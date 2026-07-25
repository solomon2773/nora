// @ts-nocheck
const express = require("express");
const request = require("supertest");

const mockDbQuery = jest.fn();
const mockConnectIntegration = jest.fn();
const mockReplaceIntegration = jest.fn();
const mockListIntegrations = jest.fn();
const mockRemoveIntegration = jest.fn();
const mockUpdateIntegration = jest.fn();
const mockGetIntegrationsForSync = jest.fn();
const mockGetIntegrationEnvVars = jest.fn();
const mockTestIntegration = jest.fn();
const mockIntegrationProviderAffectsLlmAuth = jest.fn();
const mockWithProviderStateLock = jest.fn();
const mockSyncAuthToUserAgents = jest.fn();
const mockRpcCall = jest.fn();
const mockGetEnabledMcpRuntimeState = jest.fn();

jest.mock("../db", () => ({ query: mockDbQuery }));
jest.mock("../integrations", () => ({
  connectIntegration: mockConnectIntegration,
  replaceIntegration: mockReplaceIntegration,
  listIntegrations: mockListIntegrations,
  removeIntegration: mockRemoveIntegration,
  updateIntegration: mockUpdateIntegration,
  getIntegrationsForSync: mockGetIntegrationsForSync,
  getIntegrationEnvVars: mockGetIntegrationEnvVars,
  testIntegration: mockTestIntegration,
  integrationProviderAffectsLlmAuth: mockIntegrationProviderAffectsLlmAuth,
  normalizeEmailConfigInput: jest.fn(() => ({})),
}));
jest.mock("../llmProviders", () => ({
  withProviderStateLock: mockWithProviderStateLock,
}));
jest.mock("../mcpServers", () => ({
  getAvailableMcpServers: jest.fn(),
  setAgentMcpServerIds: jest.fn(),
  isSupportedProvider: jest.fn(() => false),
  getEnabledMcpRuntimeState: mockGetEnabledMcpRuntimeState,
}));
jest.mock("../runtimeAuth", () => ({ runtimeAuthHeaders: jest.fn(async () => ({})) }));
jest.mock("../crypto", () => ({ encrypt: jest.fn((value) => value), decrypt: jest.fn() }));
jest.mock("../gatewayProxy", () => ({ rpcCall: mockRpcCall }));
jest.mock("../authSync", () => ({
  runContainerCommand: jest.fn(),
  syncAuthToUserAgents: mockSyncAuthToUserAgents,
}));
jest.mock("../integrationRuntimeFiles", () => ({
  buildHermesIntegrationInstallCommand: jest.fn(() => "true"),
}));
jest.mock("../middleware/ownership", () => ({
  requireAccessibleAgent: jest.fn(() => (_req, _res, next) => next()),
}));
jest.mock("../middleware/auth", () => ({
  requireSession: jest.fn((_req, _res, next) => next()),
  scopeByMethod: jest.fn(() => (_req, _res, next) => next()),
}));
jest.mock("../../agent-runtime/lib/agentEndpoints", () => ({
  runtimeUrlForAgent: jest.fn((_agent, path) => `http://runtime.test:9090${path}`),
}));
jest.mock("../integrations/providers/wecomActivation", () => ({
  activateWecomForOpenClawAgent: jest.fn(),
  deactivateWecomForOpenClawAgent: jest.fn(),
  verifyWecomForOpenClawAgent: jest.fn(),
}));

const router = require("../routes/integrations");
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: "user-1" };
  next();
});
app.use(router);

const agent = {
  id: "agent-1",
  user_id: "user-1",
  container_id: "runtime-1",
  host: "172.18.0.10",
  runtime_host: "172.18.0.10",
  runtime_port: 9090,
  status: "running",
  gateway_token: "gateway-token",
  gateway_host_port: 19042,
  backend_type: "docker",
  runtime_family: "openclaw",
  deploy_target: "docker",
  execution_target_id: "docker",
  sandbox_profile: "standard",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [agent] });
  mockConnectIntegration.mockResolvedValue({ id: "integration-1", provider: "openai" });
  mockReplaceIntegration.mockResolvedValue({ id: "integration-1", provider: "openai" });
  mockListIntegrations.mockResolvedValue([]);
  mockRemoveIntegration.mockResolvedValue({ id: "integration-1", provider: "github" });
  mockUpdateIntegration.mockResolvedValue({ id: "integration-1", provider: "openai" });
  mockGetIntegrationsForSync.mockResolvedValue([]);
  mockGetIntegrationEnvVars.mockResolvedValue({});
  mockTestIntegration.mockResolvedValue({ success: true });
  mockIntegrationProviderAffectsLlmAuth.mockImplementation(
    (provider) => provider === "openai" || provider === "anthropic",
  );
  mockGetEnabledMcpRuntimeState.mockResolvedValue({
    enabledIds: [],
    entries: [],
    desiredServers: {},
    env: {},
    managedEnvNames: [],
  });
  mockWithProviderStateLock.mockImplementation(async (_userId, operation) => operation());
  mockSyncAuthToUserAgents.mockResolvedValue([{ agentId: "agent-1", status: "synced" }]);
  mockRpcCall.mockImplementation(async (_agent, method) =>
    method === "config.get" ? { hash: "config-hash" } : {},
  );
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({}),
  });
});

