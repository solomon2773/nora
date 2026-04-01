/**
 * __tests__/workspaces.test.js — Workspace endpoint tests
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({ addDeploymentJob: jest.fn(), getDLQJobs: jest.fn(), retryDLQJob: jest.fn() }));
jest.mock("../scheduler", () => ({ selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }) }));
jest.mock("../containerManager", () => ({
  start: jest.fn(), stop: jest.fn(), restart: jest.fn(), destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../marketplace", () => ({
  listMarketplace: jest.fn().mockResolvedValue([]),
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
};
jest.mock("../workspaces", () => mockWorkspaces);
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
jest.mock("../monitoring", () => ({
  getMetrics: jest.fn().mockResolvedValue({}),
  logEvent: jest.fn(),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
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
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
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
      request(app).post("/workspaces").send({ name: "X".repeat(101) })
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

    const res = await auth(
      request(app).post("/workspaces").send({ name: "Production" })
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name", "Production");
  });
});

describe("DELETE /workspaces/:id", () => {
  it("rejects if not owner", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // ownership check fails

    const res = await auth(request(app).delete("/workspaces/ws-1"));
    expect(res.status).toBe(404);
  });

  it("deletes owned workspace", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1" }] }) // ownership OK
      .mockResolvedValueOnce({ rows: [] })               // delete workspace_agents
      .mockResolvedValueOnce({ rows: [] });              // delete workspace

    const res = await auth(request(app).delete("/workspaces/ws-1"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });
});

describe("GET /workspaces/:id/agents", () => {
  it("rejects if not workspace owner", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).get("/workspaces/ws-1/agents"));
    expect(res.status).toBe(404);
  });

  it("returns workspace agents for owned workspace", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "user-1" }] });
    mockWorkspaces.getWorkspaceAgents.mockResolvedValueOnce([{ agent_id: "a1", agent_name: "Agent 1" }]);

    const res = await auth(request(app).get("/workspaces/ws-1/agents"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(mockWorkspaces.getWorkspaceAgents).toHaveBeenCalledWith("ws-1", "user-1");
  });
});

describe("POST /workspaces/:id/agents", () => {
  it("rejects if not workspace owner", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // ownership check fails

    const res = await auth(
      request(app).post("/workspaces/ws-1/agents").send({ agentId: "a1" })
    );
    expect(res.status).toBe(404);
  });

  it("rejects if agent is not owned by the workspace owner", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "user-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/workspaces/ws-1/agents").send({ agentId: "a-foreign" })
    );
    expect(res.status).toBe(404);
  });
});
