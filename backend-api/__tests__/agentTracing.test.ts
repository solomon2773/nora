// @ts-nocheck
const INGEST_SECRET = "test-ingest-secret";

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const mockAuthSync = {
  runRuntimeCommand: jest.fn(),
  runContainerCommand: jest.fn(),
};
jest.mock("../authSync", () => mockAuthSync);
// routes/otlp.ts (required by agentTracing.ts for computeIngestKey/
// verifyIngestKey) pulls in ../redisQueue, which otherwise tries a real
// Redis connection at require-time — mocked away exactly like
// otlpIngest.test.ts does.
jest.mock("../redisQueue", () => ({ addSpanIngestJob: jest.fn() }));

describe("agentTracing", () => {
  const AGENT_ID = "11111111-1111-1111-1111-111111111111";
  const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

  let agentTracing;
  let otlpRoutes;

  beforeEach(() => {
    jest.resetModules();
    mockDb.query.mockReset();
    mockAuthSync.runRuntimeCommand.mockReset();
    mockAuthSync.runContainerCommand.mockReset();
    process.env.NORA_OTLP_INGEST_SECRET = INGEST_SECRET;
    delete process.env.NORA_OTLP_PUBLIC_ENDPOINT;
    delete process.env.AGENT_RUNTIME_BACKEND_API_URL;
    delete process.env.BACKEND_API_URL;

    // Re-require inside beforeEach (after resetModules) so this file's mocks
    // for ../db and ../authSync are the same instances agentTracing.js and
    // routes/otlp.js bind at require-time — jest.resetModules() would
    // otherwise hand a re-required module fresh, disconnected mocks.
    jest.mock("../db", () => mockDb);
    jest.mock("../authSync", () => mockAuthSync);
    jest.mock("../redisQueue", () => ({ addSpanIngestJob: jest.fn() }));
    agentTracing = require("../agentTracing");
    otlpRoutes = require("../routes/otlp");
  });

  describe("buildTracingConfigDelta", () => {
    const agent = { id: AGENT_ID };
    const enabledSettings = { traces_enabled: true, trace_sample_rate: 1.0 };

    test("uses http/protobuf and never enables captureContent", () => {
      const delta = agentTracing.buildTracingConfigDelta(agent, enabledSettings);
      expect(delta.diagnostics.otel.protocol).toBe("http/protobuf");
      expect(delta.diagnostics.otel.captureContent).toBe(false);
    });

    test("carries sampleRate 1.0 by default", () => {
      const delta = agentTracing.buildTracingConfigDelta(agent, enabledSettings);
      expect(delta.diagnostics.otel.sampleRate).toBe(1.0);
    });

    test("carries a whatever trace_sample_rate is given (not hardcoded)", () => {
      const delta = agentTracing.buildTracingConfigDelta(agent, {
        traces_enabled: true,
        trace_sample_rate: 0.5,
      });
      expect(delta.diagnostics.otel.sampleRate).toBe(0.5);
    });

    test("disables tracing (rather than omitting the section) when traces_enabled is false", () => {
      const delta = agentTracing.buildTracingConfigDelta(agent, {
        traces_enabled: false,
        trace_sample_rate: 1.0,
      });
      expect(delta.diagnostics.otel.enabled).toBe(false);
      expect(delta.diagnostics.otel.traces).toBe(false);
    });

    test("the ingest key baked into the delta actually verifies against Phase 11's verifyIngestKey", () => {
      const delta = agentTracing.buildTracingConfigDelta(agent, enabledSettings);
      const mintedKey = delta.diagnostics.otel.headers["x-nora-ingest-key"];
      expect(otlpRoutes.verifyIngestKey(AGENT_ID, mintedKey)).toBe(true);
      // And a key minted for a different agent must NOT verify against this one.
      expect(otlpRoutes.verifyIngestKey("some-other-agent-id", mintedKey)).toBe(false);
    });

    test("tracesEndpoint defaults to BACKEND_API_URL and is overridden by NORA_OTLP_PUBLIC_ENDPOINT", () => {
      process.env.BACKEND_API_URL = "http://backend-api:4000";
      let delta = agentTracing.buildTracingConfigDelta(agent, enabledSettings);
      expect(delta.diagnostics.otel.tracesEndpoint).toBe("http://backend-api:4000/otlp/v1/traces");

      process.env.NORA_OTLP_PUBLIC_ENDPOINT = "https://public.example.com";
      delta = agentTracing.buildTracingConfigDelta(agent, enabledSettings);
      expect(delta.diagnostics.otel.tracesEndpoint).toBe("https://public.example.com/otlp/v1/traces");
    });
  });

  describe("mintIngestKey", () => {
    test("matches Phase 11's computeIngestKey exactly", () => {
      expect(agentTracing.mintIngestKey(AGENT_ID)).toBe(otlpRoutes.computeIngestKey(AGENT_ID));
    });
  });

  describe("applyTracingConfig", () => {
    function agentRow(overrides = {}) {
      return {
        id: AGENT_ID,
        backend_type: "docker",
        runtime_family: "openclaw",
        status: "running",
        container_id: "container-1",
        host: "127.0.0.1",
        runtime_port: 9090,
        ...overrides,
      };
    }

    test("an agent with no workspace still receives its tracing config via platform defaults", async () => {
      // workspace_agents lookup returns no row -> null workspace.
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0 });

      const result = await agentTracing.applyTracingConfig(agentRow());

      expect(result.applied).toBe(true);
      expect(result.workspaceId).toBeNull();
      // Platform default traces_enabled is false, so the applied delta must
      // be the disabling shape — but it MUST have been applied (not skipped)
      // rather than silently never receiving diagnostics.otel at all.
      expect(result.settings.traces_enabled).toBe(false);
      expect(mockAuthSync.runRuntimeCommand).toHaveBeenCalledTimes(1);
    });

    test("enabling tracing on a running agent issues no restart — only the config-merge command runs", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
        .mockResolvedValueOnce({
          rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
        });
      mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0 });

      const result = await agentTracing.applyTracingConfig(agentRow());

      expect(result.applied).toBe(true);
      expect(result.delta.diagnostics.otel.enabled).toBe(true);
      expect(mockAuthSync.runRuntimeCommand).toHaveBeenCalledTimes(1);
      const [calledAgent, calledCommand] = mockAuthSync.runRuntimeCommand.mock.calls[0];
      expect(calledAgent.id).toBe(AGENT_ID);
      expect(typeof calledCommand).toBe("string");
      // No lifecycle/restart call of any kind — authSync only exposes
      // runRuntimeCommand/runContainerCommand to this module, and only the
      // former was invoked.
      expect(mockAuthSync.runContainerCommand).not.toHaveBeenCalled();
    });

    test("falls back to runContainerCommand when the runtime sidecar is unreachable", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
        .mockResolvedValueOnce({
          rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
        });
      mockAuthSync.runRuntimeCommand.mockRejectedValueOnce(new Error("unreachable"));
      mockAuthSync.runContainerCommand.mockResolvedValueOnce({ exitCode: 0 });

      const result = await agentTracing.applyTracingConfig(agentRow());

      expect(result.applied).toBe(true);
      expect(mockAuthSync.runContainerCommand).toHaveBeenCalledTimes(1);
    });

    test("a Hermes agent is skipped entirely, without error", async () => {
      const result = await agentTracing.applyTracingConfig(agentRow({ runtime_family: "hermes" }));

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe("unsupported_runtime_family");
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockAuthSync.runRuntimeCommand).not.toHaveBeenCalled();
      expect(mockAuthSync.runContainerCommand).not.toHaveBeenCalled();
    });

    test("disabling a workspace's traces_enabled removes/disables the config for its agents", async () => {
      // First apply: enabled.
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
        .mockResolvedValueOnce({
          rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
        });
      mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0 });
      const enabledResult = await agentTracing.applyTracingConfig(agentRow());
      expect(enabledResult.delta.diagnostics.otel.enabled).toBe(true);

      // Second apply, after the workspace toggled traces_enabled off.
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
        .mockResolvedValueOnce({
          rows: [{ gateway_logs_enabled: true, traces_enabled: false, trace_sample_rate: 1.0 }],
        });
      mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0 });
      const disabledResult = await agentTracing.applyTracingConfig(agentRow());

      expect(disabledResult.applied).toBe(true);
      expect(disabledResult.delta.diagnostics.otel.enabled).toBe(false);
      expect(disabledResult.delta.diagnostics.otel.traces).toBe(false);
      expect(mockAuthSync.runRuntimeCommand).toHaveBeenCalledTimes(2);
    });
  });

  describe("reconcileTracingConfig", () => {
    test("re-applies config to an agent that restarted (config 'lost', reconcile tick runs, config present again)", async () => {
      const agent = {
        id: AGENT_ID,
        backend_type: "docker",
        runtime_family: "openclaw",
        status: "running",
        container_id: "container-1",
      };

      // 1. Query for running agents.
      mockDb.query.mockResolvedValueOnce({ rows: [agent] });
      // 2. Inside applyTracingConfig: workspace lookup.
      mockDb.query.mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] });
      // 3. Inside applyTracingConfig: settings lookup.
      mockDb.query.mockResolvedValueOnce({
        rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
      });
      mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0 });

      await agentTracing.reconcileTracingConfig();

      expect(mockAuthSync.runRuntimeCommand).toHaveBeenCalledTimes(1);
      const [, command] = mockAuthSync.runRuntimeCommand.mock.calls[0];
      expect(command).toEqual(expect.stringContaining("http/protobuf"));
    });

    test("only queries running/warning agents with a container", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await agentTracing.reconcileTracingConfig();

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toEqual(expect.stringContaining("container_id IS NOT NULL"));
      expect(sql).toEqual(expect.stringContaining("running"));
    });

    test("never throws even when an individual agent's apply fails", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: AGENT_ID,
            backend_type: "docker",
            runtime_family: "openclaw",
            status: "running",
            container_id: "container-1",
          },
        ],
      });
      mockDb.query.mockRejectedValueOnce(new Error("db unavailable"));

      await expect(agentTracing.reconcileTracingConfig()).resolves.toBeUndefined();
    });
  });
});
