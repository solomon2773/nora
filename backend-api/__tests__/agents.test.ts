// @ts-nocheck
/**
 * __tests__/agents.test.js — Agent management endpoint tests
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;
const ADOPTED_GATEWAY_TOKEN = "0123456789abcdef".repeat(4);

const mockDbClient = { query: jest.fn(), release: jest.fn() };
const mockDb = { query: jest.fn(), connect: jest.fn() };
const mockActivationLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockActivationLockClient);
const mockAddDeploymentJob = jest.fn();
const mockCancelDeploymentJobsForAgent = jest.fn();
const mockEnsureDemoProvider = jest.fn();
const mockDockerPing = jest.fn((callback) => callback(null));
const mockDockerInspect = jest.fn();
const mockStats = jest.fn();
const mockSyncAuthToUserAgents = jest.fn().mockResolvedValue([]);
const mockResumeAgentWithProviderAuth = jest.fn();
const mockWithProviderStateLock = jest.fn();
const mockPersistLifecycleRuntimeAddress = jest.fn();
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
const mockAssertRemoteHostExecutionTargetAvailable = jest.fn().mockResolvedValue();
const mockVerifyApiKey = jest.fn();
const mockGetAgentVersion = jest.fn();
const mockRecordAgentVersion = jest.fn();
const mockRecordAgentVersionBestEffort = jest.fn();
const mockAgentProvisionLockRelease = jest.fn().mockResolvedValue(undefined);
const mockAcquireAgentProvisionLock = jest.fn().mockResolvedValue({
  release: mockAgentProvisionLockRelease,
});
jest.mock("../db", () => mockDb);
jest.mock("../apiKeys", () => ({
  ...jest.requireActual("../apiKeys"),
  verifyApiKey: mockVerifyApiKey,
}));
jest.mock("pg", () => ({
  ...jest.requireActual("pg"),
  Client: mockPgClient,
}));
jest.mock("dockerode", () =>
  jest.fn().mockImplementation(() => ({
    ping: mockDockerPing,
    getContainer: jest.fn(() => ({ inspect: mockDockerInspect })),
  })),
);
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
  cancelDeploymentJobsForAgent: mockCancelDeploymentJobsForAgent,
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../agentProvisionLock", () => ({
  ...jest.requireActual("../agentProvisionLock"),
  acquireAgentProvisionLock: mockAcquireAgentProvisionLock,
}));
jest.mock("../kubernetesClusters", () => ({
  assertKubernetesExecutionTargetAvailable: mockAssertKubernetesExecutionTargetAvailable,
  listKubernetesExecutionTargets: jest.fn().mockResolvedValue([]),
}));
jest.mock("../remoteHosts", () => ({
  ...jest.requireActual("../remoteHosts"),
  assertRemoteHostExecutionTargetAvailable: mockAssertRemoteHostExecutionTargetAvailable,
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
}));
jest.mock("../agentVersions", () => ({
  getVersion: mockGetAgentVersion,
  listVersions: jest.fn().mockResolvedValue([]),
  recordVersion: mockRecordAgentVersion,
  recordVersionBestEffort: mockRecordAgentVersionBestEffort,
}));
jest.mock("../containerManager", () => ({
  start: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue({}),
  restart: jest.fn().mockResolvedValue({}),
  destroy: jest.fn().mockResolvedValue({}),
  persistLifecycleRuntimeAddress: mockPersistLifecycleRuntimeAddress,
  isIgnorableStopError: jest.fn((error) =>
    /already stopped|not running/i.test(String(error?.message || "")),
  ),
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
jest.mock("../mcpServers", () => ({
  ...jest.requireActual("../mcpServers"),
  getEnabledMcpRuntimeState: jest.fn().mockResolvedValue({
    enabledIds: [],
    entries: [],
    desiredServers: {},
    env: {},
    managedEnvNames: [],
  }),
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
  ensureDemoProvider: mockEnsureDemoProvider,
  providerMutationLockKey: jest.fn((userId) => `nora:llm-providers:${userId}`),
  withProviderStateLock: mockWithProviderStateLock,
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
  resumeAgentWithProviderAuth: mockResumeAgentWithProviderAuth,
  isProviderAuthStatusHoldReason: (value) =>
    value === "provider_auth_reconciliation_pending" ||
    value === "provider_auth_reconciliation_failed",
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
const editorToken = jwt.sign(
  { id: "workspace-editor-1", email: "editor@nora.test", role: "user" },
  JWT_SECRET,
  { expiresIn: "1h" },
);
const editorAuth = (req) => req.set("Authorization", `Bearer ${editorToken}`);
const workspaceApiKeyAuth = (req) =>
  req.set("Authorization", "Bearer nora_workspace_agents_write_test");
const hubKeyAuth = (req) => req.set("Authorization", "Bearer nora_hub_test_key");

function authorizeWorkspaceApiKey({
  workspaceId = "workspace-a",
  userId = "user-1",
  scopes = ["agents:write"],
} = {}) {
  mockVerifyApiKey.mockResolvedValueOnce({
    key: {
      id: "workspace-key-1",
      workspaceId,
      scopes,
      status: "active",
    },
    workspace: { id: workspaceId, name: "Workspace A" },
    user: {
      id: userId,
      email: `${userId}@nora.test`,
      name: "Workspace API User",
      role: "user",
    },
  });
}

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
  mockDb.connect.mockReset().mockResolvedValue(mockDbClient);
  mockDbClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockDbClient.release.mockReset();
  mockAcquireAgentProvisionLock.mockReset().mockResolvedValue({
    release: mockAgentProvisionLockRelease,
  });
  mockAgentProvisionLockRelease.mockReset().mockResolvedValue(undefined);
  mockPgClient.mockReset().mockImplementation(() => mockActivationLockClient);
  mockActivationLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockActivationLockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockActivationLockClient.end.mockReset().mockResolvedValue(undefined);
  mockAddDeploymentJob.mockReset();
  mockCancelDeploymentJobsForAgent.mockReset().mockResolvedValue({ removed: 0, active: 0 });
  mockEnsureDemoProvider.mockReset().mockResolvedValue({
    id: "provider-demo",
    provider: "demo",
    model: "nora-demo-1",
    is_default: true,
  });
  mockDockerPing.mockReset().mockImplementation((callback) => callback(null));
  mockDockerInspect.mockReset();
  mockSyncAuthToUserAgents.mockReset().mockResolvedValue([]);
  mockWithProviderStateLock
    .mockReset()
    .mockImplementation(async (_userId, operation) => operation());
  mockResumeAgentWithProviderAuth.mockReset().mockImplementation(async (agent) => ({
    agent: { ...agent, status: "running", paused_reason: null },
    lifecycleResult: null,
    syncResult: { agentId: agent.id, status: "synced" },
  }));
  mockPersistLifecycleRuntimeAddress.mockReset().mockImplementation(async (_db, agent, result) => {
    const host = typeof result?.host === "string" ? result.host.trim() : "";
    const runtimeHost = typeof result?.runtimeHost === "string" ? result.runtimeHost.trim() : host;
    if (host) agent.host = host;
    if (runtimeHost) agent.runtime_host = runtimeHost;
    return agent;
  });
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
  mockGetAgentVersion.mockReset();
  mockVerifyApiKey.mockReset().mockResolvedValue(null);
  mockAssertRemoteHostExecutionTargetAvailable.mockReset().mockResolvedValue();
  mockRecordAgentVersion.mockReset().mockResolvedValue({
    id: "version-restored",
    versionNumber: 3,
    config: {},
  });
  mockRecordAgentVersionBestEffort.mockReset().mockResolvedValue(null);
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

  it.each([
    ["accessible", "/agents"],
    ["owned", "/agents?scope=owned"],
  ])("binds workspace API-key %s listings to the key workspace", async (scope, path) => {
    authorizeWorkspaceApiKey({ scopes: ["agents:read"] });
    const workspaces = require("../workspaces");
    workspaces.listAccessibleAgents.mockResolvedValueOnce([]);

    const res = await workspaceApiKeyAuth(request(app).get(path));

    expect(res.status).toBe(200);
    expect(workspaces.listAccessibleAgents).toHaveBeenCalledWith("user-1", {
      scope,
      workspaceId: "workspace-a",
    });
  });

  it("fails closed when an API-key agent listing has no workspace binding", async () => {
    authorizeWorkspaceApiKey({ workspaceId: null, scopes: ["agents:read"] });

    const res = await workspaceApiKeyAuth(request(app).get("/agents"));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
    expect(require("../workspaces").listAccessibleAgents).not.toHaveBeenCalled();
  });
});

describe("GET /agents/:id", () => {
  it("self-heals warning status to running when the container is still live", async () => {
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
    expect(res.body).toHaveProperty("status", "running");
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

  it.each(["provider_auth_reconciliation_pending", "provider_auth_reconciliation_failed"])(
    "does not live-promote an agent held for provider auth (%s)",
    async (pausedReason) => {
      const containerManager = require("../containerManager");
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "a-provider-auth-held",
            name: "Provider Auth Held",
            status: "error",
            paused_reason: pausedReason,
            user_id: "user-1",
            container_id: "container-provider-auth-held",
            effective_role: "owner",
          },
        ],
      });

      const res = await auth(request(app).get("/agents/a-provider-auth-held"));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ status: "error", paused_reason: pausedReason }),
      );
      expect(containerManager.status).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    },
  );

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

  it("returns an external connect block for a running local Docker Hermes agent", async () => {
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
          id: "a-hermes-connect",
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
    // Live container bindings for the published runtime API (8642) and
    // dashboard (9119) ports — read on demand, never persisted.
    mockDockerInspect.mockResolvedValueOnce({
      NetworkSettings: {
        Ports: {
          "8642/tcp": [{ HostIp: "100.71.115.105", HostPort: "19500" }],
          "9119/tcp": [{ HostIp: "100.71.115.105", HostPort: "19044" }],
        },
      },
    });

    const res = await auth(
      request(app)
        .get("/agents/a-hermes-connect/hermes-ui")
        .set("X-Forwarded-Host", "100.71.115.105"),
    );

    expect(res.status).toBe(200);
    expect(res.body.connect).toEqual({
      runtimeApiUrl: "http://100.71.115.105:19500",
      dashboardUrl: "http://100.71.115.105:19044",
      apiKey: "hermes-token",
    });
  });

  it.each(["viewer", "editor", "admin"])(
    "omits Hermes connect credentials for workspace %s members",
    async (role) => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: "a-hermes-viewer",
              user_id: "agent-owner",
              status: "running",
              runtime_family: "hermes",
              backend_type: "docker",
              container_id: "hermes-container",
              runtime_host: "10.0.0.43",
              runtime_port: 8642,
              gateway_token: "hermes-token",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ role }] });
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse({ body: { status: "ok", platform: "hermes-agent" } }),
        )
        .mockResolvedValueOnce(
          createMockFetchResponse({
            body: { object: "list", data: [{ id: "desk-bot", object: "model" }] },
          }),
        )
        .mockResolvedValueOnce(
          createMockFetchResponse({
            body: { version: "1.0.0", gateway_running: true, gateway_state: "running" },
          }),
        );

      const res = await auth(request(app).get("/agents/a-hermes-viewer/hermes-ui"));

      expect(res.status).toBe(200);
      expect(res.body.connect).toBeUndefined();
      expect(mockDockerInspect).not.toHaveBeenCalled();
    },
  );

  it("omits Hermes connect credentials for read-scoped workspace API keys", async () => {
    authorizeWorkspaceApiKey({ scopes: ["agents:read"] });
    const agent = {
      id: "a-hermes-api-key",
      user_id: "agent-owner",
      status: "running",
      runtime_family: "hermes",
      backend_type: "docker",
      container_id: "hermes-container",
      runtime_host: "10.0.0.43",
      runtime_port: 8642,
      gateway_token: "hermes-token",
    };
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: agent.id,
            backend_type: agent.backend_type,
            deploy_target: agent.deploy_target,
            execution_target_id: agent.execution_target_id,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [agent] });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({ body: { status: "ok", platform: "hermes-agent" } }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { object: "list", data: [{ id: "desk-bot", object: "model" }] },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { version: "1.0.0", gateway_running: true, gateway_state: "running" },
        }),
      );

    const res = await workspaceApiKeyAuth(request(app).get("/agents/a-hermes-api-key/hermes-ui"));

    expect(res.status).toBe(200);
    expect(res.body.connect).toBeUndefined();
    expect(mockDockerInspect).not.toHaveBeenCalled();
  });

  it("uses the routable published HostIp as the connect host, not the browsing host", async () => {
    mockReadHermesRuntimeSnapshot.mockResolvedValueOnce({
      runtimeStatus: { gateway_state: "running", active_agents: 1, updated_at: "t", platforms: {} },
      directory: { updated_at: "t", platforms: {} },
      platformDetails: {},
      jobsCount: 0,
      modelConfig: { defaultModel: "gpt-5.5", provider: "custom", baseUrl: "https://x/v1" },
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-hostip",
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({ body: { status: "ok", platform: "hermes-agent" } }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { object: "list", data: [{ id: "desk-bot", object: "model" }] },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { version: "1.0.0", gateway_running: true, gateway_state: "running" },
        }),
      );
    // Ports are bound to a concrete routable interface (Tailscale IP).
    mockDockerInspect.mockResolvedValueOnce({
      NetworkSettings: {
        Ports: {
          "8642/tcp": [{ HostIp: "100.71.115.105", HostPort: "19500" }],
          "9119/tcp": [{ HostIp: "100.71.115.105", HostPort: "19044" }],
        },
      },
    });

    // Operator browses Nora on a DIFFERENT host — the connect URLs must reflect
    // where the ports are actually bound, not the browsing host.
    const res = await auth(
      request(app)
        .get("/agents/a-hermes-hostip/hermes-ui")
        .set("X-Forwarded-Host", "nora.internal.example"),
    );

    expect(res.status).toBe(200);
    expect(res.body.connect).toEqual({
      runtimeApiUrl: "http://100.71.115.105:19500",
      dashboardUrl: "http://100.71.115.105:19044",
      apiKey: "hermes-token",
    });
  });

  it("falls back to the browsing host when ports are bound to loopback / 0.0.0.0", async () => {
    mockReadHermesRuntimeSnapshot.mockResolvedValueOnce({
      runtimeStatus: { gateway_state: "running", active_agents: 1, updated_at: "t", platforms: {} },
      directory: { updated_at: "t", platforms: {} },
      platformDetails: {},
      jobsCount: 0,
      modelConfig: { defaultModel: "gpt-5.5", provider: "custom", baseUrl: "https://x/v1" },
    });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-hermes-loopback",
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createMockFetchResponse({ body: { status: "ok", platform: "hermes-agent" } }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { object: "list", data: [{ id: "desk-bot", object: "model" }] },
        }),
      )
      .mockResolvedValueOnce(
        createMockFetchResponse({
          body: { version: "1.0.0", gateway_running: true, gateway_state: "running" },
        }),
      );
    // Loopback bind (default DOCKER_AGENT_BIND_IP) — no routable HostIp to advertise.
    mockDockerInspect.mockResolvedValueOnce({
      NetworkSettings: {
        Ports: {
          "8642/tcp": [{ HostIp: "127.0.0.1", HostPort: "19500" }],
          "9119/tcp": [{ HostIp: "0.0.0.0", HostPort: "19044" }],
        },
      },
    });

    const res = await auth(
      request(app)
        .get("/agents/a-hermes-loopback/hermes-ui")
        .set("X-Forwarded-Host", "nora.internal.example"),
    );

    expect(res.status).toBe(200);
    expect(res.body.connect).toEqual({
      runtimeApiUrl: "http://nora.internal.example:19500",
      dashboardUrl: "http://nora.internal.example:19044",
      apiKey: "hermes-token",
    });
  });

  it("omits the connect block for non-Docker Hermes agents", async () => {
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
          id: "a-hermes-connect-k8s",
          user_id: "user-1",
          status: "running",
          runtime_family: "hermes",
          backend_type: "k8s",
          container_id: "hermes-k8s-container",
          runtime_host: "10.42.0.5",
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

    const res = await auth(request(app).get("/agents/a-hermes-connect-k8s/hermes-ui"));

    expect(res.status).toBe(200);
    expect(res.body.connect).toBeUndefined();
    // Non-Docker gate must short-circuit before touching the container at all.
    expect(mockDockerInspect).not.toHaveBeenCalled();
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
  it("fails closed when a Hermes integration manifest cannot be built", async () => {
    const integrationsModule = require("../integrations");
    integrationsModule.connectIntegration.mockResolvedValueOnce({
      id: "int-hermes-missing-strategy",
      provider: "stale-provider",
    });
    integrationsModule.getIntegrationsForSync.mockRejectedValueOnce(
      new Error('No integration strategy is registered for provider "stale-provider"'),
    );

    const agent = {
      id: "a-hermes-missing-strategy",
      user_id: "user-1",
      name: "Hermes Missing Strategy",
      status: "running",
      runtime_family: "hermes",
      backend_type: "docker",
      container_id: "hermes-container",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(
      request(app).post("/agents/a-hermes-missing-strategy/integrations").send({
        provider: "stale-provider",
        token: "stored-token",
      }),
    );

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      error: "Integration saved, but runtime reconciliation could not be confirmed",
      committed: true,
    });
    expect(integrationsModule.getIntegrationsForSync).toHaveBeenCalledTimes(1);
    expect(mockRunContainerCommand).not.toHaveBeenCalled();
    expect(mockSyncAuthToUserAgents).not.toHaveBeenCalled();
  });

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
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", "a-hermes-integration", {
      providerLockHeld: true,
    });
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

  it("reconciles exact managed auth state for non-LLM OpenClaw integrations", async () => {
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
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", "a-openclaw-integration", {
      providerLockHeld: true,
    });
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
    expect(res.body.error).toBe(
      "Integration deleted, but 1 runtime could not be stopped and quarantined after credential reconciliation failed",
    );
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
      })
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
    const containerManager = require("../containerManager");
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
            status: "stopped",
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
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-start-1", status: "synced" },
    ]);

    const res = await auth(request(app).post("/agents/agent-start-1/start"));

    expect(res.status).toBe(200);
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-start-1", user_id: "user-1" }),
      "start",
    );
    expect(mockAcquireAgentProvisionLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockResumeAgentWithProviderAuth.mock.invocationCallOrder[0],
    );
    expect(mockResumeAgentWithProviderAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(containerManager.start).not.toHaveBeenCalled();
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

  it("uses the durable owner and reconciles empty auth when a workspace editor starts an agent", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-editor-start",
            name: "Shared Start Agent",
            user_id: "owner-1",
            container_id: "container-editor-start",
            status: "stopped",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-editor-start",
            name: "Shared Start Agent",
            user_id: "owner-1",
            container_id: "container-editor-start",
            status: "stopped",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-editor-start",
            name: "Shared Start Agent",
            user_id: "owner-1",
            container_id: "container-editor-start",
            status: "running",
          },
        ],
      });
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-editor-start", status: "synced" },
    ]);

    const res = await editorAuth(request(app).post("/agents/agent-editor-start/start"));

    expect(res.status).toBe(200);
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-editor-start", user_id: "owner-1" }),
      "start",
    );
  });

  it("stops the runtime when resume auth reconciliation fails", async () => {
    const containerManager = require("../containerManager");
    const monitoringModule = require("../monitoring");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-auth-failure",
            name: "Auth Failure Agent",
            user_id: "user-1",
            container_id: "container-auth-failure",
            status: "stopped",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-auth-failure",
            name: "Auth Failure Agent",
            user_id: "user-1",
            container_id: "container-auth-failure",
            status: "stopped",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-auth-failure",
            name: "Auth Failure Agent",
            user_id: "user-1",
            container_id: "container-auth-failure",
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockResumeAgentWithProviderAuth.mockRejectedValueOnce(
      Object.assign(new Error("Current provider authentication could not be reconciled"), {
        statusCode: 502,
        code: "AGENT_AUTH_RECONCILIATION_FAILED",
      }),
    );

    const res = await auth(request(app).post("/agents/agent-start-auth-failure/start"));

    expect(res.status).toBe(502);
    expect(containerManager.stop).not.toHaveBeenCalled();
    expect(monitoringModule.logEvent).not.toHaveBeenCalledWith(
      "agent_started",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("agent lifecycle address persistence", () => {
  it("persists a refreshed runtime address before start auth sync", async () => {
    const containerManager = require("../containerManager");
    mockResumeAgentWithProviderAuth.mockImplementationOnce(async (agent) => ({
      agent: {
        ...agent,
        status: "running",
        paused_reason: null,
        host: "10.20.30.41",
        runtime_host: "10.20.30.41",
      },
      lifecycleResult: { host: "10.20.30.41", runtimeHost: "10.20.30.41" },
    }));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-address",
            name: "Start Address Agent",
            user_id: "user-1",
            backend_type: "proxmox",
            container_id: "201",
            host: "10.20.30.10",
            runtime_host: "10.20.30.10",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-address",
            name: "Start Address Agent",
            user_id: "user-1",
            backend_type: "proxmox",
            container_id: "201",
            status: "stopped",
            host: "10.20.30.10",
            runtime_host: "10.20.30.10",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-start-address",
            name: "Start Address Agent",
            user_id: "user-1",
            backend_type: "proxmox",
            container_id: "201",
            status: "running",
            host: "10.20.30.41",
            runtime_host: "10.20.30.41",
          },
        ],
      });
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-start-address", status: "synced" },
    ]);

    const res = await auth(request(app).post("/agents/agent-start-address/start"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ host: "10.20.30.41", runtime_host: "10.20.30.41" }),
    );
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-start-address" }),
      "start",
    );
    expect(containerManager.start).not.toHaveBeenCalled();
  });

  it("persists a refreshed runtime address after restart", async () => {
    const containerManager = require("../containerManager");
    mockResumeAgentWithProviderAuth.mockImplementationOnce(async (agent) => ({
      agent: {
        ...agent,
        status: "running",
        paused_reason: null,
        host: "10.20.30.42",
        runtime_host: "10.20.30.42",
      },
      lifecycleResult: { host: "10.20.30.42", runtimeHost: "10.20.30.42" },
    }));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-restart-address",
            name: "Restart Address Agent",
            user_id: "user-1",
            backend_type: "proxmox",
            container_id: "202",
            host: "10.20.30.11",
            runtime_host: "10.20.30.11",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-restart-address",
            name: "Restart Address Agent",
            user_id: "user-1",
            backend_type: "proxmox",
            container_id: "202",
            status: "running",
            host: "10.20.30.11",
            runtime_host: "10.20.30.11",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-restart-address", status: "synced" },
    ]);

    const res = await auth(request(app).post("/agents/agent-restart-address/restart"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-restart-address" }),
      "restart",
    );
    expect(mockResumeAgentWithProviderAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(containerManager.restart).not.toHaveBeenCalled();
  });

  it("uses the durable owner when a workspace editor restarts an agent", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-editor-restart",
            name: "Shared Restart Agent",
            user_id: "owner-1",
            container_id: "container-editor-restart",
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-editor-restart",
            name: "Shared Restart Agent",
            user_id: "owner-1",
            container_id: "container-editor-restart",
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-editor-restart", status: "synced" },
    ]);

    const res = await editorAuth(request(app).post("/agents/agent-editor-restart/restart"));

    expect(res.status).toBe(200);
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-editor-restart", user_id: "owner-1" }),
      "restart",
    );
  });
});

describe("agent lifecycle provision locking", () => {
  it.each([
    ["start", "queued"],
    ["start", "deploying"],
    ["stop", "queued"],
    ["stop", "deploying"],
    ["restart", "queued"],
    ["restart", "deploying"],
  ])("rejects %s when the locked agent row is %s", async (action, lockedStatus) => {
    const containerManager = require("../containerManager");
    const agentId = `agent-${action}-${lockedStatus}`;
    const visibleAgent = {
      id: agentId,
      name: "Lifecycle Locked Agent",
      user_id: "user-1",
      status: "running",
      container_id: `container-${action}-${lockedStatus}`,
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [visibleAgent] })
      .mockResolvedValueOnce({ rows: [{ ...visibleAgent, status: lockedStatus }] });

    const res = await auth(request(app).post(`/agents/${agentId}/${action}`));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/queued or in progress/i);
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith(agentId, {
      applicationName: `nora-backend-agent-${action}`,
    });
    expect(containerManager[action]).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
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
  it("atomically assigns an API-key adoption to the bound workspace", async () => {
    authorizeWorkspaceApiKey();
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-ext-api-key",
          name: "Workspace External",
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

    const res = await workspaceApiKeyAuth(
      request(app).post("/agents/adopt").send({
        name: "Workspace External",
        runtime_family: "openclaw",
        url: "https://203.0.113.5:18789",
        gateway_token: ADOPTED_GATEWAY_TOKEN,
      }),
    );

    expect(res.status).toBe(201);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[0][0]).toMatch(/WITH created_agent AS[\s\S]*workspace_agents/i);
    expect(mockDb.query.mock.calls[0][1].at(-1)).toBe("workspace-a");
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

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
        gateway_token: ADOPTED_GATEWAY_TOKEN,
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
      expect.arrayContaining([
        "user-1",
        "openclaw",
        "203.0.113.5",
        18789,
        `enc(${ADOPTED_GATEWAY_TOKEN})`,
      ]),
    );
    expect(insert[1]).not.toContain(ADOPTED_GATEWAY_TOKEN);
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

  it.each(["short-token", "0123456789abcdef 0123456789abcdef"])(
    "rejects a weak external gateway token (%s)",
    async (gatewayToken) => {
      const res = await auth(
        request(app).post("/agents/adopt").send({
          runtime_family: "openclaw",
          url: "https://203.0.113.5:18789",
          gateway_token: gatewayToken,
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cryptographically generated secret.*32-4096 characters/i);
      expect(mockDb.query).not.toHaveBeenCalled();
    },
  );

  it("rejects an endpoint on a non-allowed port (SSRF gate)", async () => {
    const res = await auth(
      request(app).post("/agents/adopt").send({
        runtime_family: "openclaw",
        url: "http://203.0.113.5:8080",
        gateway_token: ADOPTED_GATEWAY_TOKEN,
      }),
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
        gateway_token: ADOPTED_GATEWAY_TOKEN,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an allowed gateway address/i);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects an unsupported runtime family", async () => {
    const res = await auth(
      request(app).post("/agents/adopt").send({
        runtime_family: "nope",
        url: "https://203.0.113.5:18789",
        gateway_token: ADOPTED_GATEWAY_TOKEN,
      }),
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
        gateway_token: ADOPTED_GATEWAY_TOKEN,
      }),
    );
    expect(res.status).toBe(402);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("POST /agents/activate-demo", () => {
  it("keeps demo activation session-only", async () => {
    authorizeWorkspaceApiKey();

    const response = await workspaceApiKeyAuth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "session_required" });
    expect(mockPgClient).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("serializes concurrent activation requests and returns one demo agent", async () => {
    let locked = false;
    const waiters = [];
    let persistedAgent = null;
    const clients = [];

    async function acquireLock() {
      if (!locked) {
        locked = true;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
    }

    function releaseLock() {
      const next = waiters.shift();
      if (next) next();
      else locked = false;
    }

    mockPgClient.mockImplementation(() => {
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        end: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql, params) => {
          if (sql.includes("pg_advisory_lock")) {
            await acquireLock();
            return { rows: [] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            releaseLock();
            return { rows: [] };
          }
          if (sql.includes("FROM agents") && sql.includes("template_payload @>")) {
            return { rows: persistedAgent ? [persistedAgent] : [] };
          }
          if (sql.includes("INSERT INTO agents")) {
            await new Promise((resolve) => setImmediate(resolve));
            persistedAgent = {
              id: "agent-demo",
              user_id: "user-1",
              name: "Demo Agent",
              status: "queued",
              backend_type: "docker",
              sandbox_type: "standard",
              runtime_family: "openclaw",
              deploy_target: "docker",
              execution_target_id: "docker",
              sandbox_profile: "standard",
              container_name: params[8],
              image: params[9],
              created_at: "2026-07-12T00:00:00.000Z",
            };
            return { rows: [persistedAgent] };
          }
          return { rows: [] };
        }),
      };
      clients.push(client);
      return client;
    });
    mockAddDeploymentJob.mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      auth(request(app).post("/agents/activate-demo").send({})),
      auth(request(app).post("/agents/activate-demo").send({})),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.id).toBe("agent-demo");
    expect(second.body.id).toBe("agent-demo");
    expect(mockAddDeploymentJob).toHaveBeenCalledTimes(2);
    for (const [payload, options] of mockAddDeploymentJob.mock.calls) {
      expect(payload).toEqual(
        expect.objectContaining({
          id: "agent-demo",
          backend: "docker",
          execution_target_id: "docker",
          sandbox: "standard",
          llm_provider_id: "provider-demo",
        }),
      );
      expect(options).toEqual({ jobId: "demo-activation-agent-demo" });
    }
    expect(mockDockerPing).toHaveBeenCalledTimes(2);
    const insertCalls = clients
      .flatMap((client) => client.query.mock.calls)
      .filter(([sql]) => sql.includes("INSERT INTO agents"));
    expect(insertCalls).toHaveLength(1);
    expect(JSON.parse(insertCalls[0][1][10])).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ activation: "local-docker-demo-v1" }),
      }),
    );
    const lookupSql = clients
      .flatMap((client) => client.query.mock.calls)
      .map(([sql]) => sql)
      .find((sql) => sql.includes("FROM agents") && sql.includes("template_payload @>"));
    expect(lookupSql).toEqual(expect.stringContaining("runtime_family = 'openclaw'"));
    expect(lookupSql).toEqual(expect.stringContaining("deploy_target = 'docker'"));
    expect(lookupSql).toEqual(expect.stringContaining("execution_target_id = 'docker'"));
    expect(lookupSql).toEqual(expect.stringContaining("sandbox_profile = 'standard'"));
    expect(clients).toHaveLength(2);
    expect(clients.every((client) => client.connect.mock.calls.length === 1)).toBe(true);
    expect(clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockPgClient).toHaveBeenCalledTimes(2);
    for (const [config] of mockPgClient.mock.calls) {
      expect(config).toEqual(
        expect.objectContaining({ application_name: "nora-backend-demo-activation" }),
      );
      expect(config).not.toHaveProperty("max");
      expect(config).not.toHaveProperty("idleTimeoutMillis");
    }
  });

  it("removes the new deployment and agent when queueing fails", async () => {
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql, params) => {
        if (sql.includes("FROM agents") && sql.includes("template_payload @>")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO agents")) {
          return {
            rows: [
              {
                id: "agent-demo-failed",
                user_id: "user-1",
                name: "Demo Agent",
                status: "queued",
                runtime_family: "openclaw",
                deploy_target: "docker",
                execution_target_id: "docker",
                sandbox_profile: "standard",
                backend_type: "docker",
                sandbox_type: "standard",
                container_name: params[8],
                image: params[9],
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    mockPgClient.mockImplementation(() => client);
    mockAddDeploymentJob.mockRejectedValue(new Error("Redis unavailable"));

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/Redis unavailable/i);
    expect(client.query).toHaveBeenCalledWith("DELETE FROM deployments WHERE agent_id = $1", [
      "agent-demo-failed",
    ]);
    expect(client.query).toHaveBeenCalledWith("DELETE FROM agents WHERE id = $1 AND user_id = $2", [
      "agent-demo-failed",
      "user-1",
    ]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a marker-bearing agent outside the exact local Docker tuple", async () => {
    const copiedRemoteAgent = {
      id: "copied-demo-remote",
      user_id: "user-1",
      name: "Demo Agent Copy",
      status: "error",
      runtime_family: "openclaw",
      deploy_target: "remote-docker",
      execution_target_id: "remote:build-host",
      sandbox_profile: "standard",
      backend_type: "remote-docker",
      container_id: "remote-container",
    };
    const newDemoAgent = {
      id: "agent-demo-local-new",
      user_id: "user-1",
      name: "Demo Agent",
      status: "queued",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      backend_type: "docker",
      sandbox_type: "standard",
    };
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) => {
        if (sql.includes("FROM agents") && sql.includes("template_payload @>")) {
          const exactTupleGuard = [
            "runtime_family = 'openclaw'",
            "deploy_target = 'docker'",
            "execution_target_id = 'docker'",
            "sandbox_profile = 'standard'",
          ].every((clause) => sql.includes(clause));
          return { rows: exactTupleGuard ? [] : [copiedRemoteAgent] };
        }
        if (sql.includes("INSERT INTO agents")) return { rows: [newDemoAgent] };
        return { rows: [] };
      }),
    };
    mockPgClient.mockImplementation(() => client);
    mockAddDeploymentJob.mockResolvedValue(undefined);

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(newDemoAgent.id);
    expect(require("../containerManager").destroy).not.toHaveBeenCalledWith(copiedRemoteAgent);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: newDemoAgent.id, backend: "docker" }),
      { jobId: `demo-activation-${newDemoAgent.id}` },
    );
  });

  it("resets and requeues the same demo agent after a terminal deployment failure", async () => {
    const containerManager = require("../containerManager");
    const failedAgent = {
      id: "agent-demo-error",
      user_id: "user-1",
      name: "Demo Agent",
      status: "error",
      backend_type: "docker",
      sandbox_type: "standard",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      container_id: "stale-demo-container",
      container_name: "nora-oclaw-demo-agent-error",
      image: "nora-openclaw-agent:local",
      vcpu: 1,
      ram_mb: 1024,
      disk_gb: 10,
    };
    const queuedAgent = {
      ...failedAgent,
      status: "queued",
      container_id: null,
      container_name: null,
    };
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) => {
        if (sql.includes("FROM agents") && sql.includes("template_payload @>")) {
          return { rows: [failedAgent] };
        }
        if (sql === "SELECT * FROM agents WHERE id = $1") {
          return { rows: [failedAgent] };
        }
        if (sql.includes("UPDATE agents") && sql.includes("SET status = 'queued'")) {
          return { rows: [queuedAgent] };
        }
        return { rows: [] };
      }),
    };
    mockPgClient.mockImplementation(() => client);
    mockAddDeploymentJob.mockResolvedValue(undefined);

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({ id: failedAgent.id, status: "queued" }),
    );
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledWith(failedAgent.id);
    expect(containerManager.destroy).toHaveBeenCalledWith(failedAgent);
    const resetCallIndex = client.query.mock.calls.findIndex(
      ([sql]) => sql.includes("UPDATE agents") && sql.includes("SET status = 'queued'"),
    );
    expect(resetCallIndex).toBeGreaterThanOrEqual(0);
    expect(client.query.mock.calls[resetCallIndex][0]).toContain("container_name = NULL");
    expect(containerManager.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      client.query.mock.invocationCallOrder[resetCallIndex],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: failedAgent.id, llm_provider_id: "provider-demo" }),
      { jobId: `demo-activation-${failedAgent.id}` },
    );
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith(failedAgent.id, {
      applicationName: "nora-backend-demo-activation-retry",
    });
    expect(mockAcquireAgentProvisionLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelDeploymentJobsForAgent.mock.invocationCallOrder[0],
    );
    expect(mockAddDeploymentJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
  });

  it("returns 409 without resetting an error agent while its previous deployment is active", async () => {
    const containerManager = require("../containerManager");
    const failedAgent = {
      id: "agent-demo-active",
      user_id: "user-1",
      name: "Demo Agent",
      status: "error",
      backend_type: "docker",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      container_id: "active-demo-container",
      container_name: "nora-oclaw-demo-agent-active",
    };
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) => {
        if (sql.includes("FROM agents") && sql.includes("template_payload @>")) {
          return { rows: [failedAgent] };
        }
        if (sql === "SELECT * FROM agents WHERE id = $1") {
          return { rows: [failedAgent] };
        }
        return { rows: [] };
      }),
    };
    mockPgClient.mockImplementation(() => client);
    mockCancelDeploymentJobsForAgent.mockResolvedValue({ removed: 0, active: 1 });

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/still finishing/i);
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledWith(failedAgent.id);
    expect(containerManager.destroy).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(
      client.query.mock.calls.some(
        ([sql]) => sql.includes("UPDATE agents") && sql.includes("SET status = 'queued'"),
      ),
    ).toBe(false);
    expect(
      client.query.mock.calls.some(
        ([sql]) => sql.includes("UPDATE deployments") && sql.includes("status = 'queued'"),
      ),
    ).toBe(false);
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith(failedAgent.id, {
      applicationName: "nora-backend-demo-activation-retry",
    });
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["running", { status: "synced" }],
    ["warning", { status: "synced" }],
    ["stopped", { status: "synced", staged: true }],
  ])(
    "reconciles a %s demo agent after recreating its built-in provider",
    async (status, syncResult) => {
      const stoppedAgent = {
        id: "agent-demo-stopped",
        user_id: "user-1",
        name: "Demo Agent",
        status,
        backend_type: "docker",
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        container_id: "stopped-demo-container",
      };
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        end: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql) =>
          sql.includes("FROM agents") && sql.includes("template_payload @>")
            ? { rows: [stoppedAgent] }
            : { rows: [] },
        ),
      };
      mockPgClient.mockImplementation(() => client);
      mockEnsureDemoProvider.mockResolvedValueOnce({
        id: "provider-demo-recreated",
        provider: "demo",
        model: "nora-demo-1",
        is_default: true,
      });
      mockSyncAuthToUserAgents.mockResolvedValueOnce([{ agentId: stoppedAgent.id, ...syncResult }]);

      const response = await auth(request(app).post("/agents/activate-demo").send({}));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({ id: stoppedAgent.id, status }));
      expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", stoppedAgent.id, {
        providerLockHeld: true,
      });
      expect(mockCancelDeploymentJobsForAgent).not.toHaveBeenCalled();
      expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    },
  );

  it("does not return stale ready state when demo provider reconciliation fails", async () => {
    const existingAgent = {
      id: "agent-demo-reconcile-failed",
      user_id: "user-1",
      name: "Demo Agent",
      status: "running",
      backend_type: "docker",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      container_id: "demo-runtime",
    };
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) =>
        sql.includes("FROM agents") && sql.includes("template_payload @>")
          ? { rows: [existingAgent] }
          : { rows: [] },
      ),
    };
    mockPgClient.mockImplementation(() => client);
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      {
        agentId: existingAgent.id,
        status: "failed",
        error: "runtime unavailable",
        runtimeStopped: true,
        quarantinePersisted: true,
      },
    ]);

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/could not be reconciled/i);
    expect(mockSyncAuthToUserAgents).toHaveBeenCalledWith("user-1", existingAgent.id, {
      providerLockHeld: true,
    });
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("rejects activation with an actionable error when local Docker is unavailable", async () => {
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) => {
        if (sql.includes("FROM agents") && sql.includes("template_payload @>")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    mockPgClient.mockImplementation(() => client);
    mockDockerPing.mockImplementationOnce((callback) =>
      callback(new Error("connect ENOENT /var/run/docker.sock")),
    );

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/start Docker/i);
    expect(response.body.error).toMatch(/\/var\/run\/docker\.sock/i);
    expect(mockEnsureDemoProvider).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO agents"))).toBe(false);
  });

  it("does not let a durable demo row bypass the local Docker availability gate", async () => {
    const existingAgent = {
      id: "agent-demo-restored",
      user_id: "user-1",
      name: "Demo Agent",
      status: "error",
      backend_type: "docker",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      container_id: "restored-container",
    };
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql) =>
        sql.includes("FROM agents") && sql.includes("template_payload @>")
          ? { rows: [existingAgent] }
          : { rows: [] },
      ),
    };
    mockPgClient.mockImplementation(() => client);
    mockDockerPing.mockImplementationOnce((callback) =>
      callback(new Error("connect ENOENT /var/run/docker.sock")),
    );

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/start Docker/i);
    expect(mockEnsureDemoProvider).not.toHaveBeenCalled();
    expect(mockCancelDeploymentJobsForAgent).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("rejects durable demo activation when the Docker deploy target is disabled", async () => {
    process.env.ENABLED_BACKENDS = "k8s";
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    mockPgClient.mockImplementation(() => client);

    const response = await auth(request(app).post("/agents/activate-demo").send({}));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/docker/i);
    expect(response.body.error).toMatch(/not enabled/i);
    expect(mockDockerPing).not.toHaveBeenCalled();
    expect(mockEnsureDemoProvider).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(
      client.query.mock.calls.some(
        ([sql]) => sql.includes("FROM agents") && sql.includes("template_payload @>"),
      ),
    ).toBe(false);
  });
});

describe("POST /agents/deploy", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app).post("/agents/deploy").send({});
    expect(res.status).toBe(401);
  });

  it("keeps migration-draft deployment session-only", async () => {
    authorizeWorkspaceApiKey();

    const res = await workspaceApiKeyAuth(
      request(app).post("/agents/deploy").send({
        name: "Blocked Migration Deploy",
        migration_draft_id: "draft-1",
      }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "session_required" });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(require("../billing").enforceLimits).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it.each([
    ["a personal host", "remote:personal-build-host"],
    ["a host shared through another workspace", "remote:other-workspace-host"],
  ])(
    "rejects a workspace API key before looking up or queueing Remote Docker placement on %s",
    async (_label, executionTargetId) => {
      authorizeWorkspaceApiKey();

      const res = await workspaceApiKeyAuth(
        request(app).post("/agents/deploy").send({
          name: "Blocked Remote Agent",
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: executionTargetId,
          sandbox_profile: "standard",
        }),
      );

      expect(res.status).toBe(403);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: expect.stringMatching(/session authentication/i),
          code: "session_required",
        }),
      );
      expect(require("../billing").enforceLimits).not.toHaveBeenCalled();
      expect(mockAssertRemoteHostExecutionTargetAvailable).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    },
  );

  it("preserves workspace API-key deployment for non-Remote targets", async () => {
    authorizeWorkspaceApiKey();
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-api-key-docker",
            name: "API Key Docker Agent",
            status: "queued",
            user_id: "user-1",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await workspaceApiKeyAuth(
      request(app).post("/agents/deploy").send({
        name: "API Key Docker Agent",
        deploy_target: "docker",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAssertRemoteHostExecutionTargetAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ deploy_target: "docker" }),
      { ownerUserId: "user-1" },
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-api-key-docker", backend: "docker" }),
    );
    expect(mockDb.query.mock.calls[0][0]).toMatch(/WITH created_agent AS[\s\S]*workspace_agents/i);
    expect(mockDb.query.mock.calls[0][1].at(-1)).toBe("workspace-a");
  });

  it("allows a session-authenticated Remote Docker deployment", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-session-remote",
            name: "Session Remote Agent",
            status: "queued",
            user_id: "user-1",
            runtime_family: "openclaw",
            backend_type: "remote-docker",
            deploy_target: "remote-docker",
            execution_target_id: "remote:session-host",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(
      request(app).post("/agents/deploy").send({
        name: "Session Remote Agent",
        deploy_target: "remote-docker",
        execution_target_id: "remote:session-host",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockAssertRemoteHostExecutionTargetAvailable).toHaveBeenCalledWith(
      expect.objectContaining({
        deploy_target: "remote-docker",
        execution_target_id: "remote:session-host",
      }),
      { ownerUserId: "user-1" },
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-session-remote",
        backend: "remote-docker",
        execution_target_id: "remote:session-host",
      }),
    );
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
          metadata: {
            source: "migration-test",
            activation: "local-docker-demo-v1",
          },
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
        files: [expect.objectContaining({ path: "README.md", contentBase64: "" })],
        metadata: { source: "migration-test" },
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

  it.each(["deploy_target", "execution_target_id"])(
    "rejects unknown %s values before queueing a deployment",
    async (field) => {
      const res = await auth(
        request(app)
          .post("/agents/deploy")
          .send({
            name: "BadTarget",
            [field]: "moon",
          }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown deploy target: moon/i);
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    },
  );

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

  it("keeps secret-bearing migration exports session-only for workspace API keys", async () => {
    authorizeWorkspaceApiKey({ scopes: ["agents:read"] });
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-files-1",
          backend_type: "docker",
          deploy_target: "docker",
          execution_target_id: "docker",
        },
      ],
    });

    const res = await workspaceApiKeyAuth(request(app).get("/agents/agent-files-1/export"));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "session_required" });
    expect(mockBuildMigrationManifestFromAgent).not.toHaveBeenCalled();
    expect(mockPackMigrationBundle).not.toHaveBeenCalled();
  });

  it.each([
    "/agents/agent-files-1/files/roots",
    "/agents/agent-files-1/files/content?root=workspace&path=AGENTS.md",
    "/agents/agent-files-1/files/download?root=workspace&path=AGENTS.md",
  ])("keeps secret-bearing runtime file reads session-only at %s", async (path) => {
    authorizeWorkspaceApiKey({ scopes: ["agents:read"] });

    const res = await workspaceApiKeyAuth(request(app).get(path));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "session_required" });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockDownloadPath).not.toHaveBeenCalled();
    expect(mockRootsForAgent).not.toHaveBeenCalled();
  });
});

describe("PATCH /agents/:id", () => {
  it("preserves non-Remote API-key mutation inside the bound workspace", async () => {
    authorizeWorkspaceApiKey();
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-key-rename",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "a-key-rename", name: "Old Name", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "a-key-rename", name: "New Name", user_id: "user-1" }],
      });

    const res = await workspaceApiKeyAuth(
      request(app).patch("/agents/a-key-rename").send({ name: "New Name" }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name", "New Name");
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

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
  it.each([
    [
      "a Remote Docker source onto a local target",
      {
        backend_type: "remote-docker",
        deploy_target: "remote-docker",
        execution_target_id: "remote:source-host",
      },
      { deploy_target: "docker", execution_target_id: "docker" },
    ],
    [
      "a local source onto a Remote Docker target",
      {
        backend_type: "docker",
        deploy_target: "docker",
        execution_target_id: "docker",
      },
      {
        deploy_target: "remote-docker",
        execution_target_id: "remote:destination-host",
      },
    ],
  ])(
    "rejects workspace API-key duplication involving %s",
    async (_label, sourcePlacement, body) => {
      authorizeWorkspaceApiKey();
      const sourceAgent = {
        id: "a-api-key-duplicate-source",
        name: "API Key Duplicate Source",
        user_id: "user-1",
        status: "stopped",
        runtime_family: "openclaw",
        sandbox_profile: "standard",
        sandbox_type: "standard",
        ...sourcePlacement,
      };
      mockDb.query
        .mockResolvedValueOnce({ rows: [sourceAgent] })
        .mockResolvedValueOnce({ rows: [sourceAgent] });

      const res = await workspaceApiKeyAuth(
        request(app)
          .post("/agents/a-api-key-duplicate-source/duplicate")
          .send({
            name: "Blocked Duplicate",
            ...body,
          }),
      );

      expect(res.status).toBe(403);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: expect.stringMatching(/session authentication/i),
          code: "session_required",
        }),
      );
      expect(require("../billing").enforceLimits).not.toHaveBeenCalled();
      expect(mockAssertRemoteHostExecutionTargetAvailable).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(
        sourcePlacement.deploy_target === "remote-docker" ? 1 : 2,
      );
      expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    },
  );

  it("atomically assigns a non-Remote API-key duplicate to the bound workspace", async () => {
    authorizeWorkspaceApiKey();
    const sourceAgent = {
      id: "a-api-key-local-source",
      name: "Workspace Source",
      user_id: "user-1",
      status: "stopped",
      runtime_family: "openclaw",
      backend_type: "docker",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      sandbox_type: "standard",
      template_payload: { files: [{ path: "AGENT.md", content: "hello" }] },
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [sourceAgent] })
      .mockResolvedValueOnce({ rows: [sourceAgent] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-api-key-local-copy",
            name: "Workspace Copy",
            user_id: "user-1",
            status: "queued",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await workspaceApiKeyAuth(
      request(app).post("/agents/a-api-key-local-source/duplicate").send({
        name: "Workspace Copy",
        clone_mode: "files_only",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockDb.query.mock.calls[2][0]).toMatch(/WITH created_agent AS[\s\S]*workspace_agents/i);
    expect(mockDb.query.mock.calls[2][1].at(-1)).toBe("workspace-a");
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-api-key-local-copy", backend: "docker" }),
    );
  });

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
          metadata: {
            starterType: "operations",
            activation: "local-docker-demo-v1",
          },
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
    expect(JSON.parse(insertParams[10]).metadata).toEqual({ starterType: "operations" });
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

  it("strips internal activation metadata from remote Agent Hub installs", async () => {
    const agentHubRemote = require("../agentHubRemote");
    agentHubRemote.fetchListing.mockResolvedValueOnce({
      id: "hub:remote-demo",
      remote_id: "remote-demo",
      name: "Remote Demo Copy",
      defaults: { backend: "docker", sandbox: "standard" },
      templatePayload: {
        metadata: {
          source: "demo-activation",
          activation: "local-docker-demo-v1",
        },
        files: [{ path: "AGENTS.md", content: "remote" }],
      },
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-remote-template",
            name: "Remote Demo Copy",
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
        listingId: "hub:remote-demo",
        name: "Remote Demo Copy",
      }),
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(mockDb.query.mock.calls[0][1][10]).metadata).toEqual({
      source: "demo-activation",
    });
  });

  it("rejects unknown stored template targets before queueing an Agent Hub install", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      snapshot_id: "snap-1",
      name: "Broken Template",
      status: "published",
      source_type: "platform",
    });
    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snap-1",
      name: "Broken Template",
      config: {
        defaults: {
          deploy_target: "moon",
          sandbox: "standard",
        },
      },
    });

    const res = await auth(
      request(app).post("/agent-hub/install").send({
        listingId: "listing-1",
        name: "Broken Agent",
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown deploy target: moon/i);
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
            metadata: {
              source: "demo-activation",
              activation: "local-docker-demo-v1",
            },
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
    expect(snapshotsModule.createSnapshot.mock.calls[0][3].templatePayload.metadata).toEqual({
      source: "demo-activation",
    });
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

  it("does not forward internal activation metadata in remote Agent Hub downloads", async () => {
    const agentHubRemote = require("../agentHubRemote");
    agentHubRemote.fetchListing.mockResolvedValueOnce({
      id: "hub:remote-download",
      remote_id: "remote-download",
      slug: "remote-download",
      name: "Remote Download",
      defaults: {},
      templatePayload: {
        metadata: {
          source: "demo-activation",
          activation: "local-docker-demo-v1",
        },
        files: [{ path: "AGENTS.md", content: "remote" }],
      },
    });

    const res = await auth(request(app).get("/agent-hub/hub:remote-download/download"));

    expect(res.status).toBe(200);
    expect(res.body.templatePayload.metadata).toEqual({ source: "demo-activation" });
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
  it("rejects when an API-key agent becomes Remote Docker during the lifecycle lock", async () => {
    authorizeWorkspaceApiKey({ scopes: ["agents:write"] });
    const localAgent = {
      id: "a-key-placement-race",
      status: "running",
      user_id: "user-1",
      runtime_family: "openclaw",
      backend_type: "docker",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      container_id: "local-container",
    };
    const remoteAgent = {
      ...localAgent,
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:race-host",
      container_id: "remote-container",
    };
    mockDb.query
      // Global exact-workspace guard.
      .mockResolvedValueOnce({ rows: [localAgent] })
      // Pre-lock visibility remains local.
      .mockResolvedValueOnce({ rows: [localAgent] })
      // The authoritative row after acquiring the provision lock is remote.
      .mockResolvedValueOnce({ rows: [remoteAgent] });

    const res = await workspaceApiKeyAuth(request(app).post("/agents/a-key-placement-race/stop"));

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/session authentication/i),
        code: "session_required",
      }),
    );
    expect(require("../containerManager").stop).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  it("stops a running agent", async () => {
    // db.query calls: initial visibility, locked revalidation, UPDATE status
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a1", status: "running", container_id: null, user_id: "user-1" }],
      })
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
    const statusUpdateIndex = mockDb.query.mock.calls.findIndex(
      ([sql]) => String(sql) === "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *",
    );
    expect(statusUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(containerManager.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(mockDb.query.mock.invocationCallOrder[statusUpdateIndex]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
  });

  it("keeps a Kubernetes agent running in Nora when Kubernetes stop fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.stop.mockRejectedValueOnce(new Error("Kubernetes patch failed"));
    const agent = {
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
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(request(app).post("/agents/a-k8s-stop-fail/stop"));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockDb.query).not.toHaveBeenCalledWith(
      "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *",
      [agent.id],
    );
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it("keeps a Proxmox agent running when shutdown fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.stop.mockRejectedValueOnce(new Error("Proxmox shutdown task failed"));
    const agent = {
      id: "a-proxmox-stop-fail",
      name: "Proxmox Stop Fail",
      status: "running",
      user_id: "user-1",
      runtime_family: "openclaw",
      backend_type: "proxmox",
      deploy_target: "proxmox",
      execution_target_id: "proxmox",
      sandbox_profile: "standard",
      container_id: "301",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(request(app).post("/agents/a-proxmox-stop-fail/stop"));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockDb.query).not.toHaveBeenCalledWith(
      "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *",
      [agent.id],
    );
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it("marks an already stopped runtime as stopped idempotently", async () => {
    const containerManager = require("../containerManager");
    containerManager.stop.mockRejectedValueOnce(new Error("Container is not running"));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-already-stopped",
            name: "Already Stopped",
            status: "running",
            user_id: "user-1",
            backend_type: "docker",
            container_id: "container-stopped",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-already-stopped",
            name: "Already Stopped",
            status: "running",
            user_id: "user-1",
            backend_type: "docker",
            container_id: "container-stopped",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "a-already-stopped", status: "stopped" }] });

    const res = await auth(request(app).post("/agents/a-already-stopped/stop"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: "stopped" }));
  });
});

describe("POST /agents/:id/redeploy", () => {
  it.each([
    [
      "moving an existing Remote Docker runtime to Docker",
      {
        backend_type: "remote-docker",
        deploy_target: "remote-docker",
        execution_target_id: "remote:current-host",
      },
      { deploy_target: "docker", execution_target_id: "docker" },
    ],
    [
      "moving a Docker runtime onto Remote Docker",
      {
        backend_type: "docker",
        deploy_target: "docker",
        execution_target_id: "docker",
      },
      {
        deploy_target: "remote-docker",
        execution_target_id: "remote:next-host",
      },
    ],
  ])("rejects workspace API-key redeploy when %s", async (_label, currentPlacement, body) => {
    authorizeWorkspaceApiKey();
    const agent = {
      id: "a-api-key-redeploy",
      name: "API Key Redeploy",
      status: "stopped",
      user_id: "user-1",
      runtime_family: "openclaw",
      sandbox_profile: "standard",
      sandbox_type: "standard",
      container_id: "existing-runtime",
      container_name: "existing-runtime",
      ...currentPlacement,
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });

    const res = await workspaceApiKeyAuth(
      request(app).post("/agents/a-api-key-redeploy/redeploy").send(body),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/session authentication/i),
        code: "session_required",
      }),
    );
    expect(mockAssertRemoteHostExecutionTargetAvailable).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(
      currentPlacement.deploy_target === "remote-docker" ? 1 : 2,
    );
    expect(mockAcquireAgentProvisionLock).not.toHaveBeenCalled();
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("allows redeploy when an agent is in warning state", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-warning",
            name: "Warning Agent",
            status: "warning",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            sandbox_type: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_id: "warning-container-old",
            container_name: "oclaw-agent-warning",
            host: "172.18.0.10",
            image: "nora-openclaw-agent:local",
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
      expect.stringContaining("SET status = 'queued'"),
      [
        "a-warning",
        "warning",
        "warning-container-old",
        "oclaw-agent-warning",
        "docker",
        "openclaw",
        "docker",
        "docker",
        "standard",
        "172.18.0.10",
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-warning",
        name: "Warning Agent",
        userId: "user-1",
        backend: "docker",
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        sandbox: "standard",
        replace_existing_runtime: true,
        previous_container_id: "warning-container-old",
        previous_container_name: "oclaw-agent-warning",
        previous_host: "172.18.0.10",
        previous_backend: "docker",
        previous_runtime_family: "openclaw",
        previous_deploy_target: "docker",
        previous_execution_target_id: "docker",
        previous_sandbox_profile: "standard",
        specs: { vcpu: 2, ram_mb: 2048, disk_gb: 20 },
        container_name: expect.stringMatching(/^nora-oclaw-warning-agent-/),
        image: "nora-openclaw-agent:local",
      }),
    );
  });

  it("queues a workspace editor redeploy with the persisted owner and full runtime selection", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-shared-redeploy",
            name: "Shared Agent",
            status: "warning",
            user_id: "owner-1",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            sandbox_type: "standard",
            vcpu: 4,
            ram_mb: 4096,
            disk_gb: 40,
            container_name: "nora-oclaw-shared-agent-existing",
            image: "nora-openclaw-agent:local",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await editorAuth(request(app).post("/agents/a-shared-redeploy/redeploy"));

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-shared-redeploy",
        userId: "owner-1",
        backend: "docker",
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        sandbox: "standard",
        replace_existing_runtime: true,
        specs: { vcpu: 4, ram_mb: 4096, disk_gb: 40 },
      }),
    );
    expect(mockAddDeploymentJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: "workspace-editor-1" }),
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
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "nemoclaw",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_id: "nemo-container-old",
            container_name: "oclaw-agent-nemo",
            host: "172.18.0.11",
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
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'queued'"),
      [
        "a-nemo-redeploy",
        "stopped",
        "nemo-container-old",
        "oclaw-agent-nemo",
        "docker",
        "openclaw",
        "docker",
        "docker",
        "nemoclaw",
        "172.18.0.11",
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-nemo-redeploy",
        backend: "k8s",
        runtime_family: "openclaw",
        deploy_target: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox_profile: "standard",
        sandbox: "standard",
        replace_existing_runtime: true,
        previous_container_id: "nemo-container-old",
        previous_container_name: "oclaw-agent-nemo",
        previous_host: "172.18.0.11",
        previous_backend: "docker",
        previous_runtime_family: "openclaw",
        previous_deploy_target: "docker",
        previous_execution_target_id: "docker",
        previous_sandbox_profile: "nemoclaw",
        container_name: expect.stringMatching(/^nora-oclaw-nemo-agent-/),
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
        replace_existing_runtime: true,
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
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_id: "docker-container-old",
            container_name: "oclaw-agent-docker",
            host: "172.18.0.12",
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
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'queued'"),
      [
        "a-docker-redeploy",
        "stopped",
        "docker-container-old",
        "oclaw-agent-docker",
        "docker",
        "openclaw",
        "docker",
        "docker",
        "standard",
        "172.18.0.12",
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-docker-redeploy",
        backend: "k8s",
        runtime_family: "openclaw",
        deploy_target: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox_profile: "standard",
        sandbox: "standard",
        replace_existing_runtime: true,
        previous_container_id: "docker-container-old",
        previous_container_name: "oclaw-agent-docker",
        previous_host: "172.18.0.12",
        previous_backend: "docker",
        previous_runtime_family: "openclaw",
        previous_deploy_target: "docker",
        previous_execution_target_id: "docker",
        previous_sandbox_profile: "standard",
        container_name: expect.stringMatching(/^nora-oclaw-docker-agent-/),
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
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_id: "desk-bot-container-old",
            container_name: "oclaw-agent-desk-bot-old123",
            host: "172.18.0.13",
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
      expect.stringContaining("SET status = 'queued'"),
      [
        "a-hermes-redeploy",
        "stopped",
        "desk-bot-container-old",
        "oclaw-agent-desk-bot-old123",
        "docker",
        "openclaw",
        "docker",
        "docker",
        "standard",
        "172.18.0.13",
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-hermes-redeploy",
        backend: "docker",
        runtime_family: "hermes",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        sandbox: "standard",
        container_name: expect.stringMatching(/^nora-hermes-desk-bot-/),
        replace_existing_runtime: true,
        previous_container_id: "desk-bot-container-old",
        previous_container_name: "oclaw-agent-desk-bot-old123",
        previous_host: "172.18.0.13",
        previous_backend: "docker",
        previous_runtime_family: "openclaw",
        previous_deploy_target: "docker",
        previous_execution_target_id: "docker",
        previous_sandbox_profile: "standard",
        image: "nousresearch/hermes-agent:latest",
      }),
    );
  });

  it("preserves previous runtime identity and restores status when enqueue is rejected", async () => {
    mockAddDeploymentJob.mockRejectedValueOnce(new Error("queue unavailable"));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-safe-redeploy",
            name: "Safe Redeploy",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            container_id: "local-container-old",
            container_name: "local-container-old-name",
            host: "172.18.0.12",
            image: "nora-openclaw-agent:local",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValue({ rows: [] });

    const res = await auth(request(app).post("/agents/a-safe-redeploy/redeploy"));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("queue unavailable");
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(2);
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = $2 WHERE id = $1 AND status = 'queued'",
      ["a-safe-redeploy", "stopped"],
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'",
      ["a-safe-redeploy"],
    );
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes("container_id = NULL")),
    ).toBe(false);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        replace_existing_runtime: true,
        previous_container_id: "local-container-old",
        previous_execution_target_id: "docker",
      }),
    );
  });

  it("restores the previous status when the deployment row cannot be inserted", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-insert-failure",
            name: "Insert Failure",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            container_id: "local-container-old",
            container_name: "local-container-old-name",
            host: "172.18.0.12",
            image: "nora-openclaw-agent:local",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("deployment insert unavailable"))
      .mockResolvedValue({ rows: [] });

    const res = await auth(request(app).post("/agents/a-insert-failure/redeploy"));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("deployment insert unavailable");
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(1);
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = $2 WHERE id = $1 AND status = 'queued'",
      ["a-insert-failure", "stopped"],
    );
    expect(mockDb.query).not.toHaveBeenCalledWith(
      "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'",
      ["a-insert-failure"],
    );
  });

  it("rejects a stale replacement producer after the runtime identity changes", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "a-stale-redeploy",
            name: "Stale Redeploy",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "docker",
            deploy_target: "docker",
            execution_target_id: "docker",
            sandbox_profile: "standard",
            container_id: "old-runtime",
            container_name: "old-runtime-name",
            user_id: "user-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await auth(request(app).post("/agents/a-stale-redeploy/redeploy"));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/runtime state changed/i);
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalledWith(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      ["a-stale-redeploy"],
    );
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
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

describe("GET /agents/:id/schedules/:scheduleId/runs", () => {
  it("binds schedule-run history to both the authorized agent and schedule", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "agent-a", user_id: "user-1", name: "Agent A" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).get("/agents/agent-a/schedules/schedule-b/runs"));

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("metadata #>> '{result,agentId}' = $2"),
      ["schedule-b", "agent-a", 25],
    );
  });
});

describe("POST /agents/:id/rollback/:versionId", () => {
  it("rejects workspace API-key rollback of a Remote Docker agent before version or lock work", async () => {
    authorizeWorkspaceApiKey();
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "a-api-key-remote-rollback",
          name: "API Key Remote Rollback",
          status: "stopped",
          user_id: "user-1",
          runtime_family: "openclaw",
          backend_type: "remote-docker",
          deploy_target: "remote-docker",
          execution_target_id: "remote:rollback-host",
          sandbox_profile: "standard",
          sandbox_type: "standard",
          container_id: "remote-runtime",
          container_name: "remote-runtime",
        },
      ],
    });

    const res = await workspaceApiKeyAuth(
      request(app).post("/agents/a-api-key-remote-rollback/rollback/version-1"),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/session authentication/i),
        code: "session_required",
      }),
    );
    expect(mockGetAgentVersion).not.toHaveBeenCalled();
    expect(mockAcquireAgentProvisionLock).not.toHaveBeenCalled();
    expect(mockAssertRemoteHostExecutionTargetAvailable).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockAddDeploymentJob).not.toHaveBeenCalled();
  });

  it("queues rollback from the locked row when a runtime appears while waiting for the lock", async () => {
    const targetConfig = { files: [], memoryFiles: [], wiring: { channels: [], integrations: [] } };
    const initialAgent = {
      id: "a-shared-rollback",
      name: "Shared Rollback Agent",
      status: "stopped",
      user_id: "owner-1",
      runtime_family: "openclaw",
      backend_type: "docker",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      sandbox_type: "standard",
      vcpu: 3,
      ram_mb: 3072,
      disk_gb: 30,
      container_id: null,
      container_name: null,
      host: null,
      image: "nora-openclaw-agent:local",
    };
    const lockedAgent = {
      ...initialAgent,
      status: "running",
      container_id: "container-before-rollback",
      container_name: "nora-oclaw-shared-rollback-existing",
      host: "172.18.0.10",
    };
    mockGetAgentVersion.mockResolvedValueOnce({
      id: "version-2",
      versionNumber: 2,
      config: targetConfig,
    });
    mockRecordAgentVersion.mockResolvedValueOnce({
      id: "version-3",
      versionNumber: 3,
      config: targetConfig,
    });
    let agentReadCount = 0;
    mockDb.query.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement === "SELECT * FROM agents WHERE id = $1") {
        agentReadCount += 1;
        return { rows: [agentReadCount === 1 ? initialAgent : lockedAgent] };
      }
      if (statement.includes("JOIN workspace_members")) {
        return { rows: [{ role: "editor" }] };
      }
      if (statement === "SELECT template_payload FROM agents WHERE id = $1") {
        return { rows: [{ template_payload: { files: [] } }] };
      }
      if (statement.includes("SET status = 'queued'")) {
        return { rows: [{ id: lockedAgent.id }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const res = await editorAuth(request(app).post("/agents/a-shared-rollback/rollback/version-2"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ redeployed: true }));
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a-shared-rollback",
        userId: "owner-1",
        backend: "docker",
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        sandbox: "standard",
        specs: { vcpu: 3, ram_mb: 3072, disk_gb: 30 },
        previous_container_id: "container-before-rollback",
        previous_container_name: "nora-oclaw-shared-rollback-existing",
        previous_host: "172.18.0.10",
        replace_existing_runtime: true,
      }),
    );
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith("a-shared-rollback", {
      applicationName: "nora-backend-agent-rollback",
    });
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(1);
    expect(mockAcquireAgentProvisionLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelDeploymentJobsForAgent.mock.invocationCallOrder[0],
    );
    expect(mockAddDeploymentJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
  });

  it("restores the prior payload and wiring inside the shared lock when rollback enqueue fails", async () => {
    const targetConfig = { files: [], memoryFiles: [], wiring: { channels: [], integrations: [] } };
    const currentPayload = {
      files: [{ path: "SOUL.md", content: "Prior rollback payload" }],
      memoryFiles: [],
      wiring: {
        integrations: [
          {
            provider: "slack",
            catalog_id: "slack",
            config: { channel: "prior-alerts" },
            status: "needs_reconnect",
          },
        ],
        channels: [
          {
            type: "telegram",
            name: "Prior Telegram",
            config: { chat_id: "12345" },
            enabled: true,
          },
        ],
      },
    };
    const agent = {
      id: "a-rollback-compensation",
      name: "Rollback Compensation",
      status: "running",
      user_id: "owner-1",
      runtime_family: "openclaw",
      backend_type: "docker",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      sandbox_type: "standard",
      container_id: "rollback-container",
      container_name: "nora-oclaw-rollback-compensation",
      image: "nora-openclaw-agent:local",
    };
    mockGetAgentVersion.mockResolvedValueOnce({
      id: "version-2",
      versionNumber: 2,
      config: targetConfig,
    });
    mockRecordAgentVersion.mockResolvedValueOnce({
      id: "version-3",
      versionNumber: 3,
      config: targetConfig,
    });
    mockAddDeploymentJob.mockRejectedValueOnce(new Error("queue unavailable"));
    mockDb.query.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement === "SELECT * FROM agents WHERE id = $1") {
        return { rows: [agent] };
      }
      if (statement.includes("JOIN workspace_members")) {
        return { rows: [{ role: "editor" }] };
      }
      if (statement === "SELECT template_payload FROM agents WHERE id = $1") {
        return { rows: [{ template_payload: currentPayload }] };
      }
      if (statement.includes("SET status = 'queued'")) {
        return { rows: [{ id: agent.id }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const res = await editorAuth(request(app).post(`/agents/${agent.id}/rollback/version-2`));

    expect(res.status).toBe(500);
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledTimes(2);
    const compensationCallIndex = mockDb.query.mock.calls.findIndex(
      ([sql]) =>
        String(sql) === "UPDATE agents SET status = $2 WHERE id = $1 AND status = 'queued'",
    );
    expect(compensationCallIndex).toBeGreaterThanOrEqual(0);
    expect(mockDb.query.mock.invocationCallOrder[compensationCallIndex]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET template_payload = $1::jsonb WHERE id = $2",
      [JSON.stringify(targetConfig), agent.id],
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET template_payload = $1::jsonb WHERE id = $2",
      [JSON.stringify(currentPayload), agent.id],
    );
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO integrations"), [
      agent.id,
      "slack",
      "slack",
      JSON.stringify({ channel: "prior-alerts" }),
      "needs_reconnect",
    ]);
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO channels"), [
      agent.id,
      "telegram",
      "Prior Telegram",
      JSON.stringify({ chat_id: "12345" }),
      true,
    ]);
    expect(mockRecordAgentVersionBestEffort).toHaveBeenLastCalledWith(
      agent.id,
      currentPayload,
      expect.objectContaining({
        message: expect.stringContaining("restored previous config"),
        source: "rollback",
      }),
    );
    const payloadRestoreIndex = mockDb.query.mock.calls.findIndex(
      ([sql, params]) =>
        String(sql) === "UPDATE agents SET template_payload = $1::jsonb WHERE id = $2" &&
        params?.[0] === JSON.stringify(currentPayload),
    );
    expect(payloadRestoreIndex).toBeGreaterThanOrEqual(0);
    expect(mockDb.query.mock.invocationCallOrder[payloadRestoreIndex]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("agent deletion routes", () => {
  function deleteRequest(method, agentId) {
    return method === "post"
      ? request(app).post(`/agents/${agentId}/delete`)
      : request(app).delete(`/agents/${agentId}`);
  }

  it.each([
    ["POST /agents/:id/delete", "post"],
    ["DELETE /agents/:id", "delete"],
  ])(
    "%s rejects a visible non-owner before acquiring the provision lock",
    async (_route, method) => {
      const agentId = `a-visible-non-owner-${method}`;
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ id: agentId, container_id: null, user_id: "owner-2" }],
        })
        .mockResolvedValueOnce({ rows: [{ role: "viewer" }] });

      const res = await auth(deleteRequest(method, agentId));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/direct agent owner/i);
      expect(mockAcquireAgentProvisionLock).not.toHaveBeenCalled();
      expect(mockCancelDeploymentJobsForAgent).not.toHaveBeenCalled();
      expect(mockAgentProvisionLockRelease).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["POST /agents/:id/delete", "post"],
    ["DELETE /agents/:id", "delete"],
  ])(
    "%s destroys the authoritative placement while holding the provision lock",
    async (_route, method) => {
      const agentId = `a-delete-race-${method}`;
      const staleLocalAgent = {
        id: agentId,
        name: "Delete Race",
        user_id: "user-1",
        runtime_family: "openclaw",
        backend_type: "docker",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        container_id: "stale-local-runtime",
        container_name: "nora-oclaw-stale-local-runtime",
      };
      const authoritativeRemoteAgent = {
        ...staleLocalAgent,
        backend_type: "remote-docker",
        deploy_target: "remote-docker",
        execution_target_id: "remote:build-host",
        container_id: "authoritative-remote-runtime",
        container_name: "nora-oclaw-authoritative-remote-runtime",
      };
      mockDb.query
        .mockResolvedValueOnce({ rows: [staleLocalAgent] })
        .mockResolvedValueOnce({ rows: [authoritativeRemoteAgent] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await auth(deleteRequest(method, agentId));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("success", true);
      expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith(agentId, {
        applicationName: "nora-backend-agent-delete",
      });
      expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledWith(agentId);
      expect(require("../containerManager").destroy).toHaveBeenCalledWith(
        expect.objectContaining(authoritativeRemoteAgent),
      );
      expect(mockAcquireAgentProvisionLock.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.query.mock.invocationCallOrder[1],
      );
      expect(require("../containerManager").destroy.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.query.mock.invocationCallOrder[2],
      );
      expect(mockDb.query.mock.invocationCallOrder[2]).toBeLessThan(
        mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
      );
      expect(mockDb.query).toHaveBeenLastCalledWith("DELETE FROM agents WHERE id = $1", [agentId]);
    },
  );

  it.each([
    ["POST /agents/:id/delete", "post"],
    ["DELETE /agents/:id", "delete"],
  ])(
    "%s rejects an API key when the in-lock placement became Remote Docker",
    async (_route, method) => {
      authorizeWorkspaceApiKey();
      const agentId = `a-api-key-delete-race-${method}`;
      const staleLocalAgent = {
        id: agentId,
        name: "API Key Delete Race",
        user_id: "user-1",
        runtime_family: "openclaw",
        backend_type: "docker",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        container_id: "stale-local-runtime",
      };
      const authoritativeRemoteAgent = {
        ...staleLocalAgent,
        backend_type: "remote-docker",
        deploy_target: "remote-docker",
        execution_target_id: "remote:session-only-host",
        container_id: "remote-runtime",
      };
      mockDb.query
        // Global API-key path guard.
        .mockResolvedValueOnce({ rows: [staleLocalAgent] })
        // Pre-lock visibility check.
        .mockResolvedValueOnce({ rows: [staleLocalAgent] })
        // Authoritative reload after waiting for the provision lock.
        .mockResolvedValueOnce({ rows: [authoritativeRemoteAgent] });

      const res = await workspaceApiKeyAuth(deleteRequest(method, agentId));

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "session_required" });
      expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith(agentId, {
        applicationName: "nora-backend-agent-delete",
      });
      expect(mockCancelDeploymentJobsForAgent).not.toHaveBeenCalled();
      expect(require("../containerManager").destroy).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(3);
      expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the agent record when its pending deployment jobs cannot be cancelled", async () => {
    mockCancelDeploymentJobsForAgent.mockRejectedValueOnce(new Error("Redis unavailable"));
    const agent = {
      id: "a-queued",
      container_id: null,
      user_id: "user-1",
      status: "queued",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(request(app).delete("/agents/a-queued"));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it("rechecks direct ownership after acquiring the provision lock", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "a-shared", container_id: null, user_id: "user-1" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "a-shared", container_id: null, user_id: "owner-2" }],
      })
      .mockResolvedValueOnce({ rows: [{ role: "admin" }] });

    const res = await auth(request(app).post("/agents/a-shared/delete"));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/direct agent owner/i);
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith("a-shared", {
      applicationName: "nora-backend-agent-delete",
    });
    expect(mockCancelDeploymentJobsForAgent).not.toHaveBeenCalled();
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it("destroys Kubernetes resources by container_name before deleting a stale local record", async () => {
    const containerManager = require("../containerManager");
    const agent = {
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
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [agent] })
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
    const agent = {
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
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(request(app).delete("/agents/a-k8s-delete-fail"));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Kubernetes API unreachable/i);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it("keeps a Proxmox agent record when runtime cleanup fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.destroy.mockRejectedValueOnce(new Error("Proxmox destroy task failed"));
    const agent = {
      id: "a-proxmox-delete-fail",
      name: "Proxmox Delete Fail",
      user_id: "user-1",
      runtime_family: "openclaw",
      backend_type: "proxmox",
      deploy_target: "proxmox",
      execution_target_id: "proxmox",
      sandbox_profile: "standard",
      container_id: "302",
    };
    mockDb.query.mockResolvedValueOnce({ rows: [agent] }).mockResolvedValueOnce({ rows: [agent] });

    const res = await auth(request(app).delete("/agents/a-proxmox-delete-fail"));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Proxmox destroy task failed/i);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for non-existent agent", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await auth(request(app).post("/agents/missing/delete"));
    expect(res.status).toBe(404);
    expect(mockAcquireAgentProvisionLock).not.toHaveBeenCalled();
  });
});
