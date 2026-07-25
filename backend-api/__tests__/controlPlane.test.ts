// @ts-nocheck
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn() };
const mockGetDeploymentDefaults = jest.fn().mockResolvedValue({
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
const mockGetLanguageSettings = jest.fn().mockResolvedValue({
  defaultLocale: "en",
  supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
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
  "NORA_INSTALL_METHOD",
  "NORA_MANUAL_UPGRADE_COMMAND",
  "NORA_MANUAL_UPGRADE_STEPS",
];
const CATALOG_ENV_KEYS = [
  "ENABLED_BACKENDS",
  "ENABLED_RUNTIME_FAMILIES",
  "ENABLED_SANDBOX_PROFILES",
  "PROXMOX_API_URL",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_TOKEN_SECRET",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_USER",
  "PROXMOX_SSH_PASSWORD",
];

function kubernetesClusterRow(overrides = {}) {
  return {
    id: "aks-eastus2",
    label: "AKS East US 2",
    provider: "aks",
    cluster_name: "nora-dns-vjb9kjjz",
    enabled: true,
    is_default: true,
    credential_mode: "mounted_path",
    kubeconfig_path: "/kubeconfigs/aks-eastus2",
    kube_context: "",
    namespace: "nora-openclaw-agents",
    openclaw_namespace: "nora-openclaw-agents",
    hermes_namespace: "nora-hermes-agents",
    exposure_mode: "load-balancer",
    runtime_host: "",
    service_annotations: {},
    load_balancer_source_ranges: [],
    load_balancer_class: "",
    load_balancer_ready_timeout_ms: 1200000,
    load_balancer_ready_interval_ms: 5000,
    last_test_status: "ok",
    last_test_message: "Kubernetes API is reachable.",
    ...overrides,
  };
}

jest.mock("../db", () => mockDb);
// Marked, transparent crypto: enc(...) on write, passthrough on read for any
// non-enc value. gateway_token is encrypted at rest, so the embed/gateway read
// paths must decrypt before use; plaintext rows in existing tests are unaffected.
jest.mock("../crypto", () => ({
  encrypt: (v) => (v == null || v === "" ? v : `enc(${v})`),
  decrypt: (v) => (typeof v === "string" && v.startsWith("enc(") ? v.slice(4, -1) : v),
  isEncryptionConfigured: () => true,
  ensureEncryptionConfigured: () => {},
  DecryptionError: class DecryptionError extends Error {},
}));
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
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
jest.mock("../platformSettings", () => ({
  getDeploymentDefaults: mockGetDeploymentDefaults,
  getLanguageSettings: mockGetLanguageSettings,
  getSystemBanner: mockGetSystemBanner,
}));

const app = require("../server");

describe("public platform config", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockGetDeploymentDefaults.mockReset().mockResolvedValue({
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
    mockGetLanguageSettings.mockReset().mockResolvedValue({
      defaultLocale: "en",
      supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    });
    RELEASE_ENV_KEYS.forEach((key) => delete process.env[key]);
    CATALOG_ENV_KEYS.forEach((key) => delete process.env[key]);
    delete global.fetch;
  });

  afterEach(() => {
    RELEASE_ENV_KEYS.forEach((key) => delete process.env[key]);
    CATALOG_ENV_KEYS.forEach((key) => delete process.env[key]);
    delete global.fetch;
  });

  it("returns deployment defaults in the platform config payload", async () => {
    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        mode: "selfhosted",
        deploymentDefaults: {
          vcpu: 1,
          ram_mb: 1024,
          disk_gb: 10,
        },
        systemBanner: {
          enabled: false,
          severity: "warning",
          title: "",
          message: "",
          featureEnabled: false,
          active: false,
        },
        language: {
          defaultLocale: "en",
          supportedLocales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
        },
      }),
    );
  });

  it("returns the system banner payload in the platform config", async () => {
    mockGetSystemBanner.mockResolvedValueOnce({
      enabled: true,
      severity: "warning",
      title: "Testing warning",
      message: "This Nora instance is for staging workflows only.",
      featureEnabled: true,
      active: true,
    });

    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(res.body.systemBanner).toEqual({
      enabled: true,
      severity: "warning",
      title: "Testing warning",
      message: "This Nora instance is for staging workflows only.",
      featureEnabled: true,
      active: true,
    });
  });

  it("reports the exact runtime tuple required by local Docker demo activation", async () => {
    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(res.body.capabilities.localDockerDemo).toEqual({
      enabled: true,
      runtimeFamily: "openclaw",
      deployTarget: "docker",
      executionTargetId: "docker",
      sandboxProfile: "standard",
      requiresLiveDocker: true,
      issue: null,
    });
  });

  it("disables local Docker demo activation when its runtime tuple is unavailable", async () => {
    process.env.ENABLED_BACKENDS = "k8s";

    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(res.body.capabilities.localDockerDemo).toEqual(
      expect.objectContaining({
        enabled: false,
        runtimeFamily: "openclaw",
        deployTarget: "docker",
        sandboxProfile: "standard",
        requiresLiveDocker: true,
        issue: expect.any(String),
      }),
    );
  });

  it("returns runtime, deploy-target, sandbox, and legacy backend catalogs", async () => {
    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        defaultRuntimeFamily: "openclaw",
        defaultDeployTarget: "docker",
        defaultSandboxProfile: "standard",
        enabledDeployTargets: ["docker"],
        enabledSandboxProfiles: ["standard"],
        runtimeFamily: expect.objectContaining({
          id: "openclaw",
          label: "OpenClaw",
          contractStatus: "stable",
          operatorContract: expect.arrayContaining([
            "deploy/redeploy",
            "gateway/chat",
            "auth/integration sync",
          ]),
        }),
        executionTargets: expect.arrayContaining([
          expect.objectContaining({
            id: "docker",
            label: "Docker",
            runtimeFamily: "openclaw",
            maturityTier: "ga",
            defaultSandboxProfile: "standard",
            sandboxProfiles: expect.arrayContaining([
              expect.objectContaining({
                id: "standard",
                label: "Standard",
                legacyBackendId: "docker",
                enabled: true,
                maturityTier: "ga",
              }),
              expect.objectContaining({
                id: "nemoclaw",
                label: "NemoClaw",
                legacyBackendId: "docker",
                enabled: false,
                maturityTier: "experimental",
              }),
            ]),
          }),
        ]),
        sandboxProfiles: expect.arrayContaining([
          expect.objectContaining({
            id: "standard",
            enabled: true,
            executionTargets: expect.arrayContaining(["docker"]),
          }),
          expect.objectContaining({
            id: "nemoclaw",
            enabled: false,
            executionTargets: [],
          }),
        ]),
        backends: expect.arrayContaining([
          expect.objectContaining({
            id: "docker",
            selectionType: "deploy_target",
            deployTarget: "docker",
            sandboxProfile: "standard",
            maturityTier: "ga",
          }),
        ]),
      }),
    );
    expect(res.body.legacyBackends).toEqual(res.body.backends);
  });

  it("marks maturity tiers on deploy targets and surfaces Docker sandbox choices separately", async () => {
    process.env.ENABLED_BACKENDS = "docker,proxmox";
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";
    mockDb.query.mockResolvedValueOnce({ rows: [kubernetesClusterRow()] });

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);

    const dockerTarget = res.body.executionTargets.find((target) => target.id === "docker");
    const k8sTarget = res.body.executionTargets.find((target) => target.id === "k8s:aks-eastus2");
    const proxmoxTarget = res.body.executionTargets.find((target) => target.id === "proxmox");

    expect(dockerTarget).toEqual(
      expect.objectContaining({
        enabled: true,
        available: true,
        maturityTier: "ga",
        supportsSandboxSelection: true,
        enabledSandboxProfiles: expect.arrayContaining(["standard", "nemoclaw"]),
      }),
    );
    expect(dockerTarget.sandboxProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "standard",
          enabled: true,
          available: true,
          maturityTier: "ga",
        }),
        expect.objectContaining({
          id: "nemoclaw",
          enabled: true,
          available: true,
          maturityTier: "experimental",
        }),
      ]),
    );

    expect(k8sTarget).toEqual(
      expect.objectContaining({
        enabled: true,
        available: true,
        maturityTier: "ga",
        supportsSandboxSelection: true,
      }),
    );

    expect(proxmoxTarget).toEqual(
      expect.objectContaining({
        enabled: true,
        maturityTier: "experimental",
      }),
    );
  });

  it("surfaces Hermes as a runtime family on execution targets when ENABLED_RUNTIME_FAMILIES enables it", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "hermes";
    process.env.ENABLED_BACKENDS = "docker,proxmox";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        defaultRuntimeFamily: "hermes",
        defaultDeployTarget: "docker",
        defaultSandboxProfile: "standard",
      }),
    );
    expect(res.body.runtimeFamily).toEqual(
      expect.objectContaining({
        id: "hermes",
        label: "Hermes",
        contractStatusLabel: "Deployment-first contract",
      }),
    );
    expect(res.body.executionTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "docker",
          runtimeFamily: "hermes",
          defaultSandboxProfile: "standard",
          maturityTier: "ga",
        }),
      ]),
    );
    expect(res.body.executionTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "proxmox",
          runtimeFamily: "hermes",
          maturityTier: "experimental",
        }),
      ]),
    );
    // Hermes can now target a remote Docker host (BYOC Phase B2), surfaced as
    // an experimental execution target.
    expect(res.body.executionTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "remote-docker",
          runtimeFamily: "hermes",
          maturityTier: "experimental",
        }),
      ]),
    );
    expect(res.body.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "docker",
          runtimeFamily: "hermes",
          selectionType: "deploy_target",
          deployTarget: "docker",
          sandboxProfile: "standard",
        }),
      ]),
    );
  });

  it("ignores legacy ENABLED_BACKENDS=hermes instead of enabling Hermes", async () => {
    process.env.ENABLED_BACKENDS = "hermes";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.defaultRuntimeFamily).toBe("openclaw");
    expect(res.body.enabledBackends).toEqual(["docker"]);
    expect(res.body.backends.map((backend) => backend.id)).not.toContain("hermes");
  });

  it("surfaces Kubernetes as a compatible target for OpenClaw and Hermes", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    mockDb.query.mockResolvedValueOnce({ rows: [kubernetesClusterRow()] });

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.enabledDeployTargets).toEqual(expect.arrayContaining(["k8s"]));
    expect(res.body.runtimeFamilies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openclaw" }),
        expect.objectContaining({
          id: "hermes",
          available: true,
          enabledDeployTargets: expect.arrayContaining(["k8s"]),
        }),
      ]),
    );
    expect(res.body.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "k8s:aks-eastus2",
          enabled: true,
        }),
      ]),
    );
  });

  it("omits Kubernetes clusters without a passing connection test from OpenClaw and Hermes deploy catalogs", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        kubernetesClusterRow({
          id: "aks-failed",
          last_test_status: "failed",
          last_test_message: "Forbidden",
        }),
        kubernetesClusterRow({
          id: "aks-untested",
          last_test_status: null,
          last_test_message: null,
        }),
      ],
    });

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.enabledDeployTargets).not.toContain("k8s");
    expect(res.body.executionTargets.some((target) => String(target.id).startsWith("k8s:"))).toBe(
      false,
    );
    for (const runtimeFamily of res.body.runtimeFamilies) {
      expect(
        runtimeFamily.executionTargets.some((target) => String(target.id).startsWith("k8s:")),
      ).toBe(false);
    }
  });

  it("does not create Kubernetes execution targets from K3s env aliases", async () => {
    process.env.ENABLED_BACKENDS = "k3s";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.enabledBackends).toEqual(["docker"]);
    expect(res.body.executionTargets.some((target) => String(target.id).startsWith("k8s"))).toBe(
      false,
    );
  });

  it("expands admin-registered Kubernetes clusters into concrete execution targets", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [kubernetesClusterRow()],
    });

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.defaultExecutionTarget).toBe("k8s:aks-eastus2");
    expect(res.body.executionTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "k8s:aks-eastus2",
          deployTarget: "k8s",
          executionTargetId: "k8s:aks-eastus2",
          label: "AKS East US 2",
          providerLabel: "AKS",
          clusterName: "nora-dns-vjb9kjjz",
          namespace: "nora-openclaw-agents",
          exposureMode: "load-balancer",
          available: true,
        }),
      ]),
    );
  });

  it("returns release metadata when a newer version is announced", async () => {
    process.env.NORA_CURRENT_VERSION = "1.2.3";
    process.env.NORA_CURRENT_COMMIT = "abc123def456";
    process.env.NORA_LATEST_VERSION = "1.3.0";
    process.env.NORA_LATEST_PUBLISHED_AT = "2026-04-10T12:00:00.000Z";
    process.env.NORA_RELEASE_NOTES_URL = "https://nora.test/releases/1.3.0";
    process.env.NORA_LATEST_SEVERITY = "critical";
    process.env.NORA_UPGRADE_REQUIRED = "true";

    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(res.body.release).toEqual(
      expect.objectContaining({
        currentVersion: "1.2.3",
        currentCommit: "abc123def456",
        latestVersion: "1.3.0",
        publishedAt: "2026-04-10T12:00:00.000Z",
        releaseNotesUrl: "https://nora.test/releases/1.3.0",
        severity: "critical",
        updateAvailable: true,
        upgradeRequired: true,
        trackingConfigured: true,
        canAutoUpgrade: false,
        installMethod: "source",
        manualUpgrade: expect.objectContaining({
          command: "./setup.sh --update",
          steps: expect.arrayContaining([expect.stringContaining("repo root")]),
        }),
      }),
    );
  });

  it("tracks commit-only source builds without marking them outdated", async () => {
    process.env.NORA_CURRENT_COMMIT = "abc123def456";
    process.env.NORA_LATEST_VERSION = "1.3.0";
    process.env.NORA_LATEST_PUBLISHED_AT = "2026-04-10T12:00:00.000Z";

    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(res.body.release).toEqual(
      expect.objectContaining({
        currentVersion: null,
        currentCommit: "abc123def456",
        latestVersion: "1.3.0",
        severity: "info",
        updateAvailable: false,
        upgradeRequired: false,
        trackingConfigured: true,
      }),
    );
  });

  it("uses the latest GitHub release when explicit latest metadata is not set", async () => {
    process.env.NORA_CURRENT_VERSION = "1.2.3";
    process.env.NORA_GITHUB_REPO = "solomon2773/nora";
    process.env.NORA_RELEASE_CACHE_TTL_MS = "0";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v1.3.0",
        published_at: "2026-04-11T08:30:00.000Z",
        html_url: "https://github.com/solomon2773/nora/releases/tag/v1.3.0",
      }),
    });

    const res = await request(app).get("/config/platform");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/solomon2773/nora/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "nora-release-checker",
        }),
      }),
    );
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    expect(res.body.release).toEqual(
      expect.objectContaining({
        currentVersion: "1.2.3",
        latestVersion: "v1.3.0",
        publishedAt: "2026-04-11T08:30:00.000Z",
        releaseNotesUrl: "https://github.com/solomon2773/nora/releases/tag/v1.3.0",
        latestSource: "github",
        latestRepo: "solomon2773/nora",
        updateAvailable: true,
      }),
    );
  });
});

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

  it("proxies the gateway UI, sets an embed session cookie, and injects the bootstrap script", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: null,
          status: "running",
        },
      ],
    });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head><title>Gateway</title></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    // The embed proxy now routes through the SSRF allowlist: it connects to the
    // validated host and sets the upstream Host header (10.0.0.10 is RFC1918, so
    // the resolved address is the IP itself). Root path normalizes to a trailing /.
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.10:18789/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/html",
          "Accept-Encoding": "identity",
          Host: "10.0.0.10:18789",
        }),
      }),
    );
    expect(res.text).toContain('<base href="/api/agents/agent-1/gateway/embed/">');
    expect(res.text).toContain(
      '<script src="/api/agents/agent-1/gateway/embed/bootstrap.js"></script>',
    );
    expect(res.text).not.toContain("window.__NORA_EMBED_AUTO_LOGIN__ = true");
    expect(res.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("__nora_gateway_embed_agent-1=")]),
    );
    expect(res.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self' ws: wss:");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("serves the bootstrap script from an embed session cookie and uses wss behind HTTPS proxies", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: null,
          status: "running",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed/bootstrap.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    // Relay WS URL must NOT carry the JWT as a query parameter; the embed
    // session cookie authenticates the WS upgrade server-side.
    expect(res.text).toContain('"wss://nora.test/api/ws/gateway/agent-1"');
    expect(res.text).not.toContain("?token=");
    expect(res.text).toContain('var nextHash = "password=" + encodeURIComponent(P)');
    expect(res.text).toContain("window.__NORA_EMBED_AUTO_LOGIN__ = true");
    expect(res.text).toContain("function startAutoLogin()");
    expect(res.text).toContain("form.requestSubmit");
    expect(res.text).toContain("new MutationObserver");
    expect(res.text).not.toContain("localStorage.setItem('oc-gateway-url',R)");
  });

  it("decrypts an encrypted gateway_token before inlining it into the bootstrap script", async () => {
    // gateway_token is stored encrypted; the embed bootstrap must inline the
    // DECRYPTED value (the browser uses it as the gateway WS password), never
    // the ciphertext.
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "enc(gateway-password)",
          gateway_host_port: null,
          status: "running",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed/bootstrap.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    // P is the inlined password; it must be the plaintext, not the stored enc(...).
    expect(res.text).toContain('var P="gateway-password"');
    expect(res.text).not.toContain("enc(gateway-password)");
  });

  it("does not expose the gateway bootstrap password after a Remote Docker grant is revoked", async () => {
    const agent = {
      id: "agent-remote",
      user_id: "user-1",
      host: "203.0.113.10",
      gateway_host: "203.0.113.10",
      gateway_port: 18789,
      gateway_token: "enc(remote-gateway-password)",
      status: "running",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
    };
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM agents") && text.includes("WHERE id = $1 AND user_id = $2")) {
        return { rows: [agent] };
      }
      if (text.includes("FROM remote_hosts")) return { rows: [] };
      return { rows: [] };
    });

    const res = await request(app)
      .get(`/agents/${agent.id}/gateway/embed/bootstrap.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(403);
    expect(res.text).toMatch(/host access has been revoked/i);
    expect(res.text).not.toContain("remote-gateway-password");
  });

  it("does not expose Remote Docker authorization-store failures from embed access", async () => {
    const agent = {
      id: "agent-remote-auth-store-error",
      user_id: "user-1",
      host: "203.0.113.10",
      gateway_host: "203.0.113.10",
      gateway_port: 18789,
      gateway_token: "enc(remote-gateway-password)",
      status: "running",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
    };
    const internalError = new Error("postgres://internal-user:secret@db/private");
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM agents") && text.includes("WHERE id = $1 AND user_id = $2")) {
        return { rows: [agent] };
      }
      if (text.includes("FROM remote_hosts")) throw internalError;
      return { rows: [] };
    });

    const res = await request(app)
      .get(`/agents/${agent.id}/gateway/embed/bootstrap.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(503);
    expect(res.text).toBe("Unable to verify Remote Docker host access");
    expect(res.text).not.toContain(internalError.message);
    expect(res.text).not.toContain("remote-gateway-password");
  });

  it("uses the published gateway host port when one is recorded", async () => {
    // GATEWAY_HOST is the operator-configured published host; it must be on the
    // allowlist (RFC1918 here) for the embed proxy to reach it.
    process.env.GATEWAY_HOST = "10.10.0.5";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: 19123,
          status: "running",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.10.0.5:19123/",
      expect.objectContaining({
        headers: expect.objectContaining({ Host: "10.10.0.5:19123" }),
      }),
    );
  });

  it("prefers explicit gateway host and port when the backend provides them", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: 19123,
          gateway_host: "10.0.0.20",
          gateway_port: 19500,
          status: "running",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    // Explicit gateway_host + gateway_port win over host/published port.
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.20:19500/",
      expect.objectContaining({
        headers: expect.objectContaining({ Host: "10.0.0.20:19500" }),
      }),
    );
  });

  it("prefers an explicit gateway host even when the backend exposes the gateway via a published port", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: 19123,
          gateway_host: "10.0.0.30",
          status: "running",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    // Explicit gateway_host wins; it is paired with the published host port.
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.30:19123/",
      expect.objectContaining({
        headers: expect.objectContaining({ Host: "10.0.0.30:19123" }),
      }),
    );
  });

  it("allows embed for warning agents so degraded control-plane recovery still works", async () => {
    process.env.GATEWAY_HOST = "10.10.0.5";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: 19123,
          status: "warning",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head></head><body>warning</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.10.0.5:19123/",
      expect.objectContaining({
        headers: expect.objectContaining({ Host: "10.10.0.5:19123" }),
      }),
    );
  });

  it("rejects embed for stopped agents so stale control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: 19123,
          status: "stopped",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects embed for error agents so failed control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: 19123,
          status: "error",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects embed proxy access to a public (non-allowlisted) gateway host (SSRF guard)", async () => {
    // A docker agent's own gateway host that is not RFC1918/loopback/publishedHost
    // must not be reachable — the embed proxy enforces the same allowlist as the
    // HTTP gateway proxy.
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "203.0.113.5",
          gateway_token: "gateway-password",
          gateway_host: "203.0.113.5",
          gateway_port: 18789,
          status: "running",
          deploy_target: "docker",
          execution_target_id: "docker",
          user_id: "user-1",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(502);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects asset proxy access to a public (non-allowlisted) gateway host (SSRF guard)", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "203.0.113.5",
          gateway_host: "203.0.113.5",
          gateway_port: 18789,
          status: "running",
          deploy_target: "docker",
          execution_target_id: "docker",
          user_id: "user-1",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/assets/app.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(502);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("allows asset proxy access for warning agents so degraded control-plane recovery still works", async () => {
    process.env.GATEWAY_HOST = "10.10.0.5";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_host_port: 19123,
          status: "warning",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => new TextEncoder().encode("console.log('ok')").buffer,
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/assets/app.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.10.0.5:19123/assets/app.js",
      expect.objectContaining({
        headers: expect.objectContaining({ Host: "10.10.0.5:19123" }),
      }),
    );
  });

  it("uses GATEWAY_HOST for asset proxy access when a published gateway port is recorded", async () => {
    process.env.GATEWAY_HOST = "10.10.0.5";
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_host_port: 19123,
          status: "running",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => new TextEncoder().encode("console.log('proxy')").buffer,
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/assets/app.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.10.0.5:19123/assets/app.js",
      expect.objectContaining({
        headers: expect.objectContaining({ Host: "10.10.0.5:19123" }),
      }),
    );
  });

  it("uses the default 18789 gateway contract for asset proxy access when no host port is published", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_host_port: null,
          status: "running",
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => new TextEncoder().encode("console.log('default-port')").buffer,
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/assets/app.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.10:18789/assets/app.js",
      expect.any(Object),
    );
  });

  it("rejects asset proxy access for stopped agents so stale control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_host_port: 19123,
          status: "stopped",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/assets/app.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects asset proxy access for error agents so failed control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.10",
          gateway_host_port: 19123,
          status: "error",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/assets/app.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects asset proxy access without an embed session or token so unauthenticated callers cannot fetch gateway bundles", async () => {
    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test");

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("rejects asset proxy access when the embed cookie belongs to a user who does not own the agent", async () => {
    const otherUserCookie = jwt.sign(
      { id: "user-2", agentId: "agent-1", scope: "gateway-embed" },
      JWT_SECRET,
      { expiresIn: "15m", algorithm: "HS256" },
    );
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test")
      .set("Cookie", `__nora_gateway_embed_agent-1=${otherUserCookie}`);

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects asset proxy access when the embed cookie was minted for a different agent", async () => {
    const wrongAgentCookie = jwt.sign(
      { id: "user-1", agentId: "agent-2", scope: "gateway-embed" },
      JWT_SECRET,
      { expiresIn: "15m", algorithm: "HS256" },
    );

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test")
      .set("Cookie", `__nora_gateway_embed_agent-1=${wrongAgentCookie}`);

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("proxies embed-relative config and navigation paths via the embed session cookie", async () => {
    const agentClient = request.agent(app);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.10",
            gateway_token: "gateway-password",
            gateway_host_port: null,
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.10",
            gateway_token: "gateway-password",
            gateway_host_port: null,
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.10",
            gateway_token: "gateway-password",
            gateway_host_port: null,
            status: "running",
          },
        ],
      });
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => "<html><head><title>Gateway</title></head><body>ok</body></html>",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        arrayBuffer: async () => Buffer.from('{"ok":true}'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => "<html><head><title>Chat</title></head><body>chat</body></html>",
      });

    const htmlRes = await agentClient
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(htmlRes.status).toBe(200);

    const configRes = await agentClient
      .get("/agents/agent-1/gateway/embed/__openclaw__/control-ui-config.json")
      .set("Host", "nora.test");

    expect(configRes.status).toBe(200);
    expect(configRes.text).toBe('{"ok":true}');
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://10.0.0.10:18789/__openclaw__/control-ui-config.json",
      expect.any(Object),
    );

    const chatRes = await agentClient
      .get("/agents/agent-1/gateway/embed/chat?session=main")
      .set("Host", "nora.test");

    expect(chatRes.status).toBe(200);
    expect(chatRes.text).toContain(
      '<script src="/api/agents/agent-1/gateway/embed/bootstrap.js"></script>',
    );
    expect(chatRes.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://10.0.0.10:18789/chat?session=main",
      expect.any(Object),
    );
  });

  it("does not expose internal gateway config paths before authentication", async () => {
    const res = await request(app)
      .get("/agents/agent-1/gateway/__openclaw__/control-ui-config.json")
      .set("Host", "nora.test");

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("Hermes dashboard embed", () => {
  const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, {
    expiresIn: "1h",
  });

  beforeEach(() => {
    mockDb.query.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it("proxies the official Hermes dashboard, rewrites root-relative assets, and sets an embed session cookie", async () => {
    const agentClient = request.agent(app);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.40",
            runtime_host: "10.0.0.40",
            runtime_port: 8642,
            runtime_family: "hermes",
            backend_type: "docker",
            status: "warning",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.40",
            runtime_host: "10.0.0.40",
            runtime_port: 8642,
            runtime_family: "hermes",
            backend_type: "docker",
            status: "warning",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.40",
            runtime_host: "10.0.0.40",
            runtime_port: 8642,
            runtime_family: "hermes",
            backend_type: "docker",
            status: "warning",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.40",
            runtime_host: "10.0.0.40",
            runtime_port: 8642,
            runtime_family: "hermes",
            backend_type: "docker",
            status: "warning",
          },
        ],
      });
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () =>
          '<html><head><script>window.__HERMES_SESSION_TOKEN__="dash-session";</script><link rel="icon" type="image/svg+xml" href="/favicon.ico" /><script type="module" crossorigin src="/assets/index.js"></script><link rel="stylesheet" crossorigin href="/assets/index.css"></head><body>ok</body></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/javascript" }),
        text: async () =>
          'function AM({basename:e="/",children:t,window:i}){return t}const api="/api/status";const plugin="/dashboard-plugins/example/dist/index.js";Ex.createRoot(document.getElementById("root")).render(r.jsx(AM,{children:r.jsx(Gb,{children:r.jsx("div",{children:"ok"})})}));',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/css" }),
        text: async () => "@font-face{src:url(/fonts/Mondwest.woff2)}",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        arrayBuffer: async () => Buffer.from('{"ok":true}'),
      });

    const htmlRes = await agentClient
      .get(`/agents/agent-1/hermes-ui/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.text).toContain('src="/api/agents/agent-1/hermes-ui/embed/assets/index.js"');
    expect(htmlRes.text).toContain('href="/api/agents/agent-1/hermes-ui/embed/assets/index.css"');
    expect(htmlRes.text).toContain('href="/api/agents/agent-1/hermes-ui/embed/favicon.ico"');
    expect(htmlRes.text).toContain('window.__HERMES_SESSION_TOKEN__="dash-session"');
    expect(htmlRes.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("__nora_hermes_embed_agent-1=")]),
    );
    expect(htmlRes.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://10.0.0.40:9119",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/html",
          "Accept-Encoding": "identity",
        }),
      }),
    );

    const jsRes = await agentClient
      .get("/agents/agent-1/hermes-ui/embed/assets/index.js")
      .set("Host", "nora.test");

    expect(jsRes.status).toBe(200);
    expect(jsRes.text).toContain('"/api/agents/agent-1/hermes-ui/embed/api/status"');
    expect(jsRes.text).toContain(
      '"/api/agents/agent-1/hermes-ui/embed/dashboard-plugins/example/dist/index.js"',
    );
    expect(jsRes.text).toContain('basename:"/api/agents/agent-1/hermes-ui/embed"');
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://10.0.0.40:9119/assets/index.js",
      expect.any(Object),
    );

    const cssRes = await agentClient
      .get("/agents/agent-1/hermes-ui/embed/assets/index.css")
      .set("Host", "nora.test");

    expect(cssRes.status).toBe(200);
    expect(cssRes.text).toContain("url(/api/agents/agent-1/hermes-ui/embed/fonts/Mondwest.woff2)");
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://10.0.0.40:9119/assets/index.css",
      expect.any(Object),
    );

    const apiRes = await agentClient
      .get("/agents/agent-1/hermes-ui/embed/api/env")
      .set("Host", "nora.test")
      .set("Authorization", "Bearer hermes-session-token");

    expect(apiRes.status).toBe(200);
    expect(apiRes.text).toBe('{"ok":true}');
    expect(apiRes.headers["cache-control"]).toBe("no-store");
    // The platform JWT must NOT be forwarded to the tenant-owned Hermes
    // container — the embed session cookie already authenticates the
    // proxy boundary, and the upstream image may be operator-supplied.
    const envCall = global.fetch.mock.calls[3];
    expect(envCall[0]).toBe("http://10.0.0.40:9119/api/env");
    // Upstream returned 200 directly (no 401/redirect), so no server-side login
    // fired and no dashboard session was stored — the proxy forwards neither a
    // session-token header nor the client's Authorization header.
    expect(envCall[1].headers).not.toHaveProperty("X-Hermes-Session-Token");
    expect(envCall[1].headers).not.toHaveProperty("Authorization");
  });

  it("forwards protected dashboard writes through the embed session cookie", async () => {
    const agentClient = request.agent(app);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.41",
            runtime_host: "10.0.0.41",
            runtime_port: 8642,
            runtime_family: "hermes",
            backend_type: "docker",
            status: "running",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            host: "10.0.0.41",
            runtime_host: "10.0.0.41",
            runtime_port: 8642,
            runtime_family: "hermes",
            backend_type: "docker",
            status: "running",
          },
        ],
      });
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () =>
          '<html><head><script>window.__HERMES_SESSION_TOKEN__="dash-session";</script></head><body>ok</body></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        arrayBuffer: async () => Buffer.from('{"ok":true}'),
      });

    const htmlRes = await agentClient
      .get(`/agents/agent-2/hermes-ui/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(htmlRes.status).toBe(200);

    const apiRes = await agentClient
      .put("/agents/agent-2/hermes-ui/embed/api/config")
      .set("Host", "nora.test")
      .set("Authorization", "Bearer hermes-session-token")
      .send({ config: { model: "gpt-5.5" } });

    expect(apiRes.status).toBe(200);
    expect(apiRes.text).toBe('{"ok":true}');
    // The Authorization header from the browser must NOT be forwarded to the
    // tenant Hermes container; only the proxy-level embed session cookie
    // authenticates this request.
    const configCall = global.fetch.mock.calls[1];
    expect(configCall[0]).toBe("http://10.0.0.41:9119/api/config");
    expect(configCall[1].method).toBe("PUT");
    expect(configCall[1].headers["Content-Type"]).toBe("application/json");
    // Upstream returned 200 directly, so no server-side login fired and no
    // session was stored — neither a session-token nor the client's
    // Authorization header is forwarded upstream.
    expect(configCall[1].headers).not.toHaveProperty("X-Hermes-Session-Token");
    expect(configCall[1].headers).not.toHaveProperty("Authorization");
    expect(configCall[1].body).toBe(JSON.stringify({ config: { model: "gpt-5.5" } }));
  });

  it("logs in server-side and relays the session cookie when the dashboard is unauthenticated", async () => {
    const {
      deriveHermesDashboardBasicAuth,
    } = require("../../agent-runtime/lib/hermesDashboardAuth");
    const expectedCreds = deriveHermesDashboardBasicAuth("test-seed");

    // Single embed request → single agent DB lookup. gateway_token is the login
    // seed; ENCRYPTION_KEY is unset in this test env so decrypt() passes it
    // through unchanged.
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.42",
          runtime_host: "10.0.0.42",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "docker",
          status: "running",
          gateway_token: "test-seed",
        },
      ],
    });

    global.fetch
      // 1) initial upstream GET → unauthenticated redirect to the login page.
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Headers({ location: "/login?next=%2F" }),
        text: async () => "",
      })
      // 2) server-side login POST → 200 setting the Hermes session cookies.
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: {
          get: () => null,
          getSetCookie: () => [
            "hermes_session_at=AT; Path=/; HttpOnly",
            "hermes_session_rt=RT; Path=/; HttpOnly",
            "hermes_session_provider=basic; Path=/",
          ],
        },
        text: async () => "{}",
      })
      // 3) retry upstream GET → now authenticated, returns the dashboard HTML.
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => "<html><head></head><body>ok</body></html>",
      });

    const res = await request(app)
      .get(`/agents/agent-3/hermes-ui/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(3);

    // Call #2 is the login POST: JSON body carrying the derived basic-auth creds.
    const loginCall = global.fetch.mock.calls[1];
    expect(loginCall[0]).toContain(":9119/auth/password-login");
    expect(loginCall[1].method).toBe("POST");
    expect(loginCall[1].headers["Content-Type"]).toBe("application/json");
    const sent = JSON.parse(loginCall[1].body);
    expect(sent).toMatchObject({ provider: "basic", username: "nora", next: "/" });
    expect(sent.username).toBe(expectedCreds.username);
    expect(sent.password).toBe(expectedCreds.password);

    // Call #3 is the retry, carrying the freshly established session as Cookie.
    const retryCall = global.fetch.mock.calls[2];
    expect(retryCall[1].headers.Cookie).toContain("hermes_session_at=AT");
    expect(retryCall[1].headers.Cookie).toContain("hermes_session_rt=RT");

    // The established session is persisted in the Nora-managed HttpOnly cookie.
    expect(res.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("__nora_hermes_dashboard_token_agent-3=")]),
    );
  });

  it("relays a rewritten Location when server-side login fails", async () => {
    // Single embed request → single agent DB lookup.
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.43",
          runtime_host: "10.0.0.43",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "docker",
          status: "running",
          gateway_token: "test-seed",
        },
      ],
    });

    global.fetch
      // 1) initial upstream GET → unauthenticated redirect to the login page.
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Headers({ location: "/login?next=%2F" }),
        text: async () => "",
      })
      // 2) server-side login POST → fails (401) and sets no cookie.
      .mockResolvedValueOnce({
        status: 401,
        ok: false,
        headers: {
          get: () => null,
          getSetCookie: () => [],
        },
        text: async () => "",
      });

    const res = await request(app)
      .get(`/agents/agent-4/hermes-ui/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    // Login was attempted once; because it returned no session there is no 3rd
    // (retry) upstream call — the original 302 is relayed as-is.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const loginCall = global.fetch.mock.calls[1];
    expect(loginCall[0]).toContain("/auth/password-login");

    expect(res.status).toBe(302);
    // The upstream Location is rewritten onto the embed base path so the iframe
    // navigates within the proxied dashboard instead of the control-plane origin.
    expect(res.headers.location).toBe("/api/agents/agent-4/hermes-ui/embed/login?next=%2F");
  });

  it("rejects embed requests for stopped Hermes agents", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          host: "10.0.0.40",
          runtime_host: "10.0.0.40",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "docker",
          status: "stopped",
        },
      ],
    });

    const res = await request(app)
      .get(`/agents/agent-1/hermes-ui/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("Hermes runtime host grants", () => {
  const token = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, {
    expiresIn: "1h",
  });

  beforeEach(() => {
    mockDb.query.mockReset();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it("rejects Remote Hermes runtime access after the workspace host grant is revoked", async () => {
    const agent = {
      id: "agent-remote-hermes",
      user_id: "user-1",
      name: "Remote Hermes",
      status: "running",
      container_id: "remote-hermes-container",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      runtime_family: "hermes",
      runtime_host: "203.0.113.10",
      runtime_port: 8642,
      gateway_token: "enc(runtime-token)",
    };
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text === "SELECT * FROM agents WHERE id = $1") return { rows: [agent] };
      if (text.includes("FROM remote_hosts")) return { rows: [] };
      return { rows: [] };
    });

    const res = await request(app)
      .get(`/agents/${agent.id}/hermes-ui`)
      .set("Cookie", `nora_auth=${encodeURIComponent(token)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/host access has been revoked/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
