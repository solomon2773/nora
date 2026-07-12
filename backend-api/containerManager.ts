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
const { getRemoteHostProfile } = require("./remoteHosts");

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

/**
 * Resolve the path to a backend module.
 * In Docker: backends are mounted at /app/backends/ via docker-compose.
 * In dev/local: fall back to ../workers/provisioner/backends/ relative path.
 */
function resolveBackendPath(name) {
  const localPath = path.resolve(__dirname, "backends", name);
  const workerPath = path.resolve(__dirname, "../workers/provisioner/backends", name);
  try {
    require.resolve(localPath);
    return localPath;
  } catch {
    return workerPath;
  }
}

async function getBackendInstance(type, agent = {}) {
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
      const executionTargetId = resolveAgentExecutionTargetId(agent);
      const profile = await getRemoteHostProfile(executionTargetId);
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
      const executionTargetId = resolveAgentExecutionTargetId(agent);
      const profile = await getRemoteHostProfile(executionTargetId);
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
      const executionTargetId = resolveAgentExecutionTargetId(agent);
      const profile = await getRemoteHostProfile(executionTargetId);
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

/**
 * Get the provisioner backend for a given agent row.
 * @param {{ backend_type?: string, deploy_target?: string, sandbox_profile?: string }} agent
 * @returns {import('../workers/provisioner/backends/interface')}
 */
async function backendFor(agent) {
  const type = resolveAgentBackendType(agent);
  if (type === "docker") {
    if (resolveAgentRuntimeFamily(agent) === "hermes") {
      return getBackendInstance("docker:hermes", agent);
    }
    if (resolveAgentSandboxProfile(agent) === "nemoclaw") {
      return getBackendInstance("docker:nemoclaw", agent);
    }
  }
  if (type === "remote-docker" && resolveAgentRuntimeFamily(agent) === "hermes") {
    return getBackendInstance("remote-hermes", agent);
  }
  if (type === "remote-docker" && resolveAgentSandboxProfile(agent) === "nemoclaw") {
    return getBackendInstance("remote-nemoclaw", agent);
  }
  return getBackendInstance(type, agent);
}

// ── Public API ──────────────────────────────────────────

module.exports = {
  NoContainerError,
  ensureContainerId,

  /**
   * @param {{ backend_type?: string, deploy_target?: string, sandbox_profile?: string, container_id: string }} agent
   */
  async start(agent) {
    const id = resolveKubernetesRuntimeId(agent, "start");
    const backend = await backendFor(agent);
    return usesLifecycleOptions(agent)
      ? backend.start(id, lifecycleOptions(agent))
      : backend.start(id);
  },

  async stop(agent) {
    const id = resolveKubernetesRuntimeId(agent, "stop");
    const backend = await backendFor(agent);
    return usesLifecycleOptions(agent)
      ? backend.stop(id, lifecycleOptions(agent))
      : backend.stop(id);
  },

  async restart(agent) {
    const id = resolveKubernetesRuntimeId(agent, "restart");
    const backend = await backendFor(agent);
    return usesLifecycleOptions(agent)
      ? backend.restart(id, lifecycleOptions(agent))
      : backend.restart(id);
  },

  async updateEnv(agent, envVars = {}, options = {}) {
    const id = resolveKubernetesRuntimeId(agent, "update env");
    const backend = await backendFor(agent);
    if (typeof backend.updateEnv !== "function") {
      throw new Error(`Backend ${resolveAgentBackendType(agent)} does not support env updates`);
    }
    const managedEnvNames = Array.isArray(options.managedEnvNames) ? options.managedEnvNames : [];
    return backend.updateEnv(id, envVars, {
      ...lifecycleOptions(agent),
      ...(managedEnvNames.length > 0 ? { managedEnvNames } : {}),
    });
  },

  async destroy(agent) {
    const id = resolveDestroyContainerId(agent);
    return (await backendFor(agent)).destroy(id, {
      agentId: agent.id,
      host: agent.host || null,
      runtimeFamily: resolveAgentRuntimeFamily(agent),
    });
  },

  /**
   * status() is a best-effort read called from background reconciliation and
   * live-status endpoints. Returning a stable "not running" shape (instead of
   * throwing) lets callers treat null-container as equivalent to a stopped
   * container without scattering try/catch everywhere.
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
   * @returns {ReadableStream|null}
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
   * @returns {Object|null}
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
