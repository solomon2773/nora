// @ts-nocheck
// Shared per-agent advisory lock used by control-plane deployment producers,
// destructive restore, and the provisioner. The worker intentionally uses the
// same FNV-1a key derivation so no producer can publish stale replacement work
// while another actor is retiring or restoring that agent's runtime.

const { Client } = require("pg");
const { buildPostgresConfig } = require("./lib/connectionConfig");
const { buildAgentRuntimeFields } = require("./agentRuntimeFields");

function advisoryLockKeyForAgent(agentId) {
  const value = String(agentId);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash ^ BigInt(value.charCodeAt(index))) * prime) & mask;
  }
  return hash > 0x7fffffffffffffffn ? hash - 0x10000000000000000n : hash;
}

function normalizeLockTimeoutMs(value, fallbackMs = 30000) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(10, Math.min(parsed, 120000)) : fallbackMs;
}

function createAgentProvisionLockClient(applicationName) {
  const {
    max: _max,
    idleTimeoutMillis: _idleTimeoutMillis,
    ...clientConfig
  } = buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: applicationName,
  });
  return new Client(clientConfig);
}

async function acquireAgentProvisionLock(
  agentId,
  {
    applicationName = "nora-backend-agent-provision-lock",
    timeoutMs = normalizeLockTimeoutMs(process.env.AGENT_PROVISION_LOCK_TIMEOUT_MS),
  } = {},
) {
  if (agentId == null || String(agentId).trim() === "") {
    throw new Error("agentId is required for the provision lock");
  }

  const client = createAgentProvisionLockClient(applicationName);
  const lockKey = advisoryLockKeyForAgent(agentId).toString();
  const deadline = Date.now() + normalizeLockTimeoutMs(timeoutMs);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    while (true) {
      const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
      if (result.rows[0]?.locked) break;
      if (Date.now() >= deadline) {
        const error = new Error(`Timed out waiting for the provision lock on agent ${agentId}`);
        error.code = "AGENT_PROVISION_LOCK_TIMEOUT";
        error.statusCode = 409;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  } catch (error) {
    if (connected) await client.end().catch(() => {});
    throw error;
  }

  let released = false;
  return {
    query: (...args) => client.query(...args),
    async release() {
      if (released) return;
      released = true;
      let unlockError = null;
      let closeError = null;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      } catch (error) {
        unlockError = error;
      }
      try {
        await client.end();
      } catch (error) {
        closeError = error;
      }
      if (closeError) {
        if (unlockError) closeError.unlockError = unlockError;
        throw closeError;
      }
      if (unlockError) {
        // Closing the dedicated session releases its advisory locks even when
        // the explicit unlock query failed. Do not turn a successfully queued
        // deployment into an ambiguous API error after that safe close.
        console.warn(
          `[agentProvisionLock] advisory unlock failed for agent ${agentId}; the dedicated session was closed: ${unlockError.message}`,
        );
      }
    },
  };
}

