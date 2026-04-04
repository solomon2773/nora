const { buildReadinessWarningDetail, buildReadinessWarningMetadata, buildReadinessWarningState } = require("../../workers/provisioner/readinessWarning");

describe("buildReadinessWarningDetail", () => {
  it("formats a runtime-only readiness warning", () => {
    const detail = buildReadinessWarningDetail({
      runtime: {
        ok: false,
        url: "http://agent.internal:9090/health",
        error: "timeout after 5000ms",
      },
      gateway: { ok: true },
    });

    expect(detail).toBe(
      "runtime unavailable at http://agent.internal:9090/health (timeout after 5000ms)"
    );
  });

  it("formats a gateway-only readiness warning", () => {
    const detail = buildReadinessWarningDetail({
      runtime: { ok: true },
      gateway: {
        ok: false,
        url: "http://host.docker.internal:18789/",
        status: 502,
      },
    });

    expect(detail).toBe(
      "gateway unavailable at http://host.docker.internal:18789/ (502)"
    );
  });

  it("formats combined runtime and gateway readiness warnings", () => {
    const detail = buildReadinessWarningDetail({
      runtime: {
        ok: false,
        url: "http://agent.internal:9090/health",
        error: "connection refused",
      },
      gateway: {
        ok: false,
        url: "http://host.docker.internal:19123/",
        error: "timeout after 5000ms",
      },
    });

    expect(detail).toBe(
      "runtime unavailable at http://agent.internal:9090/health (connection refused); gateway unavailable at http://host.docker.internal:19123/ (timeout after 5000ms)"
    );
  });

  it("falls back to a generic message when readiness is malformed", () => {
    expect(buildReadinessWarningDetail({})).toBe("readiness checks failed");
  });
});

describe("buildReadinessWarningMetadata", () => {
  it("includes a flattened warning detail alongside the raw readiness payload", () => {
    const readiness = {
      runtime: {
        ok: false,
        url: "http://agent.internal:9090/health",
        error: "timeout after 5000ms",
      },
      gateway: { ok: true },
    };

    expect(buildReadinessWarningMetadata({
      agentId: "agent-123",
      host: "agent.internal",
      readiness,
    })).toEqual({
      agentId: "agent-123",
      host: "agent.internal",
      detail: "runtime unavailable at http://agent.internal:9090/health (timeout after 5000ms)",
      readiness,
    });
  });
});

describe("buildReadinessWarningState", () => {
  it("builds deterministic warning state transitions and event payloads", () => {
    const readiness = {
      runtime: {
        ok: false,
        url: "http://agent.internal:9090/health",
        error: "connection refused",
      },
      gateway: {
        ok: false,
        url: "http://host.docker.internal:19123/",
        error: "timeout after 5000ms",
      },
    };

    expect(buildReadinessWarningState({
      agentId: "agent-123",
      name: "Nora QA",
      host: "agent.internal",
      readiness,
    })).toEqual({
      agentStatus: "warning",
      deploymentStatus: "warning",
      event: {
        type: "agent_runtime_warning",
        message: "Agent \"Nora QA\" deployed with readiness warning: runtime unavailable at http://agent.internal:9090/health (connection refused); gateway unavailable at http://host.docker.internal:19123/ (timeout after 5000ms)",
        metadata: {
          agentId: "agent-123",
          host: "agent.internal",
          detail: "runtime unavailable at http://agent.internal:9090/health (connection refused); gateway unavailable at http://host.docker.internal:19123/ (timeout after 5000ms)",
          readiness,
        },
      },
    });
  });
});
