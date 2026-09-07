// @ts-nocheck
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
const mockAddDeploymentJob = jest.fn();
const mockCancelDeploymentJobsForAgent = jest.fn();
const mockAddKubernetesPolicyReconcileJob = jest.fn();
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
const mockGetSystemBanner = jest.fn().mockResolvedValue({
  enabled: false,
  severity: "warning",
  title: "",
  message: "",
  featureEnabled: false,
  active: false,
});
const mockUpdateSystemBanner = jest.fn().mockResolvedValue({
  enabled: false,
  severity: "warning",
  title: "",
  message: "",
  featureEnabled: false,
  active: false,
});
const mockGetLanguageSettings = jest.fn().mockResolvedValue({
  defaultLocale: "en",
  supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
});
const mockUpdateLanguageSettings = jest.fn().mockResolvedValue({
  defaultLocale: "es",
  supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
});
const mockGetAgentHubSettings = jest.fn().mockResolvedValue({
  defaultShareTarget: "both",
  url: "https://nora.test",
  envUrl: "https://nora.test",
  sourceApiKeyConfigured: false,
  sourceApiKeySource: "none",
  sourceApiKeyMasked: "",
});
const mockUpdateAgentHubSettings = jest.fn().mockResolvedValue({
  defaultShareTarget: "internal",
  url: "https://hub.nora.test",
  envUrl: "https://hub.nora.test",
  sourceApiKeyConfigured: true,
  sourceApiKeySource: "database",
  sourceApiKeyMasked: "nora_hub...test",
});
const mockDockerCreateVolume = jest.fn();
const mockDockerPull = jest.fn();
const mockDockerFollowProgress = jest.fn();
const mockDockerCreateContainer = jest.fn();
const mockDockerContainerStart = jest.fn();
const mockDockerPing = jest.fn();
const mockDockerGetContainer = jest.fn();
const mockDockerContainerInspect = jest.fn();
const mockAssertKubernetesExecutionTargetAvailable = jest.fn().mockResolvedValue();
const mockAssertRemoteHostExecutionTargetAvailable = jest.fn().mockResolvedValue();
const mockPersistLifecycleRuntimeAddress = jest.fn();
const mockSyncAuthToUserAgents = jest.fn();
const mockResumeAgentWithProviderAuth = jest.fn();
const mockAgentProvisionLockRelease = jest.fn();
const mockAcquireAgentProvisionLock = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: mockAddDeploymentJob,
  cancelDeploymentJobsForAgent: mockCancelDeploymentJobsForAgent,
  addKubernetesPolicyReconcileJob: mockAddKubernetesPolicyReconcileJob,
  getDLQJobs: mockGetDLQJobs,
  retryDLQJob: mockRetryDLQJob,
}));
jest.mock("../agentProvisionLock", () => ({
  ...jest.requireActual("../agentProvisionLock"),
  acquireAgentProvisionLock: mockAcquireAgentProvisionLock,
}));
jest.mock("../authSync", () => ({
  ...jest.requireActual("../authSync"),
  syncAuthToUserAgents: mockSyncAuthToUserAgents,
  resumeAgentWithProviderAuth: mockResumeAgentWithProviderAuth,
}));
jest.mock("../kubernetesClusters", () => ({
  assertKubernetesExecutionTargetAvailable: mockAssertKubernetesExecutionTargetAvailable,
  listKubernetesExecutionTargets: jest.fn().mockResolvedValue([]),
  listKubernetesClusters: jest.fn().mockResolvedValue([]),
  getKubernetesClusterPolicySettings: jest.fn(),
  updateKubernetesClusterPolicySettings: jest.fn(),
}));
jest.mock("../remoteHosts", () => ({
  ...jest.requireActual("../remoteHosts"),
  assertRemoteHostExecutionTargetAvailable: mockAssertRemoteHostExecutionTargetAvailable,
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
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
  stats: jest.fn(),
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
  listAdminListings: jest.fn().mockResolvedValue([]),
  listReports: jest.fn().mockResolvedValue([]),
  resolveReport: jest.fn(),
  setListingStatus: jest.fn(),
  recordInstall: jest.fn(),
  recordDownload: jest.fn(),
  createReport: jest.fn(),
  getPlatformListingByTemplateKey: jest.fn(),
  updateCentralShareStatus: jest.fn(),
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
  listAgentCandidates: jest.fn().mockResolvedValue([]),
  removeAgent: jest.fn(),
  listAccessibleAgents: jest.fn().mockResolvedValue([]),
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
  getSubscription: jest.fn().mockResolvedValue({
    plan: "selfhosted",
    status: "active",
    agent_limit: 3,
    agent_limit_override: null,
    base_agent_limit: 3,
    agent_limit_source: "default",
    is_unlimited: false,
  }),
  normalizeAgentLimitOverride: jest.fn((value) =>
    Number.isInteger(value) && value >= 0 ? value : null,
  ),
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
    getSystemBanner: mockGetSystemBanner,
    getLanguageSettings: mockGetLanguageSettings,
    getAgentHubSettings: mockGetAgentHubSettings,
    updateDeploymentDefaults: mockUpdateDeploymentDefaults,
    updateSystemBanner: mockUpdateSystemBanner,
    updateLanguageSettings: mockUpdateLanguageSettings,
    updateAgentHubSettings: mockUpdateAgentHubSettings,
  };
});
jest.mock("dockerode", () =>
  jest.fn().mockImplementation(() => ({
    createVolume: mockDockerCreateVolume,
    pull: mockDockerPull,
    modem: {
      followProgress: mockDockerFollowProgress,
    },
    createContainer: mockDockerCreateContainer,
    ping: mockDockerPing,
    getContainer: mockDockerGetContainer,
  })),
);

const app = require("../server");
const { normalizeHealthcheckBudget } = require("../releaseUpgrade");

const adminToken = jwt.sign(
  { id: "admin-1", email: "admin@nora.test", role: "admin" },
  JWT_SECRET,
  {
    expiresIn: "1h",
  },
);
const userToken = jwt.sign({ id: "user-1", email: "user@nora.test", role: "user" }, JWT_SECRET, {
  expiresIn: "1h",
});

const RELEASE_ENV_KEYS = [
  "NORA_CURRENT_VERSION",
  "NORA_CURRENT_COMMIT",
  "NORA_BUILD_COMMIT",
  "GIT_SHA",
  "NORA_GITHUB_REPO",
  "NORA_RELEASE_REPO",
  "NORA_RELEASE_CACHE_TTL_MS",
  "NORA_LATEST_VERSION",
  "NORA_LATEST_PUBLISHED_AT",
  "NORA_RELEASE_NOTES_URL",
  "NORA_LATEST_SEVERITY",
  "NORA_UPGRADE_REQUIRED",
  "NORA_AUTO_UPGRADE_ENABLED",
  "NORA_HOST_REPO_DIR",
  "NORA_UPGRADE_REPO",
  "NORA_UPGRADE_REF",
  "NORA_UPGRADE_RUNNER_IMAGE",
  "NORA_UPGRADE_STATE_VOLUME",
  "NORA_UPGRADE_STATE_DIR",
  "NORA_ENV_FILE",
  "NORA_UPGRADE_COMPOSE_FILES",
  "NORA_UPGRADE_PUBLIC_HEALTH_URL",
  "NORA_UPGRADE_HEALTHCHECK_ATTEMPTS",
  "NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS",
  "NORA_UPGRADE_LOG_TAIL_LINES",
  "NORA_INSTALL_METHOD",
  "NORA_MANUAL_UPGRADE_COMMAND",
  "NORA_MANUAL_UPGRADE_STEPS",
];

