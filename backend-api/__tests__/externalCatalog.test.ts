// @ts-nocheck
const {
  getBackendCatalog,
  getExecutionTargetMetadata,
  isKnownDeployTarget,
  normalizeDeployTargetName,
  normalizeExecutionTargetId,
} = require("../../agent-runtime/lib/backendCatalog");

// BYOC Phase C: 'external' is a recognized deploy_target/execution_target VALUE
// for an ADOPTED, already-running runtime — but deliberately NOT a deployable
// target (no provisioner, no deploy-catalog card).
describe("external (adopted runtime) catalog recognition", () => {
  it("normalizes the external deploy target", () => {
    expect(normalizeDeployTargetName("external")).toBe("external");
    expect(normalizeDeployTargetName("EXTERNAL")).toBe("external");
    expect(() => normalizeDeployTargetName("moon")).toThrow("Unknown deploy target: moon");
  });

  it("normalizes the external execution target id", () => {
    expect(normalizeExecutionTargetId("external")).toBe("external");
    expect(normalizeExecutionTargetId("unknown")).toBeNull();
    // existing prefixes intact
    expect(normalizeExecutionTargetId("remote:my-vps")).toBe("remote:my-vps");
    expect(normalizeExecutionTargetId("k8s:prod")).toBe("k8s:prod");
  });

  it("recognizes external as a known deploy target", () => {
    expect(isKnownDeployTarget("external")).toBe(true);
    expect(isKnownDeployTarget("docker")).toBe(true);
    expect(isKnownDeployTarget("nope")).toBe(false);
  });

  it("exposes external execution-target metadata", () => {
    const meta = getExecutionTargetMetadata("external");
    expect(meta).toMatchObject({ id: "external", label: "External runtime" });
  });

  it("does NOT surface external as a deployable catalog card", () => {
    const catalog = getBackendCatalog();
    expect(catalog.some((b) => b.id === "external")).toBe(false);
    // existing deployable targets remain
    expect(catalog.some((b) => b.id === "docker")).toBe(true);
    expect(catalog.some((b) => b.id === "remote-docker")).toBe(true);
    expect(catalog.some((b) => b.id === "proxmox")).toBe(true);
  });
});
