// @ts-nocheck
/**
 * __tests__/logExport.test.ts — Phase 7 of the logging control plane
 * (GET /logs/export): same filters as search, no pagination, streamed
 * incrementally as NDJSON or CSV.
 *
 * Dependency-injected unit tests of `streamLogExport`, matching
 * logSearch.test.ts's convention. `res` is faked as a minimal writable
 * stream recorder (`write`/`end`/`setHeader`) rather than a real Express
 * response, since none of this module's logic depends on Express itself.
 */
const {
  streamLogExport,
  searchLogs,
  assertExportRangeWithinCap,
  exportFilename,
  csvEscape,
  EXPORT_MAX_RANGE_MS,
} = require("../logSearch.ts");

function line(overrides = {}) {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    observed_ts: "2026-01-01T00:00:00.010Z",
    ts_source: "source",
    stream: "runtime",
    level: "INFO",
    message: "hello",
    trace_id: null,
    span_id: null,
    session_id: null,
    channel: null,
    ord: 0,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: overrides.id || "seg-1",
    workspace_id: null,
    agent_id: "agent-1",
    stream: "runtime",
    ts_from: "2026-01-01T00:00:00.000Z",
    ts_to: "2026-01-01T00:15:00.000Z",
    storage_key: overrides.id ? `key-${overrides.id}` : "key-seg-1",
    storage_backend: "local",
    storage_config: {},
    encryption_key_id: "default",
    ...overrides,
  };
}

