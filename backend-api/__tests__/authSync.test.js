const mockDb = { query: jest.fn() };
const mockRestart = jest.fn();
const mockGetProviderKeys = jest.fn();
const mockBuildAuthProfiles = jest.fn();
const mockGetIntegrationEnvVars = jest.fn();
const mockEvictConnection = jest.fn();
const mockWaitForAgentReadiness = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../containerManager", () => ({
  restart: mockRestart,
}));
jest.mock("../llmProviders", () => ({
  PROVIDERS: [
    { id: "openai", envVar: "OPENAI_API_KEY" },
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

const { syncAuthToUserAgents } = require("../authSync");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

describe("auth sync", () => {
  let consoleLogSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    mockDb.query.mockReset();
    mockRestart.mockReset().mockResolvedValue(undefined);
    mockGetProviderKeys.mockReset().mockResolvedValue({
      OPENAI_API_KEY: "sk-live-test",
    });
    mockBuildAuthProfiles.mockReset().mockReturnValue({
      openai: { apiKey: "sk-live-test" },
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
});
