// @ts-nocheck
const mockRuntimeAuthHeaders = jest.fn();
const mockAssertRemoteHostAgentUse = jest.fn();
const mockIsRemoteDockerAgent = jest.fn();
const mockToPublicRemoteHostAuthorizationError = jest.fn();

jest.mock("../runtimeAuth", () => ({
  runtimeAuthHeaders: mockRuntimeAuthHeaders,
}));
jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
  isRemoteDockerAgent: (...args) => mockIsRemoteDockerAgent(...args),
  toPublicRemoteHostAuthorizationError: (...args) =>
    mockToPublicRemoteHostAuthorizationError(...args),
}));

const {
  buildTemplatePayloadFromAgent,
  extractTemplateDefaultsFromSnapshot,
  serializeAgent,
} = require("../agentPayloads");
const { buildAgentHubTemplateUpdate } = require("../agentHubTemplateEdits");

beforeEach(() => {
  mockRuntimeAuthHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer token" });
  mockAssertRemoteHostAgentUse.mockReset().mockResolvedValue({ id: "shared-host" });
  mockIsRemoteDockerAgent.mockReset().mockImplementation((agent) =>
    [agent?.deploy_target, agent?.backend_type, agent?.execution_target_id].some((value) =>
      String(value || "")
        .toLowerCase()
        .startsWith("remote"),
    ),
  );
  mockToPublicRemoteHostAuthorizationError.mockReset().mockImplementation((error) => error);
});

describe("serializeAgent", () => {
  it("maps network_policy_status to networkPolicyStatus", () => {
    const serialized = serializeAgent({
      id: "agent-1",
      runtime_family: "openclaw",
      deploy_target: "k8s",
      execution_target_id: "k8s:test-cluster",
      sandbox_profile: "standard",
      network_policy_status: {
        policyStatus: "supported",
        policyBundleAttempted: true,
        policyBundleApplied: true,
        policyIssue: null,
      },
    });

    expect(serialized.networkPolicyStatus).toEqual({
      policyStatus: "supported",
      policyBundleAttempted: true,
      policyBundleApplied: true,
      policyIssue: null,
    });
    expect(serialized).not.toHaveProperty("network_policy_status");
  });

  it("keeps networkPolicyStatus null when no policy state was persisted", () => {
    const serialized = serializeAgent({
      id: "agent-2",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      network_policy_status: null,
    });

    expect(serialized.networkPolicyStatus).toBeNull();
  });
});

