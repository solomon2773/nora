// @ts-nocheck
/**
 * Provisioner Backend Interface
 * Every backend must implement: create(agentConfig) -> { containerId, host }
 *                               destroy(containerId) -> void
 *                               status(containerId)  -> { running: bool, uptime, cpu, memory }
 */

const { buildUnavailableTelemetry } = require("./telemetry");

class ProvisionerBackend {
  /**
   * Provision a new agent container/VM.
   * @param {Object} config - { id, name, image, vcpu, ram_mb, disk_gb, env }
   * @returns {Promise<{ containerId: string, host: string }>}
   */
  async create(config) {
    throw new Error("create() not implemented");
  }

  /**
   * Destroy a running agent.
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async destroy(containerId) {
    throw new Error("destroy() not implemented");
  }

  /**
   * Get status of a running agent.
   * @param {string} containerId
   * @returns {Promise<{ running: boolean, uptime?: number, cpu?: number, memory?: number }>}
   */
  async status(containerId) {
    throw new Error("status() not implemented");
  }

  /**
   * Get normalized telemetry for a running agent.
   * Backends that do not support resource metrics fall back to a capability map
   * with all metrics marked unavailable while still reporting run state.
   * @param {string} containerId
   * @param {Object} [agent]
   * @returns {Promise<{ backend_type: string, capabilities: Object, current: Object }>}
   */
  async stats(containerId, agent = null) {
    const status = await this.status(containerId);
    return buildUnavailableTelemetry({
      backendType: agent?.backend_type || "unknown",
      running: Boolean(status?.running),
      uptime_seconds: 0,
    });
  }

  /**
   * Stop a running agent.
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async stop(containerId) {
    throw new Error("stop() not implemented");
  }

  /**
   * Start (resume) a stopped agent.
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async start(containerId) {
    throw new Error("start() not implemented");
  }

  /**
   * Restart a running agent.
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async restart(containerId) {
    throw new Error("restart() not implemented");
  }

  /**
   * Stream logs from the agent.
   * @param {string} containerId
   * @param {Object} opts - { follow, tail, timestamps }
   * @returns {Promise<ReadableStream|null>}
   */
  async logs(containerId, opts = {}) {
    return null; // optional — backends override if supported
  }

  /**
   * Execute a command interactively in the agent (for terminal).
   * @param {string} containerId
   * @param {Object} opts - { cmd, tty, env }
   * @returns {Promise<{ exec, stream }|null>}
   */
  async exec(containerId, opts = {}) {
    return null; // optional — backends override if supported
  }
}

module.exports = ProvisionerBackend;
