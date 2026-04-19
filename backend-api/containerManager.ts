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
 */

const path = require("path");
const { resolveAgentBackendType } = require("./agentRuntimeFields");

// Lazy-load backends so missing optional deps (e.g. @kubernetes/client-node)
// don't crash the API server when only Docker is used.
const backendCache = {};

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

function getBackendInstance(type) {
  if (backendCache[type]) return backendCache[type];

  switch (type) {
    case "docker": {
      const DockerBackend = require(resolveBackendPath("docker"));
      backendCache[type] = new DockerBackend();
      break;
    }
    case "hermes": {
      const HermesBackend = require(resolveBackendPath("hermes"));
      backendCache[type] = new HermesBackend();
      break;
    }
    case "nemoclaw": {
      const NemoClawBackend = require(resolveBackendPath("nemoclaw"));
      backendCache[type] = new NemoClawBackend();
      break;
    }
    case "proxmox": {
      const ProxmoxBackend = require(resolveBackendPath("proxmox"));
      backendCache[type] = new ProxmoxBackend();
      break;
    }
    case "k8s":
    case "kubernetes": {
      const K8sBackend = require(resolveBackendPath("k8s"));
      backendCache[type] = new K8sBackend();
      break;
    }
    default:
      throw new Error(`Unknown backend type: ${type}`);
  }

  return backendCache[type];
}

/**
 * Get the provisioner backend for a given agent row.
 * @param {{ backend_type?: string, deploy_target?: string, sandbox_profile?: string }} agent
 * @returns {import('../workers/provisioner/backends/interface')}
 */
function backendFor(agent) {
  const type = resolveAgentBackendType(agent);
  return getBackendInstance(type);
}

// ── Public API ──────────────────────────────────────────

module.exports = {
  /**
   * @param {{ backend_type?: string, deploy_target?: string, sandbox_profile?: string, container_id: string }} agent
   */
  async start(agent) {
    return backendFor(agent).start(agent.container_id);
  },

  async stop(agent) {
    return backendFor(agent).stop(agent.container_id);
  },

  async restart(agent) {
    return backendFor(agent).restart(agent.container_id);
  },

  async destroy(agent) {
    return backendFor(agent).destroy(agent.container_id);
  },

  async status(agent) {
    return backendFor(agent).status(agent.container_id);
  },

  async stats(agent) {
    const backend = backendFor(agent);
    if (typeof backend.stats === "function") {
      return backend.stats(agent.container_id, agent);
    }
    return null;
  },

  /**
   * Stream container logs.
   * @returns {ReadableStream|null}
   */
  async logs(agent, opts = {}) {
    const backend = backendFor(agent);
    if (typeof backend.logs === "function") {
      return backend.logs(agent.container_id, opts);
    }
    return null;
  },

  /**
   * Create an interactive exec session.
   * @returns {Object|null}
   */
  async exec(agent, opts = {}) {
    const backend = backendFor(agent);
    if (typeof backend.exec === "function") {
      return backend.exec(agent.container_id, opts);
    }
    return null;
  },

  /** Expose the raw backend instance for advanced operations */
  backendFor,
};
