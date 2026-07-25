// @ts-nocheck
const { UnrecoverableError, Worker } = require("bullmq");
const { randomBytes } = require("crypto");
const { decrypt: decryptProvisionerSecret } = require("./crypto");
const IORedis = require("ioredis");
const { Client, Pool } = require("pg");
const {
  buildPostgresConfig,
  createRedisClient,
} = require("../../backend-api/lib/connectionConfig");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");
const { NEMOCLAW_DEFAULT_MODEL } = require("../../agent-runtime/lib/nemoclawDefaults");
const {
  runtimeUrlForAgent,
  buildRuntimeAuthHeaders,
} = require("../../agent-runtime/lib/agentEndpoints");
const {
  getDefaultBackend,
  getEnabledBackends,
  isKnownBackend,
  normalizeBackendName,
  normalizeExecutionTargetId,
  runtimeSelectionIssue,
} = require("../../agent-runtime/lib/backendCatalog");
const { buildAgentRuntimeFields } = require("../../agent-runtime/lib/agentRuntimeFields");
const { getAgentSecretEnvVars } = require("../../backend-api/agentSecretOverrides");
const {
  getDeploymentProvider,
  getManagedProviderEnvNames,
  providerMutationLockKey,
} = require("../../backend-api/llmProviders");
const {
  buildHermesSeedArchive,
  getMigrationManifestForAgent,
} = require("../../backend-api/agentMigrations");
const {
  applyPersistedHermesState,
  getPersistedHermesState,
} = require("../../backend-api/hermesUi");
const {
  buildPolicySettingsHash,
  getKubernetesClusterProfile,
  markKubernetesClusterPolicyStatus,
} = require("../../backend-api/kubernetesClusters");
const {
  assertRemoteHostAgentUse,
  isRemoteHostAccessRevokedError,
} = require("../../backend-api/remoteHosts");
const containerManager = require("../../backend-api/containerManager");
const {
  allocateGatewayPort,
  DEFAULT_RANGE_MIN,
  DEFAULT_RANGE_MAX,
  reallocateGatewayPort,
  LOCAL_HOST_KEY,
  GATEWAY_PORT_PURPOSE,
  DASHBOARD_PORT_PURPOSE,
  RUNTIME_PORT_PURPOSE,
} = require("../../backend-api/portAllocations");
const {
  createWithDockerPortRetry,
  getOccupiedDockerPublishedPorts,
} = require("./backends/dockerPublishedPorts");
const { getIntegrationEnvVars, getIntegrationsForSync } = require("../../backend-api/integrations");
const mcpServers = require("../../backend-api/mcpServers");
const {
  HERMES_INTEGRATIONS_CONFIG_FILE,
  HERMES_INTEGRATIONS_DIR,
  buildHermesIntegrationInstallCommand,
} = require("../../backend-api/integrationRuntimeFiles");
const {
  NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
  NORA_SYNC_INTEGRATIONS_DIR,
} = require("../../agent-runtime/lib/integrationTools");
const {
  buildOpenClawAuthProfilesWriteCommand,
  buildOpenClawConfigMergeCommand,
  buildOpenClawCustomProviders,
  buildOpenClawManagedMcpServersCommand,
  buildOpenClawManagedProviderStateCommand,
  buildOpenClawModelForProvider,
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServerEnvAlias,
  buildMcpServersConfig,
  encodeOpenClawManagedMcpServers,
  mapNoraProviderIdToOpenClaw,
  OPENCLAW_MANAGED_MCP_SERVERS_ENV,
} = require("../../agent-runtime/lib/runtimeBootstrap");
const {
  buildHermesRuntimeBootstrapEnv,
} = require("../../agent-runtime/lib/hermesRuntimeBootstrap");
const { waitForAgentReadiness } = require("./healthChecks");
const { runDemoActivationCanary } = require("./demoActivationCanary");
const {
  acquireDedicatedSessionLock,
  finalizeProvisionedDeployment,
  fingerprintEffectiveProviderState,
  isBuiltInDemoActivation,
  persistProvisionedRuntimeMetadata,
  reconcileProviderStateUntilStable,
  runProvisioningReadinessBarrier,
  runRuntimeReconciliationBoundary,
  shouldReconcileEffectiveProviderState,
} = require("./deploymentLifecycle");
const { shellSingleQuote } = require("../../agent-runtime/lib/containerCommand");
const {
  computeMissingSavedSkills,
  computeOrphanedInstalledSkills,
  removeSavedSkillEntry,
  normalizeSavedSkillEntry: normalizeSavedClawhubSkillEntry,
} = require("../../agent-runtime/lib/clawhubReconciliation");

const REMOTE_PROVISIONER_AUTHORIZATION = Symbol("remoteProvisionerAuthorization");
const REMOTE_PROVISIONER_CLEANUP_EXEC = Symbol("remoteProvisionerCleanupExec");
const REMOTE_AUTHORIZATION_FAILURE = Symbol("remoteAuthorizationFailure");
const REMOTE_EXEC_AUTH_RECHECK_MS = 2000;
const PROVISIONER_EXEC_CLEANUP_TIMEOUT_MS = 8000;
const PROVISIONER_EXEC_TERMINATION_FAILURE_MARKER = "NORA_EXEC_WRAPPER_TERMINATION_UNCONFIRMED";
const PROVISIONER_EXEC_TERMINATION_STATE_VERSION = "nora-exec-termination-v1";

// ── Connections ──────────────────────────────────────────
const connection = createRedisClient(IORedis, process.env, {
  maxRetriesPerRequest: null,
});

const db = new Pool(
  buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: process.env.DB_APPLICATION_NAME || "nora-worker-provisioner",
  }),
);

function createProvisionerLockClient(scope) {
  const {
    max: _max,
    idleTimeoutMillis: _idleTimeoutMillis,
    ...clientConfig
  } = buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: `nora-worker-provisioner-${scope}`,
  });
  return new Client(clientConfig);
}

// Hash any agent ID (uuid string or integer) to a signed 64-bit BigInt suitable
// for pg_try_advisory_lock(bigint). Uses FNV-1a over the string form. The lock
// keyspace only needs to be collision-resistant within the active agent set.
function advisoryLockKeyForAgent(agentId) {
  const str = String(agentId);
  let hash = 0xcbf29ce484222325n; // FNV-1a 64-bit offset basis
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash ^ BigInt(str.charCodeAt(i))) * prime) & mask;
  }
  // pg bigint is signed; fold the high bit so the value fits in int8 range.
  return hash > 0x7fffffffffffffffn ? hash - 0x10000000000000000n : hash;
}

/**
 * Acquire a per-agent session-level advisory lock so two concurrent provision
 * jobs for the same agent ID (same worker or different worker replicas) cannot
 * both call adapter.create() and double-provision containers.
 *
 * Returns a handle that must be released in a finally block. The lock is tied
 * to the pg client's session: a worker crash drops the connection and the
 * lock is released by Postgres automatically.
 */
async function acquireAgentProvisionLock(agentId) {
  const lockKey = advisoryLockKeyForAgent(agentId);
  return acquireDedicatedSessionLock({
    createClient: () => createProvisionerLockClient("agent-lock"),
    acquire: (client) =>
      client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey.toString()]),
    release: (client) => client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]),
    isAcquired: (result) => Boolean(result.rows[0]?.locked),
    busyError: () => {
      const error = new Error(`Agent ${agentId} is already being provisioned by another worker`);
      error.code = "PROVISION_LOCK_BUSY";
      return error;
    },
    onReleaseError: (error) =>
      console.warn(`[provisioner] advisory unlock failed for agent ${agentId}: ${error.message}`),
    onCloseError: (error) =>
      console.warn(
        `[provisioner] advisory lock connection close failed for agent ${agentId}: ${error.message}`,
      ),
  });
}

async function withProviderMutationLock(userId, operation) {
  if (!userId || typeof operation !== "function") {
    throw new Error("userId and operation are required for the provider mutation lock");
  }
  const lockKey = providerMutationLockKey(userId);
  const lock = await acquireDedicatedSessionLock({
    createClient: () => createProvisionerLockClient("provider-mutation-lock"),
    acquire: (client) =>
      client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]),
    release: (client) =>
      client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]),
    onReleaseError: (error) =>
      console.warn(
        `[provisioner] provider advisory unlock failed for user ${userId}: ${error.message}`,
      ),
    onCloseError: (error) =>
      console.warn(
        `[provisioner] provider lock connection close failed for user ${userId}: ${error.message}`,
      ),
  });
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function acquireKubernetesPolicyReconcileLock(clusterId) {
  const lockKey = advisoryLockKeyForAgent(`k8s-policy:${clusterId}`);
  return acquireDedicatedSessionLock({
    createClient: () => createProvisionerLockClient("k8s-policy-lock"),
    acquire: (client) => client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]),
    release: (client) => client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]),
    onReleaseError: (error) =>
      console.warn(
        `[k8s-policy-settings] advisory unlock failed for ${clusterId}: ${error.message}`,
      ),
    onCloseError: (error) =>
      console.warn(
        `[k8s-policy-settings] lock connection close failed for ${clusterId}: ${error.message}`,
      ),
  });
}

function parseTimeoutMs(rawValue, fallbackMs) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : fallbackMs;
}

function parsePositiveInteger(rawValue, fallbackValue, { min = 1, max = 32 } = {}) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallbackValue;
  return Math.min(max, Math.max(min, parsed));
}

function deploymentAttemptInfo(job = {}) {
  const attemptsMade = Number.isFinite(Number(job?.attemptsMade))
    ? Math.max(0, Number(job.attemptsMade))
    : 0;
  const maxAttempts = Number.isFinite(Number(job?.opts?.attempts))
    ? Math.max(1, Number(job.opts.attempts))
    : 1;
  return { attempt: attemptsMade + 1, maxAttempts };
}

function isFinalDeploymentAttempt(job) {
  const { attempt, maxAttempts } = deploymentAttemptInfo(job);
  return attempt >= maxAttempts;
}

function isUnrecoverableDeploymentError(error) {
  return error?.name === "UnrecoverableError";
}

const LEGACY_BACKEND_TYPE_ALIASES = new Set(["hermes", "nemoclaw"]);

function normalizeProvisionerDeployTarget(
  value,
  { field = "deploy target", allowLegacyBackendAlias = false } = {},
) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return null;

  const normalizedValue = rawValue.toLowerCase();
  if (allowLegacyBackendAlias && LEGACY_BACKEND_TYPE_ALIASES.has(normalizedValue)) {
    return null;
  }
  if (!isKnownBackend(rawValue)) {
    const error = new UnrecoverableError(`Unknown ${field}: ${rawValue}`);
    error.code = "UNKNOWN_DEPLOY_TARGET";
    throw error;
  }
  return normalizeBackendName(rawValue);
}

function normalizeProvisionerExecutionTargetId(value, { field = "execution target" } = {}) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return null;

  const normalizedValue = normalizeExecutionTargetId(rawValue);
  if (!normalizedValue) {
    const error = new UnrecoverableError(`Unknown ${field}: ${rawValue}`);
    error.code = "UNKNOWN_DEPLOY_TARGET";
    throw error;
  }
  return normalizedValue;
}

function toUnrecoverableRuntimeSelectionError(error) {
  if (isUnrecoverableDeploymentError(error)) return error;
  if (
    ![
      "UNKNOWN_DEPLOY_TARGET",
      "UNKNOWN_RUNTIME_FAMILY",
      "UNKNOWN_SANDBOX_PROFILE",
      "RUNTIME_SELECTION_TARGET_MISMATCH",
    ].includes(error?.code)
  ) {
    return error;
  }

  const unrecoverable = new UnrecoverableError(error.message);
  unrecoverable.code = error.code;
  if (error.statusCode != null) unrecoverable.statusCode = error.statusCode;
  unrecoverable.cause = error;
  return unrecoverable;
}

function assertProvisionerRuntimeSelection(runtimeFields, env = process.env) {
  const issue = runtimeSelectionIssue(
    {
      runtimeFamily: runtimeFields.runtime_family,
      deployTarget: runtimeFields.deploy_target,
      executionTargetId: runtimeFields.execution_target_id,
      sandboxProfile: runtimeFields.sandbox_profile,
    },
    env,
  );
  if (!issue) return runtimeFields;

  const error = new UnrecoverableError(`Invalid runtime selection: ${issue}`);
  error.code = "INVALID_RUNTIME_SELECTION";
  error.statusCode = 400;
  throw error;
}

function resolveCanonicalDeploymentOwnerUserId(jobData = {}, agentRow = {}) {
  const ownerUserId = String(agentRow.user_id || "").trim();
  if (!ownerUserId) {
    const error = new UnrecoverableError(
      `Deployment job for agent ${jobData.id || agentRow.id || "unknown"} has no canonical owner`,
    );
    error.code = "DEPLOYMENT_OWNER_MISSING";
    throw error;
  }

  const queuedUserId = jobData.userId;
  if (queuedUserId !== undefined && queuedUserId !== null) {
    const normalizedQueuedUserId = String(queuedUserId).trim();
    if (normalizedQueuedUserId !== ownerUserId) {
      const error = new UnrecoverableError(
        `Deployment job owner does not match the persisted owner for agent ${jobData.id || agentRow.id || "unknown"}`,
      );
      error.code = "DEPLOYMENT_OWNER_MISMATCH";
      error.statusCode = 403;
      throw error;
    }
  }

  return ownerUserId;
}

async function allocateAvailableLocalDockerGatewayPort({
  agentId,
  containerName,
  provisioner,
  allocatePort = allocateGatewayPort,
  queryable = db,
} = {}) {
  let rangeMin = DEFAULT_RANGE_MIN;

  while (rangeMin <= DEFAULT_RANGE_MAX) {
    const port = await allocatePort({
      hostKey: LOCAL_HOST_KEY,
      agentId,
      purpose: GATEWAY_PORT_PURPOSE,
      rangeMin,
      rangeMax: DEFAULT_RANGE_MAX,
    });
    const bound =
      typeof provisioner?.isHostPortBound === "function"
        ? await provisioner.isHostPortBound(port, { ignoreContainerName: containerName })
        : false;
    if (!bound) return port;

    console.warn(
      `[provisioner] Local Docker host port ${port} is already published outside Nora's allocation table; trying the next slot`,
    );
    await queryable.query(
      `DELETE FROM gateway_port_allocations
        WHERE host_key = $1 AND agent_id = $2 AND purpose = $3 AND port = $4`,
      [LOCAL_HOST_KEY, agentId, GATEWAY_PORT_PURPOSE, port],
    );
    rangeMin = Number(port) + 1;
  }

  const error = new Error(
    `No Docker-publishable gateway port available on ${LOCAL_HOST_KEY} (range ${DEFAULT_RANGE_MIN}-${DEFAULT_RANGE_MAX}).`,
  );
  error.statusCode = 503;
  throw error;
}

async function persistProvisioningFailure({
  queryable = db,
  job,
  agentId,
  name,
  error,
  forceTerminal = false,
} = {}) {
  const existing = await queryable.query("SELECT id FROM agents WHERE id = $1", [agentId]);
  if (!existing.rows[0]) {
    return { canceled: true, terminal: false };
  }

  const { attempt, maxAttempts } = deploymentAttemptInfo(job);
  const retrySuppressed = forceTerminal || isUnrecoverableDeploymentError(error);
  const terminal = retrySuppressed || isFinalDeploymentAttempt(job);
  if (!terminal) {
    await queryable.query(
      "UPDATE agents SET status = 'queued' WHERE id = $1 AND status IN ('deploying', 'running', 'warning')",
      [agentId],
    );
    await queryable.query(
      "UPDATE deployments SET status = 'queued' WHERE agent_id = $1 AND status IN ('deploying', 'completed')",
      [agentId],
    );
    return { canceled: false, terminal: false };
  }

  await queryable.query("UPDATE agents SET status = 'error' WHERE id = $1", [agentId]);
  await queryable.query("UPDATE deployments SET status = 'failed' WHERE agent_id = $1", [agentId]);
  await queryable.query("INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)", [
    "agent_deploy_failed",
    `Agent "${name}" failed to deploy: ${error?.message || "Unknown provisioning error"}`,
    JSON.stringify({
      agentId,
      attempt,
      maxAttempts,
      ...(retrySuppressed ? { retrySuppressed: true } : {}),
      ...(error?.containerId ? { containerId: String(error.containerId) } : {}),
    }),
  ]);
  return { canceled: false, terminal: true };
}

async function persistProvisionedRuntimeIdentity({
  queryable = db,
  agentId,
  containerId,
  containerName = null,
} = {}) {
  const result = await queryable.query(
    `UPDATE agents
        SET container_id = COALESCE(container_id, $2),
            container_name = COALESCE($3, container_name)
      WHERE id = $1
        AND (container_id IS NULL OR container_id = $2)
      RETURNING id, container_id`,
    [agentId, containerId, containerName],
  );
  return {
    persisted: Boolean(result.rows[0]),
    containerId: result.rows[0]?.container_id || null,
  };
}

async function preserveUnresolvedRuntimeIdentity({ queryable, agentId, containerId } = {}) {
  try {
    return await persistProvisionedRuntimeIdentity({ queryable, agentId, containerId });
  } catch (error) {
    console.error(
      `[provisioner] Failed to persist unresolved runtime ${containerId} for agent ${agentId}: ${error.message}`,
    );
    return { persisted: false, containerId: null, error };
  }
}

function buildUnresolvedRuntimeError({ agentId, containerId, error } = {}) {
  const runtimeLabel = containerId ? `runtime ${containerId}` : "a possibly created runtime";
  const unresolvedError = new UnrecoverableError(
    `Automatic retry disabled for agent ${agentId}: ${runtimeLabel} could not be safely reconciled after provisioning failed. Resolve the existing runtime before retrying. ${error?.message || "Unknown provisioning error"}`,
  );
  unresolvedError.code = "UNRESOLVED_RUNTIME_IDENTITY";
  unresolvedError.containerId = containerId || null;
  if (error) unresolvedError.cause = error;
  return unresolvedError;
}

async function failDeploymentForUnresolvedRuntime({
  queryable = db,
  job,
  agentId,
  name,
  containerId,
  error,
} = {}) {
  const unresolvedError = buildUnresolvedRuntimeError({ agentId, containerId, error });
  try {
    const failure = await persistProvisioningFailure({
      queryable,
      job,
      agentId,
      name,
      error: unresolvedError,
      forceTerminal: true,
    });
    if (failure.canceled) {
      return { canceled: true, reason: "agent-deleted-with-unresolved-runtime" };
    }
  } catch (persistError) {
    console.error(
      `[provisioner] Failed to persist terminal state for unresolved runtime ${containerId || "unknown"} on agent ${agentId}: ${persistError.message}`,
    );
  }
  throw unresolvedError;
}

async function cleanupProvisionedRuntimeAfterFailure({
  queryable = db,
  provisioner,
  agentId,
  containerId,
  destroyAllowed = true,
  persistIdentity = true,
} = {}) {
  if (!containerId) {
    return { destroyed: false, reason: "no-runtime", retrySafe: true };
  }

  if (typeof provisioner?.destroy !== "function") {
    const identity = persistIdentity
      ? await preserveUnresolvedRuntimeIdentity({ queryable, agentId, containerId })
      : { persisted: false, containerId: null };
    return {
      destroyed: false,
      reason: "destroy-unavailable",
      retrySafe: false,
      identityPersisted: identity.persisted,
    };
  }

  if (!destroyAllowed) {
    const identity = persistIdentity
      ? await preserveUnresolvedRuntimeIdentity({ queryable, agentId, containerId })
      : { persisted: false, containerId: null };
    return {
      destroyed: false,
      reason: "destroy-not-authorized",
      retrySafe: false,
      identityPersisted: identity.persisted,
      ...(identity.error ? { error: identity.error } : {}),
    };
  }

  try {
    await provisioner.destroy(containerId, { agentId });
  } catch (error) {
    console.error(
      `[provisioner] Failed to clean runtime ${containerId} for agent ${agentId}: ${error.message}`,
    );
    const identity = persistIdentity
      ? await preserveUnresolvedRuntimeIdentity({ queryable, agentId, containerId })
      : { persisted: false, containerId: null };
    return {
      destroyed: false,
      reason: "destroy-failed",
      retrySafe: false,
      identityPersisted: identity.persisted,
      error,
    };
  }

  try {
    await queryable.query(
      `UPDATE agents
          SET container_id = NULL,
              host = NULL,
              runtime_host = NULL,
              runtime_port = NULL,
              gateway_host = NULL,
              gateway_port = NULL,
              gateway_host_port = NULL,
              gateway_token = NULL,
              dashboard_port = NULL
        WHERE id = $1 AND container_id = $2`,
      [agentId, containerId],
    );
  } catch (error) {
    console.warn(
      `[provisioner] Runtime ${containerId} was destroyed but identity cleanup failed for agent ${agentId}: ${error.message}`,
    );
    return {
      destroyed: true,
      reason: "identity-clear-failed",
      retrySafe: false,
      error,
    };
  }

  return { destroyed: true, retrySafe: true };
}

