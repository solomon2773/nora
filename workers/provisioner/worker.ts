// @ts-nocheck
const { UnrecoverableError, Worker } = require("bullmq");
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
const { getRemoteHostProfile } = require("../../backend-api/remoteHosts");
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
const {
  buildIntegrationSyncEntry,
  decryptSensitiveConfig,
} = require("../../backend-api/integrations");
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
  buildOpenClawDefaultModelCommand,
  buildOpenClawModelForProvider,
} = require("../../agent-runtime/lib/runtimeBootstrap");
const {
  buildHermesRuntimeBootstrapEnv,
} = require("../../agent-runtime/lib/hermesRuntimeBootstrap");
const { waitForAgentReadiness } = require("./healthChecks");
const { buildReadinessWarningDetail, persistReadinessWarning } = require("./readinessWarning");
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
  const terminal = forceTerminal || isFinalDeploymentAttempt(job);
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
      ...(forceTerminal ? { retrySuppressed: true } : {}),
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
  // Bare deployment name — buildDefaultModelCommand prefixes it with the
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
  return buildOpenClawAuthProfilesWriteCommand(authProfiles);
}

function buildDefaultModelCommand(defaultProvider = null) {
  const fullModel = buildDefaultOpenClawModel(defaultProvider);
  if (!fullModel) return null;

  return buildOpenClawDefaultModelCommand(fullModel);
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

async function fetchEffectiveProviderState(userId, providerId = null) {
  const [envVars, defaultProvider] = await Promise.all([
    fetchUserLlmEnvVars(userId, providerId),
    fetchDeploymentProvider(userId, providerId),
  ]);
  return {
    envVars,
    defaultProvider,
    fingerprint: fingerprintEffectiveProviderState({ envVars, defaultProvider }),
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

async function runRuntimeCommand(agent, command, { timeout = 30000 } = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("Agent runtime endpoint unavailable");
  }

  // gateway_token is encrypted at rest; decrypt() is transparent to legacy
  // plaintext, so it is safe whether the agent row was freshly selected
  // (encrypted) or carries an in-memory plaintext token.
  const { decrypt } = require("./crypto");
  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildRuntimeAuthHeaders(
        agent && agent.gateway_token ? decrypt(agent.gateway_token) : null,
      ),
    },
    body: JSON.stringify({
      command,
      timeout,
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `Runtime command failed with HTTP ${response.status}`);
  }

  if ((payload.exitCode || 0) !== 0) {
    throw new Error(
      payload.stderr || payload.stdout || `Runtime command exited with code ${payload.exitCode}`,
    );
  }

  return payload;
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

/**
 * Execute a shell command inside an already-running runtime container.
 *
 * This is the lowest-level provisioner exec helper used by ClawHub flows and
 * other runtime repair paths. Callers must shell-escape any interpolated
 * user-controlled values because `command` is executed via `/bin/sh -lc ...`,
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
  const execResult = await provisioner.exec(containerId, {
    cmd: ["/bin/sh", "-lc", command],
    tty,
    env,
    ...(agentId ? { agentId } : {}),
  });
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error("Container exec unavailable");
  }

  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    const state = { totalBytes: 0 };
    let settled = false;
    let inspectInterval = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (inspectInterval) clearInterval(inspectInterval);
      try {
        execResult.stream.destroy();
      } catch {
        // Ignore stream teardown failures.
      }
      reject(new Error(`Container command timed out after ${timeout}ms`));
    }, timeout);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inspectInterval) clearInterval(inspectInterval);
      resolve(sanitizeExecOutput(Buffer.concat(chunks).toString("utf8")));
    };

    execResult.stream.on("data", (chunk) => {
      appendChunkTail(chunks, chunk, state, maxOutputBytes);
    });
    execResult.stream.on("end", finish);
    execResult.stream.on("close", finish);
    execResult.stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inspectInterval) clearInterval(inspectInterval);
      reject(error);
    });

    inspectInterval = setInterval(async () => {
      if (settled) return;
      try {
        const status = await execResult.exec.inspect();
        if (status && status.Running === false && status.ExitCode != null) {
          finish();
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (inspectInterval) clearInterval(inspectInterval);
        reject(error);
      }
    }, 500);
  });

  const inspectResult = await execResult.exec.inspect();
  const exitCode = inspectResult?.ExitCode ?? 0;
  if (exitCode === 124) {
    throw new Error(`Container command timed out after ${timeout}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(output.trim() || `Container command exited with code ${exitCode}`);
  }

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
 * @param {string} params.bootstrappedProviderFingerprint Canonical effective provider state injected before runtime creation.
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
} = {}) {
  const providerState = await fetchEffectiveProviderState(userId, llmProviderId);
  const { envVars: llmEnvVars, defaultProvider, fingerprint: providerFingerprint } = providerState;
  if (!shouldReconcileEffectiveProviderState(bootstrappedProviderFingerprint, providerState)) {
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

  if (resolvedBackend === "k8s") {
    if (typeof provisioner?.updateEnv !== "function") {
      throw new Error("Kubernetes provider reconciliation requires updateEnv support");
    }
    const managedEnv = buildKubernetesProviderEnv(runtimeFamily, defaultProvider, llmEnvVars);
    await provisioner.updateEnv(containerId, managedEnv, {
      agentId,
      runtimeFamily,
      managedEnvNames: getManagedProviderEnvNames({ runtimeFamily }),
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
  const modelCommand = buildDefaultModelCommand(defaultProvider);
  if (Object.keys(authProfiles).length === 0 && !modelCommand) {
    return { status: "skipped", providerFingerprint };
  }

  const authWriteCommand = buildAuthProfilesWriteCommand(authProfiles);
  const reconciliationMutations = [
    async () => {
      try {
        await runRuntimeCommand(agentRef, authWriteCommand);
      } catch (error) {
        if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) {
          throw error;
        }
        await runProvisionerExecCommand(provisioner, containerId, authWriteCommand, { agentId });
      }
    },
  ];

  // Merge custom-provider registrations (Microsoft Foundry) into openclaw.json
  // before the restart so model strings like `microsoft-foundry/<deployment>`
  // resolve instead of throwing "Unknown model" on first request.
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
  if (Object.keys(customProviders).length > 0) {
    const providerMergeCommand = buildOpenClawConfigMergeCommand({
      models: { providers: customProviders },
    });
    reconciliationMutations.push(async () => {
      try {
        await runRuntimeCommand(agentRef, providerMergeCommand);
      } catch (error) {
        if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) {
          throw error;
        }
        await runProvisionerExecCommand(provisioner, containerId, providerMergeCommand, {
          agentId,
        });
      }
    });
  }

  // Apply the default model inside the same reconciliation boundary. Readiness
  // must be the final runtime operation; otherwise the config watcher can reload
  // a gateway immediately after the worker publishes it as running.
  if (modelCommand) {
    reconciliationMutations.push(() =>
      runRuntimeCommand(agentRef, modelCommand, { timeout: 60000 }),
    );
  }

  const readiness = await runRuntimeReconciliationBoundary({
    mutations: reconciliationMutations,
    restart: () => provisioner.restart(containerId, { agentId }),
    checkReadiness: () =>
      waitForAgentReadiness({
        host,
        runtimeHost,
        runtimePort,
        gatewayHostPort,
        gatewayHost,
        gatewayPort,
      }),
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
  const backend = normalizeBackendName(
    runtimeFields.backend_type || runtimeFields.deploy_target || "docker",
  );
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

async function loadBackend(runtimeFields = {}) {
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
        const profile = await getRemoteHostProfile(executionTargetId);
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
        const profile = await getRemoteHostProfile(executionTargetId);
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
        const profile = await getRemoteHostProfile(key);
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
      console.warn(`Unknown backend "${key}", falling back to docker`);
      instance = new (require("./backends/docker"))();
      break;
  }

  backendInstances.set(key, instance);
  return instance;
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

function safeK8sName(name, fallback) {
  return (
    String(name || fallback || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63) || fallback
  );
}

function defaultK8sDeployName(runtimeFamily, id, name) {
  const prefix = runtimeFamily === "hermes" ? "nora-hermes" : "nora-oclaw";
  return safeK8sName(`${prefix}-${name || "agent"}-${id}`, `${prefix}-${id}`);
}

async function cleanupPreviousK8sRuntime({
  agentId,
  jobData = {},
  fallbackRuntimeFields = {},
} = {}) {
  const previousBackend = normalizeBackendName(
    jobData.previous_backend || jobData.previous_deploy_target || "",
  );
  if (previousBackend !== "k8s") return;

  const previousRuntimeFields = buildAgentRuntimeFields({
    runtime_family: jobData.previous_runtime_family || fallbackRuntimeFields.runtime_family,
    backend_type: "k8s",
    deploy_target: "k8s",
    execution_target_id:
      jobData.previous_execution_target_id || fallbackRuntimeFields.execution_target_id,
    sandbox_profile: jobData.previous_sandbox_profile || fallbackRuntimeFields.sandbox_profile,
  });
  const previousResourceName =
    jobData.previous_container_id ||
    jobData.previous_container_name ||
    defaultK8sDeployName(previousRuntimeFields.runtime_family, agentId, jobData.name);
  const previousProvisioner = await loadBackend(previousRuntimeFields);

  console.log(
    `[provisioner] Destroying previous Kubernetes runtime ${previousResourceName} before redeploying agent ${agentId}`,
  );
  await previousProvisioner.destroy(previousResourceName, {
    agentId,
    host: jobData.previous_host || null,
    runtimeFamily: previousRuntimeFields.runtime_family,
  });
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
    await runRuntimeCommand(agentRef, command);
  } catch (error) {
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
 * can prepend framing bytes that corrupt JSON reads. It retries a few times so
 * short lockfile propagation delays after install/delete do not look like hard
 * failures.
 *
 * @param {object} provisioner Backend-specific provisioner client with `exec`.
 * @param {string} containerId Runtime container identifier.
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
        const message = String(error?.message || "");
        console.warn(
          `${logPrefix} agent=${agentId} slug=${skill.slug} Reconciliation uninstall failed: ${message}`,
        );
      }
    }
  }
}

async function loadClawhubJobAgent(agentId) {
  const result = await db.query(
    `SELECT id, name, status, container_id, backend_type, runtime_family, deploy_target,
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
      userId,
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
            container_id
       FROM agents
      WHERE id = $1`,
        [id],
      );
      const agentRow = agentRowResult.rows[0];
      if (!agentRow) {
        console.warn(`[provisioner] Skipping deployment job ${job.id}; agent ${id} was deleted`);
        return { canceled: true, reason: "agent-deleted" };
      }
      if (!["queued", "deploying", "error"].includes(agentRow.status)) {
        console.warn(
          `[provisioner] Skipping deployment job ${job.id}; agent ${id} is ${agentRow.status}`,
        );
        return { canceled: true, reason: `agent-${agentRow.status}` };
      }
      if (agentRow.container_id) {
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
      const storedRuntimeFields = buildAgentRuntimeFields(agentRow);
      const resolvedRuntimeFields = buildAgentRuntimeFields({
        runtime_family: storedRuntimeFields.runtime_family,
        deploy_target: isKnownBackend(backend)
          ? normalizeBackendName(backend)
          : storedRuntimeFields.deploy_target,
        execution_target_id:
          job.data.execution_target_id || storedRuntimeFields.execution_target_id,
        backend_type: isKnownBackend(backend)
          ? normalizeBackendName(backend)
          : storedRuntimeFields.backend_type,
        sandbox_profile: sandbox || storedRuntimeFields.sandbox_profile,
      });
      const resolvedBackend = resolvedRuntimeFields.backend_type;
      const resolvedSandbox = resolvedRuntimeFields.sandbox_profile;
      const provisioner = await loadBackend(resolvedRuntimeFields);
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
      await cleanupPreviousK8sRuntime({
        agentId: id,
        jobData: job.data,
        fallbackRuntimeFields: resolvedRuntimeFields,
      });

      // Fetch user's LLM provider keys from DB for injection into container
      const bootstrappedProviderState = await fetchEffectiveProviderState(userId, llmProviderId);
      const {
        envVars: llmEnvVars,
        defaultProvider: defaultLlmProvider,
        fingerprint: bootstrappedProviderFingerprint,
      } = bootstrappedProviderState;
      const builtInDemoActivation = isBuiltInDemoActivation({
        jobId: job.id,
        agentId: id,
        llmProviderId,
        defaultProvider: defaultLlmProvider,
      });
      const defaultOpenClawModel = buildDefaultOpenClawModel(defaultLlmProvider);
      const hermesRuntimeBootstrapEnv =
        resolvedRuntimeFields.runtime_family === "hermes"
          ? buildHermesRuntimeBootstrapEnvFor(defaultLlmProvider, llmEnvVars)
          : {};
      if (Object.keys(llmEnvVars).length > 0) {
        console.log(
          `[provisioner] Injecting ${Object.keys(llmEnvVars).length} LLM provider key(s) for user ${userId}`,
        );
      }

      // Fetch integration credentials for this agent and inject as env vars into the container
      let integrationEnvVars = {};
      // Decrypted creds for providers the operator enabled as MCP servers, keyed
      // by provider — resolved into an openclaw.json mcpServers block below.
      const mcpIntegrationsByProvider = {};
      try {
        const INTEGRATION_ENV_MAP = {
          huggingface: "HF_TOKEN",
          github: "GITHUB_TOKEN",
          gitlab: "GITLAB_TOKEN",
          slack: "SLACK_TOKEN",
          discord: "DISCORD_TOKEN",
          notion: "NOTION_TOKEN",
          linear: "LINEAR_API_KEY",
          datadog: "DD_API_KEY",
          sentry: "SENTRY_AUTH_TOKEN",
          sendgrid: "SENDGRID_API_KEY",
          openai: "OPENAI_API_KEY",
          anthropic: "ANTHROPIC_API_KEY",
          airtable: "AIRTABLE_API_KEY",
          asana: "ASANA_TOKEN",
          stripe: "STRIPE_SECRET_KEY",
          hubspot: "HUBSPOT_ACCESS_TOKEN",
          pipedrive: "PIPEDRIVE_API_KEY",
          pinecone: "PINECONE_API_KEY",
          vercel: "VERCEL_TOKEN",
          circleci: "CIRCLE_TOKEN",
          terraform: "TFE_TOKEN",
          pagerduty: "PAGERDUTY_TOKEN",
          dropbox: "DROPBOX_ACCESS_TOKEN",
          twilio: "TWILIO_AUTH_TOKEN",
          shopify: "SHOPIFY_ACCESS_TOKEN",
          linkedin: "LINKEDIN_ACCESS_TOKEN",
          salesforce: "SALESFORCE_ACCESS_TOKEN",
          twitter: "TWITTER_ACCESS_TOKEN",
          digitalocean: "DIGITALOCEAN_TOKEN",
          algolia: "ALGOLIA_API_KEY",
          clickup: "CLICKUP_API_KEY",
          monday: "MONDAY_API_KEY",
          zendesk: "ZENDESK_API_TOKEN",
          "docker-hub": "DOCKER_HUB_TOKEN",
          bitbucket: "BITBUCKET_TOKEN",
          confluence: "CONFLUENCE_TOKEN",
          jira: "JIRA_API_TOKEN",
          jenkins: "JENKINS_TOKEN",
          grafana: "GRAFANA_TOKEN",
          woocommerce: "WOOCOMMERCE_SECRET_KEY",
          trello: "TRELLO_TOKEN",
          elasticsearch: "ELASTICSEARCH_PASSWORD",
          supabase: "SUPABASE_SERVICE_ROLE_KEY",
          facebook: "FACEBOOK_ACCESS_TOKEN",
          aws: "AWS_SECRET_ACCESS_KEY",
          azure: "AZURE_CLIENT_SECRET",
          s3: "S3_SECRET_ACCESS_KEY",
          mongodb: "MONGODB_URI",
          redis: "REDIS_PASSWORD",
          postgresql: "PGPASSWORD",
          paypal: "PAYPAL_CLIENT_SECRET",
          segment: "SEGMENT_WRITE_KEY",
          mixpanel: "MIXPANEL_API_SECRET",
          weaviate: "WEAVIATE_API_KEY",
          email: "SMTP_PASS",
        };
        const INTEGRATION_CONFIG_ENV_MAP = {
          "github.org": "GITHUB_ORG",
          "gitlab.base_url": "GITLAB_BASE_URL",
          "bitbucket.username": "BITBUCKET_USERNAME",
          "bitbucket.workspace": "BITBUCKET_WORKSPACE",
          "jira.email": "JIRA_EMAIL",
          "jira.site_url": "JIRA_BASE_URL",
          "jira.project_key": "JIRA_PROJECT_KEY",
          "linear.team_id": "LINEAR_TEAM_ID",
          "slack.default_channel": "SLACK_DEFAULT_CHANNEL",
          "discord.guild_id": "DISCORD_GUILD_ID",
          "teams.webhook_url": "TEAMS_WEBHOOK_URL",
          "email.smtp_host": "SMTP_HOST",
          "email.smtp_port": "SMTP_PORT",
          "email.smtp_user": "SMTP_USER",
          "email.from_address": "SMTP_FROM_ADDRESS",
          "twilio.account_sid": "TWILIO_ACCOUNT_SID",
          "twilio.phone_number": "TWILIO_PHONE_NUMBER",
          "sendgrid.from_email": "SENDGRID_FROM_EMAIL",
          "openai.org_id": "OPENAI_ORG_ID",
          "huggingface.model_id": "HF_DEFAULT_MODEL",
          "aws.access_key_id": "AWS_ACCESS_KEY_ID",
          "aws.region": "AWS_DEFAULT_REGION",
          "gcp.service_account_json": "GOOGLE_APPLICATION_CREDENTIALS_JSON",
          "gcp.project_id": "GCP_PROJECT_ID",
          "azure.tenant_id": "AZURE_TENANT_ID",
          "azure.client_id": "AZURE_CLIENT_ID",
          "s3.access_key_id": "S3_ACCESS_KEY_ID",
          "s3.region": "S3_REGION",
          "s3.bucket": "S3_BUCKET",
          "google-drive.service_account_json": "GOOGLE_DRIVE_SA_JSON",
          "google-drive.folder_id": "GOOGLE_DRIVE_FOLDER_ID",
          "postgresql.host": "PGHOST",
          "postgresql.port": "PGPORT",
          "postgresql.database": "PGDATABASE",
          "postgresql.user": "PGUSER",
          "mongodb.database": "MONGODB_DATABASE",
          "redis.host": "REDIS_HOST",
          "redis.port": "REDIS_PORT",
          "redis.password": "REDIS_PASSWORD",
          "supabase.url": "SUPABASE_URL",
          "firebase.service_account_json": "FIREBASE_SA_JSON",
          "firebase.database_url": "FIREBASE_DATABASE_URL",
          "elasticsearch.node_url": "ELASTICSEARCH_URL",
          "elasticsearch.username": "ELASTICSEARCH_USERNAME",
          "elasticsearch.password": "ELASTICSEARCH_PASSWORD",
          "elasticsearch.index": "ELASTICSEARCH_INDEX",
          "weaviate.host": "WEAVIATE_HOST",
          "weaviate.api_key": "WEAVIATE_API_KEY",
          "pinecone.environment": "PINECONE_ENVIRONMENT",
          "pinecone.index_name": "PINECONE_INDEX",
          "algolia.app_id": "ALGOLIA_APP_ID",
          "algolia.index_name": "ALGOLIA_INDEX",
          "datadog.app_key": "DD_APP_KEY",
          "datadog.site": "DD_SITE",
          "pagerduty.routing_key": "PAGERDUTY_ROUTING_KEY",
          "sentry.organization": "SENTRY_ORG",
          "sentry.project": "SENTRY_PROJECT",
          "grafana.url": "GRAFANA_URL",
          "jenkins.url": "JENKINS_URL",
          "jenkins.username": "JENKINS_USERNAME",
          "vercel.team_id": "VERCEL_TEAM_ID",
          "terraform.organization": "TF_ORGANIZATION",
          "kubernetes.kubeconfig": "KUBECONFIG_CONTENT",
          "kubernetes.context": "KUBE_CONTEXT",
          "notion.workspace_id": "NOTION_WORKSPACE_ID",
          "airtable.base_id": "AIRTABLE_BASE_ID",
          "trello.api_key": "TRELLO_API_KEY",
          "trello.board_id": "TRELLO_BOARD_ID",
          "clickup.workspace_id": "CLICKUP_WORKSPACE_ID",
          "confluence.base_url": "CONFLUENCE_BASE_URL",
          "confluence.email": "CONFLUENCE_EMAIL",
          "google-sheets.service_account_json": "GOOGLE_SHEETS_SA_JSON",
          "google-sheets.spreadsheet_id": "GOOGLE_SHEETS_SPREADSHEET_ID",
          "google-calendar.service_account_json": "GOOGLE_CALENDAR_SA_JSON",
          "google-calendar.calendar_id": "GOOGLE_CALENDAR_ID",
          "salesforce.instance_url": "SALESFORCE_INSTANCE_URL",
          "zendesk.subdomain": "ZENDESK_SUBDOMAIN",
          "zendesk.email": "ZENDESK_EMAIL",
          "pipedrive.company_domain": "PIPEDRIVE_DOMAIN",
          "paypal.client_id": "PAYPAL_CLIENT_ID",
          "stripe.webhook_secret": "STRIPE_WEBHOOK_SECRET",
          "twitter.api_key": "TWITTER_API_KEY",
          "twitter.api_secret": "TWITTER_API_SECRET",
          "twitter.default_username": "TWITTER_DEFAULT_USERNAME",
          "facebook.page_id": "FACEBOOK_PAGE_ID",
          "mixpanel.project_token": "MIXPANEL_PROJECT_TOKEN",
          "google-analytics.service_account_json": "GOOGLE_ANALYTICS_SA_JSON",
          "google-analytics.property_id": "GA4_PROPERTY_ID",
          "shopify.shop_domain": "SHOPIFY_SHOP_DOMAIN",
          "woocommerce.site_url": "WOOCOMMERCE_STORE_URL",
          "woocommerce.consumer_key": "WOOCOMMERCE_CONSUMER_KEY",
          "zapier.webhook_url": "ZAPIER_WEBHOOK_URL",
          "make.webhook_url": "MAKE_WEBHOOK_URL",
          "n8n.webhook_url": "N8N_WEBHOOK_URL",
          "n8n.api_key": "N8N_API_KEY",
          "docker-hub.username": "DOCKER_HUB_USERNAME",
        };
        const intResult = await db.query(
          "SELECT provider, access_token, config FROM integrations WHERE agent_id = $1 AND status = 'active'",
          [id],
        );
        const { decrypt } = require("./crypto");
        for (const row of intResult.rows) {
          // Primary token
          const envName = INTEGRATION_ENV_MAP[row.provider];
          if (envName && row.access_token) {
            try {
              integrationEnvVars[envName] = decrypt(row.access_token);
            } catch (err) {
              console.warn(
                `[provisioner] Skipping integration token for agent ${id} provider ${row.provider}: ${err.message}`,
              );
            }
          }
          // Config fields (URLs, usernames, IDs, secondary secrets)
          const cfg = decryptSensitiveConfig(row.provider, row.config);
          for (const [cfgKey, cfgValue] of Object.entries(cfg)) {
            if (!cfgValue) continue;
            const cfgEnvName = INTEGRATION_CONFIG_ENV_MAP[`${row.provider}.${cfgKey}`];
            if (cfgEnvName) {
              integrationEnvVars[cfgEnvName] = String(cfgValue);
            }
          }
          // Stash the decrypted token+config for providers that can back an MCP
          // server, so an enabled MCP server gets the credential its own server
          // expects (which differs from the generic tool env var above).
          if (mcpServers.isSupportedProvider(row.provider) && row.access_token) {
            try {
              mcpIntegrationsByProvider[row.provider] = {
                token: decrypt(row.access_token),
                config: cfg,
              };
            } catch {
              // Already logged above when the tool token failed to decrypt.
            }
          }
        }
        if (Object.keys(integrationEnvVars).length > 0) {
          console.log(
            `[provisioner] Injecting ${Object.keys(integrationEnvVars).length} integration credential(s) for agent ${id}`,
          );
        }
      } catch (e) {
        console.warn(
          `[provisioner] Failed to fetch integration credentials for agent ${id}:`,
          e.message,
        );
      }
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

      // Resolve the agent's enabled MCP servers into openclaw.json entries
      // (credential-injected). Empty unless the operator enabled one and the
      // backing integration is connected. OpenClaw-only; ignored elsewhere.
      let mcpServerEntries = [];
      try {
        mcpServerEntries = mcpServers.resolveMcpEntries({
          enabledIds: agentRow.mcp_servers,
          integrationsByProvider: mcpIntegrationsByProvider,
        });
        if (mcpServerEntries.length > 0) {
          console.log(
            `[provisioner] Wiring ${mcpServerEntries.length} MCP server(s) for agent ${id}: ${mcpServerEntries
              .map((e) => e.name)
              .join(", ")}`,
          );
        }
      } catch (e) {
        console.warn(`[provisioner] Failed to resolve MCP servers for agent ${id}:`, e.message);
      }

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
        const usesLocalDockerPublishedPort =
          deployTarget === "docker" && resolvedRuntimeFields.runtime_family === "openclaw";
        if (allocationHostKey) {
          const unavailableGatewayPorts = usesLocalDockerPublishedPort
            ? await getOccupiedDockerPublishedPorts(provisioner, { agentId: id })
            : new Set();
          allocatedGatewayPort = await allocateGatewayPort({
            hostKey: allocationHostKey,
            agentId: id,
            unavailablePorts: unavailableGatewayPorts,
          });
          // Remote Hermes needs a SECOND published host port for its dashboard
          // UI (9119), distinct from the runtime API port (8642 = the 'gateway'
          // slot used for the readiness probe). Local Hermes reaches the
          // dashboard on the compose network (no host publish), and OpenClaw has
          // no separate dashboard, so neither allocates this slot.
          if (
            deployTarget === "remote-docker" &&
            resolvedRuntimeFields.runtime_family === "hermes"
          ) {
            allocatedDashboardPort = await allocateGatewayPort({
              hostKey: allocationHostKey,
              agentId: id,
              purpose: DASHBOARD_PORT_PURPOSE,
            });
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
            mcpServers: mcpServerEntries,
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
              ...(defaultOpenClawModel && resolvedRuntimeFields.runtime_family === "openclaw"
                ? { NORA_DEFAULT_OPENCLAW_MODEL: defaultOpenClawModel }
                : {}),
              ...hermesRuntimeBootstrapEnv,
              ...agentSecretEnvVars,
              ...integrationEnvVars,
              ...llmEnvVars,
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
          const [migrationManifest, persistedHermesState] = await Promise.all([
            getMigrationManifestForAgent(id).catch(() => null),
            getPersistedHermesState(id).catch(() => ({ modelConfig: {}, channels: [] })),
          ]);

          const seedArchive = migrationManifest
            ? await buildHermesSeedArchive(migrationManifest).catch(() => null)
            : null;
          // Require a real containerId — dockerode stringifies null/undefined
          // into the URL as the literal word "null", which is what surfaces to
          // the UI as `No such container: null`. Skip the seed step rather than
          // emit that confusing error; the provision will continue without the
          // seed archive (Hermes can run without imported migration state).
          if (
            seedArchive &&
            provisioner?.docker &&
            typeof containerId === "string" &&
            containerId.length > 0
          ) {
            try {
              await provisioner.docker.getContainer(containerId).putArchive(seedArchive, {
                path: "/",
              });
            } catch (e) {
              console.warn(
                `[provisioner] Hermes seed archive upload failed for agent ${id}: ${e.message}`,
              );
            }
          }

          if (
            hasMeaningfulHermesModelConfig(persistedHermesState?.modelConfig) ||
            (persistedHermesState?.channels || []).length > 0
          ) {
            await applyPersistedHermesState(
              {
                id,
                container_id: containerId,
                backend_type: resolvedBackend,
                runtime_family: "hermes",
                deploy_target: resolvedRuntimeFields.deploy_target,
                execution_target_id: resolvedRuntimeFields.execution_target_id,
                sandbox_profile: "standard",
                host,
                runtime_host: runtimeHost,
                runtime_port: runtimePort,
                gateway_host_port: gatewayHostPort,
                gateway_host: gatewayHost,
                gateway_port: gatewayPort,
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
        });
        if (failure.canceled) {
          console.warn(
            `[provisioner] Suppressing retry for deployment job ${job.id}; agent ${id} was deleted`,
          );
          return { canceled: true, reason: "agent-deleted-after-failure" };
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
            waitForAgentReadiness({
              host,
              runtimeHost,
              runtimePort,
              gatewayHost,
              gatewayHostPort,
              gatewayPort,
              checkGateway: resolvedRuntimeFields.runtime_family !== "hermes",
            }),
          failClosedOnReadinessFailure: builtInDemoActivation,
          onReadinessWarning: async (readiness) => {
            const detail = buildReadinessWarningDetail(readiness);
            console.warn(`[provisioner] Readiness check failed for agent ${id}: ${detail}`);
            await persistReadinessWarning(db, { agentId: id, name, host, readiness });
          },
          reconcileAuth: userId
            ? () =>
                reconcileRuntimeLlmAuth({
                  agentId: id,
                  userId,
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
                })
            : null,
          reconcileAndFinalize: userId
            ? () =>
                reconcileProviderStateUntilStable({
                  bootstrappedFingerprint: bootstrappedProviderFingerprint,
                  reconcile: (appliedFingerprint) =>
                    reconcileRuntimeLlmAuth({
                      agentId: id,
                      userId,
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
                    }),
                  readFingerprint: async () =>
                    (await fetchEffectiveProviderState(userId, llmProviderId)).fingerprint,
                  withMutationLock: (operation) => withProviderMutationLock(userId, operation),
                  finalize: () =>
                    finalizeProvisionedDeployment(db, {
                      agentId: id,
                      containerId,
                      name,
                      backend: resolvedBackend,
                      host,
                    }),
                })
            : null,
          finalize: () =>
            finalizeProvisionedDeployment(db, {
              agentId: id,
              containerId,
              name,
              backend: resolvedBackend,
              host,
            }),
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
            console.warn(
              `[provisioner] Failed to reconcile saved ClawHub skills for agent ${id}:`,
              e.message,
            );
          }
        }

        // The built-in demo activation is deliberately mutation-free after
        // readiness finalization. Its payload has no channels, skills, or
        // integrations, and skipping these generic reseed passes guarantees
        // the first chat cannot race a post-finalization gateway reload.
        if (!builtInDemoActivation) {
          try {
            const intResult = await db.query(
              `SELECT i.id, i.provider, i.catalog_id, i.config, i.status,
                ic.name as catalog_name, ic.category as catalog_category,
                ic.auth_type, ic.config_schema
         FROM integrations i
         LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
         WHERE i.agent_id = $1 AND i.status = 'active'`,
              [id],
            );
            const syncData = intResult.rows.map(buildIntegrationSyncEntry);
            if (resolvedRuntimeFields.runtime_family === "openclaw") {
              const runtimeUrl = runtimeUrlForAgent(
                {
                  host,
                  runtime_host: runtimeHost,
                  runtime_port: runtimePort,
                },
                "/integrations/sync",
              );
              await fetch(runtimeUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...buildRuntimeAuthHeaders(gatewayToken),
                },
                body: JSON.stringify({ integrations: syncData }),
              });
              console.log(`[provisioner] Synced ${syncData.length} integration(s) to agent ${id}`);
            } else if (resolvedRuntimeFields.runtime_family === "hermes" && containerId) {
              await runProvisionerExecCommand(
                provisioner,
                containerId,
                buildHermesIntegrationInstallCommand(syncData),
                { timeout: 30000, agentId: id },
              );
              console.log(
                `[provisioner] Installed Nora integration skill with ${syncData.length} integration(s) to Hermes agent ${id}`,
              );
            }
          } catch (e) {
            console.warn(`[provisioner] Failed to sync integrations for agent ${id}:`, e.message);
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
        });
        if (failure.canceled) {
          return { canceled: true, reason: "agent-deleted-after-persistence-failure" };
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
  console.error(`Job ${job?.id} failed (attempt ${attempts}/${maxAttempts}): ${err.message}`);

  if (job && attempts >= maxAttempts) {
    // Final failure — job exhausted all retries, now in dead letter queue
    console.error(
      `[DLQ] Agent "${job.data.name}" (${job.data.id}) exhausted all ${maxAttempts} retry attempts`,
    );
    try {
      // Terminal: without this, a job that died after the container was
      // created (e.g. the final status UPDATE failed) leaves the agent in
      // 'deploying' forever — the background reconciler deliberately skips
      // queued/deploying rows, so nothing else can ever move it.
      await db.query("UPDATE agents SET status = 'error' WHERE id = $1 AND status = 'deploying'", [
        job.data.id,
      ]);
      await db.query("INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)", [
        "agent_deploy_dlq",
        `Agent "${job.data.name}" exhausted all ${maxAttempts} retry attempts`,
        JSON.stringify({ agentId: job.data.id, error: err.message, jobId: job.id }),
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
    const provisioner = await loadBackend(buildAgentRuntimeFields(agent));

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
  buildUnresolvedRuntimeError,
  cleanupProvisionedRuntimeAfterFailure,
  failDeploymentForUnresolvedRuntime,
  fetchDeploymentProvider,
  fetchUserLlmEnvVars,
  isFinalDeploymentAttempt,
  persistProvisionedRuntimeIdentity,
  persistProvisioningFailure,
  reconcileProvisioningFailureRuntime,
};
