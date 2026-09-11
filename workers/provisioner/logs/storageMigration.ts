// @ts-nocheck
// workers/provisioner/logs/storageMigration.ts — Phase 5b of the logging
// control plane: turns a storage-destination change from an instantaneous
// cutover into an asynchronous, resumable migration of every
// previously-written segment, with an operator-visible keep-or-delete choice
// for the old-destination copy.
//
// Depends on:
//   - agent-runtime/lib/objectStorage.ts (Phase 0)        — getStorageObject,
//     putStorageObject, deleteStorageObject
//   - backend-api/db_schema.sql `storage_migration_jobs` /
//     `log_segment_legacy_copies`                          (Phase 1)
//   - workers/provisioner/logs/logStorageConfig.ts (Phase 3) —
//     logStorageConfig, storageConfigForSegment, logStorageConfigSnapshot
//   - workers/provisioner/logs/segmentWriter.ts (Phase 3)  — checkLocalCapacity,
//     DEFAULT_CAPACITY_POLL_INTERVAL_MS (the SAME gate and cadence Phase 3
//     applies to every live flush — this module does not reimplement it)
//   - backend-api/monitoring.ts                            — logEvent
//
// ── How a segment's storage/credentials are resolved during migration ─────
//
// Per segment, the OLD (from) config is rehydrated via
// `logStorageConfigModule.storageConfigForSegment(row)` — the exact same
// helper `retentionSweeper.ts` already uses for retention/reconciliation
// deletes against a segment's recorded (possibly stale) destination. The NEW
// (to) config is simply the CURRENT `logStorageConfig()` — correct because
// `PUT /admin/log-storage` flips the resolved config *before* creating the
// migration job (item 1), so for the entire life of a job (absent another
// destination change, which `startStorageMigration` refuses to allow to
// overlap) "current config" and "this job's target" are the same thing.
//
// This deliberately reuses the EXACT pattern already established by Phase 5,
// rather than inventing a second one: `storageConfigForSegment`'s own
// documented caveat applies unchanged here — it merges the OLD location's
// non-secret snapshot with whatever secrets are CURRENTLY configured for
// that backend shape, which is only correct as long as the previous driver's
// credentials remain configured (item 7's entire reason for existing). A
// real multi-destination credential store remains out of scope, exactly as
// `logStorageConfig.ts` already states for the backup-derived pattern this
// mirrors.

const objectStorage = require("../../../agent-runtime/lib/objectStorage.ts");
const logStorageConfigModule = require("./logStorageConfig.ts");
const segmentWriterModule = require("./segmentWriter.ts");

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 200;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function lazyDb(deps) {
  return deps.db || require("../../../backend-api/db.ts");
}

function lazyLogEvent(deps) {
  return deps.logEventFn || require("../../../backend-api/monitoring.ts").logEvent;
}

function lazyCheckLocalCapacity(deps) {
  return deps.checkLocalCapacity || segmentWriterModule.checkLocalCapacity;
}

function lazyLocalStorageUsage(deps) {
  if (deps.localStorageUsage) return deps.localStorageUsage;
  return require("./retentionSweeper.ts").localStorageUsage;
}

function normalizeConfigInput(config) {
  if (!config) return {};
  return typeof config === "string" ? { storageBackend: config } : config;
}

// ── Per-segment migration (Phase 5b items 2-3) ──────────────────────────

/**
 * Migrate exactly one `log_segments` row: read from its recorded (old)
 * location, write to the current (new) destination, and only THEN repoint
 * the index row — never the reverse. If the write to the new destination
 * fails, the row is left completely untouched, so the old location — still
 * fully readable — is what any concurrent reader sees (item 3).
 *
 * `keepSourceCopies`:
 *   - false: the old-destination object is deleted once the new copy and the
 *     repointed index row are both confirmed.
 *   - true: a `log_segment_legacy_copies` row is inserted carrying the OLD
 *     backend/config and the segment's `ts_to`, and the old object is left
 *     in place — untouched by this migration, tracked for its own
 *     independent expiry (Phase 5's retention sweeper) and excluded from
 *     orphan reconciliation (Phase 5 item 8a already checks this table).
 */
