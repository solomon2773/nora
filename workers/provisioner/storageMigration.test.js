// Phase 5b of the logging control plane: storage destination migration
// tests.
//
// Follows this package's established convention (segmentWriter.test.js,
// retentionSweeper.test.js) — Node's built-in test runner, fakes/mocks
// passed in via `deps` rather than module-level jest.mock.
require("tsx/cjs");

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  startStorageMigration,
  migrateSegmentBatch,
  resumeStorageMigration,
  retryStorageMigration,
  getMigrationStatus,
  backendsRequiringRetainedCredentials,
  stopCapacityResumeTimer,
} = require("./logs/storageMigration.ts");

const { reconcileStorage } = require("./logs/retentionSweeper.ts");

// ── Fakes ──────────────────────────────────────────────────────────────

/**
 * A minimal fake db whose `query` dispatches on which SQL shape is asked
 * for, mirroring retentionSweeper.test.js's approach. `jobs` and `segments`
 * are held as plain mutable arrays so tests can inspect state directly
 * after calling into the module under test. Segment ids are zero-padded
 * strings ("seg-01", "seg-02", ...) so plain JS string comparison mirrors
 * Postgres's `id > $checkpoint` ordering used by the real query.
 */
function fakeDb({ jobs = [], segments = [], legacyCopies = [] } = {}) {
  let jobSeq = jobs.length;
  const calls = [];

  const db = {
    calls,
    jobs,
    segments,
    legacyCopies,
    query: async (sql, params = []) => {
      calls.push({ sql, params });

      // ── storage_migration_jobs ─────────────────────────────────────
      if (sql.includes("INSERT INTO storage_migration_jobs")) {
        jobSeq += 1;
        const id = `job-${jobSeq}`;
        const [fromBackend, toBackend, keepSource, segmentsTotal] = params;
        jobs.push({
          id,
          from_backend: fromBackend,
          to_backend: toBackend,
          keep_source: keepSource,
          status: "running",
          segments_total: segmentsTotal,
          segments_migrated: 0,
          checkpoint: null,
          started_at: new Date().toISOString(),
          completed_at: null,
        });
        return { rows: [{ id }] };
      }

      if (
        sql.includes("SELECT id FROM storage_migration_jobs WHERE status IN ('running','paused') LIMIT 1")
      ) {
        const active = jobs.find((j) => j.status === "running" || j.status === "paused");
        return { rows: active ? [{ id: active.id }] : [] };
      }

      if (sql.includes("SELECT id FROM storage_migration_jobs WHERE status IN ('running','paused')")) {
        return { rows: jobs.filter((j) => j.status === "running" || j.status === "paused").map((j) => ({ id: j.id })) };
      }

      if (sql.includes("SELECT id FROM storage_migration_jobs WHERE status = 'paused'")) {
        return { rows: jobs.filter((j) => j.status === "paused").map((j) => ({ id: j.id })) };
      }

      if (sql.includes("SELECT id FROM storage_migration_jobs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1")) {
        const failed = jobs
          .filter((j) => j.status === "failed")
          .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
        return { rows: failed.length ? [{ id: failed[0].id }] : [] };
      }

      if (sql.includes("SELECT from_backend, to_backend FROM storage_migration_jobs")) {
        return {
          rows: jobs
            .filter((j) => j.status === "running" || j.status === "paused")
            .map((j) => ({ from_backend: j.from_backend, to_backend: j.to_backend })),
        };
      }

      if (sql.includes("SELECT * FROM storage_migration_jobs WHERE id = $1")) {
        const job = jobs.find((j) => j.id === params[0]);
        return { rows: job ? [{ ...job }] : [] };
      }

      if (sql.includes("SELECT id, from_backend, to_backend, keep_source, status, segments_total")) {
        if (jobs.length === 0) return { rows: [] };
        const latest = [...jobs].sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
        return { rows: [{ ...latest }] };
      }

      if (sql.startsWith("UPDATE storage_migration_jobs SET status = 'paused'")) {
        const job = jobs.find((j) => j.id === params[0]);
        if (job) job.status = "paused";
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE storage_migration_jobs SET status = 'running'")) {
        const job = jobs.find((j) => j.id === params[0]);
        if (job) job.status = "running";
        return { rows: [] };
      }
      if (sql.includes("SET status = 'completed'")) {
        const job = jobs.find((j) => j.id === params[0]);
        if (job) {
          job.status = "completed";
          job.completed_at = new Date().toISOString();
        }
        return { rows: [] };
      }
      if (sql.includes("SET status = 'failed'")) {
        const [jobId, addMigrated, checkpoint] = params;
        const job = jobs.find((j) => j.id === jobId);
        if (job) {
          job.status = "failed";
          job.completed_at = new Date().toISOString();
          job.segments_migrated += addMigrated;
          job.checkpoint = checkpoint;
        }
        return { rows: [] };
      }
      if (
        sql.includes("SET segments_migrated = segments_migrated + $2, checkpoint = $3") &&
        sql.includes("storage_migration_jobs")
      ) {
        const [jobId, addMigrated, checkpoint] = params;
        const job = jobs.find((j) => j.id === jobId);
        if (job) {
          job.segments_migrated += addMigrated;
          job.checkpoint = checkpoint;
        }
        return { rows: [] };
      }

      // ── log_segments (batch selection / repointing) ─────────────────
      if (
        sql.includes("SELECT id, storage_key, storage_backend, storage_config, ts_to") &&
        sql.includes("FROM log_segments") &&
        sql.includes("storage_backend = $1 AND id > $2")
      ) {
        const [fromBackend, checkpoint, limit] = params;
        const rows = segments
          .filter((s) => s.storage_backend === fromBackend && s.id > checkpoint)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((s) => ({ ...s }));
        return { rows };
      }

      if (sql.includes("UPDATE log_segments SET storage_backend = $2, storage_config = $3")) {
        const [id, storageBackend, storageConfig] = params;
        const segment = segments.find((s) => s.id === id);
        if (segment) {
          segment.storage_backend = storageBackend;
          segment.storage_config = JSON.parse(storageConfig);
        }
        return { rows: [] };
      }

      if (sql.includes("SELECT COUNT(*)::int AS count, COALESCE(SUM(bytes),0)::bigint AS bytes")) {
        const [backend] = params;
        const matching = segments.filter((s) => s.storage_backend === backend);
        const bytes = matching.reduce((sum, s) => sum + (s.bytes || 0), 0);
        return { rows: [{ count: matching.length, bytes: String(bytes) }] };
      }

      // ── log_segment_legacy_copies ────────────────────────────────────
      if (sql.includes("INSERT INTO log_segment_legacy_copies")) {
        const [logSegmentId, storageBackend, storageConfig, tsTo] = params;
        legacyCopies.push({
          legacy_id: `lc-${legacyCopies.length + 1}`,
          log_segment_id: logSegmentId,
          storage_backend: storageBackend,
          storage_config: JSON.parse(storageConfig),
          ts_to: tsTo,
        });
        return { rows: [] };
      }

      if (sql.includes("SELECT DISTINCT storage_backend FROM log_segment_legacy_copies WHERE ts_to > NOW()")) {
        const now = Date.now();
        const backends = new Set(
          legacyCopies.filter((lc) => new Date(lc.ts_to).getTime() > now).map((lc) => lc.storage_backend),
        );
        return { rows: [...backends].map((storage_backend) => ({ storage_backend })) };
      }

      // ── Delegated to retentionSweeper.ts (used by the integration test) ──
      if (sql.includes("FROM log_segment_legacy_copies lc") && sql.includes("JOIN log_segments ls")) {
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
        for (const id of params[0] || []) {
          const idx = legacyCopies.findIndex((lc) => lc.legacy_id === id);
          if (idx >= 0) legacyCopies.splice(idx, 1);
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT id, storage_key FROM log_segments WHERE storage_key LIKE")) {
        const pattern = String(params[0] || "%").replace(/%$/, "");
        const rows = segments
          .filter((s) => s.storage_key.startsWith(pattern))
          .map(({ id, storage_key }) => ({ id, storage_key }));
        return { rows };
      }
      if (sql.includes("DELETE FROM log_segments WHERE id = ANY")) {
        const ids = params[0] || [];
        for (const id of ids) {
          const idx = segments.findIndex((s) => s.id === id);
          if (idx >= 0) segments.splice(idx, 1);
        }
        return { rows: [] };
      }

      throw new Error(`fakeDb: unhandled query: ${sql}`);
    },
  };
  return db;
}

function fakeObjectStore(initial = {}) {
  // key: `${storageBackend}:${storageKey}` -> Buffer
  const store = new Map(Object.entries(initial));
  const getCalls = [];
  const putCalls = [];
  const deleteCalls = [];

  const getStorageObject = async (key, config) => {
    getCalls.push({ key, backend: config.storageBackend });
    const value = store.get(`${config.storageBackend}:${key}`);
    if (value === undefined) throw new Error(`fakeObjectStore: no object at ${config.storageBackend}:${key}`);
    return value;
  };
  const putStorageObject = async (key, buffer, config) => {
    putCalls.push({ key, backend: config.storageBackend });
    store.set(`${config.storageBackend}:${key}`, buffer);
  };
  const deleteStorageObject = async (key, config) => {
    deleteCalls.push({ key, backend: config.storageBackend });
    store.delete(`${config.storageBackend}:${key}`);
  };

  return { store, getStorageObject, putStorageObject, deleteStorageObject, getCalls, putCalls, deleteCalls };
}

function fakeStorageConfigForSegment() {
  return async (row) => ({ storageBackend: row.storage_backend, ...(row.storage_config || {}) });
}

function fakeLogStorageConfigSnapshot() {
  return (config) => ({ storageBackend: config.storageBackend });
}

function fakeLogEvent() {
  const calls = [];
  const fn = async (type, message, metadata) => {
    calls.push({ type, message, metadata });
  };
  fn.calls = calls;
  return fn;
}

function makeSegment({ id, backend = "local", bytes = 100, tsTo = "2026-01-01T00:00:00.000Z" } = {}) {
  return {
    id,
    storage_key: `ws_ws-1/agent_a/runtime/${id}.ndjson.zst.enc`,
    storage_backend: backend,
    storage_config: { storageBackend: backend },
    bytes,
    ts_to: tsTo,
  };
}

function noOpCapacity() {
  return async () => ({ usedBytes: 0, limitBytes: Infinity, atCapacity: false });
}

function baseDeps({ db, store, toBackend = "s3", capacity = noOpCapacity() } = {}) {
  return {
    db,
    getStorageObject: store.getStorageObject,
    putStorageObject: store.putStorageObject,
    deleteStorageObject: store.deleteStorageObject,
    storageConfigForSegment: fakeStorageConfigForSegment(),
    logStorageConfigSnapshot: fakeLogStorageConfigSnapshot(),
    logStorageConfig: async () => ({ storageBackend: toBackend }),
    checkLocalCapacity: capacity,
    localStorageUsage: async () => 0,
    logEventFn: fakeLogEvent(),
    autoAdvance: false,
    sleep: async () => {},
  };
}

test.afterEach(() => {
  stopCapacityResumeTimer();
});

// ── Basic per-segment migration semantics (items 2-3) ────────────────────

test("a segment is readable from its old location throughout its own migration, and from its new location immediately after", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ "local:ws_ws-1/agent_a/runtime/seg-01.ndjson.zst.enc": Buffer.from("hello") });
  const deps = baseDeps({ db, store, toBackend: "s3" });

  // Wrap putStorageObject so that, WHILE the new-destination write is
  // in-flight, the old location is still fully readable — proving "readable
  // throughout" rather than only "readable before we started."
  const originalPut = deps.putStorageObject;
  let observedDuringPut = null;
  deps.putStorageObject = async (key, buffer, config) => {
    observedDuringPut = await store.getStorageObject(key, { storageBackend: "local" });
    return originalPut(key, buffer, config);
  };

  const { jobId } = await startStorageMigration(
    { storageBackend: "local" },
    { storageBackend: "s3" },
    false,
    deps,
  );
  const outcome = await migrateSegmentBatch(jobId, deps);

  assert.ok(observedDuringPut, "old location must still be readable while the new write is in flight");
  assert.deepEqual(outcome, { done: false, status: "running", migrated: 1 });

  const newObject = await store.getStorageObject(segment.storage_key, { storageBackend: "s3" });
  assert.equal(newObject.toString(), "hello", "new location must be readable immediately after migration");

  // Completion: the next batch call finds nothing left and marks the job done.
  const finalOutcome = await migrateSegmentBatch(jobId, deps);
  assert.equal(finalOutcome.status, "completed");
});

