// @ts-nocheck
const db = require("./db");
const containerManager = require("./containerManager");
const { reconcileAgentStatus } = require("./agentStatus");
const { collectAgentTelemetrySample } = require("./agentTelemetry");
const { probeExternalAgentHealth } = require("./externalHealth");
const { isRemoteHostAccessRevokedError } = require("./remoteHosts");

const REMOTE_HOST_STATUS_PRESERVING_ERRORS = new Set([
  "REMOTE_HOST_RETEST_REQUIRED",
  "REMOTE_HOST_AUTH_CHECK_FAILED",
]);
const PROVIDER_AUTH_STATUS_HOLD_REASONS = new Set([
  "provider_auth_reconciliation_pending",
  "provider_auth_reconciliation_failed",
]);

function shouldPreserveStatusAfterRemoteHostError(error) {
  return (
    isRemoteHostAccessRevokedError(error) || REMOTE_HOST_STATUS_PRESERVING_ERRORS.has(error?.code)
  );
}

/**
 * Collect telemetry for running container-backed agents and prune samples older
 * than seven days. Individual and task-level failures are intentionally ignored.
 *
 * @param {Object} options - Database and telemetry-collector overrides.
 * @returns {Promise<void>}
 */
async function collectBackgroundTelemetry({
  dbClient = db,
  telemetryCollector = collectAgentTelemetrySample,
} = {}) {
  try {
    const agents = await dbClient.query(
      `SELECT id, user_id, container_id, backend_type, sandbox_type,
              runtime_family, deploy_target, execution_target_id, sandbox_profile, status,
              host, runtime_host, runtime_port, gateway_host, gateway_port
         FROM agents
        WHERE status IN ('running','warning')
          AND container_id IS NOT NULL`,
    );

    for (const agent of agents.rows) {
      try {
        await telemetryCollector(agent);
      } catch {
        // Runtime may have stopped between the query and the collection attempt.
      }
    }

    await dbClient
      .query("DELETE FROM container_stats WHERE recorded_at < NOW() - INTERVAL '7 days'")
      .catch(() => {});
  } catch {
    // Background sampling is best-effort only.
  }
}

/**
 * Reconcile persisted container-backed agent states with runtime liveness.
 * Resolver failures are treated as not running; all reconciliation is best-effort.
 *
 * @param {Object} options - Database and status-resolver overrides.
 * @returns {Promise<void>}
 */
async function reconcileBackgroundAgentStatuses({
  dbClient = db,
  statusResolver = (agent) => containerManager.status(agent),
} = {}) {
  try {
    const agents = await dbClient.query(
      `SELECT id, user_id, container_id, backend_type,
              runtime_family, deploy_target, execution_target_id, sandbox_profile, status,
              paused_reason
         FROM agents
        WHERE container_id IS NOT NULL
          AND status IN ('running','warning','stopped','error')`,
    );

    for (const agent of agents.rows) {
      if (PROVIDER_AUTH_STATUS_HOLD_REASONS.has(agent.paused_reason)) continue;
      try {
        const live = await statusResolver(agent);
        const reconciledStatus = reconcileAgentStatus(agent.status, Boolean(live?.running));
        if (reconciledStatus !== agent.status) {
          await dbClient.query("UPDATE agents SET status = $1 WHERE id = $2", [
            reconciledStatus,
            agent.id,
          ]);
        }
      } catch (error) {
        // Authorization/retest failures mean Nora cannot prove live state, not
        // that the container stopped. Preserve durable status until an
        // authorized and trusted check can run again.
        if (shouldPreserveStatusAfterRemoteHostError(error)) continue;
        const reconciledStatus = reconcileAgentStatus(agent.status, false);
        if (reconciledStatus !== agent.status) {
          await dbClient.query("UPDATE agents SET status = $1 WHERE id = $2", [
            reconciledStatus,
            agent.id,
          ]);
        }
      }
    }
  } catch {
    // Reconciliation is best-effort only.
  }
}

/**
 * Reconcile adopted runtimes through SSRF-safe HTTP probes because they have no
 * container to inspect. Probe failures count as down and the sweep never throws.
 *
 * @param {Object} options - Database and health-probe overrides.
 * @returns {Promise<void>}
 */
async function reconcileExternalAgentStatuses({
  dbClient = db,
  healthProbe = probeExternalAgentHealth,
} = {}) {
  try {
    const agents = await dbClient.query(
      `SELECT id, status, runtime_family, deploy_target, execution_target_id, user_id,
              gateway_host, gateway_port, runtime_host, runtime_port, dashboard_port
         FROM agents
        WHERE deploy_target = 'external'
          AND status IN ('running','warning','stopped','error')`,
    );

    for (const agent of agents.rows) {
      let live = { running: false };
      try {
        live = await healthProbe(agent);
      } catch {
        live = { running: false };
      }
      const reconciledStatus = reconcileAgentStatus(agent.status, Boolean(live?.running));
      if (reconciledStatus !== agent.status) {
        await dbClient.query("UPDATE agents SET status = $1 WHERE id = $2", [
          reconciledStatus,
          agent.id,
        ]);
      }
    }
  } catch {
    // Reconciliation is best-effort only.
  }
}

module.exports = {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
  reconcileExternalAgentStatuses,
};
