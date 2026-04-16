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
const RELEASE_ENV_KEYS = [
  "NORA_CURRENT_VERSION",
  "NORA_CURRENT_COMMIT",
  "NORA_BUILD_COMMIT",
  "GIT_SHA",
  "NORA_GITHUB_REPO",
  "NORA_RELEASE_REPO",
  "NORA_GITHUB_TOKEN",
  "NORA_RELEASE_CACHE_TTL_MS",
  "NORA_LATEST_VERSION",
  "NORA_LATEST_PUBLISHED_AT",
  "NORA_RELEASE_NOTES_URL",
  "NORA_LATEST_SEVERITY",
  "NORA_UPGRADE_REQUIRED",
  "NORA_AUTO_UPGRADE_ENABLED",
  "NORA_INSTALL_METHOD",
  "NORA_MANUAL_UPGRADE_COMMAND",
  "NORA_MANUAL_UPGRADE_STEPS",
];
const CATALOG_ENV_KEYS = [
  "ENABLED_BACKENDS",
  "ENABLED_RUNTIME_FAMILIES",
  "KUBECONFIG",
];

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
jest.mock("../platformSettings", () => ({
  getDeploymentDefaults: mockGetDeploymentDefaults,
  getSystemBanner: mockGetSystemBanner,
}));

const app = require("../server");