async function migrateOneSegment(row, { toConfig, keepSourceCopies }, deps = {}) {
  const db = lazyDb(deps);
  const getObj = deps.getStorageObject || objectStorage.getStorageObject;
  const putObj = deps.putStorageObject || objectStorage.putStorageObject;
  const deleteObj = deps.deleteStorageObject || objectStorage.deleteStorageObject;
  const resolveFromConfig = deps.storageConfigForSegment || logStorageConfigModule.storageConfigForSegment;
  const snapshotFn = deps.logStorageConfigSnapshot || logStorageConfigModule.logStorageConfigSnapshot;

  const fromConfig = await resolveFromConfig(row);

  // Read old, write new — in that order, and BEFORE anything about this
  // segment's row changes (item 3: the index row must never be repointed
  // ahead of a confirmed new-destination write).
  const bytes = await getObj(row.storage_key, fromConfig);
  await putObj(row.storage_key, bytes, toConfig);

  // Item 3/14 (extended from Phase 3): the object is confirmed in the new
  // location before the index row is touched at all.
  await db.query(
    `UPDATE log_segments SET storage_backend = $2, storage_config = $3 WHERE id = $1`,
    [row.id, toConfig.storageBackend, JSON.stringify(snapshotFn(toConfig))],
  );

  if (keepSourceCopies) {
    await db.query(
      `INSERT INTO log_segment_legacy_copies (log_segment_id, storage_backend, storage_config, ts_to)
       VALUES ($1, $2, $3, $4)`,
      [row.id, row.storage_backend, JSON.stringify(row.storage_config || {}), row.ts_to],
    );
  } else {
    await deleteObj(row.storage_key, fromConfig);
  }
}

/**
 * Retry a single segment's migration a bounded number of times before
 * treating it as an unrecoverable batch failure (item 5: a transient error
 * retries within the batch rather than failing the whole job).
 */
async function migrateOneSegmentWithRetry(row, ctx, deps = {}) {
  const attempts = deps.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await migrateOneSegment(row, ctx, deps);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastError;
}

// ── startStorageMigration (item 1, 8 / function list) ───────────────────

/**
 * Reject outright, with NO side effects, if `toConfig` is `local` and there
 * isn't real capacity for the exact byte total about to be migrated (item
 * 8). Object-storage destinations skip this entirely (Phase 5 item 5's same
 * rule).
 *
 * Otherwise creates the `storage_migration_jobs` row and begins processing.
 * Only one migration may be in flight at a time — a second call while a job
 * is `running`/`paused` is rejected, so overlapping jobs never contend for
 * the same segments or the same "previous destination's credentials must
 * stay configured" obligation (item 7).
 *
 * `fromConfig`/`toConfig` need only carry `.storageBackend` — the actual
 * object I/O during processing always re-resolves credentials per segment
 * (see module header), so nothing about these two config objects needs to
 * survive a worker restart; only the backend NAMES are persisted, on the job
 * row itself.
 */