async function reconcileProvisioningFailureRuntime({
  queryable = db,
  provisioner,
  agentId,
  containerId,
  error,
} = {}) {
  const runtimeIdentity = error?.runtimeIdentity || null;
  const unresolvedContainerId = containerId || runtimeIdentity?.containerId || null;
  if (!unresolvedContainerId) {
    return { destroyed: false, reason: "no-runtime", retrySafe: true, containerId: null };
  }
  const cleanup = await cleanupProvisionedRuntimeAfterFailure({
    queryable,
    provisioner,
    agentId,
    containerId: unresolvedContainerId,
    destroyAllowed: runtimeIdentity?.destroyAllowed !== false,
    persistIdentity: runtimeIdentity?.persistIdentity !== false,
  });
  return { ...cleanup, containerId: unresolvedContainerId };
}

async function cleanupCanceledProvisionedRuntime({
  queryable = db,
  provisioner,
  agentId,
  containerId,
  reason,
} = {}) {
  const cleanup = await cleanupProvisionedRuntimeAfterFailure({
    queryable,
    provisioner,
    agentId,
    containerId,
  });
  if (!cleanup.retrySafe) {
    const error = buildUnresolvedRuntimeError({
      agentId,
      containerId,
      error:
        cleanup.error ||
        new Error(`Canceled deployment cleanup could not be verified (${cleanup.reason})`),
    });
    error.code = "CANCELED_RUNTIME_CLEANUP_FAILED";
    error.cancellationReason = reason || "deployment-canceled";
    throw error;
  }
  return { canceled: true, reason: reason || "deployment-canceled", cleanup };
}

function isCanceledRuntimeCleanupFailure(error) {
  return error?.code === "CANCELED_RUNTIME_CLEANUP_FAILED";
}

const OPENCLAW_WORKSPACE_PATH = "/root/.openclaw/workspace";
const CLAWHUB_LOCKFILE_PATH = `${OPENCLAW_WORKSPACE_PATH}/.clawhub/lock.json`;
const CLAWHUB_INSTALL_TIMEOUT_MS = parseTimeoutMs(process.env.CLAWHUB_INSTALL_TIMEOUT_MS, 300000);
const CLAWHUB_INSTALL_LOCK_DURATION_MS = Math.max(CLAWHUB_INSTALL_TIMEOUT_MS + 120000, 420000);
const CLAWHUB_INSTALL_LOCK_RENEW_MS = Math.max(
  Math.min(Math.floor(CLAWHUB_INSTALL_LOCK_DURATION_MS / 2), 120000),
  30000,
);
const K8S_POLICY_RECONCILE_CONCURRENCY = parsePositiveInteger(
  process.env.K8S_POLICY_RECONCILE_WORKER_CONCURRENCY,
  1,
  { min: 1, max: 8 },
);

const PROVIDER_ENV_MAP = Object.freeze({
  // Zero-key demo stub; the sister NORA_DEMO_LLM_BASE_URL env var comes from
  // the provider row's config.baseUrl through the standard mechanism below.
  demo: "NORA_DEMO_LLM_TOKEN",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together: "TOGETHER_API_KEY",
  cohere: "COHERE_API_KEY",
  xai: "XAI_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  zai: "ZAI_API_KEY",
  ollama: "OLLAMA_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  huggingface: "HF_TOKEN",
  cerebras: "CEREBRAS_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  "microsoft-foundry": "MICROSOFT_FOUNDRY_API_KEY",
});
const PROVIDER_ENV_NAMES = new Set(Object.values(PROVIDER_ENV_MAP));
const MANAGED_OPENCLAW_AUTH_PROFILE_IDS = [
  ...new Set(
    Object.keys(PROVIDER_ENV_MAP)
      .map(mapNoraProviderIdToOpenClaw)
      .filter(Boolean)
      .map((providerId) => `${providerId}:default`),
  ),
];
const MANAGED_OPENCLAW_MODEL_PROVIDER_IDS = [
  ...new Set(Object.keys(PROVIDER_ENV_MAP).map(mapNoraProviderIdToOpenClaw).filter(Boolean)),
];

function buildMcpAliasPlaceholderEntries(enabledIds = []) {
  const entries = [];
  for (const provider of mcpServers.normalizeEnabledIds(enabledIds)) {
    const mapping = mcpServers.SUPPORTED_MCP_PROVIDERS[provider];
    if (!mapping) continue;
    const env = {};
    if (mapping.primaryEnv) env[mapping.primaryEnv] = "managed";
    for (const envName of Object.values(mapping.configEnv || {})) {
      if (envName) env[envName] = "managed";
    }
    entries.push({ name: provider, npmPackage: "managed-placeholder", env });
  }
  return entries;
}

function buildCredentialManagedEnvNames({
  runtimeFamily = "openclaw",
  integrationEnvNames = [],
  mcpEnabledIds = [],
  preservedEnvNames = [],
} = {}) {
  const preserved = new Set((preservedEnvNames || []).map((name) => String(name || "")));
  const names = new Set([
    ...getManagedProviderEnvNames({ runtimeFamily }),
    ...(integrationEnvNames || []),
    ...buildMcpManagedEnvNames(buildMcpAliasPlaceholderEntries(mcpEnabledIds)),
  ]);
  if (String(runtimeFamily).toLowerCase() === "openclaw") {
    names.add(OPENCLAW_MANAGED_MCP_SERVERS_ENV);
  }
  return [...names].filter((name) => name && !preserved.has(name)).sort();
}

const PROVIDER_ENV_ENDPOINT_MAP = Object.freeze({
  GEMINI_API_KEY: "https://generativelanguage.googleapis.com/v1beta",
  NVIDIA_API_KEY: "https://integrate.api.nvidia.com/v1",
  // MICROSOFT_FOUNDRY_API_KEY: per-resource; supplied from user config at sync time, not a static default.
});

const PROVIDER_MODEL_DEFAULTS = Object.freeze({
  // Bare model id — prefixed with the OpenClaw provider id (nora-demo) via
  // buildOpenClawModelForProvider, same as microsoft-foundry below.
  demo: "nora-demo-1",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.5",
  google: "gemini-3.1-pro-preview",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  deepseek: "deepseek-chat",
  openrouter: "openrouter/auto",
  together: "together/moonshotai/Kimi-K2.5",
  cohere: "command-r-plus",
  xai: "grok-4",
  nvidia: NEMOCLAW_DEFAULT_MODEL,
  moonshot: "kimi-k2.5",
  zai: "glm-5",
  minimax: "MiniMax-M2.7",
  // Bare deployment name — buildDefaultOpenClawModel prefixes it with the
  // OpenClaw provider id (azure-openai-responses) via buildOpenClawModelForProvider.
  "microsoft-foundry": "gpt-5.5-1",
});

const HERMES_NATIVE_PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({ provider: "anthropic" }),
  deepseek: Object.freeze({ provider: "deepseek" }),
  google: Object.freeze({ provider: "gemini" }),
  huggingface: Object.freeze({ provider: "huggingface" }),
  minimax: Object.freeze({ provider: "minimax" }),
  moonshot: Object.freeze({ provider: "kimi-coding" }),
  openrouter: Object.freeze({
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  }),
  xai: Object.freeze({ provider: "xai" }),
  zai: Object.freeze({ provider: "zai" }),
});

const HERMES_CUSTOM_PROVIDER_BASE_URLS = Object.freeze({
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openai: "https://api.openai.com/v1",
  together: "https://api.together.xyz/v1",
  // microsoft-foundry intentionally omitted: Foundry endpoints are per-resource
  // (https://<resource>.services.ai.azure.com/openai/v1/), so users must supply
  // base_url via their saved provider config. There is no useful shared default.
});

const DOCKER_EXEC_FALLBACK_BACKENDS = new Set(["docker", "proxmox"]);

