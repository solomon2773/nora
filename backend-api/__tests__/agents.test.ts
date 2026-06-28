// @ts-nocheck
/**
 * __tests__/agents.test.js — Agent management endpoint tests
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
const mockAddDeploymentJob = jest.fn();
const mockStats = jest.fn();
const mockSyncAuthToUserAgents = jest.fn().mockResolvedValue([]);
const mockRunContainerCommand = jest.fn();
const mockListHermesChannels = jest.fn();
const mockSaveHermesChannel = jest.fn();
const mockDeleteHermesChannel = jest.fn();
const mockTestHermesChannel = jest.fn();
const mockReadHermesRuntimeSnapshot = jest.fn().mockResolvedValue({
  runtimeStatus: {
    gateway_state: "running",
    active_agents: 1,
    updated_at: "2026-04-12T12:00:00.000Z",
    platforms: {},
  },
  directory: {
    updated_at: "2026-04-12T12:00:00.000Z",
    platforms: {},
  },
  platformDetails: {},
  jobsCount: 0,
  modelConfig: {
    defaultModel: null,
    provider: null,
    baseUrl: null,
  },
});
const mockGetOwnedMigrationDraft = jest.fn();
const mockAttachDraftToAgent = jest.fn();
const mockMaterializeManagedMigrationState = jest.fn();
const mockBuildMigrationManifestFromAgent = jest.fn();
const mockPackMigrationBundle = jest.fn();
const mockRootsForAgent = jest.fn();
const mockListFiles = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockDownloadPath = jest.fn();
const mockCreateDirectory = jest.fn();
const mockMovePath = jest.fn();
const mockDeletePath = jest.fn();
const mockNormalizeRelativePath = jest.fn((input, { allowEmpty = true } = {}) => {
  const raw = String(input || "").trim();
  if (!raw) return allowEmpty ? "" : null;
  return raw.replace(/^\/+/, "");
});
const mockGetDeploymentDefaults = jest.fn().mockResolvedValue({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});
const mockGetAgentHubSourceApiKey = jest.fn().mockResolvedValue("nora_hub_test_key");
const mockAssertKubernetesExecutionTargetAvailable = jest.fn().mockResolvedValue();
jest.mock("../db", () => mockDb);
// Marked, transparent crypto so we can assert gateway_token is encrypted on
// write (enc(...) wrapper) while legacy/plaintext values still pass through
// decrypt unchanged — keeping every existing plaintext-token assertion valid.
jest.mock("../crypto", () => ({
  encrypt: (v) => (v == null || v === "" ? v : `enc(${v})`),
  decrypt: (v) => (typeof v === "string" && v.startsWith("enc(") ? v.slice(4, -1) : v),
  isEncryptionConfigured: () => true,
  ensureEncryptionConfigured: () => {},
  DecryptionError: class DecryptionError extends Error {},
}));
jest.mock("../redisQueue", () => ({
  addDeploymentJob: mockAddDeploymentJob,
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../kubernetesClusters", () => ({
  assertKubernetesExecutionTargetAvailable: mockAssertKubernetesExecutionTargetAvailable,
  listKubernetesExecutionTargets: jest.fn().mockResolvedValue([]),
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
}));
jest.mock("../containerManager", () => ({
  start: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue({}),
  restart: jest.fn().mockResolvedValue({}),
  destroy: jest.fn().mockResolvedValue({}),
  canMutate: jest.fn(
    (agent) =>
      Boolean(agent?.container_id) ||
      ((agent?.backend_type === "k8s" || agent?.deploy_target === "k8s") &&
        Boolean(agent?.container_name || agent?.name || agent?.id)),
  ),
  canDestroy: jest.fn((agent) => Boolean(agent?.container_id || agent?.container_name)),
  isKubernetesAgent: jest.fn(
    (agent) => agent?.backend_type === "k8s" || agent?.deploy_target === "k8s",
  ),
  status: jest.fn().mockResolvedValue({ running: true }),
  stats: mockStats,
}));
jest.mock("../agentHubStore", () => ({
  LISTING_SOURCE_COMMUNITY: "community",
  LISTING_SOURCE_PLATFORM: "platform",
  LISTING_STATUS_PENDING_REVIEW: "pending_review",
  LISTING_STATUS_PUBLISHED: "published",
  LISTING_STATUS_REJECTED: "rejected",
  LISTING_STATUS_REMOVED: "removed",
  LISTING_VISIBILITY_PUBLIC: "public",
  LISTING_SHARE_TARGET_INTERNAL: "internal",
  LISTING_SHARE_TARGET_COMMUNITY: "community",
  LISTING_SHARE_TARGET_BOTH: "both",
  LISTING_LOCAL_VISIBILITY_OWNER: "owner",
  LISTING_LOCAL_VISIBILITY_INTERNAL: "internal",
  CENTRAL_SHARE_STATUS_NOT_SHARED: "not_shared",
  CENTRAL_SHARE_STATUS_QUEUED: "queued",
  CENTRAL_SHARE_STATUS_SUBMITTED: "submitted",
  CENTRAL_SHARE_STATUS_FAILED: "failed",
  listAgentHubLocalListings: jest.fn().mockResolvedValue([]),
  listUserListings: jest.fn().mockResolvedValue([]),
  listCommunityCatalog: jest.fn().mockResolvedValue([]),
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
  updateCentralShareStatus: jest.fn(),
  getPlatformListingByTemplateKey: jest.fn(),
}));
jest.mock("../agentHubRemote", () => ({
  fetchCatalog: jest.fn().mockResolvedValue({ items: [], hub: { url: "https://nora.test" } }),
  fetchListing: jest.fn(),
  submitListing: jest.fn().mockResolvedValue({ id: "central-listing-1" }),
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
  listAgentCandidates: jest.fn().mockResolvedValue([]),
  removeAgent: jest.fn(),
  listAccessibleAgents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../integrations", () => ({
  listIntegrations: jest.fn().mockResolvedValue([]),
  connectIntegration: jest.fn(),
  replaceIntegration: jest.fn(),
  removeIntegration: jest.fn(),
  testIntegration: jest.fn(),
  getCatalog: jest.fn().mockResolvedValue([]),
  getCatalogItem: jest.fn(),
  getIntegrationsForSync: jest.fn().mockResolvedValue({}),
  getIntegrationEnvVars: jest.fn().mockResolvedValue({}),
  integrationProviderAffectsLlmAuth: jest.fn().mockReturnValue(false),
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
  parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
  getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
  getAccessibleWorkspaceCosts: jest
    .fn()
    .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  recordMetric: jest.fn().mockResolvedValue(),
  recordTokenUsage: jest.fn().mockResolvedValue(),
  recordApiMetric: jest.fn(),
}));
jest.mock("../platformSettings", () => {
  const actual = jest.requireActual("../platformSettings");
  return {
    ...actual,
    getDeploymentDefaults: mockGetDeploymentDefaults,
    getAgentHubSourceApiKey: mockGetAgentHubSourceApiKey,
    getAgentHubSettings: jest.fn().mockResolvedValue({
      defaultShareTarget: "both",
      url: "https://nora.test",
      envUrl: "https://nora.test",
      sourceApiKeyConfigured: true,
      sourceApiKeySource: "database",
      sourceApiKeyMasked: "nora_hub..._key",
    }),
  };
});
jest.mock("../authSync", () => ({
  syncAuthToUserAgents: mockSyncAuthToUserAgents,
  runContainerCommand: mockRunContainerCommand,
}));
jest.mock("../hermesUi", () => ({
  listHermesChannels: mockListHermesChannels,
  saveHermesChannel: mockSaveHermesChannel,
  deleteHermesChannel: mockDeleteHermesChannel,
  testHermesChannel: mockTestHermesChannel,
  readHermesRuntimeSnapshot: mockReadHermesRuntimeSnapshot,
}));
jest.mock("../agentMigrations", () => ({
  attachDraftToAgent: mockAttachDraftToAgent,
  buildLiveMigrationManifest: jest.fn(),
  buildMigrationManifestFromAgent: mockBuildMigrationManifestFromAgent,
  createMigrationDraft: jest.fn(),
  deleteOwnedMigrationDraft: jest.fn(),
  getOwnedMigrationDraft: mockGetOwnedMigrationDraft,
  materializeManagedMigrationState: mockMaterializeManagedMigrationState,
  packMigrationBundle: mockPackMigrationBundle,
  parseUploadedMigrationBuffer: jest.fn(),
}));
jest.mock("../agentFiles", () => ({
  createDirectory: mockCreateDirectory,
  deletePath: mockDeletePath,
  downloadPath: mockDownloadPath,
  listFiles: mockListFiles,
  movePath: mockMovePath,
  normalizeRelativePath: mockNormalizeRelativePath,
  readFile: mockReadFile,
  rootsForAgent: mockRootsForAgent,
  writeFile: mockWriteFile,
}));

const app = require("../server");
const metrics = require("../metrics");

const userToken = jwt.sign({ id: "user-1", email: "user@nora.test", role: "user" }, JWT_SECRET, {
  expiresIn: "1h",
});
const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);
const hubKeyAuth = (req) => req.set("Authorization", "Bearer nora_hub_test_key");

function mockValidHubApiKey() {
  mockDb.query
    .mockResolvedValueOnce({
      rows: [
        {
          id: "hub-key-1",
          user_id: "publisher-1",
          label: "Nora installation",
          key_prefix: "nora_hub_test",
          status: "active",
          created_at: "2026-04-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
          email: "publisher@nora.test",
          name: "Publisher One",
          avatar: "data:image/png;base64,avatar",
          role: "user",
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
}

function createMockFetchResponse({ ok = true, status = 200, body = {}, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);

  return {
    ok,
    status,
    headers: {
      get(name) {
        return normalizedHeaders[String(name || "").toLowerCase()] ?? null;
      },
    },
    text: jest.fn().mockResolvedValue(rawBody),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockReset();
  mockAddDeploymentJob.mockReset();
  mockSyncAuthToUserAgents.mockReset().mockResolvedValue([]);
  mockRunContainerCommand.mockReset();
  mockListHermesChannels.mockReset().mockResolvedValue({
    channels: [],
    availableTypes: [],
    gateway: null,
    directoryUpdatedAt: null,
  });
  mockSaveHermesChannel.mockReset();
  mockDeleteHermesChannel.mockReset().mockResolvedValue({
    channels: [],
    availableTypes: [],
    gateway: null,
    directoryUpdatedAt: null,
  });
  mockTestHermesChannel.mockReset();
  mockReadHermesRuntimeSnapshot.mockReset().mockResolvedValue({
    runtimeStatus: {
      gateway_state: "running",
      active_agents: 1,
      updated_at: "2026-04-12T12:00:00.000Z",
      platforms: {},
    },
    directory: {
      updated_at: "2026-04-12T12:00:00.000Z",
      platforms: {},
    },
    platformDetails: {},
    jobsCount: 0,
    modelConfig: {
      defaultModel: null,
      provider: null,
      baseUrl: null,
    },
  });
  mockGetOwnedMigrationDraft.mockReset();
  mockAttachDraftToAgent.mockReset();
  mockMaterializeManagedMigrationState.mockReset();
  mockBuildMigrationManifestFromAgent.mockReset();
  mockPackMigrationBundle.mockReset();
  mockRootsForAgent.mockReset();
  mockListFiles.mockReset();
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  mockDownloadPath.mockReset();
  mockCreateDirectory.mockReset();
  mockMovePath.mockReset();
  mockDeletePath.mockReset();
  mockNormalizeRelativePath.mockClear();
  mockGetAgentHubSourceApiKey.mockReset().mockResolvedValue("nora_hub_test_key");
  mockPackMigrationBundle.mockResolvedValue(Buffer.from("bundle"));
  mockRootsForAgent.mockReturnValue([]);
  mockGetDeploymentDefaults.mockReset().mockResolvedValue({
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
  });
  delete process.env.ENABLED_BACKENDS;
  delete process.env.ENABLED_RUNTIME_FAMILIES;
  delete process.env.ENABLED_SANDBOX_PROFILES;
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.NEXTAUTH_URL;
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
    const workspaces = require("../workspaces");
    workspaces.listAccessibleAgents.mockResolvedValueOnce([
      { id: "a1", name: "Agent 1", status: "running", created_at: new Date().toISOString() },
    ]);

    const res = await auth(request(app).get("/agents"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("name", "Agent 1");
    expect(workspaces.listAccessibleAgents).toHaveBeenCalledWith("user-1", {
      scope: "accessible",
    });
  });

  it("supports direct-owned scope for deploy and quota surfaces", async () => {
    const workspaces = require("../workspaces");
    workspaces.listAccessibleAgents.mockResolvedValueOnce([]);

    const res = await auth(request(app).get("/agents?scope=owned"));
    expect(res.status).toBe(200);
    expect(workspaces.listAccessibleAgents).toHaveBeenCalledWith("user-1", { scope: "owned" });
  });
});

describe("GET /agents/:id", () => {
  it("preserves warning status when the container is still live", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-warning",
          name: "Warning Agent",
          status: "warning",
          user_id: "user-1",
          container_id: "container-1",
          effective_role: "owner",
        },
      ],
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
        rows: [
          {
            id: "a-warning-down",
            name: "Warning Down Agent",
            status: "warning",
            user_id: "user-1",
            container_id: "container-warning-down",
            effective_role: "owner",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-warning-down",
            status: "stopped",
          },
        ],
      });

    const res = await auth(request(app).get("/agents/a-warning-down"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "stopped");
  });

  it("reconciles stopped agents back to running when the container is live", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-stopped",
            name: "Stopped Agent",
            status: "stopped",
            user_id: "user-1",
            container_id: "container-2",
            effective_role: "owner",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-stopped",
            status: "running",
          },
        ],
      });

    const res = await auth(request(app).get("/agents/a-stopped"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "running");
  });

  it("includes Kubernetes pod replica status in agent details", async () => {
    const containerManager = require("../containerManager");
    containerManager.status.mockResolvedValueOnce({
      running: true,
      replicas: {
        specReplicas: 2,
        replicas: 2,
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 2,
      },
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-k8s-replicas",
          name: "K8s Replicas",
          status: "running",
          user_id: "user-1",
          runtime_family: "openclaw",
          backend_type: "k8s",
          deploy_target: "k8s",
          execution_target_id: "k8s:test-cluster",
          sandbox_profile: "standard",
          container_id: "nora-oclaw-k8s-replicas",
          effective_role: "owner",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-k8s-replicas"));

    expect(res.status).toBe(200);
    expect(res.body.runtime_status.replicas).toEqual({
      specReplicas: 2,
      replicas: 2,
      readyReplicas: 1,
      availableReplicas: 1,
      updatedReplicas: 2,
    });
  });
});

describe("GET /agents/:id/gateway-url", () => {
  it("uses GATEWAY_HOST when returning a published gateway url", async () => {
    process.env.GATEWAY_HOST = "gateway.external";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-gateway",
          container_id: "container-gateway",
          gateway_token: "gateway-token",
          gateway_host_port: 19123,
          user_id: "user-1",
          status: "running",
        },
      ],
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
    process.env.NEXTAUTH_URL = "http://app.nora.test:8080";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-warning-gateway",
          container_id: "container-warning-gateway",
          gateway_host_port: 19123,
          user_id: "user-1",
          status: "warning",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-warning-gateway/gateway-url"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://app.nora.test:19123",
      port: 19123,
    });

    delete process.env.NEXTAUTH_URL;
  });

  it("keeps published gateway urls on http when the control plane is behind https", async () => {
    process.env.NEXTAUTH_URL = "https://app.nora.test";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-https-gateway",
          container_id: "container-https-gateway",
          gateway_host_port: 19123,
          user_id: "user-1",
          status: "running",
        },
      ],
    });

    const res = await auth(
      request(app).get("/agents/a-https-gateway/gateway-url").set("X-Forwarded-Proto", "https"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "http://app.nora.test:19123",
      port: 19123,
    });

    delete process.env.NEXTAUTH_URL;
  });

  it("allows an explicit https override for published gateway urls", async () => {
    process.env.NEXTAUTH_URL = "https://app.nora.test";
    process.env.GATEWAY_PROTOCOL = "https";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-https-gateway",
          container_id: "container-https-gateway",
          gateway_host_port: 19123,
          user_id: "user-1",
          status: "running",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-https-gateway/gateway-url"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://app.nora.test:19123",
      port: 19123,
    });

    delete process.env.NEXTAUTH_URL;
    delete process.env.GATEWAY_PROTOCOL;
  });

  it("uses explicit gateway host and port when the backend records them", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-k8s-gateway",
          host: "oclaw-agent-a-k8s.openclaw-agents.svc.cluster.local",
          container_id: "oclaw-agent-a-k8s",
          backend_type: "k8s",
          gateway_host_port: null,
          gateway_host: "nora-kind-control-plane",
          gateway_port: 31879,
          user_id: "user-1",
          status: "running",
        },
      ],
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
      rows: [
        {
          id: "a-stopped-gateway",
          container_id: "container-gateway",
          gateway_host_port: 19123,
          user_id: "user-1",
          status: "stopped",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-stopped-gateway/gateway-url"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only available while running/i);
  });

  it("rejects gateway url lookups for error agents so failed control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-error-gateway",
          container_id: "container-error-gateway",
          gateway_host_port: 19123,
          user_id: "user-1",
          status: "error",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-error-gateway/gateway-url"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only available while running/i);
  });
});

describe("Hermes WebUI routes", () => {
  it("returns Hermes runtime status and model metadata", async () => {
    mockReadHermesRuntimeSnapshot.mockResolvedValueOnce({
      runtimeStatus: {
        gateway_state: "running",
        active_agents: 1,
        updated_at: "2026-04-12T12:00:00.000Z",
        platforms: {},
      },
      directory: {
        updated_at: "2026-04-12T12:00:00.000Z",
        platforms: {},
      },
      platformDetails: {},
      jobsCount: 0,
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "custom",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-ui",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.40",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { status: "ok", platform: "hermes-agent" },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            object: "list",
            data: [{ id: "desk-bot", object: "model" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            version: "1.0.0",
            gateway_running: true,
            gateway_state: "running",
            active_sessions: 4,
          },
        }),
      );

    const res = await auth(request(app).get("/agents/a-hermes-ui/hermes-ui"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        url: "http://10.0.0.40:8642/v1",
        runtime: { host: "10.0.0.40", port: 8642 },
        health: expect.objectContaining({ ok: true, status: "ok" }),
        dashboard: expect.objectContaining({
          ready: true,
          url: "http://10.0.0.40:9119",
          port: 9119,
          health: {
            version: "1.0.0",
            gatewayRunning: true,
            gatewayState: "running",
            activeSessions: 4,
          },
          retryable: false,
          error: null,
        }),
        defaultModel: "gpt-5.5",
        configuredModel: "gpt-5.5",
        configuredProvider: "custom",
        configuredBaseUrl: "https://api.openai.com/v1",
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://10.0.0.40:8642/health",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-token",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://10.0.0.40:8642/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-token",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://10.0.0.40:9119/api/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
    expect(res.body.gateway).toEqual(
      expect.objectContaining({
        state: "running",
        activeAgents: 1,
        jobsCount: 0,
      }),
    );
  });

  it("surfaces a redeploy message when the running Hermes image does not include the official dashboard", async () => {
    mockReadHermesRuntimeSnapshot.mockResolvedValueOnce({
      runtimeStatus: {
        gateway_state: "running",
        active_agents: 1,
        updated_at: "2026-04-12T12:00:00.000Z",
        platforms: {},
      },
      directory: {
        updated_at: "2026-04-12T12:00:00.000Z",
        platforms: {},
      },
      platformDetails: {},
      jobsCount: 0,
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "custom",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-ui-old-image",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.41",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { status: "ok", platform: "hermes-agent" },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            object: "list",
            data: [{ id: "desk-bot", object: "model" }],
          },
        }),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    mockRunContainerCommand.mockResolvedValueOnce({
      exitCode: 0,
      output: ["STATUS=missing-dashboard", "VERSION=Hermes Agent v0.8.0 (2026.4.8)", ""].join("\n"),
    });

    const res = await auth(request(app).get("/agents/a-hermes-ui-old-image/hermes-ui"));

    expect(res.status).toBe(200);
    expect(res.body.dashboard).toEqual({
      ready: false,
      url: "http://10.0.0.41:9119",
      port: 9119,
      health: null,
      retryable: false,
      error:
        "This Hermes image (Hermes Agent v0.8.0 (2026.4.8)) does not include the official dashboard yet. Pull a current Hermes image and redeploy this agent.",
    });
    expect(mockRunContainerCommand).toHaveBeenCalledTimes(1);
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain("setsid");
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain(
      'gosu hermes "$HERMES_BIN" dashboard',
    );
    expect(mockRunContainerCommand.mock.calls[0][1]).not.toContain("hermes_cli.web_server");
  });

  it("recovers a cold Hermes dashboard by starting the current CLI inside the running container", async () => {
    mockReadHermesRuntimeSnapshot.mockResolvedValueOnce({
      runtimeStatus: {
        gateway_state: "running",
        active_agents: 1,
        updated_at: "2026-04-12T12:00:00.000Z",
        platforms: {},
      },
      directory: {
        updated_at: "2026-04-12T12:00:00.000Z",
        platforms: {},
      },
      platformDetails: {},
      jobsCount: 0,
      modelConfig: {
        defaultModel: "gpt-5.5",
        provider: "custom",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-ui-recover",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.42",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { status: "ok", platform: "hermes-agent" },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            object: "list",
            data: [{ id: "desk-bot", object: "model" }],
          },
        }),
      )
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            version: "0.11.0",
            gateway_running: true,
            gateway_state: "running",
            active_sessions: 0,
          },
        }),
      );
    mockRunContainerCommand.mockResolvedValueOnce({
      exitCode: 0,
      output: [
        "Hermes Web UI → http://0.0.0.0:9119",
        "STATUS=started",
        "VERSION=Hermes Agent v0.11.0 (2026.4.23)",
        "",
      ].join("\n"),
    });

    const res = await auth(request(app).get("/agents/a-hermes-ui-recover/hermes-ui"));

    expect(res.status).toBe(200);
    expect(res.body.dashboard).toEqual({
      ready: true,
      url: "http://10.0.0.42:9119",
      port: 9119,
      health: {
        version: "0.11.0",
        gatewayRunning: true,
        gatewayState: "running",
        activeSessions: 0,
      },
      retryable: false,
      error: null,
    });
    expect(mockRunContainerCommand).toHaveBeenCalledTimes(1);
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain("setsid");
    expect(mockRunContainerCommand.mock.calls[0][1]).toContain(
      'gosu hermes "$HERMES_BIN" dashboard',
    );
    expect(mockRunContainerCommand.mock.calls[0][1]).not.toContain("hermes_cli.web_server");
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      "http://10.0.0.42:9119/api/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
  });

  it("proxies Hermes chat requests through the runtime API", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-chat",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.41",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValueOnce(
      createMockFetchResponse({
        body: {
          id: "chatcmpl-1",
          model: "desk-bot",
          choices: [
            {
              message: {
                role: "assistant",
                content: "I checked the workspace.",
              },
            },
          ],
          usage: { total_tokens: 42 },
        },
        headers: {
          "x-hermes-session-id": "sess-123",
        },
      }),
    );

    const res = await auth(
      request(app)
        .post("/agents/a-hermes-chat/hermes-ui/chat")
        .send({
          messages: [{ role: "user", content: "Inspect the workspace" }],
        }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: "I checked the workspace.",
        model: "desk-bot",
        sessionId: "sess-123",
        usage: expect.objectContaining({ total_tokens: 42 }),
      }),
    );

    const [targetUrl, requestOptions] = global.fetch.mock.calls[0];
    expect(targetUrl).toBe("http://10.0.0.41:8642/v1/chat/completions");
    expect(requestOptions).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-token",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(requestOptions.body)).toEqual({
      stream: false,
      messages: [{ role: "user", content: "Inspect the workspace" }],
    });
    expect(metrics.recordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-chat", runtime_family: "hermes" }),
      "user-1",
      expect.objectContaining({
        model: "desk-bot",
        usage: { total_tokens: 42 },
      }),
      expect.objectContaining({
        runtimeFamily: "hermes",
        source: "hermes-ui",
        model: "desk-bot",
        sessionId: "sess-123",
      }),
    );
  });

  it("rejects Hermes cron routes for non-Hermes agents", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-openclaw-hermes-ui",
          user_id: "user-1",
          status: "running",
          runtime_family: "openclaw",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-openclaw-hermes-ui/hermes-ui/cron"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not expose the Hermes WebUI surface/i);
  });

  it("rejects Hermes channel routes when the runtime is not running", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-ui-stopped",
          user_id: "user-1",
          status: "stopped",
          runtime_family: "hermes",
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-hermes-ui-stopped/hermes-ui/channels"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only available while the agent is running/i);
  });

  it("proxies Hermes cron list requests", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-cron-list",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.42",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValueOnce(
      createMockFetchResponse({
        body: {
          jobs: [{ id: "job-1", name: "Daily summary" }],
        },
      }),
    );

    const res = await auth(request(app).get("/agents/a-hermes-cron-list/hermes-ui/cron"));

    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([{ id: "job-1", name: "Daily summary" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.42:8642/api/jobs?include_disabled=true",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-token",
        }),
      }),
    );
  });

  it("maps Nora cron create payloads to Hermes prompt payloads", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-cron-create",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.43",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValueOnce(
      createMockFetchResponse({
        body: {
          job: { id: "job-2", name: "Daily summary" },
        },
      }),
    );

    const res = await auth(
      request(app).post("/agents/a-hermes-cron-create/hermes-ui/cron").send({
        name: "Daily summary",
        schedule: "0 9 * * *",
        message: "Summarize the last 24 hours",
      }),
    );

    expect(res.status).toBe(200);
    const [targetUrl, requestOptions] = global.fetch.mock.calls[0];
    expect(targetUrl).toBe("http://10.0.0.43:8642/api/jobs");
    expect(requestOptions).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-token",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(requestOptions.body)).toEqual({
      name: "Daily summary",
      schedule: "0 9 * * *",
      prompt: "Summarize the last 24 hours",
    });
  });

  it("proxies Hermes cron deletions", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-cron-delete",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "docker",
          container_id: "hermes-container",
          runtime_host: "10.0.0.44",
          runtime_port: 8642,
          gateway_token: "hermes-token",
        },
      ],
    });
    global.fetch = jest.fn().mockResolvedValueOnce(
      createMockFetchResponse({
        body: {
          deleted: true,
        },
      }),
    );

    const res = await auth(
      request(app).delete("/agents/a-hermes-cron-delete/hermes-ui/cron/job-9"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, deleted: true }));
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.44:8642/api/jobs/job-9",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-token",
        }),
      }),
    );
  });

  it("rejects a running Hermes agent with no container_id with an actionable 409", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-broken",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          container_id: null,
        },
      ],
    });

    const res = await auth(request(app).get("/agents/a-hermes-broken/hermes-ui/channels"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no container assigned/i);
    expect(res.body.error).toMatch(/redeploy/i);
    // No downstream helper should run for a broken-state agent.
    expect(mockListHermesChannels).not.toHaveBeenCalled();
  });

  it("lists Hermes channels through the helper", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-channel-list",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          container_id: "hermes-container",
        },
      ],
    });
    mockListHermesChannels.mockResolvedValueOnce({
      channels: [{ type: "telegram", name: "Telegram" }],
      availableTypes: [{ type: "telegram", label: "Telegram" }],
      gateway: { state: "running" },
      directoryUpdatedAt: "2026-04-12T12:00:00.000Z",
    });

    const res = await auth(request(app).get("/agents/a-hermes-channel-list/hermes-ui/channels"));

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([{ type: "telegram", name: "Telegram" }]);
    expect(mockListHermesChannels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-channel-list" }),
    );
  });

  it("creates and updates Hermes channel config through the helper", async () => {
    const agent = {
      id: "a-hermes-channel-save",
      user_id: "user-1",
      status: "running",
      runtime_family: "hermes",
      container_id: "hermes-container",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });
    mockSaveHermesChannel
      .mockResolvedValueOnce({
        payload: { channels: [{ type: "telegram" }] },
        channel: { type: "telegram" },
      })
      .mockResolvedValueOnce({
        payload: { channels: [{ type: "telegram" }] },
        channel: { type: "telegram" },
      });

    const createRes = await auth(
      request(app)
        .post("/agents/a-hermes-channel-save/hermes-ui/channels")
        .send({
          type: "Telegram",
          config: { TELEGRAM_BOT_TOKEN: "secret-token" },
        }),
    );
    const updateRes = await auth(
      request(app)
        .patch("/agents/a-hermes-channel-save/hermes-ui/channels/telegram")
        .send({
          config: { TELEGRAM_BOT_TOKEN: "[REDACTED]" },
        }),
    );

    expect(createRes.status).toBe(200);
    expect(updateRes.status).toBe(200);
    expect(mockSaveHermesChannel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "a-hermes-channel-save" }),
      "telegram",
      { TELEGRAM_BOT_TOKEN: "secret-token" },
      { create: true },
    );
    expect(mockSaveHermesChannel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "a-hermes-channel-save" }),
      "telegram",
      { TELEGRAM_BOT_TOKEN: "[REDACTED]" },
    );
  });

  it("deletes and tests Hermes channels through the helper", async () => {
    const agent = {
      id: "a-hermes-channel-actions",
      user_id: "user-1",
      status: "running",
      runtime_family: "hermes",
      container_id: "hermes-container",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });
    mockDeleteHermesChannel.mockResolvedValueOnce({
      channels: [],
      availableTypes: [{ type: "telegram", label: "Telegram" }],
      gateway: { state: "running" },
      directoryUpdatedAt: "2026-04-12T12:00:00.000Z",
    });
    mockTestHermesChannel.mockResolvedValueOnce({
      success: true,
      message: "Telegram is healthy",
      state: "connected",
    });

    const deleteRes = await auth(
      request(app).delete("/agents/a-hermes-channel-actions/hermes-ui/channels/telegram"),
    );
    const testRes = await auth(
      request(app).post("/agents/a-hermes-channel-actions/hermes-ui/channels/telegram/test"),
    );

    expect(deleteRes.status).toBe(200);
    expect(testRes.status).toBe(200);
    expect(mockDeleteHermesChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-channel-actions" }),
      "telegram",
    );
    expect(mockTestHermesChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-channel-actions" }),
      "telegram",
    );
  });
});

describe("Hermes integration sync routes", () => {
  it("syncs Hermes env after connecting an integration", async () => {
    const integrationsModule = require("../integrations");
    integrationsModule.connectIntegration.mockResolvedValueOnce({
      id: "int-hermes-1",
      provider: "slack",
    });
    integrationsModule.getIntegrationsForSync.mockResolvedValueOnce([
      {
        id: "int-hermes-1",
        provider: "slack",
        name: "Slack",
        credentialEnv: { primary: "SLACK_TOKEN" },
      },
    ]);
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "a-hermes-integration", status: "synced" },
    ]);

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-integration",
            user_id: "user-1",
            name: "Hermes Integration Agent",
            status: "running",
            host: "runtime-host",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-integration",
            user_id: "user-1",
            status: "running",
            runtime_family: "hermes",
            backend_type: "docker",
            container_id: "hermes-container",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-integration",
            user_id: "user-1",
            status: "running",
            runtime_family: "hermes",
            backend_type: "docker",
            container_id: "hermes-container",
          },
        ],
      });

    const res = await auth(
      request(app).post("/agents/a-hermes-integration/integrations").send({
        provider: "slack",
        token: "xoxb-secret",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", "a-hermes-integration");
    expect(mockRunContainerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-hermes-integration",
        container_id: "hermes-container",
      }),
      expect.stringContaining("nora-integrations"),
      { timeout: 30000 },
    );
    expect(mockRunContainerCommand.mock.calls.at(-1)[1]).toContain("nora-integration-tool");
  });

  it("does not restart OpenClaw auth sync for non-LLM integrations", async () => {
    const integrationsModule = require("../integrations");
    integrationsModule.connectIntegration.mockResolvedValueOnce({
      id: "int-openclaw-slack",
      provider: "slack",
    });
    integrationsModule.getIntegrationsForSync.mockResolvedValueOnce([]);
    integrationsModule.getIntegrationEnvVars.mockResolvedValueOnce({});
    integrationsModule.integrationProviderAffectsLlmAuth.mockReturnValueOnce(false);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const agent = {
      id: "a-openclaw-integration",
      user_id: "user-1",
      name: "OpenClaw Integration Agent",
      status: "running",
      runtime_family: "openclaw",
      backend_type: "docker",
      container_id: "openclaw-container",
      host: "runtime-host",
      runtime_port: 9090,
      gateway_host: "gateway-host",
      gateway_port: 18789,
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(
      request(app).post("/agents/a-openclaw-integration/integrations").send({
        provider: "slack",
        token: "xoxb-secret",
      }),
    );

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://runtime-host:9090/integrations/sync",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockSyncAuthToUserAgents).not.toHaveBeenCalled();
  });

  it("returns a 502 when Hermes integration sync fails after disconnect", async () => {
    const integrationsModule = require("../integrations");
    integrationsModule.removeIntegration.mockResolvedValueOnce();
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      {
        agentId: "a-hermes-integration-failed",
        status: "failed",
        error: "Hermes restart failed",
      },
    ]);

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-integration-failed",
            user_id: "user-1",
            name: "Hermes Integration Agent",
            status: "running",
            host: "runtime-host",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-integration-failed",
            user_id: "user-1",
            status: "running",
            runtime_family: "hermes",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-integration-failed",
            user_id: "user-1",
            status: "running",
            runtime_family: "hermes",
          },
        ],
      });

    const res = await auth(
      request(app).delete("/agents/a-hermes-integration-failed/integrations/int-hermes-1"),
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Hermes restart failed");
  });
});

describe("Twitter/X integration OAuth routes", () => {
  it("starts OAuth with PKCE and a per-agent redirect URI", async () => {
    process.env.NEXTAUTH_URL = "https://nora.test";
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-twitter",
            user_id: "user-1",
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app)
        .post("/agents/a-twitter/integrations/twitter/oauth/start")
        .send({
          redirectPath: "/app/agents/a-twitter",
          config: {
            client_id: "user-x-client-id",
            client_secret: "user-x-client-secret",
            default_username: "configured_user",
          },
        }),
    );

    expect(res.status).toBe(200);
    const authorizationUrl = new URL(res.body.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://x.com");
    expect(authorizationUrl.pathname).toBe("/i/oauth2/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("user-x-client-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://nora.test/api/integrations/twitter/oauth/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toContain("tweet.write");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(mockDb.query.mock.calls[1][0]).toContain("INSERT INTO integration_oauth_states");
    const oauthInsertParams = mockDb.query.mock.calls[1][1];
    expect(oauthInsertParams[1]).toBe("twitter");
    expect(oauthInsertParams[2]).toBe("user-1");
    expect(oauthInsertParams[3]).toBe("a-twitter");
    expect(oauthInsertParams[5]).toBe("user-x-client-id");
    expect(typeof oauthInsertParams[6]).toBe("string");
    expect(oauthInsertParams[6]).not.toBe("");
    expect(oauthInsertParams[7]).toBe(JSON.stringify({ default_username: "configured_user" }));
    expect(oauthInsertParams[8]).toBe("/app/agents/a-twitter");
  });

  it("exchanges the callback code and stores the connected X user on that agent", async () => {
    process.env.NEXTAUTH_URL = "https://nora.test";
    const integrationsModule = require("../integrations");
    integrationsModule.replaceIntegration.mockResolvedValueOnce({
      id: "int-twitter",
      provider: "twitter",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            access_token: "x-user-access-token",
            refresh_token: "x-refresh-token",
            token_type: "bearer",
            expires_in: 7200,
            scope: "tweet.read users.read tweet.write offline.access",
          },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: {
            data: {
              id: "1773",
              username: "solomon2773",
              name: "Solomon",
            },
          },
        }),
      );
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            state: "state-1",
            provider: "twitter",
            user_id: "user-1",
            agent_id: "a-twitter",
            code_verifier: "code-verifier",
            client_id: "user-x-client-id",
            client_secret: "user-x-client-secret",
            config: { default_username: "configured_user" },
            redirect_path: "/app/agents/a-twitter",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            agent_user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-twitter",
            user_id: "user-1",
            status: "stopped",
            runtime_family: "openclaw",
          },
        ],
      });

    const res = await auth(
      request(app).get("/integrations/twitter/oauth/callback?state=state-1&code=code-1"),
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/app/agents/a-twitter?integration=twitter&status=connected");
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.x.com/2/oauth2/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("user-x-client-id:user-x-client-secret").toString("base64")}`,
        }),
      }),
    );
    expect(global.fetch.mock.calls[0][1].body.toString()).toContain(
      "redirect_uri=https%3A%2F%2Fnora.test%2Fapi%2Fintegrations%2Ftwitter%2Foauth%2Fcallback",
    );
    expect(integrationsModule.replaceIntegration).toHaveBeenCalledWith(
      "a-twitter",
      "twitter",
      "x-user-access-token",
      expect.objectContaining({
        access_token: "x-user-access-token",
        refresh_token: "x-refresh-token",
        client_id: "user-x-client-id",
        client_secret: "user-x-client-secret",
        username: "solomon2773",
        default_username: "configured_user",
        user_id: "1773",
      }),
    );
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
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", "agent-start-1", {
      onlyIfAuthPresent: true,
    });
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
      }),
    );
  });
});

describe("GET /agents/:id/stats", () => {
  it("returns normalized live stats with derived rate fields", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-metrics",
            user_id: "user-1",
            container_id: "container-metrics",
            backend_type: "docker",
            sandbox_type: "standard",
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
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
          },
        ],
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
            model: "nvidia/nemotron-3-super-120b-a12b",
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
      backend_type: "docker",
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
        rows: [
          {
            id: "a-nemo",
            user_id: "user-1",
            container_id: "container-nemo",
            backend_type: "docker",
            sandbox_type: "nemoclaw",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "nemoclaw",
            status: "running",
            host: "127.0.0.1",
            runtime_host: "127.0.0.1",
            runtime_port: 9090,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).get("/agents/a-nemo/stats"));

    expect(res.status).toBe(200);
    expect(res.body.nemo).toEqual(
      expect.objectContaining({
        available: true,
        model: "nvidia/nemotron-3-super-120b-a12b",
        inferenceConfigured: true,
        policyActive: true,
        policyRuleCount: 2,
        pendingApprovalsCount: 1,
      }),
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
        rows: [
          {
            id: "a-proxmox",
            user_id: "user-1",
            container_id: "vm-101",
            backend_type: "proxmox",
            sandbox_type: "standard",
            status: "running",
            effective_role: "owner",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
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
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
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
          },
        ],
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
      }),
    );
  });

  it("uses a 7-day window and returns the live sample when stored history is empty", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-empty",
            user_id: "user-1",
            container_id: "container-empty",
            backend_type: "docker",
            sandbox_type: "standard",
            status: "running",
            effective_role: "owner",
          },
        ],
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
      }),
    );

    const historyQueryParams = mockDb.query.mock.calls[2][1];
    const fromTime = historyQueryParams[1];
    const toTime = historyQueryParams[2];
    const bucketSeconds = historyQueryParams[3];

    expect(bucketSeconds).toBe(3600);
    expect(toTime.getTime() - fromTime.getTime()).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000);
  });
});

describe("POST /agents/adopt (external runtime)", () => {
  it("adopts a reachable OpenClaw runtime without provisioning", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-ext",
          name: "Prod OpenClaw",
          status: "running",
          user_id: "user-1",
          runtime_family: "openclaw",
          deploy_target: "external",
          execution_target_id: "external",
          gateway_host: "203.0.113.5",
          gateway_port: 18789,
        },
      ],
    });

    const res = await auth(
      request(app).post("/agents/adopt").send({
        name: "Prod OpenClaw",
        runtime_family: "openclaw",
        url: "https://203.0.113.5:18789",
        gateway_token: "secret-token",
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "a-ext", deploy_target: "external", status: "running" });
    // No provisioning job for an adopted runtime.
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    // The INSERT carries deploy_target='external' + the validated endpoint.
    const insert = mockDb.query.mock.calls.find((c) => /INSERT INTO agents/i.test(c[0]));
    expect(insert[0]).toMatch(/'external', 'external'/);
    // gateway_token must be ENCRYPTED on write — the param carries enc(...),
    // not the plaintext. This fails if the encrypt() call is ever dropped.
    expect(insert[1]).toEqual(
      expect.arrayContaining(["user-1", "openclaw", "203.0.113.5", 18789, "enc(secret-token)"]),
    );
    expect(insert[1]).not.toContain("secret-token");
  });

  it("rejects adoption without a gateway token", async () => {
    const res = await auth(
      request(app)
        .post("/agents/adopt")
        .send({ runtime_family: "openclaw", url: "https://203.0.113.5:18789" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gateway_token/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects an endpoint on a non-allowed port (SSRF gate)", async () => {
    const res = await auth(
      request(app)
        .post("/agents/adopt")
        .send({ runtime_family: "openclaw", url: "http://203.0.113.5:8080", gateway_token: "t" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/port is not allowed/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects an endpoint that resolves to a blocked address (SSRF floor)", async () => {
    const res = await auth(
      request(app).post("/agents/adopt").send({
        runtime_family: "openclaw",
        url: "http://169.254.169.254:18789",
        gateway_token: "t",
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an allowed gateway address/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects an unsupported runtime family", async () => {
    const res = await auth(
      request(app)
        .post("/agents/adopt")
        .send({ runtime_family: "nope", url: "https://203.0.113.5:18789", gateway_token: "t" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/runtime_family/i);
  });

  it("enforces the agent quota (adopted runtimes still occupy a slot)", async () => {
    require("../billing").enforceLimits.mockResolvedValueOnce({
      allowed: false,
      error: "Agent limit reached",
      subscription: { plan: "free" },
    });
    const res = await auth(
      request(app).post("/agents/adopt").send({
        runtime_family: "openclaw",
        url: "https://203.0.113.5:18789",
        gateway_token: "t",
      }),
    );
    expect(res.status).toBe(402);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("POST /agents/deploy", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app).post("/agents/deploy").send({});
    expect(res.status).toBe(401);
  });

  it("rejects agent name over 100 chars", async () => {
    const longName = "A".repeat(101);
    const res = await auth(request(app).post("/agents/deploy").send({ name: longName }));
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

    const res = await auth(request(app).post("/agents/deploy").send({ name: "TestAgent" }));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("status", "queued");
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-new",
        name: "TestAgent",
        userId: "user-1",
        backend: "docker",
        specs: { vcpu: 1, ram_mb: 1024, disk_gb: 10 },
        sandbox: "standard",
      }),
    );
  });

  it("deploys from a migration draft and attaches the draft to the new agent", async () => {
    mockGetOwnedMigrationDraft.mockResolvedValueOnce({
      id: "draft-openclaw-1",
      manifest: {
        runtimeFamily: "openclaw",
        name: "Imported Support Agent",
        templatePayload: {
          version: 1,
          files: [{ path: "README.md", contentBase64: "" }],
          memoryFiles: [],
          wiring: { channels: [], integrations: [] },
          metadata: { source: "migration-test" },
        },
        managed: {
          llmProviders: [{ provider: "openai", apiKey: "secret" }],
          integrations: [],
          channels: [],
          agentSecretOverrides: [{ key: "OPENAI_API_KEY", value: "secret" }],
        },
      },
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-migrated",
            name: "Imported Support Agent",
            status: "queued",
            user_id: "user-1",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        migration_draft_id: "draft-openclaw-1",
        deploy_target: "docker",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockGetOwnedMigrationDraft).toHaveBeenCalledWith("draft-openclaw-1", "user-1");
    expect(mockMaterializeManagedMigrationState).toHaveBeenCalledWith(
      "user-1",
      "a-migrated",
      expect.objectContaining({
        runtimeFamily: "openclaw",
      }),
    );
    expect(mockAttachDraftToAgent).toHaveBeenCalledWith("draft-openclaw-1", "a-migrated");
    expect(JSON.parse(mockDb.query.mock.calls[0][1][10])).toEqual(
      expect.objectContaining({
        files: [{ path: "README.md", contentBase64: "" }],
      }),
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-migrated",
        migration_draft_id: "draft-openclaw-1",
        backend: "docker",
      }),
    );
  });

  it("rejects deploys when the migration draft runtime family does not match the requested runtime family", async () => {
    mockGetOwnedMigrationDraft.mockResolvedValueOnce({
      id: "draft-hermes-1",
      manifest: {
        runtimeFamily: "hermes",
        name: "Imported Hermes Agent",
      },
    });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "Mismatch",
        runtime_family: "openclaw",
        migration_draft_id: "draft-hermes-1",
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be deployed as openclaw/i);
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("uses a Hermes-specific container prefix for Hermes runtime deploys", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-deploy",
            name: "Desk Bot",
            status: "queued",
            user_id: "user-1",
            runtime_family: "hermes",
            backend_type: "docker",
            deploy_target: "docker",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "Desk Bot",
        runtime_family: "hermes",
      }),
    );

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[8]).toMatch(/^nora-hermes-desk-bot-/);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-hermes-deploy",
        backend: "docker",
        container_name: expect.stringMatching(/^nora-hermes-desk-bot-/),
      }),
    );
  });

  it("queues an explicitly selected Admin-registered Kubernetes target", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-k8s",
            name: "K8sAgent",
            status: "queued",
            user_id: "user-1",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "K8sAgent",
        deploy_target: "k8s:test-cluster",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-k8s",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
      }),
    );
  });

  it("accepts runtime-family and deploy-target aliases", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-target",
            name: "TargetAgent",
            status: "queued",
            user_id: "user-1",
            backend_type: "k8s",
            sandbox_type: "standard",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "TargetAgent",
        runtime_family: "openclaw",
        deploy_target: "k8s:test-cluster",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        sandbox_profile: "standard",
        backend_type: "k8s",
      }),
    );
    expect(mockDb.query.mock.calls[0][0]).toEqual(expect.stringContaining("runtime_family"));
    expect(mockDb.query.mock.calls[0][0]).toEqual(expect.stringContaining("deploy_target"));
    expect(mockDb.query.mock.calls[0][0]).toEqual(expect.stringContaining("sandbox_profile"));
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-target",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
      }),
    );
  });

  it("uses deploy-target plus sandbox-profile aliases for NemoClaw deploys", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-nemo-target",
            name: "Nemo Target Agent",
            status: "queued",
            user_id: "user-1",
            backend_type: "docker",
            sandbox_type: "nemoclaw",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "nemoclaw",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "Nemo Target Agent",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "docker",
      }),
    );
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[9]).toBe(
      getDefaultAgentImage({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend: "docker",
      }),
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-nemo-target",
        backend: "docker",
        sandbox: "nemoclaw",
      }),
    );
  });

  it("queues NemoClaw sandbox requests on Kubernetes execution targets", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-nemo-k8s",
            name: "BadSelection",
            status: "queued",
            user_id: "user-1",
            backend_type: "k8s",
            sandbox_type: "nemoclaw",
            runtime_family: "openclaw",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "nemoclaw",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "Nemo K8s",
        deploy_target: "k8s:test-cluster",
        sandbox_profile: "nemoclaw",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-nemo-k8s",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "nemoclaw",
      }),
    );
  });

  it("rejects unsupported runtime-family aliases", async () => {
    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "BadRuntime",
        runtime_family: "custom-runtime",
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/runtime_family/i);
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
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
      }),
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
      ]),
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-sanitized",
        name: "BadName",
        backend: "docker",
        specs: { vcpu: 16, ram_mb: 32768, disk_gb: 500 },
      }),
    );
  });

  it("stores the default prebaked image and blank template payload when deploying", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-image", name: "Image Agent", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/deploy").send({ name: "Image Agent" }));

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[9]).toBe("nora-openclaw-agent:local");
    expect(JSON.parse(insertParams[10])).toEqual(
      expect.objectContaining({
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
        memoryFiles: [],
        metadata: expect.objectContaining({ source: "blank-deploy" }),
      }),
    );
  });

  it("persists normalized clawhub skills during deploy without changing the response shape", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-clawhub",
            name: "ClawHub Agent",
            status: "queued",
            user_id: "user-1",
            clawhub_skills: [
              {
                source: "clawhub",
                installSlug: "github",
                author: "steipete",
                pagePath: "steipete/github",
                installedAt: "2026-04-19T12:00:00.000Z",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app)
        .post("/agents/deploy")
        .send({
          name: "ClawHub Agent",
          clawhub_skills: [
            {
              source: "clawhub",
              installSlug: "github",
              author: "steipete",
              pagePath: "steipete/github",
              installedAt: "2026-04-19T12:00:00Z",
              description: "Should not persist",
            },
            {
              source: "clawhub",
              installSlug: "github",
              author: "steipete",
              pagePath: "steipete/github",
              installedAt: "2026-04-19T12:05:00Z",
            },
          ],
        }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "a-clawhub",
        name: "ClawHub Agent",
        status: "queued",
      }),
    );

    const insertParams = mockDb.query.mock.calls[0][1];
    expect(JSON.parse(insertParams[11])).toEqual([
      {
        source: "clawhub",
        installSlug: "github",
        author: "steipete",
        pagePath: "steipete/github",
        installedAt: "2026-04-19T12:00:00.000Z",
      },
    ]);

    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-clawhub",
        clawhub_skills: [
          expect.objectContaining({
            installSlug: "github",
            author: "steipete",
            pagePath: "steipete/github",
          }),
        ],
      }),
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
        rows: [{ id: "a-paas", name: "PaaS Agent", status: "queued", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "PaaS Agent",
        vcpu: 12,
        ram_mb: 12288,
        disk_gb: 200,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-paas",
        specs: { vcpu: 4, ram_mb: 4096, disk_gb: 50 },
      }),
    );

    billing.IS_PAAS = false;
  });
});

describe("Agent file and export routes", () => {
  const binaryParser = (res, callback) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  };

  function mockOwnedAgent(overrides = {}) {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-files-1",
          user_id: "user-1",
          name: "Files Agent",
          runtime_family: "openclaw",
          status: "running",
          ...overrides,
        },
      ],
    });
  }

  it("returns the allowed filesystem roots for an owned agent", async () => {
    mockOwnedAgent();
    mockRootsForAgent.mockReturnValueOnce([
      {
        id: "workspace",
        label: "Workspace",
        path: "/root/.openclaw/workspace",
        access: "rw",
      },
    ]);

    const res = await auth(request(app).get("/agents/agent-files-1/files/roots"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      roots: [
        expect.objectContaining({
          id: "workspace",
          access: "rw",
        }),
      ],
    });
    expect(mockRootsForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-files-1" }),
    );
  });

  it("returns a live file tree payload", async () => {
    mockOwnedAgent();
    mockListFiles.mockResolvedValueOnce({
      root: { id: "workspace", label: "Workspace", access: "rw" },
      path: "project",
      entries: [{ name: "index.js", path: "project/index.js", type: "file", size: 42 }],
    });

    const res = await auth(
      request(app).get("/agents/agent-files-1/files/tree?root=workspace&path=project"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        path: "project",
        entries: [expect.objectContaining({ path: "project/index.js" })],
      }),
    );
    expect(mockListFiles).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-files-1" }),
      "workspace",
      "project",
    );
  });

  it("returns inline file content for the inspector", async () => {
    mockOwnedAgent();
    mockReadFile.mockResolvedValueOnce({
      root: "workspace",
      path: "project/index.js",
      size: 5,
      mode: "644",
      contentBase64: Buffer.from("hello").toString("base64"),
      writable: true,
    });

    const res = await auth(
      request(app).get("/agents/agent-files-1/files/content?root=workspace&path=project/index.js"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        path: "project/index.js",
        writable: true,
      }),
    );
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-files-1" }),
      "workspace",
      "project/index.js",
    );
  });

  it("writes file content through the files API", async () => {
    mockOwnedAgent();
    mockWriteFile.mockResolvedValueOnce({ success: true });

    const res = await auth(
      request(app)
        .put("/agents/agent-files-1/files/content")
        .send({
          root: "workspace",
          path: "project/index.js",
          contentBase64: Buffer.from("hello").toString("base64"),
        }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-files-1" }),
      "workspace",
      "project/index.js",
      Buffer.from("hello").toString("base64"),
      0o644,
    );
  });

  it("streams file downloads with attachment headers", async () => {
    mockOwnedAgent();
    mockDownloadPath.mockResolvedValueOnce({
      kind: "file",
      filename: "notes.txt",
      contentType: "application/octet-stream",
      contentBase64: Buffer.from("hello world").toString("base64"),
    });

    const res = await auth(
      request(app)
        .get("/agents/agent-files-1/files/download?root=workspace&path=notes.txt")
        .buffer(true)
        .parse(binaryParser),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="notes.txt"');
    expect(res.headers["content-type"]).toMatch(/application\/octet-stream/);
    expect(Buffer.from(res.body)).toEqual(Buffer.from("hello world"));
  });

  it("exports an owned agent as a Nora migration bundle", async () => {
    const manifest = { format: "nora-migration-bundle/v1", version: 1 };
    mockOwnedAgent();
    mockBuildMigrationManifestFromAgent.mockResolvedValueOnce(manifest);
    mockPackMigrationBundle.mockResolvedValueOnce(Buffer.from("bundle-data"));

    const res = await auth(
      request(app).get("/agents/agent-files-1/export").buffer(true).parse(binaryParser),
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/gzip/);
    expect(res.headers["content-disposition"]).toContain(
      'filename="files-agent.nora-migration.tgz"',
    );
    expect(mockBuildMigrationManifestFromAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-files-1" }),
      { userId: "user-1" },
    );
    expect(mockPackMigrationBundle).toHaveBeenCalledWith(manifest);
    expect(Buffer.from(res.body)).toEqual(Buffer.from("bundle-data"));
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

    const res = await auth(request(app).patch("/agents/a-rename").send({ name: "New Name" }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name", "New Name");
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "UPDATE agents SET name = $1 WHERE id = $2 RETURNING *",
      ["New Name", "a-rename"],
    );
  });
});

describe("POST /agents/:id/duplicate", () => {
  it("duplicates an agent using stored payload fallback and full clone wiring", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
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
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            provider: "slack",
            catalog_id: "slack",
            access_token: "secret",
            config: { token: "secret" },
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            type: "email",
            name: "Ops Email",
            config: { smtp_pass: "secret" },
            enabled: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "a-duplicate", name: "Source Agent Copy", status: "queued", user_id: "user-1" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-source/duplicate").send({
        name: "Source Agent Copy",
        clone_mode: "full_clone",
      }),
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
      ]),
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
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-duplicate",
        name: "Source Agent Copy",
        backend: "docker",
        image: "custom/image:latest",
        sandbox: "standard",
        specs: { vcpu: 4, ram_mb: 4096, disk_gb: 50 },
      }),
    );
  });

  it("recomputes the default image when duplicating onto a different execution target", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-source-k8s",
            name: "Source Agent",
            user_id: "user-1",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            image: "nora-openclaw-agent:local",
            template_payload: JSON.stringify({
              files: [{ path: "AGENT.md", content: "hello" }],
              memoryFiles: [],
              metadata: { source: "template" },
            }),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-duplicate-k8s",
            name: "Source Agent K8s",
            status: "queued",
            user_id: "user-1",
            backend_type: "k8s",
            sandbox_type: "standard",
            runtime_family: "openclaw",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-source-k8s/duplicate").send({
        name: "Source Agent K8s",
        clone_mode: "full_clone",
        deploy_target: "k8s:test-cluster",
      }),
    );

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[3][1];
    expect(insertParams[9]).toBe("node:24-slim");
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-duplicate-k8s",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
        image: "node:24-slim",
      }),
    );
  });

  it("uses a Hermes-specific container prefix when duplicating into Hermes", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-source-hermes",
            name: "Desk Bot",
            user_id: "user-1",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            image: "nora-openclaw-agent:local",
            template_payload: JSON.stringify({
              files: [{ path: "AGENT.md", content: "hello" }],
              memoryFiles: [],
              metadata: { source: "template" },
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-duplicate-hermes",
            name: "Desk Bot Hermes",
            status: "queued",
            user_id: "user-1",
            runtime_family: "hermes",
            backend_type: "docker",
            deploy_target: "docker",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-source-hermes/duplicate").send({
        name: "Desk Bot Hermes",
        runtime_family: "hermes",
        clone_mode: "files_only",
      }),
    );

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[1][1];
    expect(insertParams[8]).toMatch(/^nora-hermes-desk-bot-hermes-/);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-duplicate-hermes",
        backend: "docker",
        container_name: expect.stringMatching(/^nora-hermes-desk-bot-hermes-/),
      }),
    );
  });
});

describe("POST /agent-hub/install", () => {
  it("installs a starter template into a queued agent using the provided name", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
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
        rows: [
          {
            id: "a-market",
            name: "COS Agent",
            status: "queued",
            user_id: "user-1",
            backend_type: "docker",
            sandbox_type: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agent-hub/install").send({
        listingId: "listing-1",
        name: "COS Agent",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "standard",
      }),
    );
    expect(mockDb.query.mock.calls[0][0]).toEqual(expect.stringContaining("runtime_family"));
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[1]).toBe("COS Agent");
    expect(insertParams[9]).toBe("nora-openclaw-agent:local");
    expect(JSON.parse(insertParams[10]).files.map((file) => file.path)).toEqual(
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
      ]),
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-market",
        name: "COS Agent",
        backend: "docker",
        image: "nora-openclaw-agent:local",
        sandbox: "standard",
      }),
    );
  });

  it("installs NemoClaw sandbox templates on Kubernetes execution targets", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
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
      config: {
        defaults: {
          sandbox: "standard",
        },
      },
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-market-nemo-k8s",
            name: "COS Agent",
            status: "queued",
            user_id: "user-1",
            backend_type: "k8s",
            sandbox_type: "nemoclaw",
            runtime_family: "openclaw",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "nemoclaw",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agent-hub/install").send({
        listingId: "listing-1",
        name: "COS Agent",
        deploy_target: "k8s:test-cluster",
        sandbox_profile: "nemoclaw",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-market-nemo-k8s",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "nemoclaw",
      }),
    );
  });

  it("recomputes the default image when installing onto a different execution target", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
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
      config: {
        defaults: {
          backend: "docker",
          sandbox: "standard",
          image: "nora-openclaw-agent:local",
        },
        templatePayload: {
          files: [{ path: "AGENT.md", content: "starter" }],
        },
      },
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-market-k8s",
            name: "COS Agent K8s",
            status: "queued",
            user_id: "user-1",
            backend_type: "k8s",
            sandbox_type: "standard",
            runtime_family: "openclaw",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agent-hub/install").send({
        listingId: "listing-1",
        name: "COS Agent K8s",
        deploy_target: "k8s:test-cluster",
      }),
    );

    expect(res.status).toBe(200);
    const insertParams = mockDb.query.mock.calls[0][1];
    expect(insertParams[9]).toBe("node:24-slim");
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-market-k8s",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
        image: "node:24-slim",
      }),
    );
  });

  it("rejects unsupported runtime families for Agent Hub installs", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
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
      config: {
        defaults: {
          sandbox: "standard",
        },
      },
    });

    const res = await auth(
      request(app).post("/agent-hub/install").send({
        listingId: "listing-1",
        name: "COS Agent",
        runtime_family: "future-runtime",
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/runtime_family/i);
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });
});

describe("Agent Hub browse, share, download, and report", () => {
  it("requires an Agent Hub API key for the public community catalog", async () => {
    const res = await request(app).get("/agent-hub/catalog");

    expect(res.status).toBe(401);
    expect(res.body).toEqual(
      expect.objectContaining({
        code: "agent_hub_api_key_required",
      }),
    );
  });

  it("exposes the public Agent Hub community catalog", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    mockValidHubApiKey();
    agentHubStoreModule.listCommunityCatalog.mockResolvedValueOnce([
      {
        id: "listing-community-1",
        name: "Community Template",
        description: "Shared template",
        source_type: "community",
        status: "published",
        share_target: "community",
        owner_user_id: "publisher-1",
        owner_name: "Publisher One",
        owner_avatar: "data:image/png;base64,avatar",
      },
    ]);

    const res = await hubKeyAuth(request(app).get("/agent-hub/catalog"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        hub: expect.objectContaining({ name: "Nora Agent Hub" }),
        items: [
          expect.objectContaining({
            id: "listing-community-1",
            publisher: expect.objectContaining({
              displayName: "Publisher One",
              verified: true,
            }),
          }),
        ],
      }),
    );
  });

  it("does not expose internal-only shares through the public Agent Hub detail route", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    mockValidHubApiKey();
    agentHubStoreModule.getListing.mockResolvedValueOnce({
      id: "listing-internal-1",
      name: "Internal Template",
      source_type: "community",
      status: "published",
      share_target: "internal",
    });

    const res = await hubKeyAuth(request(app).get("/agent-hub/catalog/listing-internal-1"));

    expect(res.status).toBe(404);
  });

  it("binds hosted Agent Hub submissions to the API key owner", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");
    mockValidHubApiKey();
    agentHubStoreModule.upsertListing.mockResolvedValueOnce({
      id: "listing-submitted-1",
      status: "pending_review",
    });

    const res = await hubKeyAuth(
      request(app)
        .post("/agent-hub/submissions")
        .send({
          listing: {
            name: "Submitted Template",
            description: "Submitted through a registered installation key",
            category: "Operations",
          },
          templatePayload: {
            files: [{ path: "AGENTS.md", content: "hello" }],
            memoryFiles: [],
            wiring: { channels: [], integrations: [] },
          },
        }),
    );

    expect(res.status).toBe(202);
    expect(snapshotsModule.createSnapshot).toHaveBeenCalledWith(
      null,
      "Submitted Template",
      "Submitted through a registered installation key",
      expect.any(Object),
      expect.any(Object),
    );
    expect(agentHubStoreModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "publisher-1",
        status: "pending_review",
        shareTarget: "community",
      }),
    );
  });

  it("lists published Agent Hub entries for authenticated users", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    agentHubStoreModule.listAgentHubLocalListings.mockResolvedValueOnce([
      { id: "listing-1", name: "Preset" },
    ]);

    const res = await auth(request(app).get("/agent-hub"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: "listing-1" })]);
  });

  it("lists the current user's Agent Hub listings", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    agentHubStoreModule.listUserListings.mockResolvedValueOnce([
      { id: "listing-1", name: "My Listing", status: "pending_review" },
    ]);

    const res = await auth(request(app).get("/agent-hub/mine"));

    expect(res.status).toBe(200);
    expect(agentHubStoreModule.listUserListings).toHaveBeenCalledWith("user-1");
    expect(res.body[0]).toEqual(
      expect.objectContaining({ id: "listing-1", status: "pending_review" }),
    );
  });

  it("lists source-catalog API keys for the current user", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "hub-key-1",
          label: "Production install",
          key_prefix: "nora_hub_prod",
          status: "active",
          created_at: "2026-04-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
        },
      ],
    });

    const res = await auth(request(app).get("/agent-hub/api-keys"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "hub-key-1",
        label: "Production install",
        maskedKey: "nora_hub_prod...",
      }),
    ]);
  });

  it("creates a source-catalog API key and returns the raw key once", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "hub-key-1",
          label: "Production install",
          key_prefix: "nora_hub_generated",
          status: "active",
          created_at: "2026-04-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
        },
      ],
    });

    const res = await auth(
      request(app).post("/agent-hub/api-keys").send({ label: "Production install" }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "hub-key-1",
        label: "Production install",
        apiKey: expect.stringMatching(/^nora_hub_/),
      }),
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO agent_hub_api_keys"),
      expect.arrayContaining(["user-1", "Production install"]),
    );
  });

  it("revokes a source-catalog API key owned by the current user", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "hub-key-1",
          label: "Production install",
          key_prefix: "nora_hub_prod",
          status: "revoked",
          created_at: "2026-04-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: "2026-04-02T00:00:00.000Z",
        },
      ],
    });

    const res = await auth(request(app).delete("/agent-hub/api-keys/hub-key-1"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "hub-key-1",
        status: "revoked",
      }),
    );
  });

  it("returns detailed Agent Hub template data", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
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

    const res = await auth(request(app).get("/agent-hub/listing-1"));

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
      }),
    );
  });

  it("lets community owners edit and resubmit their Agent Hub listing", async () => {
    const agentHubStoreModule = require("../agentHubStore");
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

    agentHubStoreModule.getListing.mockResolvedValueOnce(listing).mockResolvedValueOnce({
      ...listing,
      name: "Updated Preset",
      status: "published",
      category: "Support",
      current_version: 3,
    });
    snapshotsModule.getSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
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
    agentHubStoreModule.upsertListing.mockResolvedValueOnce({
      ...listing,
      name: "Updated Preset",
      status: "published",
    });

    const res = await auth(
      request(app)
        .patch("/agent-hub/listing-1")
        .send({
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
        }),
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
      }),
    );
    expect(agentHubStoreModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        status: "published",
        currentVersion: 3,
        category: "Support",
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        name: "Updated Preset",
        status: "published",
        category: "Support",
        current_version: 3,
      }),
    );
  });

  it("shares an owned agent as an Agent Hub listing", async () => {
    const agentHubStoreModule = require("../agentHubStore");
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
    agentHubStoreModule.upsertListing.mockResolvedValueOnce({
      id: "listing-community-1",
      name: "Ops Agent Template",
    });
    agentHubStoreModule.getListing.mockResolvedValueOnce({
      id: "listing-community-1",
      name: "Ops Agent Template",
      status: "published",
      source_type: "community",
      share_target: "both",
      local_visibility: "internal",
      central_share_status: "submitted",
    });

    const res = await auth(
      request(app).post("/agent-hub/share").send({
        agentId: "agent-1",
        name: "Ops Agent Template",
        description: "Shared operations template",
        category: "Operations",
        shareTarget: "both",
        price: "$99/mo",
      }),
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
      expect.objectContaining({ kind: "community-template", builtIn: false }),
    );
    expect(agentHubStoreModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "user-1",
        price: "Free",
        sourceType: "community",
        status: "published",
        visibility: "public",
        shareTarget: "both",
        localVisibility: "internal",
        centralShareStatus: "queued",
      }),
    );
    expect(agentHubStoreModule.updateCentralShareStatus).toHaveBeenCalledWith(
      "listing-community-1",
      expect.objectContaining({
        status: "submitted",
        centralListingId: "central-listing-1",
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "listing-community-1",
        status: "published",
      }),
    );
  });

  it("blocks Agent Hub sharing when secret-like files are detected", async () => {
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
      request(app).post("/agent-hub/share").send({
        agentId: "agent-1",
        name: "Sensitive Template",
        description: "Should fail",
        category: "Operations",
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("issues");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(snapshotsModule.createSnapshot).not.toHaveBeenCalled();
  });

  it("downloads an Agent Hub template package", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
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

    const res = await auth(request(app).get("/agent-hub/listing-1/download"));

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("chief-of-staff-claw.nora-template.json");
    expect(agentHubStoreModule.recordDownload).toHaveBeenCalledWith("listing-1");
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
      }),
    );
  });

  it("reports a published community listing", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const monitoringModule = require("../monitoring");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      name: "Community Template",
      status: "published",
      source_type: "community",
      local_visibility: "internal",
      owner_user_id: "someone-else",
    });
    agentHubStoreModule.createReport.mockResolvedValueOnce({
      id: "report-1",
      listing_id: "listing-1",
    });

    const res = await auth(
      request(app).post("/agent-hub/listing-1/report").send({
        reason: "spam",
        details: "Low-quality content",
      }),
    );

    expect(res.status).toBe(200);
    expect(agentHubStoreModule.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        reporterUserId: "user-1",
        reason: "spam",
        details: "Low-quality content",
      }),
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "agent_hub_reported",
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
      }),
    );
  });
});

describe("POST /agents/:id/stop", () => {
  it("stops a running agent", async () => {
    // db.query calls: SELECT agent, UPDATE status
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a1", status: "running", container_id: null, user_id: "user-1" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "a1", status: "stopped" }] });

    const res = await auth(request(app).post("/agents/a1/stop"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "stopped");
  });

  it("stops a Kubernetes deployment by container_name when container_id is missing", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-k8s-stop",
            name: "K8s Stop",
            status: "running",
            user_id: "user-1",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            container_id: null,
            container_name: "nora-oclaw-k8s-stop",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "a-k8s-stop", status: "stopped" }] });

    const res = await auth(request(app).post("/agents/a-k8s-stop/stop"));

    expect(res.status).toBe(200);
    expect(containerManager.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-k8s-stop",
        container_name: "nora-oclaw-k8s-stop",
      }),
    );
    expect(res.body).toHaveProperty("status", "stopped");
  });

  it("keeps a Kubernetes agent running in Nora when Kubernetes stop fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.stop.mockRejectedValueOnce(new Error("Kubernetes patch failed"));
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-k8s-stop-fail",
          name: "K8s Stop Fail",
          status: "running",
          user_id: "user-1",
          runtime_family: "openclaw",
          backend_type: "k8s",
          deploy_target: "k8s",
          execution_target_id: "k8s:test-cluster",
          sandbox_profile: "standard",
          container_id: null,
          container_name: "nora-oclaw-k8s-stop-fail",
        },
      ],
    });

    const res = await auth(request(app).post("/agents/a-k8s-stop-fail/stop"));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Kubernetes patch failed/i);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });
});

describe("POST /agents/:id/redeploy", () => {
  it("allows redeploy when an agent is in warning state", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-warning",
            name: "Warning Agent",
            status: "warning",
            sandbox_type: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "oclaw-agent-warning",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/a-warning/redeploy"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: "queued" });
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("runtime_host = NULL"),
      [
        "a-warning",
        "docker",
        "standard",
        "openclaw",
        "docker",
        "docker",
        "standard",
        expect.stringMatching(/^nora-oclaw-warning-agent-/),
        "nora-openclaw-agent:local",
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-warning",
        name: "Warning Agent",
        userId: "user-1",
        backend: "docker",
        execution_target_id: "docker",
        sandbox: "standard",
        specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        container_name: expect.stringMatching(/^nora-oclaw-warning-agent-/),
      }),
    );
  });

  it("accepts deploy-target overrides during redeploy and resets the sandbox when needed", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-nemo-redeploy",
            name: "Nemo Agent",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "nemoclaw",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "oclaw-agent-nemo",
            image: null,
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-nemo-redeploy/redeploy").send({
        deploy_target: "k8s:test-cluster",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: "queued" });
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining("deploy_target = $5"), [
      "a-nemo-redeploy",
      "k8s",
      "standard",
      "openclaw",
      "k8s",
      "k8s:test-cluster",
      "standard",
      expect.stringMatching(/^nora-oclaw-nemo-agent-/),
      "node:24-slim",
    ]);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-nemo-redeploy",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
        image: "node:24-slim",
      }),
    );
  });

  it("passes previous Kubernetes runtime refs so redeploy deletes the old resources first", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-k8s-redeploy",
            name: "K8s Agent",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_id: "oclaw-agent-k8s-old",
            container_name: "oclaw-agent-k8s-old",
            host: "oclaw-agent-k8s-old.openclaw-agents.svc.cluster.local",
            image: "node:24-slim",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/a-k8s-redeploy/redeploy"));

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-k8s-redeploy",
        backend: "k8s",
        previous_container_id: "oclaw-agent-k8s-old",
        previous_container_name: "oclaw-agent-k8s-old",
        previous_host: "oclaw-agent-k8s-old.openclaw-agents.svc.cluster.local",
        previous_backend: "k8s",
        previous_runtime_family: "openclaw",
        previous_deploy_target: "k8s",
        previous_execution_target_id: "k8s:test-cluster",
        previous_sandbox_profile: "standard",
      }),
    );
  });

  it("recomputes the default image when redeploying onto a different execution target", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-docker-redeploy",
            name: "Docker Agent",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "oclaw-agent-docker",
            image: "nora-openclaw-agent:local",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-docker-redeploy/redeploy").send({
        deploy_target: "k8s:test-cluster",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining("image = $9"), [
      "a-docker-redeploy",
      "k8s",
      "standard",
      "openclaw",
      "k8s",
      "k8s:test-cluster",
      "standard",
      expect.stringMatching(/^nora-oclaw-docker-agent-/),
      "node:24-slim",
    ]);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-docker-redeploy",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
        image: "node:24-slim",
      }),
    );
  });

  it("regenerates auto-generated container names when redeploying into Hermes", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-hermes-redeploy",
            name: "Desk Bot",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "oclaw-agent-desk-bot-old123",
            image: "nora-openclaw-agent:local",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/a-hermes-redeploy/redeploy").send({
        runtime_family: "hermes",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("container_name = $8"),
      [
        "a-hermes-redeploy",
        "docker",
        "standard",
        "hermes",
        "docker",
        "docker",
        "standard",
        expect.stringMatching(/^nora-hermes-desk-bot-/),
        "nousresearch/hermes-agent:latest",
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-hermes-redeploy",
        backend: "docker",
        execution_target_id: "docker",
        container_name: expect.stringMatching(/^nora-hermes-desk-bot-/),
        image: "nousresearch/hermes-agent:latest",
      }),
    );
  });

  it("rejects redeploy when the agent is still actively running", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "a-running", name: "Running Agent", status: "running", user_id: "user-1" }],
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
      .mockResolvedValueOnce({ rows: [{ id: "a1", container_id: null, user_id: "user-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/a1/delete"));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("rejects deleting a workspace-shared agent when caller is not the direct owner", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-shared", container_id: null, user_id: "owner-2" }],
      })
      .mockResolvedValueOnce({ rows: [{ role: "admin" }] });

    const res = await auth(request(app).post("/agents/a-shared/delete"));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/direct agent owner/i);
  });

  it("destroys Kubernetes resources by container_name before deleting a stale local record", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-k8s-stale",
            name: "Stale K8s Agent",
            user_id: "user-1",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            container_id: null,
            container_name: "nora-oclaw-stale-k8s-agent-abc123",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).delete("/agents/a-k8s-stale"));

    expect(res.status).toBe(200);
    expect(containerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-k8s-stale",
        container_name: "nora-oclaw-stale-k8s-agent-abc123",
      }),
    );
    expect(mockDb.query).toHaveBeenLastCalledWith("DELETE FROM agents WHERE id = $1", [
      "a-k8s-stale",
    ]);
  });

  it("keeps the Kubernetes agent record when runtime cleanup fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.destroy.mockRejectedValueOnce(new Error("Kubernetes API unreachable"));
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-k8s-delete-fail",
          name: "K8s Delete Fail",
          user_id: "user-1",
          runtime_family: "openclaw",
          backend_type: "k8s",
          deploy_target: "k8s",
          execution_target_id: "k8s:test-cluster",
          sandbox_profile: "standard",
          container_id: null,
          container_name: "nora-oclaw-delete-fail",
        },
      ],
    });

    const res = await auth(request(app).delete("/agents/a-k8s-delete-fail"));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Kubernetes API unreachable/i);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for non-existent agent", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/missing/delete"));
    expect(res.status).toBe(404);
  });
});
