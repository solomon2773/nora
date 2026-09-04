// @ts-nocheck
/**
 * Container Manager — backend-agnostic lifecycle router.
 *
 * Delegates start/stop/restart/destroy/status/logs/exec to the correct
 * provisioner backend based on the agent's backend_type column.
 *
 * The backend-api service doesn't run the provisioner worker, so we
 * instantiate lightweight backend instances here purely for lifecycle
 * operations (not for create — that goes through BullMQ).
 *
 * Invariant: Docker-style adapters are never called with a null/empty
 * container_id. Kubernetes deployments can be addressed by their stable
 * container_name when a control-plane row lost container_id, so those lifecycle
 * operations use the same deployment-name fallback as destroy().
 */

const path = require("path");
const {
  resolveAgentBackendType,
  resolveAgentExecutionTargetId,
  resolveAgentRuntimeFamily,
  resolveAgentSandboxProfile,
} = require("./agentRuntimeFields");
const { getKubernetesClusterProfile } = require("./kubernetesClusters");
const { assertRemoteHostAgentUse, getRemoteHostCleanupProfile } = require("./remoteHosts");

// Lazy-load backends so missing optional deps (e.g. @kubernetes/client-node)
// don't crash the API server when only Docker is used.
const backendCache = {};

class NoContainerError extends Error {
  constructor(
    message = "Agent has no container assigned (still provisioning, failed, or already destroyed)",
  ) {
    super(message);
    this.name = "NoContainerError";
    this.statusCode = 409;
    this.code = "NO_CONTAINER";
  }
}

function ensureContainerId(agent, operation) {
  const id = agent?.container_id;
  if (typeof id !== "string" || id.length === 0) {
    throw new NoContainerError(
      `Cannot ${operation}: agent ${agent?.id || "<unknown>"} has no container_id`,
    );
  }
  return id;
}

