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

const scheduleParam = {
  name: "scheduleId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const scheduleSchema = {
  type: "object",
  required: ["id", "agent_id", "name", "cron", "timezone", "action_type", "enabled"],
  properties: {
    id: { type: "string", format: "uuid" },
    agent_id: { type: "string", format: "uuid" },
    name: { type: "string" },
    cron: { type: "string" },
    timezone: { type: "string" },
    action_type: { type: "string", enum: ["prompt", "restart", "stop", "start", "redeploy"] },
    prompt: { type: ["string", "null"] },
    enabled: { type: "boolean" },
    last_run_at: { type: ["string", "null"], format: "date-time" },
    last_status: { type: ["string", "null"] },
    next_run_at: { type: ["string", "null"], format: "date-time" },
  },
  additionalProperties: true,
};
const scheduleInput = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    cron: { type: "string", minLength: 1 },
    timezone: { type: "string", default: "UTC" },
    action_type: {
      type: "string",
      enum: ["prompt", "restart", "stop", "start", "redeploy"],
      default: "prompt",
    },
    actionType: { type: "string", description: "Alias for action_type." },
    prompt: { type: ["string", "null"], maxLength: 8000 },
    enabled: { type: "boolean" },
  },
  additionalProperties: false,
};
const versionParam = {
  name: "versionId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const versionSchema = {
  type: "object",
  required: ["id", "agentId", "versionNumber", "config", "source", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    agentId: { type: "string", format: "uuid" },
    versionNumber: { type: "integer", minimum: 1 },
    config: { type: "object", additionalProperties: true },
    createdBy: { type: ["string", "null"], format: "uuid" },
    message: { type: ["string", "null"] },
    source: {
      type: "string",
      enum: ["edit", "deploy", "redeploy", "duplicate", "hub-install", "restore", "rollback"],
    },
    createdAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};

module.exports = {
  "/agents": {
    get: {
      tags: ["Agents"],
      summary: "List agents accessible to the caller",
      description:
        "Direct ownership plus workspace-shared agents. API keys see only agents assigned to their exact bound workspace; scope=owned applies inside that same boundary.",
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
        "Queues the deployment and returns the created agent; poll GET /agents/{id} until status is 'running'. A workspace API-key deployment is atomically assigned to the key's bound workspace. API keys may deploy non-Remote targets with agents:write, but migration drafts and Remote Docker placement require a session JWT.",
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
                migration_draft_id: {
                  type: "string",
                  format: "uuid",
                  description: "Session-only migration draft to materialize into the new agent.",
                },
              },
            },
          },
        },
      },
      responses: {
        ...ok("The created agent (status 'queued')", agentSummary),
        403: {
          description:
            "Missing agents:write scope, or a workspace API key attempted session-only migration-draft or Remote Docker deployment.",
        },
      },
    },
  },
  "/agents/activate-demo": {
    post: {
      tags: ["Agents"],
      summary: "Activate or reuse the zero-key local Docker demo",
      description:
        "Session-only. Serializes activation per user, ensures the built-in demo provider, repairs a missing durable queue handoff, and returns the same durably marked OpenClaw agent on retries. New activation requires a reachable local Docker daemon.",
      "x-session-required": true,
      responses: {
        ...ok("The new or existing demo agent", agentSummary),
        403: { description: "A workspace API key attempted this session-only activation." },
        402: { description: "Agent quota or subscription does not allow activation" },
        503: { description: "The local Docker daemon is unavailable" },
      },
    },
  },
  "/agents/adopt": {
    post: {
      tags: ["Agents"],
      summary: "Adopt an already-running external runtime",
      description:
        "Registers an existing OpenClaw or Hermes runtime that Nora did not provision, by its reachable URL + gateway token. Creates an agent with deploy_target='external' and status='running' (no provisioning). API-key adoptions are atomically assigned to the key's bound workspace. Nora monitors and proxies the runtime; lifecycle actions are unavailable and delete is a deregister.",
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
                  minLength: 32,
                  maxLength: 4096,
                  description:
                    "High-entropy gateway/API token for the existing runtime. Use a cryptographically generated secret of at least 32 characters with no whitespace.",
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
        400: {
          description:
            "Invalid runtime family, weak gateway token, unsafe endpoint, or unsupported port.",
        },
        402: { description: "Agent quota or subscription does not allow adoption." },
        403: { description: "The API key lacks the agents:write scope." },
      },
    },
  },
  "/agents/{id}": {
    get: {
      tags: ["Agents"],
      summary: "Get one agent with live-reconciled status",
      description:
        "Workspace API keys are restricted to agents assigned to their exact bound workspace. Existing Remote Docker agent operations require a session JWT.",
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
    post: {
      ...summarize(
        "Agents",
        "Tear down and re-provision the runtime (agent must be stopped/warning/error)",
        [agentParam],
        ["agents:write"],
      ),
      description:
        "Workspace API keys may redeploy only when neither the current nor requested placement is Remote Docker. Any Remote Docker replacement requires a session JWT.",
    },
  },
  "/agents/{id}/delete": {
    post: summarize("Agents", "Delete an agent (legacy POST form)", [agentParam], ["agents:write"]),
  },
  "/agents/{id}/duplicate": {
    post: {
      ...summarize("Agents", "Duplicate an agent's configuration", [agentParam], ["agents:write"]),
      description:
        "Workspace API keys may duplicate only when neither the source nor destination uses Remote Docker. Remote Docker source capture or placement requires a session JWT.",
    },
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
    get: {
      tags: ["Schedules"],
      summary: "List the agent's scheduled runs",
      parameters: [agentParam],
      "x-required-scopes": ["agents:read"],
      "x-required-agent-role": "viewer",
      responses: ok("Schedules", { type: "array", items: scheduleSchema }),
    },
    post: {
      tags: ["Schedules"],
      summary: "Create a recurring prompt or lifecycle schedule",
      description:
        "Cron expressions are evaluated in the supplied IANA timezone and must respect the server's minimum interval.",
      parameters: [agentParam],
      "x-required-scopes": ["agents:write"],
      "x-required-agent-role": "editor",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              ...scheduleInput,
              required: ["name", "cron"],
            },
          },
        },
      },
      responses: {
        201: {
          description: "Created schedule",
          content: { "application/json": { schema: scheduleSchema } },
        },
      },
    },
  },
  "/agents/{id}/schedules/{scheduleId}": {
    put: {
      tags: ["Schedules"],
      summary: "Update or enable/disable a schedule",
      parameters: [agentParam, scheduleParam],
      "x-required-scopes": ["agents:write"],
      "x-required-agent-role": "editor",
      requestBody: {
        required: true,
        content: { "application/json": { schema: scheduleInput } },
      },
      responses: ok("Updated schedule", scheduleSchema),
    },
    delete: {
      tags: ["Schedules"],
      summary: "Delete a schedule",
      parameters: [agentParam, scheduleParam],
      "x-required-scopes": ["agents:write"],
      "x-required-agent-role": "editor",
      responses: ok("Schedule deleted", {
        type: "object",
        required: ["success"],
        properties: { success: { type: "boolean" } },
      }),
    },
  },
  "/agents/{id}/schedules/{scheduleId}/runs": {
    get: {
      tags: ["Schedules"],
      summary: "List recent audit events for a schedule's runs",
      parameters: [
        agentParam,
        scheduleParam,
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
      ],
      "x-required-scopes": ["agents:read"],
      "x-required-agent-role": "viewer",
      responses: ok("Schedule run events", {
        type: "array",
        items: { type: "object", additionalProperties: true },
      }),
    },
  },
  "/agents/{id}/versions": {
    get: {
      tags: ["Agents"],
      summary: "List configuration version history",
      parameters: [
        agentParam,
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      ],
      "x-required-scopes": ["agents:read"],
      "x-required-agent-role": "viewer",
      responses: ok("Configuration versions, newest first", {
        type: "array",
        items: versionSchema,
      }),
    },
  },
  "/agents/{id}/versions/{versionId}": {
    get: {
      tags: ["Agents"],
      summary: "Get one configuration version",
      parameters: [agentParam, versionParam],
      "x-required-scopes": ["agents:read"],
      "x-required-agent-role": "viewer",
      responses: ok("Configuration version", versionSchema),
    },
  },
  "/agents/{id}/rollback/{versionId}": {
    post: {
      tags: ["Agents"],
      summary: "Roll back to a configuration version and redeploy when needed",
      description:
        "Snapshots the current config first, restores the selected version, re-materializes template wiring, and queues a redeploy when the agent has a runtime. Rollback of a Remote Docker agent requires a session JWT.",
      parameters: [agentParam, versionParam],
      "x-required-scopes": ["agents:write"],
      "x-required-agent-role": "editor",
      responses: ok("Rollback result", {
        type: "object",
        required: ["success", "restored", "redeployed"],
        properties: {
          success: { type: "boolean" },
          restored: versionSchema,
          redeployed: { type: "boolean" },
        },
      }),
    },
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
