// @ts-nocheck
const { spawnSync } = require("child_process");
const { PassThrough } = require("stream");

const mockDb = { query: jest.fn() };
const mockStart = jest.fn();
const mockRestart = jest.fn();
const mockStop = jest.fn();
const mockStatus = jest.fn();
const mockExec = jest.fn();
const mockIsKubernetesAgent = jest.fn();
const mockUpdateEnv = jest.fn();
const mockPersistLifecycleRuntimeAddress = jest.fn();
const mockGetProviderKeys = jest.fn();
const mockGetProviderEndpoints = jest.fn();
const mockBuildBaseUrlEnvVars = jest.fn();
const mockBuildApiVersionEnvVars = jest.fn();
const mockBuildDeploymentEnvVars = jest.fn();
const mockBuildAuthProfiles = jest.fn();
const mockGetIntegrationEnvVars = jest.fn();
const mockGetEnabledMcpRuntimeState = jest.fn();
const mockEvictConnection = jest.fn();
const mockWaitForAgentReadiness = jest.fn();
const mockWithProviderStateLock = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../containerManager", () => ({
  exec: mockExec,
  start: mockStart,
  restart: mockRestart,
  stop: mockStop,
  status: mockStatus,
  isKubernetesAgent: mockIsKubernetesAgent,
  isIgnorableStopError: jest.fn((error) =>
    /already stopped|not running/i.test(String(error?.message || "")),
  ),
  updateEnv: mockUpdateEnv,
  persistLifecycleRuntimeAddress: mockPersistLifecycleRuntimeAddress,
}));
jest.mock("../llmProviders", () => ({
  PROVIDERS: [
    { id: "openai", envVar: "OPENAI_API_KEY" },
    { id: "google", envVar: "GEMINI_API_KEY" },
    { id: "microsoft-foundry", envVar: "MICROSOFT_FOUNDRY_API_KEY" },
  ],
  getProviderKeys: mockGetProviderKeys,
  getProviderEndpoints: mockGetProviderEndpoints,
  buildBaseUrlEnvVars: mockBuildBaseUrlEnvVars,
  buildApiVersionEnvVars: mockBuildApiVersionEnvVars,
  buildDeploymentEnvVars: mockBuildDeploymentEnvVars,
  buildAuthProfiles: mockBuildAuthProfiles,
  withProviderStateLock: mockWithProviderStateLock,
  getManagedProviderEnvNames: ({ runtimeFamily } = {}) =>
    runtimeFamily === "hermes"
      ? [
          "OPENAI_API_KEY",
          "GEMINI_API_KEY",
          "NORA_HERMES_MANAGED_ENV_B64",
          "NORA_HERMES_MODEL_CONFIG_B64",
        ]
      : ["OPENAI_API_KEY", "GEMINI_API_KEY", "NORA_DEFAULT_OPENCLAW_MODEL"],
}));
jest.mock("../integrations", () => ({
  getIntegrationEnvVars: mockGetIntegrationEnvVars,
}));
jest.mock("../mcpServers", () => ({
  getEnabledMcpRuntimeState: mockGetEnabledMcpRuntimeState,
}));
jest.mock("../gatewayProxy", () => ({
  evictConnection: mockEvictConnection,
}));
jest.mock("../healthChecks", () => ({
  waitForAgentReadiness: mockWaitForAgentReadiness,
}));

const {
  buildDefaultModelCommand,
  buildHermesEnvWriteCommand,
  buildOpenClawManagedEnvForAgent,
  PROVIDER_AUTH_PENDING_REASON,
  runContainerCommand,
  runRuntimeCommand,
  resumeAgentWithProviderAuth,
  stageProviderAuthForStoppedAgent,
  syncAuthToUserAgents,
  writeAuthToContainer,
  writeHermesEnvToContainer,
} = require("../authSync");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

function execResult(output = "", exitCode = 0) {
  const stream = new PassThrough();
  setImmediate(() => {
    if (output) stream.write(output);
    stream.end();
  });
  return {
    exec: {
      inspect: jest.fn().mockResolvedValue({ Running: false, ExitCode: exitCode }),
    },
    stream,
  };
}