function fakeDb(workspaceByAgent = {}) {
  return {
    query: jest.fn(async (sql, params = []) => {
      if (sql.includes("FROM workspace_agents WHERE agent_id")) {
        const workspaceId = workspaceByAgent[params[0]];
        return { rows: workspaceId ? [{ workspace_id: workspaceId }] : [] };
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    }),
  };
}

function fakeResponse() {
  const chunks = [];
  const headers = {};
  return {
    headers,
    chunks,
    setHeader: (name, value) => {
      headers[name] = value;
    },
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    end: jest.fn(),
    text: () => chunks.join(""),
  };
}

function makeDeps({ rows = [], linesByKey = {}, workspaceByAgent = {} } = {}) {
  return {
    db: fakeDb(workspaceByAgent),
    findAccessibleAgentForActor: async (agentId, actor) =>
      agentId === "agent-1" && actor.id === "user-1" ? { id: "agent-1" } : null,
    selectCandidateSegments: jest.fn(async () =>
      rows.slice().sort((a, b) => new Date(b.ts_to).getTime() - new Date(a.ts_to).getTime()),
    ),
    fetchSegmentLines: jest.fn(async (r) => linesByKey[r.storage_key] || []),
    keyRing: {},
  };
}

describe("streamLogExport (Phase 7)", () => {
  it("NDJSON export output matches the equivalent search result set exactly", async () => {
    const rows = [
      row({ id: "a", ts_from: "2026-01-01T00:00:00.000Z", ts_to: "2026-01-01T00:15:00.000Z" }),
      row({ id: "b", ts_from: "2026-01-01T00:15:00.000Z", ts_to: "2026-01-01T00:30:00.000Z" }),
    ];
    const linesByKey = {
      "key-a": [line({ ts: "2026-01-01T00:05:00.000Z", ord: 0 })],
      "key-b": [line({ ts: "2026-01-01T00:20:00.000Z", ord: 0 })],
    };
    const deps = makeDeps({ rows, linesByKey });
    deps.fetchConcurrency = 8;

    const res = fakeResponse();
    await streamLogExport(
      { agentId: "agent-1", from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" },
      { id: "user-1" },
      res,
      deps,
    );

    const exported = res
      .text()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const searchResult = await searchLogs(
      {
        agentId: "agent-1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T01:00:00.000Z",
        order: "asc",
        limit: 1000,
      },
      { id: "user-1" },
      { ...deps, fetchWorkerBuffer: async () => null },
    );

    expect(exported.map((l) => l.ts)).toEqual(searchResult.lines.map((l) => l.ts));
    expect(res.headers["Content-Type"]).toContain("application/x-ndjson");
  });

  it("CSV export correctly escapes embedded commas, quotes, and newlines", async () => {
    const rows = [row({ id: "a" })];
    const linesByKey = {
      "key-a": [line({ message: 'has, a comma "and quotes"\nand a newline' })],
    };
    const deps = makeDeps({ rows, linesByKey });

    const res = fakeResponse();
    await streamLogExport(
      {
        agentId: "agent-1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T01:00:00.000Z",
        format: "csv",
      },
      { id: "user-1" },
      res,
      deps,
    );

    const text = res.text();
    expect(text).toContain('"has, a comma ""and quotes""\nand a newline"');
    expect(res.headers["Content-Type"]).toContain("text/csv");
  });

  it("Content-Disposition filename is well-formed and timestamped", () => {
    const filename = exportFilename("ndjson");
    expect(filename).toMatch(/^nora-logs-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.ndjson$/);
    expect(exportFilename("csv")).toMatch(/\.csv$/);
  });

  it("a request for an over-cap time range is rejected with a clear, actionable error", () => {
    const from = new Date(0).toISOString();
    const to = new Date(EXPORT_MAX_RANGE_MS * 2).toISOString();
    expect(() => assertExportRangeWithinCap(from, to)).toThrow(/exceeds the maximum exportable range/);
    try {
      assertExportRangeWithinCap(from, to);
    } catch (error) {
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("export_range_too_large");
    }
  });

  it("rejects an over-cap export via streamLogExport before writing anything", async () => {
    const deps = makeDeps({ rows: [] });
    const res = fakeResponse();
    const from = new Date(0).toISOString();
    const to = new Date(EXPORT_MAX_RANGE_MS * 2).toISOString();
    await expect(
      streamLogExport({ agentId: "agent-1", from, to }, { id: "user-1" }, res, deps),
    ).rejects.toMatchObject({ statusCode: 400, code: "export_range_too_large" });
    expect(res.chunks).toHaveLength(0);
  });

  it("export is workspace-scoped identically to search", async () => {
    const deps = makeDeps({ rows: [row()], workspaceByAgent: { "agent-1": "ws-A" } });
    const res = fakeResponse();
    await expect(
      streamLogExport(
        {
          agentId: "agent-1",
          workspaceId: "ws-B",
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        { id: "user-1" },
        res,
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
  });

  it("streams incrementally: res.write is called before the whole export completes fetching", async () => {
    const rows = [
      row({ id: "a", ts_from: "2026-01-01T00:00:00.000Z", ts_to: "2026-01-01T00:15:00.000Z" }),
      row({ id: "b", ts_from: "2026-01-01T00:15:00.000Z", ts_to: "2026-01-01T00:30:00.000Z" }),
    ];
    const linesByKey = {
      "key-a": [line({ ts: "2026-01-01T00:05:00.000Z" })],
      "key-b": [line({ ts: "2026-01-01T00:20:00.000Z" })],
    };
    const deps = makeDeps({ rows, linesByKey });
    deps.fetchConcurrency = 1; // force two waves, so we can see incremental writes between them
    let writesAtSecondFetch = null;
    const originalFetch = deps.fetchSegmentLines;
    deps.fetchSegmentLines = jest.fn(async (r) => {
      if (r.id === "b") writesAtSecondFetch = res.chunks.length;
      return originalFetch(r);
    });
    var res = fakeResponse();
    await streamLogExport(
      { agentId: "agent-1", from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" },
      { id: "user-1" },
      res,
      deps,
    );
    // By the time the second wave's fetch runs, the first wave's line
    // should already have been written — proof of incremental streaming
    // rather than buffering the whole export before writing anything.
    expect(writesAtSecondFetch).toBeGreaterThan(0);
  });
});

describe("csvEscape", () => {
  it("passes through plain values unescaped", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("quotes and escapes values containing commas, quotes, or newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});
