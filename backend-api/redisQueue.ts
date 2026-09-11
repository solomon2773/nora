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
const HERMES_SKILLS_JOB_TIMEOUT_MS = parseTimeoutMs(
  process.env.HERMES_SKILLS_INSTALL_TIMEOUT_MS,
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

// Separate queue per runtime family: sharing clawhub-jobs would couple both
// families' concurrency-1 serialization (a slow Hermes registry install would
// block OpenClaw installs) and renaming a live queue orphans in-flight jobs
// across self-hosted upgrades.
const hermesSkillsQueue = new Queue("hermes-skills-jobs", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: "exponential", delay: 3000 },
    timeout: HERMES_SKILLS_JOB_TIMEOUT_MS,
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

// Trace-ingest span persistence (logging control plane, Phase 11). One job
// per accepted OTLP export request, carrying the already-decoded spans plus
// the authenticated agent's already-resolved workspace_id (never trusted
// from the payload — see routes/otlp.ts). Drained in worker-provisioner by
// spanDrain.ts, which batch-inserts into agent_spans. Kept off the request
// path entirely since a burst of trace exports should never block or slow
// the ingest response.
const spanIngestQueue = new Queue("span-ingest", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
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
    spanIngestQueue,
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
  return clawhubJobsApi.addJob(payload);
}

async function addBackupJob(payload) {
  const jobId = payload?.jobId || payload?.backupId || randomUUID();
  return backupsQueue.add("run-backup", { ...payload, jobId }, { jobId });
}

/**
 * Enqueue one decoded OTLP export request's spans for async persistence.
 * No caller-provided job ID: unlike deploys/backups, replaying the same
 * export twice is harmless (spans have no uniqueness constraint to violate),
 * so there is nothing to deduplicate against.
 *
 * @param {{agentId: string, workspaceId: string|null, spans: object[]}} payload
 * @returns {Promise<Object>} BullMQ job.
 */
async function addSpanIngestJob(payload) {
  return spanIngestQueue.add("ingest-spans", payload);
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

// ── Skill job queues: shared inspection API ─────────────────────

function mapSkillJobState(state) {
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

/**
 * Per-agent skill job queue API shared by the ClawHub (OpenClaw) and Hermes
 * skill queues. The queues stay separate (independent serialization, stable
 * queue names across upgrades); only the add/find/status plumbing is shared.
 * `identityField` names the job-data key that identifies the skill: `slug`
 * for ClawHub, `name` (the Hermes hub lockfile key) for Hermes.
 *
 * @param {Object} queue - BullMQ queue instance.
 * @param {Object} options - `identityField` selecting the skill key.
 * @returns {Object} `{ addJob, findInFlightJob, getJob, getJobStatus }`.
 */
function createSkillJobQueueApi(queue, { identityField = "slug" } = {}) {
  async function addJob(payload) {
    const jobId = payload?.jobId || randomUUID();
    const operation = String(payload?.operation || "").trim() || "install";
    return queue.add(`${operation}-skill`, { ...payload, operation, jobId }, { jobId });
  }

  async function findInFlightJob(agentId, identity, operation) {
    if (!agentId || !identity) return null;

    const jobs = await queue.getJobs([
      "active",
      "waiting",
      "waiting-children",
      "delayed",
      "prioritized",
    ]);

    const normalizedAgentId = String(agentId);
    const normalizedIdentity = String(identity).trim();

    for (const job of jobs) {
      if (!job) continue;
      const matchesAgent = String(job.data?.agentId || "") === normalizedAgentId;
      const matchesIdentity = String(job.data?.[identityField] || "").trim() === normalizedIdentity;
      const matchesOperation = operation
        ? String(job.data?.operation || "").trim() === String(operation).trim()
        : true;
      if (matchesAgent && matchesIdentity && matchesOperation) {
        return job;
      }
    }

    return null;
  }

  async function getJob(jobId) {
    if (!jobId) return null;
    return queue.getJob(jobId);
  }

  async function getJobStatus(jobId) {
    const job = await getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    const failedReason =
      typeof job.failedReason === "string" && job.failedReason.trim()
        ? job.failedReason.trim()
        : null;

    return {
      jobId: String(job.id),
      agentId: job.data?.agentId || null,
      [identityField]: job.data?.[identityField] || null,
      operation: job.data?.operation || "install",
      status: mapSkillJobState(state),
      error: failedReason,
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  return { addJob, findInFlightJob, getJob, getJobStatus };
}

const clawhubJobsApi = createSkillJobQueueApi(clawhubJobsQueue, { identityField: "slug" });
const hermesSkillsJobsApi = createSkillJobQueueApi(hermesSkillsQueue, { identityField: "name" });

// ── ClawHub job inspection and compatibility helpers ────────────

async function findInFlightClawhubJob(agentId, slug, operation) {
  return clawhubJobsApi.findInFlightJob(agentId, slug, operation);
}

async function getClawhubJob(jobId) {
  return clawhubJobsApi.getJob(jobId);
}

async function getClawhubJobStatus(jobId) {
  return clawhubJobsApi.getJobStatus(jobId);
}

// ── Hermes skill job helpers ────────────────────────────────────

async function addHermesSkillJob(payload) {
  return hermesSkillsJobsApi.addJob(payload);
}

async function findInFlightHermesSkillJob(agentId, name, operation) {
  return hermesSkillsJobsApi.findInFlightJob(agentId, name, operation);
}

async function getHermesSkillJobStatus(jobId) {
  return hermesSkillsJobsApi.getJobStatus(jobId);
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
  hermesSkillsQueue,
  policySettingsQueue,
  backupsQueue,
  alertDeliveryQueue,
  agentScheduleQueue,
  spanIngestQueue,
  addDeploymentJob,
  cancelDeploymentJobsForAgent,
  addScheduleRunJob,
  addClawhubJob,
  addClawhubInstallJob,
  addBackupJob,
  addSpanIngestJob,
  addKubernetesPolicyReconcileJob,
  addAlertDeliveryJob,
  findInFlightClawhubJob,
  findInFlightClawhubInstallJob,
  getClawhubJob,
  getClawhubJobStatus,
  getClawhubInstallJob,
  getClawhubInstallJobStatus,
  addHermesSkillJob,
  findInFlightHermesSkillJob,
  getHermesSkillJobStatus,
  getDLQJobs,
  retryDLQJob,
  createSkillJobQueueApi,
  connection,
  BACKUP_JOB_TIMEOUT_MS,
  ALERT_DELIVERY_ATTEMPTS,
};
