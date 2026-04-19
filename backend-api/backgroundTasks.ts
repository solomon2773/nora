// @ts-nocheck
const db = require("./db");
const containerManager = require("./containerManager");
const { reconcileAgentStatus } = require("./agentStatus");
const { collectAgentTelemetrySample } = require("./agentTelemetry");

async function collectBackgroundTelemetry({
  dbClient = db,
  telemetryCollector = collectAgentTelemetrySample,
} = {}) {
  try {
    const agents = await dbClient.query(
      `SELECT id, container_id, backend_type, sandbox_type,
              runtime_family, deploy_target, sandbox_profile, status,
              host, runtime_host, runtime_port, gateway_host, gateway_port
         FROM agents
        WHERE status IN ('running','warning')
          AND container_id IS NOT NULL`
    );

    for (const agent of agents.rows) {
      try {
        await telemetryCollector(agent);
      } catch {
        // Runtime may have stopped between the query and the collection attempt.
      }
    }

    await dbClient
      .query(
        "DELETE FROM container_stats WHERE recorded_at < NOW() - INTERVAL '7 days'"
      )
      .catch(() => {});
  } catch {
    // Background sampling is best-effort only.
  }
}

async function reconcileBackgroundAgentStatuses({
  dbClient = db,
  statusResolver = (agent) => containerManager.status(agent),
} = {}) {
  try {
    const agents = await dbClient.query(
      `SELECT id, container_id, backend_type,
              runtime_family, deploy_target, sandbox_profile, status
         FROM agents
        WHERE container_id IS NOT NULL
          AND status IN ('running','warning','stopped','error')`
    );

    for (const agent of agents.rows) {
      try {
        const live = await statusResolver(agent);
        const reconciledStatus = reconcileAgentStatus(
          agent.status,
          Boolean(live?.running)
        );
        if (reconciledStatus !== agent.status) {
          await dbClient.query(
            "UPDATE agents SET status = $1 WHERE id = $2",
            [reconciledStatus, agent.id]
          );
        }
      } catch {
        const reconciledStatus = reconcileAgentStatus(agent.status, false);
        if (reconciledStatus !== agent.status) {
          await dbClient.query(
            "UPDATE agents SET status = $1 WHERE id = $2",
            [reconciledStatus, agent.id]
          );
        }
      }
    }
  } catch {
    // Reconciliation is best-effort only.
  }
}

module.exports = {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
};
