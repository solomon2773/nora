import { describe, expect, it } from "vitest";
import "tsx/cjs";

const backendCatalog = require("../lib/backendCatalog.ts");

const { getBackendStatus, getRuntimeSelectionStatus } = backendCatalog;

function secureProxmoxEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "production",
    ENABLED_BACKENDS: "docker,proxmox",
    ENABLED_RUNTIME_FAMILIES: "openclaw,hermes",
    ENABLED_SANDBOX_PROFILES: "standard",
    PROXMOX_API_URL: "https://pve.example.com:8006/api2/json",
    PROXMOX_TOKEN_ID: "nora@pve!provisioner",
    PROXMOX_TOKEN_SECRET: "secret",
    PROXMOX_NODE: "pve-a",
    PROXMOX_TEMPLATE: "local:vztmpl/ubuntu-22.04-standard.tar.zst",
    PROXMOX_HERMES_TEMPLATE: "local:vztmpl/nora-hermes-2026.7.tar.zst",
    PROXMOX_ROOTFS_STORAGE: "local-lvm",
    PROXMOX_BRIDGE: "vmbr0",
    PROXMOX_SSH_HOST: "pve.example.com",
    PROXMOX_SSH_USER: "nora-bootstrap",
    PROXMOX_SSH_PASSWORD: "secret",
    PROXMOX_SSH_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`,
    ...overrides,
  };
}

describe("Proxmox catalog preflight", () => {
  it("accepts syntactically valid templates, storage, and bridge values", () => {
    const env = secureProxmoxEnv({
      PROXMOX_TEMPLATE: "ceph_store:vztmpl/ubuntu-24.04+node24.tar.zst",
      PROXMOX_HERMES_TEMPLATE: "ceph-store:vztmpl/nora-hermes_2026.7.tar.zst",
      PROXMOX_ROOTFS_STORAGE: "ceph_store-1",
      PROXMOX_BRIDGE: "vmbr0.42",
    });

    expect(getBackendStatus("proxmox", env)).toEqual(
      expect.objectContaining({ configured: true, available: true, issue: null }),
    );
    expect(
      getRuntimeSelectionStatus(
        {
          runtimeFamily: "hermes",
          deployTarget: "proxmox",
          sandboxProfile: "standard",
        },
        env,
      ),
    ).toEqual(expect.objectContaining({ configured: true, available: true, issue: null }));
  });

  it.each([
    ["ISO paths", "local:iso/ubuntu.iso"],
    ["missing storage", "vztmpl/ubuntu.tar.zst"],
    ["option injection", "local:vztmpl/ubuntu.tar.zst,unprivileged=0"],
    ["missing archive suffix", "local:vztmpl/not-an-archive"],
    ["wrong archive type", "local:vztmpl/template.iso"],
    ["embedded volume separator", "local:vztmpl/other:template.tar.zst"],
  ])("rejects malformed OpenClaw template references (%s)", (_label, template) => {
    const status = getBackendStatus("proxmox", secureProxmoxEnv({ PROXMOX_TEMPLATE: template }));

    expect(status).toEqual(
      expect.objectContaining({
        configured: false,
        available: false,
        availableForOnboarding: false,
        issue: "PROXMOX_TEMPLATE must use storage:vztmpl/template.tar.zst format.",
      }),
    );
  });

  it("rejects a malformed Hermes template without hiding the valid OpenClaw path", () => {
    const env = secureProxmoxEnv({ PROXMOX_HERMES_TEMPLATE: "not-a-template" });

    expect(getBackendStatus("proxmox", env).available).toBe(true);
    expect(
      getRuntimeSelectionStatus(
        {
          runtimeFamily: "hermes",
          deployTarget: "proxmox",
          sandboxProfile: "standard",
        },
        env,
      ),
    ).toEqual(
      expect.objectContaining({
        configured: false,
        available: false,
        issue: "PROXMOX_HERMES_TEMPLATE must use storage:vztmpl/template.tar.zst format.",
      }),
    );
  });

  it.each([
    ["PROXMOX_ROOTFS_STORAGE", "local-lvm,backup=1", /ROOTFS_STORAGE.*unsupported/i],
    ["PROXMOX_ROOTFS_STORAGE", "local/lvm", /ROOTFS_STORAGE.*unsupported/i],
    ["PROXMOX_BRIDGE", "vmbr0,firewall=0", /BRIDGE.*1-15 character/i],
    ["PROXMOX_BRIDGE", "bridge-name-over-15", /BRIDGE.*1-15 character/i],
  ])("rejects unsafe %s syntax", (name, value, issuePattern) => {
    const status = getBackendStatus("proxmox", secureProxmoxEnv({ [name]: value }));

    expect(status.configured).toBe(false);
    expect(status.available).toBe(false);
    expect(status.availableForOnboarding).toBe(false);
    expect(status.issue).toMatch(issuePattern);
  });
});
