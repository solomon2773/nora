// @ts-nocheck
// "Delete all collected logs": stats for the keep-or-delete choice, a durable
// request record, and the resumable job that does the deleting.
//
// Who does what. backend-api records the request (requestLogPurge) and reports
// progress; worker-provisioner performs it (runPendingPurge). The worker owns
// the segment writer's in-memory buffers and parked uploads, and those must be
// discarded first or a flush after the sweep would bring back minutes of logs
// the admin asked to be gone. The job state lives in
// platform_settings.log_purge_job, so a restart of either process resumes it.
//
// Scope: active logs only — every agent's and workspace's collected segments,
// legacy copies, and spans. Logs kept for an already-deleted agent or workspace
// (deleted_log_owners) have their own purge page and are left alone.
//
// Lives under workers/provisioner/ because the backend loads these modules too
// (see CLAUDE.md, "Backend adapter code sharing").

const crypto = require("crypto");

const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";
const DEFAULT_SEGMENT_BATCH = 200;
const DEFAULT_SPAN_BATCH = 5000;
// "Every segment ever": sweepExpiredSegmentsByScope deletes rows older than a cutoff.
const FOREVER = "9999-12-31T00:00:00.000Z";

const IN_PROGRESS = ["pending", "running"];

// Excludes logs kept for deleted agents/workspaces. `alias` is the table or
// alias the predicate is evaluated against (both tables have agent_id and
// workspace_id).
function activeScopeSql(table) {
  return `NOT EXISTS (
    SELECT 1 FROM deleted_log_owners d
     WHERE (d.kind = 'agent' AND d.source_id = ${table}.agent_id)
        OR (d.kind = 'workspace' AND d.source_id = ${table}.workspace_id)
  )`;
}

function getDb() {
  return require("../../../backend-api/db.ts");
}

function isMissingSchema(error) {
  return error && (error.code === UNDEFINED_COLUMN || error.code === UNDEFINED_TABLE);
}

/**
 * What a delete would remove: shown in the keep-or-delete choice so the
 * decision is informed, and used to decide whether to ask at all.
 */
async function getLogStats(deps = {}) {
  const db = deps.db || getDb();
  try {
    const segments = await db.query(
      `SELECT COUNT(*)::bigint AS segments,
              COALESCE(SUM(lines), 0)::bigint AS lines,
              COALESCE(SUM(bytes), 0)::bigint AS bytes,
              COUNT(DISTINCT agent_id)::int AS agents,
              MIN(ts_from) AS oldest,
              MAX(ts_to) AS newest
         FROM log_segments
        WHERE ${activeScopeSql("log_segments")}`,
    );
    const spans = await db.query(
      `SELECT COUNT(*)::bigint AS spans FROM agent_spans WHERE ${activeScopeSql("agent_spans")}`,
    );
    const row = segments.rows?.[0] || {};
    return {
      segments: Number(row.segments || 0),
      lines: Number(row.lines || 0),
      bytes: Number(row.bytes || 0),
      agents: Number(row.agents || 0),
      spans: Number(spans.rows?.[0]?.spans || 0),
      oldest: row.oldest || null,
      newest: row.newest || null,
    };
  } catch (error) {
    if (isMissingSchema(error)) {
      return { segments: 0, lines: 0, bytes: 0, agents: 0, spans: 0, oldest: null, newest: null };
    }
    throw error;
  }
}

