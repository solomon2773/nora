// @ts-nocheck
/**
 * __tests__/traceQuery.test.ts — Phase 13 of the logging control plane
 * (GET /traces, GET /traces/:traceId): aggregate `agent_spans` into a trace
 * list, reconstruct a single trace's span tree, and correlate its window
 * against Phase 6's segment-fetching machinery.
 *
 * Dependency-injected unit tests of the real `backend-api/traceQuery.ts`
 * module — same convention as `logSearch.test.ts`: a fake `db.query` that
 * pattern-matches on SQL text, real `selectCandidateSegments`/
 * `fetchSegmentLines` behaviour stubbed via injected fakes (not the real
 * segment decode pipeline, which is already covered by logSearch.test.ts).
 */
const {
  listTraces,
  getTraceDetail,
  correlatedLogsForTrace,
  buildSpanTree,
} = require("../traceQuery.ts");

function spanRow(overrides = {}) {
  return {
    trace_id: "trace-1",
    span_id: "span-1",
    parent_span_id: null,
    workspace_id: null,
    agent_id: "agent-1",
    name: "root",
    kind: "agent",
    started_at: "2026-01-01T00:00:00.000Z",
    duration_ms: 1000,
    status: "ok",
    model: null,
    provider: null,
    tokens_in: 10,
    tokens_out: 20,
    cost_usd: 0.01,
    attrs: {},
    ...overrides,
  };
}

/**
 * Fake db.query, pattern-matched on SQL text the way logSearch.test.ts's
 * fakeDb is — this module issues three distinct query shapes:
 *   - `FROM workspace_agents WHERE agent_id` (enforceWorkspaceScope /
 *     resolveAgentWorkspaceId, both from already-shipped modules)
 *   - `FROM workspace_log_settings WHERE workspace_id` (agentTracing's
 *     resolveWorkspaceLogSettings)
 *   - `FROM agent_spans WHERE agent_id` (listTraces) or
 *     `FROM agent_spans WHERE trace_id` (getTraceDetail)
 */
