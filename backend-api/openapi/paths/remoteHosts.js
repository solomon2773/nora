// @ts-nocheck
// Operator-owned remote Docker hosts. SSH material is accepted only on writes,
// encrypted at rest, and never returned by the API.

const { jsonBody, jsonResponse, pathParameter } = require("../common");

const hostParam = pathParameter(
  "id",
  "Remote-host slug (2-64 lowercase letters, numbers, or dashes).",
);
const workspaceParam = pathParameter("workspaceId", "Workspace UUID.", "uuid");
const remoteHostSchema = { $ref: "#/components/schemas/RemoteHost" };
const remoteHostInput = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,63}$" },
    hostId: { type: "string", description: "Alias for id." },
    label: { type: "string" },
    enabled: { type: "boolean" },
    isDefault: { type: "boolean" },
    sshHost: { type: "string" },
    sshPort: { type: "integer", minimum: 1, maximum: 65535, default: 22 },
    sshUser: { type: "string" },
    sshAuthMode: { type: "string", enum: ["key", "password"] },
    sshPrivateKey: { type: "string", writeOnly: true },
    sshPassword: { type: "string", writeOnly: true },
    sshPassphrase: { type: "string", writeOnly: true },
    clearSshPrivateKey: { type: "boolean" },
    clearSshPassword: { type: "boolean" },
    clearSshPassphrase: { type: "boolean" },
    gatewayHost: { type: "string" },
    dockerHost: { type: "string" },
  },
  additionalProperties: false,
};

const session = (summary, parameters = []) => ({
  tags: ["Remote Hosts"],
  summary,
  parameters,
  "x-session-required": true,
  responses: jsonResponse("Success"),
});

module.exports = {
  "/remote-hosts": {
    get: {
      ...session("List owned and workspace-shared remote hosts"),
      description:
        "Owned hosts include management access. Hosts shared through a workspace are read-only and include access/canDeploy annotations.",
      responses: jsonResponse("Accessible remote hosts with credentials masked", {
        type: "array",
        items: remoteHostSchema,
      }),
    },
    post: {
      ...session("Register a remote Docker host"),
      requestBody: jsonBody(remoteHostInput),
      responses: jsonResponse("Registered host with credentials masked", remoteHostSchema, 201),
    },
  },
  "/remote-hosts/{id}": {
    put: {
      ...session("Update an owned remote host", [hostParam]),
      requestBody: jsonBody(remoteHostInput),
      responses: jsonResponse("Updated host with credentials masked", remoteHostSchema),
    },
    delete: {
      ...session("Delete an owned remote host", [hostParam]),
      responses: jsonResponse("Deleted host metadata", remoteHostSchema),
    },
  },
  "/remote-hosts/{id}/test": {
    post: {
      ...session("Test SSH access and remote Docker availability", [hostParam]),
      responses: jsonResponse("Host with refreshed connection-test status", remoteHostSchema),
    },
  },
  "/remote-hosts/{id}/reset-host-key": {
    post: {
      ...session("Reset an owned remote host SSH key pin", [hostParam]),
      description:
        "Explicit recovery for a verified host rebuild or SSH key rotation. Clears the pin and previous Test result only; active use remains blocked until Test succeeds and pins the replacement key.",
      requestBody: jsonBody({
        type: "object",
        required: ["confirmation"],
        properties: {
          confirmation: {
            type: "string",
            description: "Exact remote-host label or id.",
          },
        },
        additionalProperties: false,
      }),
      responses: jsonResponse("Host with cleared pin and Test state", remoteHostSchema),
    },
  },
  "/remote-hosts/{id}/shares": {
    get: {
      ...session("List workspaces an owned remote host is shared with", [hostParam]),
      responses: jsonResponse("Remote-host workspace shares", {
        type: "array",
        items: { type: "object", additionalProperties: true },
      }),
    },
    post: {
      ...session("Share an owned remote host into a workspace", [hostParam]),
      requestBody: jsonBody({
        type: "object",
        properties: {
          workspace_id: { type: "string", format: "uuid" },
          workspaceId: { type: "string", format: "uuid", description: "Alias for workspace_id." },
        },
        anyOf: [{ required: ["workspace_id"] }, { required: ["workspaceId"] }],
        additionalProperties: false,
      }),
      responses: jsonResponse(
        "Updated share list",
        { type: "array", items: { type: "object", additionalProperties: true } },
        201,
      ),
    },
  },
  "/remote-hosts/{id}/shares/{workspaceId}": {
    delete: {
      ...session("Stop sharing an owned remote host with a workspace", [hostParam, workspaceParam]),
      responses: jsonResponse("Updated share list", {
        type: "array",
        items: { type: "object", additionalProperties: true },
      }),
    },
  },
};
