// @ts-nocheck
// Integration catalog, per-agent credentials, OAuth hand-offs, MCP selection,
// and native tool invocation. Provider-specific config objects remain open by
// design because their shapes come from the live integration catalog.

const { agentParam, jsonBody, jsonResponse, pathParameter, successSchema } = require("../common");

const integrationParam = pathParameter("iid", "Connected integration identifier.");
const catalogParam = pathParameter("catalogId", "Integration catalog identifier.");
const integrationSchema = { $ref: "#/components/schemas/Integration" };
const integrationArray = { type: "array", items: integrationSchema };
const editorAccess = { "x-required-agent-role": "editor" };

const oauthStart = (provider) => ({
  tags: ["Integrations"],
  summary: `Start ${provider} OAuth for an agent integration`,
  parameters: [agentParam],
  "x-required-scopes": ["integrations:write"],
  ...editorAccess,
  requestBody: jsonBody({
    type: "object",
    properties: {
      config: { type: "object", additionalProperties: true },
      redirectPath: { type: "string" },
    },
    additionalProperties: true,
  }),
  responses: jsonResponse("Provider authorization URL and callback metadata", {
    type: "object",
    required: ["authorizationUrl", "redirectUri", "expiresAt"],
    properties: {
      authorizationUrl: { type: "string", format: "uri" },
      redirectUri: { type: "string", format: "uri" },
      expiresAt: { type: "string", format: "date-time" },
    },
  }),
});

const oauthCallback = (provider) => ({
  tags: ["Integrations"],
  summary: `Complete ${provider} OAuth and redirect to the operator UI`,
  description:
    "Session-only browser callback for a previously initiated, user-bound OAuth state. Workspace API keys are rejected. The response is a redirect, not JSON.",
  parameters: [
    { name: "state", in: "query", required: true, schema: { type: "string" } },
    { name: "code", in: "query", schema: { type: "string" } },
    { name: "error", in: "query", schema: { type: "string" } },
    { name: "error_description", in: "query", schema: { type: "string" } },
  ],
  responses: { 302: { description: "Redirect to the saved operator-dashboard path." } },
});

module.exports = {
  "/integrations/catalog": {
    get: {
      tags: ["Integrations"],
      summary: "List the integration catalog",
      parameters: [{ name: "category", in: "query", schema: { type: "string" } }],
      responses: jsonResponse("Catalog items", {
        type: "array",
        items: { type: "object", additionalProperties: true },
      }),
    },
  },
  "/integrations/catalog/{catalogId}": {
    get: {
      tags: ["Integrations"],
      summary: "Get one integration catalog item",
      parameters: [catalogParam],
      responses: jsonResponse("Catalog item", { type: "object", additionalProperties: true }),
    },
  },
  "/agents/{id}/integrations": {
    get: {
      tags: ["Integrations"],
      summary: "List integrations connected to an agent",
      parameters: [agentParam],
      "x-required-scopes": ["integrations:read"],
      ...editorAccess,
      responses: jsonResponse("Connected integrations with secrets redacted", integrationArray),
    },
    post: {
      tags: ["Integrations"],
      summary: "Connect or replace an agent integration",
      description:
        "Credentials are encrypted, synchronized to the runtime, and connectivity-tested when possible.",
      parameters: [agentParam],
      "x-required-scopes": ["integrations:write"],
      ...editorAccess,
      requestBody: jsonBody({
        type: "object",
        required: ["provider"],
        properties: {
          provider: { type: "string" },
          token: { type: "string", writeOnly: true },
          config: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Connected integration", integrationSchema),
    },
  },
  "/agents/{id}/integrations/{iid}": {
    put: {
      tags: ["Integrations"],
      summary: "Update credentials or config for an agent integration",
      parameters: [agentParam, integrationParam],
      "x-required-scopes": ["integrations:write"],
      ...editorAccess,
      requestBody: jsonBody({
        type: "object",
        properties: {
          token: { type: "string", writeOnly: true },
          config: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Updated integration", integrationSchema),
    },
    delete: {
      tags: ["Integrations"],
      summary: "Disconnect an agent integration and remove runtime credentials",
      parameters: [agentParam, integrationParam],
      "x-required-scopes": ["integrations:write"],
      ...editorAccess,
      responses: jsonResponse("Integration removed", successSchema),
    },
  },
  "/agents/{id}/integrations/{iid}/test": {
    post: {
      tags: ["Integrations"],
      summary: "Test an agent integration connection",
      parameters: [agentParam, integrationParam],
      "x-required-scopes": ["integrations:write"],
      ...editorAccess,
      responses: jsonResponse("Provider-specific connectivity result", {
        type: "object",
        additionalProperties: true,
      }),
    },
  },
  "/agents/{id}/integrations/tools/invoke": {
    post: {
      tags: ["Integrations"],
      summary: "Invoke a native integration tool through an agent runtime",
      parameters: [agentParam],
      "x-required-scopes": ["integrations:write"],
      ...editorAccess,
      requestBody: jsonBody({
        type: "object",
        properties: {
          toolName: { type: "string" },
          name: { type: "string", description: "Alias for toolName." },
          input: { type: "object", additionalProperties: true },
          arguments: { type: "object", additionalProperties: true },
        },
        anyOf: [{ required: ["toolName"] }, { required: ["name"] }],
        additionalProperties: false,
      }),
      responses: jsonResponse("Tool-specific result", {
        type: "object",
        additionalProperties: true,
      }),
    },
  },
  "/agents/{id}/integrations/twitter/oauth/start": {
    post: oauthStart("Twitter/X"),
  },
  "/integrations/twitter/oauth/callback": {
    get: oauthCallback("Twitter/X"),
  },
  "/agents/{id}/integrations/linkedin/oauth/start": {
    post: oauthStart("LinkedIn"),
  },
  "/integrations/linkedin/oauth/callback": {
    get: oauthCallback("LinkedIn"),
  },
  "/agents/{id}/mcp-servers": {
    get: {
      tags: ["Integrations"],
      summary: "List MCP servers available to an agent",
      parameters: [agentParam],
      "x-required-scopes": ["integrations:read"],
      ...editorAccess,
      responses: jsonResponse("MCP inventory with connected/enabled flags", {
        type: "object",
        required: ["servers"],
        properties: {
          servers: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      }),
    },
    put: {
      tags: ["Integrations"],
      summary: "Replace the enabled MCP-server set for an agent",
      description: "The runtime applies this selection on its next redeploy.",
      parameters: [agentParam],
      "x-required-scopes": ["integrations:write"],
      ...editorAccess,
      requestBody: jsonBody({
        type: "object",
        required: ["providers"],
        properties: {
          providers: { type: "array", uniqueItems: true, items: { type: "string" } },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Enabled provider ids and refreshed server inventory", {
        type: "object",
        required: ["enabled", "redeployRequired", "servers"],
        properties: {
          enabled: { type: "array", items: { type: "string" } },
          redeployRequired: { type: "boolean" },
          servers: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      }),
    },
  },
};
