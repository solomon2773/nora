// @ts-nocheck
// Managed agent backups contain full runtime state, so every operation is
// intentionally session-only even though the routes live under /agents.

const { agentParam, jsonBody, jsonResponse, pathParameter, successSchema } = require("../common");

const backupParam = pathParameter("backupId", "Backup UUID.", "uuid");
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
};