function normalizeEnvValueMap(envVars = {}) {
  return Object.fromEntries(
    Object.entries(envVars || {})
      .filter(([key, value]) => key && value != null && String(value) !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

function buildAuthProfiles(providerKeys = {}) {
  const envToProvider = Object.fromEntries(
    Object.entries(PROVIDER_ENV_MAP).map(([provider, envVar]) => [envVar, provider]),
  );
  const normalized = normalizeEnvValueMap(providerKeys);
  const profiles = {};
  const order = {};
  const lastGood = {};
  for (const [envVar, key] of Object.entries(normalized)) {
    const provider = envToProvider[envVar];
    if (!provider) continue;
    const profileId = `${provider}:default`;
    // Endpoint precedence: per-user {PROVIDER}_BASE_URL (passed alongside the key)
    // wins over the static PROVIDER_ENV_ENDPOINT_MAP catalog default.
    const baseUrlEnv = envVar.replace(/_API_KEY$|_TOKEN$/, "_BASE_URL");
    const apiVersionEnv = envVar.replace(/_API_KEY$|_TOKEN$/, "_API_VERSION");
    const endpoint =
      (baseUrlEnv !== envVar && normalized[baseUrlEnv]) || PROVIDER_ENV_ENDPOINT_MAP[envVar] || "";
    const apiVersion = apiVersionEnv !== envVar ? normalized[apiVersionEnv] || "" : "";
    profiles[profileId] = {
      type: "api_key",
      provider,
      key,
      ...(endpoint ? { endpoint } : {}),
      ...(apiVersion ? { api_version: apiVersion } : {}),
    };
    order[provider] = [profileId];
    lastGood[provider] = profileId;
  }
  return {
    version: 1,
    profiles,
    ...(Object.keys(order).length > 0 ? { order } : {}),
    ...(Object.keys(lastGood).length > 0 ? { lastGood } : {}),
  };
}

function buildAuthProfilesWriteCommand(authProfiles) {
  return buildOpenClawAuthProfilesWriteCommand(authProfiles, {
    managedProfileIds: MANAGED_OPENCLAW_AUTH_PROFILE_IDS,
  });
}

function buildDefaultOpenClawModel(defaultProvider = null) {
  if (!defaultProvider) return null;

  const modelId = defaultProvider.model || PROVIDER_MODEL_DEFAULTS[defaultProvider.provider];
  if (!modelId) return null;

  return buildOpenClawModelForProvider(defaultProvider.provider, modelId);
}

function normalizeProviderConfig(config) {
  if (!config) return {};
  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === "object" && !Array.isArray(config) ? config : {};
}

function pickProviderBaseUrl(config = {}) {
  for (const key of ["base_url", "baseUrl", "endpoint", "url"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeUrlForCompare(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function resolveHermesProviderBaseUrl(defaultProvider = null) {
  if (!defaultProvider) return "";
  const providerId = String(defaultProvider.provider || "").trim();
  if (!providerId) return "";

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  return savedBaseUrl || HERMES_CUSTOM_PROVIDER_BASE_URLS[providerId] || "";
}

function resolveHermesModelApiKey(defaultProvider = null, envVars = {}) {
  const providerId = String(defaultProvider?.provider || "").trim();
  const envVar = PROVIDER_ENV_MAP[providerId];
  return envVar && envVars?.[envVar] ? String(envVars[envVar]) : "";
}

function attachHermesCustomApiKey(modelConfig = null, defaultProvider = null, envVars = {}) {
  if (!modelConfig || String(modelConfig.provider || "").trim() !== "custom") return modelConfig;

  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  if (!apiKey) return modelConfig;

  const defaultBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);
  const modelBaseUrl = String(modelConfig.baseUrl || "").trim();
  if (
    modelBaseUrl &&
    defaultBaseUrl &&
    normalizeUrlForCompare(modelBaseUrl) !== normalizeUrlForCompare(defaultBaseUrl)
  ) {
    return modelConfig;
  }

  return { ...modelConfig, apiKey };
}

function buildHermesModelConfig(defaultProvider = null, envVars = {}) {
  if (!defaultProvider) return null;

  const providerId = String(defaultProvider.provider || "").trim();
  if (!providerId) {
    throw new Error("Default LLM provider is missing a provider id");
  }

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  const modelId =
    typeof defaultProvider.model === "string" && defaultProvider.model.trim()
      ? defaultProvider.model.trim()
      : PROVIDER_MODEL_DEFAULTS[providerId];

  if (!modelId) {
    throw new Error(`Default provider ${providerId} needs a saved model before Hermes can use it`);
  }

  const nativeProvider = HERMES_NATIVE_PROVIDER_MAP[providerId];
  if (nativeProvider) {
    return {
      provider: nativeProvider.provider,
      defaultModel: modelId,
      baseUrl: nativeProvider.baseUrl || savedBaseUrl || null,
    };
  }

  const resolvedBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);

  if (!resolvedBaseUrl) {
    throw new Error(`Provider ${providerId} needs a base URL before Hermes can use it`);
  }

  const modelConfig = {
    provider: "custom",
    defaultModel: modelId,
    baseUrl: resolvedBaseUrl,
  };
  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  return apiKey ? { ...modelConfig, apiKey } : modelConfig;
}

function buildHermesRuntimeBootstrapEnvFor(defaultProvider = null, envVars = {}) {
  return buildHermesRuntimeBootstrapEnv({
    envVars,
    modelConfig: buildHermesModelConfig(defaultProvider, envVars),
  });
}

function hasMeaningfulHermesModelConfig(modelConfig = {}) {
  return Boolean(
    String(modelConfig?.defaultModel || "").trim() ||
    String(modelConfig?.provider || "").trim() ||
    String(modelConfig?.baseUrl || "").trim(),
  );
}

function escapeDotenvValue(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"')}"`;
}

function buildHermesEnvWriteCommand(envVars = {}) {
  const managedBlock = Object.entries(normalizeEnvValueMap(envVars))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeDotenvValue(value)}`)
    .join("\n");
  const blockB64 = Buffer.from(managedBlock).toString("base64");

  return [
    "set -eu",
    'start_marker="# >>> NORA MANAGED ENV >>>"',
    'end_marker="# <<< NORA MANAGED ENV <<<"',
    'tmp_file="$(mktemp)"',
    "if [ -f /opt/data/.env ]; then",
    '  awk -v start="$start_marker" -v end="$end_marker" \'BEGIN{skip=0} $0==start {skip=1; next} $0==end {skip=0; next} !skip {print}\' /opt/data/.env > "$tmp_file"',
    "else",
    '  : > "$tmp_file"',
    "fi",
    'if [ -s "$tmp_file" ]; then printf \'\\n\' >> "$tmp_file"; fi',
    'printf \'%s\\n\' "$start_marker" >> "$tmp_file"',
    `printf '%s' ${shellSingleQuote(blockB64)} | base64 -d >> "$tmp_file"`,
    "printf '\\n' >> \"$tmp_file\"",
    'printf \'%s\\n\' "$end_marker" >> "$tmp_file"',
    'chown hermes:hermes "$tmp_file" 2>/dev/null || true',
    'chmod 0600 "$tmp_file"',
    'mv "$tmp_file" /opt/data/.env',
    "chown hermes:hermes /opt/data/.env 2>/dev/null || true",
    "chmod 0600 /opt/data/.env",
  ].join("\n");
}

function buildHermesSeedError({ agentId, code, message, cause = null } = {}) {
  const error = new Error(`Hermes seed restore for agent ${agentId || "unknown"} ${message}`);
  error.code = code;
  error.agentId = agentId || null;
  if (cause) error.cause = cause;
  return error;
}

async function repairHermesSeedOwnership(provisioner, containerId, agentId) {
  return runProvisionerExecCommand(
    provisioner,
    containerId,
    "chown -R hermes:hermes /opt/data/workspace",
    { timeout: 30000, agentId },
  );
}

async function seedHermesArchiveForDeployment({
  agentId,
  provisioner,
  containerId,
  loadManifest = getMigrationManifestForAgent,
  buildSeedArchive = buildHermesSeedArchive,
  authorize = assertProvisionerAuthorized,
  repairOwnership = repairHermesSeedOwnership,
} = {}) {
  let migrationManifest;
  try {
    migrationManifest = await loadManifest(agentId);
  } catch (error) {
    throw buildHermesSeedError({
      agentId,
      code: "HERMES_SEED_MANIFEST_LOAD_FAILED",
      message: `could not load its attached migration manifest: ${error.message}`,
      cause: error,
    });
  }

  if (!migrationManifest) {
    return { seeded: false, reason: "manifest-missing" };
  }

  const seedFiles = Array.isArray(migrationManifest?.hermesSeed?.files)
    ? migrationManifest.hermesSeed.files
    : [];
  if (seedFiles.length === 0) return { seeded: false, reason: "archive-empty" };

  let seedArchive;
  try {
    seedArchive = await buildSeedArchive(migrationManifest);
  } catch (error) {
    throw buildHermesSeedError({
      agentId,
      code: "HERMES_SEED_ARCHIVE_BUILD_FAILED",
      message: `could not build its archive: ${error.message}`,
      cause: error,
    });
  }

  if (!seedArchive) {
    throw buildHermesSeedError({
      agentId,
      code: "HERMES_SEED_ARCHIVE_EMPTY",
      message: "produced no archive for its attached workspace files",
    });
  }

  if (
    !provisioner?.docker ||
    typeof provisioner.docker.getContainer !== "function" ||
    typeof containerId !== "string" ||
    containerId.length === 0
  ) {
    throw buildHermesSeedError({
      agentId,
      code: "HERMES_SEED_RUNTIME_UNAVAILABLE",
      message: "could not resolve the created runtime for archive upload",
    });
  }

  let container;
  try {
    await authorize(provisioner);
    container = provisioner.docker.getContainer(containerId);
    if (!container || typeof container.putArchive !== "function") {
      throw new Error("Provisioner did not return a writable Docker container");
    }
    await container.putArchive(seedArchive, { path: "/" });
  } catch (error) {
    throwIfRemoteAuthorizationFailure(error);
    throw buildHermesSeedError({
      agentId,
      code: "HERMES_SEED_ARCHIVE_UPLOAD_FAILED",
      message: `could not upload its archive: ${error.message}`,
      cause: error,
    });
  }

  try {
    await repairOwnership(provisioner, containerId, agentId);
  } catch (error) {
    throwIfRemoteAuthorizationFailure(error);
    throw buildHermesSeedError({
      agentId,
      code: "HERMES_SEED_OWNERSHIP_REPAIR_FAILED",
      message: `could not repair restored workspace ownership: ${error.message}`,
      cause: error,
    });
  }

  // The upload and ownership repair may outlive a Remote Docker grant.
  // Revalidate before accepting restored files so a mid-transfer revocation
  // enters the normal provisioning cleanup path instead of finalizing runtime.
  await authorize(provisioner);
  return { seeded: true, reason: null };
}

function buildHermesPythonCommand(script) {
  const encoded = Buffer.from(String(script || ""), "utf8").toString("base64");
  return [
    "set -eu",
    'HERMES_ROOT="/opt/hermes"',
    'HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python3"; fi',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$(command -v python3 2>/dev/null || true)"; fi',
    '[ -n "$HERMES_PYTHON" ] || exit 127',
    'if [ -d "$HERMES_ROOT" ]; then cd "$HERMES_ROOT"; fi',
    'PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}" exec "$HERMES_PYTHON" - <<\'PY\'',
    "import base64",
    "__nora_globals = {'__name__': '__main__'}",
    `exec(base64.b64decode(${JSON.stringify(encoded)}).decode('utf-8'), __nora_globals)`,
    "PY",
  ].join("\n");
}

function buildHermesModelConfigWriteCommand(modelConfig = {}) {
  const payloadJson = JSON.stringify(modelConfig || {});
  const script = `
import json
import grp
import os
import pwd
from pathlib import Path

from hermes_cli.config import get_config_path, load_config, save_config

def repair_surrogates(value):
    if isinstance(value, str):
        return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    if isinstance(value, list):
        return [repair_surrogates(item) for item in value]
    if isinstance(value, dict):
        return {
            repair_surrogates(key) if isinstance(key, str) else key: repair_surrogates(item)
            for key, item in value.items()
        }
    return value

payload = json.loads(${JSON.stringify(payloadJson)})
config = repair_surrogates(load_config() or {})
current_model = config.get("model")
model = dict(current_model) if isinstance(current_model, dict) else {}

default_model = str(payload.get("defaultModel") or "").strip()
provider = str(payload.get("provider") or "").strip()
base_url = str(payload.get("baseUrl") or "").strip()
api_key_present = "apiKey" in payload or "api_key" in payload
api_key = str(payload.get("apiKey") or payload.get("api_key") or "").strip()

if default_model:
    model["default"] = default_model
else:
    model.pop("default", None)

if provider:
    model["provider"] = provider
else:
    model.pop("provider", None)

if base_url:
    model["base_url"] = base_url
else:
    model.pop("base_url", None)

if api_key_present:
    if api_key:
        model["api_key"] = api_key
    else:
        model.pop("api_key", None)
elif provider and provider != "custom":
    model.pop("api_key", None)

if model:
    config["model"] = model
else:
    config.pop("model", None)

config_path = Path(get_config_path())
save_config(config)
try:
    user = pwd.getpwnam("hermes")
    group = grp.getgrnam("hermes")
    os.chown(config_path, user.pw_uid, group.gr_gid)
except Exception:
    pass
try:
    config_path.chmod(0o600)
except Exception:
    pass

print(json.dumps({"ok": True}))
`;
  return buildHermesPythonCommand(script);
}

function pickProviderConfigApiVersion(config = {}) {
  for (const key of ["api_version", "apiVersion"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// Azure deployment name (arbitrary per resource). Prefer an explicit config
// field; fall back to the provider row's `model` column.
function pickProviderDeployment(config = {}, model = "") {
  for (const key of ["deployment", "deployment_name", "deploymentName"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return typeof model === "string" ? model.trim() : "";
}

async function fetchUserLlmEnvVars(userId, providerId = null) {
  if (!userId || (process.env.KEY_STORAGE || "database") !== "database") {
    return {};
  }

  try {
    const params = [userId];
    const providerFilter = providerId ? " AND id = $2" : "";
    if (providerId) params.push(providerId);
    const keysResult = await db.query(
      `SELECT provider, api_key, model, config
         FROM llm_providers
        WHERE user_id = $1${providerFilter}`,
      params,
    );
    const { decrypt } = require("./crypto");
    const llmEnvVars = {};
    for (const row of keysResult.rows) {
      const envName = PROVIDER_ENV_MAP[row.provider];
      if (!envName || !row.api_key) continue;
      try {
        llmEnvVars[envName] = decrypt(row.api_key);
      } catch (err) {
        console.warn(
          `[provisioner] Skipping LLM key for user ${userId} provider ${row.provider}: ${err.message}`,
        );
        continue;
      }
      // Carry per-user base URL + api-version as sister env vars so containers
      // pick them up on restart via the dynamic auth script.
      const cfg = normalizeProviderConfig(row.config);
      const baseUrl = pickProviderBaseUrl(cfg);
      const apiVersion = pickProviderConfigApiVersion(cfg);
      const baseUrlEnv = envName.replace(/_API_KEY$|_TOKEN$/, "_BASE_URL");
      const apiVersionEnv = envName.replace(/_API_KEY$|_TOKEN$/, "_API_VERSION");
      if (baseUrl && baseUrlEnv !== envName) llmEnvVars[baseUrlEnv] = baseUrl;
      if (apiVersion && apiVersionEnv !== envName) llmEnvVars[apiVersionEnv] = apiVersion;
      // Foundry deployment names are arbitrary per Azure resource — carry the
      // saved deployment so the runtime targets the right one (not a hardcoded
      // "gpt-5.5"). See buildFoundryModelEntries / foundryDefaultModel.
      if (row.provider === "microsoft-foundry") {
        const deployment = pickProviderDeployment(cfg, row.model);
        if (deployment) llmEnvVars.MICROSOFT_FOUNDRY_DEPLOYMENT = deployment;
      }
    }
    return normalizeEnvValueMap(llmEnvVars);
  } catch (error) {
    console.warn(`[provisioner] Failed to fetch LLM keys for user ${userId}:`, error.message);
    return {};
  }
}

async function fetchDeploymentProvider(userId, providerId = null) {
  if (!userId || (process.env.KEY_STORAGE || "database") !== "database") {
    if (providerId) {
      throw new Error("Explicit deployment LLM providers require KEY_STORAGE=database");
    }
    return null;
  }

  try {
    return await getDeploymentProvider(userId, providerId, db);
  } catch (error) {
    if (providerId) {
      console.warn(
        `[provisioner] Failed to fetch explicit LLM provider ${providerId} for user ${userId}:`,
        error.message,
      );
      throw error;
    }
    console.warn(
      `[provisioner] Failed to fetch default LLM provider for user ${userId}:`,
      error.message,
    );
    return null;
  }
}

async function fetchEffectiveProviderState(
  userId,
  providerId = null,
  agentId = null,
  { runtimeFamily = "openclaw" } = {},
) {
  const [providerEnvVars, defaultProvider, integrationEnvVars, mcpRuntimeState, integrationSync] =
    await Promise.all([
      fetchUserLlmEnvVars(userId, providerId),
      fetchDeploymentProvider(userId, providerId),
      agentId ? getIntegrationEnvVars(agentId) : Promise.resolve({}),
      agentId && String(runtimeFamily).toLowerCase() === "openclaw"
        ? mcpServers.getEnabledMcpRuntimeState(agentId)
        : Promise.resolve({ enabledIds: [], entries: [], env: {}, managedEnvNames: [] }),
      agentId ? getIntegrationsForSync(agentId) : Promise.resolve([]),
    ]);
  const integrationLlmEnvVars = Object.fromEntries(
    Object.entries(integrationEnvVars || {}).filter(([name]) => PROVIDER_ENV_NAMES.has(name)),
  );
  // Explicit llm_provider rows remain authoritative when an integration emits
  // the same env name. Integration-backed LLM auth still participates in the
  // fingerprint so connect/remove cannot race deployment finalization.
  const envVars = normalizeEnvValueMap({ ...integrationLlmEnvVars, ...providerEnvVars });
  const mcpEntries = Array.isArray(mcpRuntimeState?.entries) ? mcpRuntimeState.entries : [];
  const mcpEnvVars = buildMcpManagedEnv(mcpEntries);
  const mcpServersConfig = buildMcpServersConfig(mcpEntries);
  const credentialEnvVars = normalizeEnvValueMap({
    ...(integrationEnvVars || {}),
    ...mcpEnvVars,
    ...envVars,
  });
  const managedCredentialEnvNames = buildCredentialManagedEnvNames({
    runtimeFamily,
    integrationEnvNames: Object.keys(integrationEnvVars || {}),
    mcpEnabledIds: mcpRuntimeState?.enabledIds || [],
  });
  const normalizedIntegrationSync = (Array.isArray(integrationSync) ? integrationSync : [])
    .slice()
    .sort((left, right) => {
      const providerOrder = String(left?.provider || "").localeCompare(
        String(right?.provider || ""),
      );
      if (providerOrder !== 0) return providerOrder;
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    });
  return {
    envVars,
    integrationEnvVars: normalizeEnvValueMap(integrationEnvVars || {}),
    mcpEnvVars,
    mcpServers: mcpServersConfig,
    mcpEnabledIds: mcpRuntimeState?.enabledIds || [],
    integrationSync: normalizedIntegrationSync,
    credentialEnvVars,
    managedCredentialEnvNames,
    defaultProvider,
    fingerprint: fingerprintEffectiveProviderState({
      envVars: credentialEnvVars,
      defaultProvider,
      mcpServers: mcpServersConfig,
      integrations: normalizedIntegrationSync,
    }),
  };
}

function buildKubernetesProviderEnv(runtimeFamily, defaultProvider, llmEnvVars = {}) {
  if (runtimeFamily === "hermes") {
    return {
      ...buildHermesRuntimeBootstrapEnvFor(defaultProvider, llmEnvVars),
      ...llmEnvVars,
    };
  }

  const defaultModel = buildDefaultOpenClawModel(defaultProvider);
  return {
    ...llmEnvVars,
    ...(defaultModel ? { NORA_DEFAULT_OPENCLAW_MODEL: defaultModel } : {}),
  };
}

async function fetchWithProvisionerAuthorization(
  provisioner,
  resource,
  init = {},
  { authorizationRecheckMs = REMOTE_EXEC_AUTH_RECHECK_MS } = {},
) {
  const authorize = provisioner?.[REMOTE_PROVISIONER_AUTHORIZATION];
  if (typeof authorize !== "function") {
    const response = await fetch(resource, init);
    if (!response?.ok) {
      throw new Error(`Runtime request failed with HTTP ${response?.status ?? "unknown"}`);
    }
    return response;
  }

  await authorize();

  const controller = new AbortController();
  const callerSignal = init?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  let authorizationError = null;
  let authorizationInFlight = null;
  let requestSettled = false;
  const recheckMs = Math.max(1, Number(authorizationRecheckMs) || REMOTE_EXEC_AUTH_RECHECK_MS);
  const checkAuthorization = () => {
    if (requestSettled || authorizationInFlight) return authorizationInFlight;
    authorizationInFlight = Promise.resolve()
      .then(() => authorize())
      .catch((error) => {
        authorizationError = error;
        if (!requestSettled) controller.abort(error);
      })
      .finally(() => {
        authorizationInFlight = null;
      });
    return authorizationInFlight;
  };
  const authorizationInterval = setInterval(() => {
    void checkAuthorization();
  }, recheckMs);
  authorizationInterval.unref?.();

  try {
    const response = await fetch(resource, {
      ...init,
      signal: controller.signal,
    });
    requestSettled = true;
    clearInterval(authorizationInterval);
    const pendingAuthorization = authorizationInFlight;
    if (pendingAuthorization) await pendingAuthorization;
    if (authorizationError) throw authorizationError;

    // A response can race the periodic check. Revalidate once more before the
    // caller accepts the runtime mutation as successful.
    await authorize();
    if (!response?.ok) {
      throw new Error(`Runtime request failed with HTTP ${response?.status ?? "unknown"}`);
    }
    return response;
  } catch (error) {
    if (authorizationError) throw authorizationError;
    throw error;
  } finally {
    requestSettled = true;
    clearInterval(authorizationInterval);
    if (callerSignal && !callerSignal.aborted) {
      callerSignal.removeEventListener("abort", abortFromCaller);
    }
  }
}

async function runRuntimeCommand(
  agent,
  command,
  {
    timeout = 30000,
    beforeAttempt = null,
    authorizationRecheckMs = REMOTE_EXEC_AUTH_RECHECK_MS,
  } = {},
) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("Agent runtime endpoint unavailable");
  }

  if (typeof beforeAttempt === "function") {
    await beforeAttempt();
  }

  const controller = new AbortController();
  let authorizationError = null;
  let authorizationInFlight = null;
  let settled = false;
  const checkAuthorization = () => {
    if (settled || authorizationInFlight || authorizationError) {
      return authorizationInFlight;
    }
    authorizationInFlight = Promise.resolve()
      .then(() => beforeAttempt())
      .catch((error) => {
        authorizationError = error;
        if (!settled) controller.abort(error);
      })
      .finally(() => {
        authorizationInFlight = null;
      });
    return authorizationInFlight;
  };
  const authorizationInterval =
    typeof beforeAttempt === "function"
      ? setInterval(
          () => {
            void checkAuthorization();
          },
          Math.max(1, Number(authorizationRecheckMs) || REMOTE_EXEC_AUTH_RECHECK_MS),
        )
      : null;

  // gateway_token is encrypted at rest; decrypt() is transparent to legacy
  // plaintext, so it is safe whether the agent row was freshly selected
  // (encrypted) or carries an in-memory plaintext token.
  try {
    const response = await fetch(runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildRuntimeAuthHeaders(
          agent && agent.gateway_token ? decryptProvisionerSecret(agent.gateway_token) : null,
        ),
      },
      body: JSON.stringify({
        command,
        timeout,
      }),
      signal: controller.signal,
    });

    let payload;
    try {
      payload = await response.json();
    } catch (cause) {
      const error = new Error("Runtime command returned malformed JSON");
      error.code = "RUNTIME_COMMAND_RESPONSE_INVALID";
      error.cause = cause;
      throw error;
    }

    // Stop new checks, wait for one that raced the response, and require one
    // final positive authorization result before accepting the mutation.
    settled = true;
    if (authorizationInterval) clearInterval(authorizationInterval);
    const pendingAuthorization = authorizationInFlight;
    if (pendingAuthorization) await pendingAuthorization;
    if (authorizationError) throw authorizationError;
    if (typeof beforeAttempt === "function") await beforeAttempt();

    if (!response.ok) {
      throw new Error(
        (payload && typeof payload === "object" && !Array.isArray(payload) && payload.error) ||
          `Runtime command failed with HTTP ${response.status}`,
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const error = new Error("Runtime command returned an invalid response body");
      error.code = "RUNTIME_COMMAND_RESPONSE_INVALID";
      throw error;
    }
    if (!Number.isInteger(payload.exitCode)) {
      const error = new Error("Runtime command did not confirm an integer exit code");
      error.code = "RUNTIME_COMMAND_EXIT_UNCONFIRMED";
      throw error;
    }
    if (payload.exitCode !== 0) {
      const error = new Error(
        payload.stderr || payload.stdout || `Runtime command exited with code ${payload.exitCode}`,
      );
      error.code = "RUNTIME_COMMAND_FAILED";
      error.exitCode = payload.exitCode;
      throw error;
    }

    return payload;
  } catch (error) {
    if (authorizationError) throw authorizationError;
    throw error;
  } finally {
    settled = true;
    if (authorizationInterval) clearInterval(authorizationInterval);
  }
}

function appendChunkTail(chunks, chunk, state, maxBytes) {
  if (!chunk || maxBytes <= 0) return;

  const normalizedChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (normalizedChunk.length >= maxBytes) {
    chunks.length = 0;
    chunks.push(normalizedChunk.subarray(normalizedChunk.length - maxBytes));
    state.totalBytes = maxBytes;
    return;
  }

  chunks.push(normalizedChunk);
  state.totalBytes += normalizedChunk.length;

  while (state.totalBytes > maxBytes && chunks.length > 0) {
    const overflow = state.totalBytes - maxBytes;
    const firstChunk = chunks[0];
    if (firstChunk.length <= overflow) {
      chunks.shift();
      state.totalBytes -= firstChunk.length;
      continue;
    }
    chunks[0] = firstChunk.subarray(overflow);
    state.totalBytes -= overflow;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g");
// eslint-disable-next-line no-control-regex
const NON_PRINTABLE_RE = new RegExp("[^\\x09\\x0a\\x20-\\x7e]", "g");

function sanitizeExecOutput(output = "") {
  return String(output)
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r/g, "\n")
    .replace(NON_PRINTABLE_RE, "")
    .trim();
}

function provisionerExecStateDir(commandId) {
  if (!/^[a-f0-9]{32}$/.test(String(commandId || ""))) {
    throw new Error("Invalid provisioner exec command identity");
  }
  return `/tmp/.nora-worker-exec-${commandId}`;
}

function buildTrackedProvisionerCommand(command, commandId) {
  const stateDir = provisionerExecStateDir(commandId);
  const trackedRunner = [
    "set +e",
    "umask 077",
    "state_dir=$1",
    "command_id=$2",
    "command=$3",
    "command_pgid=$$",
    'command_identity="$(awk \'{print $5 " " $22}\' "/proc/$$/stat" 2>/dev/null || true)"',
    "set -- $command_identity",
    '[ "$#" -eq 2 ] || { rm -rf "$state_dir"; exit 125; }',
    "command_group=$1",
    "command_start=$2",
    'case "$command_group" in ""|*[!0-9]*) rm -rf "$state_dir"; exit 125 ;; esac',
    'case "$command_start" in ""|*[!0-9]*) rm -rf "$state_dir"; exit 125 ;; esac',
    '[ "$command_group" = "$command_pgid" ] || { rm -rf "$state_dir"; exit 125; }',
    'pid_tmp="$state_dir/pid.tmp.$$"',
    'if ! printf "nora-exec-v1 %s %s %s\\n" "$command_id" "$command_pgid" "$command_start" > "$pid_tmp" || ! mv -f "$pid_tmp" "$state_dir/pid"; then rm -f "$pid_tmp"; rm -rf "$state_dir"; exit 125; fi',
    'exec /bin/sh -lc "$command"',
  ].join("; ");
  return [
    "set +e",
    "umask 077",
    `command_id=${shellSingleQuote(commandId)}`,
    `state_dir=${shellSingleQuote(stateDir)}`,
    'mkdir -m 700 "$state_dir" || exit 125',
    'setsid_path="$(command -v setsid 2>/dev/null || true)"',
    '[ -n "$setsid_path" ] || { rm -rf "$state_dir"; echo "setsid is required for tracked runtime commands" >&2; exit 125; }',
    `"$setsid_path" /bin/sh -c ${shellSingleQuote(trackedRunner)} nora-tracked-command "$state_dir" ${shellSingleQuote(commandId)} ${shellSingleQuote(command)} &`,
    "command_pgid=$!",
    'case "$command_pgid" in ""|*[!0-9]*) rm -rf "$state_dir"; exit 125 ;; esac',
    'pid_file="$state_dir/pid"',
    "attempt=0",
    'while [ ! -s "$pid_file" ] && kill -0 "$command_pgid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    '[ -f "$pid_file" ] && [ ! -L "$pid_file" ] && [ -r "$pid_file" ] || { wait "$command_pgid" 2>/dev/null || true; rm -rf "$state_dir"; exit 125; }',
    'pid_state="$(cat "$pid_file" 2>/dev/null)" || { wait "$command_pgid" 2>/dev/null || true; rm -rf "$state_dir"; exit 125; }',
    "old_ifs=$IFS",
    "IFS=' '",
    "set -f",
    "set -- $pid_state",
    "set +f",
    "IFS=$old_ifs",
    '[ "$#" -eq 4 ] && [ "$1" = "nora-exec-v1" ] && [ "$2" = "$command_id" ] && [ "$3" = "$command_pgid" ] || { wait "$command_pgid" 2>/dev/null || true; rm -rf "$state_dir"; exit 125; }',
    "expected_start=$4",
    'case "$expected_start" in ""|*[!0-9]*) wait "$command_pgid" 2>/dev/null || true; rm -rf "$state_dir"; exit 125 ;; esac',
    'verify_group_identity() { if [ -r "/proc/$command_pgid/stat" ]; then current_identity="$(awk \'{print $5 " " $22}\' "/proc/$command_pgid/stat" 2>/dev/null || true)"; set -- $current_identity; [ "$#" -eq 2 ] && [ "$1" = "$command_pgid" ] && [ "$2" = "$expected_start" ] || return 76; elif [ -e "/proc/$command_pgid" ]; then return 76; fi; return 0; }',
    'terminate_group() { verify_group_identity || return 76; if ! kill -TERM "-$command_pgid" 2>/dev/null && kill -0 "-$command_pgid" 2>/dev/null; then return 73; fi; sleep 0.2; if kill -0 "-$command_pgid" 2>/dev/null; then verify_group_identity || return 76; if ! kill -KILL "-$command_pgid" 2>/dev/null && kill -0 "-$command_pgid" 2>/dev/null; then return 74; fi; fi; attempt=0; while kill -0 "-$command_pgid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done; kill -0 "-$command_pgid" 2>/dev/null && return 75; return 0; }',
    `record_termination_failure() { termination_tmp="$state_dir/termination.tmp.$$"; if ! printf '${PROVISIONER_EXEC_TERMINATION_STATE_VERSION} %s %s %s\\n' "$command_id" "$command_status" "$termination_status" > "$termination_tmp" || ! mv -f "$termination_tmp" "$state_dir/termination"; then rm -f "$termination_tmp"; fi; printf '\\n${PROVISIONER_EXEC_TERMINATION_FAILURE_MARKER}:%s:%s:%s\\n' "$command_id" "$command_status" "$termination_status" >&2; }`,
    'wait "$command_pgid"',
    "command_status=$?",
    'if kill -0 "-$command_pgid" 2>/dev/null; then terminate_group; termination_status=$?; if [ "$termination_status" -ne 0 ]; then record_termination_failure; exit "$termination_status"; fi; fi',
    'rm -rf "$state_dir"',
    'exit "$command_status"',
  ].join("\n");
}

function buildProvisionerExecCleanupCommand(commandId) {
  const stateDir = provisionerExecStateDir(commandId);
  return [
    "set +e",
    `command_id=${shellSingleQuote(commandId)}`,
    `state_dir=${shellSingleQuote(stateDir)}`,
    'pid_file="$state_dir/pid"',
    "attempt=0",
    'while [ ! -s "$pid_file" ] && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    '[ -f "$pid_file" ] && [ ! -L "$pid_file" ] && [ -r "$pid_file" ] || { echo "tracked command pid state unavailable" >&2; exit 70; }',
    'pid_size="$(wc -c < "$pid_file" 2>/dev/null || true)"',
    'case "$pid_size" in ""|*[!0-9]*) echo "tracked command pid state unreadable" >&2; exit 71 ;; esac',
    '[ "$pid_size" -le 160 ] || { echo "tracked command pid state malformed" >&2; exit 71; }',
    'pid_state="$(cat "$pid_file" 2>/dev/null)" || { echo "tracked command pid state unreadable" >&2; exit 71; }',
    "old_ifs=$IFS",
    "IFS=' '",
    "set -f",
    "set -- $pid_state",
    "set +f",
    "IFS=$old_ifs",
    '[ "$#" -eq 4 ] || { echo "tracked command pid state malformed" >&2; exit 71; }',
    '[ "$1" = "nora-exec-v1" ] && [ "$2" = "$command_id" ] || { echo "tracked command pid state identity mismatch" >&2; exit 72; }',
    "command_pgid=$3",
    "expected_start=$4",
    '[ "$pid_state" = "nora-exec-v1 $command_id $command_pgid $expected_start" ] || { echo "tracked command pid state malformed" >&2; exit 71; }',
    'case "$command_pgid" in ""|*[!0-9]*) echo "tracked command pgid malformed" >&2; exit 71 ;; esac',
    'case "$expected_start" in ""|*[!0-9]*) echo "tracked command start time malformed" >&2; exit 71 ;; esac',
    '[ "$command_pgid" -gt 1 ] || { echo "tracked command pgid unsafe" >&2; exit 71; }',
    'if [ -r "/proc/$command_pgid/stat" ]; then current_identity="$(awk \'{print $5 " " $22}\' "/proc/$command_pgid/stat" 2>/dev/null || true)"; set -- $current_identity; [ "$#" -eq 2 ] && [ "$1" = "$command_pgid" ] && [ "$2" = "$expected_start" ] || { echo "tracked command process group identity mismatch" >&2; exit 72; }; elif [ -e "/proc/$command_pgid" ]; then echo "tracked command process group identity unavailable" >&2; exit 72; fi',
    'if kill -0 "-$command_pgid" 2>/dev/null && ! kill -TERM "-$command_pgid" 2>/dev/null && kill -0 "-$command_pgid" 2>/dev/null; then echo "tracked command process group rejected SIGTERM" >&2; exit 73; fi',
    "sleep 1",
    'if kill -0 "-$command_pgid" 2>/dev/null; then if [ -r "/proc/$command_pgid/stat" ]; then delayed_identity="$(awk \'{print $5 " " $22}\' "/proc/$command_pgid/stat" 2>/dev/null || true)"; set -- $delayed_identity; [ "$#" -eq 2 ] && [ "$1" = "$command_pgid" ] && [ "$2" = "$expected_start" ] || { echo "tracked command process group identity changed before SIGKILL" >&2; exit 76; }; elif [ -e "/proc/$command_pgid" ]; then echo "tracked command process group identity unavailable before SIGKILL" >&2; exit 76; fi; if ! kill -KILL "-$command_pgid" 2>/dev/null && kill -0 "-$command_pgid" 2>/dev/null; then echo "tracked command process group rejected SIGKILL" >&2; exit 74; fi; fi',
    "attempt=0",
    'while kill -0 "-$command_pgid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    'if kill -0 "-$command_pgid" 2>/dev/null; then echo "tracked command process group survived SIGKILL" >&2; exit 75; fi',
    'rm -rf "$state_dir"',
    `printf '%s\\n' ${shellSingleQuote(`NORA_EXEC_CLEANUP_OK:${commandId}`)}`,
    "exit 0",
  ].join("\n");
}

async function waitForProvisionerCleanupExec(execResult, expectedMarker) {
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error("Provisioner command cleanup exec unavailable");
  }
  const output = [];
  const capture = (chunk) => {
    if (!chunk) return;
    output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  };
  const stream = execResult.stream;
  stream.on("data", capture);
  if (typeof stream.read === "function") {
    let buffered;
    while ((buffered = stream.read()) !== null) capture(buffered);
  }

  const streamEnded = () => Boolean(stream.readableEnded || stream.closed || stream.destroyed);
  if (!streamEnded()) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanupListeners = () => {
        stream.removeListener("end", finish);
        stream.removeListener("close", finish);
        stream.removeListener("error", onError);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        try {
          stream.destroy();
        } catch {
          // Best-effort cleanup stream teardown.
        }
        reject(new Error("Provisioner command cleanup timed out"));
      }, PROVISIONER_EXEC_CLEANUP_TIMEOUT_MS);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        resolve();
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        reject(error);
      };
      stream.once("end", finish);
      stream.once("close", finish);
      stream.once("error", onError);
      if (streamEnded()) finish();
      else stream.resume?.();
    });
  }

  if (typeof stream.read === "function") {
    let buffered;
    while ((buffered = stream.read()) !== null) capture(buffered);
  }

  const status = await execResult.exec.inspect();
  if (!status || status.Running === true || status.ExitCode !== 0) {
    throw new Error(
      `Provisioner command cleanup exited without confirmation (exit ${status?.ExitCode ?? "unknown"})`,
    );
  }
  if (!Buffer.concat(output).toString("utf8").includes(expectedMarker)) {
    throw new Error("Provisioner command cleanup confirmation marker was missing");
  }
}

async function startFixedProvisionerExecCleanup(provisioner, containerId, commandId, agentId) {
  const cleanupCommand = buildProvisionerExecCleanupCommand(commandId);
  return provisioner.exec(containerId, {
    cmd: ["/bin/sh", "-c", cleanupCommand],
    tty: false,
    env: [],
    ...(agentId ? { agentId } : {}),
  });
}

async function terminateTrackedProvisionerCommand(provisioner, containerId, commandId, agentId) {
  const cleanupExec = provisioner?.[REMOTE_PROVISIONER_CLEANUP_EXEC];
  const execResult =
    typeof cleanupExec === "function"
      ? await cleanupExec(containerId, commandId, agentId)
      : await startFixedProvisionerExecCleanup(provisioner, containerId, commandId, agentId);
  await waitForProvisionerCleanupExec(execResult, `NORA_EXEC_CLEANUP_OK:${commandId}`);
}

function buildProvisionerExecTerminationUnconfirmedError(originalError, cleanupError) {
  const error = new Error("Provisioner command termination could not be confirmed", {
    cause: originalError,
  });
  error.code = "PROVISIONER_EXEC_TERMINATION_UNCONFIRMED";
  error.cleanupError = cleanupError;
  return error;
}

function extractTrackedProvisionerTerminationFailure(output, protocolOutput, commandId) {
  const markerPrefix = `${PROVISIONER_EXEC_TERMINATION_FAILURE_MARKER}:${commandId}:`;
  const protocolLines = String(protocolOutput || "")
    .split("\n")
    .map((line) => line.trim());
  let failure = null;

  for (const line of protocolLines) {
    if (!line.startsWith(markerPrefix)) continue;
    const fields = line.slice(markerPrefix.length).split(":");
    if (fields.length !== 2) continue;
    const commandStatus = Number(fields[0]);
    const terminationStatus = Number(fields[1]);
    if (
      Number.isInteger(commandStatus) &&
      commandStatus >= 0 &&
      commandStatus <= 255 &&
      Number.isInteger(terminationStatus) &&
      terminationStatus >= 73 &&
      terminationStatus <= 76
    ) {
      failure = { commandStatus, terminationStatus, marker: line };
    }
  }

  if (!failure) return null;
  const cleanOutput = String(output || "")
    .split("\n")
    .filter((line) => line.trim() !== failure.marker)
    .join("\n")
    .trim();
  return { ...failure, output: cleanOutput };
}

function buildProvisionerCommandExitError(exitCode, output = "", timeout = null) {
  if (exitCode === 124) {
    return new Error(
      timeout == null
        ? "Container command timed out inside the runtime"
        : `Container command timed out after ${timeout}ms`,
    );
  }
  return new Error(String(output || "").trim() || `Container command exited with code ${exitCode}`);
}

/**
 * Execute a shell command inside an already-running runtime container.
 *
 * This is the lowest-level provisioner exec helper used by ClawHub flows and
 * other runtime repair paths. Callers must shell-escape any interpolated
 * user-controlled values because `command` is executed via `/bin/sh -c ...`,
 * not as a direct argv array.
 *
 * @param {object} provisioner Backend-specific provisioner client with `exec`.
 * @param {string} containerId Runtime container identifier.
 * @param {string} command Shell command to execute inside the container.
 * @param {object} [options]
 * @param {number} [options.timeout=30000] Max time to wait before aborting.
 * @param {number} [options.maxOutputBytes=65536] Max output bytes to retain.
 * @param {boolean} [options.tty=false] Whether to allocate a TTY for exec.
 * @param {string[]} [options.env=[]] Extra env vars for the exec call.
 * @param {string|null} [options.agentId=null] Agent id used for authorization
 * and cleanup tracking.
 * @returns {Promise<{exitCode: number, output: string}>} Sanitized output and
 * the final container exit code. Rejects on timeout, exec transport failures,
 * or non-zero exit status.
 */
async function runProvisionerExecCommand(
  provisioner,
  containerId,
  command,
  { timeout = 30000, maxOutputBytes = 65536, tty = false, env = [], agentId = null } = {},
) {
  const commandId = randomBytes(16).toString("hex");
  const trackedCommand = buildTrackedProvisionerCommand(command, commandId);
  const execResult = await provisioner.exec(containerId, {
    cmd: ["/bin/sh", "-c", trackedCommand],
    tty,
    env,
    ...(agentId ? { agentId } : {}),
  });
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error("Container exec unavailable");
  }

  const { output, protocolOutput } = await new Promise((resolve, reject) => {
    const chunks = [];
    const state = { totalBytes: 0 };
    const protocolChunks = [];
    const protocolState = { totalBytes: 0 };
    let settled = false;
    let inspectInterval = null;
    let inspectInFlight = false;
    let streamBoundaryCheckPromise = null;
    let lastAuthorizationCheckAt = Date.now();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inspectInterval) clearInterval(inspectInterval);
      try {
        execResult.stream.destroy();
      } catch {
        // Ignore stream teardown failures.
      }
      Promise.resolve(
        terminateTrackedProvisionerCommand(provisioner, containerId, commandId, agentId),
      )
        .then(() => reject(error))
        .catch((cleanupError) => {
          console.warn(
            `[provisioner] Failed to terminate tracked command ${commandId} in ${containerId}: ${cleanupError.message}`,
          );
          reject(buildProvisionerExecTerminationUnconfirmedError(error, cleanupError));
        });
    };

    const timer = setTimeout(() => {
      fail(new Error(`Container command timed out after ${timeout}ms`));
    }, timeout);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inspectInterval) clearInterval(inspectInterval);
      resolve({
        output: sanitizeExecOutput(Buffer.concat(chunks).toString("utf8")),
        protocolOutput: sanitizeExecOutput(Buffer.concat(protocolChunks).toString("utf8")),
      });
    };

    const finishFromStreamBoundary = () => {
      if (settled || streamBoundaryCheckPromise) return;
      streamBoundaryCheckPromise = (async () => {
        try {
          // An attached Docker/SSH stream can end because the transport was
          // lost while the exec is still running. Treat the stream only as the
          // output-drain boundary; require Docker to confirm process exit
          // before accepting the command as complete.
          await assertProvisionerAuthorized(provisioner);
          const status = await execResult.exec.inspect();
          if (!status || status.Running !== false || status.ExitCode == null) {
            const error = new Error(
              "Provisioner command stream ended before tracked command exit was confirmed",
            );
            error.code = "PROVISIONER_EXEC_EXIT_UNCONFIRMED";
            fail(error);
            return;
          }
          finish();
        } catch (error) {
          fail(error);
        } finally {
          streamBoundaryCheckPromise = null;
        }
      })();
    };

    execResult.stream.on("data", (chunk) => {
      appendChunkTail(chunks, chunk, state, maxOutputBytes);
      appendChunkTail(protocolChunks, chunk, protocolState, 1024);
    });
    execResult.stream.on("end", finishFromStreamBoundary);
    execResult.stream.on("close", finishFromStreamBoundary);
    execResult.stream.on("error", (error) => {
      fail(error);
    });

    inspectInterval = setInterval(async () => {
      if (settled || inspectInFlight) return;
      inspectInFlight = true;
      try {
        if (Date.now() - lastAuthorizationCheckAt >= REMOTE_EXEC_AUTH_RECHECK_MS) {
          await assertProvisionerAuthorized(provisioner);
          lastAuthorizationCheckAt = Date.now();
        }
        // Keep the stream as the completion boundary. Docker can report the
        // exec as stopped before its final supervisor marker has drained; an
        // inspect-driven finish would lose the wrapper's termination evidence.
        await execResult.exec.inspect();
      } catch (error) {
        fail(error);
      } finally {
        inspectInFlight = false;
      }
    }, 500);
  });

  const terminationFailure = extractTrackedProvisionerTerminationFailure(
    output,
    protocolOutput,
    commandId,
  );
  if (terminationFailure) {
    const originalError =
      terminationFailure.commandStatus === 0
        ? new Error(
            `Tracked command wrapper could not confirm process-group termination (exit ${terminationFailure.terminationStatus})`,
          )
        : buildProvisionerCommandExitError(
            terminationFailure.commandStatus,
            terminationFailure.output,
            timeout,
          );
    originalError.exitCode = terminationFailure.commandStatus;
    originalError.terminationExitCode = terminationFailure.terminationStatus;
    try {
      await terminateTrackedProvisionerCommand(provisioner, containerId, commandId, agentId);
    } catch (cleanupError) {
      throw buildProvisionerExecTerminationUnconfirmedError(originalError, cleanupError);
    }

    await assertProvisionerAuthorized(provisioner);
    if (terminationFailure.commandStatus !== 0) throw originalError;
    return { exitCode: 0, output: terminationFailure.output };
  }

  // The exec handle talks to the remote Docker daemon too. Re-check after a
  // long command before inspecting its exit status so a mid-command revocation
  // cannot be followed by another credentialed Docker request.
  await assertProvisionerAuthorized(provisioner);
  const inspectResult = await execResult.exec.inspect();
  if (!inspectResult || inspectResult.Running !== false || inspectResult.ExitCode == null) {
    const originalError = new Error(
      "Provisioner command exit could not be confirmed after its output stream ended",
    );
    originalError.code = "PROVISIONER_EXEC_EXIT_UNCONFIRMED";
    try {
      await terminateTrackedProvisionerCommand(provisioner, containerId, commandId, agentId);
    } catch (cleanupError) {
      throw buildProvisionerExecTerminationUnconfirmedError(originalError, cleanupError);
    }
    throw originalError;
  }
  const exitCode = inspectResult?.ExitCode ?? 0;
  if (exitCode !== 0) throw buildProvisionerCommandExitError(exitCode, output, timeout);

  return { exitCode, output };
}

