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
  RECENT_LINES_UNAVAILABLE,
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

function makeDeps({ rows = [], linesByKey = {}, workspaceByAgent = {}, fetchWorkerBuffer } = {}) {
  return {
    db: fakeDb(workspaceByAgent),
    findAccessibleAgentForActor: async (agentId, actor) =>
      agentId === "agent-1" && actor.id === "user-1" ? { id: "agent-1" } : null,
    selectCandidateSegments: jest.fn(async () =>
      rows.slice().sort((a, b) => new Date(b.ts_to).getTime() - new Date(a.ts_to).getTime()),
    ),
    fetchSegmentLines: jest.fn(async (r) => linesByKey[r.storage_key] || []),
    // Defaults to "nothing buffered" so a test that says nothing about the
    // live buffer never reaches the real worker-provisioner HTTP call.
    fetchWorkerBuffer: fetchWorkerBuffer || jest.fn(async () => null),
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

/**
 * Phase 7 row 2: export and search must agree over the live-buffer window.
 * Every test here uses a range reaching the present on purpose —
 * `readBufferSnapshots` skips the worker call outright for a range whose
 * `to` predates the oldest possible open buffer, which is exactly why the
 * rest of this file's fixed Jan-2026 fixtures never exercised this path.
 */
describe("streamLogExport recency gap (Phase 7 row 2)", () => {
  const NOW = Date.now();
  const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
  const RANGE = { from: iso(-60 * 60 * 1000), to: iso(60 * 1000) };

  function flushedRow(overrides = {}) {
    return row({
      id: "flushed",
      ts_from: iso(-50 * 60 * 1000),
      ts_to: iso(-40 * 60 * 1000),
      ...overrides,
    });
  }

  function exportedLines(res) {
    const text = res.text().trim();
    if (!text) return [];
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("exports a line still sitting only in the live buffer, matching search over the identical range", async () => {
    const storedLine = line({ ts: iso(-45 * 60 * 1000), message: "flushed already" });
    const bufferedLine = line({ ts: iso(-30 * 1000), message: "very recent", ord: null });
    const seg = flushedRow();
    const deps = makeDeps({
      rows: [seg],
      linesByKey: { [seg.storage_key]: [storedLine] },
      fetchWorkerBuffer: jest.fn(async (_agentId, stream) =>
        stream === "runtime" ? { found: true, lines: [bufferedLine] } : null,
      ),
    });

    const res = fakeResponse();
    await streamLogExport({ agentId: "agent-1", ...RANGE }, { id: "user-1" }, res, deps);
    const exported = exportedLines(res);

    // The whole point of row 2: this line exists nowhere in storage yet.
    expect(exported.map((l) => l.message)).toContain("very recent");

    // searchLogs closes the recency gap only for its newest-first first page,
    // so parity is asserted against that shape reversed into export's
    // chronological order — not against an ascending search, which never
    // consults the buffer at all.
    const searchResult = await searchLogs(
      { agentId: "agent-1", ...RANGE, limit: 1000 },
      { id: "user-1" },
      deps,
    );
    expect(exported.map((l) => l.ts)).toEqual(searchResult.lines.map((l) => l.ts).reverse());
  });

  it("writes a line flushed into storage mid-request once, not twice", async () => {
    const overlapTs = iso(-2 * 60 * 1000);
    const overlapLine = line({ ts: overlapTs, stream: "runtime", ord: 0, message: "overlap" });
    // The buffer snapshot (taken first) still holds the line; the segment
    // read afterwards already contains it — storage must win.
    const seg = flushedRow({ id: "justflushed", ts_from: iso(-3 * 60 * 1000), ts_to: overlapTs });
    const deps = makeDeps({
      rows: [seg],
      linesByKey: { [seg.storage_key]: [overlapLine] },
      fetchWorkerBuffer: jest.fn(async (_agentId, stream) =>
        stream === "runtime" ? { found: true, lines: [overlapLine] } : null,
      ),
    });

    const res = fakeResponse();
    await streamLogExport({ agentId: "agent-1", ...RANGE }, { id: "user-1" }, res, deps);
    expect(exportedLines(res).filter((l) => l.message === "overlap")).toHaveLength(1);
  });

  it("holds buffered lines to the same level filter as stored ones", async () => {
    const deps = makeDeps({
      rows: [],
      fetchWorkerBuffer: jest.fn(async (_agentId, stream) =>
        stream === "runtime"
          ? {
              found: true,
              lines: [
                line({ ts: iso(-30 * 1000), level: "INFO", message: "buffered info" }),
                line({ ts: iso(-29 * 1000), level: "ERROR", message: "buffered error" }),
              ],
            }
          : null,
      ),
    });

    const res = fakeResponse();
    await streamLogExport(
      { agentId: "agent-1", ...RANGE, levels: ["ERROR"] },
      { id: "user-1" },
      res,
      deps,
    );
    expect(exportedLines(res).map((l) => l.message)).toEqual(["buffered error"]);
  });

  it("excludes buffered lines falling outside the requested window", async () => {
    const deps = makeDeps({
      rows: [],
      fetchWorkerBuffer: jest.fn(async (_agentId, stream) =>
        stream === "runtime"
          ? {
              found: true,
              lines: [
                line({ ts: iso(-30 * 1000), message: "inside" }),
                line({ ts: iso(10 * 60 * 1000), message: "after the window" }),
              ],
            }
          : null,
      ),
    });

    const res = fakeResponse();
    await streamLogExport({ agentId: "agent-1", ...RANGE }, { id: "user-1" }, res, deps);
    expect(exportedLines(res).map((l) => l.message)).toEqual(["inside"]);
  });

  it("degrades to storage-only with a warning header when the worker is unreachable", async () => {
    const storedLine = line({ ts: iso(-45 * 60 * 1000), message: "stored" });
    const seg = flushedRow();
    const deps = makeDeps({
      rows: [seg],
      linesByKey: { [seg.storage_key]: [storedLine] },
      fetchWorkerBuffer: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });

    const res = fakeResponse();
    await streamLogExport({ agentId: "agent-1", ...RANGE }, { id: "user-1" }, res, deps);

    // A stream has no envelope for search's `warning` field, so the same
    // signal rides a header — and the export still succeeds.
    expect(exportedLines(res).map((l) => l.message)).toEqual(["stored"]);
    expect(res.headers["X-Nora-Log-Warning"]).toBe(RECENT_LINES_UNAVAILABLE);
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