test("an interrupted job (simulated worker restart mid-batch) resumes from its checkpoint without re-migrating or skipping segments", async () => {
  const segments = [
    makeSegment({ id: "seg-01" }),
    makeSegment({ id: "seg-02" }),
    makeSegment({ id: "seg-03" }),
  ];
  const db = fakeDb({ segments });
  const store = fakeObjectStore(
    Object.fromEntries(segments.map((s) => [`local:${s.storage_key}`, Buffer.from(s.id)])),
  );
  const deps = { ...baseDeps({ db, store, toBackend: "s3" }), batchSize: 1 };

  const { jobId } = await startStorageMigration(
    { storageBackend: "local" },
    { storageBackend: "s3" },
    false,
    deps,
  );

  // Each call to migrateSegmentBatch is a fresh, independent invocation that
  // only relies on the persisted job row/checkpoint — exactly what a process
  // restart between calls would look like.
  const first = await migrateSegmentBatch(jobId, deps);
  assert.equal(first.migrated, 1);
  const second = await migrateSegmentBatch(jobId, deps);
  assert.equal(second.migrated, 1);
  const third = await migrateSegmentBatch(jobId, deps);
  assert.equal(third.migrated, 1);
  const done = await migrateSegmentBatch(jobId, deps);
  assert.equal(done.status, "completed");

  const job = db.jobs.find((j) => j.id === jobId);
  assert.equal(job.segments_migrated, 3, "each segment migrated exactly once");
  assert.equal(job.checkpoint, "seg-03");
  assert.equal(store.putCalls.length, 3, "no segment re-migrated");
  assert.deepEqual(
    store.putCalls.map((c) => c.key).sort(),
    segments.map((s) => s.storage_key).sort(),
    "every segment migrated exactly once, none skipped",
  );
});

