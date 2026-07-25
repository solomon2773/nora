// @ts-nocheck
// Unified channel surface. OpenClaw returns managed channel definitions and
// connection actions; legacy/Hermes adapters return stored channel records.
// Runtime-specific payloads stay open rather than promising a false union.

const { agentParam, jsonBody, jsonResponse, pathParameter, successSchema } = require("../common");

const channelParam = pathParameter(
  "cid",
  "Stored channel id, or the OpenClaw channel type for managed channels.",
);
const channelTypeParam = pathParameter("type", "Normalized channel type.");

const read = (summary, parameters = [agentParam]) => ({
  tags: ["Channels"],
  summary,
  parameters,
  "x-required-scopes": ["integrations:read"],
  "x-required-agent-role": "owner",
  responses: jsonResponse("Success"),
});

const write = (summary, parameters = [agentParam, channelParam]) => ({
  tags: ["Channels"],
  summary,
  parameters,
  "x-required-scopes": ["integrations:write"],
  "x-required-agent-role": "owner",
  responses: jsonResponse("Success"),
});

module.exports = {
  "/agents/{id}/channels": {
    get: {
      ...read("List configured and available channels for an agent"),
      description:
        "Returns a runtime-aware envelope. Capabilities identify whether message history, testing, QR login, and arbitrary names are supported.",
      responses: jsonResponse("Runtime-aware channel inventory", {
        type: "object",
        properties: {
          runtime: { type: "string" },
          capabilities: { type: "object", additionalProperties: true },
          channels: { type: "array", items: { $ref: "#/components/schemas/Channel" } },
          availableTypes: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
        additionalProperties: true,
      }),
    },
    post: {
      ...write("Create or configure an agent channel", [agentParam]),
      requestBody: jsonBody({
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          name: {
            type: "string",
            description:
              "Required by stored legacy adapters; ignored when the runtime owns naming.",
          },
          enabled: { type: "boolean" },
          config: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      }),
      responses: jsonResponse("Configured channel", { $ref: "#/components/schemas/Channel" }),
    },
  },
  "/agents/{id}/channels/types/{type}": {
    get: {
      ...read("Get the configuration definition for a channel type", [
        agentParam,
        channelTypeParam,
      ]),
      responses: jsonResponse("Channel type metadata", {
        type: "object",
        additionalProperties: true,
      }),
    },
  },
  "/agents/{id}/channels/{cid}": {
    patch: {
      ...write("Update an agent channel"),
      requestBody: jsonBody({ type: "object", additionalProperties: true }),
      responses: jsonResponse("Updated channel", { $ref: "#/components/schemas/Channel" }),
    },
    delete: {
      ...write("Delete a stored channel"),
      description:
        "OpenClaw-managed channels cannot be deleted; disable them with PATCH instead. Stored legacy channels are deleted.",
      responses: jsonResponse("Channel deleted", successSchema),
    },
  },
  "/agents/{id}/channels/{cid}/connect": {
    post: {
      ...write("Connect an OpenClaw-managed channel"),
      requestBody: jsonBody({ type: "object", additionalProperties: true }, false),
    },
  },
  "/agents/{id}/channels/{cid}/login": {
    post: {
      ...write("Start QR/device login for an OpenClaw channel"),
      requestBody: jsonBody({ type: "object", additionalProperties: true }, false),
    },
  },
  "/agents/{id}/channels/{cid}/login/wait": {
    post: {
      ...write("Wait for an OpenClaw channel login attempt"),
      requestBody: jsonBody({ type: "object", additionalProperties: true }, false),
    },
  },
  "/agents/{id}/channels/{cid}/logout": {
    post: {
      ...write("Log out an OpenClaw-managed channel"),
      requestBody: jsonBody({ type: "object", additionalProperties: true }, false),
    },
  },
  "/agents/{id}/channels/{cid}/test": {
    post: {
      ...write("Test a stored channel adapter"),
      description: "OpenClaw-managed channels do not expose this legacy adapter test action.",
    },
  },
  "/agents/{id}/channels/{cid}/messages": {
    get: {
      ...read("List recent messages for a stored channel", [agentParam, channelParam]),
      description:
        "Message history is not available through this endpoint for OpenClaw-managed channels.",
      parameters: [
        agentParam,
        channelParam,
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, default: 50 } },
      ],
      responses: jsonResponse("Recent messages", {
        type: "array",
        items: { type: "object", additionalProperties: true },
      }),
    },
  },
};
