require("tsx/cjs");

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  getLogStats,
  readPurgeJob,
  requestLogPurge,
  runPendingPurge,
  startLogPurgeRunner,
} = require("./logs/logPurge.ts");

const silent = { log() {}, warn() {}, error() {} };

/**
 * A fake db that backs `platform_settings.log_purge_job` with plain state and
 * hands out span deletions from a queue.
 */
function fakeDb({
  job = null,
  spanBatches = [],
  spanError = null,
  collectionEnabled = false,
} = {}) {
  const state = {
    job,
    patches: [],
    spanBatches: [...spanBatches],
    collectionEnabled,
    collectionReads: 0,
  };
  return {
    state,
    async query(sql, params) {
      if (/SELECT log_purge_job FROM platform_settings/.test(sql)) {
        return { rows: [{ log_purge_job: state.job }] };
      }
      if (/SELECT log_collection_enabled/.test(sql)) {
        state.collectionReads += 1;
        return { rows: [{ log_collection_enabled: state.collectionEnabled }] };
      }
      if (/UPDATE platform_settings\s+SET log_purge_job = log_purge_job \|\|/.test(sql)) {
        const patch = JSON.parse(params[1]);
        state.patches.push(patch);
        state.job = { ...state.job, ...patch };
        return { rowCount: 1, rows: [] };
      }
      if (/DELETE FROM agent_spans/.test(sql)) {
        if (spanError) throw spanError;
        const n = state.spanBatches.shift() ?? 0;
        return { rowCount: n, rows: Array.from({ length: n }, (_, i) => ({ id: i })) };
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    },
  };
}

function sweepFrom(batches, order = []) {
  const queue = [...batches];
  return async (whereSql, param, cutoff, deps) => {
    order.push("sweep");
    assert.ok(deps.limit > 0, "the purge must sweep in bounded batches");
    const n = queue.shift() ?? 0;
    return { deletedSegments: n, deletedObjects: n, deletedLegacyCopies: 0 };
  };
}

const pendingJob = (overrides = {}) => ({
  id: "job-1",
  status: "pending",
  requestedBy: "admin-1",
  segmentsDeleted: 0,
  spansDeleted: 0,
  objectsDeleted: 0,
  ...overrides,
});

test("does nothing when no purge was requested or the last one is finished", async () => {
  for (const job of [null, pendingJob({ status: "completed" }), pendingJob({ status: "failed" })]) {
    const db = fakeDb({ job });
    const result = await runPendingPurge({
      db,
      logger: silent,
      sweepExpiredSegmentsByScope: sweepFrom([]),
    });
    assert.equal(result.ran, false);
    assert.equal(db.state.patches.length, 0);
  }
});

test("discards buffered lines BEFORE deleting, sweeps until empty, then completes with totals and an event", async () => {
  const order = [];
  const db = fakeDb({ job: pendingJob(), spanBatches: [7, 3, 0] });
  const events = [];
  const segmentWriter = {
    discardAll: async () => {
      order.push("discard");
      return {};
    },
  };

  const result = await runPendingPurge({
    db,
    logger: silent,
    segmentWriter,
    isCollectionEnabled: async () => false,
    sweepExpiredSegmentsByScope: sweepFrom([200, 150, 0, 0], order),
    logEvent: async (...args) => {
      events.push(args);
    },
  });

  assert.equal(
    order[0],
    "discard",
    "buffers must be discarded before any stored segment is deleted",
  );
  assert.deepEqual(result, {
    ran: true,
    segmentsDeleted: 350,
    objectsDeleted: 350,
    spansDeleted: 10,
  });
  assert.equal(db.state.job.status, "completed");
  assert.equal(db.state.job.segmentsDeleted, 350);
  assert.equal(db.state.job.spansDeleted, 10);
  assert.ok(db.state.job.finishedAt);
  assert.equal(db.state.patches[0].status, "running", "the job is marked running before any work");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "log_purge_completed");
});

test("sweeps once more after the span pass, to catch a flush that was in flight when buffers were discarded", async () => {
  const order = [];
  const db = fakeDb({ job: pendingJob(), spanBatches: [0] });
  let sweeps = 0;
  await runPendingPurge({
    db,
    logger: silent,
    // First loop: nothing left (call 1). The final pass (call 2) finds one late segment.
    sweepExpiredSegmentsByScope: async () => {
      sweeps += 1;
      order.push("sweep");
      return sweeps === 2
        ? { deletedSegments: 1, deletedObjects: 1, deletedLegacyCopies: 0 }
        : { deletedSegments: 0, deletedObjects: 0, deletedLegacyCopies: 0 };
    },
    logEvent: async () => {},
  });
  assert.equal(db.state.job.segmentsDeleted, 1, "a segment that landed late must still be deleted");
  assert.equal(db.state.job.status, "completed");
});

test("refuses to run, and fails the job, if collection was turned back on", async () => {
  const db = fakeDb({ job: pendingJob() });
  let swept = false;
  const result = await runPendingPurge({
    db,
    logger: silent,
    isCollectionEnabled: async () => true,
    segmentWriter: {
      discardAll: async () => {
        throw new Error("must not discard live buffers");
      },
    },
    sweepExpiredSegmentsByScope: async () => {
      swept = true;
      return { deletedSegments: 0 };
    },
  });
  assert.equal(result.ran, false);
  assert.equal(result.abandoned, true);
  assert.equal(swept, false);
  assert.equal(db.state.job.status, "failed");
  assert.match(db.state.job.error, /turned back on/);
});