describe("Agent Hub template deploy targets", () => {
  it("rejects unknown canonical template targets instead of defaulting installs to Docker", () => {
    expect(() =>
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            deploy_target: "moon",
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("rejects unknown template execution targets instead of defaulting installs to Docker", () => {
    expect(() =>
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            execution_target_id: "moon",
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("keeps legacy NemoClaw backend metadata on the Docker compatibility path", () => {
    expect(
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            backend: "nemoclaw",
            sandbox: "nemoclaw",
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        backend: null,
        executionTargetId: null,
        sandbox: "nemoclaw",
      }),
    );
  });

  it.each(["sandbox_profile", "sandboxProfile", "sandbox"])(
    "rejects unknown template %s values instead of downgrading to the standard sandbox",
    (field) => {
      expect(() =>
        extractTemplateDefaultsFromSnapshot({
          config: {
            defaults: {
              [field]: "nemoclaw-typo",
            },
          },
        }),
      ).toThrow(expect.objectContaining({ code: "UNKNOWN_SANDBOX_PROFILE", statusCode: 400 }));
    },
  );

  it("rejects unknown backend edits instead of retaining a deployable fallback", () => {
    expect(() =>
      buildAgentHubTemplateUpdate(
        {
          name: "Template",
          kind: "community-template",
          config: {
            defaults: {
              backend: "docker",
              sandbox: "standard",
            },
          },
        },
        { name: "Template", source_type: "community" },
        { backend: "moon" },
      ),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("rejects unknown sandbox edits instead of retaining a deployable fallback", () => {
    expect(() =>
      buildAgentHubTemplateUpdate(
        {
          name: "Template",
          kind: "community-template",
          config: {
            defaults: {
              backend: "docker",
              sandbox: "standard",
            },
          },
        },
        { name: "Template", source_type: "community" },
        { sandbox: "nemoclaw-typo" },
      ),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_SANDBOX_PROFILE", statusCode: 400 }));
  });
});

describe("buildTemplatePayloadFromAgent capture authorization", () => {
  it.each([
    "REMOTE_HOST_ACCESS_REVOKED",
    "REMOTE_HOST_RETEST_REQUIRED",
    "REMOTE_HOST_AUTH_CHECK_FAILED",
  ])("does not fall back before fetch when runtime authorization fails with %s", async (code) => {
    const authorizationError = Object.assign(new Error("remote host authorization failed"), {
      code,
    });
    mockRuntimeAuthHeaders.mockRejectedValueOnce(authorizationError);
    const fetchSpy = jest.spyOn(global, "fetch");

    try {
      await expect(
        buildTemplatePayloadFromAgent(
          {
            id: "remote-agent",
            name: "Remote agent",
            runtime_family: "openclaw",
            deploy_target: "remote-docker",
            execution_target_id: "remote:shared-host",
            runtime_host: "10.0.0.12",
            runtime_port: 9090,
            template_payload: {
              files: [
                {
                  path: "STALE.md",
                  contentBase64: Buffer.from("must not be accepted").toString("base64"),
                },
              ],
            },
          },
          "files_only",
        ),
      ).rejects.toBe(authorizationError);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(mockRuntimeAuthHeaders).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps stored-template fallback for a stopped non-remote agent", async () => {
    const payload = await buildTemplatePayloadFromAgent(
      {
        id: "stopped-local-agent",
        name: "Stopped local agent",
        status: "stopped",
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        runtime_host: null,
        template_payload: {
          metadata: {
            source: "demo-activation",
            activation: "local-docker-demo-v1",
          },
          files: [
            {
              path: "CUSTOM.md",
              contentBase64: Buffer.from("stored template").toString("base64"),
            },
          ],
        },
      },
      "files_only",
    );

    expect(payload.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "CUSTOM.md" })]),
    );
    expect(payload.metadata).toEqual({ source: "demo-activation" });
    expect(mockRuntimeAuthHeaders).not.toHaveBeenCalled();
    expect(mockAssertRemoteHostAgentUse).not.toHaveBeenCalled();
  });

  it("aborts a long Remote Docker export when its current host grant is revoked", async () => {
    const authorizationError = Object.assign(
      new Error("Remote Docker host access has been revoked"),
      { code: "REMOTE_HOST_ACCESS_REVOKED" },
    );
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host" })
      .mockRejectedValueOnce(authorizationError);

    let captureSignal = null;
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((_url, options = {}) => {
      captureSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectFromAbort = () => reject(captureSignal.reason);
        if (captureSignal.aborted) rejectFromAbort();
        else captureSignal.addEventListener("abort", rejectFromAbort, { once: true });
      });
    });

    try {
      await expect(
        buildTemplatePayloadFromAgent(
          {
            id: "remote-agent",
            user_id: "user-1",
            name: "Remote agent",
            runtime_family: "openclaw",
            deploy_target: "remote-docker",
            execution_target_id: "remote:shared-host",
            runtime_host: "10.0.0.12",
            runtime_port: 9090,
            template_payload: {
              files: [
                {
                  path: "STALE.md",
                  contentBase64: Buffer.from("must not be accepted").toString("base64"),
                },
              ],
            },
          },
          "files_only",
          { authorizationRecheckMs: 1 },
        ),
      ).rejects.toBe(authorizationError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(captureSignal?.aborted).toBe(true);
      expect(captureSignal?.reason).toBe(authorizationError);
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

      const settledCheckCount = mockAssertRemoteHostAgentUse.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(settledCheckCount);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("forwards a caller abort into a Remote Docker capture without leaking its watcher", async () => {
    const callerController = new AbortController();
    const callerError = new Error("request cancelled");
    let captureSignal = null;
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((_url, options = {}) => {
      captureSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectFromAbort = () => reject(captureSignal.reason);
        if (captureSignal.aborted) rejectFromAbort();
        else captureSignal.addEventListener("abort", rejectFromAbort, { once: true });
      });
    });

    try {
      const capture = buildTemplatePayloadFromAgent(
        {
          id: "remote-agent",
          user_id: "user-1",
          name: "Remote agent",
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: "remote:shared-host",
          runtime_host: "10.0.0.12",
          runtime_port: 9090,
        },
        "files_only",
        { signal: callerController.signal, authorizationRecheckMs: 60000 },
      );

      for (let attempt = 0; attempt < 20 && !captureSignal; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(captureSignal).toBeTruthy();
      callerController.abort(callerError);

      await expect(capture).rejects.toBe(callerError);
      expect(captureSignal).not.toBe(callerController.signal);
      expect(captureSignal.reason).toBe(callerError);
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