function wrapCommandWithContainerTimeout(command, timeoutMs) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    "if command -v timeout >/dev/null 2>&1; then",
    `  exec timeout -k 5s ${timeoutSeconds}s /bin/sh -lc ${JSON.stringify(command)};`,
    "fi;",
    `exec /bin/sh -lc ${JSON.stringify(command)};`,
  ].join(" ");
}

/**
 * Push the user's current LLM auth and default-model settings into a running
 * runtime, then restart and wait for readiness.
 *
 * Hermes and OpenClaw update this config in different ways. This function
 * handles those runtime-specific steps internally so callers only need to care
 * about one outcome: if it returns `synced`, the new auth/config has been
 * applied, the runtime has restarted, and health checks passed.
 *
 * @param {object} params Reconciliation inputs for the live runtime.
 * @param {string} params.agentId Agent id used for persisted Hermes lookups.
 * @param {string} params.userId User id whose provider credentials are read.
 * @param {string} params.llmProviderId Explicit provider selected when this deployment was queued.
 * @param {string} params.runtimeFamily Runtime family, e.g. `hermes` or `openclaw`.
 * @param {string} params.resolvedBackend Normalized backend name for exec fallback behavior.
 * @param {string} params.containerId Runtime container identifier.
 * @param {object} params.provisioner Backend-specific provisioner client with `exec` and `restart`.
 * @param {string} params.host Agent host used for readiness checks.
 * @param {string} params.runtimeHost Runtime host used for readiness checks.
 * @param {number|string} params.runtimePort Runtime port used for readiness checks.
 * @param {number|string} params.gatewayHostPort Gateway port exposed on the host.
 * @param {string} params.gatewayHost Gateway host used for readiness checks.
 * @param {number|string} params.gatewayPort Gateway port used for readiness checks.
 * @param {string} params.gatewayToken Gateway auth token used to authorize runtime commands.
 * @param {string} params.bootstrappedProviderFingerprint Canonical effective provider state injected before runtime creation.
 * @param {string[]} [params.preservedEnvNames=[]] Managed env var names to exclude from
 * this write so they are not overwritten or reported as caller-managed.
 * @returns {Promise<{status: "skipped" | "synced", reason?: string}>} `skipped` when there is
 * nothing to apply, otherwise `synced` after config write, restart, and
 * readiness verification succeed.
 */
async function reconcileRuntimeLlmAuth({
  agentId,
  userId,
  llmProviderId,
  runtimeFamily,
  resolvedBackend,
  containerId,
  provisioner,
  host,
  runtimeHost,
  runtimePort,
  gatewayHostPort,
  gatewayHost,
  gatewayPort,
  gatewayToken,
  bootstrappedProviderFingerprint,
  preservedEnvNames = [],
} = {}) {
  const providerState = await fetchEffectiveProviderState(userId, llmProviderId, agentId, {
    runtimeFamily,
  });
  const {
    envVars: llmEnvVars,
    integrationEnvVars,
    mcpEnvVars,
    mcpServers: desiredMcpServers,
    integrationSync,
    managedCredentialEnvNames,
    defaultProvider,
    fingerprint: providerFingerprint,
  } = providerState;
  const providerStateChanged = shouldReconcileEffectiveProviderState(
    bootstrappedProviderFingerprint,
    providerState,
  );
  if (!providerStateChanged && resolvedBackend !== "proxmox") {
    return { status: "skipped", reason: "unchanged", providerFingerprint };
  }
  const hasLlmKeys = Object.keys(llmEnvVars).length > 0;
  if (!hasLlmKeys && !defaultProvider) {
    const error = new Error(
      "LLM provider state was removed while the runtime was provisioning; retrying from a clean bootstrap",
    );
    error.code = "PROVIDER_STATE_REMOVED_DURING_DEPLOYMENT";
    throw error;
  }

  if (providerStateChanged || resolvedBackend === "proxmox") {
    if (typeof provisioner?.updateEnv !== "function") {
      throw new Error(`${resolvedBackend} provider reconciliation requires updateEnv support`);
    }
    const preserved = new Set((preservedEnvNames || []).map((name) => String(name || "")));
    const credentialManagedEnvNames = managedCredentialEnvNames.filter(
      (name) => !preserved.has(name),
    );
    const managedEnv = Object.fromEntries(
      Object.entries({
        ...(integrationEnvVars || {}),
        ...(mcpEnvVars || {}),
        ...buildKubernetesProviderEnv(runtimeFamily, defaultProvider, llmEnvVars),
        ...(String(runtimeFamily).toLowerCase() === "openclaw"
          ? {
              [OPENCLAW_MANAGED_MCP_SERVERS_ENV]:
                encodeOpenClawManagedMcpServers(desiredMcpServers),
            }
          : {}),
      }).filter(([name]) => !preserved.has(name)),
    );
    await provisioner.updateEnv(containerId, managedEnv, {
      agentId,
      runtimeFamily,
      managedEnvNames: credentialManagedEnvNames,
      replaceManagedState: true,
    });
  }

  const agentRef = {
    backend_type: resolvedBackend,
    host,
    runtime_host: runtimeHost,
    runtime_port: runtimePort,
    gateway_host_port: gatewayHostPort,
    gateway_host: gatewayHost,
    gateway_port: gatewayPort,
    gateway_token: gatewayToken,
  };
  const authorizeRuntimeUse = () => assertProvisionerAuthorized(provisioner);

  if (runtimeFamily === "hermes") {
    let persistedModelConfig = null;
    if (agentId) {
      try {
        const persistedState = await getPersistedHermesState(agentId);
        if (hasMeaningfulHermesModelConfig(persistedState?.modelConfig)) {
          persistedModelConfig = persistedState.modelConfig;
        }
      } catch {
        persistedModelConfig = null;
      }
    }

    const modelConfig = persistedModelConfig
      ? attachHermesCustomApiKey(persistedModelConfig, defaultProvider, llmEnvVars)
      : buildHermesModelConfig(defaultProvider, llmEnvVars);
    if (modelConfig) {
      await runProvisionerExecCommand(
        provisioner,
        containerId,
        buildHermesModelConfigWriteCommand(modelConfig),
        { agentId },
      );
    }
    await runProvisionerExecCommand(
      provisioner,
      containerId,
      buildHermesEnvWriteCommand(llmEnvVars),
      { agentId },
    );
    await runProvisionerExecCommand(
      provisioner,
      containerId,
      buildHermesIntegrationInstallCommand(Array.isArray(integrationSync) ? integrationSync : []),
      { timeout: 30000, agentId },
    );
    await provisioner.restart(containerId, { agentId });
    const readiness = await waitForAgentReadiness(
      {
        host,
        runtimeHost,
        runtimePort,
        gatewayHostPort,
        gatewayHost,
        gatewayPort,
        checkGateway: false,
      },
      {
        beforeAttempt: authorizeRuntimeUse,
        runtime: {
          attempts: 8,
          intervalMs: 5000,
          timeoutMs: 5000,
        },
      },
    );
    if (!readiness.ok) {
      throw new Error(
        `Hermes runtime did not recover after auth reconcile (${readiness.runtime?.error || "unreachable"})`,
      );
    }
    return { status: "synced", providerFingerprint };
  }

  const authProfiles = buildAuthProfiles(llmEnvVars);
  const defaultModel = buildDefaultOpenClawModel(defaultProvider);

  const authWriteCommand = buildAuthProfilesWriteCommand(authProfiles);
  const reconciliationMutations = [
    async () => {
      try {
        await runRuntimeCommand(agentRef, authWriteCommand, {
          beforeAttempt: authorizeRuntimeUse,
        });
      } catch (error) {
        throwIfRemoteAuthorizationFailure(error);
        if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) {
          throw error;
        }
        await runProvisionerExecCommand(provisioner, containerId, authWriteCommand, { agentId });
      }
    },
  ];

  // Replace Nora-owned custom-provider registrations and default-model state
  // before restart. This must run even when the desired provider set is empty,
  // otherwise a deleted Foundry/demo key remains embedded in openclaw.json.
  const customProviderEnv =
    defaultProvider?.provider === "microsoft-foundry"
      ? {
          ...llmEnvVars,
          ...(defaultProvider.model ? { MICROSOFT_FOUNDRY_DEPLOYMENT: defaultProvider.model } : {}),
          ...(buildDefaultOpenClawModel(defaultProvider)
            ? { NORA_DEFAULT_OPENCLAW_MODEL: buildDefaultOpenClawModel(defaultProvider) }
            : {}),
        }
      : llmEnvVars;
  const customProviders = buildOpenClawCustomProviders(customProviderEnv);
  const providerStateCommand = buildOpenClawManagedProviderStateCommand({
    customProviders,
    defaultModel,
    managedModelProviderIds: MANAGED_OPENCLAW_MODEL_PROVIDER_IDS,
  });
  reconciliationMutations.push(async () => {
    try {
      return await runRuntimeCommand(agentRef, providerStateCommand, {
        timeout: 60000,
        beforeAttempt: authorizeRuntimeUse,
      });
    } catch (error) {
      throwIfRemoteAuthorizationFailure(error);
      if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) throw error;
      return runProvisionerExecCommand(provisioner, containerId, providerStateCommand, {
        agentId,
      });
    }
  });

  const mcpStateCommand = buildOpenClawManagedMcpServersCommand(desiredMcpServers);
  reconciliationMutations.push(async () => {
    try {
      return await runRuntimeCommand(agentRef, mcpStateCommand, {
        timeout: 60000,
        beforeAttempt: authorizeRuntimeUse,
      });
    } catch (error) {
      throwIfRemoteAuthorizationFailure(error);
      if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) throw error;
      return runProvisionerExecCommand(provisioner, containerId, mcpStateCommand, { agentId });
    }
  });

  reconciliationMutations.push(async () => {
    const syncData = Array.isArray(integrationSync) ? integrationSync : [];
    const runtimeUrl = runtimeUrlForAgent(
      {
        host,
        runtime_host: runtimeHost,
        runtime_port: runtimePort,
      },
      "/integrations/sync",
    );
    await fetchWithProvisionerAuthorization(provisioner, runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildRuntimeAuthHeaders(gatewayToken),
      },
      body: JSON.stringify({ integrations: syncData }),
    });
  });

  const readiness = await runRuntimeReconciliationBoundary({
    mutations: reconciliationMutations,
    restart: () => provisioner.restart(containerId, { agentId }),
    checkReadiness: () =>
      waitForAgentReadiness(
        {
          host,
          runtimeHost,
          runtimePort,
          gatewayHostPort,
          gatewayHost,
          gatewayPort,
        },
        {
          beforeAttempt: authorizeRuntimeUse,
        },
      ),
  });
  if (!readiness.ok) {
    throw new Error(
      `Agent runtime did not recover after auth reconcile (${readiness.runtime?.error || readiness.gateway?.error || "unreachable"})`,
    );
  }

  return { status: "synced", providerFingerprint };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pluggable Backend ────────────────────────────────────
