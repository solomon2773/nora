// @ts-nocheck
const express = require("express");
const db = require("../db");
const monitoring = require("../monitoring");
const fleetStatus = require("../fleetStatus");
const metricsModule = require("../metrics");
const { asyncHandler } = require("../middleware/errorHandler");
const {
  apiKeyWorkspaceId,
  findAccessibleAgent,
  requireAccessibleAgent,
} = require("../middleware/ownership");
const { requireAdmin, requireSession, scopeByMethod } = require("../middleware/auth");

const router = express.Router();

const requireAccessibleMonitoringAgent = requireAccessibleAgent("viewer", "id");
router.get("/agents/:id/metrics", requireAccessibleMonitoringAgent);
router.get("/agents/:id/metrics/summary", requireAccessibleMonitoringAgent);
router.get("/agents/:id/cost", requireAccessibleMonitoringAgent);
// Monitoring is read-only via API keys. We scope-gate the specific path
// prefixes the router handles — applying scopeByMethod at the router root
// would block unrelated requests because this router is mounted at "/".
router.use("/monitoring/performance", requireSession);
router.use("/monitoring", scopeByMethod("monitoring:read", null));
router.use("/agents/:id/metrics", scopeByMethod("monitoring:read", null));
router.use("/agents/:id/cost", scopeByMethod("monitoring:read", null));

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePositiveInteger(
  value,
  defaultValue,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
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
    parsed = new Date(`${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  } else {
    parsed = new Date(trimmed);
  }

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

/**
 * Normalize event-search query fields and reject invalid or reversed dates.
 * Date-only upper bounds include the full UTC day.
 *
 * @param {Object} query - Express query values.
 * @returns {Object} Validated filters for the monitoring service.
 */
function buildEventFilters(query = {}) {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const type =
    typeof query.type === "string" && query.type.trim() !== "all" ? query.type.trim() : "";
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
  return ["page", "search", "type", "from", "to"].some((key) => query[key] !== undefined);
}

function getApiKeyWorkspaceOrReject(req, res) {
  if (!req.apiKey) return null;
  const workspaceId = apiKeyWorkspaceId(req);
  if (!workspaceId) {
    res.status(403).json({ error: "API key has no workspace binding", code: "wrong_workspace" });
    return false;
  }
  return workspaceId;
}

// ─── Platform monitoring ──────────────────────────────────────────

router.get(
  "/monitoring/metrics",
  asyncHandler(async (req, res) => {
    const workspaceId = getApiKeyWorkspaceOrReject(req, res);
    if (workspaceId === false) return;
    res.json(
      await monitoring.getMetrics({
        userId: req.user.id,
        ...(workspaceId ? { workspaceId } : {}),
      }),
    );
  }),
);

router.get(
  "/monitoring/fleet-status",
  asyncHandler(async (req, res) => {
    const workspaceId = getApiKeyWorkspaceOrReject(req, res);
    if (workspaceId === false) return;
    res.json(
      await fleetStatus.getFleetAttention({
        userId: req.user.id,
        ...(workspaceId ? { workspaceId } : {}),
      }),
    );
  }),
);

router.get(
  "/monitoring/events",
  asyncHandler(async (req, res) => {
    const { agentId, limit } = req.query;
    const filters = buildEventFilters(req.query);
    const scopedAgentId = typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
    const workspaceId = getApiKeyWorkspaceOrReject(req, res);
    if (workspaceId === false) return;
    let scopedAgent = null;

    if (scopedAgentId) {
      if (workspaceId) {
        const assignment = await db.query(
          `SELECT 1 FROM workspace_agents
            WHERE workspace_id = $1 AND agent_id = $2
            LIMIT 1`,
          [workspaceId, scopedAgentId],
        );
        if (!assignment.rows[0]) {
          return res.status(403).json({
            error: "API key is not scoped to this agent's workspace",
            code: "wrong_workspace",
          });
        }
      } else {
        scopedAgent = await findAccessibleAgent(scopedAgentId, req.user.id, "viewer");
        if (!scopedAgent) return res.status(404).json({ error: "Agent not found" });
      }
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
          ...(workspaceId ? { workspaceId } : {}),
          page,
          limit: pageLimit,
        }),
      );
    }

    const parsedLimit = parsePositiveInteger(limit, 50, { min: 1, max: 100 });
    if (scopedAgentId) {
      return res.json(
        await monitoring.getUserRecentEvents(req.user.id, {
          agentId: scopedAgentId,
          ...(workspaceId ? { workspaceId } : {}),
          limit: parsedLimit,
        }),
      );
    }

    res.json(
      await monitoring.getUserRecentEvents(req.user.id, {
        ...(workspaceId ? { workspaceId } : {}),
        limit: parsedLimit,
      }),
    );
  }),
);

router.get(
  "/monitoring/performance",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await db.query(
      "SELECT value, metadata, recorded_at FROM usage_metrics WHERE metric_type = 'api_performance' AND recorded_at >= $1 ORDER BY recorded_at",
      [since],
    );
    res.json(result.rows);
  }),
);

// ─── Agent-level observability ────────────────────────────────────

router.get(
  "/agents/:id/metrics",
  asyncHandler(async (req, res) => {
    const { type, since, until } = req.query;
    const data = await metricsModule.getAgentMetrics(
      req.params.id,
      type || null,
      since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      until || new Date().toISOString(),
    );
    res.json(data);
  }),
);

router.get(
  "/agents/:id/metrics/summary",
  asyncHandler(async (req, res) => {
    res.json(await metricsModule.getAgentSummary(req.params.id));
  }),
);

router.get(
  "/agents/:id/cost",
  asyncHandler(async (req, res) => {
    const cost = await metricsModule.getAgentCost(
      req.params.id,
      metricsModule.parseCostQuery(req.query),
    );
    if (!cost) return res.status(404).json({ error: "Agent not found" });
    res.json(cost);
  }),
);

module.exports = router;
