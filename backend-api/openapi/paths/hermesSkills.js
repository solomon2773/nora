// @ts-nocheck
// Hermes skills: registry browsing, per-agent skill state and async
// install/delete jobs, and the instance-curated Skills Library. Registry and
// library reads are open to any authenticated principal; agent-scoped
// operations follow the Hermes WebUI access model (workspace viewer for reads,
// editor for mutations) and carry agents:* scopes for API keys.

const { jsonBody, jsonResponse, pathParameter } = require("../common");

const agentParam = pathParameter("agentId", "Agent UUID.", "uuid");
const jobParam = pathParameter("jobId", "Hermes skill job id.");
const libraryEntryParam = pathParameter("id", "Library entry UUID.", "uuid");

const registrySkillSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ref: { type: "string", description: "Registry ref, e.g. official/security/1password." },
    name: { type: "string" },
    description: { type: "string" },
  },
};

const agentSkillStateSchema = {
  type: "object",
  required: ["skills"],
  properties: {
    skills: {
      type: "array",
      description:
        "Saved entries merged with the runtime lockfile and in-flight queue jobs; status covers installed / pending_install / pending_delete transitions.",
      items: { type: "object", additionalProperties: true },
    },
  },
};

const skillJobAcceptedSchema = {
  type: "object",
  required: ["jobId", "agentId", "name", "operation", "status"],
  properties: {
    jobId: { type: "string" },
    agentId: { type: "string", format: "uuid" },
    name: { type: "string" },
    operation: { type: "string", enum: ["install", "delete"] },
    status: { type: "string" },
  },
};

const libraryEntrySchema = {
  type: "object",
  required: ["id", "ref", "name"],
  properties: {
    id: { type: "string", format: "uuid" },
    ref: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    addedByUserId: { type: ["string", "null"], format: "uuid" },
    createdAt: { type: ["string", "null"], format: "date-time" },
  },
};

module.exports = {
  "/hermes-skills/skills": {
    get: {
      tags: ["Hermes"],
      summary: "List Hermes registry skills",
      parameters: [
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 50 },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      responses: jsonResponse("Registry page with skills and an optional next cursor", {
        type: "object",
        additionalProperties: true,
        properties: {
          skills: { type: "array", items: registrySkillSchema },
          nextCursor: { type: ["string", "null"] },
        },
      }),
    },
  },
  "/hermes-skills/skills/search": {
    get: {
      tags: ["Hermes"],
      summary: "Search Hermes registry skills",
      parameters: [
        { name: "q", in: "query", required: true, schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 50 },
        },
      ],
      responses: jsonResponse("Matching registry skills", {
        type: "object",
        additionalProperties: true,
        properties: { skills: { type: "array", items: registrySkillSchema } },
      }),
    },
  },
  "/hermes-skills/skills/detail": {
    get: {
      tags: ["Hermes"],
      summary: "Get one Hermes registry skill by ref",
      description:
        "The ref travels as a query parameter because registry identifiers contain slashes.",
      parameters: [{ name: "ref", in: "query", required: true, schema: { type: "string" } }],
      responses: jsonResponse("Registry skill detail", registrySkillSchema),
    },
  },
  "/hermes-skills/agents/{agentId}/skills": {
    get: {
      tags: ["Hermes"],
      summary: "List a Hermes agent's skill state",
      description:
        "Requires a running or warning Hermes agent; merges saved entries, the runtime lockfile, and pending jobs.",
      parameters: [agentParam],
      "x-required-scopes": ["agents:read"],
      responses: jsonResponse("Merged skill state", agentSkillStateSchema),
    },
  },
  "/hermes-skills/agents/{agentId}/skills/install": {
    post: {
      tags: ["Hermes"],
      summary: "Queue a Hermes skill install",
      description:
        "Workspace editor role required. Returns the existing job when an install for the same skill is already in flight; 409 conflicting_job when a delete is.",
      parameters: [agentParam],
      "x-required-scopes": ["agents:write"],
      requestBody: jsonBody({
        type: "object",
        required: ["ref", "name"],
        properties: {
          ref: { type: "string" },
          name: {
            type: "string",
            description:
              "Reconciliation identity: must start with a letter or digit and contain only letters, digits, dots, hyphens, or underscores; Nora-reserved names are rejected.",
          },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Install job queued", skillJobAcceptedSchema, 202),
    },
  },
  "/hermes-skills/agents/{agentId}/skills/delete": {
    post: {
      tags: ["Hermes"],
      summary: "Queue a Hermes skill removal",
      description:
        "Workspace editor role required. Returns the existing job when a delete for the same skill is already in flight; 409 conflicting_job when an install is.",
      parameters: [agentParam],
      "x-required-scopes": ["agents:write"],
      requestBody: jsonBody({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      }),
      responses: jsonResponse("Delete job queued", skillJobAcceptedSchema, 202),
    },
  },
  "/hermes-skills/jobs/{jobId}": {
    get: {
      tags: ["Hermes"],
      summary: "Get Hermes skill job status",
      description: "Resolves 404 rather than 403 when the caller cannot access the job's agent.",
      parameters: [jobParam],
      "x-required-scopes": ["agents:read"],
      responses: jsonResponse("Job status", {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          operation: { type: "string", enum: ["install", "delete"] },
          agentId: { type: "string", format: "uuid" },
        },
      }),
    },
  },
  "/hermes-skills/library": {
    get: {
      tags: ["Hermes"],
      summary: "List the instance Skills Library",
      responses: jsonResponse("Curated library entries", {
        type: "object",
        required: ["skills"],
        properties: { skills: { type: "array", items: libraryEntrySchema } },
      }),
    },
    post: {
      tags: ["Hermes"],
      summary: "Pin a skill to the Skills Library",
      description:
        "Insert-or-return-existing keyed on ref: a re-add returns 200 with the original entry instead of clobbering it.",
      requestBody: jsonBody({
        type: "object",
        required: ["ref", "name"],
        properties: {
          ref: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
        },
        additionalProperties: false,
      }),
      responses: {
        ...jsonResponse("Library entry created", libraryEntrySchema, 201),
        ...jsonResponse("Entry for this ref already existed", libraryEntrySchema, 200),
      },
    },
  },
  "/hermes-skills/library/{id}": {
    delete: {
      tags: ["Hermes"],
      summary: "Remove a Skills Library entry",
      parameters: [libraryEntryParam],
      responses: { 204: { description: "Entry removed" } },
    },
  },
};
