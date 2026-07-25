import { describe, expect, it } from "vitest";
import "tsx/cjs";

const backendCatalog = require("../lib/backendCatalog.ts");

const { getBackendStatus, getRuntimeSelectionStatus, normalizeDeployTargetName } = backendCatalog;

describe("deploy-target normalization", () => {
  it("defaults absent input to Docker", () => {
    expect(normalizeDeployTargetName(undefined)).toBe("docker");
    expect(normalizeDeployTargetName(null)).toBe("docker");
    expect(normalizeDeployTargetName("")).toBe("docker");
    expect(normalizeDeployTargetName("   ")).toBe("docker");
  });

  it("rejects nonempty unknown deploy targets", () => {
    expect(() => normalizeDeployTargetName("moon")).toThrowError(
      expect.objectContaining({
        message: "Unknown deploy target: moon",
        code: "UNKNOWN_DEPLOY_TARGET",
        statusCode: 400,
      }),
    );
  });
});

describe("runtime selection status validation", () => {
  const env = {
    ENABLED_RUNTIME_FAMILIES: "openclaw,hermes",
    ENABLED_BACKENDS: "docker,k8s",
    ENABLED_SANDBOX_PROFILES: "standard,nemoclaw",
  };

  it.each([
    [
      { runtimeFamily: "unknown-runtime", deployTarget: "docker", sandboxProfile: "standard" },
      "UNKNOWN_RUNTIME_FAMILY",
      "Unknown runtime family: unknown-runtime",
    ],
    [
      {
        runtimeFamily: "openclaw",
        deployTarget: "docker",
        executionTargetId: "unknown-target",
        sandboxProfile: "standard",
      },
      "UNKNOWN_EXECUTION_TARGET",
      "Unknown execution target: unknown-target",
    ],
    [
      { runtimeFamily: "openclaw", deployTarget: "docker", sandboxProfile: "unknown-sandbox" },
      "UNKNOWN_SANDBOX_PROFILE",
      "Unknown sandbox profile: unknown-sandbox",
    ],
  ])("rejects nonempty unknown runtime selection fields", (selection, code, message) => {
    expect(() => getRuntimeSelectionStatus(selection, env)).toThrowError(
      expect.objectContaining({ code, statusCode: 400, message }),
    );
  });

  it("marks contradictory deploy and execution targets unavailable", () => {
    expect(
      getRuntimeSelectionStatus(
        {
          runtimeFamily: "openclaw",
          deployTarget: "docker",
          executionTargetId: "k8s:prod",
          sandboxProfile: "standard",
        },
        env,
      ),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: false,
        available: false,
        issue: "Execution target k8s:prod belongs to deploy target k8s, not docker.",
      }),
    );
  });
});

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
    PROXMOX_OFFLINE_STAGE_COMMAND: "/usr/local/libexec/nora-proxmox-stage",
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

  it.each([
    ["PROXMOX_PCT_COMMAND", "pct --help", /single command name/i],
    ["PROXMOX_PCT_COMMAND", "pct;id", /single command name/i],
    ["PROXMOX_PCT_COMMAND", "-pct", /single command name/i],
    ["PROXMOX_SUDO", "sudo", /exactly 'sudo -n'/i],
    ["PROXMOX_SUDO", "sudo -n id", /exactly 'sudo -n'/i],
    ["PROXMOX_SUDO", "/usr/bin/doas -n", /must invoke the sudo executable/i],
  ])("rejects unsafe host command configuration in %s", (name, value, issuePattern) => {
    const status = getBackendStatus("proxmox", secureProxmoxEnv({ [name]: value }));

    expect(status.configured).toBe(false);
    expect(status.available).toBe(false);
    expect(status.availableForOnboarding).toBe(false);
    expect(status.issue).toMatch(issuePattern);
  });

  it("requires a validated offline staging helper for non-root SSH", () => {
    const missing = getBackendStatus(
      "proxmox",
      secureProxmoxEnv({ PROXMOX_OFFLINE_STAGE_COMMAND: "" }),
    );
    expect(missing).toEqual(
      expect.objectContaining({
        configured: false,
        available: false,
        availableForOnboarding: false,
      }),
    );
    expect(missing.issue).toMatch(/Non-root Proxmox SSH requires PROXMOX_OFFLINE_STAGE_COMMAND/i);

    for (const helper of [
      "nora-proxmox-stage",
      "/usr/local/libexec/nora-proxmox-stage --unsafe",
      "/usr/local/libexec/../bin/nora-proxmox-stage",
      "/usr/local/libexec/nora-proxmox-stage/",
    ]) {
      expect(
        getBackendStatus("proxmox", secureProxmoxEnv({ PROXMOX_OFFLINE_STAGE_COMMAND: helper }))
          .issue,
      ).toMatch(/one absolute executable path/i);
    }
  });

  it("keeps root SSH as the supported baseline without a staging helper", () => {
    expect(
      getBackendStatus(
        "proxmox",
        secureProxmoxEnv({
          PROXMOX_SSH_USER: "root",
          PROXMOX_OFFLINE_STAGE_COMMAND: "",
        }),
      ),
    ).toEqual(expect.objectContaining({ configured: true, available: true, issue: null }));
  });
});
