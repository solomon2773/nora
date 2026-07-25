// @ts-nocheck
const http = require("http");
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const { createRedisClient } = require("../../backend-api/lib/connectionConfig");

const {
  processDueSchedules,
  pruneExpiredBackups,
  runBackupJob,
} = require("../../backend-api/backups");
const { BACKUP_JOB_TIMEOUT_MS } = require("../../backend-api/redisQueue");
const { runWithCancellableTimeout } = require("../../backend-api/promiseTimeout");

const connection = createRedisClient(IORedis, process.env, {
  maxRetriesPerRequest: null,
});

function parsePositiveInteger(value, fallback, { min = 1, max = 64 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const CONCURRENCY = parsePositiveInteger(process.env.BACKUP_WORKER_CONCURRENCY, 2, {
  min: 1,
  max: 8,
});
const SCHEDULE_POLL_MS = parsePositiveInteger(process.env.NORA_BACKUP_SCHEDULE_POLL_MS, 60000, {
  min: 10000,
  max: 3600000,
});

let lastScheduleError = null;
let lastScheduleRunAt = null;
let lastPruneAt = 0;

const worker = new Worker(
  "backups",
  async (job) => {
    const backupId = job.data?.backupId || job.data?.id;
    if (!backupId) throw new Error("Backup job is missing backupId");
    console.log(`[backup-worker] job=${job.id} backup=${backupId} started`);
    // Real cancellation: on timeout, the AbortController fires and propagates
    // through the backup pipeline (spawn(pg_dump), fetch(S3), ssh2, fs).
    // Each storage primitive checks the signal and tears down its work, so
    // a runaway job releases its worker slot immediately rather than running
    // to completion in the background.
    const result = await runWithCancellableTimeout(
      ({ signal }) => runBackupJob(backupId, { signal }),
      BACKUP_JOB_TIMEOUT_MS,
      `Backup job ${backupId} exceeded ${BACKUP_JOB_TIMEOUT_MS}ms timeout`,
    );
    console.log(`[backup-worker] job=${job.id} backup=${backupId} completed`);
    return result;
  },
  {
    connection,
    concurrency: CONCURRENCY,
  },
);

async function pollSchedules() {
  try {
    lastScheduleRunAt = new Date().toISOString();
    const queued = await processDueSchedules();
    lastScheduleError = null;
    if (queued.length > 0) {
      console.log(`[backup-worker] queued ${queued.length} scheduled backup(s)`);
    }

    const now = Date.now();
    if (now - lastPruneAt > 3600000) {
      lastPruneAt = now;
      const pruned = await pruneExpiredBackups();
      if (pruned.deleted > 0) {
        console.log(`[backup-worker] pruned ${pruned.deleted} expired backup(s)`);
      }
    }
  } catch (error) {
    lastScheduleError = error.message || String(error);
    console.error(`[backup-worker] schedule poll failed: ${lastScheduleError}`);
  }
}

worker.on("failed", (job, error) => {
  console.error(`[backup-worker] job=${job?.id || "unknown"} failed: ${error.message}`);
});

worker.on("completed", (job) => {
  console.log(`[backup-worker] job=${job.id} completed`);
});

setInterval(pollSchedules, SCHEDULE_POLL_MS).unref();
pollSchedules();

const healthPort = parseInt(process.env.BACKUP_WORKER_HEALTH_PORT || "4002", 10);
http
  .createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        queue: "backups",
        concurrency: CONCURRENCY,
        lastScheduleRunAt,
        lastScheduleError,
      }),
    );
  })
  .listen(healthPort, () => {
    console.log(`[backup-worker] health listening on ${healthPort}`);
  });

async function shutdown() {
  console.log("[backup-worker] shutting down");
  await worker.close().catch(() => {});
  await connection.quit().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
