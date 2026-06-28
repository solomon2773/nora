// @ts-nocheck
// Redis based job queue using BullMQ

const { Queue } = require("bullmq");
const { randomUUID } = require("crypto");
const IORedis = require("ioredis");

function parseTimeoutMs(rawValue, fallbackMs) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : fallbackMs;
}

const DEPLOYMENT_JOB_TIMEOUT_MS = parseTimeoutMs(
  process.env.DEPLOYMENT_JOB_TIMEOUT_MS || process.env.PROVISION_TIMEOUT_MS,
  900000,
);
const CLAWHUB_INSTALL_JOB_TIMEOUT_MS = parseTimeoutMs(
  process.env.CLAWHUB_INSTALL_TIMEOUT_MS,
  300000,
);
const BACKUP_JOB_TIMEOUT_MS = parseTimeoutMs(process.env.NORA_BACKUP_JOB_TIMEOUT_MS, 1800000);

const ALERT_DELIVERY_ATTEMPTS = (() => {
  const parsed = Number.parseInt(process.env.ALERT_DELIVERY_ATTEMPTS, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 5;
  return Math.min(parsed, 10);
})();

const connection = new IORedis({
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  maxRetriesPerRequest: null,
});

const deployQueue = new Queue("deployments", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
    timeout: DEPLOYMENT_JOB_TIMEOUT_MS,
    removeOnComplete: { count: 200 },
    removeOnFail: false, // keep failed jobs for DLQ inspection
  },
});

const clawhubJobsQueue = new Queue("clawhub-jobs", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: "exponential", delay: 3000 },
    timeout: CLAWHUB_INSTALL_JOB_TIMEOUT_MS,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
});

// Note: BullMQ v5 deprecated `timeout` in defaultJobOptions — it's silently
// ignored. The backup worker enforces BACKUP_JOB_TIMEOUT_MS itself via
// Promise.race in workers/backup/worker.ts.
const backupsQueue = new Queue("backups", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
});

// Alert webhook deliveries. Each job is one (rule, channel) pair so retries
// don't replay sibling channels that already succeeded. The worker (see
// workers/provisioner/worker.ts) calls into runAlertDeliveryJob in
// backend-api/alertRules.ts, which throws on non-2xx so BullMQ schedules
// the next attempt with exponential backoff.
const alertDeliveryQueue = new Queue("alert-deliveries", {
  connection,
  defaultJobOptions: {
    attempts: ALERT_DELIVERY_ATTEMPTS,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
  },
});

// Scheduled agent runs (recurring cron triggers). The backend sweep claims due
// schedules and enqueues one job per run; the worker executes the prompt /
// lifecycle action. Retries are bounded — a missed run is re-fired on the next
// sweep once next_run_at comes due, so we don't want long retry storms.
const agentScheduleQueue = new Queue("agent-schedules", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 200, age: 86400 },
    removeOnFail: { count: 200, age: 86400 },
  },
});

async function addDeploymentJob(agent) {
  await deployQueue.add("deploy-agent", agent);
}

async function addScheduleRunJob(payload) {
  const jobId = payload?.runId || randomUUID();
  return agentScheduleQueue.add("run-schedule", { ...payload, runId: jobId }, { jobId });
}

async function addAlertDeliveryJob(payload) {
  const deliveryId = payload?.deliveryId || randomUUID();
  return alertDeliveryQueue.add(
    "deliver-webhook",
    { ...payload, deliveryId },
    { jobId: deliveryId },
  );
}

async function addClawhubJob(payload) {
  const jobId = payload?.jobId || randomUUID();
  const operation = String(payload?.operation || "").trim() || "install";
  return clawhubJobsQueue.add(`${operation}-skill`, { ...payload, operation, jobId }, { jobId });
}

async function addBackupJob(payload) {
  const jobId = payload?.jobId || payload?.backupId || randomUUID();
  return backupsQueue.add("run-backup", { ...payload, jobId }, { jobId });
}

async function findInFlightClawhubJob(agentId, slug, operation) {
  if (!agentId || !slug) return null;

  const jobs = await clawhubJobsQueue.getJobs([
    "active",
    "waiting",
    "waiting-children",
    "delayed",
    "prioritized",
  ]);

  const normalizedAgentId = String(agentId);
  const normalizedSlug = String(slug).trim();

  for (const job of jobs) {
    if (!job) continue;
    const matchesAgent = String(job.data?.agentId || "") === normalizedAgentId;
    const matchesSlug = String(job.data?.slug || "").trim() === normalizedSlug;
    const matchesOperation = operation
      ? String(job.data?.operation || "").trim() === String(operation).trim()
      : true;
    if (matchesAgent && matchesSlug && matchesOperation) {
      return job;
    }
  }

  return null;
}

function mapClawhubJobState(state) {
  switch (state) {
    case "active":
      return "running";
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "waiting":
    case "waiting-children":
    case "delayed":
    case "prioritized":
    default:
      return "pending";
  }
}

async function getClawhubJob(jobId) {
  if (!jobId) return null;
  return clawhubJobsQueue.getJob(jobId);
}

async function getClawhubJobStatus(jobId) {
  const job = await getClawhubJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  const failedReason =
    typeof job.failedReason === "string" && job.failedReason.trim()
      ? job.failedReason.trim()
      : null;

  return {
    jobId: String(job.id),
    agentId: job.data?.agentId || null,
    slug: job.data?.slug || null,
    operation: job.data?.operation || "install",
    status: mapClawhubJobState(state),
    error: failedReason,
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

async function addClawhubInstallJob(payload) {
  return addClawhubJob({ ...payload, operation: "install" });
}

async function findInFlightClawhubInstallJob(agentId, slug) {
  return findInFlightClawhubJob(agentId, slug, "install");
}

async function getClawhubInstallJob(jobId) {
  const job = await getClawhubJob(jobId);
  return job && String(job.data?.operation || "install") === "install" ? job : null;
}

async function getClawhubInstallJobStatus(jobId) {
  const status = await getClawhubJobStatus(jobId);
  return status && status.operation === "install" ? status : null;
}

/** Retrieve failed jobs (dead letter queue) for inspection. */
async function getDLQJobs(start = 0, end = 50) {
  return deployQueue.getFailed(start, end);
}

/** Retry a specific failed job by its ID. */
async function retryDLQJob(jobId) {
  const job = await deployQueue.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  await job.retry();
  return { jobId, status: "retried" };
}

module.exports = {
  deployQueue,
  clawhubJobsQueue,
  backupsQueue,
  alertDeliveryQueue,
  agentScheduleQueue,
  addDeploymentJob,
  addScheduleRunJob,
  addClawhubJob,
  addClawhubInstallJob,
  addBackupJob,
  addAlertDeliveryJob,
  findInFlightClawhubJob,
  findInFlightClawhubInstallJob,
  getClawhubJob,
  getClawhubJobStatus,
  getClawhubInstallJob,
  getClawhubInstallJobStatus,
  getDLQJobs,
  retryDLQJob,
  connection,
  BACKUP_JOB_TIMEOUT_MS,
  ALERT_DELIVERY_ATTEMPTS,
};
