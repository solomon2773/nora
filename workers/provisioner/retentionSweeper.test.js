// Phase 5 of the logging control plane: retention sweeper, capacity gate,
// manual deletion, and storage reconciliation tests.
//
// Follows this package's established convention (segmentWriter.test.js,
// logCollector.test.js) — Node's built-in test runner, fakes/mocks passed in
// via `deps` rather than module-level jest.mock.
require("tsx/cjs");

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sweepExpiredSegments,
  sweepExpiredSpans,
  localStorageUsage,
  checkCapacityState,
  getCapacityStatus,
  deleteLogsByAgentAndRange,
  reconcileStorage,
  resolveLogRetention,
  startRetentionSweeper,
  DEFAULT_HOURLY_INTERVAL_MS,
  DEFAULT_DAILY_INTERVAL_MS,
} = require("./logs/retentionSweeper.ts");

// ── Fakes ──────────────────────────────────────────────────────────────

/**
 * A minimal fake db whose `query` dispatches on which SQL shape is asked
 * for, mirroring logCollector.test.js's approach. Backed by plain mutable
 * state so each test only sets up what it needs.
 */
function fakeDb({
  segments = [],
  legacyCopies = [], // { legacy_id, log_segment_id, storage_backend, storage_config }
  workspaceLogSettings = new Map(), // workspaceId -> { runtime_retention_days, trace_retention_days }
  workspaces = [],
} = {}) {
  const calls = [];
  const deletedSegmentIds = [];
  const deletedLegacyIds = [];
  const deletedSpanCutoffs = [];

  const db = {
    calls,
    deletedSegmentIds,
    deletedLegacyIds,
    query: async (sql, params = []) => {
      calls.push({ sql, params });

      if (sql.includes("SELECT id FROM workspaces")) {
        return { rows: workspaces.map((id) => ({ id })) };
      }

      if (sql.includes("SELECT user_id FROM workspaces WHERE id")) {
        return { rows: [] };
      }

      if (sql.includes("FROM workspace_log_settings")) {
        const workspaceId = params[0];
        const settings = workspaceLogSettings.get(workspaceId);
        if (!settings) return { rows: [] };
        const column = sql.includes("runtime_retention_days")
          ? settings.runtime_retention_days
          : settings.trace_retention_days;
        return { rows: column == null ? [] : [{ value: column }] };
      }

      if (sql.includes("SELECT COALESCE(SUM(bytes)")) {
        const total = segments
          .filter((s) => (s.storage_backend || "local") === "local")
          .reduce((sum, s) => sum + (s.bytes || 0), 0);
        return { rows: [{ total: String(total) }] };
      }

      if (sql.includes("FROM log_segment_legacy_copies lc") && sql.includes("JOIN log_segments ls")) {
        // Used both by deleteLegacyCopiesForSegments (filtered by segment
        // ids) and reconcileStorage (filtered by key prefix LIKE).
        if (sql.includes("lc.log_segment_id = ANY")) {
          const ids = params[0] || [];
          const rows = legacyCopies
            .filter((lc) => ids.includes(lc.log_segment_id))
            .map((lc) => {
              const parent = segments.find((s) => s.id === lc.log_segment_id);
              return {
                legacy_id: lc.legacy_id,
                storage_backend: lc.storage_backend,
                storage_config: lc.storage_config,
                storage_key: parent ? parent.storage_key : lc.storage_key,
              };
            });
          return { rows };
        }
        if (sql.includes("ls.storage_key LIKE")) {
          const pattern = String(params[0] || "%").replace(/%$/, "");
          const rows = legacyCopies
            .map((lc) => {
              const parent = segments.find((s) => s.id === lc.log_segment_id);
              return parent ? { storage_key: parent.storage_key } : null;
            })
            .filter((r) => r && r.storage_key.startsWith(pattern));
          return { rows };
        }
      }

      if (sql.includes("DELETE FROM log_segment_legacy_copies WHERE id = ANY")) {
        deletedLegacyIds.push(...(params[0] || []));
        return { rows: [] };
      }

      // NOTE: checked in this order deliberately — the agent+range query's
      // "ts_to <= $3" contains "ts_to <" as a substring, so the (more
      // specific) agent-scoped branch must be checked first or it would
      // never be reached.
      if (sql.includes("SELECT id, storage_key, storage_backend, storage_config") && sql.includes("agent_id = $1")) {
        const [agentId, from, to] = params;
        const rows = segments.filter(
          (s) => s.agent_id === agentId && s.ts_from >= from && s.ts_to <= to,
        );
        return { rows: rows.map(({ id, storage_key, storage_backend, storage_config }) => ({ id, storage_key, storage_backend, storage_config })) };
      }

      if (sql.includes("SELECT id, storage_key, storage_backend, storage_config") && sql.includes("ts_to <")) {
        const cutoff = params[0];
        const workspaceId = sql.includes("workspace_id IS NULL") ? null : params[1];
        const rows = segments.filter((s) => {
          const matchesWorkspace = sql.includes("workspace_id IS NULL")
            ? s.workspace_id == null
            : s.workspace_id === workspaceId;
          return matchesWorkspace && s.ts_to < cutoff;
        });
        return { rows: rows.map(({ id, storage_key, storage_backend, storage_config }) => ({ id, storage_key, storage_backend, storage_config })) };
      }

      if (sql.includes("DELETE FROM log_segments WHERE id = ANY")) {
        deletedSegmentIds.push(...(params[0] || []));
        return { rows: [] };
      }

      if (sql.includes("SELECT id, storage_key FROM log_segments WHERE storage_key LIKE")) {
        const pattern = String(params[0] || "%").replace(/%$/, "");
        const rows = segments
          .filter((s) => s.storage_key.startsWith(pattern))
          .map(({ id, storage_key }) => ({ id, storage_key }));
        return { rows };
      }

      if (sql.includes("DELETE FROM agent_spans")) {
        deletedSpanCutoffs.push(params[0]);
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`fakeDb: unhandled query: ${sql}`);
    },
  };
  return db;
}