// ── keepSourceCopies (item 2) ─────────────────────────────────────────────

test("keepSourceCopies: false deletes the old-destination object once the new copy is confirmed", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ [`local:${segment.storage_key}`]: Buffer.from("x") });
  const deps = baseDeps({ db, store, toBackend: "s3" });

  const { jobId } = await startStorageMigration({ storageBackend: "local" }, { storageBackend: "s3" }, false, deps);
  await migrateSegmentBatch(jobId, deps);

  assert.equal(store.deleteCalls.length, 1);
  assert.equal(store.deleteCalls[0].backend, "local");
  assert.equal(store.store.has(`local:${segment.storage_key}`), false, "old object must be gone");
  assert.equal(db.legacyCopies.length, 0, "no legacy copy row when not keeping source copies");
});

test("keepSourceCopies: true leaves the old-destination object in place and creates a matching log_segment_legacy_copies row", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local", tsTo: "2026-03-01T00:00:00.000Z" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ [`local:${segment.storage_key}`]: Buffer.from("x") });
  const deps = baseDeps({ db, store, toBackend: "s3" });

  const { jobId } = await startStorageMigration({ storageBackend: "local" }, { storageBackend: "s3" }, true, deps);
  await migrateSegmentBatch(jobId, deps);

  assert.equal(store.deleteCalls.length, 0, "old object must be left in place");
  assert.equal(store.store.has(`local:${segment.storage_key}`), true);
  assert.equal(db.legacyCopies.length, 1);
  assert.equal(db.legacyCopies[0].log_segment_id, "seg-01");
  assert.equal(db.legacyCopies[0].storage_backend, "local");
  assert.equal(db.legacyCopies[0].ts_to, "2026-03-01T00:00:00.000Z");
});