test("a failure part-way marks the job failed with the partial counts and logs an event", async () => {
  const db = fakeDb({ job: pendingJob(), spanBatches: [] });
  const events = [];
  let calls = 0;
  const result = await runPendingPurge({
    db,
    logger: silent,
    sweepExpiredSegmentsByScope: async () => {
      calls += 1;
      if (calls === 1) return { deletedSegments: 5, deletedObjects: 5, deletedLegacyCopies: 0 };
      throw new Error("storage unreachable");
    },
    logEvent: async (...args) => {
      events.push(args);
    },
  });
  assert.equal(result.failed, true);
  assert.equal(db.state.job.status, "failed");
  assert.equal(db.state.job.error, "storage unreachable");
  assert.equal(db.state.job.segmentsDeleted, 5);
  assert.equal(events[0][0], "log_purge_failed");
});

test("a job left running by a restart is resumed and keeps counting from where it was", async () => {
  const db = fakeDb({
    job: pendingJob({
      status: "running",
      startedAt: "2026-10-01T00:00:00.000Z",
      segmentsDeleted: 40,
      objectsDeleted: 40,
    }),
    spanBatches: [0],
  });
  await runPendingPurge({
    db,
    logger: silent,
    sweepExpiredSegmentsByScope: sweepFrom([10, 0, 0]),
    logEvent: async () => {},
  });
  assert.equal(db.state.job.status, "completed");
  assert.equal(db.state.job.segmentsDeleted, 50);
  assert.equal(
    db.state.job.startedAt,
    "2026-10-01T00:00:00.000Z",
    "startedAt must not be reset by a resume",
  );
});

test("requestLogPurge returns the in-progress job instead of starting a second", async () => {
  const existing = pendingJob({ id: "already-running", status: "running" });
  const db = { query: async () => ({ rows: [{ log_purge_job: existing }] }) };
  const result = await requestLogPurge({ requestedBy: "admin-2" }, { db });
  assert.equal(result.created, false);
  assert.equal(result.job.id, "already-running");
});

test("requestLogPurge reports a freshly created job as created", async () => {
  const db = {
    query: async (sql, params) => ({ rows: [{ log_purge_job: JSON.parse(params[0]) }] }),
  };
  const result = await requestLogPurge({ requestedBy: "admin-2" }, { db });
  assert.equal(result.created, true);
  assert.equal(result.job.status, "pending");
  assert.equal(result.job.requestedBy, "admin-2");
});

test("getLogStats totals the active logs and tolerates a database that has not been migrated", async () => {
  const db = {
    async query(sql) {
      if (/FROM log_segments/.test(sql)) {
        return {
          rows: [
            {
              segments: "12",
              lines: "3400",
              bytes: "98765",
              agents: 3,
              oldest: "2026-09-01T00:00:00Z",
              newest: "2026-10-01T00:00:00Z",
            },
          ],
        };
      }
      return { rows: [{ spans: "8" }] };
    },
  };
  assert.deepEqual(await getLogStats({ db }), {
    segments: 12,
    lines: 3400,
    bytes: 98765,
    agents: 3,
    spans: 8,
    oldest: "2026-09-01T00:00:00Z",
    newest: "2026-10-01T00:00:00Z",
  });

  const missing = {
    query: async () => {
      throw Object.assign(new Error("no table"), { code: "42P01" });
    },
  };
  assert.deepEqual(await getLogStats({ db: missing }), {
    segments: 0,
    lines: 0,
    bytes: 0,
    agents: 0,
    spans: 0,
    oldest: null,
    newest: null,
  });
  assert.equal(await readPurgeJob({ db: missing }), null);
});

test("the runner is single-flight: overlapping ticks do not start two purges", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const db = fakeDb({ job: pendingJob(), spanBatches: [0] });
  let sweeps = 0;
  const runner = startLogPurgeRunner({
    db,
    logger: silent,
    intervalMs: 3_600_000,
    sweepExpiredSegmentsByScope: async () => {
      sweeps += 1;
      await gate;
      return { deletedSegments: 0, deletedObjects: 0 };
    },
    logEvent: async () => {},
  });
  try {
    const first = runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.tick(); // overlaps the first: must return immediately without sweeping
    assert.equal(sweeps, 1);
    release();
    await first;
  } finally {
    runner.stop();
  }
});

test("by default the safety check reads the setting fresh from the database, never a cached value", async () => {
  // Collection is off in the database: the job must run, even if some cached
  // gate elsewhere in the process still believes it is on.
  const off = fakeDb({ job: pendingJob(), spanBatches: [0], collectionEnabled: false });
  const ran = await runPendingPurge({
    db: off,
    logger: silent,
    sweepExpiredSegmentsByScope: sweepFrom([0, 0]),
    logEvent: async () => {},
  });
  assert.equal(ran.ran, true);
  assert.equal(off.state.collectionReads, 1, "it must ask the database itself");
  assert.equal(off.state.job.status, "completed");

  // Collection really is on in the database: abandon rather than delete live logs.
  const on = fakeDb({ job: pendingJob(), collectionEnabled: true });
  let swept = false;
  const abandoned = await runPendingPurge({
    db: on,
    logger: silent,
    sweepExpiredSegmentsByScope: async () => {
      swept = true;
      return { deletedSegments: 0 };
    },
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal(swept, false);
  assert.equal(on.state.job.status, "failed");
});
