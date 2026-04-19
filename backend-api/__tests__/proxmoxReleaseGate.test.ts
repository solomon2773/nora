// @ts-nocheck
const {
  PROXMOX_RELEASE_BLOCKER_ISSUE,
  getBackendCatalog,
  getBackendStatus,
  getDefaultBackend,
} = require("../../agent-runtime/lib/backendCatalog");
const ProxmoxBackend = require("../../workers/provisioner/backends/proxmox");

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = [
  "ENABLED_BACKENDS",
  "ENABLED_RUNTIME_FAMILIES",
  "PROXMOX_API_URL",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_TOKEN_SECRET",
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

describe("proxmox release gate", () => {
  beforeEach(() => {
    process.env.ENABLED_BACKENDS = "proxmox,docker";
    process.env.PROXMOX_API_URL = "https://pve.example.com:8006/api2/json";
    process.env.PROXMOX_TOKEN_ID = "root@pam!openclaw";
    process.env.PROXMOX_TOKEN_SECRET = "secret";
  });

  afterEach(() => {
    restoreEnv();
  });

  it("keeps proxmox unavailable even when credentials are configured", () => {
    const status = getBackendStatus("proxmox");

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.available).toBe(false);
    expect(status.issue).toBe(PROXMOX_RELEASE_BLOCKER_ISSUE);
  });

  it("prefers a usable backend over proxmox for the default standard deployment path", () => {
    const catalog = getBackendCatalog();

    expect(getDefaultBackend(process.env, { sandbox: "standard" })).toBe("docker");
    expect(catalog.find((backend) => backend.id === "docker")?.isDefault).toBe(true);
    expect(catalog.find((backend) => backend.id === "proxmox")?.isDefault).toBe(false);
  });

  it("rejects proxmox create attempts instead of pretending a deployment succeeded", async () => {
    const backend = new ProxmoxBackend();

    await expect(
      backend.create({ id: "agent-1", name: "Blocked Proxmox Agent" })
    ).rejects.toThrow(PROXMOX_RELEASE_BLOCKER_ISSUE);
  });
});
