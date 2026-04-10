/**
 * __tests__/agents.test.js — Agent management endpoint tests
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
const mockAddDeploymentJob = jest.fn();
const mockStats = jest.fn();
const mockGetDeploymentDefaults = jest.fn().mockResolvedValue({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({ addDeploymentJob: mockAddDeploymentJob, getDLQJobs: jest.fn(), retryDLQJob: jest.fn() }));
jest.mock("../scheduler", () => ({ selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }) }));
jest.mock("../containerManager", () => ({
  start: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue({}),
  restart: jest.fn().mockResolvedValue({}),
  destroy: jest.fn().mockResolvedValue({}),
  status: jest.fn().mockResolvedValue({ running: true }),
  stats: mockStats,
}));
jest.mock("../marketplace", () => ({
  LISTING_SOURCE_COMMUNITY: "community",
  LISTING_SOURCE_PLATFORM: "platform",
  LISTING_STATUS_PENDING_REVIEW: "pending_review",
  LISTING_STATUS_PUBLISHED: "published",
  LISTING_STATUS_REJECTED: "rejected",
  LISTING_STATUS_REMOVED: "removed",
  LISTING_VISIBILITY_PUBLIC: "public",
  listMarketplace: jest.fn().mockResolvedValue([]),
  listUserListings: jest.fn().mockResolvedValue([]),
  publishSnapshot: jest.fn(),
  getListing: jest.fn(),
  deleteListing: jest.fn(),
  upsertListing: jest.fn(),
  recordInstall: jest.fn(),
  recordDownload: jest.fn(),
  createReport: jest.fn(),
  listAdminListings: jest.fn().mockResolvedValue([]),
  listReports: jest.fn().mockResolvedValue([]),
  resolveReport: jest.fn(),
  setListingStatus: jest.fn(),
  getPlatformListingByTemplateKey: jest.fn(),
}));
jest.mock("../snapshots", () => ({
  createSnapshot: jest.fn().mockResolvedValue({ id: "s1", name: "Test", description: "test" }),
  getSnapshot: jest.fn(),
  updateSnapshot: jest.fn(),
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
  buildCloneableIntegration: jest.fn((row) => ({
    provider: row.provider,
    catalog_id: row.catalog_id,
    config: { provider: row.provider, redacted: true },
    status: "needs_reconnect",
  })),
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
  buildCloneableChannel: jest.fn((row) => ({
    type: row.type,
    name: row.name,
    config: { type: row.type, redacted: true },
    enabled: false,
  })),
}));
jest.mock("../metrics", () => ({
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
  recordApiMetric: jest.fn(),
}));
jest.mock("../platformSettings", () => {
  const actual = jest.requireActual("../platformSettings");
  return {
    ...actual,
    getDeploymentDefaults: mockGetDeploymentDefaults,
  };
});

const app = require("../server");

const userToken = jwt.sign({ id: "user-1", email: "user@nora.test", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockReset();
  mockAddDeploymentJob.mockReset();
  mockGetDeploymentDefaults.mockReset().mockResolvedValue({
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
  });
  delete process.env.ENABLED_BACKENDS;
  delete process.env.KUBECONFIG;
  delete process.env.KUBERNETES_SERVICE_HOST;
  require("../billing").IS_PAAS = false;
  mockStats.mockReset().mockResolvedValue({
    backend_type: "docker",
    capabilities: { cpu: true, memory: true, network: true, disk: true, pids: true },
    current: {
      recorded_at: "2026-04-08T00:00:05.000Z",
      running: true,
      uptime_seconds: 30,
      cpu_percent: 12.34,
      memory_usage_mb: 512,
      memory_limit_mb: 2048,
      memory_percent: 25,
      network_rx_mb: 10,
      network_tx_mb: 20,
      disk_read_mb: 30,
      disk_write_mb: 40,
      pids: 6,
    },
  });
  delete global.fetch;
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
        status: "running",
      }],
    });

    const res = await auth(request(app).get("/agents/a-gateway/gateway-url"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://gateway.external:19123",
      port: 19123,
    });

    delete process.env.GATEWAY_HOST;
  });

  it("allows gateway url lookups for warning agents so degraded control-plane recovery still works", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-warning-gateway",
        container_id: "container-warning-gateway",
        gateway_host_port: 19123,
        user_id: "user-1",
        status: "warning",
      }],
    });

    const res = await auth(
      request(app)
        .get("/agents/a-warning-gateway/gateway-url")
        .set("Host", "app.nora.test:8080")
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://app.nora.test:19123",
      port: 19123,
    });
  });

  it("uses the forwarded request protocol for published gateway urls when the control plane is behind https", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-https-gateway",
        container_id: "container-https-gateway",
        gateway_host_port: 19123,
        user_id: "user-1",
        status: "running",
      }],
    });

    const res = await auth(
      request(app)
        .get("/agents/a-https-gateway/gateway-url")
        .set("Host", "app.nora.test")
        .set("X-Forwarded-Proto", "https")
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://app.nora.test:19123",
      port: 19123,
    });
  });

  it("uses explicit gateway host and port when the backend records them", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-k8s-gateway",
        host: "oclaw-agent-a-k8s.openclaw-agents.svc.cluster.local",
        container_id: "oclaw-agent-a-k8s",
        backend_type: "k8s",
        gateway_host_port: null,
        gateway_host: "nora-kind-control-plane",
        gateway_port: 31879,
        user_id: "user-1",
        status: "running",
      }],
    });

    const res = await auth(request(app).get("/agents/a-k8s-gateway/gateway-url"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://nora-kind-control-plane:31879",
      port: 31879,
    });
  });

  it("rejects gateway url lookups for stopped agents so stale ports are not exposed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-stopped-gateway",
        container_id: "container-gateway",
        gateway_host_port: 19123,
        user_id: "user-1",
        status: "stopped",
      }],
    });

    const res = await auth(request(app).get("/agents/a-stopped-gateway/gateway-url"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only available while running/i);
  });

  it("rejects gateway url lookups for error agents so failed control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "a-error-gateway",
        container_id: "container-error-gateway",
        gateway_host_port: 19123,
        user_id: "user-1",
        status: "error",
      }],
    });

    const res = await auth(request(app).get("/agents/a-error-gateway/gateway-url"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only available while running/i);
  });
});

describe("agent audit logging", () => {
  it("logs owner detail when starting an agent", async () => {
    const monitoringModule = require("../monitoring");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-1",
            name: "Start Agent",
            user_id: "user-1",
            container_id: "container-start-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-1",
            name: "Start Agent",
            user_id: "user-1",
            container_id: "container-start-1",
            status: "running",
          },
        ],
      });

    const res = await auth(request(app).post("/agents/agent-start-1/start"));

    expect(res.status).toBe(200);
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "agent_started",
      expect.stringContaining("Start Agent"),
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "account",
          label: "user@nora.test",
          service: "backend-api",
          account: expect.objectContaining({
            userId: "user-1",
            email: "user@nora.test",
            role: "user",
          }),
        }),
        actor: expect.objectContaining({
          userId: "user-1",
          email: "user@nora.test",
        }),
        agent: expect.objectContaining({
          id: "agent-start-1",
          ownerEmail: "user@nora.test",
        }),
      })
    );
  });
});

describe("GET /agents/:id/stats", () => {
  it("returns normalized live stats with derived rate fields", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-metrics",
          user_id: "user-1",
          container_id: "container-metrics",
          backend_type: "docker",
          sandbox_type: "standard",
          status: "running",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          cpu_percent: 8,
          memory_usage_mb: 500,
          memory_limit_mb: 2048,
          memory_percent: 24.41,
          network_rx_mb: 5,
          network_tx_mb: 15,
          disk_read_mb: 25,
          disk_write_mb: 35,
          network_rx_rate_mbps: 0.5,
          network_tx_rate_mbps: 1.5,
          disk_read_rate_mbps: 2.5,
          disk_write_rate_mbps: 3.5,
          pids: 4,
          recorded_at: "2026-04-08T00:00:00.000Z",
        }],
      });

    const res = await auth(request(app).get("/agents/a-metrics/stats"));

    expect(res.status).toBe(200);
    expect(res.body.backend_type).toBe("docker");
    expect(res.body.capabilities).toEqual({
      cpu: true,
      memory: true,
      network: true,
      disk: true,
      pids: true,
    });
    expect(res.body.current.cpu_percent).toBe(12.34);
    expect(res.body.current.network_rx_rate_mbps).toBe(1);
    expect(res.body.current.network_tx_rate_mbps).toBe(1);
    expect(res.body.current.disk_read_rate_mbps).toBe(1);
    expect(res.body.current.disk_write_rate_mbps).toBe(1);
  });

  it("includes a compact NemoClaw summary when the agent is a sandbox", async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).endsWith("/nemoclaw/status")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            sandbox: "nemoclaw",
            model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
            inferenceConfigured: true,
            policyActive: true,
            uptime: 120,
            pid: 77,
          }),
        });
      }
      if (String(url).endsWith("/nemoclaw/policy")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            network: { rules: [{ name: "nvidia" }, { name: "github" }] },
          }),
        });
      }
      if (String(url).endsWith("/nemoclaw/approvals")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            approvals: [{ id: "approval-1" }],
          }),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    mockStats.mockResolvedValueOnce({
      backend_type: "nemoclaw",
      capabilities: { cpu: true, memory: true, network: true, disk: true, pids: true },
      current: {
        recorded_at: "2026-04-08T00:00:05.000Z",
        running: true,
        uptime_seconds: 60,
        cpu_percent: 10,
        memory_usage_mb: 512,
        memory_limit_mb: 2048,
        memory_percent: 25,
        network_rx_mb: 2,
        network_tx_mb: 3,
        disk_read_mb: 4,
        disk_write_mb: 5,
        pids: 3,
      },
    });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-nemo",
          user_id: "user-1",
          container_id: "container-nemo",
          backend_type: "nemoclaw",
          sandbox_type: "nemoclaw",
          status: "running",
          host: "127.0.0.1",
          runtime_host: "127.0.0.1",
          runtime_port: 9090,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).get("/agents/a-nemo/stats"));

    expect(res.status).toBe(200);
    expect(res.body.nemo).toEqual(
      expect.objectContaining({
        available: true,
        model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
        inferenceConfigured: true,
        policyActive: true,
        policyRuleCount: 2,
        pendingApprovalsCount: 1,
      })
    );
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("GET /agents/:id/stats/history", () => {
  it("returns normalized history with backend capabilities", async () => {
    mockStats.mockResolvedValueOnce({
      backend_type: "proxmox",
      capabilities: { cpu: true, memory: true, network: true, disk: true, pids: false },
      current: {
        recorded_at: "2026-04-08T00:00:05.000Z",
        running: true,
        uptime_seconds: 300,
        cpu_percent: 15,
        memory_usage_mb: 1024,
        memory_limit_mb: 4096,
        memory_percent: 25,
        network_rx_mb: 50,
        network_tx_mb: 10,
        disk_read_mb: 25,
        disk_write_mb: 5,
      },
    });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-proxmox",
          user_id: "user-1",
          container_id: "vm-101",
          backend_type: "proxmox",
          sandbox_type: "standard",
          status: "running",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          cpu_percent: 15,
          memory_usage_mb: 1024,
          memory_limit_mb: 4096,
          memory_percent: 25,
          network_rx_mb: 50,
          network_tx_mb: 10,
          disk_read_mb: 25,
          disk_write_mb: 5,
          network_rx_rate_mbps: 1.5,
          network_tx_rate_mbps: 0.5,
          disk_read_rate_mbps: 0.25,
          disk_write_rate_mbps: 0.1,
          pids: 99,
          recorded_at: "2026-04-08T00:00:05.000Z",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          cpu_percent: 15,
          memory_usage_mb: 1024,
          memory_limit_mb: 4096,
          memory_percent: 25,
          network_rx_mb: 50,
          network_tx_mb: 10,
          disk_read_mb: 25,
          disk_write_mb: 5,
          network_rx_rate_mbps: 1.5,
          network_tx_rate_mbps: 0.5,
          disk_read_rate_mbps: 0.25,
          disk_write_rate_mbps: 0.1,
          pids: 99,
          recorded_at: "2026-04-08T00:00:05.000Z",
        }],
      });

    const res = await auth(request(app).get("/agents/a-proxmox/stats/history?range=15m"));

    expect(res.status).toBe(200);
    expect(res.body.backend_type).toBe("proxmox");
    expect(res.body.capabilities).toEqual({
      cpu: true,
      memory: true,
      network: true,
      disk: true,
      pids: false,
    });
    expect(res.body.samples).toHaveLength(1);
    expect(res.body.samples[0]).toEqual(
      expect.objectContaining({
        cpu_percent: 15,
        network_rx_rate_mbps: 1.5,
        pids: null,
      })
    );
  });

  it("uses a 7-day window and returns the live sample when stored history is empty", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-empty",
          user_id: "user-1",
          container_id: "container-empty",
          backend_type: "docker",
          sandbox_type: "standard",
          status: "running",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).get("/agents/a-empty/stats/history?range=7d"));

    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(1);
    expect(res.body.samples[0]).toEqual(
      expect.objectContaining({
        cpu_percent: 12.34,
        memory_usage_mb: 512,
      })
    );

    const historyQueryParams = mockDb.query.mock.calls[2][1];
    const fromTime = historyQueryParams[1];
    const toTime = historyQueryParams[2];
    const bucketSeconds = historyQueryParams[3];

    expect(bucketSeconds).toBe(3600);
    expect(toTime.getTime() - fromTime.getTime()).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000);
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
      backend: "docker",
      specs: { vcpu: 1, ram_mb: 1024, disk_gb: 10 },
      sandbox: "standard",
    }));
  });

  it("queues an explicitly selected enabled backend", async () => {
    process.env.ENABLED_BACKENDS = "docker,k8s";
    process.env.KUBECONFIG = "/tmp/test-kubeconfig";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-k8s", name: "K8sAgent", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({ name: "K8sAgent", backend: "k8s" })
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-k8s",
        backend: "k8s",
        sandbox: "standard",
      })
    );
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
        "docker",
        "standard",
        16,
        32768,
        500,
      ])
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-sanitized",
      name: "BadName",
      backend: "docker",
      specs: { vcpu: 16, ram_mb: 32768, disk_gb: 500 },
    }));
  });

  it("stores the default prebaked image and blank template payload when deploying", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-image", name: "Image Agent", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({ name: "Image Agent" })
    );

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[9]).toBe("nora-openclaw-agent:local");
    expect(JSON.parse(insertParams[10])).toEqual(
      expect.objectContaining({
        files: [],
        memoryFiles: [],
        metadata: expect.objectContaining({ source: "blank-deploy" }),
      })
    );
  });

  it("uses operator-managed deployment defaults in PaaS mode", async () => {
    const billing = require("../billing");
    billing.IS_PAAS = true;
    billing.enforceLimits.mockResolvedValueOnce({
      allowed: true,
      subscription: {
        plan: "pro",
        status: "active",
        vcpu: 99,
        ram_mb: 99999,
        disk_gb: 999,
      },
    });
    mockGetDeploymentDefaults.mockResolvedValueOnce({
      vcpu: 4,
      ram_mb: 4096,
      disk_gb: 50,
    });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          { id: "a-paas", name: "PaaS Agent", status: "queued", user_id: "user-1" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "PaaS Agent",
        vcpu: 12,
        ram_mb: 12288,
        disk_gb: 200,
      })
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-paas",
        specs: { vcpu: 4, ram_mb: 4096, disk_gb: 50 },
      })
    );

    billing.IS_PAAS = false;
  });
});

describe("PATCH /agents/:id", () => {
  it("renames an existing agent", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-rename", name: "Old Name", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "a-rename", name: "New Name", user_id: "user-1" }],
      });

    const res = await auth(
      request(app).patch("/agents/a-rename").send({ name: "New Name" })
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name", "New Name");
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "UPDATE agents SET name = $1 WHERE id = $2 RETURNING *",
      ["New Name", "a-rename"]
    );
  });
});

describe("POST /agents/:id/duplicate", () => {
  it("duplicates an agent using stored payload fallback and full clone wiring", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "a-source",
          name: "Source Agent",
          user_id: "user-1",
          status: "stopped",
          sandbox_type: "standard",
          vcpu: 4,
          ram_mb: 4096,
          disk_gb: 50,
          image: "custom/image:latest",
          template_payload: JSON.stringify({
            files: [{ path: "AGENT.md", content: "hello" }],
            memoryFiles: [{ path: "workspace/note.txt", content: "memory" }],
            metadata: { source: "template" },
          }),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          provider: "slack",
          catalog_id: "slack",
          access_token: "secret",
          config: { token: "secret" },
          status: "active",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          type: "email",
          name: "Ops Email",
          config: { smtp_pass: "secret" },
          enabled: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "a-duplicate", name: "Source Agent Copy", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-source/duplicate").send({
        name: "Source Agent Copy",
        clone_mode: "full_clone",
      })
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "a-duplicate");
    const insertParams = mockDb.query.mock.calls[3][1];
    const templatePayload = JSON.parse(insertParams[10]);
    expect(templatePayload.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "AGENT.md",
        "AGENTS.md",
        "SOUL.md",
        "TOOLS.md",
        "IDENTITY.md",
        "USER.md",
        "HEARTBEAT.md",
        "MEMORY.md",
      ])
    );
    expect(templatePayload.memoryFiles).toEqual([
      expect.objectContaining({ path: "workspace/note.txt" }),
    ]);
    expect(templatePayload.wiring.integrations).toEqual([
      expect.objectContaining({ provider: "slack", status: "needs_reconnect" }),
    ]);
    expect(templatePayload.wiring.channels).toEqual([
      expect.objectContaining({ type: "email", enabled: false }),
    ]);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-duplicate",
      name: "Source Agent Copy",
      backend: "docker",
      image: "custom/image:latest",
      sandbox: "standard",
      specs: { vcpu: 4, ram_mb: 4096, disk_gb: 50 },
    }));
  });
});

describe("POST /marketplace/install", () => {
  it("installs a starter template into a queued agent using the provided name", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      snapshot_id: "snap-1",
      name: "Chief-of-Staff Claw",
      template_key: "chief-of-staff-claw",
      status: "published",
      source_type: "platform",
    });
    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      name: "Chief-of-Staff Claw",
      description: "Operations starter",
      config: {
        defaults: {
          sandbox: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
          image: "nora-openclaw-agent:local",
        },
        templatePayload: {
          files: [{ path: "AGENT.md", content: "starter" }],
          memoryFiles: [],
          wiring: { channels: [], integrations: [] },
          metadata: { starterType: "operations" },
        },
      },
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-market", name: "COS Agent", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/marketplace/install").send({
        listingId: "listing-1",
        name: "COS Agent",
      })
    );

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[1]).toBe("COS Agent");
    expect(insertParams[9]).toBe("nora-openclaw-agent:local");
    expect(
      JSON.parse(insertParams[10]).files.map((file) => file.path)
    ).toEqual(
      expect.arrayContaining([
        "AGENT.md",
        "AGENTS.md",
        "SOUL.md",
        "TOOLS.md",
        "IDENTITY.md",
        "USER.md",
        "HEARTBEAT.md",
        "MEMORY.md",
        "BOOTSTRAP.md",
      ])
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-market",
      name: "COS Agent",
      backend: "docker",
      image: "nora-openclaw-agent:local",
      sandbox: "standard",
    }));
  });
});

describe("marketplace browse, publish, download, and report", () => {
  it("lists published marketplace entries for authenticated users", async () => {
    const marketplaceModule = require("../marketplace");
    marketplaceModule.listMarketplace.mockResolvedValueOnce([
      { id: "listing-1", name: "Preset" },
    ]);

    const res = await auth(request(app).get("/marketplace"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: "listing-1" })]);
  });

  it("lists the current user's marketplace submissions", async () => {
    const marketplaceModule = require("../marketplace");
    marketplaceModule.listUserListings.mockResolvedValueOnce([
      { id: "listing-1", name: "My Listing", status: "pending_review" },
    ]);

    const res = await auth(request(app).get("/marketplace/mine"));

    expect(res.status).toBe(200);
    expect(marketplaceModule.listUserListings).toHaveBeenCalledWith("user-1");
    expect(res.body[0]).toEqual(
      expect.objectContaining({ id: "listing-1", status: "pending_review" })
    );
  });

  it("returns detailed marketplace template data", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      snapshot_id: "snap-1",
      name: "Preset",
      status: "published",
      source_type: "platform",
      category: "Operations",
    });
    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      name: "Preset",
      description: "Operations preset",
      kind: "starter-template",
      template_key: "preset-template",
      config: {
        defaults: {
          sandbox: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
        },
        templatePayload: {
          files: [{ path: "AGENT.md", content: "starter" }],
          memoryFiles: [],
          wiring: { channels: [], integrations: [] },
        },
      },
    });

    const res = await auth(request(app).get("/marketplace/listing-1"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "listing-1",
        defaults: expect.objectContaining({ sandbox: "standard", vcpu: 2 }),
        template: expect.objectContaining({
          presentRequiredCoreCount: 7,
          hasBootstrap: true,
          coreFiles: expect.arrayContaining([
            expect.objectContaining({ path: "AGENTS.md", present: true }),
            expect.objectContaining({ path: "MEMORY.md", present: true }),
          ]),
          files: expect.arrayContaining([
            expect.objectContaining({ path: "AGENTS.md", content: expect.any(String) }),
            expect.objectContaining({ path: "SOUL.md", content: expect.any(String) }),
          ]),
        }),
      })
    );
  });

  it("lets community owners edit and resubmit their marketplace listing", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    const listing = {
      id: "listing-1",
      snapshot_id: "snap-1",
      owner_user_id: "user-1",
      name: "Preset",
      description: "Operations preset",
      status: "published",
      source_type: "community",
      category: "Operations",
      current_version: 2,
      visibility: "public",
    };
    const snapshot = {
      id: "snap-1",
      name: "Preset",
      description: "Operations preset",
      kind: "community-template",
      config: {
        defaults: {
          sandbox: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
        },
        templatePayload: {
          files: [{ path: "AGENTS.md", content: "starter" }],
          memoryFiles: [],
          wiring: { channels: [], integrations: [] },
        },
      },
    };

    marketplaceModule.getListing
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce({
        ...listing,
        name: "Updated Preset",
        status: "pending_review",
        category: "Support",
        current_version: 3,
      });
    snapshotsModule.getSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        name: "Updated Preset",
        description: "Updated description",
        config: {
          defaults: {
            sandbox: "nemoclaw",
            vcpu: 4,
            ram_mb: 4096,
            disk_gb: 40,
          },
          templatePayload: {
            files: [{ path: "AGENTS.md", content: "updated" }],
            memoryFiles: [],
            wiring: { channels: [], integrations: [] },
          },
        },
      });
    snapshotsModule.updateSnapshot.mockResolvedValueOnce({
      ...snapshot,
      name: "Updated Preset",
    });
    marketplaceModule.upsertListing.mockResolvedValueOnce({
      ...listing,
      name: "Updated Preset",
      status: "pending_review",
    });

    const res = await auth(
      request(app).patch("/marketplace/listing-1").send({
        name: "Updated Preset",
        description: "Updated description",
        category: "Support",
        slug: "updated-preset",
        currentVersion: 3,
        sandbox: "nemoclaw",
        vcpu: 4,
        ram_mb: 4096,
        disk_gb: 40,
        files: [
          {
            path: "AGENTS.md",
            content: "# Updated\n",
          },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(snapshotsModule.updateSnapshot).toHaveBeenCalledWith(
      "snap-1",
      expect.objectContaining({
        name: "Updated Preset",
        description: "Updated description",
        config: expect.objectContaining({
          defaults: expect.objectContaining({
            sandbox: "nemoclaw",
            vcpu: 4,
            ram_mb: 4096,
            disk_gb: 40,
          }),
          templatePayload: expect.objectContaining({
            files: expect.arrayContaining([
              expect.objectContaining({ path: "AGENTS.md" }),
              expect.objectContaining({ path: "SOUL.md" }),
            ]),
          }),
        }),
      })
    );
    expect(marketplaceModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        status: "pending_review",
        currentVersion: 3,
        category: "Support",
      })
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        name: "Updated Preset",
        status: "pending_review",
        category: "Support",
        current_version: 3,
      })
    );
  });

  it("publishes an owned agent as a pending community marketplace listing", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          name: "Ops Agent",
          sandbox_type: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
          image: "nora-openclaw-agent:local",
          template_payload: JSON.stringify({
            files: [{ path: "AGENT.md", content: "starter" }],
            memoryFiles: [],
            wiring: { channels: [], integrations: [] },
          }),
        },
      ],
    });
    snapshotsModule.createSnapshot.mockResolvedValueOnce({
      id: "snap-community-1",
      name: "Ops Agent Template",
      description: "Shared operations template",
    });
    marketplaceModule.upsertListing.mockResolvedValueOnce({
      id: "listing-community-1",
      name: "Ops Agent Template",
    });
    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-community-1",
      name: "Ops Agent Template",
      status: "pending_review",
      source_type: "community",
    });

    const res = await auth(
      request(app).post("/marketplace/publish").send({
        agentId: "agent-1",
        name: "Ops Agent Template",
        description: "Shared operations template",
        category: "Operations",
        price: "$99/mo",
      })
    );

    expect(res.status).toBe(200);
    expect(snapshotsModule.createSnapshot).toHaveBeenCalledWith(
      "agent-1",
      "Ops Agent Template",
      "Shared operations template",
      expect.objectContaining({
        kind: "community-template",
        defaults: expect.objectContaining({
          sandbox: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
        }),
        templatePayload: expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({ path: "AGENTS.md" }),
            expect.objectContaining({ path: "SOUL.md" }),
            expect.objectContaining({ path: "TOOLS.md" }),
            expect.objectContaining({ path: "IDENTITY.md" }),
            expect.objectContaining({ path: "USER.md" }),
            expect.objectContaining({ path: "HEARTBEAT.md" }),
            expect.objectContaining({ path: "MEMORY.md" }),
          ]),
          memoryFiles: [],
          wiring: { channels: [], integrations: [] },
        }),
      }),
      expect.objectContaining({ kind: "community-template", builtIn: false })
    );
    expect(marketplaceModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "user-1",
        price: "Free",
        sourceType: "community",
        status: "pending_review",
        visibility: "public",
      })
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "listing-community-1",
        status: "pending_review",
      })
    );
  });

  it("blocks marketplace publishing when secret-like files are detected", async () => {
    const snapshotsModule = require("../snapshots");

    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          name: "Sensitive Agent",
          sandbox_type: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
          image: "nora-openclaw-agent:local",
          template_payload: JSON.stringify({
            files: [{ path: ".env", content: "OPENAI_API_KEY=sk-testsecret123456" }],
            memoryFiles: [],
            wiring: { channels: [], integrations: [] },
          }),
        },
      ],
    });

    const res = await auth(
      request(app).post("/marketplace/publish").send({
        agentId: "agent-1",
        name: "Sensitive Template",
        description: "Should fail",
        category: "Operations",
      })
    );

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("issues");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(snapshotsModule.createSnapshot).not.toHaveBeenCalled();
  });

  it("downloads a marketplace template package", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      slug: "chief-of-staff-claw",
      name: "Chief-of-Staff Claw",
      description: "Operations preset",
      category: "Operations",
      price: "Free",
      status: "published",
      source_type: "platform",
      current_version: 1,
      snapshot_id: "snap-1",
    });
    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      kind: "starter-template",
      template_key: "chief-of-staff-claw",
      config: {
        defaults: {
          sandbox: "standard",
          vcpu: 2,
          ram_mb: 2048,
          disk_gb: 20,
          image: "nora-openclaw-agent:local",
        },
        templatePayload: {
          files: [{ path: "AGENT.md", content: "starter" }],
          memoryFiles: [],
          wiring: { channels: [], integrations: [] },
        },
      },
    });

    const res = await auth(request(app).get("/marketplace/listing-1/download"));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      "chief-of-staff-claw.nora-template.json"
    );
    expect(marketplaceModule.recordDownload).toHaveBeenCalledWith("listing-1");
    expect(res.body).toEqual(
      expect.objectContaining({
        listing: expect.objectContaining({ id: "listing-1" }),
        templatePayload: expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({ path: "AGENTS.md" }),
            expect.objectContaining({ path: "SOUL.md" }),
            expect.objectContaining({ path: "TOOLS.md" }),
            expect.objectContaining({ path: "IDENTITY.md" }),
            expect.objectContaining({ path: "USER.md" }),
            expect.objectContaining({ path: "HEARTBEAT.md" }),
            expect.objectContaining({ path: "MEMORY.md" }),
            expect.objectContaining({ path: "BOOTSTRAP.md" }),
          ]),
        }),
      })
    );
  });

  it("reports a published community listing", async () => {
    const marketplaceModule = require("../marketplace");
    const monitoringModule = require("../monitoring");

    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      name: "Community Template",
      status: "published",
      source_type: "community",
      owner_user_id: "someone-else",
    });
    marketplaceModule.createReport.mockResolvedValueOnce({
      id: "report-1",
      listing_id: "listing-1",
    });

    const res = await auth(
      request(app).post("/marketplace/listing-1/report").send({
        reason: "spam",
        details: "Low-quality content",
      })
    );

    expect(res.status).toBe(200);
    expect(marketplaceModule.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        reporterUserId: "user-1",
        reason: "spam",
        details: "Low-quality content",
      })
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "marketplace_reported",
      expect.stringContaining("reported"),
      expect.objectContaining({
        listing: expect.objectContaining({
          id: "listing-1",
          name: "Community Template",
        }),
        report: expect.objectContaining({
          id: "report-1",
          reporterUserId: "user-1",
          reporterEmail: "user@nora.test",
        }),
      })
    );
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
      expect.stringContaining("runtime_host = NULL"),
      ["a-warning"]
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(expect.objectContaining({
      id: "a-warning",
      name: "Warning Agent",
      userId: "user-1",
      backend: "docker",
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
