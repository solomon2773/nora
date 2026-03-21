const db = require('./db');

/**
 * Record a single metric data point.
 */
async function recordMetric(agentId, userId, metricType, value, metadata = {}) {
  await db.query(
    'INSERT INTO usage_metrics(agent_id, user_id, metric_type, value, metadata) VALUES($1, $2, $3, $4, $5)',
    [agentId, userId, metricType, value, JSON.stringify(metadata)]
  );
}

/**
 * Get time-bucketed metrics for an agent.
 * Returns hourly aggregates within the given time range.
 */
async function getAgentMetrics(agentId, metricType, since, until) {
  const result = await db.query(
    `SELECT metric_type,
            SUM(value) as total,
            COUNT(*) as count,
            date_trunc('hour', recorded_at) as bucket
     FROM usage_metrics
     WHERE agent_id = $1
       AND ($2::text IS NULL OR metric_type = $2)
       AND recorded_at >= $3 AND recorded_at <= $4
     GROUP BY metric_type, bucket
     ORDER BY bucket`,
    [agentId, metricType || null, since, until]
  );
  return result.rows;
}

/**
 * Get a summary of all metrics for a specific agent.
 */
async function getAgentSummary(agentId) {
  const result = await db.query(
    `SELECT metric_type,
            SUM(value) as total,
            COUNT(*) as count,
            MIN(recorded_at) as first_seen,
            MAX(recorded_at) as last_seen
     FROM usage_metrics
     WHERE agent_id = $1
     GROUP BY metric_type`,
    [agentId]
  );

  const summary = {};
  for (const row of result.rows) {
    summary[row.metric_type] = {
      total: parseFloat(row.total),
      count: parseInt(row.count),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  }
  return summary;
}

/**
 * Get a usage summary for a user across all their agents.
 */
async function getUserSummary(userId, since) {
  const result = await db.query(
    `SELECT metric_type,
            SUM(value) as total,
            COUNT(*) as count
     FROM usage_metrics
     WHERE user_id = $1
       AND recorded_at >= $2
     GROUP BY metric_type`,
    [userId, since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]
  );

  const summary = {};
  for (const row of result.rows) {
    summary[row.metric_type] = {
      total: parseFloat(row.total),
      count: parseInt(row.count),
    };
  }
  return summary;
}

// ── API Performance Ring Buffer ──────────────────────────────────
// Records API request metrics in-memory, flushes aggregates to DB periodically.

const apiBuffer = [];
const MAX_BUFFER = 1000;

function recordApiMetric(entry) {
  apiBuffer.push(entry);
  if (apiBuffer.length > MAX_BUFFER) apiBuffer.shift();
}

// Flush aggregates every 60 seconds
setInterval(async () => {
  if (apiBuffer.length === 0) return;
  const batch = apiBuffer.splice(0);
  const avgLatency = batch.reduce((s, e) => s + e.durationMs, 0) / batch.length;
  const errorCount = batch.filter(e => e.status >= 500).length;
  try {
    await db.query(
      'INSERT INTO usage_metrics(metric_type, value, metadata) VALUES($1, $2, $3)',
      ['api_performance', batch.length, JSON.stringify({
        avgLatencyMs: Math.round(avgLatency * 100) / 100,
        errorCount,
        errorRate: Math.round((errorCount / batch.length) * 10000) / 10000,
        sampleSize: batch.length,
      })]
    );
  } catch (err) {
    console.error('[metrics] Failed to flush API performance metrics:', err.message);
  }
}, 60000);

/**
 * Get agent cost estimate based on resource usage and token consumption.
 */
async function getAgentCost(agentId) {
  const costPerVcpuHour = parseFloat(process.env.COST_PER_VCPU_HOUR || '0.05');
  const costPerGbRamHour = parseFloat(process.env.COST_PER_GB_RAM_HOUR || '0.01');
  const costPer1kTokens = parseFloat(process.env.COST_PER_1K_TOKENS || '0.002');

  // Get agent specs
  const agentResult = await db.query(
    'SELECT vcpu, ram_mb, created_at FROM agents WHERE id = $1',
    [agentId]
  );
  if (!agentResult.rows[0]) return null;
  const agent = agentResult.rows[0];

  // Calculate uptime hours (rough estimate from creation)
  const uptimeHours = (Date.now() - new Date(agent.created_at).getTime()) / (1000 * 60 * 60);

  // Get total tokens used
  const tokenResult = await db.query(
    "SELECT COALESCE(SUM(value), 0) as total FROM usage_metrics WHERE agent_id = $1 AND metric_type = 'tokens_used'",
    [agentId]
  );
  const totalTokens = parseFloat(tokenResult.rows[0].total);

  const computeCost = (agent.vcpu * costPerVcpuHour + (agent.ram_mb / 1024) * costPerGbRamHour) * uptimeHours;
  const tokenCost = (totalTokens / 1000) * costPer1kTokens;

  return {
    compute_cost: Math.round(computeCost * 100) / 100,
    token_cost: Math.round(tokenCost * 100) / 100,
    total_cost: Math.round((computeCost + tokenCost) * 100) / 100,
    total_tokens: totalTokens,
    uptime_hours: Math.round(uptimeHours * 10) / 10,
    period: 'lifetime',
  };
}

module.exports = {
  recordMetric,
  getAgentMetrics,
  getAgentSummary,
  getUserSummary,
  recordApiMetric,
  getAgentCost,
};
