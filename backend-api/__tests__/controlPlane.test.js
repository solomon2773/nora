const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };

jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({ addDeploymentJob: jest.fn(), getDLQJobs: jest.fn(), retryDLQJob: jest.fn() }));
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

describe("gateway control-plane embed", () => {
  const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });

  beforeEach(() => {
    mockDb.query.mockReset();
    global.fetch = jest.fn();
    delete process.env.GATEWAY_HOST;
  });

  afterEach(() => {
    delete global.fetch;
    delete process.env.GATEWAY_HOST;
  });

  it("proxies the gateway UI over the control-plane contract port and injects the WS relay", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: null,
        status: "running",
      }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html><head><title>Gateway</title></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.10:18789/",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/html", "Accept-Encoding": "identity" }),
      })
    );
    expect(res.text).toContain("ws://nora.test/api/ws/gateway/agent-1?token=");
    expect(res.text).toContain("window.location.hash='password='+encodeURIComponent(P)");
    expect(res.text).not.toContain("localStorage.setItem('oc-gateway-url',R)");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("uses the published gateway host port when one is recorded", async () => {
    process.env.GATEWAY_HOST = "gateway.internal";
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: 19123,
        status: "running",
      }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html><head></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://gateway.internal:19123/",
      expect.any(Object)
    );
  });

  it("rejects embed for error agents so failed control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: 19123,
        status: "error",
      }],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("allows asset proxy access for warning agents so degraded control-plane recovery still works", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_host_port: 19123,
        status: "warning",
      }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => new TextEncoder().encode("console.log('ok')").buffer,
    });

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://host.docker.internal:19123/assets/app.js",
      expect.any(Object)
    );
  });

  it("rejects asset proxy access for stopped agents so stale control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_host_port: 19123,
        status: "stopped",
      }],
    });

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects asset proxy access for error agents so failed control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_host_port: 19123,
        status: "error",
      }],
    });

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
