// @ts-nocheck
const {
  buildAgentRuntimeFields,
  isSameRuntimePath,
  resolveRequestedRuntimeFields,
} = require("../agentRuntimeFields");

const ENV_KEYS = ["ENABLED_BACKENDS", "ENABLED_RUNTIME_FAMILIES", "ENABLED_SANDBOX_PROFILES"];

function clearRuntimeEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("agent runtime fields", () => {
  afterEach(() => {
    clearRuntimeEnv();
  });

  it("does not infer NemoClaw from legacy backend_type rows", () => {
    expect(
      buildAgentRuntimeFields({
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "docker",
        sandbox_type: "nemoclaw",
      }),
    );
  });

  it("does not infer Hermes from legacy backend_type rows", () => {
    expect(
      buildAgentRuntimeFields({
        backend_type: "hermes",
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "docker",
        sandbox_type: "standard",
      }),
    );
  });

  it("allows blank canonical targets to use the legacy-row default", () => {
    expect(
      buildAgentRuntimeFields({
        deploy_target: "   ",
        backend_type: "hermes",
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        sandbox_profile: "standard",
        backend_type: "docker",
      }),
    );
  });

  it("uses a concrete execution target when the canonical deploy target is blank", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: "   ",
        execution_target_id: "remote:build-host",
        sandbox_profile: "standard",
      }),
    ).toEqual(
      expect.objectContaining({
        deploy_target: "remote-docker",
        execution_target_id: "remote:build-host",
        backend_type: "remote-docker",
      }),
    );
  });

  it.each([
    ["docker", "remote:build-host"],
    ["docker", "k8s:aks-eastus2"],
    ["proxmox", "docker"],
  ])("rejects persisted target mismatch %s + %s", (deployTarget, executionTargetId) => {
    expect(() =>
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: deployTarget,
        execution_target_id: executionTargetId,
        sandbox_profile: "standard",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "RUNTIME_SELECTION_TARGET_MISMATCH",
        statusCode: 400,
      }),
    );
  });

  it("rejects unknown persisted deploy targets instead of falling back to Docker", () => {
    expect(() =>
      buildAgentRuntimeFields({
        deploy_target: "moon",
        backend_type: "docker",
      }),
    ).toThrow(
      expect.objectContaining({
        message: "Unknown deploy target: moon",
        code: "UNKNOWN_DEPLOY_TARGET",
        statusCode: 400,
      }),
    );
  });

  it("does not let a legacy backend alias mask an unknown canonical target", () => {
    expect(() =>
      buildAgentRuntimeFields({
        deploy_target: "moon",
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      }),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it.each(["deployTarget", "execution_target_id", "executionTargetId"])(
    "rejects an unknown persisted %s alias",
    (field) => {
      expect(() =>
        buildAgentRuntimeFields({
          [field]: "moon",
          backend_type: "docker",
        }),
      ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
    },
  );

  it("prefers explicit runtime fields over stale legacy aliases", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: "k8s:test-cluster",
        sandbox_profile: "standard",
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox_profile: "standard",
        backend_type: "k8s",
        sandbox_type: "standard",
      }),
    );
  });

  it("keeps backend_type as the deploy target for Docker plus NemoClaw", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "docker",
        sandbox_type: "nemoclaw",
      }),
    );
  });

  it("keeps backend_type as the deploy target for Hermes", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "hermes",
        deploy_target: "proxmox",
        sandbox_profile: "standard",
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "proxmox",
        sandbox_profile: "standard",
        backend_type: "proxmox",
        sandbox_type: "standard",
      }),
    );
  });

  it.each(["runtime_family", "runtimeFamily"])(
    "rejects an unknown persisted %s instead of falling back to OpenClaw",
    (field) => {
      expect(() =>
        buildAgentRuntimeFields({
          [field]: "future-runtime",
          deploy_target: "docker",
          sandbox_profile: "standard",
        }),
      ).toThrow(
        expect.objectContaining({
          message: "Unknown runtime family: future-runtime",
          code: "UNKNOWN_RUNTIME_FAMILY",
          statusCode: 400,
        }),
      );
    },
  );

  it.each([
    ["docker", "remote:build-host"],
    ["docker", "k8s:aks-eastus2"],
    ["proxmox", "docker"],
  ])("rejects requested target mismatch %s + %s", (deployTarget, executionTargetId) => {
    expect(() =>
      resolveRequestedRuntimeFields({
        request: {
          deploy_target: deployTarget,
          execution_target_id: executionTargetId,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "RUNTIME_SELECTION_TARGET_MISMATCH",
        statusCode: 400,
      }),
    );
  });

  it.each(["sandbox_profile", "sandboxProfile", "sandbox_type", "sandboxType"])(
    "rejects an unknown persisted %s instead of falling back to the standard sandbox",
    (field) => {
      expect(() =>
        buildAgentRuntimeFields({
          runtime_family: "openclaw",
          deploy_target: "docker",
          [field]: "nemoclaw-typo",
        }),
      ).toThrow(
        expect.objectContaining({
          message: "Unknown sandbox profile: nemoclaw-typo",
          code: "UNKNOWN_SANDBOX_PROFILE",
          statusCode: 400,
        }),
      );
    },
  );

  it("treats a redeploy target override as a standard sandbox unless NemoClaw is explicitly requested", () => {
    process.env.ENABLED_BACKENDS = "docker";

    expect(
      resolveRequestedRuntimeFields({
        request: {
          deploy_target: "k8s:test-cluster",
        },
        fallback: {
          runtime_family: "openclaw",
          deploy_target: "docker",
          sandbox_profile: "nemoclaw",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        execution_target_id: "k8s:test-cluster",
        sandbox_profile: "standard",
        backend_type: "k8s",
        sandbox_type: "standard",
      }),
    );
  });

  it("switches to Hermes defaults when the requested runtime family changes", () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";

    expect(
      resolveRequestedRuntimeFields({
        request: {
          runtime_family: "hermes",
        },
        fallback: {
          runtime_family: "openclaw",
          deploy_target: "k8s:test-cluster",
          sandbox_profile: "standard",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "docker",
        sandbox_type: "standard",
      }),
    );
  });

  it("rejects unknown requested deploy targets instead of keeping the fallback runtime", () => {
    expect(() =>
      resolveRequestedRuntimeFields({
        request: {
          deploy_target: "moon",
          backend_type: "hermes",
        },
        fallback: {
          runtime_family: "openclaw",
          deploy_target: "docker",
          sandbox_profile: "standard",
        },
      }),
    ).toThrow(
      expect.objectContaining({
        message: "Unknown deploy target: moon",
        code: "UNKNOWN_DEPLOY_TARGET",
        statusCode: 400,
      }),
    );
  });

  it.each(["deployTarget", "execution_target_id", "executionTargetId"])(
    "rejects an unknown requested %s alias",
    (field) => {
      expect(() =>
        resolveRequestedRuntimeFields({
          request: {
            [field]: "moon",
          },
          fallback: {
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
          },
        }),
      ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET", statusCode: 400 }));
    },
  );

  it.each(["runtime_family", "runtimeFamily"])(
    "rejects an unknown requested %s instead of keeping the fallback runtime",
    (field) => {
      expect(() =>
        resolveRequestedRuntimeFields({
          request: { [field]: "future-runtime" },
          fallback: {
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
          },
        }),
      ).toThrow(expect.objectContaining({ code: "UNKNOWN_RUNTIME_FAMILY", statusCode: 400 }));
    },
  );

  it.each(["sandbox_profile", "sandboxProfile", "sandbox", "sandbox_type", "sandboxType"])(
    "rejects an unknown requested %s instead of keeping the fallback sandbox",
    (field) => {
      expect(() =>
        resolveRequestedRuntimeFields({
          request: { [field]: "nemoclaw-typo" },
          fallback: {
            runtime_family: "openclaw",
            deploy_target: "docker",
            sandbox_profile: "standard",
          },
        }),
      ).toThrow(expect.objectContaining({ code: "UNKNOWN_SANDBOX_PROFILE", statusCode: 400 }));
    },
  );

  it("keeps an explicitly requested Hermes Kubernetes target", () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";

    expect(
      resolveRequestedRuntimeFields({
        request: {
          runtime_family: "hermes",
          deploy_target: "k8s:aks-eastus2",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "k8s",
        execution_target_id: "k8s:aks-eastus2",
        sandbox_profile: "standard",
        backend_type: "k8s",
        sandbox_type: "standard",
      }),
    );
  });

  it("uses the enabled sandbox default when NemoClaw is the only OpenClaw sandbox profile", () => {
    process.env.ENABLED_SANDBOX_PROFILES = "nemoclaw";

    expect(resolveRequestedRuntimeFields()).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "docker",
        sandbox_type: "nemoclaw",
      }),
    );
  });

  it("uses the Hermes runtime-family default when Hermes is the only enabled runtime family", () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "hermes";

    expect(resolveRequestedRuntimeFields()).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "docker",
        sandbox_type: "standard",
      }),
    );
  });

  it("rejects deprecated deploy-target aliases instead of redirecting them to Docker", () => {
    expect(() =>
      isSameRuntimePath(
        {
          backend_type: "kubernetes",
          sandbox_type: "standard",
        },
        {
          runtime_family: "openclaw",
          deploy_target: "k8s:test-cluster",
          sandbox_profile: "standard",
        },
      ),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("distinguishes Docker sandbox profiles", () => {
    expect(
      isSameRuntimePath(
        {
          backend_type: "docker",
          sandbox_type: "standard",
        },
        {
          runtime_family: "openclaw",
          deploy_target: "docker",
          sandbox_profile: "nemoclaw",
        },
      ),
    ).toBe(false);
  });

  it("requires concrete Kubernetes execution target ids instead of K3s aliases", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: "k8s:k3s-local",
        sandbox_profile: "nemoclaw",
      }),
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        execution_target_id: "k8s:k3s-local",
        sandbox_profile: "nemoclaw",
        backend_type: "k8s",
        sandbox_type: "nemoclaw",
      }),
    );

    expect(
      resolveRequestedRuntimeFields({
        request: {
          deploy_target: "k8s:k3s-local",
          sandbox_profile: "nemoclaw",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        deploy_target: "k8s",
        execution_target_id: "k8s:k3s-local",
        sandbox_profile: "nemoclaw",
        backend_type: "k8s",
      }),
    );
  });
});
