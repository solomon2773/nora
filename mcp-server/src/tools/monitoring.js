// Monitoring and cost tools — wrap the existing /api/monitoring and per-agent
// observability endpoints (monitoring:read scope).

import { z } from "zod";
import { jsonResult, withApi } from "./shared.js";

// UUID-validated: interpolated into the request path (see agents.js note).
const agentId = z.string().uuid().describe("Agent id (UUID)");

export function registerMonitoringTools(server, api) {
  server.registerTool(
    "get_platform_metrics",
    {
      title: "Get platform metrics",
      description:
        "Fleet-level metrics for the workspace: agent counts by status (active/deploying/warning/error/queued/stopped), total deployments, and provisioning queue depth.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withApi(async () => jsonResult(await api.get("/api/monitoring/metrics"))),
  );

  server.registerTool(
    "get_fleet_status",
    {
      title: "Get fleet status",
      description:
        "Fleet-wide needs-attention roll-up for agents and platform components.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withApi(async () => jsonResult(await api.get("/api/monitoring/fleet-status"))),
  );

  server.registerTool(
    "list_monitoring_events",
    {
      title: "List monitoring events",
      description:
        "Recent platform/agent events (deploys, lifecycle changes, alerts, budget crossings). Filter by agent, type, free-text search, or time range.",
      inputSchema: {
        agentId: z.string().optional().describe("Scope to one agent"),
        limit: z.number().int().min(1).max(100).optional(),
        type: z.string().optional().describe("Event type filter, e.g. 'agent.deployed'"),
        search: z.string().optional().describe("Free-text search in event messages"),
        from: z.string().optional().describe("ISO timestamp lower bound"),
        to: z.string().optional().describe("ISO timestamp upper bound"),
      },
      annotations: { readOnlyHint: true },
    },
    withApi(async (args) => jsonResult(await api.get("/api/monitoring/events", { query: args }))),
  );

  server.registerTool(
    "get_agent_metrics",
    {
      title: "Get agent metrics",
      description:
        "Time-series usage metrics for one agent (CPU, memory, network, disk, tokens) over a time window. Defaults to the last 24h.",
      inputSchema: {
        id: agentId,
        type: z.string().optional().describe("Metric type filter, e.g. 'token_usage'"),
        since: z.string().optional().describe("ISO timestamp lower bound (default: 24h ago)"),
        until: z.string().optional().describe("ISO timestamp upper bound (default: now)"),
      },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ id, ...query }) =>
      jsonResult(await api.get(`/api/agents/${id}/metrics`, { query })),
    ),
  );

  server.registerTool(
    "get_agent_metrics_summary",
    {
      title: "Get agent metrics summary",
      description: "Aggregated metrics summary for one agent (totals and latest samples).",
      inputSchema: { id: agentId },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ id }) => jsonResult(await api.get(`/api/agents/${id}/metrics/summary`))),
  );

  server.registerTool(
    "get_agent_cost",
    {
      title: "Get agent cost",
      description:
        "Token-cost rollup for one agent (input/output/total tokens and USD cost, pricing-aware per model). Defaults to the last 30 days.",
      inputSchema: {
        id: agentId,
        periodDays: z.number().int().min(1).max(365).optional(),
        periodStart: z.string().optional().describe("ISO date overriding periodDays"),
        periodEnd: z.string().optional().describe("ISO date overriding periodDays"),
      },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ id, ...query }) =>
      jsonResult(await api.get(`/api/agents/${id}/cost`, { query })),
    ),
  );
}
