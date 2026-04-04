/**
 * __tests__/agents.test.js — Agent management endpoint tests
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
const mockAddDeploymentJob = jest.fn();
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({ addDeploymentJob: mockAddDeploymentJob, getDLQJobs: jest.fn(), retryDLQJob: jest.fn() }));
jest.mock("../scheduler", () => ({ selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }) }));
jest.mock("../containerManager", () => ({
  start: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue({}),
  restart: jest.fn().mockResolvedValue({}),
  destroy: jest.fn().mockResolvedValue({}),
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
jest.mock("../workspaces", () => ({
  listWorkspaces: jest.fn().mockResolvedValue([]),
  createWorkspace: jest.fn(),
  addAgent: jest.fn(),
  getWorkspaceAgents: jest.fn().mockResolvedValue([]),
}));
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
  mockAddDeploymentJob.mockReset();
});

describe("GET /agents", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app).get("/agents");
    expect(res.status).toBe(401);
  });

  it("returns agent list for authenticated user", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { id: "a1", name: "Agent 1", status: "running", created_at: new Date().toISOString() },
      ],
    });

    const res = await auth(request(app).get("/agents"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("name", "Agent 1");
  });
});

describe("GET /agents/:id", () => {
  it("preserves warning status when the container is still live", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-warning",
        name: "Warning Agent",
        status: "warning",
        user_id: "user-1",
        container_id: "container-1",
      }],
    });

    const res = await auth(request(app).get("/agents/a-warning"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "warning");
  });

  it("reconciles warning agents to stopped when the container is no longer live", async () => {
    const containerManager = require("../containerManager");
    containerManager.status.mockResolvedValueOnce({ running: false });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-warning-down",
          name: "Warning Down Agent",
          status: "warning",
          user_id: "user-1",
          container_id: "container-warning-down",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "a-warning-down",
          status: "stopped",
        }],
      });

    const res = await auth(request(app).get("/agents/a-warning-down"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "stopped");
  });

  it("reconciles stopped agents back to running when the container is live", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-stopped",
          name: "Stopped Agent",
          status: "stopped",
          user_id: "user-1",
          container_id: "container-2",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "a-stopped",
          status: "running",
        }],
      });

    const res = await auth(request(app).get("/agents/a-stopped"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "running");
  });
});

describe("GET /agents/:id/gateway-url", () => {
  it("uses GATEWAY_HOST when returning a published gateway url", async () => {
    process.env.GATEWAY_HOST = "gateway.external";
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-gateway",
        container_id: "container-gateway",
        gateway_token: "gateway-token",
        gateway_host_port: 19123,
        user_id: "user-1",
      }],
    });

    const res = await auth(request(app).get("/agents/a-gateway/gateway-url"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://gateway.external:19123",
      port: 19123,
      token: "gateway-token",
    });

    delete process.env.GATEWAY_HOST;
  });
});

describe("POST /agents/deploy", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app).post("/agents/deploy").send({});
    expect(res.status).toBe(401);
  });

  it("rejects agent name over 100 chars", async () => {
    const longName = "A".repeat(101);
    const res = await auth(
      request(app).post("/agents/deploy").send({ name: longName })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
  });

  it("deploys agent with valid data", async () => {
    // db.query calls in order: INSERT agents, INSERT deployments
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-new", name: "TestAgent", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({ name: "TestAgent" })
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("status", "queued");
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-new",
      name: "TestAgent",
      userId: "user-1",
      specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
      sandbox: "standard",
    }));
  });

  it("sanitizes deploy input and clamps self-hosted resource requests", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-sanitized", name: "BadName", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "Bad\nName\t",
        vcpu: 999,
        ram_mb: 999999,
        disk_gb: 999999,
      })
    );

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO agents"),
      expect.arrayContaining([
        "user-1",
        "BadName",
        "worker-01",
        "standard",
        16,
        32768,
        500,
      ])
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-sanitized",
      name: "BadName",
      specs: { vcpu: 16, ram_mb: 32768, disk_gb: 500 },
    }));
  });
});

describe("POST /agents/:id/stop", () => {
  it("stops a running agent", async () => {
    // db.query calls: SELECT agent, UPDATE status
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "a1", status: "running", container_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "a1", status: "stopped" }] });

    const res = await auth(request(app).post("/agents/a1/stop"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "stopped");
  });
});

describe("POST /agents/:id/redeploy", () => {
  it("allows redeploy when an agent is in warning state", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-warning",
          name: "Warning Agent",
          status: "warning",
          sandbox_type: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
          container_name: "oclaw-agent-warning",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/a-warning/redeploy"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: "queued" });
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("gateway_host_port = NULL, gateway_token = NULL"),
      ["a-warning"]
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-warning",
      name: "Warning Agent",
      userId: "user-1",
      sandbox: "standard",
      specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
      container_name: "oclaw-agent-warning",
    }));
  });

  it("rejects redeploy when the agent is still actively running", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "a-running", name: "Running Agent", status: "running" }],
    });

    const res = await auth(request(app).post("/agents/a-running/redeploy"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/warning, error, or stopped/i);
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });
});

describe("POST /agents/:id/delete", () => {
  it("deletes an agent", async () => {
    // db.query calls: SELECT agent, DELETE
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "a1", container_id: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/a1/delete"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("returns 404 for non-existent agent", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/missing/delete"));
    expect(res.status).toBe(404);
  });
});