const backendInstances = new Map();

function backendInstanceKey(runtimeFields = {}) {
  const backend =
    normalizeProvisionerDeployTarget(runtimeFields.deploy_target || runtimeFields.backend_type, {
      field: "runtime deploy target",
    }) || "docker";
  if (backend === "docker") {
    if (runtimeFields.runtime_family === "hermes") return "docker:hermes";
    if (runtimeFields.sandbox_profile === "nemoclaw") return "docker:nemoclaw";
  }
  if (backend === "k8s" && runtimeFields.execution_target_id) {
    return String(runtimeFields.execution_target_id).trim().toLowerCase() || "k8s";
  }
  if (backend === "remote-docker" && runtimeFields.execution_target_id) {
    const target =
      String(runtimeFields.execution_target_id).trim().toLowerCase() || "remote-docker";
    // Encode the runtime/sandbox path so OpenClaw, Hermes, and NemoClaw agents
    // on the same remote host do not share one cached adapter.
    if (runtimeFields.runtime_family === "hermes") return `hermes:${target}`;
    if (runtimeFields.sandbox_profile === "nemoclaw") return `nemoclaw:${target}`;
    return target;
  }
  return backend;
}

async function assertWorkerRemoteHostUse(runtimeFields = {}, ownerUserId = null, options = {}) {
  try {
    return await assertRemoteHostAgentUse(
      {
        ...runtimeFields,
        user_id: ownerUserId,
      },
      options,
    );
  } catch (error) {
    if (!isRemoteHostAccessRevokedError(error)) throw error;
    const revoked = new UnrecoverableError(error.message);
    revoked.code = error.code;
    revoked.statusCode = error.statusCode;
    throw revoked;
  }
}

function isRemoteDockerRuntime(runtimeFields = {}) {
  return (
    normalizeBackendName(
      runtimeFields.deploy_target || runtimeFields.deployTarget || runtimeFields.backend_type,
    ) === "remote-docker"
  );
}

async function runRemoteAuthorizationCheck(check) {
  try {
    return await check();
  } catch (error) {
    if (error && (typeof error === "object" || typeof error === "function")) {
      error[REMOTE_AUTHORIZATION_FAILURE] = true;
    }
    throw error;
  }
}

function findErrorInChain(error, predicate) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    if (predicate(current)) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

function errorChainSome(error, predicate) {
  return Boolean(findErrorInChain(error, predicate));
}

function isRemoteHostRevocation(error) {
  return errorChainSome(error, isRemoteHostAccessRevokedError);
}

function isRemoteAuthorizationFailure(error) {
  return errorChainSome(
    error,
    (current) =>
      Boolean(current?.[REMOTE_AUTHORIZATION_FAILURE]) || isRemoteHostAccessRevokedError(current),
  );
}

function toUnrecoverableRemoteHostRevocation(error) {
  const revoked = findErrorInChain(error, isRemoteHostAccessRevokedError);
  if (!revoked) return error;
  if (error?.name === "UnrecoverableError" && isRemoteHostAccessRevokedError(error)) {
    return error;
  }
  const unrecoverable = new UnrecoverableError(revoked.message);
  unrecoverable.code = revoked.code;
  unrecoverable.statusCode = revoked.statusCode;
  unrecoverable.cause = error;
  return unrecoverable;
}

function throwIfRemoteAuthorizationFailure(error) {
  if (isRemoteAuthorizationFailure(error)) throw error;
}

/**
 * Wrap a credential-bearing Remote Docker adapter so normal worker operations
 * revalidate the current owner/workspace grant. Runtime destruction and tracked
 * command cleanup deliberately bypass the grant so revoked work can be removed.
 */
function guardRemoteProvisioner(provisioner, runtimeFields = {}, ownerUserId = null) {
  if (!provisioner || !isRemoteDockerRuntime(runtimeFields)) return provisioner;

  const authorize = () =>
    runRemoteAuthorizationCheck(() =>
      assertWorkerRemoteHostUse(runtimeFields, ownerUserId, { includeProfile: false }),
    );

  return new Proxy(provisioner, {
    get(target, property, receiver) {
      if (property === REMOTE_PROVISIONER_AUTHORIZATION) return authorize;
      if (property === REMOTE_PROVISIONER_CLEANUP_EXEC) {
        return (containerId, commandId, agentId) =>
          startFixedProvisionerExecCleanup(target, containerId, commandId, agentId);
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "destroy") return value.bind(target);
      return async (...args) => {
        await authorize();
        return Reflect.apply(value, target, args);
      };
    },
  });
}

async function assertProvisionerAuthorized(provisioner) {
  const authorize = provisioner?.[REMOTE_PROVISIONER_AUTHORIZATION];
  if (typeof authorize === "function") {
    await authorize();
  }
}

/**
 * Resolve the provisioner backend for a runtime path, refreshing profile-backed
 * adapters and enforcing current owner/workspace grants for Remote Docker.
 *
 * @param {Object} [runtimeFields={}] - Runtime-selection fields identifying the backend.
 * @param {Object} [options={}] - Optional owner context used for remote-host authorization.
 * @returns {Promise<Object>} Authorized backend adapter used for lifecycle work.
 */
async function loadBackend(runtimeFields = {}, { ownerUserId = null } = {}) {
  const key = backendInstanceKey(runtimeFields);
  // Profile-backed targets can change at runtime. Rebuild from the latest
  // stored profile so credential rotation, host-key pins, addresses, namespaces,
  // and exposure settings take effect without restarting control-plane services.
  const profileBacked =
    key.startsWith("k8s:") ||
    key.startsWith("remote:") ||
    key.startsWith("hermes:remote:") ||
    key.startsWith("nemoclaw:remote:");
  if (backendInstances.has(key) && !profileBacked) return backendInstances.get(key);
  if (profileBacked) backendInstances.delete(key);

  let instance;
  switch (key) {
    case "docker":
      instance = new (require("./backends/docker"))();
      break;
    case "docker:hermes":
      instance = new (require("./backends/hermes"))();
      break;
    case "docker:nemoclaw":
      instance = new (require("./backends/nemoclaw"))();
      break;
    case "proxmox":
      instance = new (require("./backends/proxmox"))();
      break;
    default:
      if (key.startsWith("k8s:")) {
        backendInstances.delete(key);
        const profile = await getKubernetesClusterProfile(key);
        if (!profile) {
          throw new Error(`Unknown Kubernetes execution target: ${key}`);
        }
        instance = new (require("./backends/k8s"))(profile);
        break;
      }
      if (key === "k8s") {
        throw new Error(
          "Kubernetes provisioning requires an Admin-registered cluster target such as k8s:aks-eastus2.",
        );
      }
      if (key.startsWith("hermes:remote:")) {
        const executionTargetId = key.slice("hermes:".length);
        const profile = await assertWorkerRemoteHostUse(runtimeFields, ownerUserId);
        if (!profile) {
          throw new Error(`Unknown remote host execution target: ${executionTargetId}`);
        }
        if (!profile.configured) {
          throw new Error(
            profile.issue || `Remote host ${executionTargetId} is not configured for provisioning.`,
          );
        }
        instance = new (require("./backends/remote-hermes"))(profile);
        break;
      }
      if (key.startsWith("nemoclaw:remote:")) {
        const executionTargetId = key.slice("nemoclaw:".length);
        const profile = await assertWorkerRemoteHostUse(runtimeFields, ownerUserId);
        if (!profile) {
          throw new Error(`Unknown remote host execution target: ${executionTargetId}`);
        }
        if (!profile.configured) {
          throw new Error(
            profile.issue || `Remote host ${executionTargetId} is not configured for provisioning.`,
          );
        }
        instance = new (require("./backends/remote-nemoclaw"))(profile);
        break;
      }
      if (key.startsWith("remote:")) {
        const profile = await assertWorkerRemoteHostUse(runtimeFields, ownerUserId);
        if (!profile) {
          throw new Error(`Unknown remote host execution target: ${key}`);
        }
        if (!profile.configured) {
          throw new Error(
            profile.issue || `Remote host ${key} is not configured for provisioning.`,
          );
        }
        instance = new (require("./backends/remote-docker"))(profile);
        break;
      }
      if (key === "remote-docker") {
        throw new Error(
          "Remote Docker provisioning requires a registered host target such as remote:my-laptop.",
        );
      }
      {
        const error = new UnrecoverableError(`Unsupported provisioner deploy target: ${key}`);
        error.code = "UNSUPPORTED_DEPLOY_TARGET";
        throw error;
      }
  }

  backendInstances.set(key, instance);
  return guardRemoteProvisioner(instance, runtimeFields, ownerUserId);
}

async function runKubernetesPolicyReconcileJob({ clusterId }) {
  const normalizedClusterId = String(clusterId || "")
    .trim()
    .toLowerCase();
  if (!normalizedClusterId) {
    throw new Error("Kubernetes policy reconcile job is missing clusterId");
  }

  const lock = await acquireKubernetesPolicyReconcileLock(normalizedClusterId);
  try {
    const executionTargetId = `k8s:${normalizedClusterId}`;
    const profile = await getKubernetesClusterProfile(executionTargetId);
    if (!profile) {
      console.warn(
        `[k8s-policy-settings] Skipping reconcile for missing cluster ${normalizedClusterId}`,
      );
      return { skipped: true, clusterId: normalizedClusterId, reason: "cluster_missing" };
    }

    const desiredHash = buildPolicySettingsHash(profile.policySettings);
    const now = new Date().toISOString();

    await markKubernetesClusterPolicyStatus(normalizedClusterId, {
      state: "applying",
      desiredHash,
      customPolicyIssue: null,
      updatedAt: now,
    });

    const backend = await loadBackend({
      backend_type: "k8s",
      deploy_target: "k8s",
      execution_target_id: executionTargetId,
      runtime_family: "openclaw",
      sandbox_profile: "standard",
    });
    const reconcileResult = await backend.reconcilePolicySettings({
      policySettings: profile.policySettings,
      policySettingsStatus: profile.policySettingsStatus,
    });
    await markKubernetesClusterPolicyStatus(normalizedClusterId, {
      state: "applied",
      desiredHash,
      appliedHash: desiredHash,
      lastAppliedNamespaces: reconcileResult.appliedNamespaces,
      customPolicyIssue: null,
      customPolicyAppliedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      clusterId: normalizedClusterId,
      desiredHash,
      state: "applied",
      appliedNamespaces: reconcileResult.appliedNamespaces,
    };
  } catch (error) {
    await markKubernetesClusterPolicyStatus(normalizedClusterId, {
      state: "failed",
      desiredHash,
      customPolicyIssue: error?.message || "Kubernetes policy reconcile failed.",
      updatedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    await lock.release();
  }
}

function replacementRuntimeError(message, code = "REPLACEMENT_RUNTIME_INVALID") {
  const error = new UnrecoverableError(message);
  error.code = code;
  return error;
}

function normalizeReplacementValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function loadQueuedPreviousRuntimeTuple(agentId, jobData, agentRow) {
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
    throw replacementRuntimeError(
      `Replacement job for agent ${agentId} omitted the previous runtime tuple: ${missing.join(", ")}`,
      "REPLACEMENT_RUNTIME_TUPLE_INCOMPLETE",
    );
  }

  const queued = {
    container_id: normalizeReplacementValue(jobData.previous_container_id),
    container_name: normalizeReplacementValue(jobData.previous_container_name),
    host: normalizeReplacementValue(jobData.previous_host),
    backend_type: normalizeReplacementValue(jobData.previous_backend),
    runtime_family: normalizeReplacementValue(jobData.previous_runtime_family),
    deploy_target: normalizeReplacementValue(jobData.previous_deploy_target),
    execution_target_id: normalizeReplacementValue(jobData.previous_execution_target_id),
    sandbox_profile: normalizeReplacementValue(jobData.previous_sandbox_profile),
  };
  const durableRuntimeFields = buildAgentRuntimeFields(agentRow);
  const durable = {
    container_id: normalizeReplacementValue(agentRow.container_id),
    container_name: normalizeReplacementValue(agentRow.container_name),
    host: normalizeReplacementValue(agentRow.host),
    backend_type: durableRuntimeFields.backend_type,
    runtime_family: durableRuntimeFields.runtime_family,
    deploy_target: durableRuntimeFields.deploy_target,
    execution_target_id: durableRuntimeFields.execution_target_id,
    sandbox_profile: durableRuntimeFields.sandbox_profile,
  };

  for (const field of ["container_id", "container_name", "host"]) {
    if (queued[field] !== durable[field]) {
      throw replacementRuntimeError(
        `Replacement runtime identity mismatch for agent ${agentId}: queued ${field}=${queued[field] || "empty"}, persisted ${field}=${durable[field] || "empty"}`,
        "REPLACEMENT_RUNTIME_IDENTITY_MISMATCH",
      );
    }
  }
  for (const field of [
    "backend_type",
    "runtime_family",
    "deploy_target",
    "execution_target_id",
    "sandbox_profile",
  ]) {
    if (queued[field] !== durable[field]) {
      throw replacementRuntimeError(
        `Replacement runtime tuple mismatch for agent ${agentId}: queued ${field}=${queued[field] || "empty"}, persisted ${field}=${durable[field] || "empty"}`,
        "REPLACEMENT_RUNTIME_TUPLE_MISMATCH",
      );
    }
  }

  return queued;
}

/**
 * Validate a queued replacement against durable runtime identity, destroy that
 * exact prior runtime, then compare-and-swap the desired placement into storage.
 *
 * @param {Object} [params={}] - Queued job, durable row, and resolved replacement fields.
 * @returns {Promise<Object>} Replacement status and the updated mutable agent row.
 */
async function prepareReplacementRuntime({
  queryable = db,
  agentId,
  agentRow,
  name,
  jobData = {},
  resolvedRuntimeFields,
  resolvedImage,
} = {}) {
  if (jobData.replace_existing_runtime !== true) {
    return { replacement: false, agentRow };
  }

  const previousRuntime = loadQueuedPreviousRuntimeTuple(agentId, jobData, agentRow);
  const previousRuntimeFields = {
    backend_type: previousRuntime.backend_type,
    runtime_family: previousRuntime.runtime_family,
    deploy_target: previousRuntime.deploy_target,
    execution_target_id: previousRuntime.execution_target_id,
    sandbox_profile: previousRuntime.sandbox_profile,
  };
  const previousContainerId = previousRuntime.container_id;
  const previousContainerName = previousRuntime.container_name;

  const previousAgent = {
    id: agentId,
    name: name || jobData.name || agentRow.name,
    user_id: agentRow.user_id,
    container_id: previousContainerId,
    container_name: previousContainerName,
    host: previousRuntime.host,
    runtime_family: previousRuntimeFields.runtime_family,
    backend_type: previousRuntimeFields.backend_type,
    deploy_target: previousRuntimeFields.deploy_target,
    execution_target_id: previousRuntimeFields.execution_target_id,
    sandbox_profile: previousRuntimeFields.sandbox_profile,
    sandbox_type: previousRuntimeFields.sandbox_profile,
  };

  let previousRuntimeDestroyed = false;
  const hasPreviousRuntimeIdentity = Boolean(previousContainerId || previousContainerName);
  const canDestroyPreviousRuntime = containerManager.canDestroy(previousAgent);
  if (hasPreviousRuntimeIdentity && !canDestroyPreviousRuntime) {
    throw replacementRuntimeError(
      `Previous runtime for agent ${agentId} has persisted identity but cannot be destroyed safely`,
      "REPLACEMENT_RUNTIME_DESTROY_UNAVAILABLE",
    );
  }
  if (canDestroyPreviousRuntime) {
    console.log(
      `[provisioner] Destroying previous ${previousRuntimeFields.deploy_target} runtime ${previousAgent.container_id || previousAgent.container_name || previousAgent.name} before redeploying agent ${agentId}`,
    );
    await containerManager.destroy(previousAgent);
    previousRuntimeDestroyed = true;
  }

  const desiredContainerName = jobData.container_name || agentRow.container_name || null;
  let updated;
  try {
    updated = await queryable.query(
      `UPDATE agents
        SET container_id = NULL,
            host = NULL,
            runtime_host = NULL,
            runtime_port = NULL,
            gateway_host = NULL,
            gateway_port = NULL,
            gateway_host_port = NULL,
            gateway_token = NULL,
            dashboard_port = NULL,
            backend_type = $2,
            sandbox_type = $3,
            runtime_family = $4,
            deploy_target = $5,
            execution_target_id = $6,
            sandbox_profile = $7,
            container_name = $8,
            image = $9
      WHERE id = $1
        AND status = 'deploying'
        AND container_id IS NOT DISTINCT FROM $10
        AND container_name IS NOT DISTINCT FROM $11
        AND backend_type = $12
        AND runtime_family = $13
        AND deploy_target = $14
        AND execution_target_id = $15
        AND sandbox_profile = $16
        AND host IS NOT DISTINCT FROM $17
      RETURNING image, template_payload, sandbox_type, backend_type, runtime_family,
                deploy_target, execution_target_id, sandbox_profile, gateway_token, mcp_servers,
                status, container_id, container_name, host, runtime_host, runtime_port,
                gateway_host, gateway_port, gateway_host_port, dashboard_port, user_id`,
      [
        agentId,
        resolvedRuntimeFields.backend_type,
        resolvedRuntimeFields.sandbox_profile,
        resolvedRuntimeFields.runtime_family,
        resolvedRuntimeFields.deploy_target,
        resolvedRuntimeFields.execution_target_id,
        resolvedRuntimeFields.sandbox_profile,
        desiredContainerName,
        resolvedImage,
        previousContainerId,
        previousContainerName,
        previousRuntimeFields.backend_type,
        previousRuntimeFields.runtime_family,
        previousRuntimeFields.deploy_target,
        previousRuntimeFields.execution_target_id,
        previousRuntimeFields.sandbox_profile,
        previousRuntime.host,
      ],
    );
  } catch (error) {
    if (!previousRuntimeDestroyed) throw error;
    const persistenceError = replacementRuntimeError(
      `Previous runtime for agent ${agentId} was destroyed, but replacement placement could not be persisted`,
      "REPLACEMENT_RUNTIME_STATE_PERSIST_FAILED",
    );
    persistenceError.previousRuntimeDestroyed = true;
    persistenceError.cause = error;
    throw persistenceError;
  }
  if (!updated.rows[0]) {
    const error = replacementRuntimeError(
      `Agent ${agentId} changed while its previous runtime was being retired`,
      "REPLACEMENT_RUNTIME_STATE_CHANGED",
    );
    error.previousRuntimeDestroyed = previousRuntimeDestroyed;
    throw error;
  }
  Object.assign(agentRow, updated.rows[0]);
  return { replacement: true, agentRow, previousAgent };
}

async function markDeploymentLifecycle(db, agentId, status) {
  await db.query("UPDATE agents SET status = $2 WHERE id = $1", [agentId, status]);
  await db.query("UPDATE deployments SET status = $2 WHERE agent_id = $1", [agentId, status]);
}

function mergePlainObjects(current, next) {
  if (!next || typeof next !== "object" || Array.isArray(next)) return next;
  const out =
    current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(next)) {
    out[key] = mergePlainObjects(out[key], value);
  }
  return out;
}

/**
 * Reseed persisted OpenClaw channel config into a fresh runtime. Channel
 * config lives in the runtime's openclaw.json, which dies with the container
 * on redeploy; every channel save keeps an encrypted per-channel config patch
 * in openclaw_channel_state. Merging them back restores token channels —
 * QR-linked sessions (WhatsApp device links) still need a re-pair, since
 * device state cannot be captured control-plane-side.
 */
async function reconcileOpenClawChannelState({
  agentId,
  resolvedBackend,
  containerId,
  provisioner,
  host,
  runtimeHost,
  runtimePort,
  gatewayToken,
}) {
  const rows = await db.query(
    "SELECT channel_id, config_encrypted FROM openclaw_channel_state WHERE agent_id = $1",
    [agentId],
  );
  if (rows.rows.length === 0) return { status: "skipped" };

  const { decrypt } = require("./crypto");
  let delta = {};
  for (const row of rows.rows) {
    try {
      delta = mergePlainObjects(delta, JSON.parse(decrypt(row.config_encrypted)));
    } catch (error) {
      console.warn(
        `[provisioner] Skipping undecryptable channel state ${row.channel_id} for agent ${agentId}: ${error.message}`,
      );
    }
  }
  if (Object.keys(delta).length === 0) return { status: "skipped" };

  const agentRef = {
    backend_type: resolvedBackend,
    host,
    runtime_host: runtimeHost,
    runtime_port: runtimePort,
    gateway_token: gatewayToken,
  };
  const command = buildOpenClawConfigMergeCommand(delta);
  try {
    await runRuntimeCommand(agentRef, command, {
      beforeAttempt: () => assertProvisionerAuthorized(provisioner),
    });
  } catch (error) {
    throwIfRemoteAuthorizationFailure(error);
    if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) throw error;
    await runProvisionerExecCommand(provisioner, containerId, command, { agentId });
  }
  return { status: "synced", channels: rows.rows.length };
}