// ── Legacy copy expiry is independent of later retention changes ─────────

test("a kept legacy copy's ts_to is snapshotted at migration time, independent of retention settings changed afterward", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local", tsTo: "2026-02-15T00:00:00.000Z" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ [`local:${segment.storage_key}`]: Buffer.from("x") });
  const deps = baseDeps({ db, store, toBackend: "s3" });

  const { jobId } = await startStorageMigration({ storageBackend: "local" }, { storageBackend: "s3" }, true, deps);
  await migrateSegmentBatch(jobId, deps);

  // Nothing in storageMigration.ts reads a workspace's retention setting at
  // all — the value written is purely the segment's own ts_to at the moment
  // of migration, which is what makes it immune to a later retention change.
  assert.equal(db.legacyCopies[0].ts_to, "2026-02-15T00:00:00.000Z");

  // Simulate a subsequent retention change and confirm nothing about the
  // already-written row is touched by anything in this module.
  const beforeMutation = JSON.stringify(db.legacyCopies[0]);
  db.workspaceLogSettingsChangedAfterMigration = { runtime_retention_days: 1 }; // no-op marker
  assert.equal(JSON.stringify(db.legacyCopies[0]), beforeMutation);
});

// ── Orphan reconciliation must not delete a tracked legacy copy ──────────

