// @ts-nocheck
// Workspace, member, invitation, API-key, alert-rule, cost, and budget routes.
// The nested routers are mounted by routes/workspaces.ts; the drift test checks
// each child router against the fully assembled public paths below.

const {
  jsonBody,
  jsonResponse,
  pathParameter,
  successSchema,
  workspaceParam,
} = require("../common");

const workspaceArray = {
  type: "array",
  items: { $ref: "#/components/schemas/Workspace" },
};
const objectArray = { type: "array", items: { type: "object", additionalProperties: true } };
const workspaceRole = { type: "string", enum: ["viewer", "editor", "admin", "owner"] };
const userParam = pathParameter("userId", "Member user UUID.", "uuid");
const agentParam = pathParameter("agentId", "Agent UUID.", "uuid");
const invitationParam = pathParameter("invitationId", "Invitation UUID.", "uuid");
const keyParam = pathParameter("keyId", "Workspace API-key UUID.", "uuid");
const ruleParam = pathParameter("ruleId", "Alert-rule UUID.", "uuid");
const budgetParam = pathParameter("budgetId", "Workspace budget UUID.", "uuid");

const read = (tag, summary, parameters = [workspaceParam], role = "viewer") => ({
  tags: [tag],
  summary,
  parameters,
  "x-required-scopes": ["workspaces:read"],
  ...(role ? { "x-required-workspace-role": role } : {}),
  responses: jsonResponse("Success"),
});

const sessionWrite = (tag, summary, parameters = [workspaceParam], role = null) => ({
  tags: [tag],
  summary,
  parameters,
  "x-session-required": true,
  ...(role ? { "x-required-workspace-role": role } : {}),
  responses: jsonResponse("Success"),
});

