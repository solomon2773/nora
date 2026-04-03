const db = require("./db");
const { deployQueue } = require("./redisQueue");

async function getMetrics() {
  const [agentCounts, deploymentCount, userCount] = await Promise.all([
    db.query("SELECT status, count(*)::int FROM agents GROUP BY status"),
    db.query("SELECT count(*)::int as total FROM deployments"),
    db.query("SELECT count(*)::int as total FROM users"),
  ]);

  const statusMap = {};
  agentCounts.rows.forEach((r) => {
    statusMap[r.status] = r.count;
  });

  let queueStats = { waiting: 0, active: 0, completed: 0, failed: 0 };
  try {
    queueStats = await deployQueue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed"
    );
  } catch (e) {
    /* queue may not be ready */
  }

  return {
    activeAgents: statusMap.running || 0,
    warningAgents: statusMap.warning || 0,
    errorAgents: statusMap.error || 0,
    totalAgents: Object.values(statusMap).reduce((a, b) => a + b, 0),
    queuedAgents: statusMap.queued || 0,
    stoppedAgents: statusMap.stopped || 0,
    totalDeployments: deploymentCount.rows[0]?.total || 0,
    totalUsers: userCount.rows[0]?.total || 0,
    queue: queueStats,
  };
}

async function getRecentEvents(limit = 20) {
  const result = await db.query(
    "SELECT * FROM events ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return result.rows;
}

async function logEvent(type, message, metadata = {}) {
  await db.query(
    "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
    [type, message, JSON.stringify(metadata)]
  );
}

module.exports = { getMetrics, getRecentEvents, logEvent };
