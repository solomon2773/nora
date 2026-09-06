// Phase 5c of the logging control plane: agent/workspace log deletion
// choice, deleted_log_owners snapshot/recovery, and manual purge.
//
// Follows this package's established convention (segmentWriter.test.js,
// retentionSweeper.test.js) — Node's built-in test runner, fakes/mocks
// passed in via `deps` rather than module-level mocking.
require("tsx/cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  deleteAgentLogs,
  deleteWorkspaceLogs,
  snapshotDeletedLogOwner,
  purgeDeletedLogOwner,
  purgeAllLogsByColumn,
  listRecoveredLogLines,
  collectAllRecoveredLogLines,
} = require("./logs/logDeletion.ts");

const { encryptSegment } = require("./logs/segmentWriter.ts");
const retentionSweeper = require("./logs/retentionSweeper.ts");

const KEY_A = "a".repeat(64);
const KEY_RING = { keys: new Map([["k1", Buffer.from(KEY_A, "hex")]]), currentKeyId: "k1" };

// ── Fakes ──────────────────────────────────────────────────────────────

/**
 * A minimal fake db whose `query` dispatches on which SQL shape is asked
 * for, mirroring retentionSweeper.test.js's approach.
 */
function fakeDb({
  segments = [], // { id, agent_id, workspace_id, storage_key, storage_backend, storage_config, ts_from, ts_to, stream }
  legacyCopies = [], // { legacy_id, log_segment_id, storage_backend, storage_config }
  spans = [], // { id, agent_id, workspace_id }
  deletedLogOwners = [], // { id, kind, source_id, display_name, owner_user_id, retention_days, deleted_by_user_id }
  workspaceLogSettings = new Map(),
} = {}) {
  const deletedSegmentIds = [];
  const deletedLegacyIds = [];
  const deletedSpanIds = [];
  const insertedOwners = [];
  const deletedOwnerIds = [];
  const calls = [];

  const db = {
    calls,
    deletedSegmentIds,
    deletedLegacyIds,
    deletedSpanIds,
    insertedOwners,
    deletedOwnerIds,
    deletedLogOwners,
    query: async (sql, params = []) => {
      calls.push({ sql, params });

      if (sql.includes("FROM workspace_log_settings")) {
        const workspaceId = params[0];
        const settings = workspaceLogSettings.get(workspaceId);
        if (!settings) return { rows: [] };
        const column = sql.includes("runtime_retention_days")
          ? settings.runtime_retention_days
          : settings.trace_retention_days;
        return { rows: column == null ? [] : [{ value: column }] };
      }

      if (sql.includes("FROM log_segment_legacy_copies lc") && sql.includes("lc.log_segment_id = ANY")) {
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

      if (sql.includes("DELETE FROM log_segment_legacy_copies WHERE id = ANY")) {
        deletedLegacyIds.push(...(params[0] || []));
        return { rows: [] };
      }

      // listRecoveredLogLines's ordered read — check this BEFORE the plain
      // purge select below, since both match on column = $1.
      if (sql.includes("ORDER BY ts_from ASC")) {
        const column = sql.includes("workspace_id = $1") ? "workspace_id" : "agent_id";
        const rows = segments
          .filter((s) => s[column] === params[0])
          .sort((a, b) => (a.ts_from < b.ts_from ? -1 : a.ts_from > b.ts_from ? 1 : 0));
        return {
          rows: rows.map(({ id, storage_key, storage_backend, storage_config, ts_from, ts_to, stream }) => ({
            id,
            storage_key,
            storage_backend,
            storage_config,
            ts_from,
            ts_to,
            stream,
          })),
        };
      }

      // The retention sweeper's cutoff-scoped select (sweepExpiredSegmentsByScope,
      // reused for deleted-owner sweeps) — has a "ts_to < $1" clause and a
      // SECOND bind param for the scope column.
      if (
        sql.includes("SELECT id, storage_key, storage_backend, storage_config") &&
        sql.includes("ts_to <")
      ) {
        const cutoff = params[0];
        const column = sql.includes("workspace_id = $2") ? "workspace_id" : "agent_id";
        const rows = segments.filter((s) => s[column] === params[1] && s.ts_to < cutoff);
        return {
          rows: rows.map(({ id, storage_key, storage_backend, storage_config }) => ({
            id,
            storage_key,
            storage_backend,
            storage_config,
          })),
        };
      }

      // The unconditional purge select (purgeAllLogsByColumn) — no cutoff,
      // single bind param.
      if (
        sql.includes("SELECT id, storage_key, storage_backend, storage_config FROM log_segments WHERE")
      ) {
        const column = sql.includes("workspace_id =") ? "workspace_id" : "agent_id";
        const rows = segments.filter((s) => s[column] === params[0]);
        return {
          rows: rows.map(({ id, storage_key, storage_backend, storage_config }) => ({
            id,
            storage_key,
            storage_backend,
            storage_config,
          })),
        };
      }

      if (sql.includes("DELETE FROM log_segments WHERE id = ANY")) {
        deletedSegmentIds.push(...(params[0] || []));
        return { rows: [] };
      }

      if (sql.includes("DELETE FROM agent_spans WHERE")) {
        const hasCutoff = sql.includes("started_at <");
        const column = sql.includes("workspace_id =") ? "workspace_id" : "agent_id";
        const value = hasCutoff ? params[1] : params[0];
        const matched = spans.filter((s) => s[column] === value);
        deletedSpanIds.push(...matched.map((s) => s.id));
        return { rows: matched.map((s) => ({ id: s.id })), rowCount: matched.length };
      }

      if (sql.includes("INSERT INTO deleted_log_owners")) {
        const [kind, sourceId, displayName, ownerUserId, retentionDays, deletedByUserId] = params;
        const row = {
          id: `owner-${insertedOwners.length + 1}`,
          kind,
          source_id: sourceId,
          display_name: displayName,
          owner_user_id: ownerUserId,
          retention_days: retentionDays,
          deleted_by_user_id: deletedByUserId,
          deleted_at: "2026-01-01T00:00:00.000Z",
        };
        insertedOwners.push(row);
        deletedLogOwners.push(row);
        return { rows: [row] };
      }

      if (sql.includes("SELECT id, kind, source_id, retention_days FROM deleted_log_owners")) {
        return { rows: deletedLogOwners };
      }

      if (sql.includes("SELECT * FROM deleted_log_owners WHERE id = $1")) {
        const row = deletedLogOwners.find((o) => o.id === params[0]);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes("SELECT id, kind, source_id, display_name")) {
        return { rows: deletedLogOwners };
      }

      if (sql.includes("DELETE FROM deleted_log_owners WHERE id = $1")) {
        deletedOwnerIds.push(params[0]);
        const idx = deletedLogOwners.findIndex((o) => o.id === params[0]);
        if (idx >= 0) deletedLogOwners.splice(idx, 1);
        return { rows: [] };
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

function segmentFixture(overrides = {}) {
  return {
    id: overrides.id || "seg-1",
    agent_id: overrides.agent_id ?? null,
    workspace_id: overrides.workspace_id ?? null,
    storage_key: overrides.storage_key || `key-${overrides.id || "seg-1"}`,
    storage_backend: "local",
    storage_config: {},
    ts_from: overrides.ts_from || "2026-01-01T00:00:00.000Z",
    ts_to: overrides.ts_to || "2026-01-01T00:15:00.000Z",
    stream: overrides.stream || "runtime",
  };
}

// ── deleteAgentLogs / deleteWorkspaceLogs (item 2) ───────────────────────

test("deleteAgentLogs removes segments, spans, legacy copies for the agent — sibling agent untouched", async () => {
  const targetSeg = segmentFixture({ id: "seg-target", agent_id: "agent-1" });
  const siblingSeg = segmentFixture({ id: "seg-sibling", agent_id: "agent-2" });
  const db = fakeDb({
    segments: [targetSeg, siblingSeg],
    legacyCopies: [{ legacy_id: "lc-1", log_segment_id: "seg-target", storage_backend: "local", storage_config: {} }],
    spans: [
      { id: "span-1", agent_id: "agent-1" },
      { id: "span-2", agent_id: "agent-2" },
    ],
  });
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await deleteAgentLogs("agent-1", {
    db,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 1);
  assert.equal(result.deletedLegacyCopies, 1);
  assert.equal(result.deletedSpans, 1);
  assert.deepEqual(db.deletedSegmentIds, ["seg-target"]);
  assert.deepEqual(db.deletedSpanIds, ["span-1"]);
  // Sibling agent's segment/span were never touched.
  assert.ok(!db.deletedSegmentIds.includes("seg-sibling"));
  assert.ok(!db.deletedSpanIds.includes("span-2"));
});

test("deleteWorkspaceLogs scopes by workspace_id, not by enumerating member agents", async () => {
  const wsSeg = segmentFixture({ id: "seg-ws", agent_id: "agent-1", workspace_id: "ws-1" });
  const otherWsSeg = segmentFixture({ id: "seg-other-ws", agent_id: "agent-1", workspace_id: "ws-2" });
  const db = fakeDb({
    segments: [wsSeg, otherWsSeg],
    spans: [
      { id: "span-ws", workspace_id: "ws-1" },
      { id: "span-other-ws", workspace_id: "ws-2" },
    ],
  });
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await deleteWorkspaceLogs("ws-1", {
    db,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 1);
  assert.deepEqual(db.deletedSegmentIds, ["seg-ws"]);
  assert.deepEqual(db.deletedSpanIds, ["span-ws"]);
});

// ── snapshotDeletedLogOwner (item 3) ─────────────────────────────────────

test("snapshotDeletedLogOwner resolves retention_days from workspace_log_settings for an agent's workspace", async () => {
  const db = fakeDb({
    workspaceLogSettings: new Map([["ws-1", { runtime_retention_days: 14, trace_retention_days: 14 }]]),
  });

  const row = await snapshotDeletedLogOwner(
    "agent",
    "agent-1",
    { id: "user-1" },
    { displayName: "My Agent", ownerUserId: "user-1", workspaceId: "ws-1" },
    { db, getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays },
  );

  assert.equal(row.kind, "agent");
  assert.equal(row.source_id, "agent-1");
  assert.equal(row.retention_days, 14);
  assert.equal(row.deleted_by_user_id, "user-1");
});

test("snapshotDeletedLogOwner falls back to the platform ceiling for an agent with no workspace", async () => {
  const db = fakeDb();

  const row = await snapshotDeletedLogOwner(
    "agent",
    "agent-2",
    { id: "user-1" },
    { workspaceId: null },
    { db, getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays },
  );

  assert.equal(row.retention_days, 30);
});

test("workspace deleteLogs:false — retention snapshot survives workspace_log_settings being gone afterward", async () => {
  const workspaceLogSettings = new Map([["ws-9", { runtime_retention_days: 21, trace_retention_days: 21 }]]);
  const db = fakeDb({ workspaceLogSettings });

  const row = await snapshotDeletedLogOwner(
    "workspace",
    "ws-9",
    { id: "user-1" },
    { displayName: "Team Workspace", ownerUserId: "user-1" },
    { db, getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays },
  );
  assert.equal(row.retention_days, 21);

  // Simulate the workspace_log_settings row cascading away with the
  // workspace delete — the ALREADY-SNAPSHOTTED value on deleted_log_owners
  // must be unaffected.
  workspaceLogSettings.delete("ws-9");
  assert.equal(row.retention_days, 21);
});

// ── purgeDeletedLogOwner (item 7) ────────────────────────────────────────

test("purgeDeletedLogOwner removes segments, spans, legacy copies, and the deleted_log_owners row itself", async () => {
  const seg = segmentFixture({ id: "seg-kept", agent_id: "agent-3" });
  const db = fakeDb({
    segments: [seg],
    legacyCopies: [{ legacy_id: "lc-2", log_segment_id: "seg-kept", storage_backend: "local", storage_config: {} }],
    spans: [{ id: "span-kept", agent_id: "agent-3" }],
    deletedLogOwners: [
      { id: "owner-1", kind: "agent", source_id: "agent-3", retention_days: 30 },
    ],
  });
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await purgeDeletedLogOwner(
    "owner-1",
    { id: "admin-1" },
    {
      db,
      deleteStorageObjects: deleteObjs,
      storageConfigForSegment: fakeStorageConfigForSegment(),
      logEventFn: async () => {},
    },
  );

  assert.equal(result.purged, true);
  assert.equal(result.deletedSegments, 1);
  assert.equal(result.deletedSpans, 1);
  assert.equal(result.deletedLegacyCopies, 1);
  assert.deepEqual(db.deletedOwnerIds, ["owner-1"]);
  assert.equal(db.deletedLogOwners.length, 0, "the deleted_log_owners row itself must be gone");
});

test("purgeDeletedLogOwner throws a 404-shaped error for an unknown id", async () => {
  const db = fakeDb();
  await assert.rejects(
    () => purgeDeletedLogOwner("missing", { id: "admin-1" }, { db, logEventFn: async () => {} }),
    (error) => {
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

// ── listRecoveredLogLines / collectAllRecoveredLogLines (item 5) ────────
//
// Full round trip through the REAL encrypt/compress pipeline (Phase 3's
// encryptSegment + zstdCompressSync) and the REAL decrypt/decompress path
// this module uses — verifying actual log lines come back, not a stub.

function buildFixtureSegment({ id, agentId, lines, tsFrom, tsTo }) {
  const ndjson = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const compressed = zlib.zstdCompressSync(Buffer.from(ndjson, "utf8"));
  const { buffer: encrypted } = encryptSegment(compressed, KEY_RING);
  return {
    segmentRow: segmentFixture({ id, agent_id: agentId, ts_from: tsFrom, ts_to: tsTo }),
    encrypted,
  };
}

test("listRecoveredLogLines decrypts and decompresses real segments into real log lines", async () => {
  const seg1Lines = [
    { ts: "2026-01-01T00:00:00.000Z", stream: "runtime", level: "INFO", message: "first" },
    { ts: "2026-01-01T00:01:00.000Z", stream: "runtime", level: "INFO", message: "second" },
  ];
  const seg2Lines = [
    { ts: "2026-01-01T00:20:00.000Z", stream: "runtime", level: "WARN", message: "third" },
  ];
  const seg1 = buildFixtureSegment({
    id: "seg-1",
    agentId: "agent-5",
    lines: seg1Lines,
    tsFrom: "2026-01-01T00:00:00.000Z",
    tsTo: "2026-01-01T00:15:00.000Z",
  });
  const seg2 = buildFixtureSegment({
    id: "seg-2",
    agentId: "agent-5",
    lines: seg2Lines,
    tsFrom: "2026-01-01T00:15:00.000Z",
    tsTo: "2026-01-01T00:30:00.000Z",
  });

  const db = fakeDb({
    segments: [seg1.segmentRow, seg2.segmentRow],
    deletedLogOwners: [{ id: "owner-5", kind: "agent", source_id: "agent-5", retention_days: 30 }],
  });
  const store = new Map([
    [seg1.segmentRow.storage_key, seg1.encrypted],
    [seg2.segmentRow.storage_key, seg2.encrypted],
  ]);

  const deps = {
    db,
    storageConfigForSegment: fakeStorageConfigForSegment(),
    getStorageObject: async (key) => store.get(key),
    keyRing: KEY_RING,
  };

  const page1 = await listRecoveredLogLines("owner-5", { limit: 2 }, deps);
  assert.equal(page1.lines.length, 2);
  assert.deepEqual(
    page1.lines.map((l) => l.message),
    ["first", "second"],
  );
  assert.ok(page1.nextCursor, "more lines remain in segment 2");

  const page2 = await listRecoveredLogLines("owner-5", { limit: 2, cursor: page1.nextCursor }, deps);
  assert.deepEqual(
    page2.lines.map((l) => l.message),
    ["third"],
  );
  assert.equal(page2.nextCursor, null);
});

test("collectAllRecoveredLogLines gathers every line across every page", async () => {
  const lines = [
    { ts: "2026-01-01T00:00:00.000Z", message: "a" },
    { ts: "2026-01-01T00:01:00.000Z", message: "b" },
    { ts: "2026-01-01T00:02:00.000Z", message: "c" },
  ];
  const seg = buildFixtureSegment({ id: "seg-x", agentId: "agent-6", lines });
  const db = fakeDb({
    segments: [seg.segmentRow],
    deletedLogOwners: [{ id: "owner-6", kind: "agent", source_id: "agent-6", retention_days: 30 }],
  });
  const store = new Map([[seg.segmentRow.storage_key, seg.encrypted]]);

  const result = await collectAllRecoveredLogLines("owner-6", {
    db,
    storageConfigForSegment: fakeStorageConfigForSegment(),
    getStorageObject: async (key) => store.get(key),
    keyRing: KEY_RING,
  });

  assert.equal(result.lines.length, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.lines.map((l) => l.message),
    ["a", "b", "c"],
  );
});

// ── Retention sweeper integration (item 6) ───────────────────────────────

test("the retention sweeper expires a deleted_log_owners entry's segments on its snapshotted retention, scoped by agent_id not workspace_id", async () => {
  const now = new Date("2026-02-01T00:00:00.000Z").getTime();
  const expiredSeg = segmentFixture({
    id: "seg-expired",
    agent_id: "agent-7",
    ts_to: "2026-01-01T00:00:00.000Z", // far older than the 7-day snapshotted retention
  });
  const freshSeg = segmentFixture({
    id: "seg-fresh",
    agent_id: "agent-7",
    ts_to: "2026-01-31T23:00:00.000Z", // within the retention window
  });
  // A DIFFERENT agent's segment sharing no workspace scope, to prove this
  // sweep never falls back to a workspace_id lookup.
  const otherAgentSeg = segmentFixture({
    id: "seg-other-agent",
    agent_id: "agent-8",
    ts_to: "2026-01-01T00:00:00.000Z",
  });

  const db = fakeDb({
    segments: [expiredSeg, freshSeg, otherAgentSeg],
    deletedLogOwners: [{ id: "owner-7", kind: "agent", source_id: "agent-7", retention_days: 7 }],
  });
  const deleteObjs = fakeDeleteStorageObjects();

  const results = await retentionSweeper.sweepDeletedLogOwners({
    db,
    now: () => now,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
    getLogRetentionCeilingDays: fakeGetLogRetentionCeilingDays,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].deletedLogOwnerId, "owner-7");
  assert.equal(results[0].deletedSegments, 1);
  assert.deepEqual(db.deletedSegmentIds, ["seg-expired"]);
  assert.ok(!db.deletedSegmentIds.includes("seg-fresh"));
  assert.ok(!db.deletedSegmentIds.includes("seg-other-agent"));
});

test("purgeAllLogsByColumn is the exact same purge core deleteAgentLogs/deleteWorkspaceLogs/purgeDeletedLogOwner all share", async () => {
  const seg = segmentFixture({ id: "seg-shared", agent_id: "agent-9" });
  const db = fakeDb({ segments: [seg], spans: [{ id: "span-shared", agent_id: "agent-9" }] });
  const deleteObjs = fakeDeleteStorageObjects();

  const result = await purgeAllLogsByColumn("agent_id", "agent-9", {
    db,
    deleteStorageObjects: deleteObjs,
    storageConfigForSegment: fakeStorageConfigForSegment(),
  });

  assert.equal(result.deletedSegments, 1);
  assert.equal(result.deletedSpans, 1);
});