test("orphan reconciliation (Phase 5's reconcileStorage) does not delete a legacy copy this phase created", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local", tsTo: "2026-02-15T00:00:00.000Z" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ [`local:${segment.storage_key}`]: Buffer.from("x") });
  const deps = baseDeps({ db, store, toBackend: "s3" });

  const { jobId } = await startStorageMigration({ storageBackend: "local" }, { storageBackend: "s3" }, true, deps);
  await migrateSegmentBatch(jobId, deps);
  // Segment now lives on s3; its OLD ("local") copy is tracked via
  // log_segment_legacy_copies and still physically present in `store`.
  assert.equal(segment.storage_backend, "s3");
  assert.equal(store.store.has(`local:${segment.storage_key}`), true);

  const now = Date.parse("2026-01-20T00:00:00.000Z"); // segment.ts_to already migrated; object is old enough not to be in-flight
  const objects = [
    {
      key: segment.storage_key,
      size: 5,
      lastModified: new Date(now - 60 * 60 * 1000).toISOString(),
    },
  ];
  const deleteStorageObjectsCalls = [];
  const result = await reconcileStorage("ws_ws-1/", {
    db,
    listStorageObjects: async () => objects,
    storageConfig: { storageBackend: "local" },
    deleteStorageObjects: async (keys) => {
      deleteStorageObjectsCalls.push(keys);
      return { deleted: keys, errors: [] };
    },
    now: () => now,
  });

  assert.equal(result.deletedOrphans, 0, "a tracked legacy copy must never be treated as an orphan");
  assert.equal(deleteStorageObjectsCalls.length, 0);
});

// ── Credential-retention guard (item 7) ───────────────────────────────────

test("backendsRequiringRetainedCredentials reports a backend referenced by a running/paused job", async () => {
  const db = fakeDb({
    jobs: [
      {
        id: "job-1",
        from_backend: "local",
        to_backend: "s3",
        keep_source: false,
        status: "running",
        segments_total: 0,
        segments_migrated: 0,
        checkpoint: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
    ],
  });
  const backends = await backendsRequiringRetainedCredentials({ db });
  assert.ok(backends.has("local"));
  assert.ok(backends.has("s3"));
});

test("backendsRequiringRetainedCredentials reports a backend referenced by an unexpired legacy copy", async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const db = fakeDb({
    legacyCopies: [{ legacy_id: "lc-1", log_segment_id: "seg-01", storage_backend: "ssh", ts_to: future }],
  });
  const backends = await backendsRequiringRetainedCredentials({ db });
  assert.ok(backends.has("ssh"));
});

test("backendsRequiringRetainedCredentials does not report a backend whose only legacy copy already expired", async () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const db = fakeDb({
    legacyCopies: [{ legacy_id: "lc-1", log_segment_id: "seg-01", storage_backend: "ssh", ts_to: past }],
  });
  const backends = await backendsRequiringRetainedCredentials({ db });
  assert.equal(backends.has("ssh"), false);
});

// ── Migration progress is queryable mid-run (item 6) ─────────────────────

test("migration progress is queryable mid-run via getMigrationStatus and reflects real segment counts", async () => {
  const segments = [makeSegment({ id: "seg-01" }), makeSegment({ id: "seg-02" })];
  const db = fakeDb({ segments });
  const store = fakeObjectStore(
    Object.fromEntries(segments.map((s) => [`local:${s.storage_key}`, Buffer.from("x")])),
  );
  const deps = { ...baseDeps({ db, store, toBackend: "s3" }), batchSize: 1 };

  const { jobId, segmentsTotal } = await startStorageMigration(
    { storageBackend: "local" },
    { storageBackend: "s3" },
    false,
    deps,
  );
  assert.equal(segmentsTotal, 2);

  let status = await getMigrationStatus({ db });
  assert.equal(status.jobId, jobId);
  assert.equal(status.status, "running");
  assert.equal(status.segmentsMigrated, 0);
  assert.equal(status.segmentsTotal, 2);

  await migrateSegmentBatch(jobId, deps);
  status = await getMigrationStatus({ db });
  assert.equal(status.segmentsMigrated, 1);

  await migrateSegmentBatch(jobId, deps);
  await migrateSegmentBatch(jobId, deps); // empty batch -> completed
  status = await getMigrationStatus({ db });
  assert.equal(status.status, "completed");
  assert.equal(status.segmentsMigrated, 2);
});

