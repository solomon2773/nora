// @ts-nocheck
const {
  buildKubernetesClusterExecutionTargetEntry,
  getBackendCatalog,
  getDefaultBackend,
  getEnabledBackends,
  getRuntimeSelectionStatus,
} = require("../../agent-runtime/lib/backendCatalog");

describe("backend catalog kubernetes policy capability metadata", () => {
  it("surfaces supported NetworkPolicy metadata on Kubernetes execution targets", () => {
    const entry = buildKubernetesClusterExecutionTargetEntry("openclaw", {
      id: "test-cluster",
      executionTargetId: "k8s:test-cluster",
      label: "Test Cluster",
      enabled: true,
      configured: true,
      available: true,
      supportsNetworkPolicy: true,
      policyEngine: "cilium",
      policySupportStatus: "supported",
      policyIssue: null,
    });

    expect(entry.supportsNetworkPolicy).toBe(true);
    expect(entry.policyEngine).toBe("cilium");
    expect(entry.policySupportStatus).toBe("supported");
    expect(entry.policyIssue).toBeNull();
    expect(entry.sandboxProfiles.every((option) => option.supportsNetworkPolicy === true)).toBe(
      true,
    );
  });

  it("surfaces degraded NetworkPolicy metadata on Kubernetes execution targets", () => {
    const entry = buildKubernetesClusterExecutionTargetEntry("openclaw", {
      id: "test-cluster",
      executionTargetId: "k8s:test-cluster",
      label: "Test Cluster",
      enabled: true,
      configured: true,
      available: true,
      supportsNetworkPolicy: false,
      policyEngine: null,
    });

    expect(entry.supportsNetworkPolicy).toBe(false);
    expect(entry.policyEngine).toBeNull();
    expect(entry.policySupportStatus).toBe("degraded");
    expect(entry.policyIssue).toMatch(/degraded mode/i);
    expect(entry.sandboxProfiles.every((option) => option.policySupportStatus === "degraded")).toBe(
      true,
    );
  });
});

describe("backend catalog k8s-only control planes", () => {
  const env = {
    ENABLED_BACKENDS: "k8s",
    ENABLED_RUNTIME_FAMILIES: "openclaw",
    ENABLED_SANDBOX_PROFILES: "standard",
  };

  it("treats k8s as an explicit no-local-Docker configuration", () => {
    expect(getEnabledBackends(env)).toEqual(["k8s"]);
    expect(getDefaultBackend(env)).toBe("k8s");
    expect(
      getRuntimeSelectionStatus(
        { runtime_family: "openclaw", deploy_target: "docker", sandbox_profile: "standard" },
        env,
      ),
    ).toEqual(expect.objectContaining({ enabled: false, available: false }));

    const catalog = getBackendCatalog(env);
    expect(catalog.find((entry) => entry.id === "docker")).toEqual(
      expect.objectContaining({ enabled: false, available: false, availableForOnboarding: false }),
    );
    expect(catalog.some((entry) => entry.id === "k8s")).toBe(false);
  });

  it("surfaces only concrete registered clusters for k8s onboarding", () => {
    const catalog = getBackendCatalog(env, {
      kubernetesClusters: [
        {
          id: "primary",
          executionTargetId: "k8s:primary",
          label: "Primary cluster",
          enabled: true,
          configured: true,
          available: true,
        },
      ],
    });

    expect(catalog.find((entry) => entry.id === "k8s:primary")).toEqual(
      expect.objectContaining({ enabled: true, available: true, availableForOnboarding: true }),
    );
    expect(catalog.some((entry) => entry.id === "k8s")).toBe(false);
  });
});
