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

    describe("per-agent tracing capability", () => {
      test("buildEnableTracingPluginCommand's shell fragment checks real enablement rather than trusting install/enable exit codes", () => {
        const command = agentTracing.buildEnableTracingPluginCommand();
        expect(command).toContain("openclaw plugins list --enabled --json");
        expect(command).toMatch(/__NORA_TRACING_CAPABILITY__=supported/);
        expect(command).toMatch(/__NORA_TRACING_CAPABILITY__=unsupported/);
      });

      test("buildEnableTracingPluginCommand's shell fragment also captures the raw OpenClaw version for diagnostics", () => {
        const command = agentTracing.buildEnableTracingPluginCommand();
        expect(command).toContain("__NORA_TRACING_OPENCLAW_VERSION__=$(openclaw --version");
      });

      test("parseTracingOpenclawVersionFromOutput reads the raw version line out of arbitrary surrounding output", () => {
        expect(
          agentTracing.parseTracingOpenclawVersionFromOutput(
            "noise\n__NORA_TRACING_OPENCLAW_VERSION__=OpenClaw 2026.6.11 (abc123)\nmore noise",
          ),
        ).toBe("OpenClaw 2026.6.11 (abc123)");
      });

      test("parseTracingOpenclawVersionFromOutput returns undefined for an empty or missing marker", () => {
        expect(agentTracing.parseTracingOpenclawVersionFromOutput("")).toBeUndefined();
        expect(agentTracing.parseTracingOpenclawVersionFromOutput("__NORA_TRACING_OPENCLAW_VERSION__=")).toBeUndefined();
        expect(agentTracing.parseTracingOpenclawVersionFromOutput("no marker here")).toBeUndefined();
      });

      test("parseTracingCapabilityFromOutput reads the marker out of arbitrary surrounding output", () => {
        expect(
          agentTracing.parseTracingCapabilityFromOutput(
            "some noise\n__NORA_TRACING_CAPABILITY__=supported\nmore noise",
          ),
        ).toBe("supported");
        expect(
          agentTracing.parseTracingCapabilityFromOutput("__NORA_TRACING_CAPABILITY__=unsupported"),
        ).toBe("unsupported");
      });

      test("parseTracingCapabilityFromOutput returns undefined when the marker never printed (unreachable agent, shell error before the check)", () => {
        expect(agentTracing.parseTracingCapabilityFromOutput("")).toBeUndefined();
        expect(agentTracing.parseTracingCapabilityFromOutput(undefined)).toBeUndefined();
        expect(agentTracing.parseTracingCapabilityFromOutput("sh: command not found")).toBeUndefined();
      });

      test("persists 'supported' to agents.tracing_capability when the plugin check output says so", async () => {
        mockDb.query
          .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
          .mockResolvedValueOnce({
            rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
          })
          .mockResolvedValueOnce({ rows: [] }) // optimistic pre-write of checked_at
          .mockResolvedValueOnce({ rows: [] }); // the final capability UPDATE
        mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({
          exitCode: 0,
          output:
            "some plugin install noise\n__NORA_TRACING_CAPABILITY__=supported\n__NORA_TRACING_OPENCLAW_VERSION__=OpenClaw 2026.9.4 (abc123)\n",
        });

        const result = await agentTracing.applyTracingConfig(agentRow());

        expect(result.tracingCapability).toBe("supported");
        expect(result.tracingOpenclawVersion).toBe("OpenClaw 2026.9.4 (abc123)");
        expect(mockDb.query).toHaveBeenLastCalledWith(
          expect.stringContaining("SET tracing_capability = $1"),
          ["supported", "OpenClaw 2026.9.4 (abc123)", AGENT_ID],
        );
      });

      test("persists 'unsupported' the same way when the plugin check fails", async () => {
        mockDb.query
          .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
          .mockResolvedValueOnce({
            rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
          })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] });
        mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({
          exitCode: 0,
          output:
            "requires plugin API >=2026.9.3, but this OpenClaw runtime exposes 2026.6.11\n__NORA_TRACING_CAPABILITY__=unsupported\n__NORA_TRACING_OPENCLAW_VERSION__=OpenClaw 2026.6.11 (def456)\n",
        });

        const result = await agentTracing.applyTracingConfig(agentRow());

        expect(result.tracingCapability).toBe("unsupported");
        expect(result.tracingOpenclawVersion).toBe("OpenClaw 2026.6.11 (def456)");
        expect(mockDb.query).toHaveBeenLastCalledWith(
          expect.stringContaining("SET tracing_capability = $1"),
          ["unsupported", "OpenClaw 2026.6.11 (def456)", AGENT_ID],
        );
      });

      test("does not touch tracing_capability at all when traces_enabled is false -- no attempt means no new information", async () => {
        mockDb.query
          .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
          .mockResolvedValueOnce({
            rows: [{ gateway_logs_enabled: true, traces_enabled: false, trace_sample_rate: 1.0 }],
          });
        mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0, output: "" });

        const result = await agentTracing.applyTracingConfig(agentRow());

        expect(result.tracingCapability).toBeUndefined();
        // Exactly the two lookups from above -- no plugin check attempted at
        // all when traces_enabled is false, so no checked_at pre-write and
        // no capability UPDATE either.
        expect(mockDb.query).toHaveBeenCalledTimes(2);
      });

      test("does not persist a capability verdict when the marker never printed, but still records the attempt via checked_at", async () => {
        mockDb.query
          .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
          .mockResolvedValueOnce({
            rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
          })
          .mockResolvedValueOnce({ rows: [] }); // the optimistic pre-write
        mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0, output: "no marker here" });

        const result = await agentTracing.applyTracingConfig(agentRow());

        expect(result.tracingCapability).toBeUndefined();
        // workspace lookup, settings lookup, and the pre-write -- no 4th
        // (final capability) UPDATE since no verdict was ever parsed.
        expect(mockDb.query).toHaveBeenCalledTimes(3);
        expect(mockDb.query).toHaveBeenLastCalledWith(
          expect.stringContaining("UPDATE agents SET tracing_capability_checked_at = NOW()"),
          [AGENT_ID],
        );
      });

      test("shouldCheckTracingCapability: always checks when capability is unknown or absent", () => {
        expect(agentTracing.shouldCheckTracingCapability({})).toBe(true);
        expect(agentTracing.shouldCheckTracingCapability({ tracing_capability: "unknown" })).toBe(true);
      });

      test("shouldCheckTracingCapability: always checks when a known verdict has no checked_at timestamp", () => {
        expect(agentTracing.shouldCheckTracingCapability({ tracing_capability: "unsupported" })).toBe(true);
      });

      test("shouldCheckTracingCapability: skips a recent known verdict, within the recheck interval", () => {
        const now = Date.parse("2026-01-01T00:10:00.000Z");
        const checkedAt = "2026-01-01T00:00:00.000Z"; // 10 minutes ago, well under the 30-minute interval
        expect(
          agentTracing.shouldCheckTracingCapability(
            { tracing_capability: "unsupported", tracing_capability_checked_at: checkedAt },
            now,
          ),
        ).toBe(false);
      });

      test("shouldCheckTracingCapability: rechecks a known verdict once the recheck interval has elapsed", () => {
        const checkedAt = "2026-01-01T00:00:00.000Z";
        const now = Date.parse(checkedAt) + agentTracing.TRACING_CAPABILITY_RECHECK_INTERVAL_MS;
        expect(
          agentTracing.shouldCheckTracingCapability(
            { tracing_capability: "unsupported", tracing_capability_checked_at: checkedAt },
            now,
          ),
        ).toBe(true);
      });

      test("reconcileTracingConfig's automatic 30s loop skips the plugin check entirely once a verdict is already fresh -- the exact collision this throttle exists to prevent", async () => {
        const freshlyChecked = new Date().toISOString();
        mockDb.query
          .mockResolvedValueOnce({
            rows: [
              agentRow({
                tracing_capability: "unsupported",
                tracing_capability_checked_at: freshlyChecked,
              }),
            ],
          })
          .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
          .mockResolvedValueOnce({
            rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
          });
        mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0, output: "" });

        await agentTracing.reconcileTracingConfig({});

        // Only the config-merge command ran -- no buildEnableTracingPluginCommand
        // fragment (no `openclaw plugins install`) in what was sent.
        const [, calledCommand] = mockAuthSync.runRuntimeCommand.mock.calls[0];
        expect(calledCommand).not.toContain("openclaw plugins install");
      });

      test("a deliberate operator toggle (forceCapabilityCheck) bypasses the throttle even with a fresh checked_at", async () => {
        const freshlyChecked = new Date().toISOString();
        mockDb.query
          .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
          .mockResolvedValueOnce({
            rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
          })
          .mockResolvedValueOnce({ rows: [] });
        mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0, output: "" });

        await agentTracing.applyTracingConfig(
          agentRow({ tracing_capability: "unsupported", tracing_capability_checked_at: freshlyChecked }),
          {},
          { forceCapabilityCheck: true },
        );

        const [, calledCommand] = mockAuthSync.runRuntimeCommand.mock.calls[0];
        expect(calledCommand).toContain("openclaw plugins install");
      });

      describe("version-probe fast path (a throttled recheck of an already-known verdict)", () => {
        // shouldCheckTracingCapability returns true (due for recheck) once
        // the interval has elapsed -- use a checked_at older than that so
        // dueForCapabilityCheck is true without forceCapabilityCheck.
        // Computed fresh per test (not at describe-body eval time, before
        // `agentTracing` is even assigned by the outer beforeEach).
        let staleCheckedAt;
        beforeEach(() => {
          staleCheckedAt = new Date(
            Date.now() - agentTracing.TRACING_CAPABILITY_RECHECK_INTERVAL_MS - 1000,
          ).toISOString();
        });

        test("an unchanged version skips the real plugin check entirely -- only the cheap probe and the config merge run", async () => {
          mockDb.query
            .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
            .mockResolvedValueOnce({
              rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
            })
            .mockResolvedValueOnce({ rows: [] }); // checked_at refresh
          mockAuthSync.runRuntimeCommand
            .mockResolvedValueOnce({ exitCode: 0, output: "OpenClaw 2026.6.11 (e085fa1)" }) // the probe
            .mockResolvedValueOnce({ exitCode: 0, output: "" }); // the actual command

          const result = await agentTracing.applyTracingConfig(
            agentRow({
              tracing_capability: "unsupported",
              tracing_capability_checked_at: staleCheckedAt,
              tracing_openclaw_version: "OpenClaw 2026.6.11 (e085fa1)",
            }),
          );

          expect(mockAuthSync.runRuntimeCommand).toHaveBeenCalledTimes(2);
          const [, probeCommand] = mockAuthSync.runRuntimeCommand.mock.calls[0];
          expect(probeCommand).toBe(agentTracing.buildProbeOpenclawVersionCommand());
          const [, secondCommand] = mockAuthSync.runRuntimeCommand.mock.calls[1];
          expect(secondCommand).not.toContain("openclaw plugins install");
          // No verdict was re-derived -- the existing one stands unreported
          // (the caller already knows it from the agent row it passed in).
          expect(result.tracingCapability).toBeUndefined();
          // workspace lookup, settings lookup, checked_at refresh -- no 4th
          // (capability-persisting) UPDATE, since nothing changed.
          expect(mockDb.query).toHaveBeenCalledTimes(3);
        });

        test("a changed version escalates to the real plugin check", async () => {
          mockDb.query
            .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
            .mockResolvedValueOnce({
              rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
            })
            .mockResolvedValueOnce({ rows: [] }) // checked_at refresh
            .mockResolvedValueOnce({ rows: [] }); // final capability persist
          mockAuthSync.runRuntimeCommand
            .mockResolvedValueOnce({ exitCode: 0, output: "OpenClaw 2026.9.4 (abc123)" }) // the probe -- changed!
            .mockResolvedValueOnce({
              exitCode: 0,
              output:
                "__NORA_TRACING_CAPABILITY__=supported\n__NORA_TRACING_OPENCLAW_VERSION__=OpenClaw 2026.9.4 (abc123)\n",
            });

          const result = await agentTracing.applyTracingConfig(
            agentRow({
              tracing_capability: "unsupported",
              tracing_capability_checked_at: staleCheckedAt,
              tracing_openclaw_version: "OpenClaw 2026.6.11 (e085fa1)",
            }),
          );

          const [, secondCommand] = mockAuthSync.runRuntimeCommand.mock.calls[1];
          expect(secondCommand).toContain("openclaw plugins install");
          expect(result.tracingCapability).toBe("supported");
        });

        test("a known verdict with no previously-recorded version treats any real probe result as a change (safe default)", async () => {
          mockDb.query
            .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
            .mockResolvedValueOnce({
              rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
          mockAuthSync.runRuntimeCommand
            .mockResolvedValueOnce({ exitCode: 0, output: "OpenClaw 2026.6.11 (e085fa1)" })
            .mockResolvedValueOnce({
              exitCode: 0,
              output: "__NORA_TRACING_CAPABILITY__=unsupported\n",
            });

          await agentTracing.applyTracingConfig(
            agentRow({ tracing_capability: "unsupported", tracing_capability_checked_at: staleCheckedAt }),
          );

          const [, secondCommand] = mockAuthSync.runRuntimeCommand.mock.calls[1];
          expect(secondCommand).toContain("openclaw plugins install");
        });

        test("a probe that fails on both the runtime sidecar AND the container-exec fallback falls through to the real check rather than silently trusting a stale verdict", async () => {
          mockDb.query
            .mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID }] })
            .mockResolvedValueOnce({
              rows: [{ gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1.0 }],
            })
            .mockResolvedValueOnce({ rows: [] });
          // applyConfigMergeCommand's own runRuntimeCommand -> runContainerCommand
          // fallback means the probe only truly fails (and reaches this
          // module's outer catch) if BOTH reject.
          mockAuthSync.runRuntimeCommand.mockRejectedValueOnce(new Error("probe unreachable"));
          mockAuthSync.runContainerCommand.mockRejectedValueOnce(new Error("probe unreachable"));
          mockAuthSync.runRuntimeCommand.mockResolvedValueOnce({ exitCode: 0, output: "" }); // the actual command, on its own fresh attempt

          await agentTracing.applyTracingConfig(
            agentRow({
              tracing_capability: "unsupported",
              tracing_capability_checked_at: staleCheckedAt,
              tracing_openclaw_version: "OpenClaw 2026.6.11 (e085fa1)",
            }),
          );

          const [, secondCommand] = mockAuthSync.runRuntimeCommand.mock.calls[1];
          expect(secondCommand).toContain("openclaw plugins install");
        });
      });
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