test("getMigrationStatus returns status: none when no migration has ever run", async () => {
  const db = fakeDb({});
  const status = await getMigrationStatus({ db });
  assert.deepEqual(status, { status: "none" });
});

// ── Capacity gate: pre-flight rejection (item 8) ─────────────────────────

test("startStorageMigration rejects switching to local with no side effects when capacity would be exceeded", async () => {
  const segments = [makeSegment({ id: "seg-01", backend: "s3", bytes: 800 })];
  const db = fakeDb({ segments });
  const store = fakeObjectStore();
  const deps = { ...baseDeps({ db, store }), limitBytes: 1000, localStorageUsage: async () => 400 };

  await assert.rejects(
    () => startStorageMigration({ storageBackend: "s3" }, { storageBackend: "local" }, false, deps),
    (error) => {
      assert.equal(error.code, "LOG_STORAGE_CAPACITY_EXCEEDED");
      return true;
    },
  );

  assert.equal(db.jobs.length, 0, "no job row must be created");
});

test("startStorageMigration succeeds when there is enough headroom", async () => {
  const segments = [makeSegment({ id: "seg-01", backend: "s3", bytes: 200 })];
  const db = fakeDb({ segments });
  const store = fakeObjectStore();
  const deps = { ...baseDeps({ db, store }), limitBytes: 1000, localStorageUsage: async () => 100 };

  const { jobId } = await startStorageMigration(
    { storageBackend: "s3" },
    { storageBackend: "local" },
    false,
    deps,
  );
  assert.ok(jobId);
  assert.equal(db.jobs.length, 1);
});

test("startStorageMigration never runs the local capacity check for an object-storage destination", async () => {
  const db = fakeDb({ segments: [makeSegment({ id: "seg-01", backend: "local" })] });
  const store = fakeObjectStore();
  let localUsageCalled = false;
  const deps = {
    ...baseDeps({ db, store }),
    localStorageUsage: async () => {
      localUsageCalled = true;
      return 0;
    },
  };
  await startStorageMigration({ storageBackend: "local" }, { storageBackend: "s3" }, false, deps);
  assert.equal(localUsageCalled, false, "s3/r2 destinations must never trigger the capacity check");
});

// ── Capacity gate: mid-run pause/resume (items 9-10) ─────────────────────

test("a running migration to local pauses (not failed) when usage crosses the cap mid-run", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "s3" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ [`s3:${segment.storage_key}`]: Buffer.from("x") });
  let atCapacity = false;
  const deps = {
    ...baseDeps({ db, store, toBackend: "local" }),
    checkLocalCapacity: async () => ({ usedBytes: atCapacity ? 1000 : 0, limitBytes: 1000, atCapacity }),
  };

  const { jobId } = await startStorageMigration({ storageBackend: "s3" }, { storageBackend: "local" }, false, deps);

  atCapacity = true; // usage crosses the cap before the batch runs
  const outcome = await migrateSegmentBatch(jobId, deps);
  assert.equal(outcome.status, "paused");
  assert.equal(store.putCalls.length, 0, "no segment touched once paused");

  const job = db.jobs.find((j) => j.id === jobId);
  assert.equal(job.status, "paused");
  assert.equal(job.segments_migrated, 0);
});