function normalizeRuntimeIdentity(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function buildReplacementDeploymentJob(
  agent,
  { runtimeFields, containerName, image, extra = {} } = {},
) {
  if (!agent?.id) throw new Error("agent is required for a replacement deployment");
  const previousRuntimeFields = buildAgentRuntimeFields(agent);
  const desiredRuntimeFields = buildAgentRuntimeFields(runtimeFields || previousRuntimeFields);

  return {
    ...extra,
    id: agent.id,
    name: agent.name,
    userId: agent.user_id,
    backend: desiredRuntimeFields.backend_type,
    runtime_family: desiredRuntimeFields.runtime_family,
    deploy_target: desiredRuntimeFields.deploy_target,
    execution_target_id: desiredRuntimeFields.execution_target_id,
    sandbox_profile: desiredRuntimeFields.sandbox_profile,
    sandbox: desiredRuntimeFields.sandbox_profile,
    specs: {
      vcpu: agent.vcpu || 2,
      ram_mb: agent.ram_mb || 2048,
      disk_gb: agent.disk_gb || 20,
    },
    container_name: containerName ?? agent.container_name ?? null,
    image: image ?? agent.image ?? null,
    replace_existing_runtime: true,
    previous_container_id: normalizeRuntimeIdentity(agent.container_id),
    previous_container_name: normalizeRuntimeIdentity(agent.container_name),
    previous_host: normalizeRuntimeIdentity(agent.host),
    previous_backend: previousRuntimeFields.backend_type,
    previous_runtime_family: previousRuntimeFields.runtime_family,
    previous_deploy_target: previousRuntimeFields.deploy_target,
    previous_execution_target_id: previousRuntimeFields.execution_target_id,
    previous_sandbox_profile: previousRuntimeFields.sandbox_profile,
  };
}

function replacementTupleFromJob(jobData = {}) {
  const requiredFields = [
    "previous_container_id",
    "previous_container_name",
    "previous_host",
    "previous_backend",
    "previous_runtime_family",
    "previous_deploy_target",
    "previous_execution_target_id",
    "previous_sandbox_profile",
  ];
  const missing = requiredFields.filter(
    (field) => !Object.prototype.hasOwnProperty.call(jobData, field),
  );
  if (missing.length > 0) {
    const error = new Error(
      `Replacement deployment is missing the previous runtime tuple: ${missing.join(", ")}`,
    );
    error.code = "AGENT_REPLACEMENT_TUPLE_INCOMPLETE";
    error.statusCode = 409;
    throw error;
  }

  return {
    container_id: normalizeRuntimeIdentity(jobData.previous_container_id),
    container_name: normalizeRuntimeIdentity(jobData.previous_container_name),
    host: normalizeRuntimeIdentity(jobData.previous_host),
    backend_type: normalizeRuntimeIdentity(jobData.previous_backend),
    runtime_family: normalizeRuntimeIdentity(jobData.previous_runtime_family),
    deploy_target: normalizeRuntimeIdentity(jobData.previous_deploy_target),
    execution_target_id: normalizeRuntimeIdentity(jobData.previous_execution_target_id),
    sandbox_profile: normalizeRuntimeIdentity(jobData.previous_sandbox_profile),
  };
}

function assertReplacementJobMatchesAgent(agent, jobData = {}) {
  if (jobData.replace_existing_runtime !== true) {
    const error = new Error("Replacement deployment marker is required");
    error.code = "AGENT_REPLACEMENT_MARKER_MISSING";
    error.statusCode = 409;
    throw error;
  }
  if (String(jobData.id || "") !== String(agent?.id || "")) {
    const error = new Error("Replacement deployment agent identity does not match");
    error.code = "AGENT_REPLACEMENT_STATE_CHANGED";
    error.statusCode = 409;
    throw error;
  }

  const queued = replacementTupleFromJob(jobData);
  const durableRuntimeFields = buildAgentRuntimeFields(agent);
  const durable = {
    container_id: normalizeRuntimeIdentity(agent?.container_id),
    container_name: normalizeRuntimeIdentity(agent?.container_name),
    host: normalizeRuntimeIdentity(agent?.host),
    backend_type: durableRuntimeFields.backend_type,
    runtime_family: durableRuntimeFields.runtime_family,
    deploy_target: durableRuntimeFields.deploy_target,
    execution_target_id: durableRuntimeFields.execution_target_id,
    sandbox_profile: durableRuntimeFields.sandbox_profile,
  };
  const mismatch = Object.keys(durable).find((field) => queued[field] !== durable[field]);
  if (mismatch) {
    const error = new Error(
      `Agent runtime state changed while replacement deployment was being queued (${mismatch})`,
    );
    error.code = "AGENT_REPLACEMENT_STATE_CHANGED";
    error.statusCode = 409;
    throw error;
  }
  return queued;
}

async function enqueueReplacementDeployment(
  agent,
  jobData,
  {
    queryable,
    cancelDeploymentJobsForAgent,
    addDeploymentJob,
    acquireLock = acquireAgentProvisionLock,
    provisionLock = null,
    skipCancellation = false,
    applicationName = "nora-backend-agent-replacement",
  } = {},
) {
  if (!queryable || typeof queryable.query !== "function") {
    throw new TypeError("Replacement deployment requires a queryable database client");
  }
  if (typeof addDeploymentJob !== "function") {
    throw new TypeError("Replacement deployment requires an enqueue function");
  }
  if (!skipCancellation && typeof cancelDeploymentJobsForAgent !== "function") {
    throw new TypeError("Replacement deployment requires a cancellation function");
  }

  const previous = assertReplacementJobMatchesAgent(agent, jobData);
  const lock =
    provisionLock ||
    (await acquireLock(agent.id, {
      applicationName,
    }));
  const ownsLock = !provisionLock;
  let statusTransitioned = false;
  let deploymentInserted = false;
  let enqueueAttempted = false;

  try {
    if (!skipCancellation) {
      const canceledJobs = await cancelDeploymentJobsForAgent(agent.id);
      if (canceledJobs.active > 0) {
        const error = new Error(
          "An earlier deployment is still active for this agent. Try again shortly.",
        );
        error.statusCode = 409;
        throw error;
      }
    }

    const transition = await queryable.query(
      `UPDATE agents
          SET status = 'queued'
        WHERE id = $1
          AND status = $2
          AND container_id IS NOT DISTINCT FROM $3
          AND container_name IS NOT DISTINCT FROM $4
          AND backend_type = $5
          AND runtime_family = $6
          AND deploy_target = $7
          AND execution_target_id = $8
          AND sandbox_profile = $9
          AND host IS NOT DISTINCT FROM $10
        RETURNING id`,
      [
        agent.id,
        agent.status,
        previous.container_id,
        previous.container_name,
        previous.backend_type,
        previous.runtime_family,
        previous.deploy_target,
        previous.execution_target_id,
        previous.sandbox_profile,
        previous.host,
      ],
    );
    if (transition.rowCount === 0) {
      const error = new Error(
        "Agent runtime state changed while replacement deployment was being queued",
      );
      error.code = "AGENT_REPLACEMENT_STATE_CHANGED";
      error.statusCode = 409;
      throw error;
    }
    statusTransitioned = true;

    await queryable.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [
      agent.id,
    ]);
    deploymentInserted = true;

    enqueueAttempted = true;
    return await addDeploymentJob(jobData);
  } catch (error) {
    let cancellation = null;
    if (enqueueAttempted && typeof cancelDeploymentJobsForAgent === "function") {
      try {
        cancellation = await cancelDeploymentJobsForAgent(agent.id);
      } catch (cancelError) {
        error.cancellationError = cancelError;
      }
    }

    const canRestoreStatus =
      statusTransitioned && (!enqueueAttempted || (cancellation && cancellation.active === 0));
    if (canRestoreStatus) {
      const restored = await Promise.allSettled([
        queryable.query("UPDATE agents SET status = $2 WHERE id = $1 AND status = 'queued'", [
          agent.id,
          agent.status,
        ]),
        ...(deploymentInserted
          ? [
              queryable.query(
                "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'",
                [agent.id],
              ),
            ]
          : []),
      ]);
      const restoreFailure = restored.find((result) => result.status === "rejected");
      if (restoreFailure) error.statusRestoreError = restoreFailure.reason;
    }

    throw error;
  } finally {
    if (ownsLock) await lock.release();
  }
}

module.exports = {
  acquireAgentProvisionLock,
  advisoryLockKeyForAgent,
  assertReplacementJobMatchesAgent,
  buildReplacementDeploymentJob,
  enqueueReplacementDeployment,
  normalizeLockTimeoutMs,
  replacementTupleFromJob,
};
