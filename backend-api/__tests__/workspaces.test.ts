// @ts-nocheck
/**
 * __tests__/workspaces.test.js — Workspace endpoint tests
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
}));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../agentHubStore", () => ({
  listAgentHubLocalListings: jest.fn().mockResolvedValue([]),
  publishSnapshot: jest.fn(),
  getListing: jest.fn(),
  deleteListing: jest.fn(),
}));
jest.mock("../snapshots", () => ({
  createSnapshot: jest.fn().mockResolvedValue({ id: "s1", name: "Test", description: "test" }),
  getSnapshot: jest.fn(),
}));
const mockWorkspaces = {
  listWorkspaces: jest.fn().mockResolvedValue([]),
  createWorkspace: jest.fn(),
  addAgent: jest.fn(),
  getWorkspaceAgents: jest.fn().mockResolvedValue([]),
  listAgentCandidates: jest.fn().mockResolvedValue([]),
  removeAgent: jest.fn(),
  listAccessibleAgents: jest.fn().mockResolvedValue([]),
};
jest.mock("../workspaces", () => mockWorkspaces);
const mockWorkspaceMembers = {
  listMembers: jest.fn().mockResolvedValue([]),
  updateMemberRole: jest.fn(),
  removeMember: jest.fn(),
  createInvitation: jest.fn(),
  listInvitations: jest.fn().mockResolvedValue([]),
  revokeInvitation: jest.fn(),
  acceptInvitation: jest.fn(),
};
jest.mock("../workspaceMembers", () => mockWorkspaceMembers);
jest.mock("../integrations", () => ({
  listIntegrations: jest.fn().mockResolvedValue([]),
  connectIntegration: jest.fn(),
  removeIntegration: jest.fn(),
  testIntegration: jest.fn(),
  getCatalog: jest.fn().mockResolvedValue([]),
  getCatalogItem: jest.fn(),
  getIntegrationsForSync: jest.fn().mockResolvedValue({}),
  seedCatalog: jest.fn(),
}));
const mockMonitoring = {
  getMetrics: jest.fn().mockResolvedValue({}),
  logEvent: jest.fn().mockResolvedValue(undefined),
  getRecentEvents: jest.fn().mockResolvedValue([]),
};
jest.mock("../monitoring", () => mockMonitoring);
const mockMailer = {
  sendMail: jest.fn().mockResolvedValue({ delivered: false, error: "not_configured" }),
  isConfigured: jest.fn().mockResolvedValue(false),
  bustCache: jest.fn(),
};
jest.mock("../mailer", () => mockMailer);
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  IS_PAAS: false,
  SELFHOSTED_LIMITS: { max_vcpu: 16, max_ram_mb: 32768, max_disk_gb: 500, max_agents: 50 },
  enforceLimits: jest.fn().mockResolvedValue({
    allowed: true,
    subscription: { plan: "selfhosted", vcpu: 2, ram_mb: 2048, disk_gb: 20 },
  }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
  createCheckoutSession: jest.fn(),
  createPortalSession: jest.fn(),
  handleWebhookEvent: jest.fn(),
}));
jest.mock("../llmProviders", () => ({
  getAvailableProviders: jest.fn().mockReturnValue([]),
  listProviders: jest.fn().mockResolvedValue([]),
  addProvider: jest.fn(),
  updateProvider: jest.fn(),
  deleteProvider: jest.fn(),
  getProviderKeys: jest.fn().mockResolvedValue([]),
  buildAuthProfiles: jest.fn().mockReturnValue({}),
  PROVIDERS: [],
}));
jest.mock("../channels", () => ({
  listChannels: jest.fn().mockResolvedValue([]),
  createChannel: jest.fn(),
  updateChannel: jest.fn(),
  deleteChannel: jest.fn(),
  testChannel: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  handleInboundWebhook: jest.fn(),
}));
jest.mock("../metrics", () => ({
  parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
  getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
  getAccessibleWorkspaceCosts: jest
    .fn()
    .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  recordApiMetric: jest.fn(),
}));

const app = require("../server");

const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);

beforeEach(() => {
  mockDb.query.mockReset();
  mockWorkspaces.listWorkspaces.mockReset().mockResolvedValue([]);
  mockWorkspaces.createWorkspace.mockReset();
  mockWorkspaces.addAgent.mockReset();
  mockWorkspaces.listAgentCandidates.mockReset().mockResolvedValue([]);
  mockWorkspaces.removeAgent.mockReset();
  mockWorkspaceMembers.listMembers.mockReset().mockResolvedValue([]);
  mockWorkspaceMembers.updateMemberRole.mockReset();
  mockWorkspaceMembers.removeMember.mockReset();
  mockWorkspaceMembers.createInvitation.mockReset();
  mockWorkspaceMembers.listInvitations.mockReset().mockResolvedValue([]);
  mockWorkspaceMembers.revokeInvitation.mockReset();
  mockWorkspaceMembers.acceptInvitation.mockReset();
  mockMonitoring.logEvent.mockReset().mockResolvedValue(undefined);
  mockMailer.sendMail.mockReset().mockResolvedValue({ delivered: false, error: "not_configured" });
  mockMailer.isConfigured.mockReset().mockResolvedValue(false);
});

describe("GET /workspaces", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app).get("/workspaces");
    expect(res.status).toBe(401);
  });

  it("returns workspace list", async () => {
    mockWorkspaces.listWorkspaces.mockResolvedValueOnce([
      { id: "ws-1", name: "Dev", user_id: "user-1" },
    ]);

    const res = await auth(request(app).get("/workspaces"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("POST /workspaces", () => {
  it("rejects missing name", async () => {
    const res = await auth(request(app).post("/workspaces").send({}));
    expect(res.status).toBe(400);
  });

  it("rejects name over 100 chars", async () => {
    const res = await auth(
      request(app)
        .post("/workspaces")
        .send({ name: "X".repeat(101) }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1-100/);
  });

  it("creates workspace with valid name", async () => {
    mockWorkspaces.createWorkspace.mockResolvedValueOnce({
      id: "ws-new",
      name: "Production",
      user_id: "user-1",
    });

    const res = await auth(request(app).post("/workspaces").send({ name: "Production" }));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name", "Production");
  });
});

describe("DELETE /workspaces/:id", () => {
  it("rejects if not a member", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // membership check fails

    const res = await auth(request(app).delete("/workspaces/ws-1"));
    expect(res.status).toBe(404);
  });

  it("rejects non-owner members (admin tries to delete)", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "admin" }],
    });
    const res = await auth(request(app).delete("/workspaces/ws-1"));
    expect(res.status).toBe(403);
  });

  it("deletes when caller is owner", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "user-1", role: "owner" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).delete("/workspaces/ws-1"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("treats legacy creator (workspaces.user_id only) as owner", async () => {
    // Membership row missing but workspaces.user_id matches caller — fallback path.
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "user-1", role: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).delete("/workspaces/ws-1"));
    expect(res.status).toBe(200);
  });
});

describe("GET /workspaces/:id/agents", () => {
  it("rejects if not a member", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).get("/workspaces/ws-1/agents"));
    expect(res.status).toBe(404);
  });

  it("allows viewers to read agents", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "viewer" }],
    });
    mockWorkspaces.getWorkspaceAgents.mockResolvedValueOnce([
      { agent_id: "a1", agent_name: "Agent 1" },
    ]);

    const res = await auth(request(app).get("/workspaces/ws-1/agents"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(mockWorkspaces.getWorkspaceAgents).toHaveBeenCalledWith("ws-1", "user-1");
  });
});

describe("POST /workspaces/:id/agents", () => {
  it("rejects if not a member", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/workspaces/ws-1/agents").send({ agentId: "a1" }));
    expect(res.status).toBe(404);
  });

  it("rejects viewers (insufficient role)", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "viewer" }],
    });
    const res = await auth(request(app).post("/workspaces/ws-1/agents").send({ agentId: "a1" }));
    expect(res.status).toBe(403);
  });

  it("rejects when agent is not owned by the caller", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "user-1", role: "owner" }] })
      .mockResolvedValueOnce({ rows: [] }); // findOwnedAgent miss

    const res = await auth(
      request(app).post("/workspaces/ws-1/agents").send({ agentId: "a-foreign" }),
    );
    expect(res.status).toBe(404);
  });

  it("allows workspace editors to assign directly owned agents", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "editor" }] })
      .mockResolvedValueOnce({ rows: [{ id: "a1", user_id: "user-1", name: "Agent 1" }] });
    mockWorkspaces.addAgent.mockResolvedValueOnce({
      workspace_id: "ws-1",
      agent_id: "a1",
      role: "member",
    });

    const res = await auth(request(app).post("/workspaces/ws-1/agents").send({ agentId: "a1" }));
    expect(res.status).toBe(200);
    expect(mockWorkspaces.addAgent).toHaveBeenCalledWith("ws-1", "a1", undefined, "user-1");
  });
});

describe("GET /workspaces/:id/agent-candidates", () => {
  it("returns owned assignment candidates to editors", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "editor" }],
    });
    mockWorkspaces.listAgentCandidates.mockResolvedValueOnce([
      { agentId: "a1", name: "Agent 1", assigned: false },
    ]);

    const res = await auth(request(app).get("/workspaces/ws-1/agent-candidates"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ agentId: "a1", name: "Agent 1", assigned: false }]);
    expect(mockWorkspaces.listAgentCandidates).toHaveBeenCalledWith("ws-1", "user-1");
  });
});

describe("GET /workspaces/cost", () => {
  it("returns all accessible workspace cost groups", async () => {
    const metrics = require("../metrics");
    metrics.getAccessibleWorkspaceCosts.mockResolvedValueOnce({
      periodDays: 30,
      workspaces: [],
      uniqueFleetTotalUsd: 0,
    });

    const res = await auth(request(app).get("/workspaces/cost?period_days=30"));
    expect(res.status).toBe(200);
    expect(metrics.getAccessibleWorkspaceCosts).toHaveBeenCalledWith("user-1", {
      periodDays: 30,
    });
  });

  it("returns only the exact bound workspace for API keys", async () => {
    const metrics = require("../metrics");
    metrics.getWorkspaceCost.mockReset().mockResolvedValueOnce({
      workspaceId: "ws-A",
      periodDays: 30,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-06-30T23:59:59.999Z",
      totalUsd: 12.5,
      perAgent: [{ agentId: "agent-A", total_cost: 12.5 }],
    });
    metrics.getAccessibleWorkspaceCosts.mockClear();
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "key-cost",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "hash",
            key_prefix: "nora_c",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Workspace A",
            user_email: "user@example.com",
            user_role: "user",
            user_name: "User",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces/cost?period_days=30")
      .set("Authorization", "Bearer nora_workspace_cost");

    expect(res.status).toBe(200);
    expect(metrics.getWorkspaceCost).toHaveBeenCalledWith("ws-A", { periodDays: 30 });
    expect(metrics.getAccessibleWorkspaceCosts).not.toHaveBeenCalled();
    expect(res.body.workspaces).toEqual([
      expect.objectContaining({
        workspaceId: "ws-A",
        workspaceName: "Workspace A",
        totalUsd: 12.5,
      }),
    ]);
    expect(res.body.unassigned).toEqual({ totalUsd: 0, perAgent: [] });
    expect(res.body.uniqueFleetTotalUsd).toBe(12.5);
  });
});

describe("DELETE /workspaces/:id/agents/:agentId", () => {
  it("allows workspace admins to remove an assignment without deleting the agent", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "admin" }],
    });
    mockWorkspaces.removeAgent.mockResolvedValueOnce({ workspace_id: "ws-1", agent_id: "a1" });

    const res = await auth(request(app).delete("/workspaces/ws-1/agents/a1"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockWorkspaces.removeAgent).toHaveBeenCalledWith("ws-1", "a1");
  });
});

describe("Workspace member management", () => {
  it("GET /:id/members returns members to viewers", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "viewer" }],
    });
    mockWorkspaceMembers.listMembers.mockResolvedValueOnce([
      { userId: "u-1", role: "owner", email: "a@b.com" },
    ]);
    const res = await auth(request(app).get("/workspaces/ws-1/members"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("PATCH /:id/members/:userId rejects editor (admin required)", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "editor" }],
    });
    const res = await auth(
      request(app).patch("/workspaces/ws-1/members/u-2").send({ role: "viewer" }),
    );
    expect(res.status).toBe(403);
  });

  it("PATCH /:id/members/:userId allows admin to change role", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "admin" }],
    });
    mockWorkspaceMembers.updateMemberRole.mockResolvedValueOnce({
      userId: "u-2",
      role: "editor",
    });
    const res = await auth(
      request(app).patch("/workspaces/ws-1/members/u-2").send({ role: "editor" }),
    );
    expect(res.status).toBe(200);
    expect(mockWorkspaceMembers.updateMemberRole).toHaveBeenCalledWith("ws-1", "u-2", "editor");
  });

  it("DELETE /:id/members/:userId surfaces last-owner errors", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "user-1", role: "owner" }],
    });
    const err = new Error("Cannot remove the last owner of a workspace");
    err.statusCode = 409;
    mockWorkspaceMembers.removeMember.mockRejectedValueOnce(err);
    const res = await auth(request(app).delete("/workspaces/ws-1/members/user-1"));
    expect(res.status).toBe(409);
  });

  it("POST /:id/invitations issues invitation as admin and logs audit event", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "admin" }],
    });
    mockWorkspaceMembers.createInvitation.mockResolvedValueOnce({
      id: "inv-1",
      email: "new@b.com",
      role: "editor",
      token: "nora_inv_xyz",
    });
    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/invitations")
        .send({ email: "new@b.com", role: "editor" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.emailDelivery).toEqual({ sent: false, error: "not_configured" });
    expect(mockMailer.sendMail).not.toHaveBeenCalled();
    expect(mockMonitoring.logEvent).toHaveBeenCalledWith(
      "workspace_invitation_created",
      expect.stringContaining("new@b.com"),
      expect.objectContaining({
        workspace: expect.objectContaining({ id: "ws-1" }),
        invitation: expect.objectContaining({
          id: "inv-1",
          email: "new@b.com",
          role: "editor",
        }),
      }),
    );
  });

  it("POST /:id/invitations sends email and reports sent:true when SMTP configured", async () => {
    mockMailer.isConfigured.mockResolvedValueOnce(true);
    mockMailer.sendMail.mockResolvedValueOnce({ delivered: true, messageId: "m-1" });
    process.env.NEXTAUTH_URL = "https://nora.example.com";
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "ws-1", user_id: "creator", role: "admin", name: "Prod" }],
      })
      .mockResolvedValueOnce({ rows: [{ name: "Prod" }] }); // workspace name lookup
    mockWorkspaceMembers.createInvitation.mockResolvedValueOnce({
      id: "inv-2",
      workspaceId: "ws-1",
      email: "alice@example.com",
      role: "editor",
      token: "nora_inv_abc",
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    });

    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/invitations")
        .send({ email: "alice@example.com", role: "editor" }),
    );

    expect(res.status).toBe(200);
    expect(res.body.emailDelivery).toMatchObject({ sent: true });
    expect(mockMailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@example.com",
        subject: expect.stringContaining("Prod"),
        text: expect.stringContaining(
          "https://nora.example.com/app/invitations/accept?token=nora_inv_abc",
        ),
      }),
    );
    delete process.env.NEXTAUTH_URL;
  });

  it("PATCH /:id/members/:userId logs audit event on success", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "admin" }],
    });
    mockWorkspaceMembers.updateMemberRole.mockResolvedValueOnce({
      userId: "u-2",
      email: "user2@x.com",
      role: "editor",
    });
    const res = await auth(
      request(app).patch("/workspaces/ws-1/members/u-2").send({ role: "editor" }),
    );
    expect(res.status).toBe(200);
    expect(mockMonitoring.logEvent).toHaveBeenCalledWith(
      "workspace_member_role_changed",
      expect.stringContaining("editor"),
      expect.objectContaining({
        member: expect.objectContaining({ userId: "u-2" }),
      }),
    );
  });

  it("POST /invitations/accept proxies to acceptInvitation", async () => {
    mockWorkspaceMembers.acceptInvitation.mockResolvedValueOnce({
      workspaceId: "ws-1",
      role: "editor",
    });
    const res = await auth(
      request(app).post("/workspaces/invitations/accept").send({ token: "nora_inv_xyz" }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspaceId: "ws-1", role: "editor" });
    expect(mockWorkspaceMembers.acceptInvitation).toHaveBeenCalledWith("nora_inv_xyz", "user-1");
  });

  it("POST /invitations/accept surfaces 410 for expired tokens", async () => {
    const err = new Error("Invitation has expired");
    err.statusCode = 410;
    mockWorkspaceMembers.acceptInvitation.mockRejectedValueOnce(err);
    const res = await auth(
      request(app).post("/workspaces/invitations/accept").send({ token: "nora_inv_old" }),
    );
    expect(res.status).toBe(410);
  });
});