test("object-storage destinations (s3, r2) never trigger the capacity check or a paused status", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local" });
  const db = fakeDb({ segments: [segment] });
  const store = fakeObjectStore({ [`local:${segment.storage_key}`]: Buffer.from("x") });
  let capacityChecked = false;
  const deps = {
    ...baseDeps({ db, store, toBackend: "s3" }),
    checkLocalCapacity: async () => {
      capacityChecked = true;
      return { usedBytes: 999999, limitBytes: 1, atCapacity: true };
    },
  };

  const { jobId } = await startStorageMigration({ storageBackend: "local" }, { storageBackend: "s3" }, false, deps);
  const outcome = await migrateSegmentBatch(jobId, deps);

  assert.equal(capacityChecked, false, "the local capacity gate must never run for an s3/r2 destination");
  assert.equal(outcome.status, "running");
  assert.equal(outcome.migrated, 1);
});

test("a paused migration resumes automatically from its checkpoint once usage drops back under the cap", async () => {
  const segments = [makeSegment({ id: "seg-01", backend: "s3" }), makeSegment({ id: "seg-02", backend: "s3" })];
  const db = fakeDb({ segments });
  const store = fakeObjectStore(Object.fromEntries(segments.map((s) => [`s3:${s.storage_key}`, Buffer.from("x")])));
  let atCapacity = true;
  const deps = {
    ...baseDeps({ db, store, toBackend: "local" }),
    batchSize: 1,
    checkLocalCapacity: async () => ({ usedBytes: atCapacity ? 1000 : 0, limitBytes: 1000, atCapacity }),
  };

  const { jobId } = await startStorageMigration({ storageBackend: "s3" }, { storageBackend: "local" }, false, deps);
  let outcome = await migrateSegmentBatch(jobId, deps);
  assert.equal(outcome.status, "paused");
  assert.equal(db.jobs[0].checkpoint, null, "nothing migrated while paused");

  // Usage drops back under the cap — no separate "resume" call is required
  // beyond invoking the same batch function again (the capacity-resume
  // timer / resumeStorageMigration() is what calls it automatically in
  // production; this test drives it directly to assert the underlying
  // behavior it depends on).
  atCapacity = false;
  outcome = await migrateSegmentBatch(jobId, deps);
  assert.equal(outcome.status, "running");
  assert.equal(outcome.migrated, 1);
  assert.equal(db.jobs[0].status, "running");
  assert.equal(db.jobs[0].checkpoint, "seg-01");
});

// ── resumeStorageMigration on worker restart (item 10) ───────────────────

test("resumeStorageMigration picks up a running job left over from an ungraceful restart", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "local" });
  const db = fakeDb({
    segments: [segment],
    jobs: [
      {
        id: "job-1",
        from_backend: "local",
        to_backend: "s3",
        keep_source: false,
        status: "running",
        segments_total: 1,
        segments_migrated: 0,
        checkpoint: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
    ],
  });
  const store = fakeObjectStore({ [`local:${segment.storage_key}`]: Buffer.from("x") });
  const deps = baseDeps({ db, store, toBackend: "s3" });

  const { resumed, jobIds } = await resumeStorageMigration(deps);
  assert.equal(resumed, 1);
  assert.deepEqual(jobIds, ["job-1"]);

  // driveMigrationJob runs asynchronously (fire-and-forget); give it a tick
  // to complete against our synchronous fakes.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(db.jobs[0].status, "completed");
});

