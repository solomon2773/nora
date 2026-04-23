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

const clawhubInstallsQueue = new Queue("clawhub-installs", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: "exponential", delay: 3000 },
    timeout: CLAWHUB_INSTALL_JOB_TIMEOUT_MS,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
});

async function addDeploymentJob(agent) {
  await deployQueue.add("deploy-agent", agent);
}

async function addClawhubInstallJob(payload) {
  const jobId = payload?.jobId || randomUUID();
  return clawhubInstallsQueue.add("install-skill", { ...payload, jobId }, { jobId });
}

async function findInFlightClawhubInstallJob(agentId, slug) {
  if (!agentId || !slug) return null;

  const jobs = await clawhubInstallsQueue.getJobs([
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
    if (matchesAgent && matchesSlug) {
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

async function getClawhubInstallJob(jobId) {
  if (!jobId) return null;
  return clawhubInstallsQueue.getJob(jobId);
}

async function getClawhubInstallJobStatus(jobId) {
  const job = await getClawhubInstallJob(jobId);
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
    status: mapClawhubJobState(state),
    error: failedReason,
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
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
  clawhubInstallsQueue,
  addDeploymentJob,
  addClawhubInstallJob,
  findInFlightClawhubInstallJob,
  getClawhubInstallJob,
  getClawhubInstallJobStatus,
  getDLQJobs,
  retryDLQJob,
  connection,
};