// ── ClawHub Helpers ──────────────────────────────────────
function createClawhubSkillJobLogger({ jobId, agentId, slug, operation }) {
  const startedAt = Date.now();

  return (step, message, extra = null) => {
    const elapsedMs = Date.now() - startedAt;
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    console.log(
      `[clawhub-jobs] operation=${operation} job=${jobId} agent=${agentId} slug=${slug} step=${step} elapsedMs=${elapsedMs} ${message}${suffix}`,
    );
  };
}

function normalizeInstalledSkillsLockfile(parsed = {}) {
  const skills = parsed?.skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return [];

  return Object.entries(skills)
    .map(([slug, entry]) => ({
      slug,
      version:
        entry && typeof entry === "object" && typeof entry.version === "string"
          ? entry.version
          : "",
    }))
    .filter((entry) => entry.slug);
}

/**
 * Read `.clawhub/lock.json` from the runtime container and normalize it into a
 * list of installed skills.
 *
 * The helper uses a TTY plus base64 transport because raw Docker exec streams
 * can prepend framing bytes that corrupt JSON reads. JSON decode or parse
 * failures are retried; a valid missing-file result is returned immediately.
 *
 * @param {object} provisioner Backend-specific provisioner client with `exec`.
 * @param {string} containerId Runtime container identifier.
 * @param {string} agentId Agent identifier used to authorize and track exec commands.
 * @returns {Promise<Array<{slug: string, version: string}>>} The installed
 * ClawHub skills currently represented in the runtime lockfile.
 */
async function readInstalledClawhubSkills(provisioner, containerId, agentId) {
  const readCommand =
    `if [ -f ${JSON.stringify(CLAWHUB_LOCKFILE_PATH)} ]; then ` +
    `base64 < ${JSON.stringify(CLAWHUB_LOCKFILE_PATH)} | tr -d '\\n'; ` +
    `else printf 'eyJ2ZXJzaW9uIjoxLCJza2lsbHMiOnt9fQ=='; fi`;

  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const { output } = await runProvisionerExecCommand(provisioner, containerId, readCommand, {
      // Use a TTY here so Docker does not prepend multiplexed stream framing bytes
      // to the lockfile payload. We additionally base64-wrap the file contents so
      // JSON parsing only happens after the transport output is normalized.
      tty: true,
      env: ["TERM=dumb", "CI=1", "NO_COLOR=1", "CLICOLOR=0"],
      agentId,
    });

    try {
      const decoded = Buffer.from(
        String(output || "eyJ2ZXJzaW9uIjoxLCJza2lsbHMiOnt9fQ==").trim(),
        "base64",
      ).toString("utf8");
      return normalizeInstalledSkillsLockfile(JSON.parse(decoded || '{"version":1,"skills":{}}'));
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await sleep(250 * attempt);
      }
    }
  }

  throw new Error(`Failed to parse ClawHub lockfile: ${lastError?.message || "unknown error"}`);
}

/**
 * Ensure the `clawhub` CLI is available inside a running OpenClaw container
 * before Nora attempts install/delete operations.
 *
 * @param {Object} provisioner - Backend-specific provisioner client with `exec`.
 * @param {string} containerId - Runtime container identifier.
 * @param {string} agentId - Agent identifier used to authorize and track the exec command.
 * @returns {Promise<void>} Resolves when the CLI is already present or installs successfully.
 */
async function ensureClawhubCli(provisioner, containerId, agentId) {
  try {
    await runProvisionerExecCommand(
      provisioner,
      containerId,
      wrapCommandWithContainerTimeout(
        "if command -v clawhub >/dev/null 2>&1; then exit 0; fi; " +
          "if ! command -v npm >/dev/null 2>&1; then exit 42; fi; " +
          "npm install -g clawhub",
        CLAWHUB_INSTALL_TIMEOUT_MS,
      ),
      {
        timeout: CLAWHUB_INSTALL_TIMEOUT_MS + 10000,
        env: ["TERM=dumb", "CI=1", "NO_COLOR=1", "CLICOLOR=0"],
        agentId,
      },
    );
  } catch (error) {
    if (String(error?.message || "").includes("exit 42")) {
      const npmError = new Error(
        "The clawhub CLI could not be installed. Ensure Node.js is in your base image.",
      );
      npmError.code = "npm_unavailable";
      throw npmError;
    }
    throw error;
  }
}

async function appendSavedClawhubSkill(agentId, slug, skillEntry) {
  const normalizedEntry = normalizeSavedClawhubSkillEntry(slug, skillEntry);
  if (!normalizedEntry) return;

  const result = await db.query("SELECT clawhub_skills FROM agents WHERE id = $1 LIMIT 1", [
    agentId,
  ]);
  const current = Array.isArray(result.rows[0]?.clawhub_skills)
    ? result.rows[0].clawhub_skills
    : [];
  const exists = current.some((entry) => {
    const savedSlug = String(entry?.installSlug || entry?.slug || "").trim();
    const savedAuthor = String(entry?.author || "").trim();
    return savedSlug === normalizedEntry.installSlug && savedAuthor === normalizedEntry.author;
  });
  if (exists) return;

  await db.query("UPDATE agents SET clawhub_skills = $2::jsonb WHERE id = $1", [
    agentId,
    JSON.stringify([...current, normalizedEntry]),
  ]);
}

async function removeSavedClawhubSkill(agentId, slug, skillEntry) {
  const normalizedEntry = normalizeSavedClawhubSkillEntry(slug, skillEntry);
  const result = await db.query("SELECT clawhub_skills FROM agents WHERE id = $1 LIMIT 1", [
    agentId,
  ]);
  const current = Array.isArray(result.rows[0]?.clawhub_skills)
    ? result.rows[0].clawhub_skills
    : [];
  const next = removeSavedSkillEntry(
    current,
    normalizedEntry?.installSlug || slug,
    normalizedEntry?.author || "",
  );
  await db.query("UPDATE agents SET clawhub_skills = $2::jsonb WHERE id = $1", [
    agentId,
    JSON.stringify(next),
  ]);
}

async function installClawhubSkill(provisioner, containerId, slug, agentId) {
  await ensureClawhubCli(provisioner, containerId, agentId);
  // Keep the install invocation unwrapped (no nested in-container `timeout ... /bin/sh -lc ...`).
  // A nested timeout caused Nora-driven ClawHub installs to hang even though the same CLI command
  // completed quickly when run directly in the container. The outer exec timeout below is the single
  // guardrail. `slug` is shell-quoted (single quotes) so it cannot inject into the container shell.
  await runProvisionerExecCommand(
    provisioner,
    containerId,
    `cd ${JSON.stringify(OPENCLAW_WORKSPACE_PATH)} && clawhub install ${shellSingleQuote(
      slug,
    )} --no-input`,
    {
      timeout: CLAWHUB_INSTALL_TIMEOUT_MS + 10000,
      maxOutputBytes: 32768,
      env: ["TERM=dumb", "CI=1", "NO_COLOR=1", "CLICOLOR=0"],
      agentId,
    },
  );
}

async function uninstallClawhubSkill(provisioner, containerId, slug, agentId) {
  await ensureClawhubCli(provisioner, containerId, agentId);
  // `slug` is shell-quoted (single quotes) so it cannot inject into the container shell.
  await runProvisionerExecCommand(
    provisioner,
    containerId,
    `cd ${JSON.stringify(OPENCLAW_WORKSPACE_PATH)} && clawhub uninstall ${shellSingleQuote(
      slug,
    )} --yes`,
    {
      timeout: CLAWHUB_INSTALL_TIMEOUT_MS + 10000,
      maxOutputBytes: 32768,
      env: ["TERM=dumb", "CI=1", "NO_COLOR=1", "CLICOLOR=0"],
      agentId,
    },
  );
}

/**
 * Reconcile the OpenClaw runtime's installed ClawHub skills against Nora's
 * saved desired state in `agents.clawhub_skills`.
 *
 * Missing saved skills are reinstalled so the container matches persisted
 * state. Runtime-only skills are treated as drift: they stay visible to the UI
 * and are only auto-pruned when `CLAWHUB_PRUNE_ORPHANED_SKILLS=true`, so a
 * manual in-container install is not silently removed by default.
 *
 * @param {object} params Reconciliation inputs.
 * @param {string} params.agentId Agent id whose saved ClawHub state is read.
 * @param {string} params.containerId Runtime container identifier.
 * @param {object} params.provisioner Backend-specific provisioner client.
 * @param {string} [params.logPrefix="[clawhub-reconcile]"] Log prefix for reconciliation messages.
 * @returns {Promise<void>} Resolves after reconciliation attempts finish or no
 * action is needed.
 */
async function reconcileClawhubSkills({
  agentId,
  containerId,
  provisioner,
  logPrefix = "[clawhub-reconcile]",
}) {
  const result = await db.query(
    "SELECT clawhub_skills, backend_type, runtime_family FROM agents WHERE id = $1 LIMIT 1",
    [agentId],
  );
  const agent = result.rows[0];
  if (!agent) {
    console.warn(`${logPrefix} agent=${agentId} Agent row not found; skipping reconciliation`);
    return;
  }

  if (agent.runtime_family !== "openclaw") {
    return;
  }

  const savedSkills = Array.isArray(agent.clawhub_skills) ? agent.clawhub_skills : [];

  let installedSkills = [];
  try {
    installedSkills = await readInstalledClawhubSkills(provisioner, containerId, agentId);
  } catch (error) {
    throwIfRemoteAuthorizationFailure(error);
    console.warn(
      `${logPrefix} agent=${agentId} Failed to read installed skills before reconciliation: ${error.message}`,
    );
    installedSkills = [];
  }

  const missingSkills = computeMissingSavedSkills(savedSkills, installedSkills);
  const orphanedSkills = computeOrphanedInstalledSkills(savedSkills, installedSkills);

  if (!missingSkills.length && !orphanedSkills.length) {
    console.log(`${logPrefix} agent=${agentId} ClawHub runtime already matches saved state`);
    return;
  }

  if (missingSkills.length) {
    console.log(
      `${logPrefix} agent=${agentId} Reconciling ${missingSkills.length} missing ClawHub skill(s)`,
    );
  }

  for (const skill of missingSkills) {
    try {
      console.log(
        `${logPrefix} agent=${agentId} slug=${skill.installSlug} Installing missing saved skill`,
      );
      await installClawhubSkill(provisioner, containerId, skill.installSlug, agentId);
      console.log(
        `${logPrefix} agent=${agentId} slug=${skill.installSlug} Reconciliation install completed`,
      );
    } catch (error) {
      throwIfRemoteAuthorizationFailure(error);
      const message = String(error?.message || "");
      if (message.includes("Already installed")) {
        console.log(
          `${logPrefix} agent=${agentId} slug=${skill.installSlug} Skill already installed during reconciliation`,
        );
        continue;
      }
      console.warn(
        `${logPrefix} agent=${agentId} slug=${skill.installSlug} Reconciliation install failed: ${message}`,
      );
    }
  }

  // Pruning orphaned runtime skills (installed in the container but not tracked in the agents
  // table) is destructive and OFF by default: it would silently delete skills an operator
  // installed manually inside the container. Drift is always surfaced in the merged skill view
  // and can be removed explicitly via the delete route; set CLAWHUB_PRUNE_ORPHANED_SKILLS=true
  // to opt into automatic pruning during reconciliation.
  const pruneOrphans = process.env.CLAWHUB_PRUNE_ORPHANED_SKILLS === "true";

  if (orphanedSkills.length && !pruneOrphans) {
    console.warn(
      `${logPrefix} agent=${agentId} Detected ${orphanedSkills.length} orphaned ClawHub skill(s) not in saved state; ` +
        `automatic pruning is disabled (set CLAWHUB_PRUNE_ORPHANED_SKILLS=true to enable). ` +
        `Leaving runtime skills in place: ${orphanedSkills.map((skill) => skill.slug).join(", ")}`,
    );
  }

  if (orphanedSkills.length && pruneOrphans) {
    console.warn(
      `${logPrefix} agent=${agentId} Pruning ${orphanedSkills.length} orphaned ClawHub skill(s) (CLAWHUB_PRUNE_ORPHANED_SKILLS=true)`,
    );
    for (const skill of orphanedSkills) {
      try {
        console.warn(
          `${logPrefix} agent=${agentId} slug=${skill.slug} Removing orphaned runtime skill`,
        );
        await uninstallClawhubSkill(provisioner, containerId, skill.slug, agentId);
        console.warn(
          `${logPrefix} agent=${agentId} slug=${skill.slug} Reconciliation uninstall completed`,
        );
      } catch (error) {
        throwIfRemoteAuthorizationFailure(error);
        const message = String(error?.message || "");
        console.warn(
          `${logPrefix} agent=${agentId} slug=${skill.slug} Reconciliation uninstall failed: ${message}`,
        );
      }
    }
  }
}

/**
 * Load and validate the agent targeted by a queued ClawHub job.
 *
 * @param {string} agentId - Agent whose runtime will be mutated.
 * @returns {Promise<Object>} Running OpenClaw agent with a usable container id.
 */
async function loadClawhubJobAgent(agentId) {
  const result = await db.query(
    `SELECT id, user_id, name, status, container_id, backend_type, runtime_family, deploy_target,
            execution_target_id, sandbox_profile, clawhub_skills
       FROM agents
      WHERE id = $1
      LIMIT 1`,
    [agentId],
  );
  const agent = result.rows[0];
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  if (agent.runtime_family !== "openclaw") {
    throw new Error("ClawHub mutations are only available for OpenClaw agents.");
  }
  if (!agent.container_id || (agent.status !== "running" && agent.status !== "warning")) {
    throw new Error("Start the agent before managing ClawHub skills.");
  }
  return agent;
}

/**
 * Perform one queued ClawHub install operation for an agent and persist the DB
 * state only after runtime verification succeeds.
 *
 * The job is intentionally idempotent: if the slug is already present in the
 * runtime lockfile, the function skips the CLI call and optionally backfills
 * `agents.clawhub_skills`. Fresh installs must appear in the lockfile before
 * the saved state is updated.
 *
 * @param {object} params Install job inputs.
 * @param {string} params.agentId Agent id whose saved ClawHub state may be updated.
 * @param {string} params.slug ClawHub slug to install.
 * @param {object} params.skillEntry Saved-state metadata for the skill.
 * @param {boolean} [params.persistOnSuccess=true] Whether to persist the skill to `agents.clawhub_skills`.
 * @param {object} params.provisioner Backend-specific provisioner client.
 * @param {string} params.containerId Runtime container identifier.
 * @param {Function} params.logJob Structured job logger for progress events.
 * @returns {Promise<{agentId: string, slug: string, operation: "install", installedSkills: Array<{slug: string, version: string}>}>}
 * The verified post-install runtime state for the agent.
 */
async function runClawhubInstallJob({
  agentId,
  slug,
  skillEntry,
  persistOnSuccess = true,
  provisioner,
  containerId,
  logJob,
}) {
  logJob("cli-check", "Ensuring clawhub CLI is available");
  await ensureClawhubCli(provisioner, containerId, agentId);
  logJob("cli-check", "Clawhub CLI is ready");

  logJob("precheck", "Reading installed skills before install");
  const installedBefore = await readInstalledClawhubSkills(provisioner, containerId, agentId);
  logJob("precheck", "Read installed skills before install", {
    installedCount: installedBefore.length,
  });
  if (installedBefore.some((entry) => entry.slug === slug)) {
    logJob("precheck", "Skill already installed before command");
    if (persistOnSuccess) {
      logJob("persist", "Persisting already-installed skill to agents table");
      await appendSavedClawhubSkill(agentId, slug, skillEntry);
      logJob("persist", "Persisted already-installed skill");
    }
    return {
      agentId,
      slug,
      operation: "install",
      installedSkills: installedBefore,
    };
  }

  try {
    logJob("install", "Running clawhub install command", {
      timeoutMs: CLAWHUB_INSTALL_TIMEOUT_MS,
    });
    await installClawhubSkill(provisioner, containerId, slug, agentId);
    logJob("install", "Clawhub install command finished");
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Already installed")) {
      logJob("install", "Clawhub install command failed", {
        error: message,
      });
      throw error;
    }
    logJob("install", "Clawhub reported skill already installed");
  }

  logJob("verify", "Reading installed skills after install");
  const installedSkills = await readInstalledClawhubSkills(provisioner, containerId, agentId);
  logJob("verify", "Read installed skills after install", {
    installedCount: installedSkills.length,
  });
  if (!installedSkills.some((entry) => entry.slug === slug)) {
    logJob("verify", "Lockfile missing expected slug after install");
    throw new Error(`ClawHub install completed but ${slug} was not found in lockfile`);
  }

  if (persistOnSuccess) {
    logJob("persist", "Persisting successful install to agents table");
    await appendSavedClawhubSkill(agentId, slug, skillEntry);
    logJob("persist", "Persisted successful install");
  }

  return {
    agentId,
    slug,
    operation: "install",
    installedSkills,
  };
}

/**
 * Perform one queued ClawHub delete operation for an agent and remove the DB
 * entry only after the runtime lockfile confirms the slug is gone.
 *
 * Deletes are also idempotent: if the runtime already lacks the slug, the job
 * treats that as success and only updates saved state when requested. This
 * keeps the DB as Nora's desired-state record without requiring the uninstall
 * command to run on every retry.
 *
 * @param {object} params Delete job inputs.
 * @param {string} params.agentId Agent id whose saved ClawHub state may be updated.
 * @param {string} params.slug ClawHub slug to remove.
 * @param {object} params.skillEntry Saved-state metadata used when removing the DB entry.
 * @param {boolean} [params.removeSavedEntryOnSuccess=true] Whether to remove the skill from `agents.clawhub_skills`.
 * @param {object} params.provisioner Backend-specific provisioner client.
 * @param {string} params.containerId Runtime container identifier.
 * @param {Function} params.logJob Structured job logger for progress events.
 * @returns {Promise<{agentId: string, slug: string, operation: "delete", installedSkills: Array<{slug: string, version: string}>}>}
 * The verified post-delete runtime state for the agent.
 */
