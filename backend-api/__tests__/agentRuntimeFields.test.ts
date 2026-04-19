// @ts-nocheck
const {
  buildAgentRuntimeFields,
  isSameRuntimePath,
  resolveRequestedRuntimeFields,
} = require("../agentRuntimeFields");

describe("agent runtime fields", () => {
  it("derives new runtime columns from legacy NemoClaw rows", () => {
    expect(
      buildAgentRuntimeFields({
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      })
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      })
    );
  });

  it("prefers new runtime fields over stale legacy aliases", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        sandbox_profile: "standard",
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      })
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        sandbox_profile: "standard",
        backend_type: "k8s",
        sandbox_type: "standard",
      })
    );
  });

  it("rebuilds the legacy backend alias from docker plus NemoClaw sandbox", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
      })
    ).toEqual(
      expect.objectContaining({
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      })
    );
  });

  it("derives Hermes runtime fields from the backend alias", () => {
    expect(
      buildAgentRuntimeFields({
        backend_type: "hermes",
      })
    ).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "hermes",
        sandbox_type: "standard",
      })
    );
  });

  it("collapses unsupported runtime-family values back to the stable OpenClaw contract", () => {
    expect(
      buildAgentRuntimeFields({
        runtime_family: "future-runtime",
        deploy_target: "docker",
        sandbox_profile: "standard",
      })
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "docker",
        sandbox_type: "standard",
      })
    );
  });

  it("treats a redeploy target override as a standard sandbox unless NemoClaw is explicitly requested", () => {
    expect(
      resolveRequestedRuntimeFields({
        request: {
          deploy_target: "k8s",
        },
        fallback: {
          runtime_family: "openclaw",
          deploy_target: "docker",
          sandbox_profile: "nemoclaw",
        },
      })
    ).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "k8s",
        sandbox_profile: "standard",
        backend_type: "k8s",
        sandbox_type: "standard",
      })
    );
  });

  it("switches to Hermes defaults when the requested runtime family changes", () => {
    expect(
      resolveRequestedRuntimeFields({
        request: {
          runtime_family: "hermes",
        },
        fallback: {
          runtime_family: "openclaw",
          deploy_target: "k8s",
          sandbox_profile: "standard",
        },
      })
    ).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "hermes",
        sandbox_type: "standard",
      })
    );
  });

  it("uses the enabled backend default when only NemoClaw is available", () => {
    process.env.ENABLED_BACKENDS = "nemoclaw";

    expect(resolveRequestedRuntimeFields()).toEqual(
      expect.objectContaining({
        runtime_family: "openclaw",
        deploy_target: "docker",
        sandbox_profile: "nemoclaw",
        backend_type: "nemoclaw",
        sandbox_type: "nemoclaw",
      })
    );

    delete process.env.ENABLED_BACKENDS;
  });

  it("uses the Hermes runtime-family default when Hermes is the only enabled runtime family", () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "hermes";

    expect(resolveRequestedRuntimeFields()).toEqual(
      expect.objectContaining({
        runtime_family: "hermes",
        deploy_target: "docker",
        sandbox_profile: "standard",
        backend_type: "hermes",
        sandbox_type: "standard",
      })
    );

    delete process.env.ENABLED_RUNTIME_FAMILIES;
  });

  it("treats legacy and new runtime metadata for the same path as equivalent", () => {
    expect(
      isSameRuntimePath(
        {
          backend_type: "kubernetes",
          sandbox_type: "standard",
        },
        {
          runtime_family: "openclaw",
          deploy_target: "k8s",
          sandbox_profile: "standard",
        }
      )
    ).toBe(true);

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
        }
      )
    ).toBe(false);
  });
});
