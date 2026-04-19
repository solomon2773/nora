// @ts-nocheck
const { spawnSync } = require("child_process");
const { PassThrough } = require("stream");

const mockDb = { query: jest.fn() };
const mockRestart = jest.fn();
const mockExec = jest.fn();
const mockGetProviderKeys = jest.fn();
const mockBuildAuthProfiles = jest.fn();
const mockGetIntegrationEnvVars = jest.fn();
const mockEvictConnection = jest.fn();
const mockWaitForAgentReadiness = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../containerManager", () => ({
  exec: mockExec,
  restart: mockRestart,
}));
jest.mock("../llmProviders", () => ({
  PROVIDERS: [
    { id: "openai", envVar: "OPENAI_API_KEY" },
    { id: "google", envVar: "GEMINI_API_KEY" },
  ],
  getProviderKeys: mockGetProviderKeys,
  buildAuthProfiles: mockBuildAuthProfiles,
}));
jest.mock("../integrations", () => ({
  getIntegrationEnvVars: mockGetIntegrationEnvVars,
}));
jest.mock("../gatewayProxy", () => ({
  evictConnection: mockEvictConnection,
}));
jest.mock("../healthChecks", () => ({
  waitForAgentReadiness: mockWaitForAgentReadiness,
}));

const {
  buildHermesEnvWriteCommand,
  syncAuthToUserAgents,
  writeAuthToContainer,
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
      inspect: jest.fn().mockResolvedValue({ ExitCode: exitCode }),
    },
    stream,
  };
}

function decodeHermesScript(command) {
  const match = String(command || "").match(
    /base64\.b64decode\("([^"]+)"\)\.decode\('utf-8'\)/
  );
  if (!match) return "";
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("auth sync", () => {
  let consoleLogSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    mockDb.query.mockReset();
    mockExec.mockReset().mockResolvedValue(execResult());
    mockRestart.mockReset().mockResolvedValue(undefined);
    mockGetProviderKeys.mockReset().mockResolvedValue({
      OPENAI_API_KEY: "sk-live-test",
    });
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

  it("syncs auth through the runtime endpoint and restarts supported non-docker agents", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.4" }],
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
      .mockResolvedValueOnce(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));

    const results = await syncAuthToUserAgents("user-1");

    expect(mockEvictConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-k8s-1" })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://runtime.internal:9090/exec",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).command).toContain(
      "auth-profiles.json"
    );
    expect(mockRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-1",
        backend_type: "k8s",
        container_id: "oclaw-agent-123",
      })
    );
    expect(mockWaitForAgentReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "agent.internal",
        runtimeHost: "runtime.internal",
        runtimePort: 9090,
        gatewayHost: "gateway.internal",
        gatewayPort: 18789,
      })
    );
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).command).toContain(
      'models" "set" "openai/gpt-5.4'
    );
    expect(results).toEqual([
      { agentId: "agent-k8s-1", status: "synced" },
    ]);
  });

  it("returns a failed sync result when the runtime write command fails", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.4" }],
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
      jsonResponse({ exitCode: 1, stdout: "", stderr: "write failed" })
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
      }
    );

    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-docker-1",
        backend_type: "docker",
      }),
      expect.objectContaining({
        cmd: expect.arrayContaining(["/bin/sh", "-lc"]),
      })
    );
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

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(results).toEqual([
      { agentId: "agent-empty-1", status: "skipped" },
    ]);
  });

  it("rewrites the Hermes model config and env file before waiting for runtime readiness", async () => {
    mockGetIntegrationEnvVars.mockResolvedValue({
      GITHUB_TOKEN: "gh-token",
    });
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ provider: "openai", model: "gpt-5.4", config: {} }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-hermes-1",
            container_id: "hermes-agent-123",
            backend_type: "hermes",
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
      expect.objectContaining({ id: "agent-hermes-1" })
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-hermes-1",
        runtime_family: "hermes",
      }),
      expect.objectContaining({
        cmd: expect.arrayContaining(["/bin/sh", "-lc"]),
      })
    );
    expect(mockExec).toHaveBeenCalledTimes(2);

    const configScript = decodeHermesScript(execSpy.mock.calls[0][1].cmd[2]);
    expect(configScript).toContain("payload = json.loads(");
    expect(configScript).toContain('\\"provider\\":\\"custom\\"');
    expect(configScript).toContain('\\"defaultModel\\":\\"gpt-5.4\\"');
    expect(configScript).toContain('\\"baseUrl\\":\\"https://api.openai.com/v1\\"');

    expect(execSpy.mock.calls[1][1].cmd[2]).toContain("/opt/data/.env");
    expect(execSpy.mock.calls[1][1].cmd[2]).toContain("NORA MANAGED ENV");
    expect(execSpy.mock.calls[1][1].cmd[2]).toContain(
      'chown hermes:hermes "$tmp_file" 2>/dev/null || true'
    );
    expect(execSpy.mock.calls[1][1].cmd[2]).toContain('chmod 0600 "$tmp_file"');
    expect(execSpy.mock.calls[1][1].cmd[2]).toContain(
      "chown hermes:hermes /opt/data/.env 2>/dev/null || true"
    );
    expect(execSpy.mock.calls[1][1].cmd[2]).toContain("chmod 0600 /opt/data/.env");
    expect(execSpy.mock.calls[1][1].cmd[2]).not.toContain("then;");
    expect(execSpy.mock.calls[1][1].cmd[2]).not.toContain("else;");
    expect(mockRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-hermes-1",
        container_id: "hermes-agent-123",
      })
    );
    expect(mockWaitForAgentReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "agent.internal",
        runtimeHost: "runtime.internal",
        runtimePort: 8642,
        checkGateway: false,
      })
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(results).toEqual([
      { agentId: "agent-hermes-1", status: "synced" },
    ]);
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
            backend_type: "hermes",
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

    const configScript = decodeHermesScript(execSpy.mock.calls[0][1].cmd[2]);
    expect(configScript).toContain("payload = json.loads(");
    expect(configScript).toContain('\\"provider\\":\\"gemini\\"');
    expect(configScript).toContain('\\"baseUrl\\":null');
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
