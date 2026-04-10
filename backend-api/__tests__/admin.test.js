const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
const mockAddDeploymentJob = jest.fn();
const mockGetDLQJobs = jest.fn();
const mockRetryDLQJob = jest.fn();
const mockBuildAgentStatsResponse = jest.fn();
const mockBuildAgentHistoryResponse = jest.fn();
const mockGetDeploymentDefaults = jest.fn().mockResolvedValue({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});
const mockUpdateDeploymentDefaults = jest.fn().mockResolvedValue({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});

jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: mockAddDeploymentJob,
  getDLQJobs: mockGetDLQJobs,
  retryDLQJob: mockRetryDLQJob,
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
}));
jest.mock("../containerManager", () => ({
  start: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue({}),
  restart: jest.fn().mockResolvedValue({}),
  destroy: jest.fn().mockResolvedValue({}),
  status: jest.fn().mockResolvedValue({ running: true }),
  stats: jest.fn(),
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
  listAdminListings: jest.fn().mockResolvedValue([]),
  listReports: jest.fn().mockResolvedValue([]),
  resolveReport: jest.fn(),
  setListingStatus: jest.fn(),
  recordInstall: jest.fn(),
  recordDownload: jest.fn(),
  createReport: jest.fn(),
  getPlatformListingByTemplateKey: jest.fn(),
}));
jest.mock("../snapshots", () => ({
  createSnapshot: jest.fn().mockResolvedValue({
    id: "snapshot-1",
    name: "Snapshot",
    description: "test",
  }),
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
}));
jest.mock("../monitoring", () => ({
  getMetrics: jest.fn().mockResolvedValue({ totalUsers: 0 }),
  logEvent: jest.fn(),
  getAuditEventsPage: jest.fn().mockResolvedValue({
    events: [],
    total: 0,
    page: 1,
    limit: 30,
    totalPages: 1,
    availableTypes: [],
  }),
  exportEvents: jest.fn().mockResolvedValue([]),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  IS_PAAS: false,
  SELFHOSTED_LIMITS: {
    max_vcpu: 16,
    max_ram_mb: 32768,
    max_disk_gb: 500,
    max_agents: 50,
  },
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
jest.mock("../agentTelemetry", () => ({
  buildAgentHistoryResponse: mockBuildAgentHistoryResponse,
  buildAgentStatsResponse: mockBuildAgentStatsResponse,
  collectAgentTelemetrySample: jest.fn(),
}));
jest.mock("../platformSettings", () => {
  const actual = jest.requireActual("../platformSettings");
  return {
    ...actual,
    getDeploymentDefaults: mockGetDeploymentDefaults,
    updateDeploymentDefaults: mockUpdateDeploymentDefaults,
  };
});

const app = require("../server");

const adminToken = jwt.sign({ id: "admin-1", email: "admin@nora.test", role: "admin" }, JWT_SECRET, {
  expiresIn: "1h",
});
const userToken = jwt.sign({ id: "user-1", email: "user@nora.test", role: "user" }, JWT_SECRET, {
  expiresIn: "1h",
});

function withToken(req, token) {
  return req.set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockReset();
  mockAddDeploymentJob.mockReset();
  mockGetDLQJobs.mockReset();
  mockRetryDLQJob.mockReset();
  mockBuildAgentStatsResponse.mockReset();
  mockBuildAgentHistoryResponse.mockReset();
  mockGetDeploymentDefaults.mockReset().mockResolvedValue({
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
  });
  mockUpdateDeploymentDefaults.mockReset().mockResolvedValue({
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
  });
  delete process.env.ENABLED_BACKENDS;
});

describe("admin routes", () => {
  it("rejects non-admin access to /admin/agents", async () => {
    const res = await withToken(request(app).get("/admin/agents"), userToken);
    expect(res.status).toBe(403);
  });

  it("returns deployment defaults for admins", async () => {
    mockGetDeploymentDefaults.mockResolvedValueOnce({
      vcpu: 1,
      ram_mb: 1024,
      disk_gb: 10,
    });

    const res = await withToken(
      request(app).get("/admin/settings/deployment-defaults"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      vcpu: 1,
      ram_mb: 1024,
      disk_gb: 10,
    });
  });

  it("updates deployment defaults for admins", async () => {
    const monitoringModule = require("../monitoring");
    mockGetDeploymentDefaults.mockResolvedValueOnce({
      vcpu: 1,
      ram_mb: 1024,
      disk_gb: 10,
    });
    mockUpdateDeploymentDefaults.mockResolvedValueOnce({
      vcpu: 2,
      ram_mb: 2048,
      disk_gb: 20,
    });

    const res = await withToken(
      request(app).put("/admin/settings/deployment-defaults").send({
        vcpu: 2,
        ram_mb: 2048,
        disk_gb: 20,
      }),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      vcpu: 2,
      ram_mb: 2048,
      disk_gb: 20,
    });
    expect(mockUpdateDeploymentDefaults).toHaveBeenCalledWith(
      { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
      expect.objectContaining({
        max_vcpu: 16,
        max_ram_mb: 32768,
        max_disk_gb: 500,
      })
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_deployment_defaults_updated",
      expect.stringContaining("2 vCPU / 2048 MB RAM / 20 GB disk"),
      expect.any(Object)
    );
  });

  it("rejects invalid deployment default updates", async () => {
    mockGetDeploymentDefaults.mockResolvedValueOnce({
      vcpu: 1,
      ram_mb: 1024,
      disk_gb: 10,
    });

    const res = await withToken(
      request(app).put("/admin/settings/deployment-defaults").send({
        vcpu: "not-a-number",
        ram_mb: 1024,
        disk_gb: 10,
      }),
      adminToken
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vcpu must be an integer/i);
    expect(mockUpdateDeploymentDefaults).not.toHaveBeenCalled();
  });

  it("returns marketplace listings for moderation", async () => {
    const marketplaceModule = require("../marketplace");
    marketplaceModule.listAdminListings.mockResolvedValueOnce([
      { id: "listing-1", name: "Community Template", status: "pending_review" },
    ]);

    const res = await withToken(request(app).get("/admin/marketplace"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "listing-1", status: "pending_review" }),
    ]);
  });

  it("returns detailed marketplace listing data for admins", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      snapshot_id: "snapshot-1",
      name: "Community Template",
      status: "pending_review",
      source_type: "community",
      category: "Operations",
    });
    marketplaceModule.listReports.mockResolvedValueOnce([
      {
        id: "report-1",
        listing_id: "listing-1",
        reason: "spam",
        status: "open",
      },
    ]);
    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snapshot-1",
      name: "Community Template",
      description: "Preset description",
      kind: "community-template",
      template_key: "community-template",
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

    const res = await withToken(
      request(app).get("/admin/marketplace/listing-1"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "listing-1",
        reports: [expect.objectContaining({ id: "report-1" })],
        defaults: expect.objectContaining({ sandbox: "standard", vcpu: 2 }),
        template: expect.objectContaining({
          presentRequiredCoreCount: 7,
          hasBootstrap: true,
          files: expect.arrayContaining([
            expect.objectContaining({ path: "AGENTS.md", content: expect.any(String) }),
            expect.objectContaining({ path: "SOUL.md", content: expect.any(String) }),
          ]),
        }),
      })
    );
  });

  it("updates marketplace template metadata and files for admins", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    const listing = {
      id: "listing-1",
      snapshot_id: "snapshot-1",
      owner_user_id: "user-1",
      name: "Community Template",
      description: "Preset description",
      status: "published",
      source_type: "community",
      category: "Operations",
      current_version: 2,
      visibility: "public",
      review_notes: "Old note",
    };
    const snapshot = {
      id: "snapshot-1",
      name: "Community Template",
      description: "Preset description",
      kind: "community-template",
      template_key: "community-template",
      built_in: false,
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
        name: "Updated Template",
        description: "Updated description",
        category: "Support",
        current_version: 3,
      });
    snapshotsModule.getSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        name: "Updated Template",
        description: "Updated description",
        template_key: "updated-template",
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
      name: "Updated Template",
    });
    marketplaceModule.upsertListing.mockResolvedValueOnce({
      ...listing,
      name: "Updated Template",
      current_version: 3,
    });
    marketplaceModule.listReports.mockResolvedValueOnce([]);

    const res = await withToken(
      request(app).patch("/admin/marketplace/listing-1").send({
        name: "Updated Template",
        description: "Updated description",
        category: "Support",
        slug: "updated-template",
        currentVersion: 3,
        templateKey: "updated-template",
        snapshotKind: "starter-template",
        sandbox: "nemoclaw",
        vcpu: 4,
        ram_mb: 4096,
        disk_gb: 40,
        reviewNotes: "Reviewed and corrected",
        files: [
          {
            path: "AGENTS.md",
            content: "# Updated\n",
          },
        ],
      }),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(snapshotsModule.updateSnapshot).toHaveBeenCalledWith(
      "snapshot-1",
      expect.objectContaining({
        name: "Updated Template",
        description: "Updated description",
        kind: "starter-template",
        templateKey: "updated-template",
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
        category: "Support",
        currentVersion: 3,
        reviewNotes: "Reviewed and corrected",
      })
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        name: "Updated Template",
        category: "Support",
        current_version: 3,
        snapshot: expect.objectContaining({
          templateKey: "updated-template",
        }),
      })
    );
  });

  it("updates a marketplace listing status", async () => {
    const marketplaceModule = require("../marketplace");
    const monitoringModule = require("../monitoring");
    marketplaceModule.setListingStatus.mockResolvedValueOnce({
      id: "listing-1",
      name: "Community Template",
      status: "published",
    });
    marketplaceModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      name: "Community Template",
      status: "published",
      source_type: "community",
    });

    const res = await withToken(
      request(app).patch("/admin/marketplace/listing-1/status").send({
        status: "published",
      }),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(marketplaceModule.setListingStatus).toHaveBeenCalledWith(
      "listing-1",
      "published",
      "admin-1",
      null
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "marketplace_reviewed",
      expect.stringContaining("marked published"),
      expect.objectContaining({
        actor: expect.objectContaining({
          email: "admin@nora.test",
          userId: "admin-1",
        }),
        listing: expect.objectContaining({
          id: "listing-1",
          status: "published",
        }),
      })
    );
  });

  it("publishes platform marketplace listings as free", async () => {
    const marketplaceModule = require("../marketplace");
    const snapshotsModule = require("../snapshots");

    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snapshot-1",
      name: "Platform Template",
      description: "Preset description",
      template_key: "platform-template",
    });
    marketplaceModule.upsertListing.mockResolvedValueOnce({
      id: "listing-1",
      name: "Platform Template",
      price: "Free",
      status: "published",
    });

    const res = await withToken(
      request(app).post("/admin/marketplace/publish").send({
        snapshotId: "snapshot-1",
        price: "$49/mo",
      }),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(marketplaceModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: "snapshot-1",
        price: "Free",
        sourceType: "platform",
        status: "published",
        visibility: "public",
      })
    );
  });

  it("returns marketplace reports for admins", async () => {
    const marketplaceModule = require("../marketplace");
    marketplaceModule.listReports.mockResolvedValueOnce([
      { id: "report-1", listing_id: "listing-1", status: "open" },
    ]);

    const res = await withToken(
      request(app).get("/admin/marketplace/reports"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "report-1", status: "open" }),
    ]);
  });

  it("resolves marketplace reports", async () => {
    const marketplaceModule = require("../marketplace");
    const monitoringModule = require("../monitoring");
    marketplaceModule.resolveReport.mockResolvedValueOnce({
      id: "report-1",
      listing_id: "listing-1",
      status: "dismissed",
    });

    const res = await withToken(
      request(app).patch("/admin/marketplace/reports/report-1").send({
        status: "dismissed",
      }),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(marketplaceModule.resolveReport).toHaveBeenCalledWith(
      "report-1",
      "admin-1",
      "dismissed"
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "marketplace_report_resolved",
      expect.stringContaining("dismissed"),
      expect.objectContaining({
        actor: expect.objectContaining({
          email: "admin@nora.test",
          userId: "admin-1",
        }),
        listing: expect.objectContaining({
          id: "listing-1",
        }),
        report: expect.objectContaining({
          id: "report-1",
          status: "dismissed",
          reviewerUserId: "admin-1",
          reviewerEmail: "admin@nora.test",
        }),
      })
    );
  });

  it("returns enriched admin users with agent counts", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "user-1",
          email: "ops@example.com",
          name: "Ops User",
          role: "admin",
          created_at: "2026-04-08T00:00:00.000Z",
          agentCount: 3,
        },
      ],
    });

    const res = await withToken(request(app).get("/admin/users"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        email: "ops@example.com",
        agentCount: 3,
      }),
    ]);
  });

  it("logs actor and target detail when an admin changes a user role", async () => {
    const monitoringModule = require("../monitoring");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-2", email: "target@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "user-2", email: "target@example.com", role: "admin" }],
      });

    const res = await withToken(
      request(app).put("/admin/users/user-2/role").send({ role: "admin" }),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_user_role_changed",
      expect.stringContaining("target@example.com"),
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "account",
          label: "admin@nora.test",
          service: "backend-api",
          account: expect.objectContaining({
            userId: "admin-1",
            email: "admin@nora.test",
            role: "admin",
          }),
        }),
        actor: expect.objectContaining({
          userId: "admin-1",
          email: "admin@nora.test",
          role: "admin",
        }),
        user: expect.objectContaining({
          id: "user-2",
          email: "target@example.com",
          role: "admin",
        }),
        result: expect.objectContaining({
          previousRole: "user",
          nextRole: "admin",
        }),
      })
    );
  });

  it("logs rejected admin mutations with error detail", async () => {
    const monitoringModule = require("../monitoring");

    const res = await withToken(
      request(app).put("/admin/users/user-2/role").send({ role: "superadmin" }),
      adminToken
    );

    expect(res.status).toBe(400);
    await new Promise((resolve) => setImmediate(resolve));
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_action_failed",
      expect.stringContaining("PUT /admin/users/user-2/role"),
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "account",
          label: "admin@nora.test",
          service: "backend-api",
        }),
        actor: expect.objectContaining({
          userId: "admin-1",
          email: "admin@nora.test",
        }),
        error: expect.objectContaining({
          message: "Invalid role",
          status: 400,
        }),
      })
    );
  });

  it("returns the global admin fleet with owner metadata", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          name: "Global Agent",
          status: "running",
          ownerEmail: "owner@example.com",
          created_at: "2026-04-08T00:00:00.000Z",
        },
      ],
    });

    const res = await withToken(request(app).get("/admin/agents"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        id: "agent-1",
        ownerEmail: "owner@example.com",
      })
    );
  });

  it("returns admin agent stats through the telemetry builder", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          name: "Stats Agent",
          status: "running",
          container_id: "container-1",
        },
      ],
    });
    mockBuildAgentStatsResponse.mockResolvedValueOnce({
      backend_type: "docker",
      capabilities: { cpu: true },
      current: { cpu_percent: 42.1 },
    });

    const res = await withToken(
      request(app).get("/admin/agents/agent-1/stats"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(mockBuildAgentStatsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" })
    );
    expect(res.body.current).toEqual(expect.objectContaining({ cpu_percent: 42.1 }));
  });

  it("returns admin agent history through the telemetry builder", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-1",
          user_id: "user-1",
          name: "History Agent",
          status: "running",
          container_id: "container-1",
        },
      ],
    });
    mockBuildAgentHistoryResponse.mockResolvedValueOnce({
      backend_type: "docker",
      capabilities: { cpu: true },
      samples: [{ recorded_at: "2026-04-08T00:00:00.000Z", cpu_percent: 10 }],
    });

    const res = await withToken(
      request(app).get("/admin/agents/agent-1/stats/history?range=1h"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(mockBuildAgentHistoryResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.any(Date),
      expect.any(Date)
    );
    expect(res.body.samples).toHaveLength(1);
  });

  it("requeues an agent redeploy with the owning user id", async () => {
    const monitoring = require("../monitoring");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            user_id: "user-2",
            name: "Redeploy Agent",
            status: "stopped",
            sandbox_type: "standard",
            vcpu: 4,
            ram_mb: 4096,
            disk_gb: 40,
            container_name: "agent-container",
            image: "nora/agent:latest",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).post("/admin/agents/agent-1/redeploy"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        userId: "user-2",
        backend: "docker",
        specs: { vcpu: 4, ram_mb: 4096, disk_gb: 40 },
      })
    );
    expect(monitoring.logEvent).toHaveBeenCalled();
  });

  it("destroys agent containers before deleting the user", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-7", email: "user@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-7",
            user_id: "user-7",
            name: "Owned Agent",
            container_id: "container-7",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).delete("/admin/users/user-7"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(containerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-7" })
    );
    expect(mockDb.query).toHaveBeenLastCalledWith(
      "DELETE FROM users WHERE id = $1",
      ["user-7"]
    );
  });

  it("deletes global agents with admin privileges", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-9",
            user_id: "user-9",
            name: "Delete Agent",
            container_id: "container-9",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).delete("/admin/agents/agent-9"),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(containerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-9" })
    );
    expect(res.body).toEqual({ success: true });
  });

  it("returns paginated audit results with date and type filters", async () => {
    const monitoringModule = require("../monitoring");
    monitoringModule.getAuditEventsPage.mockResolvedValueOnce({
      events: [
        {
          id: "event-1",
          type: "admin_action_failed",
          message: "admin action failed: PUT /admin/users/user-2/role",
          metadata: {
            actor: { email: "admin@nora.test" },
            error: { message: "Invalid role", status: 400 },
          },
          created_at: "2026-04-08T12:00:00.000Z",
        },
      ],
      total: 23,
      page: 2,
      limit: 30,
      totalPages: 1,
      availableTypes: ["admin_action_failed", "agent_started"],
    });

    const res = await withToken(
      request(app).get(
        "/admin/audit?search=invalid&type=admin_action_failed&from=2026-04-01&to=2026-04-08&page=2&limit=30"
      ),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(monitoringModule.getAuditEventsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "invalid",
        type: "admin_action_failed",
        from: expect.any(Date),
        to: expect.any(Date),
        page: 2,
        limit: 30,
      })
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        total: 23,
        page: 2,
        limit: 30,
      })
    );
    expect(res.body.availableTypes).toEqual(
      expect.arrayContaining(["admin_action_failed", "agent_started"])
    );
    expect(res.body.events).toHaveLength(1);
  });

  it("exports filtered audit results as csv", async () => {
    const monitoringModule = require("../monitoring");
    monitoringModule.exportEvents.mockResolvedValueOnce([
      {
        id: "event-1",
        type: "admin_action_failed",
        message: "admin action failed: PUT /admin/users/user-2/role",
        metadata: {
          actor: { email: "admin@nora.test", userId: "admin-1", role: "admin" },
          request: {
            method: "PUT",
            path: "/admin/users/user-2/role",
            correlationId: "corr-1",
          },
          error: {
            name: "AppError",
            code: "INVALID_ROLE",
            status: 400,
            message: "Invalid role",
          },
        },
        created_at: "2026-04-08T12:00:00.000Z",
      },
    ]);

    const res = await withToken(
      request(app).get(
        "/admin/audit/export?search=invalid&type=admin_action_failed"
      ),
      adminToken
    );

    expect(res.status).toBe(200);
    expect(monitoringModule.exportEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "invalid",
        type: "admin_action_failed",
      })
    );
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("nora-audit-");
    expect(res.text).toContain("admin_action_failed");
    expect(res.text).toContain("Invalid role");
    expect(res.text).toContain("metadata_json");
    expect(res.text).toContain("source_kind");
  });
});
