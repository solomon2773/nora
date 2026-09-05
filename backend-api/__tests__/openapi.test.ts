// @ts-nocheck
// OpenAPI anti-rot: the spec must cover every route the tier-1 routers
// actually serve, and must not document routes that no longer exist. Requiring
// the routers pulls in db/queue modules — reuse the same mocks the route tests
// use so introspection works without infrastructure.

process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);

jest.mock("../db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../redisQueue", () => ({
  deployQueue: { getJobCounts: jest.fn() },
  addDeploymentJob: jest.fn(),
  addBackupJob: jest.fn(),
  addKubernetesPolicyReconcileJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  canDestroy: jest.fn(),
  isKubernetesAgent: jest.fn(),
  status: jest.fn(),
}));
jest.mock("../authSync", () => ({
  runContainerCommand: jest.fn(),
  syncAuthToUserAgents: jest.fn(),
}));
jest.mock("../gatewayProxy", () => ({ rpcCall: jest.fn() }));

const { listRouterPaths } = require("../openapi/routerPaths");
const { buildOpenApiDocument } = require("../openapi");

// Fully documented routers and their mount prefixes (must match server.ts).
// Nested workspace routers are listed independently because Express does not
// retain a portable mount-path string on child router layers.
const COMPLETE_ROUTERS = [
  { name: "agents", router: () => require("../routes/agents"), mount: "/agents" },
  { name: "monitoring", router: () => require("../routes/monitoring"), mount: "" },
  {
    name: "llmProviders",
    router: () => require("../routes/llmProviders"),
    mount: "/llm-providers",
  },
  { name: "auth", router: () => require("../routes/auth"), mount: "/auth" },
  { name: "workspaces", router: () => require("../routes/workspaces"), mount: "/workspaces" },
  {
    name: "workspaceApiKeys",
    router: () => require("../routes/apiKeys"),
    mount: "/workspaces/:id/api-keys",
  },
  {
    name: "workspaceAlertRules",
    router: () => require("../routes/alertRules"),
    mount: "/workspaces/:id/alert-rules",
  },
  {
    name: "workspaceCost",
    router: () => require("../routes/workspaceCost"),
    mount: "/workspaces/:id",
  },
  { name: "integrations", router: () => require("../routes/integrations"), mount: "" },
  { name: "channels", router: () => require("../routes/channels"), mount: "/agents" },
  { name: "backups", router: () => require("../routes/backups"), mount: "/agents" },
  {
    name: "accountBackups",
    router: () => require("../routes/accountBackups"),
    mount: "/backups",
  },
  { name: "agentHub", router: () => require("../routes/agentHub"), mount: "/agent-hub" },
  {
    name: "agentHubPublic",
    router: () => require("../routes/agentHubPublic"),
    mount: "/agent-hub",
  },
  {
    name: "remoteHosts",
    router: () => require("../routes/remoteHosts"),
    mount: "/remote-hosts",
  },
];

// Admin has many browser-only implementation routes. Doctor is the one stable
// public automation contract documented today; stale checking still verifies
// it exists without claiming complete admin coverage.
const PARTIAL_ROUTERS = [
  { name: "admin", router: () => require("../routes/admin"), mount: "/admin" },
];

