// @ts-nocheck
// Monitoring router paths (mounted at "/"). Drift-checked against
// routes/monitoring.ts.

const agentParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "Agent UUID.",
};

const ok = (description, schema) => ({
  200: { description, ...(schema ? { content: { "application/json": { schema } } } : {}) },
});

module.exports = {
  "/monitoring/metrics": {
    get: {
      tags: ["Monitoring"],
      summary: "Platform metrics summary scoped to the caller",
      "x-required-scopes": ["monitoring:read"],
      responses: ok("Aggregate agent counts, deployments, and queue depth"),
    },
  },
  "/monitoring/fleet-status": {
    get: {
      tags: ["Monitoring"],
      summary: "Fleet needs-attention roll-up",
      description:
        "Only the agents needing operator attention, with reasons (error, budget_paused, stuck_deploying, budget_warning, telemetry_stalled). Errors first.",
      "x-required-scopes": ["monitoring:read"],
      responses: ok("Roll-up", {
        type: "object",
        properties: {
          generatedAt: { type: "string", format: "date-time" },
          total: { type: "integer" },
          attentionCount: { type: "integer" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agentId: { type: "string", format: "uuid" },
                name: { type: "string", nullable: true },
                status: { type: "string", nullable: true },
                severity: { type: "string", enum: ["error", "warning"] },
                reasons: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      severity: { type: "string", enum: ["error", "warning"] },
                      label: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    },
  },
  "/monitoring/events": {
    get: {
      tags: ["Monitoring"],
      summary: "Activity event log",
      description:
        "Filters (type/search/from/to or page) switch the response to a pagination envelope with an effective minimum limit of 10; without filters a flat array is returned honoring limit >= 1.",
      "x-required-scopes": ["monitoring:read"],
      parameters: [
        { name: "agentId", in: "query", schema: { type: "string", format: "uuid" } },
        { name: "limit", in: "query", schema: { type: "integer" } },
        { name: "type", in: "query", schema: { type: "string" } },
        { name: "search", in: "query", schema: { type: "string" } },
        { name: "from", in: "query", schema: { type: "string", format: "date" } },
        { name: "to", in: "query", schema: { type: "string", format: "date" } },
        { name: "page", in: "query", schema: { type: "integer" } },
      ],
      responses: ok("Events (array or pagination envelope, see description)"),
    },
  },
  "/monitoring/performance": {
    get: {
      tags: ["Monitoring"],
      summary: "Raw API performance metric records",
      "x-session-required": true,
      parameters: [{ name: "since", in: "query", schema: { type: "string", format: "date-time" } }],
      responses: ok("Metric records"),
    },
  },
  "/agents/{id}/metrics": {
    get: {
      tags: ["Monitoring"],
      summary: "Time-series metrics for one agent",
      "x-required-scopes": ["monitoring:read"],
      parameters: [
        agentParam,
        { name: "type", in: "query", schema: { type: "string" } },
        { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
        { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
      ],
      responses: ok("Metric records"),
    },
  },
  "/agents/{id}/metrics/summary": {
    get: {
      tags: ["Monitoring"],
      summary: "Pre-aggregated metrics summary for one agent",
      "x-required-scopes": ["monitoring:read"],
      parameters: [agentParam],
      responses: ok("Summary"),
    },
  },
  "/agents/{id}/cost": {
    get: {
      tags: ["Monitoring"],
      summary: "Accumulated LLM cost for one agent",
      "x-required-scopes": ["monitoring:read"],
      parameters: [
        agentParam,
        { name: "period_days", in: "query", schema: { type: "integer", default: 30 } },
      ],
      responses: ok("Cost summary"),
    },
  },
};
