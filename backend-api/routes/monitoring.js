const express = require("express");
const db = require("../db");
const monitoring = require("../monitoring");
const metricsModule = require("../metrics");
const { asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

// ─── Platform monitoring ──────────────────────────────────────────

router.get("/monitoring/metrics", asyncHandler(async (req, res) => {
  res.json(await monitoring.getMetrics());
}));

router.get("/monitoring/events", asyncHandler(async (req, res) => {
  const { agentId, limit } = req.query;
  if (agentId) {
    const result = await db.query(
      "SELECT * FROM events WHERE metadata->>'agentId' = $1 ORDER BY created_at DESC LIMIT $2",
      [agentId, parseInt(limit) || 20]
    );
    return res.json(result.rows);
  }
  res.json(await monitoring.getRecentEvents(parseInt(limit) || 50));
}));

router.get("/monitoring/performance", asyncHandler(async (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await db.query(
    "SELECT value, metadata, recorded_at FROM usage_metrics WHERE metric_type = 'api_performance' AND recorded_at >= $1 ORDER BY recorded_at",
    [since]
  );
  res.json(result.rows);
}));

// ─── Agent-level observability ────────────────────────────────────

router.get("/agents/:id/metrics", asyncHandler(async (req, res) => {
  const { type, since, until } = req.query;
  const data = await metricsModule.getAgentMetrics(
    req.params.id,
    type || null,
    since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    until || new Date().toISOString()
  );
  res.json(data);
}));

router.get("/agents/:id/metrics/summary", asyncHandler(async (req, res) => {
  res.json(await metricsModule.getAgentSummary(req.params.id));
}));

router.get("/agents/:id/cost", asyncHandler(async (req, res) => {
  const cost = await metricsModule.getAgentCost(req.params.id);
  if (!cost) return res.status(404).json({ error: "Agent not found" });
  res.json(cost);
}));

module.exports = router;