async function readPurgeJob(deps = {}) {
  const db = deps.db || getDb();
  try {
    const result = await db.query(
      `SELECT log_purge_job FROM platform_settings WHERE singleton = TRUE LIMIT 1`,
    );
    return result.rows?.[0]?.log_purge_job || null;
  } catch (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
}

/**
 * Record a request to delete everything. If one is already pending or running
 * it is returned instead of starting a second, so double-clicks and retries are
 * harmless. Returns `{ job, created }`.
 */
async function requestLogPurge({ requestedBy = null } = {}, deps = {}) {
  const db = deps.db || getDb();
  const job = {
    id: crypto.randomUUID(),
    status: "pending",
    requestedAt: new Date().toISOString(),
    requestedBy,
    segmentsDeleted: 0,
    spansDeleted: 0,
    objectsDeleted: 0,
  };
  const result = await db.query(
    `INSERT INTO platform_settings(singleton, log_purge_job, updated_at)
     VALUES (TRUE, $1::jsonb, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       log_purge_job = CASE
         WHEN platform_settings.log_purge_job->>'status' IN ('pending', 'running')
           THEN platform_settings.log_purge_job
         ELSE EXCLUDED.log_purge_job
       END,
       updated_at = NOW()
     RETURNING log_purge_job`,
    [JSON.stringify(job)],
  );
  const stored = result.rows?.[0]?.log_purge_job || job;
  return { job: stored, created: stored.id === job.id };
}

async function patchPurgeJob(jobId, patch, deps = {}) {
  const db = deps.db || getDb();
  await db.query(
    `UPDATE platform_settings
        SET log_purge_job = log_purge_job || $2::jsonb, updated_at = NOW()
      WHERE singleton = TRUE AND log_purge_job->>'id' = $1`,
    [jobId, JSON.stringify(patch)],
  );
}

/**
 * Performs the recorded request, if there is one to perform. Safe to call on
 * every tick and after a restart: a job that was `running` when the worker
 * stopped is picked up again, and every step is idempotent (it deletes what is
 * still there).
 *
 * @param {Object} deps
 * @param {Object} deps.segmentWriter - its buffers and parked uploads are discarded first.
 * @param {Function} [deps.isCollectionEnabled] - override for tests; by default the setting is read fresh, and the job refuses to run while collection is on.
 */
async function runPendingPurge(deps = {}) {
  const db = deps.db || getDb();
  const logger = deps.logger || console;
  const logEvent = deps.logEvent || ((...args) => require("../../../backend-api/monitoring.ts").logEvent(...args));
  const sweep = deps.sweepExpiredSegmentsByScope || require("./retentionSweeper.ts").sweepExpiredSegmentsByScope;
  const segmentBatch = deps.segmentBatch || DEFAULT_SEGMENT_BATCH;
  const spanBatch = deps.spanBatch || DEFAULT_SPAN_BATCH;

  const job = await readPurgeJob({ db });
  if (!job || !IN_PROGRESS.includes(job.status)) return { ran: false };

  // The request is only valid while collection is off. If something turned it
  // back on, abandon the job rather than delete logs that are being written.
  // This is a safety check before destroying data, so it reads the setting
  // fresh: the worker's cached gate can be a few seconds stale, and right after
  // an admin turns collection off it would still say "on".
  const isCollectionEnabled =
    deps.isCollectionEnabled ||
    (async () => (await require("./logCollectionState.ts").resolveLogCollectionState({ db })).enabled);
  if (await isCollectionEnabled()) {
    await patchPurgeJob(job.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: "Log collection was turned back on before the deletion ran.",
    }, { db });
    return { ran: false, abandoned: true };
  }

  await patchPurgeJob(job.id, { status: "running", startedAt: job.startedAt || new Date().toISOString() }, { db });
  logger.log?.(`[logPurge] deleting all collected logs (job ${job.id})`);

  let segmentsDeleted = job.segmentsDeleted || 0;
  let objectsDeleted = job.objectsDeleted || 0;
  let spansDeleted = job.spansDeleted || 0;
  try {
    // Buffers and parked uploads first, so nothing flushes after the sweep.
    if (deps.segmentWriter?.discardAll) await deps.segmentWriter.discardAll();

    for (;;) {
      const outcome = await sweep(activeScopeSql("log_segments"), null, FOREVER, { db, limit: segmentBatch });
      if (!outcome.deletedSegments) break;
      segmentsDeleted += outcome.deletedSegments;
      objectsDeleted += outcome.deletedObjects;
      await patchPurgeJob(job.id, { segmentsDeleted, objectsDeleted }, { db });
    }

    for (;;) {
      const result = await db.query(
        `DELETE FROM agent_spans
          WHERE id IN (
            SELECT id FROM agent_spans WHERE ${activeScopeSql("agent_spans")} LIMIT ${spanBatch}
          )
          RETURNING id`,
      );
      const deleted = result.rowCount ?? result.rows?.length ?? 0;
      if (!deleted) break;
      spansDeleted += deleted;
      await patchPurgeJob(job.id, { spansDeleted }, { db });
    }

    // One more pass: a flush that was already in flight when the buffers were
    // discarded has now finished, and may have written a final segment.
    for (;;) {
      const outcome = await sweep(activeScopeSql("log_segments"), null, FOREVER, { db, limit: segmentBatch });
      if (!outcome.deletedSegments) break;
      segmentsDeleted += outcome.deletedSegments;
      objectsDeleted += outcome.deletedObjects;
    }

    await patchPurgeJob(job.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      segmentsDeleted,
      objectsDeleted,
      spansDeleted,
      error: null,
    }, { db });
    await logEvent("log_purge_completed", "All collected logs were deleted", {
      jobId: job.id,
      requestedBy: job.requestedBy,
      segmentsDeleted,
      objectsDeleted,
      spansDeleted,
    });
    logger.log?.(`[logPurge] done: ${segmentsDeleted} segment(s), ${spansDeleted} span(s)`);
    return { ran: true, segmentsDeleted, objectsDeleted, spansDeleted };
  } catch (error) {
    logger.error?.(`[logPurge] failed: ${error.message}`);
    await patchPurgeJob(job.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      segmentsDeleted,
      objectsDeleted,
      spansDeleted,
      error: error.message,
    }, { db }).catch(() => {});
    await logEvent("log_purge_failed", `Deleting all collected logs failed: ${error.message}`, {
      jobId: job.id,
      requestedBy: job.requestedBy,
      segmentsDeleted,
    }).catch(() => {});
    return { ran: true, failed: true, error: error.message };
  }
}

/**
 * Drives runPendingPurge on a timer from the worker. Single-flight, and
 * unref'd so it never holds the process open.
 */
function startLogPurgeRunner(deps = {}) {
  const intervalMs = deps.intervalMs ?? 15_000;
  const logger = deps.logger || console;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  let inFlight = false;
  let timer = null;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      await runPendingPurge(deps);
    } catch (error) {
      logger.error?.(`[logPurge] tick failed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  timer = setIntervalFn(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    tick,
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
  };
}

module.exports = {
  activeScopeSql,
  getLogStats,
  readPurgeJob,
  requestLogPurge,
  runPendingPurge,
  startLogPurgeRunner,
  IN_PROGRESS,
};
