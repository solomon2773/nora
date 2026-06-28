// @ts-nocheck
// Assembles Nora's OpenAPI 3.1 document from hand-authored path fragments.
// Served at GET /api.json with an interactive reference at /api-docs (publicly
// /api/api.json and /api/api-docs — nginx strips the /api prefix).
//
// Coverage policy: the tier-1 routers (agents, monitoring, llm-providers,
// auth) are FULLY covered and enforced by the jest drift test
// (__tests__/openapi.test.ts) — adding a route to one of those routers without
// documenting it fails CI. Other routers (integrations, workspaces, channels,
// billing, admin) are documented in the Mintlify docs and will join the spec
// incrementally.

const agentsPaths = require("./paths/agents");
const monitoringPaths = require("./paths/monitoring");
const llmProvidersPaths = require("./paths/llmProviders");
const authPaths = require("./paths/auth");

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
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A session JWT from POST /auth/login, or a workspace API key (`nora_…`). API keys carry scopes — each operation lists its requirement under `x-required-scopes`. Session users skip scope checks (role-based guards apply instead).",
        },
      },
    },
    paths: {
      ...agentsPaths,
      ...monitoringPaths,
      ...llmProvidersPaths,
      ...authPaths,
    },
  };
}

module.exports = { buildOpenApiDocument };