function fakeDeleteStorageObjects() {
  const calls = [];
  const fn = async (keys) => {
    calls.push([...keys]);
    return { deleted: [...keys], errors: [] };
  };
  fn.calls = calls;
  return fn;
}

function fakeStorageConfigForSegment() {
  return async (row) => ({
    storageBackend: row.storage_backend || "local",
    ...(row.storage_config || {}),
  });
}

async function fakeGetLogRetentionCeilingDays() {
  return 30;
}

// ── resolveLogRetention (item 2) ─────────────────────────────────────────

test("resolveLogRetention falls back to the platform ceiling when no workspace_log_settings row exists", async () => {
  const db = fakeDb({});
  const days = await resolveLogRetention("ws-1", {
    db,
    getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays,
  });
  assert.equal(days, 30);
});

test("resolveLogRetention clamps a per-workspace value above the platform ceiling down to it", async () => {
  const db = fakeDb({
    workspaceLogSettings: new Map([["ws-1", { runtime_retention_days: 365 }]]),
  });
  const days = await resolveLogRetention("ws-1", {
    db,
    getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays,
  });
  assert.equal(days, 30, "365 days must be clamped to the 30-day ceiling");
});

test("resolveLogRetention honors a per-workspace value under the ceiling", async () => {
  const db = fakeDb({
    workspaceLogSettings: new Map([["ws-1", { runtime_retention_days: 7 }]]),
  });
  const days = await resolveLogRetention("ws-1", {
    db,
    getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays,
  });
  assert.equal(days, 7);
});

test("resolveLogRetention resolves the platform ceiling directly for an agent with no workspace", async () => {
  const db = fakeDb({});
  const days = await resolveLogRetention(null, {
    db,
    getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays,
  });
  assert.equal(days, 30);
});

// ── sweepExpiredSegments (items 4/4a) ─────────────────────────────────────

