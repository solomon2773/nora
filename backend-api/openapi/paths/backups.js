// @ts-nocheck
// Managed agent backups contain full runtime state, so every operation is
// intentionally session-only even though the routes live under /agents.

const { agentParam, jsonBody, jsonResponse, pathParameter, successSchema } = require("../common");

const backupParam = pathParameter("backupId", "Backup UUID.", "uuid");
// Account-scoped operations resolve a backup by id and owner, so they carry no
// agent parameter and no agent-role requirement — the source agent may be gone.
const accountOperation = (summary, parameters = [backupParam]) => ({
  tags: ["Backups"],
  summary,
  parameters,
  "x-session-required": true,
  responses: jsonResponse("Success"),
});
const sessionOperation = (summary, parameters = [agentParam]) => ({
  tags: ["Backups"],
  summary,
  parameters,
  "x-session-required": true,
  "x-required-agent-role": "owner",
  responses: jsonResponse("Success"),
});

module.exports = {
  "/agents/{id}/backups": {
    get: {
      ...sessionOperation("List managed backups for an agent"),
      responses: jsonResponse("Agent backups", {
        type: "array",
        items: { $ref: "#/components/schemas/Backup" },
      }),
    },
    post: {
      ...sessionOperation("Queue a managed backup for an agent"),
      requestBody: jsonBody(
        {
          type: "object",
          properties: { name: { type: "string", maxLength: 160 } },
          additionalProperties: false,
        },
        false,
      ),
      responses: jsonResponse(
        "Backup record accepted for asynchronous capture",
        {
          type: "object",
          required: ["backup"],
          properties: { backup: { $ref: "#/components/schemas/Backup" } },
        },
        202,
      ),
    },
  },
  "/agents/{id}/backups/schedule": {
    get: {
      ...sessionOperation("Get an agent backup schedule and entitlement"),
      responses: jsonResponse("Schedule and effective backup entitlement", {
        type: "object",
        required: ["schedule", "entitlement"],
        properties: {
          schedule: { type: "object", additionalProperties: true },
          entitlement: { type: "object", additionalProperties: true },
        },
      }),
    },
    put: {
      ...sessionOperation("Create, update, enable, or disable an agent backup schedule"),
      requestBody: jsonBody({
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          name: { type: "string", maxLength: 160 },
          frequency: { type: "string", enum: ["hourly", "daily", "weekly"] },
          hour_utc: { type: "integer", minimum: 0, maximum: 23 },
          day_of_week: { type: "integer", minimum: 0, maximum: 6 },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Saved schedule and effective backup entitlement"),
    },
  },
  "/agents/{id}/backups/{backupId}/download": {
    get: {
      ...sessionOperation("Download a completed encrypted backup archive", [
        agentParam,
        backupParam,
      ]),
      responses: {
        200: {
          description: "Gzip backup archive.",
          headers: {
            "Content-Disposition": {
              schema: { type: "string" },
              description: "Attachment filename generated from the backup record.",
            },
          },
          content: { "application/gzip": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
  },
  "/agents/{id}/backups/{backupId}": {
    delete: {
      ...sessionOperation("Delete an agent backup and its stored archive", [
        agentParam,
        backupParam,
      ]),
      responses: jsonResponse("Deletion result", successSchema),
    },
  },
  "/agents/{id}/backups/{backupId}/restore": {
    post: {
      ...sessionOperation("Create a copy-restore deployment draft from a backup", [
        agentParam,
        backupParam,
      ]),
      description:
        "Operator routes only support copy restore. In-place restore is restricted to platform-admin backup routes.",
      requestBody: jsonBody(
        {
          type: "object",
          properties: { mode: { type: "string", enum: ["copy"], default: "copy" } },
          additionalProperties: false,
        },
        false,
      ),
      responses: jsonResponse("Migration/deployment draft populated from the backup"),
    },
  },
  // Account-scoped backup access. The agent-scoped routes above resolve the
  // agent first and 404 once it is deleted, which made backups unreachable in
  // exactly the disaster-recovery case they exist for (#338).
  "/backups": {
    get: {
      ...accountOperation("List every managed backup the caller owns", []),
      description:
        "Includes backups whose source agent has been deleted; each entry reports agent_exists so callers can distinguish an orphaned backup from a live one.",
      responses: jsonResponse("Owned agent backups, entitlement, and usage", {
        type: "object",
        required: ["backups", "entitlement", "usage"],
        properties: {
          backups: { type: "array", items: { $ref: "#/components/schemas/Backup" } },
          entitlement: { type: "object", additionalProperties: true },
          usage: { type: "object", additionalProperties: true },
        },
      }),
    },
  },
  "/backups/{backupId}/download": {
    get: {
      ...accountOperation("Download a backup archive by backup id"),
      responses: {
        200: {
          description: "Encrypted backup archive",
          content: { "application/gzip": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
  },
  "/backups/{backupId}": {
    delete: {
      ...accountOperation("Delete a backup and its stored archive by backup id"),
      responses: jsonResponse("Deletion result", successSchema),
    },
  },
  "/backups/{backupId}/restore": {
    post: {
      ...accountOperation("Create a copy-restore deployment draft by backup id"),
      description:
        "Works after the source agent has been deleted: copy restore provisions a fresh agent from the archive. In-place restore still requires the original agent and remains on the agent-scoped route.",
      requestBody: jsonBody(
        {
          type: "object",
          properties: { mode: { type: "string", enum: ["copy"], default: "copy" } },
          additionalProperties: false,
        },
        false,
      ),
      responses: jsonResponse("Migration/deployment draft populated from the backup"),
    },
  },
};
