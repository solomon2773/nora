// @ts-nocheck
/**
 * __tests__/apiKeys.test.ts — workspace-scoped API key issuance, listing,
 * revocation, and verification. Mocks db so the SQL surface is pinned without
 * needing Postgres. Also covers the auth middleware's API-key intake path
 * (Bearer "nora_..." tokens) end-to-end.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;
process.env.NORA_API_KEY_HASH_SECRET = "test-api-key-hash-secret-must-be-32+chars-long";

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../monitoring", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
  getMetrics: jest.fn().mockResolvedValue({}),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  IS_PAAS: false,
  enforceLimits: jest
    .fn()
    .mockResolvedValue({ allowed: true, subscription: { plan: "selfhosted" } }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
}));

const apiKeys = require("../apiKeys");

beforeEach(() => {
  mockDb.query.mockReset();
});

describe("apiKeys.createApiKey", () => {
  it("validates that scopes are non-empty", async () => {
    await expect(
      apiKeys.createApiKey("ws-1", "user-1", { label: "Test", scopes: [] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects unknown scopes", async () => {
    await expect(
      apiKeys.createApiKey("ws-1", "user-1", { label: "T", scopes: ["agents:nuke"] }),
    ).rejects.toThrow(/Unknown API scope/);
  });

  it("issues a key with prefix nora_, returns the raw token once", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "k-1",
          workspace_id: "ws-1",
          created_by: "user-1",
          label: "Test",
          key_prefix: "nora_xxxx",
          scopes: ["agents:read"],
          status: "active",
          created_at: new Date().toISOString(),
        },
      ],
    });

    const created = await apiKeys.createApiKey("ws-1", "user-1", {
      label: "Test",
      scopes: ["agents:read"],
    });

    expect(created.apiKey).toMatch(/^nora_/);
    expect(created.id).toBe("k-1");
    expect(created.scopes).toEqual(["agents:read"]);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [, params] = mockDb.query.mock.calls[0];
    // workspace_id, created_by, label, key_hash, key_prefix, scopes_json, status, expires_at
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("user-1");
    expect(params[6]).toBe("active");
    expect(params[3]).toMatch(/^[a-f0-9]{64}$/); // hex sha256
  });

  it("rejects when workspaceId missing", async () => {
    await expect(
      apiKeys.createApiKey(null, "user-1", { label: "T", scopes: ["agents:read"] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("apiKeys.verifyApiKey", () => {
  it("returns null when token is empty", async () => {
    expect(await apiKeys.verifyApiKey("")).toBeNull();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("returns null when no row matches", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    expect(await apiKeys.verifyApiKey("nora_xxx")).toBeNull();
    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain("JOIN users u ON u.id = k.created_by");
    expect(sql).toContain("JOIN workspace_members issuer_membership");
    expect(sql).toContain("issuer_membership.workspace_id = k.workspace_id");
    expect(sql).not.toContain("w.user_id = k.created_by");
  });

  it("rejects a former workspace creator's key after removal when another owner remains", async () => {
    const workspace = { id: "ws-1", user_id: "former-owner", name: "Prod" };
    const memberships = [{ workspace_id: "ws-1", user_id: "current-owner", role: "owner" }];
    const key = {
      id: "k-former-owner",
      workspace_id: workspace.id,
      created_by: workspace.user_id,
    };

    mockDb.query.mockImplementationOnce(async (sql) => {
      expect(sql).toContain("JOIN workspace_members issuer_membership");
      expect(sql).not.toContain("w.user_id = k.created_by");

      const issuerIsCurrentMember = memberships.some(
        (member) => member.workspace_id === key.workspace_id && member.user_id === key.created_by,
      );
      return { rows: issuerIsCurrentMember ? [key] : [] };
    });

    await expect(apiKeys.verifyApiKey("nora_former_owner")).resolves.toBeNull();
    expect(memberships).toContainEqual(
      expect.objectContaining({ user_id: "current-owner", role: "owner" }),
    );
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("returns the key + workspace + user envelope on a match", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "doesnotmatter",
            key_prefix: "nora_xxxx",
            scopes: ["agents:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "owner@x.com",
            user_role: "user",
            user_name: "Owner",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // last_used_at update (or rehash)

    const verified = await apiKeys.verifyApiKey("nora_anytoken");
    expect(verified).toMatchObject({
      key: { id: "k-1", scopes: ["agents:read"] },
      workspace: { id: "ws-1", name: "Prod" },
      user: { id: "user-1", email: "owner@x.com" },
    });
  });
});

describe("API key endpoints (HTTP)", () => {
  // Lazily require the app so jest mocks above are applied.
  jest.mock("../workspaces", () => ({
    listWorkspaces: jest.fn().mockResolvedValue([]),
    createWorkspace: jest.fn(),
    addAgent: jest.fn(),
    getWorkspaceAgents: jest.fn().mockResolvedValue([]),
    listAgentCandidates: jest.fn().mockResolvedValue([]),
    removeAgent: jest.fn(),
    listAccessibleAgents: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../workspaceMembers", () => ({
    listMembers: jest.fn().mockResolvedValue([]),
    listInvitations: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../integrations", () => ({
    connectIntegration: jest.fn(),
    listIntegrations: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../channels", () => ({
    listChannels: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../llmProviders", () => ({
    getAvailableProviders: jest.fn().mockReturnValue([]),
    listProviders: jest.fn().mockResolvedValue([]),
    PROVIDERS: [],
  }));
  jest.mock("../metrics", () => ({
    parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
    recordApiMetric: jest.fn(),
    getAgentSummary: jest.fn().mockResolvedValue({}),
    getAgentMetrics: jest.fn().mockResolvedValue([]),
    getAgentCost: jest.fn().mockResolvedValue(null),
    getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
    getAccessibleWorkspaceCosts: jest
      .fn()
      .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  }));

  const app = require("../server");
  const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
  const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);

  it("GET /workspaces/:id/api-keys/scopes returns the scope catalog", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "user-1", role: "viewer" }],
    });

    const res = await auth(request(app).get("/workspaces/ws-1/api-keys/scopes"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.find((s) => s.value === "agents:read")).toBeDefined();
    expect(res.body.find((s) => s.value === "admin:read")).toBeDefined();
  });

  it("POST /workspaces/:id/api-keys requires admin role", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "editor" }],
    });
    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/api-keys")
        .send({ label: "ci", scopes: ["agents:read"] }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /workspaces/:id/api-keys issues a key for admins", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "admin" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            label: "ci",
            key_prefix: "nora_abcd",
            scopes: ["agents:read"],
            status: "active",
            created_at: new Date().toISOString(),
          },
        ],
      });

    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/api-keys")
        .send({ label: "ci", scopes: ["agents:read"] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatch(/^nora_/);
    expect(res.body.scopes).toEqual(["agents:read"]);
  });

  it("DELETE /workspaces/:id/api-keys/:keyId revokes when admin", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "admin" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            label: "old",
            key_prefix: "nora_xxx",
            scopes: ["agents:read"],
            status: "revoked",
            created_at: new Date().toISOString(),
          },
        ],
      });

    const res = await auth(request(app).delete("/workspaces/ws-1/api-keys/k-1"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revoked");
  });
});

describe("auth middleware: API key intake", () => {
  const app = require("../server");

  it("rejects bearer 'nora_...' that doesn't verify", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // verifyApiKey misses
    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_invalid_token_value_here");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or expired API key/);
  });

  it("authenticates a request with a valid 'nora_' Bearer", async () => {
    mockDb.query
      // verifyApiKey: matched row + workspace + user joined
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "anything",
            key_prefix: "nora_yyyy",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "owner@x.com",
            user_role: "user",
            user_name: "Owner",
          },
        ],
      })
      // verifyApiKey: last_used_at update
      .mockResolvedValueOnce({ rows: [] })
      // listWorkspaces (the route the request lands on) — return empty for simplicity
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_validtoken");
    expect(res.status).toBe(200);
  });

  it("rejects API-key request to /workspaces when scope is missing", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-3",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["agents:read"], // no workspaces:read
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_underscoped");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(res.body.error).toMatch(/workspaces:read/);
  });

  it("keeps Agent Hub and backup state behind session authentication", async () => {
    const keyRow = {
      id: "k-sensitive",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["agents:read", "agents:write", "integrations:read", "integrations:write"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };

    mockDb.query.mockResolvedValueOnce({ rows: [keyRow] }).mockResolvedValueOnce({ rows: [] });
    const hub = await request(app)
      .get("/agent-hub")
      .set("Authorization", "Bearer nora_sensitive_hub");
    expect(hub.status).toBe(403);
    expect(hub.body.code).toBe("session_required");

    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-1", backend_type: "docker", deploy_target: "docker" }],
      });
    const backups = await request(app)
      .get("/agents/agent-1/backups")
      .set("Authorization", "Bearer nora_sensitive_backup");
    expect(backups.status).toBe(403);
    expect(backups.body.code).toBe("session_required");
  });

  it("requires integration scopes before an API key can reach channel ownership", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-channels",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["agents:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-1", backend_type: "docker", deploy_target: "docker" }],
      });

    const res = await request(app)
      .get("/agents/agent-1/channels")
      .set("Authorization", "Bearer nora_channels_readonly");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(res.body.error).toMatch(/integrations:read/);
  });

  it("accepts monitoring:read alone for assigned agent metrics", async () => {
    const keyRow = {
      id: "k-monitoring-only",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["monitoring:read"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-1", backend_type: "docker", deploy_target: "docker" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            user_id: "user-1",
            backend_type: "docker",
            deploy_target: "docker",
          },
        ],
      });

    const res = await request(app)
      .get("/agents/agent-1/metrics")
      .set("Authorization", "Bearer nora_monitoring_only");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rechecks the exact key-workspace assignment before agent metrics", async () => {
    const metrics = require("../metrics");
    metrics.getAgentMetrics.mockClear();
    const keyRow = {
      id: "k-monitoring-revoked",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["monitoring:read"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      // The global path guard sees the assignment.
      .mockResolvedValueOnce({
        rows: [{ id: "agent-1", backend_type: "docker", deploy_target: "docker" }],
      })
      // The route loader rechecks after the assignment is revoked.
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/agents/agent-1/metrics")
      .set("Authorization", "Bearer nora_monitoring_revoked");

    expect(res.status).toBe(404);
    expect(metrics.getAgentMetrics).not.toHaveBeenCalled();
  });

  it("accepts integrations:read alone for a teammate-owned assigned agent", async () => {
    const keyRow = {
      id: "k-integrations-only",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["integrations:read"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-shared", backend_type: "docker", deploy_target: "docker" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-shared",
            user_id: "teammate-1",
            backend_type: "docker",
            deploy_target: "docker",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] });

    const res = await request(app)
      .get("/agents/agent-shared/integrations")
      .set("Authorization", "Bearer nora_integrations_only");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects an integration mutation when placement becomes Remote Docker after middleware", async () => {
    const integrations = require("../integrations");
    integrations.connectIntegration.mockClear();
    const keyRow = {
      id: "k-integrations-race",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["integrations:write"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    const localAgent = {
      id: "agent-race",
      user_id: "teammate-1",
      runtime_family: "openclaw",
      backend_type: "docker",
      deploy_target: "docker",
      execution_target_id: "docker",
      status: "running",
    };
    const remoteAgent = {
      ...localAgent,
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:race-host",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      // Global path guard and route access middleware both see local placement.
      .mockResolvedValueOnce({ rows: [localAgent] })
      .mockResolvedValueOnce({ rows: [localAgent] })
      // The mutation handler's authoritative runtime load sees Remote Docker.
      .mockResolvedValueOnce({ rows: [remoteAgent] });

    const res = await request(app)
      .post("/agents/agent-race/integrations")
      .set("Authorization", "Bearer nora_integrations_race")
      .send({ provider: "github", token: "secret" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/session authentication/i),
        code: "session_required",
      }),
    );
    expect(integrations.connectIntegration).not.toHaveBeenCalled();
  });

  it.each(["twitter", "linkedin"])("keeps the %s OAuth callback session-only", async (provider) => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: `k-${provider}-callback`,
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["integrations:write"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/integrations/${provider}/oauth/callback?state=test&code=test`)
      .set("Authorization", `Bearer nora_${provider}_callback`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("allows integrations:read channels on a teammate-owned assigned agent", async () => {
    const keyRow = {
      id: "k-channels-shared",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["integrations:read"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    const teammateAgent = {
      id: "agent-shared",
      user_id: "teammate-1",
      runtime_family: "hermes",
      backend_type: "docker",
      deploy_target: "docker",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [teammateAgent] })
      .mockResolvedValueOnce({ rows: [teammateAgent] });

    const res = await request(app)
      .get("/agents/agent-shared/channels")
      .set("Authorization", "Bearer nora_channels_shared");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ runtime: "legacy", channels: [] }));
  });

  it("rejects channels when an assigned agent becomes Remote Docker after the path guard", async () => {
    const channels = require("../channels");
    channels.listChannels.mockClear();
    const keyRow = {
      id: "k-channels-race",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["integrations:read"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-race", backend_type: "docker", deploy_target: "docker" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-race",
            user_id: "teammate-1",
            runtime_family: "openclaw",
            backend_type: "remote-docker",
            deploy_target: "remote-docker",
            execution_target_id: "remote:race-host",
          },
        ],
      });

    const res = await request(app)
      .get("/agents/agent-race/channels")
      .set("Authorization", "Bearer nora_channels_race");

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/session authentication/i),
        code: "session_required",
      }),
    );
    expect(channels.listChannels).not.toHaveBeenCalled();
  });

  it("requires the explicit admin:read scope for API-key doctor access", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-admin",
            workspace_id: "ws-1",
            created_by: "admin-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["monitoring:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "admin@x.com",
            user_role: "admin",
            user_name: "Admin",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/admin/doctor")
      .set("Authorization", "Bearer nora_admin_without_scope");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(res.body.error).toMatch(/admin:read/);
  });

  it("blocks API keys from mutating workspaces (session-required)", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-4",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/workspaces")
      .set("Authorization", "Bearer nora_readonly")
      .send({ name: "Should Fail" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
  });

  it("blocks API keys from issuing other API keys", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-5",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces/ws-1/api-keys")
      .set("Authorization", "Bearer nora_readonly");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
  });

  // Regression: an API key issued in workspace A must not unlock workspace B,
  // even when the issuing user is a member of B. Pre-fix the workspace param
  // was only checked against the user's membership, not the key's binding.
  it("rejects an API key with cross-workspace access (workspace route)", async () => {
    mockDb.query
      // verifyApiKey: key bound to ws-A
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-cw",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "A",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // last_used_at update
    // No membership query should be issued — the workspace gate must reject
    // before findWorkspaceMembership runs. If the gate is bypassed, the next
    // mockResolvedValueOnce wouldn't exist and the request would 500/200.

    const res = await request(app)
      .get("/workspaces/ws-B/alert-rules")
      .set("Authorization", "Bearer nora_crossworkspace");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
  });

  it("rejects an API key reaching another workspace's agent", async () => {
    mockDb.query
      // verifyApiKey: key bound to ws-A. Agent metrics use their documented
      // monitoring scope without also requiring agents:read.
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-cwa",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["monitoring:read"],
            status: "active",
            workspace_name: "A",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // last_used_at update
      // workspace_agents lookup inside enforceApiKeyAgentScope: agent is NOT in ws-A
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/agents/agent-xyz/metrics")
      .set("Authorization", "Bearer nora_crossagent");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
  });

  it.each([
    ["get", "/agents/agent-other"],
    ["post", "/agents/agent-other/nemoclaw/policy"],
    ["post", "/agents/agent-other/start"],
    ["get", "/agents/agent-other/gateway/status"],
  ])("rejects cross-workspace API-key access before %s %s side effects", async (method, path) => {
    const keyRow = {
      id: "k-agent-boundary",
      workspace_id: "ws-A",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["agents:read", "agents:write"],
      status: "active",
      workspace_name: "A",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const pending = request(app)[method](path).set("Authorization", "Bearer nora_agent_boundary");
    const res = method === "post" ? await pending.send({}) : await pending;

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  it("keeps agent file access session-only before workspace-agent lookup", async () => {
    const keyRow = {
      id: "k-file-session-only",
      workspace_id: "ws-A",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["agents:read"],
      status: "active",
      workspace_name: "A",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [keyRow] }).mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/agents/agent-other/files/content?root=workspace&path=AGENT.md")
      .set("Authorization", "Bearer nora_file_session_only");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it("keeps existing Remote Docker agent operations session-only for workspace API keys", async () => {
    const keyRow = {
      id: "k-remote-agent",
      workspace_id: "ws-A",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["agents:write"],
      status: "active",
      workspace_name: "A",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-remote",
            backend_type: "remote-docker",
            deploy_target: "remote-docker",
            execution_target_id: "remote:build-host",
          },
        ],
      });

    const res = await request(app)
      .post("/agents/agent-remote/stop")
      .set("Authorization", "Bearer nora_remote_agent");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  it("filters GET /workspaces to the API key's bound workspace only", async () => {
    mockDb.query
      // verifyApiKey: key bound to ws-A
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-list",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "A",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // last_used_at update

    // listWorkspaces is mocked at the top of this describe block to return [];
    // override it here to return both workspaces the user belongs to.
    const workspacesModule = require("../workspaces");
    workspacesModule.listWorkspaces.mockResolvedValueOnce([
      { id: "ws-A", name: "A", role: "owner" },
      { id: "ws-B", name: "B", role: "member" },
    ]);

    const res = await request(app).get("/workspaces").set("Authorization", "Bearer nora_listing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "ws-A", name: "A", role: "owner" }]);
  });

  it("rejects an API key whose issuing user no longer exists", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "k-2",
          workspace_id: "ws-1",
          created_by: null,
          key_hash: "h",
          key_prefix: "nora_zzzz",
          scopes: ["workspaces:read"],
          status: "active",
          workspace_name: "Prod",
          user_email: null,
          user_role: null,
          user_name: null,
        },
      ],
    });

    const res = await request(app).get("/workspaces").set("x-api-key", "nora_some_other_token");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired API key");
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Authorization", "Bearer nora_restricted_over_cookie"],
    ["x-api-key", "nora_restricted_over_cookie"],
  ])(
    "prefers explicit %s API-key authentication over a valid session cookie",
    async (name, value) => {
      const cookieToken = jwt.sign(
        { id: "session-user", email: "session@example.com", role: "user" },
        JWT_SECRET,
        { algorithm: "HS256", expiresIn: "1h" },
      );
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: "k-restricted",
              workspace_id: "ws-A",
              created_by: "key-user",
              key_hash: "h",
              key_prefix: "nora_p",
              scopes: ["agents:read"],
              status: "active",
              workspace_name: "A",
              user_email: "key@example.com",
              user_role: "user",
              user_name: "Key User",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get("/workspaces")
        .set("Cookie", `nora_auth=${cookieToken}`)
        .set(name, value);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("missing_scope");
      expect(res.body.error).toMatch(/workspaces:read/);
    },
  );

  it("rejects conflicting explicit authentication headers before verification", async () => {
    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_first")
      .set("x-api-key", "nora_second");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Conflicting authentication headers",
      code: "conflicting_auth",
    });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("loads teammate-owned assigned agents for API-key NemoClaw routes", async () => {
    const keyRow = {
      id: "k-shared-agent",
      workspace_id: "ws-A",
      created_by: "key-user",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["agents:read"],
      status: "active",
      workspace_name: "A",
      user_email: "key@example.com",
      user_role: "user",
      user_name: "Key User",
    };

    mockDb.query
      .mockResolvedValueOnce({ rows: [keyRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-shared", backend_type: "docker", deploy_target: "docker" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-shared",
            user_id: "teammate-1",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            sandbox_type: "nemoclaw",
            sandbox_profile: "nemoclaw",
          },
        ],
      });

    const status = await request(app)
      .get("/agents/agent-shared/nemoclaw/status")
      .set("Authorization", "Bearer nora_shared_nemoclaw");

    expect(status.status).toBe(200);
    expect(status.body).toEqual({ status: "stopped", sandbox: null });
  });
});
