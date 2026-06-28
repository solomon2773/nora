// @ts-nocheck
const {
  getBackendCatalog,
  getBackendStatus,
  getDefaultBackend,
  getRuntimeSelectionStatus,
  isKnownDeployTarget,
  normalizeDeployTargetName,
  normalizeExecutionTargetId,
} = require("../../agent-runtime/lib/backendCatalog");

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = ["ENABLED_BACKENDS", "ENABLED_RUNTIME_FAMILIES", "ENABLED_SANDBOX_PROFILES"];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ORIGINAL_ENV, key)) {
      process.env[key] = ORIGINAL_ENV[key];
    } else {
      delete process.env[key];
    }
  }
}

describe("remote-docker deploy target recognition", () => {
  afterEach(() => restoreEnv());

  describe("normalizers", () => {
    it("maps the remote: execution-target prefix to the remote-docker deploy target", () => {
      expect(normalizeDeployTargetName("remote-docker")).toBe("remote-docker");
      expect(normalizeDeployTargetName("remote:my-laptop")).toBe("remote-docker");
      expect(normalizeDeployTargetName("REMOTE:My-Laptop")).toBe("remote-docker");
    });

    it("does not let remote-docker change the docker fallback for unknown targets", () => {
      expect(normalizeDeployTargetName("moon")).toBe("docker");
      expect(normalizeDeployTargetName("")).toBe("docker");
      expect(normalizeDeployTargetName("docker")).toBe("docker");
    });

    it("normalizes remote: execution-target ids and slugs the host id", () => {
      expect(normalizeExecutionTargetId("remote:My_Laptop")).toBe("remote:my-laptop");
      expect(normalizeExecutionTargetId("remote:  spaced  host ")).toBe("remote:spaced-host");
      expect(normalizeExecutionTargetId("remote-docker")).toBe("remote-docker");
      expect(normalizeExecutionTargetId("remote:")).toBe("remote-docker");
    });

    it("leaves the k8s prefix handling intact", () => {
      expect(normalizeExecutionTargetId("k8s:aks-eastus2")).toBe("k8s:aks-eastus2");
      expect(normalizeDeployTargetName("k8s:aks-eastus2")).toBe("k8s");
    });

    it("recognizes remote targets as known deploy targets", () => {
      expect(isKnownDeployTarget("remote-docker")).toBe(true);
      expect(isKnownDeployTarget("remote:my-laptop")).toBe(true);
      expect(isKnownDeployTarget("nope")).toBe(false);
    });
  });

  describe("runtime selection", () => {
    beforeEach(() => {
      process.env.ENABLED_BACKENDS = "docker";
      process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
      process.env.ENABLED_SANDBOX_PROFILES = "standard";
    });

    it("allows an OpenClaw deploy once a remote host target is selected", () => {
      const status = getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "remote-docker",
        execution_target_id: "remote:my-laptop",
        sandbox_profile: "standard",
      });
      expect(status.enabled).toBe(true);
      expect(status.configured).toBe(true);
      expect(status.available).toBe(true);
      expect(status.issue).toBeNull();
      expect(status.deployTarget).toBe("remote-docker");
      expect(status.executionTargetId).toBe("remote:my-laptop");
    });

    it("blocks a remote-docker deploy when no host target is registered", () => {
      const status = getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "remote-docker",
        sandbox_profile: "standard",
      });
      expect(status.available).toBe(false);
      expect(status.issue).toMatch(/registered host such as remote:/i);
    });

    it("never enables remote-docker through ENABLED_BACKENDS alone (no registered host)", () => {
      process.env.ENABLED_BACKENDS = "docker,remote-docker";
      const status = getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "remote-docker",
        sandbox_profile: "standard",
      });
      // remote-docker is filtered out of ENABLED_BACKENDS parsing; availability
      // comes only from a registered remote:<id> target.
      expect(status.available).toBe(false);
    });

    it("lets Hermes target a registered remote Docker host (BYOC Phase B2)", () => {
      const status = getRuntimeSelectionStatus({
        runtime_family: "hermes",
        deploy_target: "remote-docker",
        execution_target_id: "remote:my-laptop",
        sandbox_profile: "standard",
      });
      expect(status.available).toBe(true);
      expect(status.issue).toBeNull();
      expect(status.deployTarget).toBe("remote-docker");
    });

    it("lets NemoClaw target a registered remote Docker host when the sandbox is enabled", () => {
      process.env.ENABLED_SANDBOX_PROFILES = "standard,nemoclaw";
      const status = getRuntimeSelectionStatus({
        runtime_family: "openclaw",
        deploy_target: "remote-docker",
        execution_target_id: "remote:my-laptop",
        sandbox_profile: "nemoclaw",
      });
      expect(status.available).toBe(true);
      expect(status.issue).toBeNull();
      expect(status.deployTarget).toBe("remote-docker");
      expect(status.sandboxProfile).toBe("nemoclaw");
    });
  });

  describe("catalog surfacing", () => {
    beforeEach(() => {
      process.env.ENABLED_BACKENDS = "docker";
      process.env.ENABLED_RUNTIME_FAMILIES = "openclaw";
      process.env.ENABLED_SANDBOX_PROFILES = "standard";
    });

    it("surfaces remote-docker as an experimental, currently-unavailable target", () => {
      const status = getBackendStatus("remote-docker");
      expect(status.id).toBe("remote-docker");
      expect(status.maturityTier).toBe("experimental");
      expect(status.available).toBe(false);
      expect(status.label).toMatch(/Remote/i);
    });

    it("keeps docker the default and leaves existing targets unchanged", () => {
      expect(getDefaultBackend(process.env, { sandbox: "standard" })).toBe("docker");
      const catalog = getBackendCatalog();
      expect(catalog.find((b) => b.id === "docker")?.isDefault).toBe(true);
      expect(catalog.find((b) => b.id === "remote-docker")?.isDefault).toBe(false);
      expect(catalog.find((b) => b.id === "remote-docker")?.availableForOnboarding).toBe(false);
      // existing non-cluster targets still present (k8s only surfaces per registered cluster)
      expect(catalog.some((b) => b.id === "docker")).toBe(true);
      expect(catalog.some((b) => b.id === "proxmox")).toBe(true);
      expect(catalog.some((b) => b.id === "remote-docker")).toBe(true);
    });
  });
});
