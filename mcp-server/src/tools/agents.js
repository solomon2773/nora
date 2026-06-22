// Agent lifecycle tools — wrap the existing /api/agents endpoints. Auth and
// workspace scoping come from the API key (agents:read / agents:write scopes);
// the server adds no policy of its own beyond gating delete_agent.

import { z } from "zod";
import { jsonResult, withApi } from "./shared.js";

// Validate as a UUID: agent ids are UUIDs (db_schema agents.id), and the value
// is interpolated into the request path. A loose z.string() would let a crafted
// id like ".." collapse `/api/agents/../stop` to `/api/stop` via URL
// normalization and reach endpoints the tool never advertised.
const agentId = z.string().uuid().describe("Agent id (UUID)");

export function registerAgentTools(server, api, { allowDestructive = false } = {}) {
  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "List all agents accessible to the API key's workspace, with status, runtime family, deploy target, resources, and placement.",
      inputSchema: {
        scope: z
          .enum(["accessible", "owned"])
          .optional()
          .describe("'owned' restricts to agents created by the key's issuing user"),
      },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ scope }) => jsonResult(await api.get("/api/agents", { query: { scope } }))),
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get agent details",
      description:
        "Fetch one agent with live-reconciled status and runtime details (container state, gateway info, resources).",
      inputSchema: { id: agentId },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ id }) => jsonResult(await api.get(`/api/agents/${id}`))),
  );

  server.registerTool(
    "get_agent_stats",
    {
      title: "Get agent statistics",
      description:
        "Fetch real-time agent resource utilization and execution statistics (CPU, memory, disk, network, active tasks, error counts).",
      inputSchema: { id: agentId },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ id }) => jsonResult(await api.get(`/api/agents/${id}/stats`))),
  );

  server.registerTool(
    "get_agent_versions",
    {
      title: "List agent config versions",
      description:
        "List an agent's configuration version history (snapshots taken on config changes; usable with the dashboard's rollback).",
      inputSchema: {
        id: agentId,
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    withApi(async ({ id, limit }) =>
      jsonResult(await api.get(`/api/agents/${id}/versions`, { query: { limit } })),
    ),
  );

  server.registerTool(
    "deploy_agent",
    {
      title: "Deploy a new agent",
      description:
        "Provision and deploy a new agent runtime. Queues the deployment and returns the created agent; poll get_agent until status is 'running'.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Agent display name"),
        runtime_family: z
          .enum(["openclaw", "hermes"])
          .optional()
          .describe("Runtime family (default: control plane's default, usually openclaw)"),
        deploy_target: z
          .string()
          .optional()
          .describe("Deploy target, e.g. 'docker' or 'k8s' (default: control plane default)"),
        execution_target_id: z
          .string()
          .optional()
          .describe("Specific execution target id (e.g. a registered Kubernetes cluster)"),
        sandbox_profile: z
          .enum(["standard", "nemoclaw"])
          .optional()
          .describe("Sandbox profile (nemoclaw is experimental)"),
        vcpu: z.number().int().min(1).optional().describe("vCPU cores"),
        ram_mb: z
          .number()
          .int()
          .min(512)
          .optional()
          .describe(
            "RAM in MB (self-hosted minimum 512; ignored in PaaS mode where the operator sets resources)",
          ),
        disk_gb: z.number().int().min(1).optional().describe("Disk in GB"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    withApi(async (body) => jsonResult(await api.post("/api/agents/deploy", body))),
  );

  server.registerTool(
    "start_agent",
    {
      title: "Start agent",
      description: "Start a stopped agent runtime.",
      inputSchema: { id: agentId },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    withApi(async ({ id }) => jsonResult(await api.post(`/api/agents/${id}/start`))),
  );

  server.registerTool(
    "stop_agent",
    {
      title: "Stop agent",
      description:
        "Stop a running agent runtime. The agent keeps its state and can be started again.",
      inputSchema: { id: agentId },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    withApi(async ({ id }) => jsonResult(await api.post(`/api/agents/${id}/stop`))),
  );

  server.registerTool(
    "restart_agent",
    {
      title: "Restart agent",
      description: "Restart a running agent runtime in place.",
      inputSchema: { id: agentId },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    withApi(async ({ id }) => jsonResult(await api.post(`/api/agents/${id}/restart`))),
  );

  server.registerTool(
    "redeploy_agent",
    {
      title: "Redeploy agent",
      description:
        "Tear down and re-provision the agent's runtime container with its current configuration. Only valid when the agent is stopped, in warning, or in error state — stop a running agent first.",
      inputSchema: { id: agentId },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    withApi(async ({ id }) => jsonResult(await api.post(`/api/agents/${id}/redeploy`))),
  );

  if (allowDestructive) {
    server.registerTool(
      "delete_agent",
      {
        title: "Delete agent",
        description:
          "Permanently delete an agent and its runtime container. Irreversible. Only registered because NORA_MCP_ALLOW_DESTRUCTIVE=true.",
        inputSchema: { id: agentId },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      withApi(async ({ id }) => jsonResult(await api.delete(`/api/agents/${id}`))),
    );
  }
}