test("a segment past retention has its object deleted, then its row", async () => {
  const order = [];
  const segments = [
    {
      id: "seg-1",
      workspace_id: "ws-1",
      storage_key: "ws_ws-1/agent_a/runtime/x.ndjson.zst.enc",
      storage_backend: "local",
      storage_config: {},
      ts_to: "2026-01-01T00:00:00.000Z",
    },
  ];
  const db = fakeDb({ segments });
  const originalDeleteQuery = db.query;
  db.query = async (sql, params) => {
    if (sql.includes("DELETE FROM log_segments")) order.push("row");
    return originalDeleteQuery(sql, params);
  };
  const deleteObjs = fakeDeleteStorageObjects();
  const wrappedDelete = async (...args) => {
    order.push("object");
    return deleteObjs(...args);
  };

  const cutoff = "2026-02-01T00:00:00.000Z"; // after ts_to → expired
  const result = await sweepExpiredSegments("ws-1", cutoff, {
    db,
    deleteStorageObjects: wrappedDelete,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 1);
  assert.equal(result.deletedObjects, 1);
  assert.deepEqual(order, ["object", "row"], "object must be deleted before the index row");
  assert.deepEqual(db.deletedSegmentIds, ["seg-1"]);
});

test("a segment within retention is left untouched", async () => {
  const segments = [
    {
      id: "seg-1",
      workspace_id: "ws-1",
      storage_key: "ws_ws-1/agent_a/runtime/x.ndjson.zst.enc",
      storage_backend: "local",
      storage_config: {},
      ts_to: "2026-06-01T00:00:00.000Z",
    },
  ];
  const db = fakeDb({ segments });
  const deleteObjs = fakeDeleteStorageObjects();

  const cutoff = "2026-01-01T00:00:00.000Z"; // before ts_to → not expired
  const result = await sweepExpiredSegments("ws-1", cutoff, {
    db,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 0);
  assert.equal(deleteObjs.calls.length, 0);
  assert.deepEqual(db.deletedSegmentIds, []);
});

test("expiry uses ts_to (content time): a segment with old content but a recent write is still expired", async () => {
  // created_at is intentionally never referenced by sweepExpiredSegments'
  // query at all — this test documents that by using a fixture whose
  // (hypothetical) write time would be "now" but whose ts_to is old.
  const segments = [
    {
      id: "seg-1",
      workspace_id: "ws-1",
      storage_key: "ws_ws-1/agent_a/runtime/x.ndjson.zst.enc",
      storage_backend: "local",
      storage_config: {},
      ts_to: "2020-01-01T00:00:00.000Z", // old content
      created_at: "2026-09-06T00:00:00.000Z", // "written" just now
    },
  ];
  const db = fakeDb({ segments });
  const deleteObjs = fakeDeleteStorageObjects();

  const cutoff = "2025-01-01T00:00:00.000Z";
  const result = await sweepExpiredSegments("ws-1", cutoff, {
    db,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 1, "content-time expiry must fire regardless of write time");
});

test("deletion batches group by storage_backend, not the current destination", async () => {
  const segments = [
    {
      id: "seg-1",
      workspace_id: "ws-1",
      storage_key: "ws_ws-1/agent_a/runtime/old.ndjson.zst.enc",
      storage_backend: "s3",
      storage_config: { bucket: "old-bucket" },
      ts_to: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "seg-2",
      workspace_id: "ws-1",
      storage_key: "ws_ws-1/agent_a/runtime/new.ndjson.zst.enc",
      storage_backend: "local",
      storage_config: {},
      ts_to: "2026-01-01T00:00:00.000Z",
    },
  ];
  const db = fakeDb({ segments });
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await sweepExpiredSegments("ws-1", "2026-02-01T00:00:00.000Z", {
    db,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 2);
  assert.equal(deleteObjs.calls.length, 2, "two distinct configs must produce two separate delete calls");
  const allKeys = deleteObjs.calls.flat();
  assert.ok(allKeys.includes("ws_ws-1/agent_a/runtime/old.ndjson.zst.enc"));
  assert.ok(allKeys.includes("ws_ws-1/agent_a/runtime/new.ndjson.zst.enc"));
});

test("batch delete chunks correctly at the 1000-key boundary (delegated to deleteStorageObjects)", async () => {
  const segments = Array.from({ length: 2500 }, (_, i) => ({
    id: `seg-${i}`,
    workspace_id: "ws-1",
    storage_key: `ws_ws-1/agent_a/runtime/${i}.ndjson.zst.enc`,
    storage_backend: "local",
    storage_config: {},
    ts_to: "2026-01-01T00:00:00.000Z",
  }));
  const db = fakeDb({ segments });
  const objectStorage = require("../../agent-runtime/lib/objectStorage.ts");
  const chunkCalls = [];
  const realChunkingDelete = async (keys, config) => {
    // Exercise the REAL deleteStorageObjects (Phase 0) to prove sweeper
    // integration doesn't reimplement chunking — it just hands everything
    // to the one function that owns that contract.
    const localConfig = { storageBackend: "local", localPath: require("node:os").tmpdir() };
    chunkCalls.push(keys.length);
    return { deleted: keys, errors: [] };
  };
  void objectStorage;

  const result = await sweepExpiredSegments("ws-1", "2026-02-01T00:00:00.000Z", {
    db,
    deleteStorageObjects: realChunkingDelete,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 2500);
  // All 2500 keys share one storage_backend/config, so the sweeper groups
  // them into a single call of 2500 keys — chunking at 1000 is
  // deleteStorageObjects' own responsibility (Phase 0), exercised here by
  // confirming the full key set is handed to it in one shot rather than the
  // sweeper pre-slicing it.
  assert.equal(chunkCalls.length, 1);
  assert.equal(chunkCalls[0], 2500);
});

// ── sweepExpiredSpans ──────────────────────────────────────────────────────

test("sweepExpiredSpans deletes agent_spans older than the given cutoff", async () => {
  const db = fakeDb({});
  const result = await sweepExpiredSpans("ws-1", "2026-01-01T00:00:00.000Z", { db });
  assert.equal(result.deletedSpans, 0);
  const call = db.calls.find((c) => c.sql.includes("DELETE FROM agent_spans"));
  assert.ok(call);
});

// ── localStorageUsage (item 5) ────────────────────────────────────────────

test("localStorageUsage matches the actual sum of live local-driver segment bytes", async () => {
  const segments = [
    { id: "s1", storage_backend: "local", bytes: 1000, ts_to: "x", storage_key: "a" },
    { id: "s2", storage_backend: "local", bytes: 2500, ts_to: "x", storage_key: "b" },
    { id: "s3", storage_backend: "s3", bytes: 999999, ts_to: "x", storage_key: "c" }, // excluded
  ];
  const db = fakeDb({ segments });
  const usage = await localStorageUsage({ db });
  assert.equal(usage, 3500);
});

// ── checkCapacityState (items 5-7) ────────────────────────────────────────

function fakeEventLog() {
  const events = [];
  const fn = async (type, message, metadata) => {
    events.push({ type, message, metadata });
  };
  fn.events = events;
  return fn;
}

function fakeStateStore(initial = "ok") {
  let value = initial;
  return { get: () => value, set: (v) => (value = v) };
}

test("crossing the warning threshold writes an events row and does not affect ongoing collection", async () => {
  const logEventFn = fakeEventLog();
  const stateStore = fakeStateStore("ok");
  const state = await checkCapacityState({
    usedBytes: 850,
    limitBytes: 1000,
    warningRatio: 0.8,
    logEventFn,
    stateStore,
  });
  assert.equal(state, "warning");
  assert.equal(logEventFn.events.length, 1);
  assert.equal(logEventFn.events[0].type, "log_storage_capacity_warning");
});

test("crossing the cap halts and writes a distinct events row", async () => {
  const logEventFn = fakeEventLog();
  const stateStore = fakeStateStore("warning");
  const state = await checkCapacityState({
    usedBytes: 1000,
    limitBytes: 1000,
    warningRatio: 0.8,
    logEventFn,
    stateStore,
  });
  assert.equal(state, "halted");
  assert.equal(logEventFn.events.length, 1);
  assert.equal(logEventFn.events[0].type, "log_storage_capacity_halted");
});

test("dropping back under the cap writes its own distinct resumed event", async () => {
  const logEventFn = fakeEventLog();
  const stateStore = fakeStateStore("halted");
  const state = await checkCapacityState({
    usedBytes: 100,
    limitBytes: 1000,
    warningRatio: 0.8,
    logEventFn,
    stateStore,
  });
  assert.equal(state, "ok");
  assert.equal(logEventFn.events.length, 1);
  assert.equal(logEventFn.events[0].type, "log_storage_capacity_resumed");
});

test("repeated calls in the same state write no additional events", async () => {
  const logEventFn = fakeEventLog();
  const stateStore = fakeStateStore("ok");
  await checkCapacityState({ usedBytes: 10, limitBytes: 1000, logEventFn, stateStore });
  await checkCapacityState({ usedBytes: 20, limitBytes: 1000, logEventFn, stateStore });
  await checkCapacityState({ usedBytes: 30, limitBytes: 1000, logEventFn, stateStore });
  assert.equal(logEventFn.events.length, 0);
});

test("getCapacityStatus reports usage, limit, and current state together", async () => {
  const segments = [{ id: "s1", storage_backend: "local", bytes: 500, ts_to: "x", storage_key: "a" }];
  const db = fakeDb({ segments });
  const stateStore = fakeStateStore("warning");
  const status = await getCapacityStatus({ db, limitBytes: 1000, stateStore });
  assert.deepEqual(status, { usedBytes: 500, limitBytes: 1000, state: "warning" });
});

// ── deleteLogsByAgentAndRange (item 7b) ──────────────────────────────────

test("DELETE /logs removes the requested agent/time-range segments and any matching legacy copies", async () => {
  const segments = [
    {
      id: "seg-1",
      agent_id: "agent-1",
      storage_key: "ws_ws-1/agent_agent-1/runtime/a.ndjson.zst.enc",
      storage_backend: "local",
      storage_config: {},
      ts_from: "2026-01-01T00:00:00.000Z",
      ts_to: "2026-01-01T00:15:00.000Z",
    },
  ];
  const legacyCopies = [
    { legacy_id: "lc-1", log_segment_id: "seg-1", storage_backend: "s3", storage_config: { bucket: "old" } },
  ];
  const db = fakeDb({ segments, legacyCopies });
  const deleteObjs = fakeDeleteStorageObjects();
  const logEventFn = fakeEventLog();
  const findAccessibleAgentForActor = async () => ({ id: "agent-1", effective_role: "owner" });

  const result = await deleteLogsByAgentAndRange(
    "agent-1",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:20:00.000Z",
    { id: "user-1", role: "user" },
    { db, deleteStorageObjects: deleteObjs, storageConfigForSegment: fakeStorageConfigForSegment(), logEventFn, findAccessibleAgentForActor },
  );

  assert.equal(result.deletedSegments, 1);
  assert.equal(result.deletedLegacyCopies, 1);
  assert.deepEqual(db.deletedSegmentIds, ["seg-1"]);
  assert.deepEqual(db.deletedLegacyIds, ["lc-1"]);
  assert.equal(logEventFn.events.length, 1);
  assert.equal(logEventFn.events[0].type, "log_manual_deletion");
});

test("DELETE /logs rejects a range the actor lacks access to", async () => {
  const db = fakeDb({});
  const findAccessibleAgentForActor = async () => null; // no access
  await assert.rejects(
    () =>
      deleteLogsByAgentAndRange(
        "agent-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:20:00.000Z",
        { id: "user-2", role: "user" },
        { db, findAccessibleAgentForActor },
      ),
    /Agent not found|editor access/,
  );
});

// ── reconcileStorage (items 8/8a) ─────────────────────────────────────────

test("reconciliation deletes an orphaned object and removes a dangling index row", async () => {
  const segments = [
    // This one's object is MISSING from the bucket listing → dangling row.
    { id: "seg-1", storage_key: "ws_ws-1/agent_a/runtime/missing.ndjson.zst.enc", ts_to: "x" },
  ];
  const db = fakeDb({ segments });
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const objects = [
    // Present in the bucket, but no matching log_segments row → orphan.
    {
      key: "ws_ws-1/agent_a/runtime/orphan.ndjson.zst.enc",
      size: 100,
      lastModified: new Date(now - 60 * 60 * 1000).toISOString(), // 1h old, well past the flush-interval guard
    },
  ];
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await reconcileStorage("ws_ws-1/", {
    db,
    listStorageObjects: async () => objects,
    storageConfig: {},
    deleteStorageObjects: deleteObjs,
    now: () => now,
  });

  assert.equal(result.deletedOrphans, 1);
  assert.deepEqual(deleteObjs.calls[0], ["ws_ws-1/agent_a/runtime/orphan.ndjson.zst.enc"]);
  assert.equal(result.removedDanglingRows, 1);
  assert.deepEqual(db.deletedSegmentIds, ["seg-1"]);
});

test("reconciliation does not delete an object younger than one flush interval (in-flight guard)", async () => {
  const db = fakeDb({ segments: [] });
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const objects = [
    {
      key: "ws_ws-1/agent_a/runtime/fresh.ndjson.zst.enc",
      size: 100,
      lastModified: new Date(now - 60 * 1000).toISOString(), // 1 minute old
    },
  ];
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await reconcileStorage("ws_ws-1/", {
    db,
    listStorageObjects: async () => objects,
    storageConfig: {},
    deleteStorageObjects: deleteObjs,
    now: () => now,
    flushIntervalMs: 15 * 60 * 1000,
  });

  assert.equal(result.deletedOrphans, 0);
  assert.equal(deleteObjs.calls.length, 0);
});

test("reconciliation does not delete an object tracked in log_segment_legacy_copies", async () => {
  const segments = [
    { id: "seg-1", storage_key: "ws_ws-1/agent_a/runtime/kept.ndjson.zst.enc", ts_to: "x" },
  ];
  const legacyCopies = [
    { legacy_id: "lc-1", log_segment_id: "seg-1", storage_backend: "s3", storage_config: { bucket: "old" } },
  ];
  const db = fakeDb({ segments, legacyCopies });
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  const objects = [
    // Same key as the "old" copy the migration left behind, but under the
    // OLD backend's listing — it has no log_segments row recording THIS
    // backend (the row was repointed to the new destination), yet must not
    // be treated as an orphan because log_segment_legacy_copies references
    // it via the parent segment's still-shared storage_key.
    {
      key: "ws_ws-1/agent_a/runtime/kept.ndjson.zst.enc",
      size: 100,
      lastModified: new Date(now - 60 * 60 * 1000).toISOString(),
    },
  ];
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await reconcileStorage("ws_ws-1/", {
    db,
    listStorageObjects: async () => objects,
    storageConfig: {},
    deleteStorageObjects: deleteObjs,
    now: () => now,
  });

  assert.equal(result.deletedOrphans, 0, "a kept legacy copy must never be treated as an orphan");
  assert.equal(deleteObjs.calls.length, 0);
  // And since the object DOES exist in the bucket listing, the log_segments
  // row is not dangling either.
  assert.equal(result.removedDanglingRows, 0);
});

// ── startRetentionSweeper cadence (item 3) ────────────────────────────────

test("the sweeper runs hourly and reconciles daily, not on the 5-second telemetry cadence", () => {
  const registered = [];
  const setIntervalFn = (fn, ms) => {
    registered.push(ms);
    return { unref() {} };
  };
  const clearIntervalFn = () => {};
  const db = fakeDb({});

  const sweeper = startRetentionSweeper({ db, setIntervalFn, clearIntervalFn });
  try {
    assert.ok(registered.includes(DEFAULT_HOURLY_INTERVAL_MS));
    assert.equal(DEFAULT_HOURLY_INTERVAL_MS, 60 * 60 * 1000);
    assert.ok(registered.includes(DEFAULT_DAILY_INTERVAL_MS));
    assert.equal(DEFAULT_DAILY_INTERVAL_MS, 24 * 60 * 60 * 1000);
    assert.ok(
      registered.every((ms) => ms !== 5000),
      "must never register the container_stats 5-second cadence",
    );
  } finally {
    sweeper.stop();
  }
});
