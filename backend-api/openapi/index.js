// @ts-nocheck
// Assembles Nora's OpenAPI 3.1 document from hand-authored path fragments.
// Served at GET /api.json with an interactive reference at /api-docs (publicly
// /api/api.json and /api/api-docs — nginx strips the /api prefix).
//
// Coverage policy: every path fragment below is checked against the Express
// router that serves it. Complete routers fail CI when a route is added without
// documentation; partial routers (currently admin) still fail CI if a
// documented operation disappears. Every operation receives a deterministic,
// unique operationId so generated clients have a stable symbol surface.

const agentsPaths = require("./paths/agents");
const monitoringPaths = require("./paths/monitoring");
const llmProvidersPaths = require("./paths/llmProviders");
const authPaths = require("./paths/auth");
const workspacesPaths = require("./paths/workspaces");
const integrationsPaths = require("./paths/integrations");
const channelsPaths = require("./paths/channels");
const backupsPaths = require("./paths/backups");
const agentHubPaths = require("./paths/agentHub");
const remoteHostsPaths = require("./paths/remoteHosts");
const adminPaths = require("./paths/admin");

function pascalCase(value) {
  return String(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function operationIdFor(method, path) {
  const suffix = String(path)
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const parameter = segment.match(/^\{(.+)\}$/);
      return parameter ? `By${pascalCase(parameter[1])}` : pascalCase(segment);
    })
    .join("");
  return `${String(method).toLowerCase()}${suffix || "Root"}`;
}

function addOperationIds(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([path, operations]) => [
      path,
      Object.fromEntries(
        Object.entries(operations).map(([method, operation]) => [
          method,
          {
            ...operation,
            operationId: operation.operationId || operationIdFor(method, path),
          },
        ]),
      ),
    ]),
  );
}

function buildOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Nora Control Plane API",
      version: process.env.NORA_VERSION || "1.10",
      description:
        "Operator API for the Nora self-hosted agent ops platform: deploy and manage agent runtimes, budgets, monitoring, and LLM provider keys. Authenticate with a session JWT or a scoped workspace API key (`nora_…`).",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [
      {
        url: "/api",
        description:
          "Same-origin via nginx (the /api prefix is stripped before reaching the backend).",
      },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Agents", description: "Agent lifecycle: deploy, start/stop, versions." },
      { name: "Budgets", description: "Per-agent LLM spend caps with auto-pause." },
      {
        name: "Schedules",
        description: "Recurring cron triggers for agent prompts and lifecycle actions.",
      },
      { name: "Monitoring", description: "Metrics, events, cost, and the fleet roll-up." },
      { name: "LLM Providers", description: "Encrypted provider key management." },
      { name: "Auth", description: "Session endpoints (JWT + HttpOnly cookie)." },
      { name: "Hermes", description: "Hermes-runtime specific operations." },
      { name: "Workspaces", description: "Workspace metadata, members, invitations, and agents." },
      { name: "API Keys", description: "Session-only workspace API-key lifecycle." },
      { name: "Alerts", description: "Workspace alert rules and delivery tests." },
      { name: "Integrations", description: "Integration catalog and agent credentials/tools." },
      { name: "Channels", description: "Agent communication-channel configuration and actions." },
      { name: "Backups", description: "Agent backup, schedule, download, and copy-restore flows." },
      { name: "Agent Hub", description: "Browse, publish, install, and exchange agent templates." },
      { name: "Remote Hosts", description: "Session-only BYOC SSH host registry and sharing." },
      { name: "Admin", description: "Platform-administrator diagnostics." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A session JWT from POST /auth/login, or a workspace API key (`nora_…`). API keys carry scopes — each operation lists its requirement under `x-required-scopes`. Session users skip scope checks (role-based guards apply instead).",
        },
        agentHubApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-Agent-Hub-Api-Key",
          description:
            "Installation key (`nora_hub_…`) for hosted Agent Hub catalog exchange. `X-Api-Key`, `Api-Key`, and Bearer transport are also accepted by the server.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
          additionalProperties: true,
        },
        Success: {
          type: "object",
          required: ["success"],
          properties: { success: { type: "boolean" } },
          additionalProperties: true,
        },
        Workspace: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            role: { type: "string", enum: ["viewer", "editor", "admin", "owner"] },
            created_at: { type: "string", format: "date-time" },
            agent_count: { type: "integer" },
            member_count: { type: "integer" },
          },
          additionalProperties: true,
        },
        ApiKey: {
          type: "object",
          required: ["id", "label", "scopes", "status"],
          properties: {
            id: { type: "string", format: "uuid" },
            workspaceId: { type: "string", format: "uuid" },
            label: { type: "string" },
            keyPrefix: { type: "string" },
            maskedKey: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["active", "revoked"] },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            apiKey: {
              type: "string",
              description: "Returned once, only when the key is created.",
            },
          },
          additionalProperties: true,
        },
        Integration: {
          type: "object",
          required: ["id", "provider"],
          properties: {
            id: { type: "string" },
            agent_id: { type: "string", format: "uuid" },
            provider: { type: "string" },
            config: { type: "object", additionalProperties: true },
            status: { type: "string" },
            connectivity: { type: "object", additionalProperties: true },
          },
          additionalProperties: true,
        },
        Channel: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            config: { type: "object", additionalProperties: true },
          },
          additionalProperties: true,
        },
        Backup: {
          type: "object",
          required: ["id", "status"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            kind: { type: "string" },
            status: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
          additionalProperties: true,
        },
        AgentHubListing: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            category: { type: "string" },
            source_type: { type: "string" },
            status: { type: "string" },
            current_version: { type: "integer" },
          },
          additionalProperties: true,
        },
        RemoteHost: {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: { type: "string" },
            executionTargetId: { type: "string", pattern: "^remote:" },
            adapter: { type: "string", enum: ["remote-docker"] },
            deployTarget: { type: "string", enum: ["remote-docker"] },
            label: { type: "string" },
            sshHost: { type: "string" },
            sshPort: { type: "integer" },
            sshUser: { type: "string" },
            sshAuthMode: { type: "string", enum: ["key", "password"] },
            lastTestStatus: { type: "string" },
            access: { type: "string" },
            canDeploy: { type: "boolean" },
          },
          additionalProperties: true,
        },
      },
    },
    paths: addOperationIds({
      ...agentsPaths,
      ...monitoringPaths,
      ...llmProvidersPaths,
      ...authPaths,
      ...workspacesPaths,
      ...integrationsPaths,
      ...channelsPaths,
      ...backupsPaths,
      ...agentHubPaths,
      ...remoteHostsPaths,
      ...adminPaths,
    }),
  };
}

module.exports = { buildOpenApiDocument, operationIdFor };
