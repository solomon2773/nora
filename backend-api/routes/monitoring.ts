// @ts-nocheck
const express = require("express");
const db = require("../db");
const monitoring = require("../monitoring");
const metricsModule = require("../metrics");
const { asyncHandler } = require("../middleware/errorHandler");
const { findOwnedAgent, requireOwnedAgent } = require("../middleware/ownership");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.use("/agents/:id", requireOwnedAgent("id"));

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePositiveInteger(
  value,
  defaultValue,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {}
) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return defaultValue;
  return Math.min(max, Math.max(min, numeric));
}

function parseEventDate(value, { endOfDay = false } = {}) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    parsed = new Date(
      `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    );
  } else {
    parsed = new Date(trimmed);
  }

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function buildEventFilters(query = {}) {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const type =
    typeof query.type === "string" && query.type.trim() !== "all"
      ? query.type.trim()
      : "";
  const hasFrom = typeof query.from === "string" && query.from.trim();
  const hasTo = typeof query.to === "string" && query.to.trim();
  const from = hasFrom ? parseEventDate(query.from) : null;
  const to = hasTo ? parseEventDate(query.to, { endOfDay: true }) : null;

  if (hasFrom && !from) {
    throw createHttpError("Invalid from date");
  }

  if (hasTo && !to) {
    throw createHttpError("Invalid to date");
  }

  if (from && to && from > to) {
    throw createHttpError("Invalid date range");
  }

  return { search, type, from, to };
}

function wantsPaginatedEvents(query = {}) {
  return ["page", "search", "type", "from", "to"].some(
    (key) => query[key] !== undefined
  );
}

// ─── Platform monitoring ──────────────────────────────────────────

router.get("/monitoring/metrics", asyncHandler(async (req, res) => {
  res.json(await monitoring.getMetrics({ userId: req.user.id }));
}));

router.get("/monitoring/events", asyncHandler(async (req, res) => {
  const { agentId, limit } = req.query;
  const filters = buildEventFilters(req.query);
  const scopedAgentId =
    typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
  let scopedAgent = null;

  if (scopedAgentId) {
    scopedAgent = await findOwnedAgent(scopedAgentId, req.user.id);
    if (!scopedAgent) return res.status(404).json({ error: "Agent not found" });
  }

  if (wantsPaginatedEvents(req.query)) {
    const page = parsePositiveInteger(req.query.page, 1, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    });
    const pageLimit = parsePositiveInteger(limit, 30, { min: 10, max: 100 });

    return res.json(
      await monitoring.getUserEventsPage(req.user.id, {
        ...filters,
        agentId: scopedAgentId,
        page,
        limit: pageLimit,
      })
    );
  }

  const parsedLimit = parsePositiveInteger(limit, 50, { min: 1, max: 100 });
  if (scopedAgentId) {
    return res.json(
      await monitoring.getUserRecentEvents(req.user.id, {
        agentId: scopedAgentId,
        limit: parsedLimit,
      })
    );
  }

  res.json(
    await monitoring.getUserRecentEvents(req.user.id, {
      limit: parsedLimit,
    })
  );
}));

router.get("/monitoring/performance", requireAdmin, asyncHandler(async (req, res) => {
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