afterAll(() => {
  delete global.fetch;
});

describe("integration credential reconciliation routes", () => {
  it("holds the provider fence until an LLM-affecting integration sync completes", async () => {
    const events = [];
    let releaseSync;
    mockConnectIntegration.mockImplementation(async () => {
      events.push("mutation");
      return { id: "integration-1", provider: "openai" };
    });
    mockWithProviderStateLock.mockImplementation(async (_userId, operation) => {
      events.push("lock:start");
      const result = await operation();
      events.push("lock:end");
      return result;
    });
    mockSyncAuthToUserAgents.mockImplementation(
      () =>
        new Promise((resolve) => {
          events.push("sync:start");
          releaseSync = resolve;
        }),
    );

    let settled = false;
    const responsePromise = request(app)
      .post("/agents/agent-1/integrations")
      .send({ provider: "openai", token: "integration-secret" })
      .then((response) => {
        settled = true;
        return response;
      });

    for (let attempt = 0; attempt < 20 && !releaseSync; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(events).toEqual(["lock:start", "mutation", "sync:start"]);
    expect(settled).toBe(false);

    releaseSync([{ agentId: "agent-1", status: "synced" }]);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(events).toEqual(["lock:start", "mutation", "sync:start", "lock:end"]);
    expect(mockWithProviderStateLock).toHaveBeenCalledWith("user-1", expect.any(Function));
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", "agent-1", {
      providerLockHeld: true,
    });
  });

  it("returns a warning when failed reconciliation was safely stopped and quarantined", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      {
        agentId: "agent-1",
        status: "failed",
        error: "runtime unavailable",
        runtimeStopped: true,
        quarantinePersisted: true,
      },
    ]);

    const response = await request(app)
      .post("/agents/agent-1/integrations")
      .send({ provider: "openai", token: "integration-secret" });

    expect(response.status).toBe(200);
    expect(response.body.sync_warning).toMatch(/stopped and quarantined/i);
    expect(response.body.sync_results).toEqual([
      expect.objectContaining({ agentId: "agent-1", status: "failed" }),
    ]);
  });

  it("returns a committed 502 when stale credentials could not be contained", async () => {
    mockSyncAuthToUserAgents.mockResolvedValue([
      {
        agentId: "agent-1",
        status: "failed",
        error: "managed state write failed",
        runtimeStopped: false,
        quarantinePersisted: true,
      },
    ]);

    const response = await request(app)
      .post("/agents/agent-1/integrations")
      .send({ provider: "openai", token: "integration-secret" });

    expect(response.status).toBe(502);
    expect(response.body).toEqual(
      expect.objectContaining({
        committed: true,
        error: expect.stringMatching(/could not be stopped and quarantined/i),
        sync_results: [expect.objectContaining({ agentId: "agent-1", status: "failed" })],
      }),
    );
  });

  it.each(["running", "warning", "stopped"])(
    "routes deletion of the final non-LLM integration through exact managed-state revocation for a %s runtime",
    async (status) => {
      const runtimeAgent = { ...agent, status };
      mockDbQuery.mockResolvedValue({ rows: [runtimeAgent] });
      mockListIntegrations.mockResolvedValue([
        { id: "integration-1", provider: "github", cron_job_id: null },
      ]);
      mockRemoveIntegration.mockResolvedValue({
        id: "integration-1",
        provider: "github",
        cron_job_id: null,
      });
      mockGetIntegrationEnvVars
        .mockResolvedValueOnce({ GITHUB_TOKEN: "old-github-secret" })
        .mockResolvedValueOnce({});

      const response = await request(app).delete("/agents/agent-1/integrations/integration-1");

      expect(response.status).toBe(200);
      expect(mockWithProviderStateLock).toHaveBeenCalledWith("user-1", expect.any(Function));
      expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", "agent-1", {
        providerLockHeld: true,
        extraManagedEnvNames: ["GITHUB_TOKEN"],
      });
      if (status === "stopped") {
        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockRpcCall).not.toHaveBeenCalled();
      } else {
        expect(mockRpcCall).toHaveBeenCalledWith(runtimeAgent, "config.patch", {
          raw: JSON.stringify({ env: { GITHUB_TOKEN: null } }),
          baseHash: "config-hash",
        });
      }
    },
  );

  it("holds the provider fence through pre-invoke OAuth refresh without forcing auth restart", async () => {
    const events = [];
    let releaseManifestSync;
    mockWithProviderStateLock.mockImplementation(async (_userId, operation) => {
      events.push("lock:start");
      const result = await operation();
      events.push("lock:end");
      return result;
    });
    mockGetIntegrationsForSync.mockImplementation(async () => {
      events.push("credentials:refreshed");
      return [];
    });
    global.fetch = jest.fn(async (resource) => {
      const url = String(resource);
      if (url.endsWith("/integrations/sync")) {
        events.push("manifest:start");
        await new Promise((resolve) => {
          releaseManifestSync = resolve;
        });
        events.push("manifest:end");
      } else {
        events.push("tool:invoke");
      }
      return {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ ok: true }),
      };
    });

    const responsePromise = request(app)
      .post("/agents/agent-1/integrations/tools/invoke")
      .send({ toolName: "twitter_post", input: { text: "hello" } })
      .then((response) => response);

    for (let attempt = 0; attempt < 20 && !releaseManifestSync; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(events).toEqual(["lock:start", "credentials:refreshed", "manifest:start"]);

    releaseManifestSync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(events).toEqual([
      "lock:start",
      "credentials:refreshed",
      "manifest:start",
      "manifest:end",
      "lock:end",
      "tool:invoke",
    ]);
    expect(mockWithProviderStateLock).toHaveBeenCalledWith("user-1", expect.any(Function));
    expect(mockSyncAuthToUserAgents).not.toHaveBeenCalled();
  });

  it("marks an OAuth redirect as committed when post-save reconciliation fails", async () => {
    mockDbQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM integration_oauth_states")) {
        return {
          rows: [
            {
              state: "oauth-state",
              provider: "twitter",
              user_id: "user-1",
              agent_id: "agent-1",
              code_verifier: "verifier",
              client_id: "twitter-client",
              client_secret: null,
              config: {},
              redirect_path: "/app/agents/agent-1",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              agent_user_id: "user-1",
            },
          ],
        };
      }
      if (text.includes("DELETE FROM integration_oauth_states")) return { rows: [] };
      if (text.includes("FROM agents WHERE id")) return { rows: [agent] };
      return { rows: [] };
    });
    mockReplaceIntegration.mockResolvedValue({ id: "integration-twitter", provider: "twitter" });
    mockSyncAuthToUserAgents.mockRejectedValue(new Error("runtime sync crashed"));
    global.fetch = jest.fn(async (resource) => {
      const url = String(resource);
      if (url.includes("oauth2/token")) {
        return {
          ok: true,
          status: 200,
          text: jest
            .fn()
            .mockResolvedValue(
              JSON.stringify({ access_token: "twitter-access", token_type: "bearer" }),
            ),
        };
      }
      if (url.includes("/2/users/me")) {
        return {
          ok: true,
          status: 200,
          text: jest
            .fn()
            .mockResolvedValue(JSON.stringify({ data: { id: "tw-1", username: "nora" } })),
        };
      }
      return {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({}),
      };
    });

    const response = await request(app).get(
      "/integrations/twitter/oauth/callback?state=oauth-state&code=oauth-code",
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location, "http://nora.test");
    expect(location.searchParams.get("status")).toBe("error");
    expect(location.searchParams.get("committed")).toBe("true");
    expect(location.searchParams.get("error")).toMatch(/runtime credential reconciliation/i);
    expect(mockWithProviderStateLock).toHaveBeenCalledWith("user-1", expect.any(Function));
    expect(mockReplaceIntegration).toHaveBeenCalledWith(
      "agent-1",
      "twitter",
      "twitter-access",
      expect.objectContaining({ user_id: "tw-1", username: "nora" }),
    );
  });
});