function decodeHermesScript(command) {
  const match = String(command || "").match(/base64\.b64decode\("([^"]+)"\)\.decode\('utf-8'\)/);
  if (!match) return "";
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("auth sync", () => {
  let consoleLogSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    mockDb.query.mockReset();
    mockExec.mockReset().mockResolvedValue(execResult());
    mockStart.mockReset().mockResolvedValue(undefined);
    mockRestart.mockReset().mockResolvedValue(undefined);
    mockStop.mockReset().mockResolvedValue(undefined);
    mockStatus.mockReset().mockResolvedValue({ running: false });
    mockIsKubernetesAgent
      .mockReset()
      .mockImplementation((agent) => String(agent?.backend_type || "").toLowerCase() === "k8s");
    mockUpdateEnv.mockReset().mockResolvedValue(undefined);
    mockWithProviderStateLock
      .mockReset()
      .mockImplementation(async (_userId, operation) => operation());
    mockPersistLifecycleRuntimeAddress
      .mockReset()
      .mockImplementation(async (_db, agent, result) => {
        const host = typeof result?.host === "string" ? result.host.trim() : "";
        const runtimeHost =
          typeof result?.runtimeHost === "string" ? result.runtimeHost.trim() : host;
        if (host) agent.host = host;
        if (runtimeHost) agent.runtime_host = runtimeHost;
        return agent;
      });
    mockGetProviderKeys.mockReset().mockResolvedValue({
      OPENAI_API_KEY: "sk-live-test",
    });
    mockGetProviderEndpoints.mockReset().mockResolvedValue({
      byEnvVar: {},
      byProvider: {},
      apiVersionByEnvVar: {},
      apiVersionByProvider: {},
      deploymentByEnvVar: {},
    });
    mockBuildBaseUrlEnvVars.mockReset().mockReturnValue({});
    mockBuildApiVersionEnvVars.mockReset().mockReturnValue({});
    mockBuildDeploymentEnvVars.mockReset().mockReturnValue({});
    mockBuildAuthProfiles.mockReset().mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-live-test",
        },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    });
    mockGetIntegrationEnvVars.mockReset().mockResolvedValue({});
    mockGetEnabledMcpRuntimeState.mockReset().mockResolvedValue({
      enabledIds: [],
      entries: [],
      desiredServers: {},
      env: {},
      managedEnvNames: [],
    });
    mockEvictConnection.mockReset();
    mockWaitForAgentReadiness.mockReset().mockResolvedValue({
      ok: true,
      runtime: { ok: true },
      gateway: { ok: true },
    });
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = jest.fn();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    delete global.fetch;
  });

  it("adds enabled MCP alias credentials to the exact OpenClaw managed environment", async () => {
    mockGetIntegrationEnvVars.mockResolvedValue({ GITLAB_TOKEN: "generic-token" });
    mockGetEnabledMcpRuntimeState.mockResolvedValue({
      enabledIds: ["gitlab"],
      entries: [
        {
          name: "gitlab",
          npmPackage: "@modelcontextprotocol/server-gitlab",
          env: { GITLAB_PERSONAL_ACCESS_TOKEN: "mcp-token" },
        },
      ],
      desiredServers: {
        gitlab: {
          command: "/usr/local/bin/nora-mcp-server",
          args: ["secret-free-payload"],
        },
      },
      env: { NORA_MCP_GITLAB_TOKEN_ALIAS: "mcp-token" },
      managedEnvNames: ["NORA_MCP_GITLAB_TOKEN_ALIAS"],
    });

    const managedEnv = await buildOpenClawManagedEnvForAgent("user-1", "agent-1", null);
    expect(managedEnv).toEqual(
      expect.objectContaining({
        GITLAB_TOKEN: "generic-token",
        NORA_MCP_GITLAB_TOKEN_ALIAS: "mcp-token",
        OPENAI_API_KEY: "sk-live-test",
        NORA_MANAGED_MCP_SERVERS_B64: expect.any(String),
      }),
    );
    const encodedMcpConfig = Buffer.from(
      managedEnv.NORA_MANAGED_MCP_SERVERS_B64,
      "base64",
    ).toString("utf8");
    expect(JSON.parse(encodedMcpConfig)).toEqual({
      gitlab: {
        command: "/usr/local/bin/nora-mcp-server",
        args: ["secret-free-payload"],
      },
    });
    expect(encodedMcpConfig).not.toContain("mcp-token");
  });

  it("rejects API-key-scoped auth sync after assignment removal", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      syncAuthToUserAgents("owner-1", "agent-1", {
        apiKeyWorkspaceId: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "wrong_workspace", statusCode: 403 });
    expect(mockGetProviderKeys).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects API-key-scoped auth sync when current placement is Remote Docker", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-remote",
          backend_type: "remote-docker",
          deploy_target: "remote-docker",
          execution_target_id: "remote:host-1",
        },
      ],
    });

    await expect(
      syncAuthToUserAgents("owner-1", "agent-remote", {
        apiKeyWorkspaceId: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "session_required", statusCode: 403 });
    expect(mockGetProviderKeys).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("stages exact integration and MCP revocation while an OpenClaw runtime is stopped", async () => {
    const agent = {
      id: "agent-stopped-revocation",
      user_id: "user-1",
      container_id: "stopped-container",
      container_name: "stopped-container",
      backend_type: "docker",
      deploy_target: "docker",
      runtime_family: "openclaw",
      status: "stopped",
      paused_reason: null,
    };
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM llm_providers") && text.includes("is_default = true")) {
        return { rows: [{ provider: "openai", model: "gpt-5.5", config: {} }] };
      }
      if (text.includes("FROM agents")) return { rows: [agent] };
      return { rows: [] };
    });
    mockStatus.mockResolvedValue({ running: false });
    mockGetEnabledMcpRuntimeState.mockResolvedValue({
      enabledIds: ["gitlab"],
      entries: [],
      desiredServers: {},
      env: {},
      managedEnvNames: ["NORA_MCP_GITLAB_TOKEN_ALIAS"],
    });
    mockGetIntegrationEnvVars.mockResolvedValue({});

    await expect(
      syncAuthToUserAgents("user-1", "agent-stopped-revocation", {
        extraManagedEnvNames: ["GITHUB_TOKEN"],
      }),
    ).resolves.toEqual([{ agentId: "agent-stopped-revocation", status: "synced", staged: true }]);

    expect(mockUpdateEnv).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({
        OPENAI_API_KEY: "sk-live-test",
        NORA_MANAGED_MCP_SERVERS_B64: "e30=",
      }),
      {
        managedEnvNames: expect.arrayContaining([
          "OPENAI_API_KEY",
          "GITHUB_TOKEN",
          "NORA_MCP_GITLAB_TOKEN_ALIAS",
          "NORA_MANAGED_MCP_SERVERS_B64",
        ]),
        replaceManagedState: true,
      },
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("sets Microsoft Foundry defaults through azure-openai-responses even when the saved model has an OpenAI prefix", () => {
    const command = buildDefaultModelCommand({
      provider: "microsoft-foundry",
      model: "openai/gpt-5.5-1",
    });

    // Written via config merge, NOT `openclaw models set`: the CLI
    // canonicalizes the ref back to `openai/<deployment>`, a provider the
    // agent has no credentials for.
    expect(command).toContain("__NORA_MERGE_OPENCLAW_CONFIG__");
    expect(command).toContain('"primary": "azure-openai-responses/gpt-5.5-1"');
    expect(command).not.toContain('"openai/gpt-5.5-1"');
    expect(command).not.toContain('"models" "set"');
  });

  it("holds the provider lock from offline start staging through readiness and final status", async () => {
    const order = [];
    const agent = {
      id: "agent-staged-start",
      user_id: "user-1",
      name: "Staged Start",
      container_id: "nora-staged-start",
      container_name: "nora-staged-start",
      backend_type: "k8s",
      deploy_target: "k8s",
      runtime_family: "openclaw",
      status: "stopped",
      runtime_host: "runtime.internal",
      runtime_port: 9090,
      gateway_host: "gateway.internal",
      gateway_port: 18789,
    };
    mockWithProviderStateLock.mockImplementationOnce(async (userId, operation) => {
      expect(userId).toBe("user-1");
      order.push("provider-lock-enter");
      const result = await operation();
      order.push("provider-lock-exit");
      return result;
    });
    mockStatus.mockImplementationOnce(async () => {
      order.push("offline-status");
      return { running: false };
    });
    mockUpdateEnv.mockImplementationOnce(async () => {
      order.push("offline-stage");
    });
    mockStart.mockImplementationOnce(async () => {
      order.push("physical-start");
      return { host: "runtime.internal", runtimeHost: "runtime.internal" };
    });
    mockPersistLifecycleRuntimeAddress.mockImplementationOnce(async (_db, target, result) => {
      order.push("address");
      target.host = result.host;
      target.runtime_host = result.runtimeHost;
      return target;
    });
    mockWaitForAgentReadiness.mockImplementationOnce(async () => {
      order.push("readiness");
      return { ok: true, runtime: { ok: true }, gateway: { ok: true } };
    });
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("SET status = $2") && text.includes("paused_reason = $3")) {
        order.push("pending-status");
        return {
          rows: [{ ...agent, status: params[1], paused_reason: params[2] }],
        };
      }
      if (text.includes("FROM llm_providers") && text.includes("is_default = true")) {
        return { rows: [{ provider: "openai", model: "gpt-5.5", config: {} }] };
      }
      if (text.includes("FROM agents")) {
        return {
          rows: [
            {
              ...agent,
              status: "stopped",
              paused_reason: PROVIDER_AUTH_PENDING_REASON,
            },
          ],
        };
      }
      if (text.includes("SET status = 'running'") && text.includes("paused_reason = NULL")) {
        order.push("final-status");
        return { rows: [{ ...agent, status: "running", paused_reason: null }] };
      }
      return { rows: [] };
    });

    const result = await resumeAgentWithProviderAuth(agent, "start");

    expect(result.agent).toEqual(
      expect.objectContaining({ status: "running", paused_reason: null }),
    );
    expect(order).toEqual([
      "provider-lock-enter",
      "pending-status",
      "offline-status",
      "offline-stage",
      "physical-start",
      "address",
      "readiness",
      "final-status",
      "provider-lock-exit",
    ]);
    expect(mockWithProviderStateLock).toHaveBeenCalledTimes(1);
    expect(mockRestart).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("lets auth sync own the restart and publishes running only after reconciliation", async () => {
    const order = [];
    const agent = {
      id: "agent-single-restart",
      user_id: "user-1",
      name: "Single Restart",
      container_id: "nora-single-restart",
      container_name: "nora-single-restart",
      backend_type: "k8s",
      deploy_target: "k8s",
      runtime_family: "openclaw",
      status: "running",
      runtime_host: "runtime.internal",
      runtime_port: 9090,
      gateway_host: "gateway.internal",
      gateway_port: 18789,
    };
    mockWithProviderStateLock.mockImplementationOnce(async (_userId, operation) => {
      order.push("provider-lock-enter");
      const result = await operation();
      order.push("provider-lock-exit");
      return result;
    });
    mockRestart.mockImplementationOnce(async () => {
      order.push("exact-restart");
      return { host: "runtime.internal", runtimeHost: "runtime.internal" };
    });
    mockWaitForAgentReadiness.mockImplementationOnce(async () => {
      order.push("readiness");
      return { ok: true, runtime: { ok: true }, gateway: { ok: true } };
    });
    global.fetch
      .mockImplementationOnce(async () => {
        order.push("auth-write");
        return jsonResponse({ exitCode: 0, stdout: "", stderr: "" });
      })
      .mockImplementationOnce(async () => {
        order.push("provider-write");
        return jsonResponse({ exitCode: 0, stdout: "", stderr: "" });
      })
      .mockImplementationOnce(async () => {
        order.push("mcp-write");
        return jsonResponse({ exitCode: 0, stdout: "", stderr: "" });
      });
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("SET status = $2") && text.includes("paused_reason = $3")) {
        order.push("pending-status");
        return { rows: [{ ...agent, status: params[1], paused_reason: params[2] }] };
      }
      if (text.includes("FROM llm_providers") && text.includes("is_default = true")) {
        return { rows: [{ provider: "openai", model: "gpt-5.5", config: {} }] };
      }
      if (text.includes("FROM agents")) {
        return {
          rows: [
            {
              ...agent,
              status: "error",
              paused_reason: PROVIDER_AUTH_PENDING_REASON,
            },
          ],
        };
      }
      if (text.includes("SET status = 'running'") && text.includes("paused_reason = NULL")) {
        order.push("final-status");
        return { rows: [{ ...agent, status: "running", paused_reason: null }] };
      }
      return { rows: [] };
    });

    await resumeAgentWithProviderAuth(agent, "restart");

    expect(mockStart).not.toHaveBeenCalled();
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "provider-lock-enter",
      "pending-status",
      "auth-write",
      "provider-write",
      "mcp-write",
      "exact-restart",
      "readiness",
      "final-status",
      "provider-lock-exit",
    ]);
    expect(mockWithProviderStateLock).toHaveBeenCalledTimes(1);
  });

  it("fails before physical start when exact offline staging is unavailable", async () => {
    const agent = {
      id: "agent-stage-failure",
      user_id: "user-1",
      name: "Stage Failure",
      container_id: "nora-stage-failure",
      backend_type: "proxmox",
      deploy_target: "proxmox",
      runtime_family: "openclaw",
      status: "stopped",
    };
    mockUpdateEnv.mockRejectedValueOnce(new Error("offline staging unsupported"));
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("SET status = $2") && text.includes("paused_reason = $3")) {
        return { rows: [{ ...agent, status: params[1], paused_reason: params[2] }] };
      }
      if (text.includes("FROM llm_providers") && text.includes("is_default = true")) {
        return { rows: [{ provider: "openai", model: "gpt-5.5", config: {} }] };
      }
      return { rows: [] };
    });

    await expect(resumeAgentWithProviderAuth(agent, "start")).rejects.toMatchObject({
      code: "AGENT_AUTH_RECONCILIATION_FAILED",
      statusCode: 502,
    });

    expect(mockStart).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'stopped', paused_reason = $2 WHERE id = $1",
      [agent.id, "provider_auth_reconciliation_failed"],
    );
    expect(mockWithProviderStateLock).toHaveBeenCalledTimes(1);
  });

  it("keeps restart non-runnable and quarantines it when readiness fails", async () => {
    const agent = {
      id: "agent-restart-readiness-failure",
      user_id: "user-1",
      name: "Restart Readiness Failure",
      container_id: "nora-restart-readiness-failure",
      backend_type: "k8s",
      deploy_target: "k8s",
      runtime_family: "openclaw",
      status: "running",
      runtime_host: "runtime.internal",
      runtime_port: 9090,
      gateway_host: "gateway.internal",
      gateway_port: 18789,
    };
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));
    mockWaitForAgentReadiness.mockResolvedValueOnce({
      ok: false,
      runtime: { ok: false, error: "unreachable" },
      gateway: { ok: false, error: "unreachable" },
    });
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("SET status = $2") && text.includes("paused_reason = $3")) {
        return { rows: [{ ...agent, status: params[1], paused_reason: params[2] }] };
      }
      if (text.includes("FROM llm_providers") && text.includes("is_default = true")) {
        return { rows: [{ provider: "openai", model: "gpt-5.5", config: {} }] };
      }
      if (text.includes("FROM agents")) {
        return {
          rows: [
            {
              ...agent,
              status: "error",
              paused_reason: PROVIDER_AUTH_PENDING_REASON,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(resumeAgentWithProviderAuth(agent, "restart")).rejects.toMatchObject({
      code: "AGENT_AUTH_RECONCILIATION_FAILED",
    });

    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(
      mockDb.query.mock.calls.some(
        ([sql]) =>
          String(sql).includes("SET status = 'running'") &&
          String(sql).includes("paused_reason = NULL"),
      ),
    ).toBe(false);
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'error', paused_reason = $2 WHERE id = $1",
      [agent.id, "provider_auth_reconciliation_failed"],
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'stopped', paused_reason = $2 WHERE id = $1",
      [agent.id, "provider_auth_reconciliation_failed"],
    );
  });

  it("syncs auth through the runtime endpoint and restarts supported non-docker agents", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.5" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-1",
            container_id: "oclaw-agent-123",
            backend_type: "k8s",
            host: "agent.internal",
            runtime_host: "runtime.internal",
            runtime_port: 9090,
            gateway_host_port: null,
            gateway_host: "gateway.internal",
            gateway_port: 18789,
          },
        ],
      });

    global.fetch
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));
    // Non-LLM integration tokens must reach the Deployment env too — they
    // otherwise live only in the pod's openclaw.json and die with the pod.
    mockGetIntegrationEnvVars.mockResolvedValue({ GITHUB_TOKEN: "gh-tok" });

    const results = await syncAuthToUserAgents("user-1");

    expect(mockEvictConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-k8s-1" }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://runtime.internal:9090/exec",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).command).toContain("auth-profiles.json");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).command).toContain("paste-api-key");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).command).toContain(
      "__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__",
    );
    expect(mockRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-1",
        backend_type: "k8s",
        container_id: "oclaw-agent-123",
      }),
    );
    expect(mockWaitForAgentReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "agent.internal",
        runtimeHost: "runtime.internal",
        runtimePort: 9090,
        gatewayHost: "gateway.internal",
        gatewayPort: 18789,
      }),
      expect.objectContaining({ beforeAttempt: expect.any(Function) }),
    );
    const runtimeWriteOrders = global.fetch.mock.invocationCallOrder;
    expect(Math.max(...runtimeWriteOrders)).toBeLessThan(mockRestart.mock.invocationCallOrder[0]);
    expect(mockRestart.mock.invocationCallOrder[0]).toBeLessThan(
      mockWaitForAgentReadiness.mock.invocationCallOrder[0],
    );
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).command).toContain(
      "model.primary = desiredDefaultModel",
    );
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).command).toContain(
      'const desiredDefaultModel = "openai/gpt-5.5"',
    );
    // Kubernetes restarts are rollouts: the replacement pod re-seeds auth
    // from the Deployment env, so the sync must patch it too.
    expect(mockUpdateEnv).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-k8s-1" }),
      {
        GITHUB_TOKEN: "gh-tok",
        OPENAI_API_KEY: "sk-live-test",
        NORA_DEFAULT_OPENCLAW_MODEL: "openai/gpt-5.5",
        NORA_MANAGED_MCP_SERVERS_B64: "e30=",
      },
      {
        managedEnvNames: [
          "OPENAI_API_KEY",
          "GEMINI_API_KEY",
          "NORA_DEFAULT_OPENCLAW_MODEL",
          "NORA_MANAGED_MCP_SERVERS_B64",
        ],
        replaceManagedState: true,
      },
    );
    expect(results).toEqual([{ agentId: "agent-k8s-1", status: "synced" }]);
  });

  it("writes auth, custom providers, and the default model before one restart with readiness last", async () => {
    const foundryBaseUrl = "https://resource.openai.azure.com/openai/v1";
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            provider: "microsoft-foundry",
            model: "openai/gpt-5.5-1",
            config: { base_url: foundryBaseUrl },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-foundry",
            container_id: "oclaw-foundry-123",
            backend_type: "k8s",
            host: "agent.internal",
            runtime_host: "runtime.internal",
            runtime_port: 9090,
            gateway_host_port: null,
            gateway_host: "gateway.internal",
            gateway_port: 18789,
          },
        ],
      });
    mockGetProviderKeys.mockResolvedValue({ MICROSOFT_FOUNDRY_API_KEY: "ms-live-test" });
    mockGetProviderEndpoints.mockResolvedValue({
      byEnvVar: { MICROSOFT_FOUNDRY_API_KEY: foundryBaseUrl },
      byProvider: { "microsoft-foundry": foundryBaseUrl },
      apiVersionByEnvVar: {},
      apiVersionByProvider: {},
      deploymentByEnvVar: { MICROSOFT_FOUNDRY_API_KEY: "gpt-5.5-1" },
    });
    mockBuildBaseUrlEnvVars.mockReturnValue({ MICROSOFT_FOUNDRY_BASE_URL: foundryBaseUrl });
    mockBuildDeploymentEnvVars.mockReturnValue({
      MICROSOFT_FOUNDRY_DEPLOYMENT: "gpt-5.5-1",
    });
    mockBuildAuthProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          key: "ms-live-test",
          endpoint: foundryBaseUrl,
        },
      },
      order: { "microsoft-foundry": ["microsoft-foundry:default"] },
      lastGood: { "microsoft-foundry": "microsoft-foundry:default" },
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));
    mockWaitForAgentReadiness.mockImplementationOnce(async () => {
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(mockRestart).toHaveBeenCalledTimes(1);
      return { ok: true, runtime: { ok: true }, gateway: { ok: true } };
    });

    const results = await syncAuthToUserAgents("user-1");

    const commands = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).command);
    expect(commands[0]).toContain("__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__");
    expect(commands[1]).toContain('"azure-openai-responses"');
    expect(commands[1]).toContain('"apiKey":"ms-live-test"');
    expect(commands[1]).toContain('const desiredDefaultModel = "azure-openai-responses/gpt-5.5-1"');
    expect(commands[2]).toContain("__NORA_RECONCILE_OPENCLAW_MCP_SERVERS__");
    expect(commands[2]).not.toContain("ms-live-test");
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(Math.max(...global.fetch.mock.invocationCallOrder)).toBeLessThan(
      mockRestart.mock.invocationCallOrder[0],
    );
    expect(mockRestart.mock.invocationCallOrder[0]).toBeLessThan(
      mockWaitForAgentReadiness.mock.invocationCallOrder[0],
    );
    expect(results).toEqual([{ agentId: "agent-k8s-foundry", status: "synced" }]);
  });

  it("uses a refreshed Proxmox address for readiness after auth-sync restart", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.5" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-proxmox-auth",
            container_id: "501",
            backend_type: "proxmox",
            host: "10.80.90.10",
            runtime_host: "10.80.90.10",
            runtime_port: 9090,
            gateway_host_port: null,
            gateway_host: null,
            gateway_port: 18789,
          },
        ],
      });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));
    mockRestart.mockResolvedValueOnce({
      host: "10.80.90.51",
      runtimeHost: "10.80.90.51",
    });

    const results = await syncAuthToUserAgents("user-1");

    expect(mockPersistLifecycleRuntimeAddress).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ id: "agent-proxmox-auth" }),
      { host: "10.80.90.51", runtimeHost: "10.80.90.51" },
    );
    expect(mockWaitForAgentReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "10.80.90.51",
        runtimeHost: "10.80.90.51",
      }),
      expect.objectContaining({ beforeAttempt: expect.any(Function) }),
    );
    expect(results).toEqual([{ agentId: "agent-proxmox-auth", status: "synced" }]);
  });

  it("returns a failed sync result when the runtime write command fails", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.5" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-k8s-2",
            container_id: "oclaw-agent-999",
            backend_type: "k8s",
            host: "agent.internal",
            runtime_host: "runtime.internal",
            runtime_port: 9090,
            gateway_host_port: null,
            gateway_host: "gateway.internal",
            gateway_port: 18789,
          },
        ],
      });

    global.fetch.mockResolvedValueOnce(
      jsonResponse({ exitCode: 1, stdout: "", stderr: "write failed" }),
    );

    const results = await syncAuthToUserAgents("user-1");

    expect(mockRestart).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        agentId: "agent-k8s-2",
        status: "failed",
        error: "write failed",
      }),
    ]);
  });

  it("reconciles exact credential revocation for error agents that retain runtime identity", async () => {
    const agent = {
      id: "agent-error-live-runtime",
      user_id: "user-1",
      status: "error",
      paused_reason: null,
      container_id: "oclaw-error-runtime",
      container_name: "oclaw-error-runtime",
      backend_type: "docker",
      deploy_target: "docker",
      runtime_family: "openclaw",
      host: "agent.internal",
      runtime_host: "runtime.internal",
      runtime_port: 9090,
      gateway_host: "gateway.internal",
      gateway_port: 18789,
    };
    mockGetProviderKeys.mockResolvedValue({});
    mockBuildAuthProfiles.mockReturnValue({});
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM llm_providers")) return { rows: [] };
      if (text.includes("FROM agents")) return { rows: [agent] };
      return { rows: [] };
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }))
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));

    const results = await syncAuthToUserAgents("user-1");

    const agentQuery = mockDb.query.mock.calls.find(([sql]) => String(sql).includes("FROM agents"));
    expect(String(agentQuery[0])).toMatch(/status = 'error'\s+AND container_id IS NOT NULL/);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).command).toContain(
      "__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__",
    );
    expect(mockRestart).toHaveBeenCalledWith(agent);
    expect(results).toEqual([{ agentId: agent.id, status: "synced" }]);
  });

  it("does not treat a preassigned container name as proof of a live error runtime", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    const results = await syncAuthToUserAgents("user-1");

    const agentQuery = String(mockDb.query.mock.calls[1][0]);
    const errorStatusClause = agentQuery.match(/status = 'error'\s+AND[^\n]+/)?.[0];
    expect(errorStatusClause).toMatch(/AND container_id IS NOT NULL/);
    expect(errorStatusClause).not.toContain("container_name");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("does not write or restart a Remote Docker runtime after host access is revoked", async () => {
    const remoteAgent = {
      id: "agent-remote-revoked",
      user_id: "former-grantee",
      container_id: "remote-container",
      backend_type: "remote-docker",
      runtime_family: "openclaw",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      sandbox_profile: "standard",
      runtime_host: "203.0.113.5",
      runtime_port: 19043,
      gateway_host: "203.0.113.5",
      gateway_port: 19042,
      gateway_token: "must-not-be-used",
    };
    mockDb.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM llm_providers") && text.includes("is_default = true")) {
        return { rows: [{ provider: "openai", model: "gpt-5.5" }] };
      }
      if (
        text.includes("FROM agents") &&
        text.includes("status IN ('running', 'warning', 'stopped')")
      ) {
        return { rows: [remoteAgent] };
      }
      if (/SELECT \*\s+FROM remote_hosts/.test(text)) {
        return {
          rows: [
            {
              id: "shared-host",
              owner_user_id: "host-owner",
              label: "Shared host",
              enabled: true,
              ssh_host: "203.0.113.5",
              ssh_port: 22,
              ssh_user: "operator",
              ssh_auth_mode: "key",
              ssh_private_key_encrypted: "encrypted-key",
              ssh_host_key: Buffer.from("SHARED-HOST-KEY").toString("base64"),
              gateway_host: "203.0.113.5",
              last_test_status: "ok",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const results = await syncAuthToUserAgents("former-grantee");

    expect(results).toEqual([
      expect.objectContaining({
        agentId: "agent-remote-revoked",
        status: "failed",
        error: expect.stringMatching(/revoked/i),
      }),
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockUpdateEnv).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("aborts an in-flight Remote Docker runtime command when authorization recheck fails", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote-mid-command",
      user_id: "host-owner",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      runtime_host: "203.0.113.5",
      runtime_port: 19043,
    };
    let authorizationAvailable = true;
    let requestSignal = null;
    mockDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM remote_hosts")) {
        if (!authorizationAvailable) {
          throw Object.assign(new Error("authorization database unavailable"), { code: "57P01" });
        }
        return {
          rows: [
            {
              id: "shared-host",
              owner_user_id: "host-owner",
              label: "Shared host",
              enabled: true,
              ssh_host: "203.0.113.5",
              ssh_port: 22,
              ssh_user: "operator",
              ssh_auth_mode: "key",
              ssh_private_key_encrypted: "encrypted-key",
              ssh_host_key: Buffer.from("SHARED-HOST-KEY").toString("base64"),
              gateway_host: "203.0.113.5",
              last_test_status: "ok",
            },
          ],
        };
      }
      return { rows: [] };
    });
    global.fetch.mockImplementation((_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason || new Error("aborted")),
          { once: true },
        );
      });
    });

    const command = runRuntimeCommand(agent, "sleep 60", { timeout: 60000 });
    const commandRejection = expect(command).rejects.toMatchObject({
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);

    authorizationAvailable = false;
    jest.advanceTimersByTime(1000);
    await new Promise((resolve) => setImmediate(resolve));

    await commandRejection;
    expect(requestSignal?.aborted).toBe(true);
    jest.useRealTimers();
  });

  it("waits for an in-flight authorization recheck before accepting a successful response", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote-auth-race",
      user_id: "host-owner",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      runtime_host: "203.0.113.5",
      runtime_port: 19043,
    };
    let rejectAuthorization;
    let authorizationStartedResolve;
    let authorizationQueryCount = 0;
    const authorizationStarted = new Promise((resolve) => {
      authorizationStartedResolve = resolve;
    });
    let resolveBody;
    mockDb.query.mockImplementation((sql) => {
      if (String(sql).includes("FROM remote_hosts")) {
        authorizationQueryCount += 1;
        if (authorizationQueryCount === 1) {
          return Promise.resolve({
            rows: [
              {
                id: "shared-host",
                owner_user_id: "host-owner",
                label: "Shared host",
                enabled: true,
                ssh_host: "203.0.113.5",
                ssh_port: 22,
                ssh_user: "operator",
                ssh_auth_mode: "key",
                ssh_private_key_encrypted: "encrypted-key",
                ssh_host_key: Buffer.from("SHARED-HOST-KEY").toString("base64"),
                gateway_host: "203.0.113.5",
                last_test_status: "ok",
              },
            ],
          });
        }
        authorizationStartedResolve();
        return new Promise((_resolve, reject) => {
          rejectAuthorization = reject;
        });
      }
      return Promise.resolve({ rows: [] });
    });
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    });

    const command = runRuntimeCommand(agent, "true");
    const commandRejection = expect(command).rejects.toMatchObject({
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    for (let attempt = 0; attempt < 20 && typeof resolveBody !== "function"; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(typeof resolveBody).toBe("function");

    jest.advanceTimersByTime(1000);
    await authorizationStarted;
    resolveBody({ exitCode: 0 });
    rejectAuthorization(
      Object.assign(new Error("authorization database unavailable"), { code: "57P01" }),
    );

    await commandRejection;
    jest.useRealTimers();
  });

  it.each([undefined, null, "0", 0.5])(
    "rejects runtime command success without an integer exit code (%p)",
    async (exitCode) => {
      global.fetch.mockResolvedValue(
        jsonResponse({
          ...(exitCode !== undefined ? { exitCode } : {}),
          stdout: "command output",
        }),
      );

      await expect(
        runRuntimeCommand(
          {
            id: "agent-runtime-malformed-success",
            backend_type: "docker",
            runtime_host: "runtime.internal",
            runtime_port: 9090,
            gateway_token: "legacy-plaintext-token",
          },
          "true",
        ),
      ).rejects.toMatchObject({
        code: "RUNTIME_COMMAND_EXIT_UNCONFIRMED",
      });
    },
  );

  it("falls back to container exec when docker runtime auth writes cannot use the runtime endpoint", async () => {
    global.fetch.mockRejectedValueOnce(new Error("runtime unavailable"));
    mockExec.mockResolvedValueOnce(execResult());

    await writeAuthToContainer(
      {
        id: "agent-docker-1",
        backend_type: "docker",
        container_id: "docker-agent-1",
      },
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-live-test",
          },
        },
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
      },
    );

    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-docker-1",
        backend_type: "docker",
      }),
      expect.objectContaining({
        cmd: expect.arrayContaining(["/bin/sh", "-lc"]),
      }),
    );
  });

  it("preserves container exec exit code metadata on failures", async () => {
    mockExec.mockResolvedValueOnce(execResult("partial output", 137));

    try {
      await runContainerCommand(
        {
          id: "agent-docker-oom",
          backend_type: "docker",
          container_id: "docker-agent-oom",
        },
        "npm install something",
      );
      throw new Error("expected runContainerCommand to fail");
    } catch (error) {
      expect(error.message).toBe("partial output");
      expect(error.exitCode).toBe(137);
      expect(error.output).toBe("partial output");
    }
  });

  it("wraps fallback exec in a bounded process group and reports an unconfirmed transport timeout", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const stream = new PassThrough();
    mockExec.mockResolvedValueOnce({
      exec: { inspect: jest.fn().mockResolvedValue({ Running: true, ExitCode: null }) },
      stream,
    });

    const command = runContainerCommand(
      {
        id: "agent-docker-timeout",
        backend_type: "docker",
        container_id: "docker-agent-timeout",
      },
      "sleep 60",
      { timeout: 10 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const execOptions = mockExec.mock.calls[0][1];
    expect(execOptions.tty).toBe(false);
    expect(execOptions.cmd[2]).toContain("command -v setsid");
    expect(execOptions.cmd[2]).toContain("command -v timeout");
    expect(execOptions.cmd.at(-1)).toBe("sleep 60");

    jest.advanceTimersByTime(5010);
    await expect(command).rejects.toMatchObject({
      code: "CONTAINER_COMMAND_EXIT_UNCONFIRMED",
    });
    expect(stream.destroyed).toBe(true);
    jest.useRealTimers();
  });

  it("fails closed when the attach stream closes before Docker confirms command exit", async () => {
    const stream = new PassThrough();
    const agent = {
      id: "agent-docker-detached",
      backend_type: "docker",
      container_id: "docker-agent-detached",
    };
    mockExec.mockResolvedValueOnce({
      exec: { inspect: jest.fn().mockResolvedValue({ Running: true, ExitCode: null }) },
      stream,
    });
    setImmediate(() => stream.destroy());

    await expect(runContainerCommand(agent, "sleep 60", { timeout: 60000 })).rejects.toMatchObject({
      code: "CONTAINER_COMMAND_EXIT_UNCONFIRMED",
    });

    expect(stream.destroyed).toBe(true);
  });

  it("routes Remote Docker container commands through abort-aware runtime exec", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const agent = {
      id: "agent-remote-container-command",
      user_id: "host-owner",
      backend_type: "remote-docker",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      container_id: "remote-container",
      runtime_host: "203.0.113.5",
      runtime_port: 19043,
    };
    let authorizationAvailable = true;
    let requestSignal = null;
    mockDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM remote_hosts")) {
        if (!authorizationAvailable) {
          throw Object.assign(new Error("authorization database unavailable"), { code: "57P01" });
        }
        return {
          rows: [
            {
              id: "shared-host",
              owner_user_id: "host-owner",
              label: "Shared host",
              enabled: true,
              ssh_host: "203.0.113.5",
              ssh_port: 22,
              ssh_user: "operator",
              ssh_auth_mode: "key",
              ssh_private_key_encrypted: "encrypted-key",
              ssh_host_key: Buffer.from("SHARED-HOST-KEY").toString("base64"),
              gateway_host: "203.0.113.5",
              last_test_status: "ok",
            },
          ],
        };
      }
      return { rows: [] };
    });
    global.fetch.mockImplementation((_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason || new Error("aborted")),
          { once: true },
        );
      });
    });

    const command = runContainerCommand(agent, "sleep 60", { timeout: 60000 });
    const commandRejection = expect(command).rejects.toMatchObject({
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockExec).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);

    authorizationAvailable = false;
    jest.advanceTimersByTime(1000);
    await new Promise((resolve) => setImmediate(resolve));

    await commandRejection;
    expect(requestSignal?.aborted).toBe(true);
    jest.useRealTimers();
  });

  it("stops Remote Hermes when revocation makes a direct exec command unconfirmable", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const stream = new PassThrough();
    const agent = {
      id: "agent-remote-hermes-command",
      user_id: "host-owner",
      backend_type: "remote-docker",
      runtime_family: "hermes",
      deploy_target: "remote-docker",
      execution_target_id: "remote:shared-host",
      container_id: "remote-hermes-container",
    };
    let authorizationAvailable = true;
    mockDb.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM remote_hosts")) {
        if (!authorizationAvailable) {
          throw Object.assign(new Error("authorization database unavailable"), { code: "57P01" });
        }
        return {
          rows: [
            {
              id: "shared-host",
              owner_user_id: "host-owner",
              label: "Shared host",
              enabled: true,
              ssh_host: "203.0.113.5",
              ssh_port: 22,
              ssh_user: "operator",
              ssh_auth_mode: "key",
              ssh_private_key_encrypted: "encrypted-key",
              ssh_host_key: Buffer.from("SHARED-HOST-KEY").toString("base64"),
              gateway_host: "203.0.113.5",
              last_test_status: "ok",
            },
          ],
        };
      }
      return { rows: [] };
    });
    mockExec.mockResolvedValueOnce({
      exec: { inspect: jest.fn().mockResolvedValue({ Running: true, ExitCode: null }) },
      stream,
    });

    const command = runContainerCommand(agent, "sleep 60", { timeout: 60000 });
    const commandRejection = expect(command).rejects.toMatchObject({
      code: "REMOTE_HOST_AUTH_CHECK_FAILED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockExec).toHaveBeenCalledTimes(1);

    authorizationAvailable = false;
    jest.advanceTimersByTime(1000);
    await new Promise((resolve) => setImmediate(resolve));

    await commandRejection;
    expect(mockStop).toHaveBeenCalledWith(agent);
    expect(mockDb.query).toHaveBeenCalledWith(
      "UPDATE agents SET status = 'stopped' WHERE id = $1",
      [agent.id],
    );
    expect(stream.destroyed).toBe(true);
    jest.useRealTimers();
  });

  it("skips best-effort syncs when no auth material exists", async () => {
    mockGetProviderKeys.mockResolvedValue({});
    mockBuildAuthProfiles.mockReturnValue({});
    mockGetIntegrationEnvVars.mockResolvedValue({});
    mockDb.query
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-empty-1",
            container_id: "oclaw-agent-empty",
            backend_type: "docker",
            host: "agent.internal",
            runtime_host: "runtime.internal",
            runtime_port: 9090,
            gateway_host_port: null,
            gateway_host: "gateway.internal",
            gateway_port: 18789,
          },
        ],
      });

    const results = await syncAuthToUserAgents("user-1", null, {
      onlyIfAuthPresent: true,
    });

    expect(mockWithProviderStateLock).toHaveBeenCalledWith("user-1", expect.any(Function));
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(results).toEqual([{ agentId: "agent-empty-1", status: "skipped" }]);
  });

  it("rewrites the Hermes model config and env file before waiting for runtime readiness", async () => {
    mockGetIntegrationEnvVars.mockResolvedValue({
      GITHUB_TOKEN: "gh-token",
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.5", config: {} }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-hermes-1",
            container_id: "hermes-agent-123",
            backend_type: "docker",
            runtime_family: "hermes",
            host: "agent.internal",
            runtime_host: "runtime.internal",
            runtime_port: 8642,
            gateway_host_port: null,
            gateway_host: null,
            gateway_port: null,
          },
        ],
      });

    const execSpy = jest.fn().mockImplementation(() => Promise.resolve(execResult()));
    mockExec.mockImplementation(execSpy);

    const results = await syncAuthToUserAgents("user-1");

    expect(mockEvictConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-hermes-1" }),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-hermes-1",
        runtime_family: "hermes",
      }),
      expect.objectContaining({
        cmd: expect.arrayContaining(["/bin/sh", "-lc"]),
      }),
    );
    expect(mockExec).toHaveBeenCalledTimes(2);

    const configScript = decodeHermesScript(execSpy.mock.calls[0][1].cmd.at(-1));
    expect(configScript).toContain("payload = json.loads(");
    expect(configScript).toContain('\\"provider\\":\\"custom\\"');
    expect(configScript).toContain('\\"defaultModel\\":\\"gpt-5.5\\"');
    expect(configScript).toContain('\\"baseUrl\\":\\"https://api.openai.com/v1\\"');
    expect(configScript).toContain("repair_surrogates(load_config() or {})");
    expect(configScript).toContain("save_config(config)");
    expect(configScript).not.toContain("json.dumps(config, indent=2)");

    const envScript = execSpy.mock.calls[1][1].cmd.at(-1);
    expect(envScript).toContain("/opt/data/.env");
    expect(envScript).toContain("NORA MANAGED ENV");
    expect(envScript).toContain('chown hermes:hermes "$tmp_file" 2>/dev/null || true');
    expect(envScript).toContain('chmod 0600 "$tmp_file"');
    expect(envScript).toContain("chown hermes:hermes /opt/data/.env 2>/dev/null || true");
    expect(envScript).toContain("chmod 0600 /opt/data/.env");
    expect(envScript).not.toContain("then;");
    expect(envScript).not.toContain("else;");
    expect(mockRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-hermes-1",
        container_id: "hermes-agent-123",
      }),
    );
    expect(mockWaitForAgentReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "agent.internal",
        runtimeHost: "runtime.internal",
        runtimePort: 8642,
        checkGateway: false,
      }),
      expect.objectContaining({ beforeAttempt: expect.any(Function) }),
    );
    expect(Math.max(...mockExec.mock.invocationCallOrder)).toBeLessThan(
      mockRestart.mock.invocationCallOrder[0],
    );
    expect(mockRestart.mock.invocationCallOrder[0]).toBeLessThan(
      mockWaitForAgentReadiness.mock.invocationCallOrder[0],
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(results).toEqual([{ agentId: "agent-hermes-1", status: "synced" }]);
  });

  it("renders Hermes model config through json.loads when native providers omit base URLs", async () => {
    mockGetProviderKeys.mockResolvedValue({
      GEMINI_API_KEY: "gm-live-test",
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "google", model: "gemini-3-flash-preview", config: {} }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-hermes-google",
            container_id: "hermes-agent-google",
            backend_type: "docker",
            runtime_family: "hermes",
            host: "agent.internal",
            runtime_host: "runtime.internal",
            runtime_port: 8642,
            gateway_host_port: null,
            gateway_host: null,
            gateway_port: null,
          },
        ],
      });

    const execSpy = jest.fn().mockImplementation(() => Promise.resolve(execResult()));
    mockExec.mockImplementation(execSpy);

    await syncAuthToUserAgents("user-1");

    const configScript = decodeHermesScript(execSpy.mock.calls[0][1].cmd.at(-1));
    expect(configScript).toContain("payload = json.loads(");
    expect(configScript).toContain('\\"provider\\":\\"gemini\\"');
    expect(configScript).toContain('\\"baseUrl\\":null');
    expect(configScript).not.toContain("import yaml");
    expect(configScript).toContain("repair_surrogates(load_config() or {})");
    expect(configScript).toContain("save_config(config)");
    expect(configScript).not.toContain("json.dumps(config, indent=2)");
  });

  it("replaces Kubernetes Hermes provider env and model bootstrap in one update", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.5", config: {} }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-hermes-k8s",
            container_id: "hermes-agent-k8s",
            backend_type: "k8s",
            runtime_family: "hermes",
            host: "hermes-agent.hermes-agents.svc.cluster.local",
            runtime_host: "hermes-agent.hermes-agents.svc.cluster.local",
            runtime_port: 8642,
            gateway_host_port: null,
            gateway_host: null,
            gateway_port: null,
          },
        ],
      });

    const results = await syncAuthToUserAgents("user-1");

    expect(mockUpdateEnv).toHaveBeenCalledTimes(1);
    const [, managedEnv, options] = mockUpdateEnv.mock.calls[0];
    expect(managedEnv.OPENAI_API_KEY).toBe("sk-live-test");
    expect(managedEnv.NORA_HERMES_MANAGED_ENV_B64).toBeTruthy();
    expect(
      JSON.parse(Buffer.from(managedEnv.NORA_HERMES_MODEL_CONFIG_B64, "base64").toString("utf8")),
    ).toEqual(
      expect.objectContaining({
        provider: "custom",
        defaultModel: "gpt-5.5",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-live-test",
      }),
    );
    expect(options.managedEnvNames).toEqual(
      expect.arrayContaining([
        "OPENAI_API_KEY",
        "NORA_HERMES_MANAGED_ENV_B64",
        "NORA_HERMES_MODEL_CONFIG_B64",
      ]),
    );
    expect(options.replaceManagedState).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ agentId: "agent-hermes-k8s", status: "synced" }]);
  });

  it("preserves the Kubernetes Hermes model bootstrap during channel-only env writes", async () => {
    await writeHermesEnvToContainer(
      {
        id: "agent-hermes-k8s-channel",
        backend_type: "k8s",
        runtime_family: "hermes",
        container_id: "hermes-agent-k8s-channel",
      },
      { TELEGRAM_BOT_TOKEN: "telegram-test-token" },
    );

    expect(mockUpdateEnv).toHaveBeenCalledTimes(1);
    const [, managedEnv, options] = mockUpdateEnv.mock.calls[0];
    expect(managedEnv.NORA_HERMES_MANAGED_ENV_B64).toBeTruthy();
    expect(managedEnv.NORA_HERMES_MODEL_CONFIG_B64).toBeUndefined();
    expect(options.managedEnvNames).toEqual(
      expect.arrayContaining(["OPENAI_API_KEY", "GEMINI_API_KEY", "NORA_HERMES_MANAGED_ENV_B64"]),
    );
    expect(options.managedEnvNames).not.toContain("NORA_HERMES_MODEL_CONFIG_B64");
  });

  it("removes Kubernetes Hermes managed provider state after the last provider is deleted", async () => {
    mockGetProviderKeys.mockResolvedValue({});
    mockGetIntegrationEnvVars.mockResolvedValue({});
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-hermes-k8s-empty",
            container_id: "hermes-agent-k8s-empty",
            backend_type: "k8s",
            runtime_family: "hermes",
            host: "hermes-agent.hermes-agents.svc.cluster.local",
            runtime_host: "hermes-agent.hermes-agents.svc.cluster.local",
            runtime_port: 8642,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            model_config: {
              provider: "custom",
              defaultModel: "gpt-5.5",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "deleted-secret",
            },
            channel_configs: {},
          },
        ],
      });

    await syncAuthToUserAgents("user-1");

    expect(mockUpdateEnv).toHaveBeenCalledTimes(1);
    const [, managedEnv, options] = mockUpdateEnv.mock.calls[0];
    expect(managedEnv).toEqual({
      NORA_HERMES_MANAGED_ENV_B64: "__NORA_EMPTY_STATE_V1__",
      NORA_HERMES_MODEL_CONFIG_B64: "__NORA_EMPTY_STATE_V1__",
    });
    expect(options.managedEnvNames).toEqual(
      expect.arrayContaining([
        "OPENAI_API_KEY",
        "NORA_HERMES_MANAGED_ENV_B64",
        "NORA_HERMES_MODEL_CONFIG_B64",
      ]),
    );
    expect(options.replaceManagedState).toBe(true);
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it("builds a shell-parseable Hermes env rewrite command", () => {
    const command = buildHermesEnvWriteCommand({
      OPENAI_API_KEY: "sk-live-test",
      GITHUB_TOKEN: "gh-token",
    });
    const parse = spawnSync("/bin/sh", ["-n"], { input: command });
    const encodedBlock = command.match(/printf '%s' '([^']+)' \| base64 -d/);
    const decodedBlock = encodedBlock
      ? Buffer.from(encodedBlock[1], "base64").toString("utf8")
      : "";

    expect(parse.status).toBe(0);
    expect(decodedBlock).toContain('OPENAI_API_KEY="sk-live-test"');
    expect(decodedBlock).toContain('GITHUB_TOKEN="gh-token"');
    expect(command).toContain('chown hermes:hermes "$tmp_file" 2>/dev/null || true');
    expect(command).toContain('chmod 0600 "$tmp_file"');
    expect(command).toContain("chown hermes:hermes /opt/data/.env 2>/dev/null || true");
    expect(command).toContain("chmod 0600 /opt/data/.env");
    expect(command).not.toContain("then;");
    expect(command).not.toContain("else;");
  });
});
