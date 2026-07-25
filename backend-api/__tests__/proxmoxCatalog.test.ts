// @ts-nocheck
const {
  PROXMOX_NEMOCLAW_BLOCKER_ISSUE,
  getBackendCatalog,
  getBackendStatus,
  getDefaultBackend,
  getRuntimeSelectionStatus,
  isProxmoxApiTokenId,
} = require("../../agent-runtime/lib/backendCatalog");

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = [
  "NODE_ENV",
  "ENABLED_BACKENDS",
  "ENABLED_RUNTIME_FAMILIES",
  "ENABLED_SANDBOX_PROFILES",
  "PROXMOX_API_URL",
  "PROXMOX_ALLOW_INSECURE_HTTP",
  "PROXMOX_VERIFY_TLS",
  "PROXMOX_CA_CERT",
  "PROXMOX_CA_CERT_PATH",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_TOKEN_SECRET",
  "PROXMOX_NODE",
  "PROXMOX_SSH_HOST",
  "PROXMOX_SSH_USER",
  "PROXMOX_SSH_PORT",
  "PROXMOX_SSH_PASSWORD",
  "PROXMOX_SSH_PRIVATE_KEY",
  "PROXMOX_SSH_PRIVATE_KEY_PATH",
  "PROXMOX_SSH_HOST_FINGERPRINT",
  "PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY",
  "PROXMOX_OFFLINE_STAGE_COMMAND",
  "PROXMOX_HERMES_TEMPLATE",
  "PROXMOX_NEMOCLAW_TEMPLATE",
];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ORIGINAL_ENV, key)) {
      process.env[key] = ORIGINAL_ENV[key];
    } else {
      delete process.env[key];
    }
  }
}

function configureProxmox() {
  process.env.ENABLED_BACKENDS = "docker,proxmox";
  process.env.PROXMOX_API_URL = "https://pve.example.com:8006/api2/json";
  process.env.PROXMOX_TOKEN_ID = "nora@pve!provisioner";
  process.env.PROXMOX_TOKEN_SECRET = "secret";
  process.env.PROXMOX_SSH_HOST = "pve.example.com";
  process.env.PROXMOX_SSH_USER = "nora-bootstrap";
  process.env.PROXMOX_SSH_PASSWORD = "secret";
  process.env.PROXMOX_SSH_HOST_FINGERPRINT = `SHA256:${"A".repeat(43)}`;
  process.env.PROXMOX_OFFLINE_STAGE_COMMAND = "/usr/local/libexec/nora-proxmox-stage";
}