function withToken(req, token) {
  return req.set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockReset();
  mockAddDeploymentJob.mockReset();
  mockCancelDeploymentJobsForAgent.mockReset().mockResolvedValue({ removed: 0, active: 0 });
  mockAgentProvisionLockRelease.mockReset().mockResolvedValue(undefined);
  mockAcquireAgentProvisionLock.mockReset().mockResolvedValue({
    release: mockAgentProvisionLockRelease,
  });
  mockAddKubernetesPolicyReconcileJob.mockReset();
  mockGetDLQJobs.mockReset();
  mockRetryDLQJob.mockReset();
  mockBuildAgentStatsResponse.mockReset();
  mockBuildAgentHistoryResponse.mockReset();
  mockDockerCreateVolume.mockReset().mockResolvedValue({});
  mockDockerPull.mockReset().mockImplementation((_image, callback) => callback(null, {}));
  mockDockerFollowProgress.mockReset().mockImplementation((_stream, callback) => callback(null));
  mockDockerContainerStart.mockReset().mockResolvedValue({});
  mockDockerCreateContainer.mockReset().mockResolvedValue({
    id: "runner-1",
    start: mockDockerContainerStart,
  });
  mockDockerPing.mockReset().mockImplementation((callback) => callback(null));
  mockDockerContainerInspect.mockReset().mockResolvedValue({ Config: { Labels: {} } });
  mockDockerGetContainer.mockReset().mockReturnValue({ inspect: mockDockerContainerInspect });
  mockAssertRemoteHostExecutionTargetAvailable.mockReset().mockResolvedValue(undefined);
  mockPersistLifecycleRuntimeAddress.mockReset().mockImplementation(async (_db, agent, result) => {
    const host = typeof result?.host === "string" ? result.host.trim() : "";
    const runtimeHost = typeof result?.runtimeHost === "string" ? result.runtimeHost.trim() : host;
    if (host) agent.host = host;
    if (runtimeHost) agent.runtime_host = runtimeHost;
    return agent;
  });
  mockSyncAuthToUserAgents
    .mockReset()
    .mockImplementation(async (_userId, agentId) => [{ agentId, status: "synced" }]);
  mockResumeAgentWithProviderAuth.mockReset().mockImplementation(async (agent) => ({
    agent: { ...agent, status: "running", paused_reason: null },
    lifecycleResult: null,
    syncResult: { agentId: agent.id, status: "synced" },
  }));
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
  mockGetSystemBanner.mockReset().mockResolvedValue({
    enabled: false,
    severity: "warning",
    title: "",
    message: "",
    featureEnabled: false,
    active: false,
  });
  mockUpdateSystemBanner.mockReset().mockResolvedValue({
    enabled: false,
    severity: "warning",
    title: "",
    message: "",
    featureEnabled: false,
    active: false,
  });
  mockGetLanguageSettings.mockReset().mockResolvedValue({
    defaultLocale: "en",
    supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
  });
  mockUpdateLanguageSettings.mockReset().mockResolvedValue({
    defaultLocale: "es",
    supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
  });
  mockGetAgentHubSettings.mockReset().mockResolvedValue({
    defaultShareTarget: "both",
    url: "https://nora.test",
    envUrl: "https://nora.test",
    sourceApiKeyConfigured: false,
    sourceApiKeySource: "none",
    sourceApiKeyMasked: "",
  });
  mockUpdateAgentHubSettings.mockReset().mockResolvedValue({
    defaultShareTarget: "both",
    url: "https://nora.test",
    envUrl: "https://nora.test",
    sourceApiKeyConfigured: false,
    sourceApiKeySource: "none",
    sourceApiKeyMasked: "",
  });
  delete process.env.ENABLED_BACKENDS;
  delete process.env.ENABLED_RUNTIME_FAMILIES;
  delete process.env.ENABLED_SANDBOX_PROFILES;
  RELEASE_ENV_KEYS.forEach((key) => delete process.env[key]);
  process.env.NORA_UPGRADE_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "nora-release-upgrade-"),
  );
  delete global.fetch;
});

