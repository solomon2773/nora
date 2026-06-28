// @ts-nocheck
// Agents router paths (mounted at /agents). Every route in routes/agents.ts
// must appear here — the jest drift test fails otherwise. Headline endpoints
// carry full request/response docs; the long tail is summarized.

const agentParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "Agent UUID.",
};

const agentSummary = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    status: {
      type: "string",
      enum: ["queued", "deploying", "running", "warning", "error", "stopped"],
    },
    runtime_family: { type: "string", enum: ["openclaw", "hermes"] },
    deploy_target: { type: "string" },
    sandbox_profile: { type: "string" },
    paused_reason: { type: "string", nullable: true },
    vcpu: { type: "integer" },
    ram_mb: { type: "integer" },
    disk_gb: { type: "integer" },
    created_at: { type: "string", format: "date-time" },
  },
};

const ok = (description, schema) => ({
  200: {
    description,
    ...(schema ? { content: { "application/json": { schema } } } : {}),
  },
});

const summarize = (tag, summary, params = [agentParam], scopes = null) => ({
  tags: [tag],
  summary,
  parameters: params,
  ...(scopes ? { "x-required-scopes": scopes } : {}),
  responses: ok("Success"),
});

module.exports = {
  "/agents": {
    get: {
      tags: ["Agents"],
      summary: "List agents accessible to the caller",
      description:
        "Direct ownership plus workspace-shared agents. API keys see the agents of their bound workspace.",
      "x-required-scopes": ["agents:read"],
      parameters: [
        {
          name: "scope",
          in: "query",
          schema: { type: "string", enum: ["accessible", "owned"] },
          description: "'owned' restricts to agents created by the caller.",
        },
      ],
      responses: ok("Array of agents", { type: "array", items: agentSummary }),
    },
  },
  "/agents/deploy": {
    post: {
      tags: ["Agents"],
      summary: "Provision and deploy a new agent",
      description:
        "Queues the deployment and returns the created agent; poll GET /agents/{id} until status is 'running'.",
      "x-required-scopes": ["agents:write"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", maxLength: 100 },
                runtime_family: { type: "string", enum: ["openclaw", "hermes"] },
                deploy_target: { type: "string", description: "e.g. 'docker' or 'k8s'" },
                execution_target_id: { type: "string" },
                sandbox_profile: { type: "string", enum: ["standard", "nemoclaw"] },
                vcpu: { type: "integer", minimum: 1 },
                ram_mb: { type: "integer", minimum: 512 },
                disk_gb: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
      responses: ok("The created agent (status 'queued')", agentSummary),
    },
  },
  "/agents/adopt": {
    post: {
      tags: ["Agents"],
      summary: "Adopt an already-running external runtime",
      description:
        "Registers an existing OpenClaw or Hermes runtime that Nora did not provision, by its reachable URL + gateway token. Creates an agent with deploy_target='external' and status='running' (no provisioning). Nora monitors and proxies it; lifecycle actions are unavailable and delete is a deregister.",
      "x-required-scopes": ["agents:write"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["runtime_family", "gateway_token"],
              properties: {
                name: { type: "string", maxLength: 100 },
                runtime_family: { type: "string", enum: ["openclaw", "hermes"] },
                url: {
                  type: "string",
                  description:
                    "Reachable runtime URL — e.g. https://host:18789 (OpenClaw gateway) or https://host:9119 (Hermes dashboard). Provide this or host (+ port).",
                },
                host: { type: "string", description: "Runtime host (alternative to url)." },
                port: {
                  type: "integer",
                  description: "Runtime port (defaults to the family's gateway/dashboard port).",
                },
                gateway_token: {
                  type: "string",
                  description: "Gateway/API token for the existing runtime.",
                },
              },
            },
          },
        },
      },
      responses: {
        201: {
          description: "The adopted external agent (status 'running')",
          content: { "application/json": { schema: agentSummary } },
        },
      },
    },
  },
  "/agents/{id}": {
    get: {
      tags: ["Agents"],
      summary: "Get one agent with live-reconciled status",
      "x-required-scopes": ["agents:read"],
      parameters: [agentParam],
      responses: ok("Agent detail", agentSummary),
    },
    patch: summarize("Agents", "Rename / update agent fields", [agentParam], ["agents:write"]),
    delete: {
      tags: ["Agents"],
      summary: "Permanently delete an agent and its runtime",
      "x-required-scopes": ["agents:write"],
      parameters: [agentParam],
      responses: ok("Deletion result"),
    },
  },
  "/agents/{id}/start": {
    post: {
      tags: ["Agents"],
      summary: "Start a stopped agent",
      description: "Also clears a budget pause marker (manual start is an explicit override).",
      "x-required-scopes": ["agents:write"],
      parameters: [agentParam],
      responses: ok("Start result"),
    },
  },
};