async function runClawhubDeleteJob({
  agentId,
  slug,
  skillEntry,
  removeSavedEntryOnSuccess = true,
  provisioner,
  containerId,
  logJob,
}) {
  logJob("cli-check", "Ensuring clawhub CLI is available");
  await ensureClawhubCli(provisioner, containerId, agentId);
  logJob("cli-check", "Clawhub CLI is ready");

  logJob("precheck", "Reading installed skills before delete");
  const installedBefore = await readInstalledClawhubSkills(provisioner, containerId, agentId);
  logJob("precheck", "Read installed skills before delete", {
    installedCount: installedBefore.length,
  });

  if (installedBefore.some((entry) => entry.slug === slug)) {
    logJob("delete", "Running clawhub uninstall command", {
      timeoutMs: CLAWHUB_INSTALL_TIMEOUT_MS,
    });
    await uninstallClawhubSkill(provisioner, containerId, slug, agentId);
    logJob("delete", "Clawhub uninstall command finished");
  } else {
    logJob("precheck", "Skill already absent before delete");
  }

  logJob("verify", "Reading installed skills after delete");
  const installedSkills = await readInstalledClawhubSkills(provisioner, containerId, agentId);
  logJob("verify", "Read installed skills after delete", {
    installedCount: installedSkills.length,
  });
  if (installedSkills.some((entry) => entry.slug === slug)) {
    logJob("verify", "Lockfile still contains slug after delete");
    throw new Error(`ClawHub uninstall completed but ${slug} is still present in lockfile`);
  }

  if (removeSavedEntryOnSuccess) {
    logJob("persist", "Removing saved ClawHub skill from agents table if present");
    await removeSavedClawhubSkill(agentId, slug, skillEntry);
    logJob("persist", "Removed saved ClawHub skill from agents table if present");
  }

  return {
    agentId,
    slug,
    operation: "delete",
    installedSkills,
  };
}

const enabledBackends = getEnabledBackends();
const DEPLOYMENT_WORKER_CONCURRENCY = parsePositiveInteger(
  process.env.DEPLOYMENT_WORKER_CONCURRENCY,
  3,
);
console.log(
  `Provisioner worker started [enabled backends=${enabledBackends.join(", ") || "docker"} default backend=${getDefaultBackend()} concurrency=${DEPLOYMENT_WORKER_CONCURRENCY}]`,
);

// ── Worker ───────────────────────────────────────────────
const worker = new Worker(
  "deployments",
  async (job) => {
    const {
      id,
      name,
      image,
      specs,
      sandbox,
      backend,
      container_name,
      model,
      llm_provider_id: llmProviderId,
    } = job.data;
    const vcpu = specs?.vcpu || 1;
    const ram_mb = specs?.ram_mb || 1024;
    const disk_gb = specs?.disk_gb || 10;

    // Per-agent advisory lock: prevents two concurrent provision jobs (same
    // worker or cross-replica) from both calling adapter.create() and leaking
    // one of the containers when the second UPDATE overwrites the first.
    const provisionLock = await acquireAgentProvisionLock(id);
    try {
      const agentRowResult = await db.query(
        `SELECT image, template_payload, sandbox_type, backend_type, runtime_family,
            deploy_target, execution_target_id, sandbox_profile, gateway_token, mcp_servers, status,
            container_id, container_name, host, runtime_host, runtime_port, gateway_host,
            gateway_port, gateway_host_port, dashboard_port, user_id
       FROM agents
      WHERE id = $1`,
        [id],
      );
      const agentRow = agentRowResult.rows[0];
      if (!agentRow) {
        console.warn(`[provisioner] Skipping deployment job ${job.id}; agent ${id} was deleted`);
        return { canceled: true, reason: "agent-deleted" };
      }
      if (!["queued", "deploying"].includes(agentRow.status)) {
        console.warn(
          `[provisioner] Skipping deployment job ${job.id}; agent ${id} is ${agentRow.status}`,
        );
        return { canceled: true, reason: `agent-${agentRow.status}` };
      }
      let ownerUserId;
      try {
        ownerUserId = resolveCanonicalDeploymentOwnerUserId(job.data, agentRow);
      } catch (error) {
        await persistProvisioningFailure({
          queryable: db,
          job,
          agentId: id,
          name,
          error,
          forceTerminal: true,
        });
        throw error;
      }
      // A retained runtime identity is the highest-priority provisioning
      // safety barrier after owner validation. Refuse the job before parsing
      // a possibly stale desired target so malformed selection metadata cannot
      // mask the live/orphaned runtime that an operator must reconcile first.
      if (agentRow.container_id && job.data.replace_existing_runtime !== true) {
        console.error(
          `[provisioner] Refusing to create a replacement runtime for agent ${id}; unresolved runtime ${agentRow.container_id} is still persisted`,
        );
        return await failDeploymentForUnresolvedRuntime({
          queryable: db,
          job,
          agentId: id,
          name,
          containerId: agentRow.container_id,
          error: new Error("A previous provisioning attempt left runtime identity in place"),
        });
      }
      // gateway_token is encrypted at rest. Decrypt the stored value in place so
      // the reuse path (k8s/Hermes pass it back into the container as the runtime
      // password) gets plaintext. A rotated/corrupted key → treat as no reusable
      // token so the backend generates a fresh one rather than failing the deploy.
      if (agentRow.gateway_token) {
        const { decrypt } = require("./crypto");
        try {
          agentRow.gateway_token = decrypt(agentRow.gateway_token);
        } catch (err) {
          console.warn(
            `[provisioner] Could not decrypt stored gateway_token for agent ${id} — generating a fresh token: ${err.message}`,
          );
          agentRow.gateway_token = null;
        }
      }
      let storedRuntimeFields;
      let resolvedRuntimeFields;
      let resolvedBackend;
      let resolvedSandbox;
      let provisioner;
      try {
        normalizeProvisionerDeployTarget(agentRow.deploy_target, {
          field: "persisted deploy target",
        });
        normalizeProvisionerExecutionTargetId(agentRow.execution_target_id, {
          field: "persisted execution target",
        });
        if (!String(agentRow.deploy_target ?? "").trim()) {
          normalizeProvisionerDeployTarget(agentRow.backend_type, {
            field: "persisted backend type",
            allowLegacyBackendAlias: true,
          });
        }

        const queuedDeployTarget =
          normalizeProvisionerDeployTarget(job.data.deploy_target, {
            field: "deployment job deploy target",
          }) ||
          normalizeProvisionerDeployTarget(backend, {
            field: "deployment job backend",
            allowLegacyBackendAlias: true,
          });
        const queuedTargetValue = String(job.data.deploy_target || backend || "")
          .trim()
          .toLowerCase();
        const queuedExecutionTargetId =
          normalizeProvisionerExecutionTargetId(job.data.execution_target_id, {
            field: "deployment job execution target",
          }) ||
          (/^(?:k8s|remote):/.test(queuedTargetValue)
            ? normalizeProvisionerExecutionTargetId(queuedTargetValue, {
                field: "deployment job execution target",
              })
            : null);

        storedRuntimeFields = buildAgentRuntimeFields(agentRow);
        resolvedRuntimeFields = buildAgentRuntimeFields({
          runtime_family: job.data.runtime_family || storedRuntimeFields.runtime_family,
          deploy_target: queuedDeployTarget || storedRuntimeFields.deploy_target,
          execution_target_id: queuedExecutionTargetId || storedRuntimeFields.execution_target_id,
          backend_type: queuedDeployTarget || storedRuntimeFields.backend_type,
          sandbox_profile: sandbox || storedRuntimeFields.sandbox_profile,
        });
        assertProvisionerRuntimeSelection(resolvedRuntimeFields);
        resolvedBackend = resolvedRuntimeFields.backend_type;
        resolvedSandbox = resolvedRuntimeFields.sandbox_profile;
        provisioner = await loadBackend(resolvedRuntimeFields, {
          ownerUserId,
        });
      } catch (error) {
        const terminalError = toUnrecoverableRuntimeSelectionError(error);
        if (
          isRemoteHostAccessRevokedError(error) ||
          isUnrecoverableDeploymentError(terminalError)
        ) {
          await persistProvisioningFailure({
            queryable: db,
            job,
            agentId: id,
            name,
            error: terminalError,
            forceTerminal: true,
          });
        }
        throw terminalError;
      }
      const resolvedImage =
        image ||
        agentRow.image ||
        getDefaultAgentImage({
          runtime_family: resolvedRuntimeFields.runtime_family,
          deploy_target: resolvedRuntimeFields.deploy_target,
          sandbox_profile: resolvedSandbox,
          backend: resolvedBackend,
        });
      let templatePayload = agentRow.template_payload || {};
      if (typeof templatePayload === "string") {
        try {
          templatePayload = JSON.parse(templatePayload);
        } catch {
          templatePayload = {};
        }
      }

      console.log(
        `Processing deployment job ${job.id}: agent=${id} name=${name} backend=${resolvedBackend} (${vcpu}vCPU/${ram_mb}MB/${disk_gb}GB)`,
      );
      await markDeploymentLifecycle(db, id, "deploying");
      try {
        await prepareReplacementRuntime({
          queryable: db,
          agentId: id,
          agentRow,
          name,
          jobData: job.data,
          resolvedRuntimeFields,
          resolvedImage,
        });
      } catch (error) {
        if (isUnrecoverableDeploymentError(error) || error?.previousRuntimeDestroyed) {
          try {
            await persistProvisioningFailure({
              queryable: db,
              job,
              agentId: id,
              name,
              error,
              forceTerminal: true,
            });
          } catch (persistError) {
            error.persistenceError = persistError;
          }
        }
        throw error;
      }

      // Runtime creation is deliberately credential-neutral. Provider and
      // integration state is fetched again and staged only after the runtime is
      // reachable, while the shared mutation lock is held through finalization.
      const defaultLlmProvider = await fetchDeploymentProvider(ownerUserId, llmProviderId);
      const bootstrappedProviderFingerprint = null;
      const builtInDemoActivation = isBuiltInDemoActivation({
        jobId: job.id,
        agentId: id,
        llmProviderId,
        defaultProvider: defaultLlmProvider,
      });
      let agentSecretEnvVars = {};
      try {
        agentSecretEnvVars = normalizeEnvValueMap(await getAgentSecretEnvVars(id));
        if (Object.keys(agentSecretEnvVars).length > 0) {
          console.log(
            `[provisioner] Injecting ${Object.keys(agentSecretEnvVars).length} imported env override(s) for agent ${id}`,
          );
        }
      } catch (e) {
        console.warn(
          `[provisioner] Failed to fetch agent secret overrides for agent ${id}:`,
          e.message,
        );
      }

      const credentialManagedEnvNames = buildCredentialManagedEnvNames({
        runtimeFamily: resolvedRuntimeFields.runtime_family,
        mcpEnabledIds: agentRow.mcp_servers,
        preservedEnvNames: Object.keys(agentSecretEnvVars),
      });

      const configuredProvisionTimeout = parseTimeoutMs(process.env.PROVISION_TIMEOUT_MS, 840000);
      const jobTimeout = parseTimeoutMs(job?.opts?.timeout, 900000);
      const PROVISION_TIMEOUT = Math.min(
        configuredProvisionTimeout,
        Math.max(60000, jobTimeout - 60000),
      );

      let containerId,
        host,
        gatewayToken,
        containerName,
        gatewayHostPort,
        runtimeHost,
        runtimePort,
        gatewayHost,
        gatewayPort,
        networkPolicyStatus,
        dashboardPort;
      try {
        const abortController = new AbortController();
        let provisionTimeoutHandle = null;
        let runtimeIdentityPersisted = false;
        if (resolvedBackend === "k8s" && container_name) {
          containerId = container_name;
        }
        // Reserve a collision-safe published gateway port for docker / remote-docker
        // agents (k8s/proxmox manage their own ports). Idempotent per agent+host,
        // so redeploys keep the same port; released via ON DELETE CASCADE.
        let allocatedGatewayPort;
        let allocatedRuntimePort;
        let allocatedDashboardPort;
        const deployTarget = resolvedRuntimeFields.deploy_target;
        const allocationHostKey =
          deployTarget === "remote-docker"
            ? String(resolvedRuntimeFields.execution_target_id || "")
                .trim()
                .toLowerCase() || null
            : deployTarget === "docker"
              ? LOCAL_HOST_KEY
              : null;
        const usesLocalDockerPublishedPort = deployTarget === "docker";
        if (allocationHostKey) {
          const unavailableGatewayPorts = usesLocalDockerPublishedPort
            ? await getOccupiedDockerPublishedPorts(provisioner, { agentId: id })
            : new Set();
          allocatedGatewayPort = await allocateGatewayPort({
            hostKey: allocationHostKey,
            agentId: id,
            unavailablePorts: unavailableGatewayPorts,
          });
          // Hermes needs a SECOND published host port for its dashboard UI
          // (9119), distinct from the runtime API port (8642 = the 'gateway'
          // slot used for the readiness probe). Remote publishes it on the
          // remote host; local Docker publishes it on DOCKER_AGENT_BIND_IP so
          // the embedded WebUI is reachable by external clients too.
          if (
            (deployTarget === "remote-docker" || deployTarget === "docker") &&
            resolvedRuntimeFields.runtime_family === "hermes"
          ) {
            allocatedDashboardPort = await allocateGatewayPort({
              hostKey: allocationHostKey,
              agentId: id,
              purpose: DASHBOARD_PORT_PURPOSE,
            });
            // Local Docker (unlike remote) shares the host with the control
            // plane, so also exclude already-bound host ports outside Nora's
            // allocation table before handing the port to create().
            if (
              deployTarget === "docker" &&
              typeof provisioner?.isHostPortBound === "function" &&
              (await provisioner.isHostPortBound(allocatedDashboardPort, {
                ignoreContainerName: container_name,
              }))
            ) {
              console.warn(
                `[provisioner] Dashboard host port ${allocatedDashboardPort} already bound; reallocating for agent ${id}`,
              );
              allocatedDashboardPort = await reallocateGatewayPort({
                hostKey: allocationHostKey,
                agentId: id,
                previousPort: allocatedDashboardPort,
                purpose: DASHBOARD_PORT_PURPOSE,
              });
            }
          }
          if (
            deployTarget === "remote-docker" &&
            resolvedRuntimeFields.runtime_family === "openclaw"
          ) {
            allocatedRuntimePort = await allocateGatewayPort({
              hostKey: allocationHostKey,
              agentId: id,
              purpose: RUNTIME_PORT_PURPOSE,
            });
          }
        }
        const currentAgent = await db.query("SELECT status FROM agents WHERE id = $1", [id]);
        if (!currentAgent.rows[0]) {
          console.warn(
            `[provisioner] Canceling deployment job ${job.id}; agent ${id} was deleted before create`,
          );
          return { canceled: true, reason: "agent-deleted-before-create" };
        }
        await assertWorkerRemoteHostUse(resolvedRuntimeFields, ownerUserId, {
          includeProfile: false,
        });
        const onRuntimeIdentity = async (identity = {}) => {
          const createdContainerId = String(identity.containerId || "").trim();
          if (!createdContainerId) {
            throw new Error("Provisioner reported an empty runtime identity");
          }
          containerId = createdContainerId;
          containerName = identity.containerName || containerName || container_name;
          const persisted = await persistProvisionedRuntimeIdentity({
            queryable: db,
            agentId: id,
            containerId,
            containerName: containerName || null,
          });
          if (!persisted.persisted) {
            const identityError = new Error(
              `Agent ${id} was deleted or already references another runtime while ${containerId} was being created`,
            );
            identityError.code = "RUNTIME_IDENTITY_PERSIST_FAILED";
            identityError.containerId = containerId;
            throw identityError;
          }
          runtimeIdentityPersisted = true;
        };
        const createOnce = (gatewayHostPort) =>
          provisioner.create({
            id,
            name,
            image: resolvedImage,
            vcpu,
            ram_mb,
            disk_gb,
            container_name,
            gatewayHostPort,
            runtimeHostPort: allocatedRuntimePort,
            dashboardHostPort: allocatedDashboardPort,
            gatewayToken: agentRow.gateway_token || undefined,
            templatePayload,
            credentialManagedEnvNames,
            runtimeFamily: resolvedRuntimeFields.runtime_family,
            deployTarget: resolvedRuntimeFields.deploy_target,
            executionTargetId: resolvedRuntimeFields.execution_target_id,
            sandboxProfile: resolvedRuntimeFields.sandbox_profile,
            abortSignal: abortController.signal,
            onRuntimeIdentity,
            env: {
              AGENT_ID: String(id),
              AGENT_NAME: name || "",
              NORA_INTEGRATIONS_CONFIG:
                resolvedRuntimeFields.runtime_family === "hermes"
                  ? HERMES_INTEGRATIONS_CONFIG_FILE
                  : NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
              NORA_INTEGRATIONS_DIR:
                resolvedRuntimeFields.runtime_family === "hermes"
                  ? HERMES_INTEGRATIONS_DIR
                  : NORA_SYNC_INTEGRATIONS_DIR,
              ...(resolvedRuntimeFields.sandbox_profile === "nemoclaw" && model
                ? { NEMOCLAW_MODEL: model }
                : {}),
              ...agentSecretEnvVars,
            },
          });
        const createPromise = usesLocalDockerPublishedPort
          ? createWithDockerPortRetry({
              create: createOnce,
              initialPort: allocatedGatewayPort,
              getOccupiedPorts: () => getOccupiedDockerPublishedPorts(provisioner, { agentId: id }),
              reallocate: async ({ previousPort, unavailablePorts }) => {
                allocatedGatewayPort = await reallocateGatewayPort({
                  hostKey: allocationHostKey,
                  agentId: id,
                  previousPort,
                  unavailablePorts,
                });
                return allocatedGatewayPort;
              },
              onRetry: ({ retry, previousPort, nextPort }) => {
                console.warn(
                  `[provisioner] Docker port ${previousPort} was unavailable for agent ${id}; retry ${retry} will use persisted port ${nextPort}`,
                );
              },
            })
          : createOnce(allocatedGatewayPort);
        const timeoutPromise = new Promise((_, reject) => {
          provisionTimeoutHandle = setTimeout(() => {
            const timeoutError = new Error(
              `Provisioner create() timed out after ${PROVISION_TIMEOUT / 1000}s`,
            );
            abortController.abort(timeoutError);
            reject(timeoutError);
          }, PROVISION_TIMEOUT);
        });
        const result = await Promise.race([createPromise, timeoutPromise]).finally(() => {
          if (provisionTimeoutHandle) {
            clearTimeout(provisionTimeoutHandle);
          }
        });
        containerId = result.containerId;
        host = result.host;
        gatewayToken = result.gatewayToken;
        containerName = result.containerName || container_name;
        gatewayHostPort = result.gatewayHostPort || null;
        runtimeHost = result.runtimeHost || null;
        runtimePort = result.runtimePort || null;
        gatewayHost = result.gatewayHost || null;
        gatewayPort = result.gatewayPort || null;
        networkPolicyStatus =
          result.policyStatus ||
          result.policyBundleAttempted !== undefined ||
          result.policyBundleApplied !== undefined ||
          result.policyIssue !== undefined
            ? {
                policyStatus: result.policyStatus || null,
                policyBundleAttempted:
                  result.policyBundleAttempted === undefined
                    ? null
                    : Boolean(result.policyBundleAttempted),
                policyBundleApplied:
                  result.policyBundleApplied === undefined
                    ? null
                    : Boolean(result.policyBundleApplied),
                policyIssue: result.policyIssue || null,
              }
            : null;
        dashboardPort = result.dashboardPort || null;

        // The host grant may change while the external Docker create call is
        // in flight. Re-check after capturing the returned identity so failure
        // enters the normal cleanup path and no replacement retry is created.
        await assertWorkerRemoteHostUse(resolvedRuntimeFields, ownerUserId, {
          includeProfile: false,
        });

        // Persist container_id immediately so that if the worker crashes or the
        // final status UPDATE fails below, the container can still be located
        // and cleaned up by the failure catch, a reconciler, or a retry. Without
        // this, a crash between create() and the final UPDATE leaves an orphan
        // container that no DB row references.
        if (containerId && !runtimeIdentityPersisted) {
          try {
            const persistedContainer = await persistProvisionedRuntimeIdentity({
              queryable: db,
              agentId: id,
              containerId,
              containerName: containerName || null,
            });
            if (!persistedContainer.persisted) {
              console.warn(
                `[provisioner] Agent ${id} was deleted during create; removing runtime ${containerId}`,
              );
              return cleanupCanceledProvisionedRuntime({
                queryable: db,
                provisioner,
                agentId: id,
                containerId,
                reason: "agent-deleted-during-create",
              });
            }
          } catch (e) {
            console.error(
              `[provisioner] Failed to persist container_id for agent ${id} (will still attempt final update): ${e.message}`,
            );
          }
        }

        // If network discovery failed, host may be "localhost" which is unreachable
        // from backend-api. Attempt to resolve the correct Compose network IP.
        if (host === "localhost" && containerId) {
          try {
            const Docker = require("dockerode");
            const docker = new Docker({ socketPath: "/var/run/docker.sock" });
            const info = await docker.getContainer(containerId).inspect();
            const nets = info.NetworkSettings?.Networks || {};
            for (const [netName, netInfo] of Object.entries(nets)) {
              if (netName.endsWith("_default") && netInfo.IPAddress) {
                host = netInfo.IPAddress;
                console.log(
                  `[provisioner] Resolved host via container inspect: ${host} (${netName})`,
                );
                break;
              }
            }
          } catch (e) {
            console.warn(
              `[provisioner] Failed to resolve host from container networks: ${e.message}`,
            );
          }
          // Last resort: use container name (Docker DNS resolves it on the compose network)
          if (host === "localhost" && containerName) {
            host = containerName;
            console.log(`[provisioner] Falling back to container name as host: ${host}`);
          }
        }
        if (!runtimeHost || runtimeHost === "localhost") {
          runtimeHost = host;
        }

        if (resolvedRuntimeFields.runtime_family === "hermes") {
          const persistedHermesState = await getPersistedHermesState(id).catch(() => ({
            modelConfig: {},
            channels: [],
          }));

          await seedHermesArchiveForDeployment({
            agentId: id,
            provisioner,
            containerId,
          });

          if (
            hasMeaningfulHermesModelConfig(persistedHermesState?.modelConfig) ||
            (persistedHermesState?.channels || []).length > 0
          ) {
            await applyPersistedHermesState(
              {
                id,
                user_id: ownerUserId,
                container_id: containerId,
                container_name: containerName || container_name || null,
                image: resolvedImage,
                backend_type: resolvedBackend,
                runtime_family: "hermes",
                deploy_target: resolvedRuntimeFields.deploy_target,
                execution_target_id: resolvedRuntimeFields.execution_target_id,
                sandbox_profile: resolvedRuntimeFields.sandbox_profile,
                sandbox_type: resolvedRuntimeFields.sandbox_type,
                host,
                runtime_host: runtimeHost,
                runtime_port: runtimePort,
                gateway_host_port: gatewayHostPort,
                gateway_host: gatewayHost,
                gateway_port: gatewayPort,
                gateway_token: gatewayToken,
                dashboard_port: dashboardPort,
              },
              persistedHermesState,
              { restart: true },
            );
          }
        }
      } catch (err) {
        if (isCanceledRuntimeCleanupFailure(err)) throw err;
        console.error(
          `[${resolvedBackend}] Provisioning failed for agent ${id} (attempt ${job.attemptsMade + 1}/${job.opts?.attempts || 1}):`,
          err.message,
        );
        const cleanup = await reconcileProvisioningFailureRuntime({
          queryable: db,
          provisioner,
          agentId: id,
          containerId,
          error: err,
        });
        if (!cleanup.retrySafe) {
          const unresolved = await failDeploymentForUnresolvedRuntime({
            queryable: db,
            job,
            agentId: id,
            name,
            containerId: cleanup.containerId,
            error: cleanup.error || err,
          });
          if (unresolved.canceled) return unresolved;
        }
        const failure = await persistProvisioningFailure({
          queryable: db,
          job,
          agentId: id,
          name,
          error: err,
          forceTerminal: isRemoteHostRevocation(err) || isUnrecoverableDeploymentError(err),
        });
        if (failure.canceled) {
          console.warn(
            `[provisioner] Suppressing retry for deployment job ${job.id}; agent ${id} was deleted`,
          );
          return { canceled: true, reason: "agent-deleted-after-failure" };
        }
        if (isRemoteHostRevocation(err)) {
          throw toUnrecoverableRemoteHostRevocation(err);
        }
        throw err;
      }

      // Update agent with real container info. gateway_token is encrypted at
      // rest (no-op when ENCRYPTION_KEY is unset); the in-memory gatewayToken
      // stays plaintext for the integration-sync auth call below.
      const { encrypt } = require("./crypto");
      const gatewayTokenForStorage = gatewayToken ? encrypt(gatewayToken) : gatewayToken;
      try {
        const metadataPersistence = await persistProvisionedRuntimeMetadata(db, {
          agentId: id,
          containerId,
          host,
          backendType: resolvedRuntimeFields.backend_type,
          gatewayToken: gatewayTokenForStorage,
          containerName,
          gatewayHostPort,
          runtimeHost,
          runtimePort,
          gatewayHost,
          gatewayPort,
          image: resolvedImage,
          runtimeFamily: resolvedRuntimeFields.runtime_family,
          deployTarget: resolvedRuntimeFields.deploy_target,
          executionTargetId: resolvedRuntimeFields.execution_target_id,
          sandboxProfile: resolvedRuntimeFields.sandbox_profile,
          sandboxType: resolvedRuntimeFields.sandbox_type,
          networkPolicyStatus,
          dashboardPort,
        });
        if (!metadataPersistence.persisted) {
          console.warn(
            `[provisioner] Agent ${id} was deleted or replaced before runtime metadata persistence; removing runtime ${containerId}`,
          );
          return cleanupCanceledProvisionedRuntime({
            queryable: db,
            provisioner,
            agentId: id,
            containerId,
            reason: "agent-deleted-before-metadata-persistence",
          });
        }

        // Keep the durable lifecycle in `deploying` until the first readiness
        // check and any credential-drift restart have both settled. Gateway
        // routes reject `deploying`, so operators cannot race the restart with
        // their first chat request.
        const readinessBarrier = await runProvisioningReadinessBarrier({
          checkReadiness: () =>
            waitForAgentReadiness(
              {
                host,
                runtimeHost,
                runtimePort,
                gatewayHost,
                gatewayHostPort,
                gatewayPort,
                checkGateway: resolvedRuntimeFields.runtime_family !== "hermes",
              },
              {
                beforeAttempt: () => assertProvisionerAuthorized(provisioner),
              },
            ),
          failClosedOnReadinessFailure: true,
          reconcileAuth: ownerUserId
            ? () =>
                reconcileRuntimeLlmAuth({
                  agentId: id,
                  userId: ownerUserId,
                  llmProviderId,
                  runtimeFamily: resolvedRuntimeFields.runtime_family,
                  resolvedBackend,
                  containerId,
                  provisioner,
                  host,
                  runtimeHost,
                  runtimePort,
                  gatewayHostPort,
                  gatewayHost,
                  gatewayPort,
                  gatewayToken,
                  bootstrappedProviderFingerprint,
                  preservedEnvNames: Object.keys(agentSecretEnvVars),
                })
            : null,
          reconcileAndFinalize: ownerUserId
            ? () =>
                reconcileProviderStateUntilStable({
                  bootstrappedFingerprint: bootstrappedProviderFingerprint,
                  reconcile: (appliedFingerprint) =>
                    reconcileRuntimeLlmAuth({
                      agentId: id,
                      userId: ownerUserId,
                      llmProviderId,
                      runtimeFamily: resolvedRuntimeFields.runtime_family,
                      resolvedBackend,
                      containerId,
                      provisioner,
                      host,
                      runtimeHost,
                      runtimePort,
                      gatewayHostPort,
                      gatewayHost,
                      gatewayPort,
                      gatewayToken,
                      bootstrappedProviderFingerprint: appliedFingerprint,
                      preservedEnvNames: Object.keys(agentSecretEnvVars),
                    }),
                  verify: builtInDemoActivation
                    ? async () => {
                        await runDemoActivationCanary({
                          agentId: id,
                          execute: (command, options) =>
                            runProvisionerExecCommand(provisioner, containerId, command, options),
                          onCleanupFailure: ({ error }) => {
                            console.warn(
                              `[provisioner] Demo activation canary session cleanup failed for agent ${id}: ${error?.message || "unknown error"}`,
                            );
                          },
                        });
                        console.log(
                          `[provisioner] Demo activation Gateway canary passed for agent ${id}`,
                        );
                      }
                    : null,
                  readFingerprint: async () =>
                    (
                      await fetchEffectiveProviderState(ownerUserId, llmProviderId, id, {
                        runtimeFamily: resolvedRuntimeFields.runtime_family,
                      })
                    ).fingerprint,
                  withMutationLock: (operation) => withProviderMutationLock(ownerUserId, operation),
                  finalize: () =>
                    assertProvisionerAuthorized(provisioner).then(() =>
                      finalizeProvisionedDeployment(db, {
                        agentId: id,
                        containerId,
                        name,
                        backend: resolvedBackend,
                        host,
                      }),
                    ),
                })
            : null,
          finalize: () =>
            assertProvisionerAuthorized(provisioner).then(() =>
              finalizeProvisionedDeployment(db, {
                agentId: id,
                containerId,
                name,
                backend: resolvedBackend,
                host,
              }),
            ),
        });
        const { readiness } = readinessBarrier;
        if (readinessBarrier.status === "canceled") {
          console.warn(
            `[provisioner] Agent ${id} was deleted or its runtime changed before readiness finalization; removing runtime ${containerId}`,
          );
          return cleanupCanceledProvisionedRuntime({
            queryable: db,
            provisioner,
            agentId: id,
            containerId,
            reason: "agent-deleted-before-readiness-finalization",
          });
        } else if (readinessBarrier.status === "running") {
          if (readinessBarrier.reconciliation?.status === "synced") {
            console.log(`[provisioner] Post-deploy LLM auth sync completed for agent ${id}`);
          } else if (readinessBarrier.reconciliation?.reason === "unchanged") {
            console.log(
              `[provisioner] Post-deploy LLM auth sync skipped for agent ${id}; bootstrap state is current`,
            );
          }
          console.log(`Agent ${id} deployed: containerId=${containerId} host=${host}`);
        }

        // Reseed persisted channel config before skills/integrations so a
        // redeploy comes back with its Telegram/Slack/Discord channels wired.
        if (
          !builtInDemoActivation &&
          resolvedRuntimeFields.runtime_family === "openclaw" &&
          readiness.ok
        ) {
          try {
            const channelSeed = await reconcileOpenClawChannelState({
              agentId: id,
              resolvedBackend,
              containerId,
              provisioner,
              host,
              runtimeHost,
              runtimePort,
              gatewayToken,
            });
            if (channelSeed.status === "synced") {
              console.log(
                `[provisioner] Reseeded ${channelSeed.channels} OpenClaw channel config(s) for agent ${id}`,
              );
            }
          } catch (e) {
            throwIfRemoteAuthorizationFailure(e);
            console.warn(
              `[provisioner] Failed to reseed OpenClaw channel config for agent ${id}:`,
              e.message,
            );
          }
        }

        if (
          !builtInDemoActivation &&
          resolvedRuntimeFields.runtime_family === "openclaw" &&
          containerId
        ) {
          try {
            await reconcileClawhubSkills({
              agentId: id,
              containerId,
              provisioner,
            });
          } catch (e) {
            throwIfRemoteAuthorizationFailure(e);
            console.warn(
              `[provisioner] Failed to reconcile saved ClawHub skills for agent ${id}:`,
              e.message,
            );
          }
        }
      } catch (err) {
        if (isCanceledRuntimeCleanupFailure(err)) throw err;
        console.error("Failed to finalize provisioned runtime:", err.message);
        const cleanup = await reconcileProvisioningFailureRuntime({
          queryable: db,
          provisioner,
          agentId: id,
          containerId,
          error: err,
        });
        if (!cleanup.retrySafe) {
          const unresolved = await failDeploymentForUnresolvedRuntime({
            queryable: db,
            job,
            agentId: id,
            name,
            containerId: cleanup.containerId,
            error: cleanup.error || err,
          });
          if (unresolved.canceled) return unresolved;
        }
        const failure = await persistProvisioningFailure({
          queryable: db,
          job,
          agentId: id,
          name,
          error: err,
          forceTerminal: isRemoteHostRevocation(err) || isUnrecoverableDeploymentError(err),
        });
        if (failure.canceled) {
          return { canceled: true, reason: "agent-deleted-after-persistence-failure" };
        }
        if (isRemoteHostRevocation(err)) {
          throw toUnrecoverableRemoteHostRevocation(err);
        }
        throw err;
      }
    } finally {
      await provisionLock.release();
    }
  },
  { connection, concurrency: DEPLOYMENT_WORKER_CONCURRENCY },
);