function fakeDb({ workspaceByAgent = {}, spans = [], logSettingsByWorkspace = {} } = {}) {
  return {
    query: jest.fn(async (sql, params = []) => {
      if (sql.includes("FROM workspace_agents WHERE agent_id")) {
        const agentId = params[0];
        const workspaceId = workspaceByAgent[agentId];
        return { rows: workspaceId ? [{ workspace_id: workspaceId }] : [] };
      }
      if (sql.includes("FROM workspace_log_settings")) {
        const workspaceId = params[0];
        const settings = logSettingsByWorkspace[workspaceId];
        return { rows: settings ? [settings] : [] };
      }
      if (sql.includes("FROM agent_spans WHERE agent_id")) {
        const agentId = params[0];
        return { rows: spans.filter((s) => s.agent_id === agentId) };
      }
      if (sql.includes("FROM agent_spans WHERE trace_id")) {
        const traceId = params[0];
        return { rows: spans.filter((s) => s.trace_id === traceId) };
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    }),
  };
}

function agentOwner(userId, agentId = "agent-1") {
  return async (id, actor) =>
    id === agentId && actor.id === userId ? { id: agentId, user_id: userId } : null;
}

function agentAdminBypass(agentId = "agent-1") {
  return async (id, actor) => (id === agentId && actor.role === "admin" ? { id: agentId } : null);
}

describe("listTraces (item 1)", () => {
  function makeDeps({ spans = [], workspaceByAgent = {}, logSettingsByWorkspace = {}, findAgent } = {}) {
    return {
      db: fakeDb({ spans, workspaceByAgent, logSettingsByWorkspace }),
      findAccessibleAgentForActor: findAgent || agentOwner("user-1"),
    };
  }

  it("aggregates duration, span count, and cost across multiple spans in the same trace", async () => {
    const spans = [
      spanRow({
        trace_id: "trace-1",
        span_id: "root",
        parent_span_id: null,
        name: "handle-request",
        started_at: "2026-01-01T00:00:00.000Z",
        duration_ms: 500,
        tokens_in: 10,
        tokens_out: 5,
        cost_usd: 0.01,
      }),
      spanRow({
        trace_id: "trace-1",
        span_id: "child-1",
        parent_span_id: "root",
        name: "llm-call",
        started_at: "2026-01-01T00:00:00.100Z",
        duration_ms: 2000, // ends later than the root span
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.05,
      }),
      spanRow({
        trace_id: "trace-1",
        span_id: "child-2",
        parent_span_id: "root",
        name: "tool-call",
        started_at: "2026-01-01T00:00:00.200Z",
        duration_ms: 100,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      }),
    ];
    const deps = makeDeps({ spans });

    const result = await listTraces({ agentId: "agent-1" }, { id: "user-1" }, deps);

    expect(result.traces).toHaveLength(1);
    const trace = result.traces[0];
    expect(trace.traceId).toBe("trace-1");
    expect(trace.spanCount).toBe(3);
    expect(trace.tokensIn).toBe(110);
    expect(trace.tokensOut).toBe(55);
    expect(trace.costUsd).toBeCloseTo(0.06);
    expect(trace.rootSpanName).toBe("handle-request");
    expect(trace.status).toBe("ok");
    // Window spans from 00:00:00.000 to the latest span end: child-1 started
    // at 00:00:00.100 and ran for 2000ms -> ends at 00:00:02.100, which is
    // later than the root's own 00:00:00.500 end -- the aggregate must use
    // the actual latest end across all spans, not just the root's own.
    expect(trace.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(trace.durationMs).toBe(2100);
  });

  it("groups multiple distinct traces independently", async () => {
    const spans = [
      spanRow({ trace_id: "trace-1", span_id: "a", started_at: "2026-01-01T00:00:00.000Z" }),
      spanRow({ trace_id: "trace-2", span_id: "b", started_at: "2026-01-01T00:05:00.000Z" }),
    ];
    const deps = makeDeps({ spans });
    const result = await listTraces({ agentId: "agent-1" }, { id: "user-1" }, deps);
    expect(result.traces.map((t) => t.traceId).sort()).toEqual(["trace-1", "trace-2"]);
  });

  it("reports tracesEnabled/traceSampleRate resolved from workspace_log_settings", async () => {
    const deps = makeDeps({
      spans: [],
      workspaceByAgent: { "agent-1": "ws-A" },
      logSettingsByWorkspace: {
        "ws-A": { gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 0.5 },
      },
    });
    const result = await listTraces({ agentId: "agent-1", workspaceId: "ws-A" }, { id: "user-1" }, deps);
    expect(result.workspaceId).toBe("ws-A");
    expect(result.tracesEnabled).toBe(true);
    expect(result.traceSampleRate).toBe(0.5);
  });

  describe("distinguishing 'tracing disabled' from 'enabled but empty' (item 7)", () => {
    it("tracesEnabled is false and traces is empty when a workspace never turned tracing on", async () => {
      const deps = makeDeps({
        spans: [],
        workspaceByAgent: { "agent-1": "ws-A" },
        logSettingsByWorkspace: {
          "ws-A": { gateway_logs_enabled: true, traces_enabled: false, trace_sample_rate: 1 },
        },
      });
      const result = await listTraces({ agentId: "agent-1", workspaceId: "ws-A" }, { id: "user-1" }, deps);
      expect(result.tracesEnabled).toBe(false);
      expect(result.traces).toEqual([]);
    });

    it("tracesEnabled is true and traces is empty when tracing is on but nothing has run yet", async () => {
      const deps = makeDeps({
        spans: [],
        workspaceByAgent: { "agent-1": "ws-A" },
        logSettingsByWorkspace: {
          "ws-A": { gateway_logs_enabled: true, traces_enabled: true, trace_sample_rate: 1 },
        },
      });
      const result = await listTraces({ agentId: "agent-1", workspaceId: "ws-A" }, { id: "user-1" }, deps);
      expect(result.tracesEnabled).toBe(true);
      expect(result.traces).toEqual([]);
      // The two empty-list cases above are only distinguishable via
      // `tracesEnabled` -- `traces` alone is identically `[]` in both.
    });
  });

  describe("workspace scoping (item 8)", () => {
    it("workspace-A actor receives zero workspace-B rows", async () => {
      const deps = makeDeps({
        spans: [spanRow()],
        workspaceByAgent: { "agent-1": "ws-A" },
      });
      await expect(
        listTraces({ agentId: "agent-1", workspaceId: "ws-B" }, { id: "user-1" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
    });

    it("a platform admin querying workspace A receives zero workspace-B rows despite the per-agent admin bypass", async () => {
      const deps = makeDeps({
        spans: [spanRow()],
        workspaceByAgent: { "agent-1": "ws-A" },
        findAgent: agentAdminBypass("agent-1"),
      });
      await expect(
        listTraces({ agentId: "agent-1", workspaceId: "ws-B" }, { id: "admin-1", role: "admin" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });

      const ok = await listTraces(
        { agentId: "agent-1", workspaceId: "ws-A" },
        { id: "admin-1", role: "admin" },
        deps,
      );
      expect(ok.traces).toHaveLength(1);
    });

    it("lets an admin session list traces for an agent in any workspace without naming one", async () => {
      const deps = makeDeps({
        spans: [spanRow()],
        workspaceByAgent: { "agent-1": "ws-A" },
        findAgent: agentAdminBypass("agent-1"),
      });
      const result = await listTraces({ agentId: "agent-1" }, { id: "admin-1", role: "admin" }, deps);
      expect(result.traces).toHaveLength(1);
    });

    it("an unassigned agent's spans are returned to its owner, never filtered out by workspace scoping", async () => {
      const deps = makeDeps({
        spans: [spanRow()],
        workspaceByAgent: {}, // no workspace_agents row for agent-1
      });
      const ok = await listTraces({ agentId: "agent-1" }, { id: "user-1" }, deps);
      expect(ok.traces).toHaveLength(1);
      expect(ok.workspaceId).toBeNull();

      // A workspaceId filter can never match an unassigned agent.
      await expect(
        listTraces({ agentId: "agent-1", workspaceId: "ws-X" }, { id: "user-1" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
    });

    it("someone who is not the owner is rejected with 404 before any span is read", async () => {
      const deps = makeDeps({ spans: [spanRow()], workspaceByAgent: {} });
      await expect(
        listTraces({ agentId: "agent-1" }, { id: "someone-else" }, deps),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});

describe("buildSpanTree (parent/child nesting)", () => {
  it("reconstructs nesting from parent_span_id via a computed depth, sorted chronologically", () => {
    const spans = [
      spanRow({ span_id: "root", parent_span_id: null, started_at: "2026-01-01T00:00:00.000Z" }),
      spanRow({ span_id: "child", parent_span_id: "root", started_at: "2026-01-01T00:00:00.100Z" }),
      spanRow({ span_id: "grandchild", parent_span_id: "child", started_at: "2026-01-01T00:00:00.200Z" }),
      spanRow({ span_id: "sibling", parent_span_id: "root", started_at: "2026-01-01T00:00:00.050Z" }),
    ];
    const tree = buildSpanTree(spans);
    const bySpanId = Object.fromEntries(tree.map((n) => [n.spanId, n]));
    expect(bySpanId.root.depth).toBe(0);
    expect(bySpanId.child.depth).toBe(1);
    expect(bySpanId.grandchild.depth).toBe(2);
    expect(bySpanId.sibling.depth).toBe(1);
    // Chronological order, not insertion order.
    expect(tree.map((n) => n.spanId)).toEqual(["root", "sibling", "child", "grandchild"]);
  });

  it("treats a span whose parent isn't in this trace's row set as a root (depth 0)", () => {
    const spans = [spanRow({ span_id: "orphan", parent_span_id: "not-in-this-trace" })];
    const tree = buildSpanTree(spans);
    expect(tree[0].depth).toBe(0);
  });
});

describe("correlatedLogsForTrace (items 3/4)", () => {
  function logLine(overrides = {}) {
    return {
      ts: "2026-01-01T00:00:00.500Z",
      observed_ts: "2026-01-01T00:00:00.510Z",
      stream: "gateway",
      level: "INFO",
      message: "hello",
      trace_id: null,
      ord: 0,
      ...overrides,
    };
  }

  function segmentRow(overrides = {}) {
    return {
      id: "seg-1",
      agent_id: "agent-1",
      stream: "gateway",
      ts_from: "2026-01-01T00:00:00.000Z",
      ts_to: "2026-01-01T00:15:00.000Z",
      storage_key: "key-seg-1",
      ...overrides,
    };
  }

  it("includes gateway lines whose trace_id matches, marked inTrace: true / category: 'trace'", async () => {
    const spans = [spanRow({ trace_id: "trace-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 1000 })];
    const gatewayRow = segmentRow({ stream: "gateway", storage_key: "key-gw" });
    const deps = {
      selectCandidateSegments: jest.fn(async () => [gatewayRow]),
      fetchSegmentLines: jest.fn(async (row) =>
        row.storage_key === "key-gw"
          ? [logLine({ trace_id: "trace-1", message: "matched gateway line" })]
          : [],
      ),
    };

    const result = await correlatedLogsForTrace(spans, deps);
    expect(result).toHaveLength(1);
    expect(result[0].inTrace).toBe(true);
    expect(result[0].category).toBe("trace");
    expect(result[0].message).toBe("matched gateway line");
  });

  it("includes an in-window gateway line from a different trace_id, flagged inTrace: false / category: 'window' (its trace_id is OpenClaw's own internal id, not the OTel trace_id, so it cannot be used to exclude)", async () => {
    const spans = [spanRow({ trace_id: "trace-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 1000 })];
    const deps = {
      selectCandidateSegments: jest.fn(async () => [segmentRow({ stream: "gateway" })]),
      fetchSegmentLines: jest.fn(async () => [logLine({ trace_id: "some-other-trace" })]),
    };
    const result = await correlatedLogsForTrace(spans, deps);
    expect(result).toHaveLength(1);
    expect(result[0].inTrace).toBe(false);
    expect(result[0].category).toBe("window");
  });

  it("excludes a gateway line from a different trace_id that falls OUTSIDE the time window", async () => {
    const spans = [spanRow({ trace_id: "trace-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 1000 })];
    const deps = {
      selectCandidateSegments: jest.fn(async () => [segmentRow({ stream: "gateway" })]),
      fetchSegmentLines: jest.fn(async () => [
        logLine({ trace_id: "some-other-trace", ts: "2026-01-01T00:05:00.000Z" }),
      ]),
    };
    const result = await correlatedLogsForTrace(spans, deps);
    expect(result).toEqual([]);
  });

  it("includes untraced runtime lines in the same agent+time window, flagged inTrace: false / category: 'window'", async () => {
    const spans = [spanRow({ trace_id: "trace-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 1000 })];
    const runtimeRow = segmentRow({ stream: "runtime", storage_key: "key-rt" });
    const deps = {
      selectCandidateSegments: jest.fn(async () => [runtimeRow]),
      fetchSegmentLines: jest.fn(async (row) =>
        row.storage_key === "key-rt"
          ? [
              logLine({
                stream: "runtime",
                trace_id: null, // runtime lines never carry a trace_id
                ts: "2026-01-01T00:00:00.400Z",
                message: "container crashed",
              }),
            ]
          : [],
      ),
    };

    const result = await correlatedLogsForTrace(spans, deps);
    expect(result).toHaveLength(1);
    expect(result[0].inTrace).toBe(false);
    expect(result[0].category).toBe("window");
    expect(result[0].message).toBe("container crashed");
  });

  it("does not silently merge traced and untraced lines -- both groups are distinctly flagged in one response", async () => {
    const spans = [spanRow({ trace_id: "trace-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 1000 })];
    const deps = {
      selectCandidateSegments: jest.fn(async () => [
        segmentRow({ stream: "gateway", storage_key: "key-gw" }),
        segmentRow({ stream: "runtime", storage_key: "key-rt" }),
      ]),
      fetchSegmentLines: jest.fn(async (row) => {
        if (row.storage_key === "key-gw") {
          return [logLine({ stream: "gateway", trace_id: "trace-1", message: "gateway line" })];
        }
        if (row.storage_key === "key-rt") {
          return [
            logLine({
              stream: "runtime",
              trace_id: null,
              ts: "2026-01-01T00:00:00.600Z",
              message: "runtime line",
            }),
          ];
        }
        return [];
      }),
    };

    const result = await correlatedLogsForTrace(spans, deps);
    expect(result).toHaveLength(2);
    const byMessage = Object.fromEntries(result.map((l) => [l.message, l]));
    expect(byMessage["gateway line"]).toMatchObject({ inTrace: true, category: "trace" });
    expect(byMessage["runtime line"]).toMatchObject({ inTrace: false, category: "window" });
  });

  it("excludes a runtime line whose timestamp falls outside the trace's actual window even though its segment overlaps", async () => {
    // Segments are pruned by 15-minute buckets, which are wider than most
    // traces -- a runtime line elsewhere in the same bucket must not leak in.
    const spans = [spanRow({ trace_id: "trace-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 1000 })];
    const deps = {
      selectCandidateSegments: jest.fn(async () => [segmentRow({ stream: "runtime", storage_key: "key-rt" })]),
      fetchSegmentLines: jest.fn(async () => [
        logLine({ stream: "runtime", trace_id: null, ts: "2026-01-01T00:14:00.000Z", message: "far away" }),
      ]),
    };
    const result = await correlatedLogsForTrace(spans, deps);
    expect(result).toEqual([]);
  });

  it("prunes candidate segments by agent and time window, not by trace", async () => {
    const spans = [
      spanRow({ trace_id: "trace-1", agent_id: "agent-1", started_at: "2026-01-01T00:00:00.000Z", duration_ms: 500 }),
    ];
    const selectCandidateSegments = jest.fn(async () => []);
    await correlatedLogsForTrace(spans, { selectCandidateSegments, fetchSegmentLines: jest.fn(async () => []) });
    expect(selectCandidateSegments).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", streams: expect.arrayContaining(["runtime", "gateway"]) }),
      expect.anything(),
    );
    // No trace_id anywhere in the call -- pruning is agent+time only.
    const callArgs = selectCandidateSegments.mock.calls[0][0];
    expect(callArgs.traceId).toBeUndefined();
  });
});

describe("getTraceDetail (item 2)", () => {
  function makeDeps({
    spans = [],
    workspaceByAgent = {},
    findAgent,
    correlatedLogs = [],
  } = {}) {
    return {
      db: fakeDb({ spans, workspaceByAgent }),
      findAccessibleAgentForActor: findAgent || agentOwner("user-1"),
      correlatedLogsForTrace: jest.fn(async () => correlatedLogs),
    };
  }

  it("returns the trace summary, a flat span list, and correlated logs", async () => {
    const spans = [
      spanRow({ trace_id: "trace-1", span_id: "root", parent_span_id: null, started_at: "2026-01-01T00:00:00.000Z", duration_ms: 500 }),
      spanRow({ trace_id: "trace-1", span_id: "child", parent_span_id: "root", started_at: "2026-01-01T00:00:00.100Z", duration_ms: 100 }),
    ];
    const deps = makeDeps({ spans, correlatedLogs: [{ message: "line", inTrace: true, category: "trace" }] });

    const result = await getTraceDetail("trace-1", { id: "user-1" }, {}, deps);

    expect(result.trace.traceId).toBe("trace-1");
    expect(result.trace.spanCount).toBe(2);
    expect(result.spans).toHaveLength(2);
    expect(result.spans.map((s) => s.spanId).sort()).toEqual(["child", "root"]);
    expect(result.spans.find((s) => s.spanId === "child").parentSpanId).toBe("root");
    expect(result.correlatedLogs).toEqual([{ message: "line", inTrace: true, category: "trace" }]);
  });

  it("returns 404 for a trace_id with no rows", async () => {
    const deps = makeDeps({ spans: [] });
    await expect(getTraceDetail("nope", { id: "user-1" }, {}, deps)).rejects.toMatchObject({ statusCode: 404 });
  });

  describe("workspace scoping (item 8)", () => {
    it("workspace-A actor cannot fetch a trace belonging to workspace-B's agent", async () => {
      const spans = [spanRow({ trace_id: "trace-1", agent_id: "agent-1" })];
      const deps = makeDeps({ spans, workspaceByAgent: { "agent-1": "ws-A" } });
      await expect(
        getTraceDetail("trace-1", { id: "user-1" }, { workspaceId: "ws-B" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
    });

    it("a platform admin is still subject to workspace scoping despite the per-agent admin bypass", async () => {
      const spans = [spanRow({ trace_id: "trace-1", agent_id: "agent-1" })];
      const deps = makeDeps({
        spans,
        workspaceByAgent: { "agent-1": "ws-A" },
        findAgent: agentAdminBypass("agent-1"),
      });
      await expect(
        getTraceDetail("trace-1", { id: "admin-1", role: "admin" }, { workspaceId: "ws-B" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });

      const ok = await getTraceDetail(
        "trace-1",
        { id: "admin-1", role: "admin" },
        { workspaceId: "ws-A" },
        deps,
      );
      expect(ok.trace.traceId).toBe("trace-1");
    });

    it("an unassigned agent's trace is returned to its owner, never filtered out by workspace scoping", async () => {
      const spans = [spanRow({ trace_id: "trace-1", agent_id: "agent-1" })];
      const deps = makeDeps({ spans, workspaceByAgent: {} });
      const ok = await getTraceDetail("trace-1", { id: "user-1" }, {}, deps);
      expect(ok.trace.traceId).toBe("trace-1");

      await expect(
        getTraceDetail("trace-1", { id: "user-1" }, { workspaceId: "ws-X" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
    });

    it("someone who is not the owner is rejected with 404, indistinguishable from a nonexistent trace", async () => {
      const spans = [spanRow({ trace_id: "trace-1", agent_id: "agent-1" })];
      const deps = makeDeps({ spans, workspaceByAgent: {} });
      await expect(
        getTraceDetail("trace-1", { id: "someone-else" }, {}, deps),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