async function startStorageMigration(fromConfig, toConfig, keepSourceCopies, deps = {}) {
  const db = lazyDb(deps);
  const from = normalizeConfigInput(fromConfig);
  const to = normalizeConfigInput(toConfig);
  const fromBackend = from.storageBackend;
  const toBackend = to.storageBackend;

  if (!fromBackend || !toBackend) {
    const error = new Error("startStorageMigration requires fromConfig.storageBackend and toConfig.storageBackend");
    error.statusCode = 400;
    throw error;
  }

  const activeJob = await db.query(
    `SELECT id FROM storage_migration_jobs WHERE status IN ('running','paused') LIMIT 1`,
  );
  if (activeJob.rows[0]) {
    const error = new Error("A storage migration is already in progress");
    error.statusCode = 409;
    error.code = "MIGRATION_ALREADY_RUNNING";
    throw error;
  }

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(bytes),0)::bigint AS bytes
       FROM log_segments WHERE storage_backend = $1`,
    [fromBackend],
  );
  const segmentsTotal = countResult.rows[0]?.count || 0;
  const bytesToMigrate = Number(countResult.rows[0]?.bytes || 0);

  if (toBackend === "local") {
    const localUsage = lazyLocalStorageUsage(deps);
    const usedBytes = await localUsage();
    const limitBytes =
      deps.limitBytes ?? (Number(process.env.NORA_LOG_LOCAL_MAX_BYTES) || Infinity);
    if (Number.isFinite(limitBytes) && usedBytes + bytesToMigrate > limitBytes) {
      const error = new Error(
        `Migrating ${bytesToMigrate} byte(s) to local storage would exceed the configured cap ` +
          `(${usedBytes} already used + ${bytesToMigrate} to migrate > ${limitBytes} byte limit)`,
      );
      error.statusCode = 400;
      error.code = "LOG_STORAGE_CAPACITY_EXCEEDED";
      throw error;
    }
  }

  const insertResult = await db.query(
    `INSERT INTO storage_migration_jobs
       (from_backend, to_backend, keep_source, status, segments_total, segments_migrated)
     VALUES ($1, $2, $3, 'running', $4, 0)
     RETURNING id`,
    [fromBackend, toBackend, Boolean(keepSourceCopies), segmentsTotal],
  );
  const jobId = insertResult.rows[0].id;

  ensureCapacityResumeTimer(deps);

  if (deps.autoAdvance !== false) {
    driveMigrationJob(jobId, deps).catch((error) => {
      (deps.logger || console).error(
        `[storageMigration] job ${jobId} processing loop failed: ${error.message}`,
      );
    });
  }

  return { jobId, segmentsTotal, bytesToMigrate };
}

// ── migrateSegmentBatch (item 2-4, 9 / function list) ───────────────────

/**
 * Process exactly one checkpointed batch for `jobId`. Consults the exact
 * same capacity gate `segmentWriter.ts` applies to every live flush
 * (`checkLocalCapacity()`) before touching anything, when the destination is
 * `local` — never a second implementation of that idea (item 9). On a
 * capacity breach the job is `paused` at its current checkpoint, not
 * `failed` — a capacity pause is expected to self-resolve.
 *
 * Returns `{ done, status, migrated? }`. `done: true` means the caller
 * should stop driving this job (`completed`, `failed`, or `not_found`);
 * `done: false` with `status: "paused"` means stop for now but a later call
 * (the capacity-resume timer, or another `resumeStorageMigration()`) may
 * continue it; `done: false` with `status: "running"` means more batches
 * remain right now.
 */
async function migrateSegmentBatch(jobId, deps = {}) {
  const db = lazyDb(deps);
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const logEvent = lazyLogEvent(deps);
  const resolveToConfig = deps.logStorageConfig || logStorageConfigModule.logStorageConfig;
  const checkCapacity = lazyCheckLocalCapacity(deps);

  const jobResult = await db.query(`SELECT * FROM storage_migration_jobs WHERE id = $1`, [jobId]);
  const job = jobResult.rows[0];
  if (!job) return { done: true, status: "not_found" };
  if (job.status === "completed" || job.status === "failed") {
    return { done: true, status: job.status };
  }

  const toConfig = await resolveToConfig();
  const isLocalTarget = toConfig.storageBackend === "local";

  if (isLocalTarget) {
    const capacity = await checkCapacity();
    if (capacity.atCapacity) {
      if (job.status !== "paused") {
        await db.query(`UPDATE storage_migration_jobs SET status = 'paused' WHERE id = $1`, [jobId]);
        await logEvent(
          "log_storage_migration_paused",
          `Storage migration ${jobId} paused at checkpoint ${job.checkpoint || "(start)"} — ` +
            `local log storage is at capacity (${capacity.usedBytes}/${capacity.limitBytes} bytes). ` +
            `This is expected to self-resolve once usage drops back under the cap.`,
          { jobId, checkpoint: job.checkpoint, usedBytes: capacity.usedBytes, limitBytes: capacity.limitBytes },
        );
      }
      return { done: false, status: "paused" };
    }
  }

  // Capacity is fine (or the destination isn't local, where this gate never
  // applies at all — item 9's last line). If the job had been paused, clear
  // that state so it resumes from exactly where it left off (item 10).
  if (job.status === "paused") {
    await db.query(`UPDATE storage_migration_jobs SET status = 'running' WHERE id = $1`, [jobId]);
    job.status = "running";
  }

  const checkpoint = job.checkpoint || NIL_UUID;
  const segmentsResult = await db.query(
    `SELECT id, storage_key, storage_backend, storage_config, ts_to
       FROM log_segments
      WHERE storage_backend = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [job.from_backend, checkpoint, batchSize],
  );
  const rows = segmentsResult.rows || [];

  if (rows.length === 0) {
    await db.query(
      `UPDATE storage_migration_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [jobId],
    );
    await logEvent(
      "log_storage_migration_completed",
      `Storage migration to ${job.to_backend} completed: ${job.segments_migrated} segment(s) migrated, ` +
        `source copies ${job.keep_source ? "kept (tracked for their own expiry)" : "deleted"}`,
      {
        jobId,
        fromBackend: job.from_backend,
        toBackend: job.to_backend,
        segmentsMigrated: job.segments_migrated,
        keepSource: job.keep_source,
      },
    );
    return { done: true, status: "completed" };
  }

  let migratedInBatch = 0;
  for (const row of rows) {
    try {
      await migrateOneSegmentWithRetry(row, { toConfig, keepSourceCopies: job.keep_source }, deps);
      migratedInBatch += 1;
    } catch (error) {
      // Unrecoverable (retries already exhausted): mark failed, but credit
      // whatever in THIS batch already succeeded before the failing
      // segment — item 5's "only changes storage_backend for segments that
      // already succeeded" guarantee.
      const partialCheckpoint = migratedInBatch > 0 ? rows[migratedInBatch - 1].id : job.checkpoint;
      await db.query(
        `UPDATE storage_migration_jobs
            SET status = 'failed', completed_at = NOW(), segments_migrated = segments_migrated + $2,
                checkpoint = $3
          WHERE id = $1`,
        [jobId, migratedInBatch, partialCheckpoint],
      );
      await logEvent(
        "log_storage_migration_failed",
        `Storage migration ${jobId} failed while migrating segment ${row.id}: ${error.message}`,
        { jobId, segmentId: row.id, error: error.message },
      );
      return { done: true, status: "failed", error };
    }
  }

  const newCheckpoint = rows[rows.length - 1].id;
  await db.query(
    `UPDATE storage_migration_jobs
        SET segments_migrated = segments_migrated + $2, checkpoint = $3
      WHERE id = $1`,
    [jobId, migratedInBatch, newCheckpoint],
  );

  return { done: false, status: "running", migrated: migratedInBatch };
}

// ── Driving a job to completion (startStorageMigration's "how") ─────────
//
// Chosen mechanism: an in-process loop that calls `migrateSegmentBatch`
// repeatedly, yielding the event loop between batches via `setImmediate`
// (injectable as `deps.scheduleNext`) rather than a separate queue job.
//
// Why not a BullMQ job (the pattern the rest of `worker.ts` uses for
// provisioning work): this loop's unit of durable progress is already the
// `storage_migration_jobs.checkpoint` column, updated after every batch —
// that IS the durability mechanism (item 4), so a BullMQ job would only add
// a second, redundant bookkeeping layer (job attempts/backoff) around state
// that's already correctly persisted and already resumable by construction.
// A plain in-process loop that simply stops driving on `paused`/`done` and
// is picked back up by `resumeStorageMigration()` on the next boot, or by
// the capacity-resume timer below once usage clears, is simpler and matches
// how Phase 5's retention sweeper (`startRetentionSweeper`) already drives
// its own recurring, resumable work with a plain interval rather than a
// queue.
function driveMigrationJob(jobId, deps = {}) {
  const scheduleNext = deps.scheduleNext || ((fn) => setImmediate(fn));
  return (async () => {
    for (;;) {
      const outcome = await migrateSegmentBatch(jobId, deps);
      if (outcome.done) return outcome;
      if (outcome.status === "paused") return outcome;
      await new Promise((resolve) => scheduleNext(resolve));
    }
  })();
}

// ── Capacity-resume timer (item 10) ──────────────────────────────────────
//
// `driveMigrationJob` stops looping the instant a batch reports `paused` —
// nothing will call `migrateSegmentBatch` again for that job on its own.
// Phase 5's live-collection resume works because `segmentWriter.ts` runs its
// OWN independent poll of the identical `checkLocalCapacity()` gate, every
// `DEFAULT_CAPACITY_POLL_INTERVAL_MS` (10s) — see that module's `pollCapacity`
// — and the 30s collector reconcile tick then re-attaches once the flag
// clears. There is no publish/subscribe hook on that timer to attach to
// without modifying `segmentWriter.ts` itself, which is out of this phase's
// touched-file set (see the task brief). This timer is therefore a SECOND,
// independent poll — not literally "the same tick" — but it checks the
// IDENTICAL gate function at the IDENTICAL cadence constant, so the two
// mechanisms clear in lockstep in practice. This is flagged in the
// completion report as the one place true shared-tick wiring would require
// touching a file outside this phase's scope.
let _resumeTimer = null;

function ensureCapacityResumeTimer(deps = {}) {
  if (_resumeTimer) return _resumeTimer;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const intervalMs = deps.capacityPollIntervalMs ?? segmentWriterModule.DEFAULT_CAPACITY_POLL_INTERVAL_MS;
  _resumeTimer = setIntervalFn(() => {
    tryResumePausedJobs(deps).catch(() => {});
  }, intervalMs);
  if (typeof _resumeTimer.unref === "function") _resumeTimer.unref();
  return _resumeTimer;
}

/** Test/shutdown hook: stop the module-level capacity-resume timer. */
function stopCapacityResumeTimer(deps = {}) {
  if (!_resumeTimer) return;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  clearIntervalFn(_resumeTimer);
  _resumeTimer = null;
}

async function tryResumePausedJobs(deps = {}) {
  const db = lazyDb(deps);
  const result = await db.query(`SELECT id FROM storage_migration_jobs WHERE status = 'paused'`);
  for (const row of result.rows || []) {
    driveMigrationJob(row.id, deps).catch(() => {});
  }
}

// ── resumeStorageMigration (item 10 / function list) ────────────────────

/**
 * Called on worker startup to pick up any `running` OR `paused` job left
 * over from an ungraceful restart (item 10). A `paused` job is driven
 * exactly like a `running` one — `driveMigrationJob` -> `migrateSegmentBatch`
 * — but `migrateSegmentBatch` re-checks capacity BEFORE doing anything, so a
 * job that is still over the cap at restart time simply re-confirms `paused`
 * and stops again immediately. A bare restart never bypasses the gate.
 */
async function resumeStorageMigration(deps = {}) {
  const db = lazyDb(deps);
  const result = await db.query(
    `SELECT id FROM storage_migration_jobs WHERE status IN ('running','paused')`,
  );
  const jobs = result.rows || [];
  if (jobs.length > 0) ensureCapacityResumeTimer(deps);
  for (const job of jobs) {
    driveMigrationJob(job.id, deps).catch((error) => {
      (deps.logger || console).error(
        `[storageMigration] resume of job ${job.id} failed: ${error.message}`,
      );
    });
  }
  return { resumed: jobs.length, jobIds: jobs.map((j) => j.id) };
}

// ── retryStorageMigration ─────────────────────────────────────────────
//
// A `failed` job is otherwise a dead end: `resumeStorageMigration` above
// only ever looks at `running`/`paused` jobs, and `PUT /admin/log-storage`
// only starts a NEW migration when `storageBackend` actually changes from
// what's already in `platform_settings` — but that column is written
// BEFORE the migration is attempted (item 1's ordering), so it already
// reads as the failed migration's target destination. Fixing the bad
// credentials and re-saving the SAME destination looks, from that check's
// perspective, like "nothing changed" — no new job gets created, and the
// stale `failed` job keeps being what `GET /admin/log-storage/migration`
// reports forever. This is the operator's actual recovery path: retry the
// existing failed job from its own checkpoint (which already reflects
// whatever segments succeeded before the failure — see item 5's per-batch
// partial-credit guarantee) rather than requiring a real backend flip
// (e.g. bounce through `local`) just to get `startStorageMigration` to
// notice.

/**
 * Re-drive the most recent `failed` job from its checkpoint — functionally
 * identical to resuming a `paused` job (same `driveMigrationJob` /
 * `migrateSegmentBatch` machinery), just re-entered from `failed` instead
 * of `paused`. Rejects if a migration is already `running`/`paused` (same
 * one-at-a-time rule `startStorageMigration` enforces), and if there is no
 * `failed` job to retry.
 */
async function retryStorageMigration(deps = {}) {
  const db = lazyDb(deps);

  const activeJob = await db.query(
    `SELECT id FROM storage_migration_jobs WHERE status IN ('running','paused') LIMIT 1`,
  );
  if (activeJob.rows[0]) {
    const error = new Error("A storage migration is already in progress");
    error.statusCode = 409;
    error.code = "MIGRATION_ALREADY_RUNNING";
    throw error;
  }

  const failedJobResult = await db.query(
    `SELECT id FROM storage_migration_jobs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`,
  );
  const job = failedJobResult.rows[0];
  if (!job) {
    const error = new Error("No failed migration to retry");
    error.statusCode = 404;
    error.code = "NO_FAILED_MIGRATION";
    throw error;
  }

  await db.query(
    `UPDATE storage_migration_jobs SET status = 'running', completed_at = NULL WHERE id = $1`,
    [job.id],
  );

  ensureCapacityResumeTimer(deps);
  if (deps.autoAdvance !== false) {
    driveMigrationJob(job.id, deps).catch((error) => {
      (deps.logger || console).error(
        `[storageMigration] retry of job ${job.id} failed: ${error.message}`,
      );
    });
  }

  return { jobId: job.id };
}

// ── Migration progress (GET /admin/log-storage/migration) ───────────────

/**
 * The current or most-recent job's progress, for `GET
 * /admin/log-storage/migration` to poll (item 6). Returns `{ status: "none" }`
 * when no migration has ever run.
 */
async function getMigrationStatus(deps = {}) {
  const db = lazyDb(deps);
  const result = await db.query(
    `SELECT id, from_backend, to_backend, keep_source, status, segments_total,
            segments_migrated, checkpoint, started_at, completed_at
       FROM storage_migration_jobs
      ORDER BY started_at DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return { status: "none" };
  return {
    jobId: row.id,
    fromBackend: row.from_backend,
    toBackend: row.to_backend,
    keepSource: row.keep_source,
    status: row.status,
    segmentsTotal: row.segments_total,
    segmentsMigrated: row.segments_migrated,
    checkpoint: row.checkpoint,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ── Credential-retention guard (item 7) ──────────────────────────────────

/**
 * Backends whose credentials must stay configured right now: referenced as
 * `from_backend`/`to_backend` by a `running`/`paused` migration job, or
 * referenced by any `log_segment_legacy_copies` row that hasn't expired yet
 * (item 7). `PUT /admin/log-storage` consults this before honoring a
 * request to clear a destination's credentials.
 */
async function backendsRequiringRetainedCredentials(deps = {}) {
  const db = lazyDb(deps);
  const jobsResult = await db.query(
    `SELECT from_backend, to_backend FROM storage_migration_jobs WHERE status IN ('running','paused')`,
  );
  const legacyResult = await db.query(
    `SELECT DISTINCT storage_backend FROM log_segment_legacy_copies WHERE ts_to > NOW()`,
  );
  const backends = new Set();
  for (const row of jobsResult.rows || []) {
    if (row.from_backend) backends.add(row.from_backend);
    if (row.to_backend) backends.add(row.to_backend);
  }
  for (const row of legacyResult.rows || []) {
    if (row.storage_backend) backends.add(row.storage_backend);
  }
  return backends;
}

module.exports = {
  startStorageMigration,
  migrateSegmentBatch,
  resumeStorageMigration,
  retryStorageMigration,
  getMigrationStatus,
  backendsRequiringRetainedCredentials,
  driveMigrationJob,
  ensureCapacityResumeTimer,
  stopCapacityResumeTimer,
  DEFAULT_BATCH_SIZE,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
};