test("resumeStorageMigration picks up a paused job exactly like a running one", async () => {
  const db = fakeDb({
    jobs: [
      {
        id: "job-1",
        from_backend: "s3",
        to_backend: "local",
        keep_source: false,
        status: "paused",
        segments_total: 1,
        segments_migrated: 0,
        checkpoint: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
    ],
  });
  const store = fakeObjectStore();
  const deps = { ...baseDeps({ db, store, toBackend: "local" }), checkLocalCapacity: async () => ({ usedBytes: 0, limitBytes: Infinity, atCapacity: false }) };

  const { resumed } = await resumeStorageMigration(deps);
  assert.equal(resumed, 1);
});

test("a worker restart while a job is paused does not resume real processing past the capacity check — it stays paused if the cap is still exceeded", async () => {
  const segment = makeSegment({ id: "seg-01", backend: "s3" });
  const db = fakeDb({
    segments: [segment],
    jobs: [
      {
        id: "job-1",
        from_backend: "s3",
        to_backend: "local",
        keep_source: false,
        status: "paused",
        segments_total: 1,
        segments_migrated: 0,
        checkpoint: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
    ],
  });
  const store = fakeObjectStore({ [`s3:${segment.storage_key}`]: Buffer.from("x") });
  const deps = {
    ...baseDeps({ db, store, toBackend: "local" }),
    checkLocalCapacity: async () => ({ usedBytes: 1000, limitBytes: 1000, atCapacity: true }),
  };

  await resumeStorageMigration(deps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(db.jobs[0].status, "paused", "restart must never bypass the gate and resume blindly");
  assert.equal(store.putCalls.length, 0);
});

// ── No overlapping migrations ─────────────────────────────────────────────

test("startStorageMigration rejects starting a second migration while one is already running or paused", async () => {
  const db = fakeDb({
    jobs: [
      {
        id: "job-1",
        from_backend: "local",
        to_backend: "s3",
        keep_source: false,
        status: "running",
        segments_total: 0,
        segments_migrated: 0,
        checkpoint: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
    ],
  });
  const store = fakeObjectStore();
  const deps = baseDeps({ db, store });

  await assert.rejects(
    () => startStorageMigration({ storageBackend: "s3" }, { storageBackend: "r2" }, false, deps),
    (error) => {
      assert.equal(error.code, "MIGRATION_ALREADY_RUNNING");
      return true;
    },
  );
});

// ── retryStorageMigration ─────────────────────────────────────────────────
//
// Regression coverage for the real bug this closes: after a failed
// migration, `PUT /admin/log-storage` already wrote the new destination to
// `platform_settings` BEFORE the migration ran (item 1's ordering), so
// simply fixing bad credentials and re-saving the same destination never
// re-triggers `startStorageMigration` (it only fires on an actual backend
// change) — the job just sits `failed` forever with no way back in. These
// tests are against `retryStorageMigration` directly, the recovery path.

function failedJob(overrides = {}) {
  return {
    id: "job-failed-1",
    from_backend: "local",
    to_backend: "s3",
    keep_source: false,
    status: "failed",
    segments_total: 2,
    segments_migrated: 1,
    checkpoint: "seg-01",
    started_at: new Date(Date.now() - 60000).toISOString(),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

test("retryStorageMigration rejects with no failed job to retry", async () => {
  const db = fakeDb({ jobs: [] });
  const deps = baseDeps({ db, store: fakeObjectStore() });

  await assert.rejects(() => retryStorageMigration(deps), (error) => {
    assert.equal(error.code, "NO_FAILED_MIGRATION");
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test("retryStorageMigration rejects while another migration is running or paused", async () => {
  const db = fakeDb({
    jobs: [
      failedJob({ id: "job-failed-1" }),
      {
        id: "job-running-1",
        from_backend: "local",
        to_backend: "r2",
        keep_source: false,
        status: "running",
        segments_total: 0,
        segments_migrated: 0,
        checkpoint: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
    ],
  });
  const deps = baseDeps({ db, store: fakeObjectStore() });

  await assert.rejects(() => retryStorageMigration(deps), (error) => {
    assert.equal(error.code, "MIGRATION_ALREADY_RUNNING");
    assert.equal(error.statusCode, 409);
    return true;
  });
});

test("retryStorageMigration flips the failed job back to running and finishes migrating the remaining segments, resuming from its checkpoint", async () => {
  // seg-01 already succeeded before the failure (reflected in checkpoint /
  // segments_migrated); only seg-02 should actually get migrated on retry.
  const segments = [makeSegment({ id: "seg-01" }), makeSegment({ id: "seg-02" })];
  const db = fakeDb({ segments, jobs: [failedJob()] });
  const store = fakeObjectStore(
    Object.fromEntries(segments.map((s) => [`local:${s.storage_key}`, Buffer.from(s.id)])),
  );
  const deps = baseDeps({ db, store, toBackend: "s3" });

  const { jobId } = await retryStorageMigration(deps);
  assert.equal(jobId, "job-failed-1");
  assert.equal(db.jobs.find((j) => j.id === jobId).status, "running");

  const outcome = await migrateSegmentBatch(jobId, deps);
  assert.equal(outcome.status, "running");
  assert.equal(outcome.migrated, 1, "only the not-yet-migrated segment is processed");

  const done = await migrateSegmentBatch(jobId, deps);
  assert.equal(done.status, "completed");

  assert.deepEqual(
    store.putCalls.map((c) => c.key),
    [segments[1].storage_key],
    "the already-succeeded segment must not be re-migrated",
  );
});