describe("public platform config", () => {
  beforeEach(() => {
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
      })
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
                legacyBackendId: "nemoclaw",
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
          expect.objectContaining({
            id: "nemoclaw",
            selectionType: "sandbox_profile",
            deployTarget: "docker",
            sandboxProfile: "nemoclaw",
            maturityTier: "experimental",
          }),
        ]),
      })
    );
    expect(res.body.legacyBackends).toEqual(res.body.backends);
  });

  it("marks maturity tiers on deploy targets and surfaces Docker sandbox choices separately", async () => {
    process.env.ENABLED_BACKENDS = "docker,nemoclaw,k8s,proxmox";
    process.env.KUBECONFIG = "/tmp/test-kubeconfig";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);

    const dockerTarget = res.body.executionTargets.find((target) => target.id === "docker");
    const k8sTarget = res.body.executionTargets.find((target) => target.id === "k8s");
    const proxmoxTarget = res.body.executionTargets.find((target) => target.id === "proxmox");

    expect(dockerTarget).toEqual(
      expect.objectContaining({
        enabled: true,
        available: true,
        maturityTier: "ga",
        supportsSandboxSelection: true,
        enabledSandboxProfiles: expect.arrayContaining(["standard", "nemoclaw"]),
      })
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
      ])
    );

    expect(k8sTarget).toEqual(
      expect.objectContaining({
        enabled: true,
        available: true,
        maturityTier: "beta",
        supportsSandboxSelection: false,
      })
    );

    expect(proxmoxTarget).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        maturityTier: "blocked",
        availableForOnboarding: false,
      })
    );
  });

  it("surfaces Hermes as a distinct runtime family and backend when ENABLED_RUNTIME_FAMILIES enables it", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "hermes";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        defaultRuntimeFamily: "hermes",
        defaultDeployTarget: "docker",
        defaultSandboxProfile: "standard",
      })
    );
    expect(res.body.runtimeFamily).toEqual(
      expect.objectContaining({
        id: "hermes",
        label: "Hermes",
        contractStatusLabel: "Deployment-first contract",
      })
    );
    expect(res.body.executionTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "docker",
          runtimeFamily: "hermes",
          defaultSandboxProfile: "standard",
        }),
      ])
    );
    expect(res.body.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hermes",
          runtimeFamily: "hermes",
          selectionType: "runtime_family",
          deployTarget: "docker",
          sandboxProfile: "standard",
        }),
      ])
    );
  });

  it("keeps legacy ENABLED_BACKENDS=hermes working for Hermes enablement", async () => {
    process.env.ENABLED_BACKENDS = "hermes";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.defaultRuntimeFamily).toBe("hermes");
    expect(res.body.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hermes",
          runtimeFamily: "hermes",
        }),
      ])
    );
  });

  it("fills in a default backend for runtime families that are enabled without an explicit backend", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
    process.env.ENABLED_BACKENDS = "k8s";
    process.env.KUBECONFIG = "/tmp/test-kubeconfig";

    const res = await request(app).get("/config/backends");

    expect(res.status).toBe(200);
    expect(res.body.enabledBackends).toEqual(["k8s", "hermes"]);
    expect(res.body.runtimeFamilies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openclaw" }),
        expect.objectContaining({ id: "hermes" }),
      ])
    );
    expect(res.body.backends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "k8s",
          enabled: true,
        }),
        expect.objectContaining({
          id: "hermes",
          enabled: true,
        }),
        expect.objectContaining({
          id: "docker",
          enabled: false,
        }),
      ])
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
          command: "git pull --ff-only && docker compose up -d --build",
          steps: expect.arrayContaining([
            expect.stringContaining("repo root"),
          ]),
        }),
      })
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
      })
    );
    expect(res.body.release).toEqual(
      expect.objectContaining({
        currentVersion: "1.2.3",
        latestVersion: "v1.3.0",
        publishedAt: "2026-04-11T08:30:00.000Z",
        releaseNotesUrl:
          "https://github.com/solomon2773/nora/releases/tag/v1.3.0",
        latestSource: "github",
        latestRepo: "solomon2773/nora",
        updateAvailable: true,
      })
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
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: null,
        status: "running",
      }],
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
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.10:18789",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/html", "Accept-Encoding": "identity" }),
      })
    );
    expect(res.text).toContain('<base href="/api/agents/agent-1/gateway/embed/">');
    expect(res.text).toContain('<script src="/api/agents/agent-1/gateway/embed/bootstrap.js"></script>');
    expect(res.text).not.toContain("window.__NORA_EMBED_AUTO_LOGIN__ = true");
    expect(res.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("__nora_gateway_embed_agent-1="),
    ]));
    expect(res.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self' ws: wss:");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("serves the bootstrap script from an embed session cookie and uses wss behind HTTPS proxies", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: null,
        status: "running",
      }],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed/bootstrap.js?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    expect(res.text).toContain("wss://nora.test/api/ws/gateway/agent-1?token=");
    expect(res.text).toContain('var nextHash = "password=" + encodeURIComponent(P)');
    expect(res.text).toContain("window.__NORA_EMBED_AUTO_LOGIN__ = true");
    expect(res.text).toContain("function startAutoLogin()");
    expect(res.text).toContain("form.requestSubmit");
    expect(res.text).toContain("new MutationObserver");
    expect(res.text).not.toContain("localStorage.setItem('oc-gateway-url',R)");
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
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head></head><body>ok</body></html>",
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://gateway.internal:19123",
      expect.any(Object)
    );
  });

  it("prefers explicit gateway host and port when the backend provides them", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: 19123,
        gateway_host: "gateway.service.internal",
        gateway_port: 28789,
        status: "running",
      }],
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
      "http://gateway.service.internal:28789",
      expect.any(Object)
    );
  });

  it("prefers an explicit gateway host even when the backend exposes the gateway via a published port", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: 19123,
        gateway_host: "nora-kind-control-plane",
        status: "running",
      }],
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
      "http://nora-kind-control-plane:19123",
      expect.any(Object)
    );
  });

  it("allows embed for warning agents so degraded control-plane recovery still works", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: 19123,
        status: "warning",
      }],
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
      "http://host.docker.internal:19123",
      expect.any(Object)
    );
  });

  it("rejects embed for stopped agents so stale control-plane state stays closed", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_token: "gateway-password",
        gateway_host_port: 19123,
        status: "stopped",
      }],
    });

    const res = await request(app)
      .get(`/agents/agent-1/gateway/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
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

  it("uses GATEWAY_HOST for asset proxy access when a published gateway port is recorded", async () => {
    process.env.GATEWAY_HOST = "gateway.external";
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_host_port: 19123,
        status: "running",
      }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => new TextEncoder().encode("console.log('proxy')").buffer,
    });

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://gateway.external:19123/assets/app.js",
      expect.any(Object)
    );
  });

  it("uses the default 18789 gateway contract for asset proxy access when no host port is published", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.10",
        gateway_host_port: null,
        status: "running",
      }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/javascript" }),
      arrayBuffer: async () => new TextEncoder().encode("console.log('default-port')").buffer,
    });

    const res = await request(app)
      .get("/agents/agent-1/gateway/assets/app.js")
      .set("Host", "nora.test");

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://10.0.0.10:18789/assets/app.js",
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

  it("proxies embed-relative config and navigation paths via the embed session cookie", async () => {
    const agentClient = request.agent(app);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: null,
          status: "running",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: null,
          status: "running",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.10",
          gateway_token: "gateway-password",
          gateway_host_port: null,
          status: "running",
        }],
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
      expect.any(Object)
    );

    const chatRes = await agentClient
      .get("/agents/agent-1/gateway/embed/chat?session=main")
      .set("Host", "nora.test");

    expect(chatRes.status).toBe(200);
    expect(chatRes.text).toContain('<script src="/api/agents/agent-1/gateway/embed/bootstrap.js"></script>');
    expect(chatRes.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://10.0.0.10:18789/chat?session=main",
      expect.any(Object)
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
        rows: [{
          host: "10.0.0.40",
          runtime_host: "10.0.0.40",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "hermes",
          status: "warning",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.40",
          runtime_host: "10.0.0.40",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "hermes",
          status: "warning",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.40",
          runtime_host: "10.0.0.40",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "hermes",
          status: "warning",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.40",
          runtime_host: "10.0.0.40",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "hermes",
          status: "warning",
        }],
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
          'const api="/api/status";Ex.createRoot(document.getElementById("root")).render(r.jsx($y,{children:r.jsx(Gb,{children:r.jsx("div",{children:"ok"})})}));',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/css" }),
        text: async () => '@font-face{src:url(/fonts/Mondwest.woff2)}',
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
    expect(htmlRes.text).toContain(
      'src="/api/agents/agent-1/hermes-ui/embed/assets/index.js"'
    );
    expect(htmlRes.text).toContain(
      'href="/api/agents/agent-1/hermes-ui/embed/assets/index.css"'
    );
    expect(htmlRes.text).toContain(
      'href="/api/agents/agent-1/hermes-ui/embed/favicon.ico"'
    );
    expect(htmlRes.text).toContain(
      'window.__HERMES_SESSION_TOKEN__="dash-session"'
    );
    expect(htmlRes.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("__nora_hermes_embed_agent-1="),
      ])
    );
    expect(htmlRes.headers["content-security-policy"]).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://10.0.0.40:9119",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/html",
          "Accept-Encoding": "identity",
        }),
      })
    );

    const jsRes = await agentClient
      .get("/agents/agent-1/hermes-ui/embed/assets/index.js")
      .set("Host", "nora.test");

    expect(jsRes.status).toBe(200);
    expect(jsRes.text).toContain(
      '"/api/agents/agent-1/hermes-ui/embed/api/status"'
    );
    expect(jsRes.text).toContain(
      'basename:"/api/agents/agent-1/hermes-ui/embed"'
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://10.0.0.40:9119/assets/index.js",
      expect.any(Object)
    );

    const cssRes = await agentClient
      .get("/agents/agent-1/hermes-ui/embed/assets/index.css")
      .set("Host", "nora.test");

    expect(cssRes.status).toBe(200);
    expect(cssRes.text).toContain(
      "url(/api/agents/agent-1/hermes-ui/embed/fonts/Mondwest.woff2)"
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://10.0.0.40:9119/assets/index.css",
      expect.any(Object)
    );

    const apiRes = await agentClient
      .get("/agents/agent-1/hermes-ui/embed/api/env")
      .set("Host", "nora.test")
      .set("Authorization", "Bearer hermes-session-token");

    expect(apiRes.status).toBe(200);
    expect(apiRes.text).toBe('{"ok":true}');
    expect(apiRes.headers["cache-control"]).toBe("no-store");
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      "http://10.0.0.40:9119/api/env",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-session-token",
        }),
      })
    );
  });

  it("forwards protected dashboard writes through the embed session cookie", async () => {
    const agentClient = request.agent(app);
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.41",
          runtime_host: "10.0.0.41",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "hermes",
          status: "running",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          host: "10.0.0.41",
          runtime_host: "10.0.0.41",
          runtime_port: 8642,
          runtime_family: "hermes",
          backend_type: "hermes",
          status: "running",
        }],
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
      .send({ config: { model: "gpt-5.4" } });

    expect(apiRes.status).toBe(200);
    expect(apiRes.text).toBe('{"ok":true}');
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://10.0.0.41:9119/api/config",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer hermes-session-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ config: { model: "gpt-5.4" } }),
      })
    );
  });

  it("rejects embed requests for stopped Hermes agents", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        host: "10.0.0.40",
        runtime_host: "10.0.0.40",
        runtime_port: 8642,
        runtime_family: "hermes",
        backend_type: "hermes",
        status: "stopped",
      }],
    });

    const res = await request(app)
      .get(`/agents/agent-1/hermes-ui/embed?token=${encodeURIComponent(token)}`)
      .set("Host", "nora.test");

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