describe("admin routes", () => {
  it("rejects non-admin access to /admin/agents", async () => {
    const res = await withToken(request(app).get("/admin/agents"), userToken);
    expect(res.status).toBe(403);
  });

  it("returns Kubernetes policy settings for admins", async () => {
    const kubernetesClustersModule = require("../kubernetesClusters");
    kubernetesClustersModule.getKubernetesClusterPolicySettings.mockResolvedValueOnce({
      id: "aks-eastus2",
      label: "AKS East US 2",
      policySettings: {
        ingressRules: {
          openclaw: [
            {
              id: "rule-1",
              cidr: "203.0.113.10/32",
              ports: [18789, 9090],
              description: "corp vpn",
            },
          ],
          hermes: [],
        },
      },
      policySettingsStatus: {
        state: "queued",
        desiredHash: "hash-1",
      },
      customPolicyConfigured: true,
      customIngressConfigured: true,
      customPolicyApplied: false,
      customPolicyState: "queued",
      customPolicyDesiredHash: "hash-1",
      supportsNetworkPolicy: true,
      policyEngine: "cilium",
    });

    const res = await withToken(
      request(app).get("/admin/kubernetes-clusters/aks-eastus2/policy-settings"),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(res.body.policySettings.ingressRules.openclaw).toHaveLength(1);
    expect(res.body.policySettingsStatus).toEqual({
      state: "queued",
      desiredHash: "hash-1",
    });
    expect(kubernetesClustersModule.getKubernetesClusterPolicySettings).toHaveBeenCalledWith(
      "aks-eastus2",
    );
  });

  it("updates Kubernetes policy settings, seeds queued status, and enqueues reconcile", async () => {
    const kubernetesClustersModule = require("../kubernetesClusters");
    const monitoringModule = require("../monitoring");
    kubernetesClustersModule.updateKubernetesClusterPolicySettings.mockResolvedValueOnce({
      id: "aks-eastus2",
      label: "AKS East US 2",
      policySettings: {
        ingressRules: {
          openclaw: [
            {
              id: "rule-1",
              cidr: "203.0.113.10/32",
              ports: [18789, 9090],
              description: "corp vpn",
            },
          ],
          hermes: [],
        },
      },
      policySettingsStatus: {
        state: "queued",
        desiredHash: "hash-queued",
      },
      customPolicyConfigured: true,
      customIngressConfigured: true,
      customPolicyApplied: false,
      customPolicyState: "queued",
      customPolicyDesiredHash: "hash-queued",
    });

    const res = await withToken(
      request(app)
        .put("/admin/kubernetes-clusters/aks-eastus2/policy-settings")
        .send({
          ingressRules: {
            openclaw: [
              {
                cidr: "203.0.113.10/32",
                ports: [9090, 18789, 9090],
                description: "corp vpn",
              },
            ],
          },
        }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(kubernetesClustersModule.updateKubernetesClusterPolicySettings).toHaveBeenCalledWith(
      "aks-eastus2",
      {
        ingressRules: {
          openclaw: [
            {
              cidr: "203.0.113.10/32",
              ports: [9090, 18789, 9090],
              description: "corp vpn",
            },
          ],
        },
      },
    );
    expect(mockAddKubernetesPolicyReconcileJob).toHaveBeenCalledWith({
      clusterId: "aks-eastus2",
      desiredHash: "hash-queued",
    });
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_kubernetes_cluster_policy_settings_updated",
      expect.stringContaining("AKS East US 2"),
      expect.any(Object),
    );
    expect(res.body.customPolicyState).toBe("queued");
  });

  it("surfaces Kubernetes policy-settings validation errors", async () => {
    const kubernetesClustersModule = require("../kubernetesClusters");
    const error = new Error("openclaw ingress rules may only target ports 18789 and 9090.");
    error.statusCode = 400;
    kubernetesClustersModule.updateKubernetesClusterPolicySettings.mockRejectedValueOnce(error);

    const res = await withToken(
      request(app)
        .put("/admin/kubernetes-clusters/aks-eastus2/policy-settings")
        .send({
          ingressRules: {
            openclaw: [{ cidr: "203.0.113.10/32", ports: [8080] }],
          },
        }),
      adminToken,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/18789 and 9090/);
    expect(mockAddKubernetesPolicyReconcileJob).not.toHaveBeenCalled();
  });

  it("returns deployment defaults for admins", async () => {
    mockGetDeploymentDefaults.mockResolvedValueOnce({
      vcpu: 1,
      ram_mb: 1024,
      disk_gb: 10,
    });

    const res = await withToken(
      request(app).get("/admin/settings/deployment-defaults"),
      adminToken,
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
      adminToken,
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
      }),
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_deployment_defaults_updated",
      expect.stringContaining("2 vCPU / 2048 MB RAM / 20 GB disk"),
      expect.any(Object),
    );
  });

  it("returns the system banner settings for admins", async () => {
    mockGetSystemBanner.mockResolvedValueOnce({
      enabled: true,
      severity: "warning",
      title: "Testing warning",
      message: "This control plane resets nightly.",
      featureEnabled: true,
      active: true,
    });

    const res = await withToken(request(app).get("/admin/settings/system-banner"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      severity: "warning",
      title: "Testing warning",
      message: "This control plane resets nightly.",
      featureEnabled: true,
      active: true,
    });
  });

  it("updates the system banner for admins", async () => {
    const monitoringModule = require("../monitoring");
    mockGetSystemBanner.mockResolvedValueOnce({
      enabled: false,
      severity: "warning",
      title: "",
      message: "",
      featureEnabled: true,
      active: false,
    });
    mockUpdateSystemBanner.mockResolvedValueOnce({
      enabled: true,
      severity: "critical",
      title: "Testing warning",
      message: "Do not use this environment for production work.",
      featureEnabled: true,
      active: true,
    });

    const res = await withToken(
      request(app).put("/admin/settings/system-banner").send({
        enabled: true,
        severity: "critical",
        title: "Testing warning",
        message: "Do not use this environment for production work.",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      severity: "critical",
      title: "Testing warning",
      message: "Do not use this environment for production work.",
      featureEnabled: true,
      active: true,
    });
    expect(mockUpdateSystemBanner).toHaveBeenCalledWith({
      enabled: true,
      severity: "critical",
      title: "Testing warning",
      message: "Do not use this environment for production work.",
    });
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_system_banner_updated",
      expect.stringContaining("system banner"),
      expect.any(Object),
    );
  });

  it("returns the platform language settings for admins", async () => {
    mockGetLanguageSettings.mockResolvedValueOnce({
      defaultLocale: "fr",
      supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    });

    const res = await withToken(request(app).get("/admin/settings/language"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaultLocale: "fr",
      supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    });
  });

  it("updates the platform language settings for admins", async () => {
    const monitoringModule = require("../monitoring");
    mockGetLanguageSettings.mockResolvedValueOnce({
      defaultLocale: "en",
      supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    });
    mockUpdateLanguageSettings.mockResolvedValueOnce({
      defaultLocale: "es",
      supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    });

    const res = await withToken(
      request(app).put("/admin/settings/language").send({
        defaultLocale: "es",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockUpdateLanguageSettings).toHaveBeenCalledWith({
      defaultLocale: "es",
    });
    expect(res.body).toEqual({
      defaultLocale: "es",
      supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    });
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_language_settings_updated",
      expect.stringContaining("default language"),
      expect.any(Object),
    );
  });

  it("returns the Agent Hub sharing settings for admins", async () => {
    mockGetAgentHubSettings.mockResolvedValueOnce({
      defaultShareTarget: "both",
      url: "https://norafleet.ai",
      envUrl: "https://norafleet.ai",
      sourceApiKeyConfigured: true,
      sourceApiKeySource: "env",
      sourceApiKeyMasked: "nora_hub...test",
    });

    const res = await withToken(request(app).get("/admin/settings/agent-hub"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaultShareTarget: "both",
      url: "https://norafleet.ai",
      envUrl: "https://norafleet.ai",
      sourceApiKeyConfigured: true,
      sourceApiKeySource: "env",
      sourceApiKeyMasked: "nora_hub...test",
    });
  });

  it("updates the Agent Hub sharing settings for admins", async () => {
    const monitoringModule = require("../monitoring");
    mockGetAgentHubSettings.mockResolvedValueOnce({
      defaultShareTarget: "both",
      url: "https://norafleet.ai",
      envUrl: "https://norafleet.ai",
    });
    mockUpdateAgentHubSettings.mockResolvedValueOnce({
      defaultShareTarget: "internal",
      url: "https://hub.internal.test",
      envUrl: "https://norafleet.ai",
      sourceApiKeyConfigured: true,
      sourceApiKeySource: "database",
      sourceApiKeyMasked: "nora_hub...prod",
    });

    const res = await withToken(
      request(app).put("/admin/settings/agent-hub").send({
        defaultShareTarget: "internal",
        url: "https://hub.internal.test",
        sourceApiKey: "nora_hub_prod",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockUpdateAgentHubSettings).toHaveBeenCalledWith({
      defaultShareTarget: "internal",
      url: "https://hub.internal.test",
      sourceApiKey: "nora_hub_prod",
    });
    expect(res.body).toEqual(
      expect.objectContaining({
        defaultShareTarget: "internal",
        url: "https://hub.internal.test",
      }),
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_agent_hub_settings_updated",
      expect.stringContaining("Agent Hub"),
      expect.any(Object),
    );
  });

  it("returns release upgrade status for admins when one-click upgrade is disabled", async () => {
    const res = await withToken(request(app).get("/admin/release-upgrade"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        autoUpgrade: expect.objectContaining({
          enabled: false,
          available: false,
          mode: "github_direct",
          disabledReason: expect.stringContaining("NORA_AUTO_UPGRADE_ENABLED=true"),
        }),
        runnerReachable: true,
        job: null,
        logTail: [],
      }),
    );
    expect(res.body.release).toEqual(
      expect.objectContaining({
        canAutoUpgrade: false,
        autoUpgrade: expect.objectContaining({
          enabled: false,
          available: false,
        }),
      }),
    );
  });

  it("marks direct GitHub release upgrade unavailable without a host repo path", async () => {
    process.env.NORA_CURRENT_VERSION = "1.0.0";
    process.env.NORA_LATEST_VERSION = "1.1.0";
    process.env.NORA_AUTO_UPGRADE_ENABLED = "true";

    const res = await withToken(request(app).get("/admin/release-upgrade"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        autoUpgrade: expect.objectContaining({
          enabled: true,
          available: false,
          mode: "github_direct",
          disabledReason: expect.stringContaining("NORA_HOST_REPO_DIR"),
        }),
        runnerReachable: true,
      }),
    );
  });

  it("returns direct GitHub release upgrade preflight checks for admins", async () => {
    process.env.NORA_CURRENT_VERSION = "1.0.0";
    process.env.NORA_LATEST_VERSION = "1.1.0";
    process.env.NORA_AUTO_UPGRADE_ENABLED = "true";
    process.env.NORA_HOST_REPO_DIR = "/srv/nora";
    process.env.NORA_UPGRADE_COMPOSE_FILES =
      "docker-compose.yml:infra/docker-compose.public-tls.yml:docker-compose.kubernetes.yml";

    const res = await withToken(request(app).get("/admin/release-upgrade/preflight"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        command:
          "docker compose --env-file .env -f docker-compose.yml -f infra/docker-compose.public-tls.yml -f docker-compose.kubernetes.yml up -d --build",
        config: expect.objectContaining({
          hostRepoDir: "/srv/nora",
          envFile: ".env",
          composeFiles: [
            "docker-compose.yml",
            "infra/docker-compose.public-tls.yml",
            "docker-compose.kubernetes.yml",
          ],
        }),
        checks: expect.arrayContaining([
          expect.objectContaining({ id: "auto_upgrade_enabled", status: "pass" }),
          expect.objectContaining({ id: "target_release", status: "pass" }),
          expect.objectContaining({ id: "docker_socket", status: "pass" }),
        ]),
      }),
    );
  });

  it("rejects direct GitHub release upgrade repos with embedded credentials", async () => {
    process.env.NORA_CURRENT_VERSION = "1.0.0";
    process.env.NORA_LATEST_VERSION = "1.1.0";
    process.env.NORA_AUTO_UPGRADE_ENABLED = "true";
    process.env.NORA_HOST_REPO_DIR = "/srv/nora";
    process.env.NORA_UPGRADE_REPO = "https://token@github.com/solomon2773/nora.git";

    const res = await withToken(request(app).get("/admin/release-upgrade"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body.autoUpgrade).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        mode: "github_direct",
        disabledReason: expect.stringContaining("public HTTPS GitHub repository URL"),
      }),
    );
    expect(res.body.runnerReachable).toBe(true);
  });

  it("uses the migration-aware release upgrade health-check defaults", () => {
    const warn = jest.fn();

    expect(normalizeHealthcheckBudget({}, warn)).toEqual({
      attempts: 221,
      intervalSeconds: 3,
      firstToFinalWindowSeconds: 660,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("upgrades the former 40x3 built-in health-check budget", () => {
    const warn = jest.fn();

    expect(
      normalizeHealthcheckBudget(
        {
          NORA_UPGRADE_HEALTHCHECK_ATTEMPTS: "40",
          NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS: "3",
        },
        warn,
      ),
    ).toEqual({
      attempts: 221,
      intervalSeconds: 3,
      firstToFinalWindowSeconds: 660,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves valid release upgrade health-check overrides", () => {
    const warn = jest.fn();

    expect(
      normalizeHealthcheckBudget(
        {
          NORA_UPGRADE_HEALTHCHECK_ATTEMPTS: "101",
          NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS: "6",
        },
        warn,
      ),
    ).toEqual({
      attempts: 101,
      intervalSeconds: 6,
      firstToFinalWindowSeconds: 600,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back safely for invalid or over-budget release upgrade health checks", () => {
    const warn = jest.fn();
    const defaults = {
      attempts: 221,
      intervalSeconds: 3,
      firstToFinalWindowSeconds: 660,
    };

    expect(
      normalizeHealthcheckBudget(
        {
          NORA_UPGRADE_HEALTHCHECK_ATTEMPTS: "not-a-number",
          NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS: "3",
        },
        warn,
      ),
    ).toEqual(defaults);
    expect(
      normalizeHealthcheckBudget(
        {
          NORA_UPGRADE_HEALTHCHECK_ATTEMPTS: "1302",
          NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS: "3",
        },
        warn,
      ),
    ).toEqual(defaults);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("no greater than 3900s"));
  });

  it("starts a direct GitHub release upgrade runner for admins", async () => {
    const monitoringModule = require("../monitoring");
    process.env.NORA_CURRENT_VERSION = "1.0.0";
    process.env.NORA_LATEST_VERSION = "1.1.0";
    process.env.NORA_RELEASE_NOTES_URL = "https://nora.test/releases/1.1.0";
    process.env.NORA_AUTO_UPGRADE_ENABLED = "true";
    process.env.NORA_HOST_REPO_DIR = "/srv/nora";
    process.env.NORA_UPGRADE_REPO = "https://github.com/solomon2773/nora.git";
    process.env.NORA_UPGRADE_REF = "master";
    process.env.NORA_UPGRADE_RUNNER_IMAGE = "docker:29-cli";
    process.env.NORA_ENV_FILE = "deploy.env";
    process.env.NORA_UPGRADE_COMPOSE_FILES =
      "docker-compose.yml:infra/docker-compose.public-tls.yml:docker-compose.kubernetes.yml";
    process.env.NORA_UPGRADE_PUBLIC_HEALTH_URL = "https://nora.test/api/health";

    const res = await withToken(request(app).post("/admin/release-upgrade"), adminToken);

    expect(res.status).toBe(202);
    expect(mockDockerCreateVolume).toHaveBeenCalledWith({ Name: "nora_upgrade_state" });
    expect(mockDockerPull).toHaveBeenCalledWith("docker:29-cli", expect.any(Function));
    expect(mockDockerCreateContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: "docker:29-cli",
        Env: expect.arrayContaining([
          "NORA_UPGRADE_REPO=https://github.com/solomon2773/nora.git",
          "NORA_UPGRADE_REF=master",
          "NORA_UPGRADE_TARGET_VERSION=1.1.0",
          "NORA_HOST_REPO_DIR=/srv/nora",
          "NORA_ENV_FILE=deploy.env",
          "NORA_UPGRADE_COMPOSE_FILES=docker-compose.yml:infra/docker-compose.public-tls.yml:docker-compose.kubernetes.yml",
          "NORA_UPGRADE_HEALTHCHECK_ATTEMPTS=221",
          "NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS=3",
          "NORA_UPGRADE_PUBLIC_HEALTH_URL=https://nora.test/api/health",
        ]),
        Cmd: expect.arrayContaining([
          "sh",
          "-c",
          expect.stringContaining("infra/run-release-upgrade.sh"),
        ]),
        WorkingDir: "/srv/nora",
        HostConfig: expect.objectContaining({
          Binds: expect.arrayContaining([
            "/srv/nora:/srv/nora",
            "/var/run/docker.sock:/var/run/docker.sock",
            "nora_upgrade_state:/var/lib/nora-upgrade",
          ]),
        }),
      }),
    );
    expect(mockDockerContainerStart).toHaveBeenCalled();
    expect(res.body).toEqual(
      expect.objectContaining({
        runnerReachable: true,
        job: expect.objectContaining({
          phase: "queued",
          targetVersion: "1.1.0",
          containerId: "runner-1",
          sourceRepo: "https://github.com/solomon2773/nora.git",
          envFile: "deploy.env",
          composeFiles: [
            "docker-compose.yml",
            "infra/docker-compose.public-tls.yml",
            "docker-compose.kubernetes.yml",
          ],
          command:
            "docker compose --env-file deploy.env -f docker-compose.yml -f infra/docker-compose.public-tls.yml -f docker-compose.kubernetes.yml up -d --build",
        }),
        logTail: expect.arrayContaining([expect.stringContaining("Queued direct GitHub upgrade")]),
      }),
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_release_upgrade_started",
      expect.stringContaining("1.1.0"),
      expect.any(Object),
    );
  });

  it("does not start a release upgrade when no update is available", async () => {
    process.env.NORA_CURRENT_VERSION = "1.1.0";
    process.env.NORA_LATEST_VERSION = "1.1.0";
    process.env.NORA_AUTO_UPGRADE_ENABLED = "true";
    process.env.NORA_HOST_REPO_DIR = "/srv/nora";

    const res = await withToken(request(app).post("/admin/release-upgrade"), adminToken);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/latest announced release/i);
    expect(mockDockerCreateContainer).not.toHaveBeenCalled();
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
      adminToken,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vcpu must be an integer/i);
    expect(mockUpdateDeploymentDefaults).not.toHaveBeenCalled();
  });

  it("returns Agent Hub listings for moderation", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    agentHubStoreModule.listAdminListings.mockResolvedValueOnce([
      { id: "listing-1", name: "Community Template", status: "pending_review" },
    ]);

    const res = await withToken(request(app).get("/admin/agent-hub"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "listing-1", status: "pending_review" }),
    ]);
  });

  it("returns detailed Agent Hub listing data for admins", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    agentHubStoreModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      snapshot_id: "snapshot-1",
      name: "Community Template",
      status: "pending_review",
      source_type: "community",
      category: "Operations",
    });
    agentHubStoreModule.listReports.mockResolvedValueOnce([
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

    const res = await withToken(request(app).get("/admin/agent-hub/listing-1"), adminToken);

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
      }),
    );
  });

  it("updates Agent Hub template metadata and files for admins", async () => {
    const agentHubStoreModule = require("../agentHubStore");
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

    agentHubStoreModule.getListing.mockResolvedValueOnce(listing).mockResolvedValueOnce({
      ...listing,
      name: "Updated Template",
      description: "Updated description",
      category: "Support",
      current_version: 3,
    });
    snapshotsModule.getSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
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
    agentHubStoreModule.upsertListing.mockResolvedValueOnce({
      ...listing,
      name: "Updated Template",
      current_version: 3,
    });
    agentHubStoreModule.listReports.mockResolvedValueOnce([]);

    const res = await withToken(
      request(app)
        .patch("/admin/agent-hub/listing-1")
        .send({
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
      adminToken,
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
      }),
    );
    expect(agentHubStoreModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: "listing-1",
        category: "Support",
        currentVersion: 3,
        reviewNotes: "Reviewed and corrected",
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        name: "Updated Template",
        category: "Support",
        current_version: 3,
        snapshot: expect.objectContaining({
          templateKey: "updated-template",
        }),
      }),
    );
  });

  it("updates an Agent Hub listing status", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const monitoringModule = require("../monitoring");
    agentHubStoreModule.setListingStatus.mockResolvedValueOnce({
      id: "listing-1",
      name: "Community Template",
      status: "published",
    });
    agentHubStoreModule.getListing.mockResolvedValueOnce({
      id: "listing-1",
      name: "Community Template",
      status: "published",
      source_type: "community",
    });

    const res = await withToken(
      request(app).patch("/admin/agent-hub/listing-1/status").send({
        status: "published",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(agentHubStoreModule.setListingStatus).toHaveBeenCalledWith(
      "listing-1",
      "published",
      "admin-1",
      null,
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "agent_hub_reviewed",
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
      }),
    );
  });

  it("publishes platform Agent Hub listings as free", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const snapshotsModule = require("../snapshots");

    snapshotsModule.getSnapshot.mockResolvedValueOnce({
      id: "snapshot-1",
      name: "Platform Template",
      description: "Preset description",
      template_key: "platform-template",
    });
    agentHubStoreModule.upsertListing.mockResolvedValueOnce({
      id: "listing-1",
      name: "Platform Template",
      price: "Free",
      status: "published",
    });

    const res = await withToken(
      request(app).post("/admin/agent-hub/publish").send({
        snapshotId: "snapshot-1",
        price: "$49/mo",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(agentHubStoreModule.upsertListing).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: "snapshot-1",
        price: "Free",
        sourceType: "platform",
        status: "published",
        visibility: "public",
      }),
    );
  });

  it("returns Agent Hub reports for admins", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    agentHubStoreModule.listReports.mockResolvedValueOnce([
      { id: "report-1", listing_id: "listing-1", status: "open" },
    ]);

    const res = await withToken(request(app).get("/admin/agent-hub/reports"), adminToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: "report-1", status: "open" })]);
  });

  it("resolves Agent Hub reports", async () => {
    const agentHubStoreModule = require("../agentHubStore");
    const monitoringModule = require("../monitoring");
    agentHubStoreModule.resolveReport.mockResolvedValueOnce({
      id: "report-1",
      listing_id: "listing-1",
      status: "dismissed",
    });

    const res = await withToken(
      request(app).patch("/admin/agent-hub/reports/report-1").send({
        status: "dismissed",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(agentHubStoreModule.resolveReport).toHaveBeenCalledWith(
      "report-1",
      "admin-1",
      "dismissed",
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "agent_hub_report_resolved",
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
      }),
    );
  });

  it("returns enriched admin users with agent counts", async () => {
    const billingModule = require("../billing");

    billingModule.getSubscription.mockResolvedValueOnce({
      plan: "selfhosted",
      status: "active",
      agent_limit: null,
      agent_limit_override: null,
      base_agent_limit: null,
      agent_limit_source: "admin_default_unlimited",
      is_unlimited: true,
    });

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
        agent_limit: null,
        agent_limit_source: "admin_default_unlimited",
        is_unlimited: true,
      }),
    ]);
  });

  it("updates a user agent cap override and returns enriched user data", async () => {
    const billingModule = require("../billing");
    const monitoringModule = require("../monitoring");

    billingModule.getSubscription
      .mockResolvedValueOnce({
        plan: "selfhosted",
        status: "active",
        agent_limit: 3,
        agent_limit_override: null,
        base_agent_limit: 3,
        agent_limit_source: "default",
        is_unlimited: false,
      })
      .mockResolvedValueOnce({
        plan: "selfhosted",
        status: "active",
        agent_limit: 6,
        agent_limit_override: 6,
        base_agent_limit: 3,
        agent_limit_source: "admin_override",
        is_unlimited: false,
      });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "user-2",
            email: "target@example.com",
            name: "Target User",
            role: "user",
            agent_limit_override: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "user-2",
            email: "target@example.com",
            name: "Target User",
            role: "user",
            created_at: "2026-04-08T00:00:00.000Z",
            agent_limit_override: 6,
            agentCount: 2,
            subscriptionPlan: null,
            subscriptionStatus: null,
          },
        ],
      });
    const res = await withToken(
      request(app).put("/admin/users/user-2/agent-limit").send({ agent_limit_override: 6 }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: "user-2",
        agent_limit: 6,
        agent_limit_override: 6,
        base_agent_limit: 3,
        agent_limit_source: "admin_override",
      }),
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_user_agent_limit_updated",
      expect.stringContaining("to 6"),
      expect.objectContaining({
        user: expect.objectContaining({
          id: "user-2",
          email: "target@example.com",
        }),
        result: expect.objectContaining({
          previousAgentLimit: 3,
          nextAgentLimit: 6,
          nextAgentLimitSource: "admin_override",
        }),
      }),
    );
  });

  it("clears a user agent cap override", async () => {
    const billingModule = require("../billing");
    const monitoringModule = require("../monitoring");

    billingModule.getSubscription
      .mockResolvedValueOnce({
        plan: "selfhosted",
        status: "active",
        agent_limit: 7,
        agent_limit_override: 7,
        base_agent_limit: 3,
        agent_limit_source: "admin_override",
        is_unlimited: false,
      })
      .mockResolvedValueOnce({
        plan: "selfhosted",
        status: "active",
        agent_limit: 3,
        agent_limit_override: null,
        base_agent_limit: 3,
        agent_limit_source: "default",
        is_unlimited: false,
      });

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "user-3",
            email: "clear@example.com",
            name: "Clear User",
            role: "user",
            agent_limit_override: 7,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "user-3",
            email: "clear@example.com",
            name: "Clear User",
            role: "user",
            created_at: "2026-04-08T00:00:00.000Z",
            agent_limit_override: null,
            agentCount: 4,
            subscriptionPlan: null,
            subscriptionStatus: null,
          },
        ],
      });

    const res = await withToken(
      request(app).put("/admin/users/user-3/agent-limit").send({ agent_limit_override: null }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        agent_limit: 3,
        agent_limit_override: null,
        agent_limit_source: "default",
      }),
    );
    expect(monitoringModule.logEvent).toHaveBeenCalledWith(
      "admin_user_agent_limit_updated",
      expect.stringContaining("cleared"),
      expect.any(Object),
    );
  });

  it("rejects invalid agent cap overrides", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "user-4",
          email: "invalid@example.com",
          name: "Invalid User",
          role: "user",
          agent_limit_override: null,
        },
      ],
    });

    const res = await withToken(
      request(app).put("/admin/users/user-4/agent-limit").send({ agent_limit_override: -1 }),
      adminToken,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/0 or greater/i);
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
      adminToken,
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
      }),
    );
  });

  it("logs rejected admin mutations with error detail", async () => {
    const monitoringModule = require("../monitoring");

    const res = await withToken(
      request(app).put("/admin/users/user-2/role").send({ role: "superadmin" }),
      adminToken,
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
      }),
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
      }),
    );
  });

  it.each(["provider_auth_reconciliation_pending", "provider_auth_reconciliation_failed"])(
    "does not live-promote an admin agent held for provider auth (%s)",
    async (pausedReason) => {
      const containerManager = require("../containerManager");
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-provider-auth-held",
            user_id: "user-1",
            name: "Admin Provider Auth Held",
            status: "error",
            paused_reason: pausedReason,
            container_id: "container-admin-provider-auth-held",
            ownerEmail: "owner@example.com",
          },
        ],
      });

      const res = await withToken(
        request(app).get("/admin/agents/agent-admin-provider-auth-held"),
        adminToken,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ status: "error", paused_reason: pausedReason }),
      );
      expect(containerManager.status).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    },
  );

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

    const res = await withToken(request(app).get("/admin/agents/agent-1/stats"), adminToken);

    expect(res.status).toBe(200);
    expect(mockBuildAgentStatsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
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
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockBuildAgentHistoryResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.any(Date),
      expect.any(Date),
    );
    expect(res.body.samples).toHaveLength(1);
  });

  it("persists a refreshed runtime address when an admin starts an agent", async () => {
    const containerManager = require("../containerManager");
    mockResumeAgentWithProviderAuth.mockImplementationOnce(async (agent) => ({
      agent: {
        ...agent,
        status: "running",
        paused_reason: null,
        host: "10.40.50.61",
        runtime_host: "10.40.50.61",
      },
      lifecycleResult: { host: "10.40.50.61", runtimeHost: "10.40.50.61" },
    }));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-start-address",
            user_id: "user-proxmox",
            name: "Admin Start Address",
            status: "stopped",
            backend_type: "proxmox",
            container_id: "401",
            host: "10.40.50.10",
            runtime_host: "10.40.50.10",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-start-address",
            user_id: "user-proxmox",
            name: "Admin Start Address",
            status: "stopped",
            backend_type: "proxmox",
            container_id: "401",
            host: "10.40.50.10",
            runtime_host: "10.40.50.10",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-start-address",
            user_id: "user-proxmox",
            name: "Admin Start Address",
            status: "running",
            backend_type: "proxmox",
            container_id: "401",
            host: "10.40.50.61",
            runtime_host: "10.40.50.61",
          },
        ],
      });
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-admin-start-address", status: "synced" },
    ]);

    const res = await withToken(
      request(app).post("/admin/agents/agent-admin-start-address/start"),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ host: "10.40.50.61", runtime_host: "10.40.50.61" }),
    );
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-admin-start-address", user_id: "user-proxmox" }),
      "start",
    );
    expect(mockResumeAgentWithProviderAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(containerManager.start).not.toHaveBeenCalled();
  });

  it("persists a refreshed runtime address when an admin restarts an agent", async () => {
    const containerManager = require("../containerManager");
    mockResumeAgentWithProviderAuth.mockImplementationOnce(async (agent) => ({
      agent: {
        ...agent,
        status: "running",
        paused_reason: null,
        host: "10.40.50.62",
        runtime_host: "10.40.50.62",
      },
      lifecycleResult: { host: "10.40.50.62", runtimeHost: "10.40.50.62" },
    }));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-restart-address",
            user_id: "user-proxmox",
            name: "Admin Restart Address",
            status: "running",
            backend_type: "proxmox",
            container_id: "402",
            host: "10.40.50.11",
            runtime_host: "10.40.50.11",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-restart-address",
            user_id: "user-proxmox",
            name: "Admin Restart Address",
            status: "running",
            backend_type: "proxmox",
            container_id: "402",
            host: "10.40.50.11",
            runtime_host: "10.40.50.11",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-restart-address",
            user_id: "user-proxmox",
            name: "Admin Restart Address",
            status: "running",
            backend_type: "proxmox",
            container_id: "402",
            host: "10.40.50.62",
            runtime_host: "10.40.50.62",
          },
        ],
      });
    mockSyncAuthToUserAgents.mockResolvedValueOnce([
      { agentId: "agent-admin-restart-address", status: "synced" },
    ]);

    const res = await withToken(
      request(app).post("/admin/agents/agent-admin-restart-address/restart"),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ host: "10.40.50.62", runtime_host: "10.40.50.62" }),
    );
    expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-admin-restart-address", user_id: "user-proxmox" }),
      "restart",
    );
    expect(mockResumeAgentWithProviderAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
    );
    expect(containerManager.restart).not.toHaveBeenCalled();
  });

  it.each([
    ["start", "stopped", false],
    ["restart", "running", true],
  ])(
    "returns the provider-fenced %s failure without publishing a success audit",
    async (action, initialStatus) => {
      const containerManager = require("../containerManager");
      const monitoringModule = require("../monitoring");
      const agent = {
        id: `agent-admin-${action}-auth-failure`,
        user_id: "durable-owner-1",
        name: `Admin ${action} Auth Failure`,
        status: initialStatus,
        backend_type: "proxmox",
        container_id: action === "start" ? "405" : "406",
      };
      mockDb.query
        .mockResolvedValueOnce({ rows: [agent] })
        .mockResolvedValueOnce({ rows: [{ ...agent }] })
        .mockResolvedValueOnce({ rows: [{ ...agent, status: "running" }] })
        .mockResolvedValueOnce({ rows: [] });

      mockResumeAgentWithProviderAuth.mockRejectedValueOnce(
        Object.assign(new Error("Current provider authentication could not be reconciled"), {
          statusCode: 502,
          code: "AGENT_AUTH_RECONCILIATION_FAILED",
        }),
      );

      const res = await withToken(
        request(app).post(`/admin/agents/${agent.id}/${action}`),
        adminToken,
      );

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("AGENT_AUTH_RECONCILIATION_FAILED");
      expect(mockResumeAgentWithProviderAuth).toHaveBeenCalledWith(
        expect.objectContaining({ id: agent.id, user_id: "durable-owner-1" }),
        action,
      );
      expect(mockResumeAgentWithProviderAuth.mock.invocationCallOrder[0]).toBeLessThan(
        mockAgentProvisionLockRelease.mock.invocationCallOrder[0],
      );
      expect(containerManager[action]).not.toHaveBeenCalled();
      expect(monitoringModule.logEvent).not.toHaveBeenCalledWith(
        action === "start" ? "admin_agent_started" : "admin_agent_restarted",
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("stops a Kubernetes deployment by container_name from admin when container_id is missing", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-stop",
            user_id: "user-k8s",
            name: "K8s Stop",
            status: "running",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            container_id: null,
            container_name: "nora-oclaw-admin-k8s-stop",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-stop",
            user_id: "user-k8s",
            name: "K8s Stop",
            status: "running",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            container_id: null,
            container_name: "nora-oclaw-admin-k8s-stop",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "agent-k8s-stop", status: "stopped" }],
      });

    const res = await withToken(request(app).post("/admin/agents/agent-k8s-stop/stop"), adminToken);

    expect(res.status).toBe(200);
    expect(containerManager.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-stop",
        container_name: "nora-oclaw-admin-k8s-stop",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({ status: "stopped" }));
  });

  it("keeps a Proxmox agent running when an admin stop fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.stop.mockRejectedValueOnce(new Error("Proxmox admin shutdown failed"));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-proxmox-stop-fail",
            user_id: "user-proxmox",
            name: "Admin Proxmox Stop Fail",
            status: "running",
            backend_type: "proxmox",
            deploy_target: "proxmox",
            container_id: "403",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-admin-proxmox-stop-fail",
            user_id: "user-proxmox",
            name: "Admin Proxmox Stop Fail",
            status: "running",
            backend_type: "proxmox",
            deploy_target: "proxmox",
            container_id: "403",
          },
        ],
      });

    const res = await withToken(
      request(app).post("/admin/agents/agent-admin-proxmox-stop-fail/stop"),
      adminToken,
    );

    expect(res.status).toBe(500);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["start", "queued"],
    ["start", "deploying"],
    ["stop", "queued"],
    ["stop", "deploying"],
    ["restart", "queued"],
    ["restart", "deploying"],
  ])("rejects an admin %s while the locked agent is %s", async (action, lockedStatus) => {
    const containerManager = require("../containerManager");
    const agent = {
      id: `agent-admin-${action}-${lockedStatus}`,
      user_id: "user-proxmox",
      name: `Admin ${action} ${lockedStatus}`,
      status: action === "start" ? "stopped" : "running",
      backend_type: "proxmox",
      deploy_target: "proxmox",
      container_id: "404",
    };
    mockDb.query
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [{ ...agent, status: lockedStatus }] });

    const res = await withToken(
      request(app).post(`/admin/agents/${agent.id}/${action}`),
      adminToken,
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({
        error:
          "Agent deployment is queued or in progress. Wait for provisioning to finish before changing lifecycle state.",
        code: "AGENT_PROVISIONING_IN_PROGRESS",
      }),
    );
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith(agent.id, {
      applicationName: `nora-backend-admin-agent-${action}`,
    });
    expect(containerManager[action]).not.toHaveBeenCalled();
    expect(mockPersistLifecycleRuntimeAddress).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
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

    const res = await withToken(request(app).post("/admin/agents/agent-1/redeploy"), adminToken);

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        userId: "user-2",
        backend: "docker",
        specs: { vcpu: 4, ram_mb: 4096, disk_gb: 40 },
      }),
    );
    expect(monitoring.logEvent).toHaveBeenCalled();
  });

  it("authorizes a Remote Docker admin redeploy as the persisted agent owner", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-remote-admin",
            user_id: "user-remote-owner",
            name: "Remote Agent",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "remote-docker",
            deploy_target: "remote-docker",
            execution_target_id: "remote:shared-vps",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "remote-agent",
            image: "nora-openclaw-agent:local",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).post("/admin/agents/agent-remote-admin/redeploy"),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockAssertRemoteHostExecutionTargetAvailable).toHaveBeenCalledWith(
      expect.objectContaining({
        deploy_target: "remote-docker",
        execution_target_id: "remote:shared-vps",
      }),
      { ownerUserId: "user-remote-owner" },
    );
  });

  it("requeues admin redeploys from new runtime columns when legacy aliases are missing", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-2",
            user_id: "user-9",
            name: "Nemo Runtime Agent",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "nemoclaw",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "nemo-agent",
            image: "nora/nemo:latest",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(request(app).post("/admin/agents/agent-2/redeploy"), adminToken);

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-2",
        userId: "user-9",
        backend: "docker",
        sandbox: "nemoclaw",
      }),
    );
  });

  it("accepts sandbox profile overrides on admin redeploy", async () => {
    process.env.ENABLED_BACKENDS = "docker";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-3",
            user_id: "user-3",
            name: "Standard Runtime Agent",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "standard-agent",
            image: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).post("/admin/agents/agent-3/redeploy").send({
        sandbox_profile: "nemoclaw",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'queued'"),
      [
        "agent-3",
        "stopped",
        null,
        "standard-agent",
        "docker",
        "openclaw",
        "docker",
        "docker",
        "standard",
        null,
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-3",
        userId: "user-3",
        backend: "docker",
        execution_target_id: "docker",
        sandbox: "nemoclaw",
        replace_existing_runtime: true,
        previous_container_id: null,
        previous_container_name: "standard-agent",
        previous_sandbox_profile: "standard",
        image: getDefaultAgentImage({
          runtime_family: "openclaw",
          deploy_target: "docker",
          sandbox_profile: "nemoclaw",
          backend: "docker",
        }),
      }),
    );
  });

  it("recomputes the default image when admin redeploy switches execution targets", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-4",
            user_id: "user-4",
            name: "Docker Runtime Agent",
            status: "stopped",
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_name: "docker-agent",
            image: "nora-openclaw-agent:local",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).post("/admin/agents/agent-4/redeploy").send({
        deploy_target: "k8s:test-cluster",
      }),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET status = 'queued'"),
      [
        "agent-4",
        "stopped",
        null,
        "docker-agent",
        "docker",
        "openclaw",
        "docker",
        "docker",
        "standard",
        null,
      ],
    );
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-4",
        userId: "user-4",
        backend: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox: "standard",
        replace_existing_runtime: true,
        previous_container_name: "docker-agent",
        previous_deploy_target: "docker",
        image: "node:24-slim",
      }),
    );
  });

  it("passes previous Kubernetes runtime refs for admin redeploy cleanup", async () => {
    process.env.ENABLED_BACKENDS = "docker";

    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-admin",
            user_id: "user-k8s",
            name: "Admin K8s Agent",
            status: "stopped",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            vcpu: 2,
            ram_mb: 2048,
            disk_gb: 20,
            container_id: "nora-oclaw-admin-k8s-old",
            container_name: "nora-oclaw-admin-k8s-old",
            host: "nora-oclaw-admin-k8s-old.openclaw-agents.svc.cluster.local",
            image: "node:24-slim",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(
      request(app).post("/admin/agents/agent-k8s-admin/redeploy"),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(mockAddDeploymentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-admin",
        userId: "user-k8s",
        backend: "k8s",
        previous_container_id: "nora-oclaw-admin-k8s-old",
        previous_container_name: "nora-oclaw-admin-k8s-old",
        previous_host: "nora-oclaw-admin-k8s-old.openclaw-agents.svc.cluster.local",
        previous_backend: "k8s",
        previous_runtime_family: "openclaw",
        previous_deploy_target: "k8s",
        previous_execution_target_id: "k8s:test-cluster",
        previous_sandbox_profile: "standard",
        replace_existing_runtime: true,
      }),
    );
    expect(mockAcquireAgentProvisionLock).toHaveBeenCalledWith("agent-k8s-admin", {
      applicationName: "nora-backend-admin-agent-replacement",
    });
    expect(mockCancelDeploymentJobsForAgent).toHaveBeenCalledWith("agent-k8s-admin");
    expect(mockAgentProvisionLockRelease).toHaveBeenCalledTimes(1);
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes("container_id = NULL")),
    ).toBe(false);
  });

  it("destroys agent containers before deleting the user", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-7", email: "user@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({ rows: [] })
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

    const res = await withToken(request(app).delete("/admin/users/user-7"), adminToken);

    expect(res.status).toBe(200);
    expect(containerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-7" }),
    );
    expect(mockDb.query).toHaveBeenLastCalledWith("DELETE FROM users WHERE id = $1", ["user-7"]);
  });

  it("keeps the user and agent rows when owned runtime cleanup fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.destroy.mockRejectedValueOnce(new Error("Proxmox user cleanup failed"));
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-proxmox-fail", email: "proxmox@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-proxmox-user-fail",
            user_id: "user-proxmox-fail",
            name: "Proxmox User Agent",
            backend_type: "proxmox",
            container_id: "404",
          },
        ],
      });

    const res = await withToken(request(app).delete("/admin/users/user-proxmox-fail"), adminToken);

    expect(res.status).toBe(500);
    expect(mockDb.query).toHaveBeenCalledTimes(3);
    expect(mockDb.query).not.toHaveBeenCalledWith("DELETE FROM users WHERE id = $1", [
      "user-proxmox-fail",
    ]);
  });

  it("blocks user deletion before cleanup when an owned Remote Docker host is referenced", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: "host-owner", email: "owner@example.com", role: "user" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "shared-build-host", label: "Shared build host", agentCount: 2 }],
      });

    const res = await withToken(request(app).delete("/admin/users/host-owner"), adminToken);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Shared build host.*2 agents/i);
    expect(res.body.code).toBe("REMOTE_HOSTS_IN_USE");
    expect(containerManager.destroy).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockDb.query.mock.calls[1][0]).toMatch(/a\.execution_target_id = 'remote:' \|\| rh\.id/);
    expect(mockDb.query.mock.calls[1][0]).not.toMatch(/a\.user_id/);
    expect(mockDb.query).not.toHaveBeenCalledWith("DELETE FROM users WHERE id = $1", [
      "host-owner",
    ]);
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

    const res = await withToken(request(app).delete("/admin/agents/agent-9"), adminToken);

    expect(res.status).toBe(200);
    expect(containerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-9" }),
    );
    expect(res.body).toEqual({ success: true });
  });

  it("keeps a global agent row when non-Kubernetes runtime cleanup fails", async () => {
    const containerManager = require("../containerManager");
    containerManager.destroy.mockRejectedValueOnce(new Error("Proxmox admin destroy failed"));
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-proxmox-admin-fail",
          user_id: "user-proxmox",
          name: "Delete Proxmox Agent",
          backend_type: "proxmox",
          container_id: "405",
        },
      ],
    });

    const res = await withToken(
      request(app).delete("/admin/agents/agent-proxmox-admin-fail"),
      adminToken,
    );

    expect(res.status).toBe(500);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalledWith("DELETE FROM agents WHERE id = $1", [
      "agent-proxmox-admin-fail",
    ]);
  });

  it("destroys Kubernetes resources by container_name before admin agent deletion", async () => {
    const containerManager = require("../containerManager");
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-delete",
            user_id: "user-k8s",
            name: "K8s Delete",
            runtime_family: "openclaw",
            backend_type: "k8s",
            deploy_target: "k8s",
            execution_target_id: "k8s:test-cluster",
            sandbox_profile: "standard",
            container_id: null,
            container_name: "nora-oclaw-k8s-delete",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await withToken(request(app).delete("/admin/agents/agent-k8s-delete"), adminToken);

    expect(res.status).toBe(200);
    expect(containerManager.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-delete",
        container_name: "nora-oclaw-k8s-delete",
      }),
    );
    expect(mockDb.query).toHaveBeenLastCalledWith("DELETE FROM agents WHERE id = $1", [
      "agent-k8s-delete",
    ]);
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
        "/admin/audit?search=invalid&type=admin_action_failed&from=2026-04-01&to=2026-04-08&page=2&limit=30",
      ),
      adminToken,
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
      }),
    );
    expect(res.body).toEqual(
      expect.objectContaining({
        total: 23,
        page: 2,
        limit: 30,
      }),
    );
    expect(res.body.availableTypes).toEqual(
      expect.arrayContaining(["admin_action_failed", "agent_started"]),
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
      request(app).get("/admin/audit/export?search=invalid&type=admin_action_failed"),
      adminToken,
    );

    expect(res.status).toBe(200);
    expect(monitoringModule.exportEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "invalid",
        type: "admin_action_failed",
      }),
    );
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("nora-audit-");
    expect(res.text).toContain("admin_action_failed");
    expect(res.text).toContain("Invalid role");
    expect(res.text).toContain("metadata_json");
    expect(res.text).toContain("source_kind");
  });
});