// The terse tail — defined separately and merged so the headline block above
// stays readable. Each entry still satisfies the drift test.
const tail = {
  "/agents/{id}/stop": {
    post: summarize("Agents", "Stop a running agent", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/restart": {
    post: summarize("Agents", "Restart a running agent in place", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/redeploy": {
    post: summarize(
      "Agents",
      "Tear down and re-provision the runtime (agent must be stopped/warning/error)",
      [agentParam],
      ["agents:write"],
    ),
  },
  "/agents/{id}/delete": {
    post: summarize("Agents", "Delete an agent (legacy POST form)", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/duplicate": {
    post: summarize("Agents", "Duplicate an agent's configuration", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/budget": {
    get: {
      tags: ["Budgets"],
      summary: "List the agent's budgets with current spend",
      "x-required-scopes": ["agents:read"],
      parameters: [agentParam],
      responses: ok("Budgets with spend", {
        type: "object",
        properties: {
          budgets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                period: { type: "string", enum: ["daily", "weekly", "monthly"] },
                limitUsd: { type: "number" },
                softThresholdPct: { type: "integer" },
                currentUsd: { type: "number" },
                pct: { type: "integer" },
                bucket: { type: "string", enum: ["none", "soft", "hard"] },
              },
            },
          },
          pausedReason: { type: "string", nullable: true },
        },
      }),
    },
    put: {
      tags: ["Budgets"],
      summary: "Create or update a budget for a period",
      description:
        "Crossing the soft threshold emits an alert event; crossing 100% pauses the runtime.",
      "x-required-scopes": ["agents:write"],
      parameters: [agentParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["limitUsd"],
              properties: {
                period: {
                  type: "string",
                  enum: ["daily", "weekly", "monthly"],
                  default: "monthly",
                },
                limitUsd: { type: "number", exclusiveMinimum: 0 },
                softThresholdPct: { type: "integer", minimum: 0, maximum: 100, default: 80 },
              },
            },
          },
        },
      },
      responses: ok("The saved budget"),
    },
  },
  "/agents/{id}/budget/{budgetId}": {
    delete: summarize(
      "Budgets",
      "Remove a budget",
      [agentParam, { name: "budgetId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
  },
  "/agents/{id}/schedules": {
    get: summarize("Schedules", "List the agent's scheduled runs", [agentParam], ["agents:read"]),
    post: summarize(
      "Schedules",
      "Create a scheduled run (cron prompt or lifecycle action)",
      [agentParam],
      ["agents:write"],
    ),
  },
  "/agents/{id}/schedules/{scheduleId}": {
    put: summarize(
      "Schedules",
      "Update or enable/disable a schedule",
      [agentParam, { name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
    delete: summarize(
      "Schedules",
      "Delete a schedule",
      [agentParam, { name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
  },
  "/agents/{id}/schedules/{scheduleId}/runs": {
    get: summarize(
      "Schedules",
      "List recent runs for a schedule",
      [agentParam, { name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:read"],
    ),
  },
  "/agents/{id}/versions": {
    get: summarize("Agents", "List configuration version history", [agentParam], ["agents:read"]),
  },
  "/agents/{id}/versions/{versionId}": {
    get: summarize(
      "Agents",
      "Get one configuration version",
      [agentParam, { name: "versionId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:read"],
    ),
  },
  "/agents/{id}/rollback/{versionId}": {
    post: summarize(
      "Agents",
      "Roll back to a configuration version (queues a redeploy)",
      [agentParam, { name: "versionId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
  },
  "/agents/{id}/stats": {
    get: summarize("Monitoring", "Live runtime stats snapshot", [agentParam], ["agents:read"]),
  },
  "/agents/{id}/stats/history": {
    get: summarize("Monitoring", "Historical runtime stats", [agentParam], ["agents:read"]),
  },
  "/agents/{id}/gateway-url": {
    get: summarize("Agents", "Gateway control UI URL for the agent", [agentParam], ["agents:read"]),
  },
  "/agents/{id}/hermes-ui": {
    get: summarize("Hermes", "Hermes runtime snapshot", [agentParam], ["agents:read"]),
  },
  "/agents/{id}/hermes-ui/chat": {
    post: summarize(
      "Hermes",
      "Send a chat message to a Hermes agent",
      [agentParam],
      ["agents:write"],
    ),
  },
  "/agents/{id}/hermes-ui/cron": {
    get: summarize("Hermes", "List Hermes cron jobs", [agentParam], ["agents:read"]),
    post: summarize("Hermes", "Create a Hermes cron job", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/hermes-ui/cron/{jobId}": {
    put: summarize(
      "Hermes",
      "Update a Hermes cron job",
      [agentParam, { name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
    delete: summarize(
      "Hermes",
      "Delete a Hermes cron job",
      [agentParam, { name: "jobId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
  },
  "/agents/{id}/hermes-ui/channels": {
    get: summarize("Hermes", "List Hermes channels", [agentParam], ["agents:read"]),
    post: summarize("Hermes", "Create a Hermes channel", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/hermes-ui/channels/{channelId}": {
    patch: summarize(
      "Hermes",
      "Update a Hermes channel",
      [agentParam, { name: "channelId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
    delete: summarize(
      "Hermes",
      "Delete a Hermes channel",
      [agentParam, { name: "channelId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
  },
  "/agents/{id}/hermes-ui/channels/{channelId}/test": {
    post: summarize(
      "Hermes",
      "Test a Hermes channel",
      [agentParam, { name: "channelId", in: "path", required: true, schema: { type: "string" } }],
      ["agents:write"],
    ),
  },
};

module.exports = { ...module.exports, ...tail };