function hasText(value) {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
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

function defaultK8sDeployName(agent = {}) {
  const runtimeFamily = resolveAgentRuntimeFamily(agent);
  const prefix = runtimeFamily === "hermes" ? "nora-hermes" : "nora-oclaw";
  return safeK8sName(
    `${prefix}-${agent.name || "agent"}-${agent.id || ""}`,
    `${prefix}-${agent.id || "agent"}`,
  );
}

function isKubernetesAgent(agent = {}) {
  return resolveAgentBackendType(agent) === "k8s";
}

function isProxmoxAgent(agent = {}) {
  return resolveAgentBackendType(agent) === "proxmox";
}

function usesLifecycleOptions(agent = {}) {
  return isKubernetesAgent(agent) || isProxmoxAgent(agent);
}

/**
 * Resolve the agent runtime identifier to use for a lifecycle operation.
 *
 * @param {Object} agent - Agent row whose runtime should be addressed.
 * @param {string} operation - Human-readable lifecycle action name used in error messages.
 * @returns {string} Runtime identifier for the backend, using Kubernetes fallbacks when `container_id` is unavailable.
 */
function resolveKubernetesRuntimeId(agent, operation) {
  if (!isKubernetesAgent(agent)) {
    return ensureContainerId(agent, operation);
  }

  if (hasText(agent?.container_id)) return String(agent.container_id);
  if (hasText(agent?.container_name)) return String(agent.container_name).trim();
  return defaultK8sDeployName(agent);
}

function lifecycleOptions(agent = {}) {
  return {
    agentId: agent.id,
    host: agent.host || null,
    runtimeFamily: resolveAgentRuntimeFamily(agent),
  };
}

function canMutate(agent = {}) {
  if (hasText(agent.container_id)) return true;
  if (!isKubernetesAgent(agent)) return false;
  return hasText(agent.container_name) || hasText(agent.name) || hasText(agent.id);
}

/**
 * Resolve the identifier Nora should use when destroying an agent runtime.
 *
 * @param {Object} agent - Agent row being deleted.
 * @returns {string} Runtime identifier to destroy, including Kubernetes deployment-name fallbacks for drifted rows.
 */
function resolveDestroyContainerId(agent) {
  if (!isKubernetesAgent(agent)) {
    return ensureContainerId(agent, "destroy");
  }

  return resolveKubernetesRuntimeId(agent, "destroy");
}

function canDestroy(agent = {}) {
  return canMutate(agent);
}

function normalizeLifecycleHost(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function lifecycleRuntimeAddress(result = {}) {
  if (!result || typeof result !== "object") return null;
  const host = normalizeLifecycleHost(result.host);
  const runtimeHost =
    normalizeLifecycleHost(result.runtimeHost ?? result.runtime_host) || host || null;
  if (!host && !runtimeHost) return null;
  return { host, runtimeHost };
}

async function persistLifecycleRuntimeAddress(queryable, agent, result) {
  const address = lifecycleRuntimeAddress(result);
  if (!address) return agent;
  if (!queryable || typeof queryable.query !== "function") {
    throw new TypeError("Lifecycle runtime address persistence requires a database client");
  }
  if (!agent?.id) {
    throw new TypeError("Lifecycle runtime address persistence requires an agent id");
  }

  const updated = await queryable.query(
    `UPDATE agents
        SET host = COALESCE($2, host),
            runtime_host = COALESCE($3, runtime_host)
      WHERE id = $1
      RETURNING host, runtime_host`,
    [agent.id, address.host, address.runtimeHost],
  );
  if (!updated.rows[0]) {
    const error = new Error(`Agent ${agent.id} no longer exists after lifecycle operation`);
    error.statusCode = 404;
    error.code = "AGENT_NOT_FOUND";
    throw error;
  }

  agent.host = updated.rows[0].host;
  agent.runtime_host = updated.rows[0].runtime_host;
  return agent;
}

function isIgnorableStopError(error) {
  return /already stopped|not running/i.test(String(error?.message || ""));
}

// Canonical in-container location of the worker's real backend adapters. They
// live here in EVERY layout: the backend-api prod image COPYs them to
// /app/backends, the worker-provisioner prod image has the worker itself at
// /app (so /app/backends is the worker's own backends), and dev compose bind-
// mounts ./workers/provisioner/backends to /app/backends in both services.
const APP_BACKENDS_DIR = "/app/backends";

/**
 * Ordered candidate paths for a backend adapter module, most-canonical first.
 *
 * /app/backends is tried FIRST because it always points at the worker's real
 * adapters (see APP_BACKENDS_DIR). This is essential in the worker-provisioner
 * prod image, where containerManager runs from /backend-api: there the
 * __dirname-relative candidates resolve either to the re-export shims
 * (backend-api/backends/{hermes,nemoclaw}, whose ../../workers/... require is
 * dead — there is no /workers dir in that image) or to a nonexistent
 * /workers/provisioner/backends path. Trying /app/backends first loads the real
 * adapter directly and never touches the shims.
 */
function backendPathCandidates(
  name,
  { appBackendsDir = APP_BACKENDS_DIR, dirname = __dirname } = {},
) {
  return [
    path.join(appBackendsDir, name),
    path.resolve(dirname, "backends", name),
    path.resolve(dirname, "../workers/provisioner/backends", name),
  ];
}

/**
 * Resolve the path to a backend module across the backend-api image, the
 * worker-provisioner image, and dev bind-mount layouts. Returns the first
 * candidate that resolves; if none do, returns the dev-sibling path so a
 * downstream require failure names a real, meaningful location.
 *
 * @param {string} name Backend adapter name (e.g. "docker", "hermes").
 * @param {Object} [opts]
 * @param {(p: string) => string} [opts.resolve] Resolver (injectable for tests).
 * @param {string} [opts.appBackendsDir] Override the canonical /app/backends dir.
 * @param {string} [opts.dirname] Override __dirname (for tests).
 */
function resolveBackendPath(name, { resolve = require.resolve, appBackendsDir, dirname } = {}) {
  const candidates = backendPathCandidates(name, { appBackendsDir, dirname });
  for (const candidate of candidates) {
    try {
      resolve(candidate);
      return candidate;
    } catch {
      // Try the next candidate layout.
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * Resolve a backend adapter for lifecycle operations. Static local adapters are
 * cached, while Kubernetes and Remote Docker adapters are rebuilt from their
 * current stored profiles.
 *
 * @param {string} type - Normalized backend type such as `docker`, `docker:hermes`, `docker:nemoclaw`, `proxmox`, or `k8s`.
 * @param {Object} [agent={}] - Agent row used to resolve execution-target-scoped backends.
 * @param {boolean} [cleanupOnly=false] - Whether Remote Docker may use the cleanup-only profile path.
 * @returns {Promise<Object>} Backend adapter instance for the requested lifecycle operations.
 */
async function getBackendInstance(type, agent = {}, cleanupOnly = false) {
  const cacheKey =
    type === "k8s" || type === "k3s" || type === "kubernetes" || type === "remote-docker"
      ? resolveAgentExecutionTargetId(agent)
      : type === "remote-hermes" || type === "remote-nemoclaw"
        ? `${type}:${resolveAgentExecutionTargetId(agent)}`
        : type;
  const profileBacked = [
    "k8s",
    "k3s",
    "kubernetes",
    "remote-docker",
    "remote-hermes",
    "remote-nemoclaw",
  ].includes(type);
  if (backendCache[cacheKey] && !profileBacked) return backendCache[cacheKey];
  if (profileBacked) delete backendCache[cacheKey];

  switch (type) {
    case "docker": {
      const DockerBackend = require(resolveBackendPath("docker"));
      backendCache[type] = new DockerBackend();
      break;
    }
    case "docker:hermes": {
      const HermesBackend = require(resolveBackendPath("hermes"));
      backendCache[type] = new HermesBackend();
      break;
    }
    case "docker:nemoclaw": {
      const NemoClawBackend = require(resolveBackendPath("nemoclaw"));
      backendCache[type] = new NemoClawBackend();
      break;
    }
    case "proxmox": {
      const ProxmoxBackend = require(resolveBackendPath("proxmox"));
      backendCache[type] = new ProxmoxBackend();
      break;
    }
    case "k8s": {
      const K8sBackend = require(resolveBackendPath("k8s"));
      const executionTargetId = resolveAgentExecutionTargetId(agent);
      const profile = await getKubernetesClusterProfile(executionTargetId);
      if (!profile) {
        throw new Error(
          "Kubernetes lifecycle operations require an Admin-registered cluster execution target.",
        );
      }
      backendCache[cacheKey] = new K8sBackend(profile);
      break;
    }
    case "remote-docker": {
      const RemoteDockerBackend = require(resolveBackendPath("remote-docker"));
      const profile = cleanupOnly
        ? await getRemoteHostCleanupProfile(agent)
        : await assertRemoteHostAgentUse(agent);
      if (!profile) {
        throw new Error(
          "Remote Docker lifecycle operations require a registered remote host execution target.",
        );
      }
      if (!profile.configured) {
        throw new Error(profile.issue || "Remote host is not configured for lifecycle operations.");
      }
      backendCache[cacheKey] = new RemoteDockerBackend(profile);
      break;
    }
    case "remote-nemoclaw": {
      const RemoteNemoClawBackend = require(resolveBackendPath("remote-nemoclaw"));
      const profile = cleanupOnly
        ? await getRemoteHostCleanupProfile(agent)
        : await assertRemoteHostAgentUse(agent);
      if (!profile) {
        throw new Error(
          "Remote NemoClaw lifecycle operations require a registered remote host execution target.",
        );
      }
      if (!profile.configured) {
        throw new Error(profile.issue || "Remote host is not configured for lifecycle operations.");
      }
      backendCache[cacheKey] = new RemoteNemoClawBackend(profile);
      break;
    }
    case "remote-hermes": {
      const RemoteHermesBackend = require(resolveBackendPath("remote-hermes"));
      const profile = cleanupOnly
        ? await getRemoteHostCleanupProfile(agent)
        : await assertRemoteHostAgentUse(agent);
      if (!profile) {
        throw new Error(
          "Remote Hermes lifecycle operations require a registered remote host execution target.",
        );
      }
      if (!profile.configured) {
        throw new Error(profile.issue || "Remote host is not configured for lifecycle operations.");
      }
      backendCache[cacheKey] = new RemoteHermesBackend(profile);
      break;
    }
    default:
      throw new Error(`Unknown backend type: ${type}`);
  }

  return backendCache[cacheKey];
}

async function backendForMode(agent, cleanupOnly) {
  const type = resolveAgentBackendType(agent);
  if (type === "docker") {
    if (resolveAgentRuntimeFamily(agent) === "hermes") {
      return getBackendInstance("docker:hermes", agent, cleanupOnly);
    }
    if (resolveAgentSandboxProfile(agent) === "nemoclaw") {
      return getBackendInstance("docker:nemoclaw", agent, cleanupOnly);
    }
  }
  if (type === "remote-docker" && resolveAgentRuntimeFamily(agent) === "hermes") {
    return getBackendInstance("remote-hermes", agent, cleanupOnly);
  }
  if (type === "remote-docker" && resolveAgentSandboxProfile(agent) === "nemoclaw") {
    return getBackendInstance("remote-nemoclaw", agent, cleanupOnly);
  }
  return getBackendInstance(type, agent, cleanupOnly);
}

/**
 * Resolve the backend adapter that should handle normal lifecycle operations for an agent.
 *
 * @param {Object} agent - Agent runtime metadata used to choose the backend.
 * @returns {Promise<Object>} Backend adapter responsible for the agent's lifecycle operations.
 */
async function backendFor(agent) {
  return backendForMode(agent, false);
}

// Intentionally private: only stop/destroy below may bypass the current host
// grant and PaaS active-use gate. Exported backendFor always resolves through
// assertRemoteHostAgentUse, even if a caller supplies extra arguments.
async function backendForCleanup(agent) {
  return backendForMode(agent, true);
}

// ── Public API ──────────────────────────────────────────

module.exports = {
  NoContainerError,
  ensureContainerId,
  // Exported for layout-resolution regression tests (backendPathResolution.test.ts).
  resolveBackendPath,
  backendPathCandidates,

  /**
   * Start an agent's runtime through its backend adapter.
   *
   * @param {Object} agent - Agent whose runtime should be started.
   * @returns {Promise<Object|void>} Backend start result, including a fresh
   * host/runtimeHost when the backend's address can change on start.
   */
  async start(agent) {
    const id = resolveKubernetesRuntimeId(agent, "start");
    const backend = await backendFor(agent);
    return usesLifecycleOptions(agent)
      ? backend.start(id, lifecycleOptions(agent))
      : backend.start(id);
  },

  /**
   * Stop an agent's runtime through its backend adapter.
   *
   * Stop is a cleanup operation: a former grantee must be able to quiesce a
   * runtime after host access is revoked, even though active use is blocked.
   *
   * @param {Object} agent - Agent whose runtime should be stopped.
   * @returns {Promise<void>} Resolves once the backend reports the runtime stopped.
   */
  async stop(agent) {
    const id = resolveKubernetesRuntimeId(agent, "stop");
    // Stop is a cleanup operation: a former grantee must be able to quiesce a
    // runtime after host access is revoked, even though active use is blocked.
    const backend = await backendForCleanup(agent);
    return usesLifecycleOptions(agent)
      ? backend.stop(id, lifecycleOptions(agent))
      : backend.stop(id);
  },

  /**
   * Restart an agent's runtime through its backend adapter.
   *
   * @param {Object} agent - Agent whose runtime should be restarted.
   * @returns {Promise<Object|void>} Backend restart result, including a fresh
   * host/runtimeHost when the backend's address can change on restart.
   */
  async restart(agent) {
    const id = resolveKubernetesRuntimeId(agent, "restart");
    const backend = await backendFor(agent);
    return usesLifecycleOptions(agent)
      ? backend.restart(id, lifecycleOptions(agent))
      : backend.restart(id);
  },

  /**
   * Replace an agent's managed runtime environment variables.
   *
   * @param {Object} agent - Agent whose runtime environment should be updated.
   * @param {Object} [envVars={}] - Environment variable values to apply.
   * @param {Object} [options={}] - Optional managed-name scoping, full-state
   * replacement, and cancellation signal.
   * @returns {Promise<Object>} Backend env-update result.
   */
  async updateEnv(agent, envVars = {}, options = {}) {
    const id = resolveKubernetesRuntimeId(agent, "update env");
    const backend = await backendFor(agent);
    if (typeof backend.updateEnv !== "function") {
      throw new Error(`Backend ${resolveAgentBackendType(agent)} does not support env updates`);
    }
    const managedEnvNames = Array.isArray(options.managedEnvNames) ? options.managedEnvNames : [];
    const authoritativeLifecycle = lifecycleOptions(agent);
    return backend.updateEnv(id, envVars, {
      ...authoritativeLifecycle,
      runtimeFamily: authoritativeLifecycle.runtimeFamily,
      ...(managedEnvNames.length > 0 ? { managedEnvNames } : {}),
      ...(options.replaceManagedState === true ? { replaceManagedState: true } : {}),
      ...(options.signal && typeof options.signal === "object" ? { signal: options.signal } : {}),
    });
  },

  /**
   * Read back an agent's currently applied managed runtime environment variables.
   *
   * @param {Object} agent - Agent whose runtime environment should be inspected.
   * @param {string[]} [envNames=[]] - Env var names to report; empty reports none.
   * @returns {Promise<Object>} Backend env-inspection result.
   */
  async inspectEnv(agent, envNames = []) {
    const id = resolveKubernetesRuntimeId(agent, "inspect environment");
    const backend = await backendFor(agent);
    if (typeof backend.inspectEnv !== "function") {
      throw new Error(
        `Backend ${resolveAgentBackendType(agent)} does not support environment inspection`,
      );
    }
    return backend.inspectEnv(id, {
      ...lifecycleOptions(agent),
      envNames: Array.isArray(envNames) ? envNames : [],
    });
  },

  /**
   * Permanently destroy an agent's runtime through its backend adapter.
   *
   * This is the final cleanup escape hatch for direct owners/admins: the route
   * layer constrains who may call it, so it deliberately bypasses the same
   * revoked-access guard that blocks normal start/restart/read/exec operations.
   *
   * @param {Object} agent - Agent whose runtime should be destroyed.
   * @param {Object} [options]
   * @param {boolean} [options.preserveState=false] - Keep the agent's durable
   * state (named volumes, the Kubernetes state claim) across the destroy. The
   * redeploy path sets this because it recreates the runtime against that same
   * state. A plain delete leaves it false, which is what tells the backend to
   * remove the state — adapters preserve by default.
   * @returns {Promise<void>} Resolves once the backend reports the runtime destroyed.
   */
  async destroy(agent, { preserveState = false } = {}) {
    const id = resolveDestroyContainerId(agent);
    // Destroy is the final cleanup escape hatch for direct owners/admins. The
    // route layer constrains who may delete; do not expose this bypass to
    // normal start/restart/read/exec operations.
    return (await backendForCleanup(agent)).destroy(id, {
      agentId: agent.id,
      host: agent.host || null,
      runtimeFamily: resolveAgentRuntimeFamily(agent),
      preserveState,
    });
  },

  /**
   * Return a stable not-running shape when an agent has no runtime identifier;
   * otherwise delegate to the selected backend and propagate its failures.
   *
   * @param {Object} agent - Agent whose runtime status should be inspected.
   * @returns {Promise<Object>} Backend status or the stable not-running fallback.
   */
  async status(agent) {
    const kubernetes = isKubernetesAgent(agent);
    const id = kubernetes ? resolveKubernetesRuntimeId(agent, "inspect") : agent?.container_id;
    if (typeof id !== "string" || id.length === 0) {
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
    const backend = await backendFor(agent);
    return usesLifecycleOptions(agent)
      ? backend.status(id, lifecycleOptions(agent))
      : backend.status(id);
  },

  async stats(agent) {
    const id = agent?.container_id;
    if (typeof id !== "string" || id.length === 0) return null;
    const backend = await backendFor(agent);
    if (typeof backend.stats === "function") {
      return backend.stats(id, isProxmoxAgent(agent) ? lifecycleOptions(agent) : agent);
    }
    return null;
  },

  /**
   * Stream container logs.
   *
   * @param {Object} agent - Agent whose logs should be streamed.
   * @param {Object} [opts={}] - Backend log streaming options.
   * @returns {Promise<ReadableStream|null>} Backend log stream when supported.
   */
  async logs(agent, opts = {}) {
    const id = ensureContainerId(agent, "stream logs");
    const backend = await backendFor(agent);
    if (typeof backend.logs === "function") {
      return backend.logs(
        id,
        isProxmoxAgent(agent) ? { ...opts, ...lifecycleOptions(agent) } : opts,
      );
    }
    return null;
  },

  /**
   * Create an interactive exec session.
   *
   * @param {Object} agent - Agent whose runtime should host the exec session.
   * @param {Object} [opts={}] - Backend command, TTY, and environment options.
   * @returns {Promise<Object|null>} Backend exec handles when supported.
   */
  async exec(agent, opts = {}) {
    const id = ensureContainerId(agent, "exec");
    const backend = await backendFor(agent);
    if (typeof backend.exec === "function") {
      return backend.exec(
        id,
        isProxmoxAgent(agent) ? { ...opts, ...lifecycleOptions(agent) } : opts,
      );
    }
    return null;
  },

  /** Expose the raw backend instance for advanced operations */
  backendFor,
  canMutate,
  canDestroy,
  isKubernetesAgent,
  lifecycleRuntimeAddress,
  persistLifecycleRuntimeAddress,
  isIgnorableStopError,
};
