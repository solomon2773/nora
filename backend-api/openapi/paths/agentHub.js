// @ts-nocheck
// Agent Hub has two deliberately separate credentials:
// - the operator UI surface is session-only;
// - hosted catalog exchange uses a dedicated nora_hub_ installation key.

const { jsonBody, jsonResponse, pathParameter, successSchema } = require("../common");

const listingParam = pathParameter("id", "Local listing UUID or a remote listing identifier.");
const hubKeyParam = pathParameter("id", "Agent Hub installation-key UUID.", "uuid");
const listingSchema = { $ref: "#/components/schemas/AgentHubListing" };
const listingArray = { type: "array", items: listingSchema };

const session = (summary, parameters = []) => ({
  tags: ["Agent Hub"],
  summary,
  parameters,
  "x-session-required": true,
  responses: jsonResponse("Success"),
});

const hubKeySecurity = [{ agentHubApiKey: [] }];

module.exports = {
  "/agent-hub": {
    get: {
      ...session("List local built-in and shared Agent Hub templates"),
      responses: jsonResponse("Local template listings", listingArray),
    },
  },
  "/agent-hub/community": {
    get: {
      ...session("Browse the configured community Agent Hub catalog"),
      parameters: [
        {
          name: "refresh",
          in: "query",
          schema: { type: "boolean", default: false },
          description: "Bypass the short-lived remote catalog cache.",
        },
      ],
      responses: jsonResponse("Remote catalog envelope"),
    },
  },
  "/agent-hub/mine": {
    get: {
      ...session("List Agent Hub templates owned by the current user"),
      responses: jsonResponse("Owned template listings", listingArray),
    },
  },
  "/agent-hub/settings": {
    get: {
      ...session("Get effective Agent Hub sharing settings"),
      responses: jsonResponse("Agent Hub settings", {
        type: "object",
        additionalProperties: true,
      }),
    },
  },
  "/agent-hub/api-keys": {
    get: {
      ...session("List Agent Hub installation keys without raw secrets"),
      responses: jsonResponse("Installation-key metadata", {
        type: "array",
        items: { type: "object", additionalProperties: true },
      }),
    },
    post: {
      ...session("Create an Agent Hub installation key"),
      description: "The raw nora_hub_ key is returned once in the apiKey field.",
      requestBody: jsonBody(
        {
          type: "object",
          properties: { label: { type: "string", maxLength: 120 } },
          additionalProperties: false,
        },
        false,
      ),
      responses: jsonResponse(
        "New installation key including its one-time raw secret",
        { type: "object", additionalProperties: true },
        201,
      ),
    },
  },
  "/agent-hub/api-keys/{id}": {
    delete: {
      ...session("Revoke an Agent Hub installation key", [hubKeyParam]),
      responses: jsonResponse("Revoked installation-key metadata"),
    },
  },
  "/agent-hub/share": {
    post: {
      ...session("Publish an owned agent as an Agent Hub template"),
      description:
        "Captures the agent's portable files-only template, rejects likely secrets, and optionally submits it to the configured community hub.",
      requestBody: jsonBody({
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string", format: "uuid" },
          listingId: { type: ["string", "null"], description: "Owned listing to replace." },
          name: { type: "string", maxLength: 100 },
          description: { type: "string", maxLength: 1200 },
          category: { type: "string", maxLength: 60 },
          shareTarget: { type: "string", enum: ["internal", "community", "both"] },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Published listing", listingSchema),
    },
  },
  "/agent-hub/install": {
    post: {
      ...session("Install an Agent Hub template as a new agent"),
      requestBody: jsonBody({
        type: "object",
        required: ["listingId", "name"],
        properties: {
          listingId: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 100 },
          runtime_family: { type: "string", enum: ["openclaw", "hermes"] },
          deploy_target: { type: "string" },
          execution_target_id: { type: "string" },
          sandbox_profile: { type: "string" },
          image: { type: "string" },
          container_name: { type: "string" },
        },
        additionalProperties: true,
      }),
      responses: jsonResponse("Queued agent created from the template"),
    },
  },
  "/agent-hub/{id}": {
    get: {
      ...session("Get an accessible Agent Hub template with portable content", [listingParam]),
      responses: jsonResponse("Template detail", listingSchema),
    },
    patch: {
      ...session("Update an owned community template", [listingParam]),
      requestBody: jsonBody({
        type: "object",
        properties: {
          name: { type: "string", maxLength: 100 },
          description: { type: "string", maxLength: 1200 },
          category: { type: "string", maxLength: 60 },
          shareTarget: { type: "string", enum: ["internal", "community", "both"] },
          templatePayload: { type: "object", additionalProperties: true },
          defaults: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      }),
      responses: jsonResponse("Updated template detail", listingSchema),
    },
  },
  "/agent-hub/{id}/download": {
    get: {
      ...session("Download a portable Nora template package", [listingParam]),
      responses: {
        200: {
          description: "JSON template package returned as an attachment.",
          headers: { "Content-Disposition": { schema: { type: "string" } } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["listing", "defaults", "templatePayload"],
                properties: {
                  listing: { type: "object", additionalProperties: true },
                  snapshot: { type: ["object", "null"], additionalProperties: true },
                  defaults: { type: "object", additionalProperties: true },
                  templatePayload: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
  },
  "/agent-hub/{id}/report": {
    post: {
      ...session("Report a community Agent Hub listing", [listingParam]),
      requestBody: jsonBody({
        type: "object",
        required: ["reason"],
        properties: {
          reason: { type: "string", minLength: 1 },
          details: { type: "string" },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Created report id", {
        ...successSchema,
        properties: {
          ...successSchema.properties,
          reportId: { type: "string" },
        },
      }),
    },
  },
  "/agent-hub/catalog": {
    get: {
      tags: ["Agent Hub"],
      summary: "Fetch the published hosted Agent Hub catalog",
      security: hubKeySecurity,
      responses: jsonResponse("Hub identity and published catalog items", {
        type: "object",
        required: ["hub", "items"],
        properties: {
          hub: { type: "object", additionalProperties: true },
          items: listingArray,
        },
      }),
    },
  },
  "/agent-hub/catalog/{id}": {
    get: {
      tags: ["Agent Hub"],
      summary: "Fetch one hosted Agent Hub template with portable content",
      security: hubKeySecurity,
      parameters: [listingParam],
      responses: jsonResponse("Hosted template detail", listingSchema),
    },
  },
  "/agent-hub/submissions": {
    post: {
      tags: ["Agent Hub"],
      summary: "Submit a portable template to a hosted Agent Hub for review",
      security: hubKeySecurity,
      requestBody: jsonBody({
        type: "object",
        properties: {
          listing: { type: "object", additionalProperties: true },
          templatePayload: { type: "object", additionalProperties: true },
          defaults: { type: "object", additionalProperties: true },
          snapshot: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      }),
      responses: jsonResponse(
        "Submission accepted for review",
        {
          type: "object",
          required: ["id", "listingId", "status"],
          properties: {
            id: { type: "string" },
            listingId: { type: "string" },
            status: { type: "string" },
          },
        },
        202,
      ),
    },
  },
};