function specOperationKeys(doc) {
  const keys = new Set();
  for (const [path, ops] of Object.entries(doc.paths || {})) {
    for (const method of Object.keys(ops || {})) {
      keys.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys;
}

describe("OpenAPI document", () => {
  const doc = buildOpenApiDocument();

  it("is a structurally sane 3.1 document", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toMatch(/Nora/);
    expect(doc.servers[0].url).toBe("/api");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(100);
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(doc.components.securitySchemes.agentHubApiKey.name).toBe("X-Agent-Hub-Api-Key");
  });

  it("gives every operation a tag, summary, and unique operationId", () => {
    const knownTags = new Set(doc.tags.map((t) => t.name));
    const operationIds = new Set();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(`${method.toUpperCase()} ${path}: ${op.summary || "MISSING SUMMARY"}`).not.toMatch(
          /MISSING SUMMARY/,
        );
        expect(Array.isArray(op.tags) && op.tags.length > 0).toBe(true);
        for (const tag of op.tags) {
          expect(knownTags.has(tag) ? tag : `unknown tag "${tag}" on ${path}`).toBe(tag);
        }
        expect(op.operationId).toMatch(/^[a-z][A-Za-z0-9]+$/);
        expect(
          operationIds.has(op.operationId) ? `duplicate operationId ${op.operationId}` : null,
        ).toBeNull();
        operationIds.add(op.operationId);
      }
    }
  });

  describe("drift against registered routers", () => {
    const specKeys = specOperationKeys(doc);

    for (const entry of COMPLETE_ROUTERS) {
      it(`covers every route in routes/${entry.name}`, () => {
        const served = listRouterPaths(entry.router(), entry.mount);
        const missing = served.filter((key) => !specKeys.has(key));
        expect(missing).toEqual([]);
      });
    }

    it("documents no operation missing from the registered router inventory", () => {
      const inventory = [...COMPLETE_ROUTERS, ...PARTIAL_ROUTERS];
      const served = new Set(
        inventory.flatMap((entry) => listRouterPaths(entry.router(), entry.mount)),
      );
      const stale = [...specKeys].filter((key) => !served.has(key));
      expect(stale).toEqual([]);
    });
  });

  it("marks sensitive cross-boundary surfaces as session-only", () => {
    expect(doc.paths["/agent-hub/install"].post["x-session-required"]).toBe(true);
    expect(doc.paths["/agents/{id}/backups"].get["x-session-required"]).toBe(true);
    expect(doc.paths["/llm-providers"].post["x-session-required"]).toBe(true);
    expect(doc.paths["/llm-providers/{id}"].put["x-session-required"]).toBe(true);
    expect(doc.paths["/llm-providers/{id}"].delete["x-session-required"]).toBe(true);
    expect(doc.paths["/llm-providers/sync"].post["x-session-required"]).toBe(true);
    expect(doc.paths["/remote-hosts"].get["x-session-required"]).toBe(true);
  });

  it("uses the dedicated installation-key scheme for hosted Agent Hub exchange", () => {
    expect(doc.paths["/agent-hub/catalog"].get.security).toEqual([{ agentHubApiKey: [] }]);
    expect(doc.paths["/agent-hub/submissions"].post.security).toEqual([{ agentHubApiKey: [] }]);
  });

  it("documents runtime auth bootstrap fields and the optional signup challenge token", () => {
    const bootstrapSchema =
      doc.paths["/auth/bootstrap-status"].get.responses[200].content["application/json"].schema;
    expect(bootstrapSchema.required).toEqual(
      expect.arrayContaining([
        "needsFirstAdmin",
        "oauthLoginEnabled",
        "platformMode",
        "signupEnabled",
        "signupBotProtection",
      ]),
    );
    expect(bootstrapSchema.properties.platformMode.enum).toEqual(["selfhosted", "paas"]);
    expect(bootstrapSchema.properties.signupEnabled).toEqual({ type: "boolean" });

    const signupSchema =
      doc.paths["/auth/signup"].post.requestBody.content["application/json"].schema;
    expect(signupSchema.required).toEqual(["email", "password"]);
    expect(signupSchema.properties.botProtectionToken).toEqual(
      expect.objectContaining({ type: "string" }),
    );

    const signupDisabledResponse = doc.paths["/auth/signup"].post.responses[403];
    expect(signupDisabledResponse.description).toMatch(/disabled/i);
    expect(signupDisabledResponse.content["application/json"].schema.properties.code).toEqual(
      expect.objectContaining({ type: "string", enum: ["SIGNUP_DISABLED"] }),
    );

    const oauthSignupDisabledResponse = doc.paths["/auth/oauth-login"].post.responses[403];
    expect(oauthSignupDisabledResponse.description).toMatch(/registration.*disabled/i);
    expect(oauthSignupDisabledResponse.content["application/json"].schema.properties.code).toEqual(
      expect.objectContaining({ type: "string", enum: ["SIGNUP_DISABLED"] }),
    );
  });

  it("documents the strong external-runtime gateway token contract", () => {
    const adoptSchema =
      doc.paths["/agents/adopt"].post.requestBody.content["application/json"].schema;
    expect(adoptSchema.required).toEqual(
      expect.arrayContaining(["runtime_family", "gateway_token"]),
    );
    expect(adoptSchema.properties.gateway_token).toEqual(
      expect.objectContaining({ type: "string", minLength: 32, maxLength: 4096 }),
    );
    expect(doc.paths["/agents/adopt"].post.responses[400].description).toMatch(
      /weak gateway token/i,
    );
  });
});
