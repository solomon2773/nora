// @ts-nocheck
// Redis based job queue using BullMQ

const { Queue } = require("bullmq");
const { randomUUID } = require("crypto");
const IORedis = require("ioredis");
const { createRedisClient } = require("./lib/connectionConfig");

const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;

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

const connection = createRedisClient(IORedis, process.env, {
  maxRetriesPerRequest: null,
  ...(IS_TEST_ENV
    ? {
        // Unit tests mock queue behavior at the module boundary. Keep imports
        // from opening a retrying DNS/socket loop when a suite loads server.ts.
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      }
    : {}),
});

// ── Queue definitions and retry policy ──────────────────────────

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

const policySettingsQueue = new Queue("k8s-policy-settings", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
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

if (IS_TEST_ENV) {
  for (const queue of [
    deployQueue,
    clawhubJobsQueue,
    policySettingsQueue,
    backupsQueue,
    alertDeliveryQueue,
    agentScheduleQueue,
  ]) {
    if (typeof queue.removeAllListeners === "function" && typeof queue.on === "function") {
      queue.removeAllListeners("error");
      queue.on("error", () => {});
    }
  }
}

// ── Deployment enqueue and cancellation ────────────────────────

async function addDeploymentJob(agent, options = undefined) {
  const jobId = options?.jobId ? String(options.jobId) : "";
  if (jobId) {
    const existing = await deployQueue.getJob(jobId);
    if (existing) {
      const state = typeof existing.getState === "function" ? await existing.getState() : "unknown";
      if (["active", "waiting", "waiting-children", "delayed", "prioritized"].includes(state)) {
        return existing;
      }
      if (typeof existing.remove === "function") {
        await existing.remove();
      }
    }
    return deployQueue.add("deploy-agent", agent, { ...options, jobId });
  }
  return deployQueue.add("deploy-agent", agent);
}

async function cancelDeploymentJobsForAgent(agentId) {
  if (!agentId) return { removed: 0, active: 0 };

  const jobs = await deployQueue.getJobs([
    "active",
    "waiting",
    "waiting-children",
    "delayed",
    "prioritized",
    "failed",
  ]);
  const normalizedAgentId = String(agentId);
  let removed = 0;
  let active = 0;

  for (const job of jobs) {
    if (!job || String(job.data?.id || "") !== normalizedAgentId) continue;
    const state = typeof job.getState === "function" ? await job.getState() : "unknown";
    if (state === "active") {
      // BullMQ cannot remove a locked job from another process. The provisioner
      // treats a missing agent row as cancellation before create, after create,
      // and in its failure path, so an in-flight job cannot retry or orphan a
      // runtime after the control-plane row is deleted.
      active += 1;
      continue;
    }
    if (typeof job.remove === "function") {
      await job.remove();
      removed += 1;
    }
  }

  return { removed, active };
}

// ── Other enqueue operations ───────────────────────────────────

/**
 * Enqueue one schedule execution, using runId as payload and BullMQ job identity.
 * Repeated attempts deduplicate only while the corresponding job is retained.
 *
 * @param {Object} payload - Claimed schedule-run payload.
 * @returns {Promise<Object>} BullMQ job.
 */
async function addScheduleRunJob(payload) {
  const jobId = payload?.runId || randomUUID();
  return agentScheduleQueue.add("run-schedule", { ...payload, runId: jobId }, { jobId });
}

/**
 * Enqueue one webhook channel delivery under a stable delivery ID so sibling
 * channels retry independently.
 *
 * @param {Object} payload - Rule, channel, and event delivery context.
 * @returns {Promise<Object>} BullMQ job.
 */
async function addAlertDeliveryJob(payload) {
  const deliveryId = payload?.deliveryId || randomUUID();
  return alertDeliveryQueue.add(
    "deliver-webhook",
    { ...payload, deliveryId },
    { jobId: deliveryId },
  );
}

/**
 * Enqueue a ClawHub operation with a caller-provided or generated job ID.
 * Repeated IDs deduplicate only while the corresponding job is retained.
 *
 * @param {Object} payload - Agent, skill, and operation details.
 * @returns {Promise<Object>} BullMQ job.
 */
async function addClawhubJob(payload) {
  const jobId = payload?.jobId || randomUUID();
  const operation = String(payload?.operation || "").trim() || "install";
  return clawhubJobsQueue.add(`${operation}-skill`, { ...payload, operation, jobId }, { jobId });
}

async function addBackupJob(payload) {
  const jobId = payload?.jobId || payload?.backupId || randomUUID();
  return backupsQueue.add("run-backup", { ...payload, jobId }, { jobId });
}

/**
 * Coalesce Kubernetes policy reconciliation per cluster. Waiting jobs are
 * updated in place, active jobs receive a follow-up, and terminal jobs are
 * replaced.
 *
 * @param {Object} payload - Cluster ID and desired policy hash.
 * @returns {Promise<Object>} Existing, updated, or newly enqueued BullMQ job.
 */
async function addKubernetesPolicyReconcileJob(payload) {
  const clusterId = String(payload?.clusterId || payload?.cluster_id || "").trim();
  if (!clusterId) {
    throw new Error("clusterId is required");
  }
  const desiredHash = String(payload?.desiredHash || payload?.desired_hash || "").trim() || null;
  const jobId = `k8s-policy-${clusterId}`;
  const existingJob = await policySettingsQueue.getJob(jobId);
  if (existingJob) {
    const state =
      typeof existingJob.getState === "function" ? await existingJob.getState() : "unknown";
    if (["waiting", "waiting-children", "delayed", "prioritized"].includes(state)) {
      await existingJob.updateData({ clusterId, desiredHash });
      return existingJob;
    }
    if (state === "active") {
      return policySettingsQueue.add(
        "reconcile-kubernetes-policy-settings",
        { clusterId, desiredHash },
        { jobId: `${jobId}-followup-${randomUUID()}` },
      );
    }
    if (typeof existingJob.remove === "function") {
      await existingJob.remove();
    }
  }
  return policySettingsQueue.add(
    "reconcile-kubernetes-policy-settings",
    { clusterId, desiredHash },
    { jobId },
  );
}

// ── ClawHub job inspection and compatibility helpers ────────────

/**
 * Find an in-flight ClawHub job for the same agent, skill, and optional operation.
 *
 * @param {string} agentId - Agent receiving the operation.
 * @param {string} slug - ClawHub skill slug.
 * @param {string} operation - Optional operation filter.
 * @returns {Promise<Object|null>} Matching BullMQ job, if any.
 */
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

// ── Deployment dead-letter operations ──────────────────────────

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
  policySettingsQueue,
  backupsQueue,
  alertDeliveryQueue,
  agentScheduleQueue,
  addDeploymentJob,
  cancelDeploymentJobsForAgent,
  addScheduleRunJob,
  addClawhubJob,
  addClawhubInstallJob,
  addBackupJob,
  addKubernetesPolicyReconcileJob,
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