describe("proxmox runtime selection", () => {
  beforeEach(() => {
    restoreEnv();
    configureProxmox();
  });

  afterAll(() => {
    restoreEnv();
  });

  it("exposes a securely configured standard OpenClaw target as experimental", () => {
    process.env.NODE_ENV = "production";
    const status = getBackendStatus("proxmox");

    expect(status).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: true,
        available: true,
        availableForOnboarding: true,
        issue: null,
        maturityTier: "experimental",
      }),
    );
  });

  it("requires API-token syntax, SSH credentials, and pinned SSH host verification", () => {
    process.env.PROXMOX_TOKEN_ID = "nora@pve";
    expect(getBackendStatus("proxmox").issue).toMatch(/user@realm!tokenname/i);

    process.env.PROXMOX_TOKEN_ID = "nora@pve!provisioner";
    delete process.env.PROXMOX_SSH_HOST_FINGERPRINT;
    expect(getBackendStatus("proxmox").issue).toMatch(/host_fingerprint/i);

    process.env.PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY = "true";
    expect(getBackendStatus("proxmox").available).toBe(true);

    process.env.PROXMOX_SSH_HOST_FINGERPRINT = "SHA256:not-a-fingerprint";
    expect(getBackendStatus("proxmox").issue).toMatch(/OpenSSH SHA256 fingerprint/i);
  });

  it("validates readable CA and SSH private-key paths before advertising availability", () => {
    process.env.PROXMOX_CA_CERT_PATH = "/run/secrets/missing-proxmox-ca.pem";
    expect(getBackendStatus("proxmox").issue).toMatch(/CA certificate could not be read/i);

    process.env.PROXMOX_CA_CERT_PATH = __filename;
    delete process.env.PROXMOX_SSH_PASSWORD;
    process.env.PROXMOX_SSH_PRIVATE_KEY_PATH = "/run/secrets/missing-proxmox-key";
    expect(getBackendStatus("proxmox").issue).toMatch(/private key could not be read/i);

    process.env.PROXMOX_SSH_PRIVATE_KEY_PATH = __filename;
    expect(getBackendStatus("proxmox").available).toBe(true);
  });

  it("validates the Proxmox node and SSH port before advertising availability", () => {
    process.env.PROXMOX_NODE = "pve; reboot";
    expect(getBackendStatus("proxmox").issue).toMatch(/unsupported characters/i);

    process.env.PROXMOX_NODE = "pve-a";
    process.env.PROXMOX_SSH_PORT = "70000";
    expect(getBackendStatus("proxmox").issue).toMatch(/between 1 and 65535/i);

    process.env.PROXMOX_SSH_PORT = "22suffix";
    expect(getBackendStatus("proxmox").issue).toMatch(/between 1 and 65535/i);
  });

  it("requires the strict offline staging helper only for non-root SSH", () => {
    delete process.env.PROXMOX_OFFLINE_STAGE_COMMAND;
    expect(getBackendStatus("proxmox")).toEqual(
      expect.objectContaining({
        configured: false,
        available: false,
        availableForOnboarding: false,
      }),
    );
    expect(getBackendStatus("proxmox").issue).toMatch(/OFFLINE_STAGE_COMMAND/i);

    process.env.PROXMOX_SSH_USER = "root";
    expect(getBackendStatus("proxmox")).toEqual(
      expect.objectContaining({ configured: true, available: true, issue: null }),
    );
  });

  it("allows transport escape hatches only outside production", () => {
    process.env.PROXMOX_API_URL = "http://pve.test:8006/api2/json";
    expect(getBackendStatus("proxmox").issue).toMatch(/must use HTTPS/i);

    process.env.PROXMOX_ALLOW_INSECURE_HTTP = "true";
    expect(getBackendStatus("proxmox").available).toBe(true);

    process.env.PROXMOX_API_URL = "https://pve.test:8006/api2/json";
    process.env.PROXMOX_VERIFY_TLS = "false";
    expect(getBackendStatus("proxmox").available).toBe(true);
  });

  it.each([
    ["PROXMOX_ALLOW_INSECURE_HTTP", "true"],
    ["PROXMOX_VERIFY_TLS", "false"],
    ["PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY", "true"],
  ])("rejects %s in production", (name, value) => {
    process.env.NODE_ENV = "production";
    process.env[name] = value;
    if (name === "PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY") {
      delete process.env.PROXMOX_SSH_HOST_FINGERPRINT;
    }

    const status = getBackendStatus("proxmox");
    expect(status.available).toBe(false);
    expect(status.availableForOnboarding).toBe(false);
    expect(status.issue).toMatch(/not allowed when NODE_ENV=production/i);
  });

  it("supports Hermes only when a prepared LXC template is configured", () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";

    expect(
      getRuntimeSelectionStatus({
        runtime_family: "hermes",
        deploy_target: "proxmox",
        sandbox_profile: "standard",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        issue: "Hermes on Proxmox requires PROXMOX_HERMES_TEMPLATE.",
      }),
    );

    process.env.PROXMOX_HERMES_TEMPLATE = "local:vztmpl/nora-hermes-2026.7.tar.zst";
    expect(
      getRuntimeSelectionStatus({
        runtime_family: "hermes",
        deploy_target: "proxmox",
        sandbox_profile: "standard",
      }),
    ).toEqual(expect.objectContaining({ enabled: true, available: true, issue: null }));
  });

  it("keeps NemoClaw blocked until Proxmox enforces the actual sandbox contract", () => {
    process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";
    process.env.PROXMOX_NEMOCLAW_TEMPLATE = "local:vztmpl/nora-nemoclaw.tar.zst";

    expect(
      getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "proxmox",
        sandbox_profile: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        available: false,
        issue: PROXMOX_NEMOCLAW_BLOCKER_ISSUE,
      }),
    );
    const target = getBackendCatalog().find((backend) => backend.id === "proxmox");
    expect(target.sandboxProfiles.find((option) => option.id === "nemoclaw")).toEqual(
      expect.objectContaining({ maturityTier: "blocked", availableForOnboarding: false }),
    );
  });

  it("preserves Docker as the default while it remains the first available target", () => {
    const catalog = getBackendCatalog();

    expect(getDefaultBackend(process.env, { sandbox: "standard" })).toBe("docker");
    expect(catalog.find((backend) => backend.id === "docker")?.isDefault).toBe(true);
    expect(catalog.find((backend) => backend.id === "proxmox")?.isDefault).toBe(false);
  });

  it("validates the full user@realm!tokenname token id", () => {
    expect(isProxmoxApiTokenId("nora@pve!provisioner")).toBe(true);
    expect(isProxmoxApiTokenId("root@pam")).toBe(false);
    expect(isProxmoxApiTokenId("root!token")).toBe(false);
    expect(isProxmoxApiTokenId("root@pam!token!extra")).toBe(false);
  });
});