worker.on("failed", async (job, err) => {
  const attempts = job?.attemptsMade || 0;
  const maxAttempts = job?.opts?.attempts || 1;
  const unrecoverable = isUnrecoverableDeploymentError(err);
  console.error(`Job ${job?.id} failed (attempt ${attempts}/${maxAttempts}): ${err.message}`);

  if (job && (attempts >= maxAttempts || unrecoverable)) {
    // Final failure — either retries were exhausted or BullMQ suppressed them
    // because the failure is explicitly unrecoverable.
    console.error(
      unrecoverable
        ? `[DLQ] Agent "${job.data.name}" (${job.data.id}) failed unrecoverably`
        : `[DLQ] Agent "${job.data.name}" (${job.data.id}) exhausted all ${maxAttempts} retry attempts`,
    );
    try {
      // Terminal: without this, a job that died after the container was
      // created (e.g. the final status UPDATE failed) leaves the agent in
      // 'deploying' forever — the background reconciler deliberately skips
      // queued/deploying rows, so nothing else can ever move it.
      await db.query("UPDATE agents SET status = 'error' WHERE id = $1 AND status = 'deploying'", [
        job.data.id,
      ]);
      await db.query(
        "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status IN ('queued', 'deploying')",
        [job.data.id],
      );
      await db.query("INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)", [
        "agent_deploy_dlq",
        unrecoverable
          ? `Agent "${job.data.name}" failed unrecoverably`
          : `Agent "${job.data.name}" exhausted all ${maxAttempts} retry attempts`,
        JSON.stringify({
          agentId: job.data.id,
          error: err.message,
          jobId: job.id,
          ...(unrecoverable ? { retrySuppressed: true } : {}),
        }),
      ]);
    } catch (dbErr) {
      console.error("[DLQ] Failed to log DLQ event:", dbErr.message);
    }
  }
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

const clawhubJobsWorker = new Worker(
  "clawhub-jobs",
  async (job) => {
    const {
      agentId,
      slug,
      operation = "install",
      skillEntry,
      persistOnSuccess = true,
      removeSavedEntryOnSuccess = true,
    } = job.data || {};
    const normalizedSlug = String(slug || "").trim();
    const normalizedOperation = String(operation || "").trim() || "install";
    if (!agentId || !normalizedSlug) {
      throw new Error("ClawHub job is missing agentId or slug");
    }
    if (!["install", "delete"].includes(normalizedOperation)) {
      throw new Error(`Unsupported ClawHub operation: ${normalizedOperation}`);
    }

    const logJob = createClawhubSkillJobLogger({
      jobId: job.id,
      agentId,
      slug: normalizedSlug,
      operation: normalizedOperation,
    });
    const agent = await loadClawhubJobAgent(agentId);
    const provisioner = await loadBackend(buildAgentRuntimeFields(agent), {
      ownerUserId: agent.user_id,
    });

    logJob("start", `Starting ${normalizedOperation} job`);

    const result =
      normalizedOperation === "install"
        ? await runClawhubInstallJob({
            agentId,
            slug: normalizedSlug,
            skillEntry,
            persistOnSuccess,
            provisioner,
            containerId: agent.container_id,
            logJob,
          })
        : await runClawhubDeleteJob({
            agentId,
            slug: normalizedSlug,
            skillEntry,
            removeSavedEntryOnSuccess,
            provisioner,
            containerId: agent.container_id,
            logJob,
          });

    logJob("done", `${normalizedOperation} job completed successfully`);
    return result;
  },
  {
    connection,
    concurrency: 1,
    lockDuration: CLAWHUB_INSTALL_LOCK_DURATION_MS,
    lockRenewTime: CLAWHUB_INSTALL_LOCK_RENEW_MS,
    stalledInterval: 30000,
    maxStalledCount: 1,
  },
);

clawhubJobsWorker.on("failed", (job, err) => {
  console.error(
    `[clawhub-jobs] operation=${job?.data?.operation || "unknown"} job=${job?.id} failed: ${err.message}`,
  );
});

clawhubJobsWorker.on("completed", (job) => {
  console.log(
    `[clawhub-jobs] operation=${job?.data?.operation || "unknown"} job=${job.id} completed successfully`,
  );
});

const k8sPolicySettingsWorker = new Worker(
  "k8s-policy-settings",
  async (job) => {
    const clusterId = String(job?.data?.clusterId || "").trim();
    if (!clusterId) {
      throw new Error("Kubernetes policy reconcile job is missing clusterId");
    }
    console.log(
      `[k8s-policy-settings] Starting reconcile for cluster ${clusterId} (job ${job.id})`,
    );
    const result = await runKubernetesPolicyReconcileJob({ clusterId });
    console.log(
      `[k8s-policy-settings] Reconcile completed for cluster ${clusterId} (${result.state || "skipped"})`,
    );
    return result;
  },
  {
    connection,
    concurrency: K8S_POLICY_RECONCILE_CONCURRENCY,
  },
);

k8sPolicySettingsWorker.on("failed", (job, err) => {
  console.error(
    `[k8s-policy-settings] job=${job?.id} cluster=${job?.data?.clusterId || "unknown"} failed: ${err.message}`,
  );
});

k8sPolicySettingsWorker.on("completed", (job) => {
  console.log(
    `[k8s-policy-settings] job=${job?.id} cluster=${job?.data?.clusterId || "unknown"} completed successfully`,
  );
});

// ── Alert Delivery Worker ────────────────────────────────────────
// Each job is one (rule, webhook channel) pair. runAlertDeliveryJob throws
// on non-2xx so BullMQ retries with exponential backoff (configured on the
// queue). When attemptsMade hits the configured limit, recordDeliveryFailure
// updates the rule's last_error.
const { runAlertDeliveryJob, recordDeliveryFailure } = require("../../backend-api/alertRules");
const { ALERT_DELIVERY_ATTEMPTS } = require("../../backend-api/redisQueue");
const ALERT_DELIVERY_CONCURRENCY = parsePositiveInteger(
  process.env.ALERT_DELIVERY_WORKER_CONCURRENCY,
  5,
);

const alertDeliveryWorker = new Worker(
  "alert-deliveries",
  async (job) => runAlertDeliveryJob(job.data),
  { connection, concurrency: ALERT_DELIVERY_CONCURRENCY },
);

alertDeliveryWorker.on("failed", async (job, err) => {
  if (!job) return;
  const attemptsMade = job.attemptsMade || 0;
  const maxAttempts = job.opts?.attempts || ALERT_DELIVERY_ATTEMPTS;
  const terminal = attemptsMade >= maxAttempts;
  console.error(
    `[alert-deliveries] Job ${job.id} attempt ${attemptsMade}/${maxAttempts} failed: ${err.message}`,
  );
  if (terminal && job.data?.ruleId) {
    try {
      await recordDeliveryFailure(job.data.ruleId, `webhook:${err.message}`);
    } catch (recordErr) {
      console.error(
        `[alert-deliveries] Failed to record terminal delivery failure: ${recordErr.message}`,
      );
    }
  }
});

alertDeliveryWorker.on("completed", (job) => {
  console.log(`[alert-deliveries] Job ${job.id} delivered`);
});

// ── Scheduled Agent Run Worker ───────────────────────────────────
// The backend sweep enqueues one job per due schedule; runScheduledAction
// (backend-api) executes the prompt/lifecycle action against the agent. It
// throws on failure so BullMQ applies the queue's bounded retry.
const { runScheduledAction } = require("../../backend-api/scheduleRunner");
const SCHEDULE_RUN_CONCURRENCY = parsePositiveInteger(
  process.env.SCHEDULE_RUN_WORKER_CONCURRENCY,
  5,
);

const scheduleRunWorker = new Worker(
  "agent-schedules",
  async (job) => runScheduledAction(job.data),
  { connection, concurrency: SCHEDULE_RUN_CONCURRENCY },
);

scheduleRunWorker.on("failed", (job, err) => {
  if (!job) return;
  const attemptsMade = job.attemptsMade || 0;
  const maxAttempts = job.opts?.attempts || 2;
  console.error(
    `[agent-schedules] Job ${job.id} (schedule ${job.data?.scheduleId}) attempt ${attemptsMade}/${maxAttempts} failed: ${err.message}`,
  );
});

scheduleRunWorker.on("completed", (job) => {
  console.log(
    `[agent-schedules] Job ${job.id} ran (${job.data?.actionType} on agent ${job.data?.agentId})`,
  );
});

// ── Health Check Server ──────────────────────────────────────────
const http = require("http");
const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "4001");
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    const isReady =
      worker.isRunning() &&
      clawhubJobsWorker.isRunning() &&
      alertDeliveryWorker.isRunning() &&
      k8sPolicySettingsWorker.isRunning() &&
      scheduleRunWorker.isRunning();
    res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: isReady ? "ok" : "not_ready", uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(HEALTH_PORT, () => {
  console.log(`Worker health check listening on port ${HEALTH_PORT}`);
});

module.exports = {
  allocateAvailableLocalDockerGatewayPort,
  assertProvisionerRuntimeSelection,
  buildProvisionerExecCleanupCommand,
  buildTrackedProvisionerCommand,
  buildUnresolvedRuntimeError,
  cleanupProvisionedRuntimeAfterFailure,
  failDeploymentForUnresolvedRuntime,
  fetchDeploymentProvider,
  fetchWithProvisionerAuthorization,
  fetchUserLlmEnvVars,
  guardRemoteProvisioner,
  isRemoteAuthorizationFailure,
  isFinalDeploymentAttempt,
  loadBackend,
  normalizeProvisionerDeployTarget,
  normalizeProvisionerExecutionTargetId,
  persistProvisionedRuntimeIdentity,
  persistProvisioningFailure,
  prepareReplacementRuntime,
  provisionerExecStateDir,
  reconcileProvisioningFailureRuntime,
  resolveCanonicalDeploymentOwnerUserId,
  runRuntimeCommand,
  runProvisionerExecCommand,
  seedHermesArchiveForDeployment,
  toUnrecoverableRuntimeSelectionError,
};