module.exports = {
  "/workspaces": {
    get: {
      tags: ["Workspaces"],
      summary: "List workspaces visible to the caller",
      description:
        "Session users receive every workspace they belong to. A workspace API key is restricted to its bound workspace.",
      "x-required-scopes": ["workspaces:read"],
      responses: jsonResponse("Workspace memberships", workspaceArray),
    },
    post: {
      tags: ["Workspaces"],
      summary: "Create a workspace",
      "x-session-required": true,
      requestBody: jsonBody({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
        additionalProperties: false,
      }),
      responses: jsonResponse("Created workspace", { $ref: "#/components/schemas/Workspace" }),
    },
  },
  "/workspaces/cost": {
    get: {
      tags: ["Workspaces"],
      summary: "Get cost across all workspaces accessible to the caller",
      description:
        "Session users receive their accessible workspace groups plus unassigned owned agents. A workspace API key receives only its exact bound workspace and no unassigned agents.",
      "x-required-scopes": ["workspaces:read"],
      parameters: [
        { name: "period_days", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "period_start", in: "query", schema: { type: "string", format: "date" } },
        { name: "period_end", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: jsonResponse("Cross-workspace cost summary"),
    },
  },
  "/workspaces/invitations/accept": {
    post: {
      tags: ["Workspaces"],
      summary: "Accept a workspace invitation",
      "x-session-required": true,
      requestBody: jsonBody({
        type: "object",
        required: ["token"],
        properties: { token: { type: "string", minLength: 1 } },
        additionalProperties: false,
      }),
      responses: jsonResponse("Accepted membership"),
    },
  },
  "/workspaces/{id}/agents": {
    get: {
      ...read("Workspaces", "List agents assigned to a workspace"),
      responses: jsonResponse("Workspace agents", objectArray),
    },
    post: {
      ...sessionWrite(
        "Workspaces",
        "Assign a directly owned agent to a workspace",
        [workspaceParam],
        "editor",
      ),
      requestBody: jsonBody({
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", format: "uuid" },
          role: { type: "string" },
        },
        additionalProperties: false,
      }),
    },
  },
  "/workspaces/{id}/agent-candidates": {
    get: {
      ...read(
        "Workspaces",
        "List owned agents eligible for assignment",
        [workspaceParam],
        "editor",
      ),
      responses: jsonResponse("Assignment candidates", objectArray),
    },
  },
  "/workspaces/{id}/agents/{agentId}": {
    delete: {
      ...sessionWrite(
        "Workspaces",
        "Remove an agent assignment from a workspace",
        [workspaceParam, agentParam],
        "admin",
      ),
      responses: jsonResponse("Assignment removed", successSchema),
    },
  },
  "/workspaces/{id}": {
    delete: {
      ...sessionWrite(
        "Workspaces",
        "Delete a workspace without deleting its agents",
        [workspaceParam],
        "owner",
      ),
      responses: jsonResponse("Workspace deleted", successSchema),
    },
  },
  "/workspaces/{id}/members": {
    get: {
      ...read("Workspaces", "List workspace members"),
      responses: jsonResponse("Workspace members", objectArray),
    },
  },
  "/workspaces/{id}/members/{userId}": {
    patch: {
      ...sessionWrite(
        "Workspaces",
        "Change a workspace member role",
        [workspaceParam, userParam],
        "admin",
      ),
      requestBody: jsonBody({
        type: "object",
        required: ["role"],
        properties: { role: workspaceRole },
        additionalProperties: false,
      }),
    },
    delete: {
      ...sessionWrite(
        "Workspaces",
        "Remove a workspace member",
        [workspaceParam, userParam],
        "admin",
      ),
      responses: jsonResponse("Member removed", successSchema),
    },
  },
  "/workspaces/{id}/invitations": {
    get: {
      ...read("Workspaces", "List workspace invitations", [workspaceParam], "admin"),
      parameters: [
        workspaceParam,
        { name: "includeRevoked", in: "query", schema: { type: "boolean", default: false } },
      ],
      responses: jsonResponse("Workspace invitations", objectArray),
    },
    post: {
      ...sessionWrite("Workspaces", "Invite a member to a workspace", [workspaceParam], "admin"),
      requestBody: jsonBody({
        type: "object",
        required: ["email", "role"],
        properties: {
          email: { type: "string", format: "email" },
          role: workspaceRole,
        },
        additionalProperties: false,
      }),
    },
  },
  "/workspaces/{id}/invitations/{invitationId}": {
    delete: sessionWrite(
      "Workspaces",
      "Revoke a workspace invitation",
      [workspaceParam, invitationParam],
      "admin",
    ),
  },
  "/workspaces/{id}/api-keys/scopes": {
    get: {
      tags: ["API Keys"],
      summary: "List recognized workspace API-key scopes",
      parameters: [workspaceParam],
      "x-session-required": true,
      "x-required-workspace-role": "viewer",
      responses: jsonResponse("Scope definitions", objectArray),
    },
  },
  "/workspaces/{id}/api-keys": {
    get: {
      tags: ["API Keys"],
      summary: "List workspace API keys without raw secrets",
      parameters: [workspaceParam],
      "x-session-required": true,
      "x-required-workspace-role": "viewer",
      responses: jsonResponse("Workspace API keys", {
        type: "array",
        items: { $ref: "#/components/schemas/ApiKey" },
      }),
    },
    post: {
      tags: ["API Keys"],
      summary: "Issue a workspace API key",
      description:
        "The raw apiKey value is returned once and is never available from list endpoints.",
      parameters: [workspaceParam],
      "x-session-required": true,
      "x-required-workspace-role": "admin",
      requestBody: jsonBody({
        type: "object",
        required: ["scopes"],
        properties: {
          label: { type: "string", maxLength: 120 },
          scopes: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "agents:read",
                "agents:write",
                "workspaces:read",
                "monitoring:read",
                "integrations:read",
                "integrations:write",
                "admin:read",
              ],
            },
          },
          expiresAt: { type: ["string", "null"], format: "date-time" },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("New API key including its one-time raw secret", {
        $ref: "#/components/schemas/ApiKey",
      }),
    },
  },
  "/workspaces/{id}/api-keys/{keyId}": {
    delete: {
      tags: ["API Keys"],
      summary: "Revoke a workspace API key",
      parameters: [workspaceParam, keyParam],
      "x-session-required": true,
      "x-required-workspace-role": "admin",
      responses: jsonResponse("Revoked API-key metadata", {
        $ref: "#/components/schemas/ApiKey",
      }),
    },
  },
  "/workspaces/{id}/alert-rules": {
    get: {
      ...read("Alerts", "List workspace alert rules"),
      responses: jsonResponse("Alert rules", objectArray),
    },
    post: {
      ...sessionWrite("Alerts", "Create a workspace alert rule", [workspaceParam], "admin"),
      requestBody: jsonBody({
        type: "object",
        required: ["name", "eventPattern", "channels"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          eventPattern: { type: "string", minLength: 1, maxLength: 100 },
          channels: { type: "array", minItems: 1, items: { type: "object" } },
          enabled: { type: "boolean", default: true },
        },
        additionalProperties: false,
      }),
    },
  },
  "/workspaces/{id}/alert-rules/{ruleId}": {
    patch: {
      ...sessionWrite(
        "Alerts",
        "Update a workspace alert rule",
        [workspaceParam, ruleParam],
        "admin",
      ),
      requestBody: jsonBody(
        {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            eventPattern: { type: "string", minLength: 1, maxLength: 100 },
            channels: { type: "array", minItems: 1, items: { type: "object" } },
            enabled: { type: "boolean" },
          },
          additionalProperties: false,
        },
        true,
      ),
    },
    delete: {
      ...sessionWrite(
        "Alerts",
        "Delete a workspace alert rule",
        [workspaceParam, ruleParam],
        "admin",
      ),
      responses: jsonResponse("Alert rule deleted", successSchema),
    },
  },
  "/workspaces/{id}/alert-rules/{ruleId}/test": {
    post: {
      ...sessionWrite(
        "Alerts",
        "Send a synthetic event through an alert rule",
        [workspaceParam, ruleParam],
        "admin",
      ),
      responses: jsonResponse("Test event accepted", successSchema),
    },
  },
  "/workspaces/{id}/cost": {
    get: {
      ...read("Workspaces", "Get one workspace cost summary"),
      parameters: [
        workspaceParam,
        { name: "period_days", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "period_start", in: "query", schema: { type: "string", format: "date" } },
        { name: "period_end", in: "query", schema: { type: "string", format: "date" } },
      ],
    },
  },
  "/workspaces/{id}/budgets": {
    get: {
      ...read("Workspaces", "List workspace spend budgets"),
      responses: jsonResponse("Workspace budgets", objectArray),
    },
    put: {
      ...sessionWrite(
        "Workspaces",
        "Create or update a workspace spend budget",
        [workspaceParam],
        "admin",
      ),
      requestBody: jsonBody({
        type: "object",
        required: ["limitUsd"],
        properties: {
          period: { type: "string", enum: ["daily", "weekly", "monthly"] },
          limitUsd: { type: "number", exclusiveMinimum: 0 },
          softThresholdPct: { type: "integer", minimum: 0, maximum: 100 },
        },
        additionalProperties: false,
      }),
    },
  },
  "/workspaces/{id}/budgets/{budgetId}": {
    delete: {
      ...sessionWrite(
        "Workspaces",
        "Delete a workspace spend budget",
        [workspaceParam, budgetParam],
        "admin",
      ),
      responses: jsonResponse("Budget deleted", successSchema),
    },
  },
};
