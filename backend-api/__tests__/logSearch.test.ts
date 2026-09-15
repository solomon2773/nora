// @ts-nocheck
/**
 * __tests__/logSearch.test.ts — Phase 6 of the logging control plane
 * (GET /logs/search): prune → fetch (concurrent, wave-based, early
 * termination, prefiltered) → merge → recency-gap.
 *
 * Dependency-injected unit tests of the real `backend-api/logSearch.ts`
 * module (no module mocking, no HTTP layer for most cases — same
 * convention as logDeletion.test.ts), so this exercises the actual
 * prune/fetch/merge/scope logic backend-api's routes depend on. A small
 * dedicated block at the end mounts the real Express router to verify the
 * one behaviour that genuinely lives at the HTTP layer: an API key's
 * workspace binding rejecting a cross-workspace agent before searchLogs
 * ever runs.
 */
const zlib = require("zlib");
const {
  searchLogs,
  mergeSegments,
  encodeCursor,
  decodeCursor,
  fetchSegmentLines,
  compareLines,
  enforceWorkspaceScope,
  listLoggingAgents,
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
        const agentId = params[0];
        const workspaceId = workspaceByAgent[agentId];
        return { rows: workspaceId ? [{ workspace_id: workspaceId }] : [] };
      }
      throw new Error(`fakeDb: unhandled query: ${sql}`);
    }),
  };
}

function agentOwner(userId, agentId = "agent-1") {
  return async (id, actor) => (id === agentId && actor.id === userId ? { id: agentId, user_id: userId } : null);
}

function agentAdminBypass(agentId = "agent-1") {
  // Mirrors findAccessibleAgentForActor's real admin bypass: returns the
  // agent for ANY admin actor, regardless of workspace — the exact bypass
  // items 8/8a exist to not be mistaken for workspace scoping.
  return async (id, actor) => (id === agentId && actor.role === "admin" ? { id: agentId } : null);
}

describe("mergeSegments / compareLines (item 5/6)", () => {
  it("produces correct chronological order across two streams", () => {
    const lines = [
      line({ ts: "2026-01-01T00:00:03.000Z", stream: "runtime", ord: 0 }),
      line({ ts: "2026-01-01T00:00:01.000Z", stream: "gateway", ord: 0 }),
      line({ ts: "2026-01-01T00:00:02.000Z", stream: "runtime", ord: 1 }),
    ];
    const { lines: merged } = mergeSegments(lines, 10, null, "asc");
    expect(merged.map((l) => l.ts)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
    ]);
  });

  it("sorts ts_source: collector lines (no ts) on observed_ts", () => {
    const lines = [
      line({ ts: null, observed_ts: "2026-01-01T00:00:05.000Z", ts_source: "collector", ord: 0 }),
      line({ ts: "2026-01-01T00:00:01.000Z", ord: 0 }),
    ];
    const { lines: merged } = mergeSegments(lines, 10, null, "asc");
    expect(merged[0].ts).toBe("2026-01-01T00:00:01.000Z");
    expect(merged[1].ts_source).toBe("collector");
  });

  it("cursor pagination returns no duplicates and no gaps across pages", () => {
    const all = Array.from({ length: 10 }, (_, i) =>
      line({ ts: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, ord: i }),
    );
    const page1 = mergeSegments(all, 4, null, "asc");
    expect(page1.lines).toHaveLength(4);
    const cursor1 = decodeCursor(page1.nextCursor);
    const page2 = mergeSegments(all, 4, cursor1, "asc");
    expect(page2.lines).toHaveLength(4);
    const cursor2 = decodeCursor(page2.nextCursor);
    const page3 = mergeSegments(all, 4, cursor2, "asc");
    expect(page3.lines).toHaveLength(2);

    const seen = [...page1.lines, ...page2.lines, ...page3.lines].map((l) => l.ord);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // no dup, no gap
  });

  it("a late-arriving segment's lines appear in a re-run without breaking the cursor", () => {
    const initial = [line({ ts: "2026-01-01T00:00:00.000Z", ord: 0 }), line({ ts: "2026-01-01T00:00:02.000Z", ord: 0 })];
    const page1 = mergeSegments(initial, 1, null, "asc");
    expect(page1.lines[0].ts).toBe("2026-01-01T00:00:00.000Z");
    const cursor = decodeCursor(page1.nextCursor);

    // A segment covering ts=00:00:01 arrives late (e.g. a delayed gateway
    // flush) between the two calls.
    const withLateArrival = [...initial, line({ ts: "2026-01-01T00:00:01.000Z", stream: "gateway", ord: 0 })];
    const page2 = mergeSegments(withLateArrival, 10, cursor, "asc");
    expect(page2.lines.map((l) => l.ts)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
    ]);
  });
});

describe("fetchSegmentLines (items 4a/5/5a)", () => {
  function buildEncodedSegment(lines) {
    const ndjson = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    return zlib.zstdCompressSync(Buffer.from(ndjson, "utf8"));
  }

  it("decrypts using the row's own storage config (previous storage_backend)", async () => {
    const segLines = [line({ message: "from s3" })];
    const compressed = buildEncodedSegment(segLines);
    const storageConfigForSegmentFn = jest.fn(async (r) => ({ storageBackend: r.storage_backend }));
    const getStorageObjectFn = jest.fn(async () => Buffer.from("encrypted-placeholder"));
    const decryptSegmentFn = jest.fn(() => compressed); // identity past "encryption" for this test

    const result = await fetchSegmentLines(row({ id: "s3-seg", storage_backend: "s3" }), {
      storageConfigForSegmentFn,
      getStorageObjectFn,
      decryptSegmentFn,
      keyRing: {},
      cache: new Map(),
    });

    expect(storageConfigForSegmentFn).toHaveBeenCalledWith(expect.objectContaining({ storage_backend: "s3" }));
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("from s3");
  });

  it("a segment with no q match is never JSON-parsed", async () => {
    const compressed = buildEncodedSegment([line({ message: "nothing interesting here" })]);
    const parseSpy = jest.spyOn(JSON, "parse");
    parseSpy.mockClear();

    const result = await fetchSegmentLines(row({ id: "q-miss" }), {
      q: "needle-not-present",
      storageConfigForSegmentFn: async () => ({}),
      getStorageObjectFn: async () => Buffer.alloc(0),
      decryptSegmentFn: () => compressed,
      keyRing: {},
      cache: new Map(),
    });

    expect(result).toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("q filtering happens after decompression and matching lines are returned", async () => {
    const compressed = buildEncodedSegment([
      line({ message: "contains needle here" }),
      line({ message: "does not match" }),
    ]);
    const result = await fetchSegmentLines(row({ id: "q-match" }), {
      q: "needle",
      storageConfigForSegmentFn: async () => ({}),
      getStorageObjectFn: async () => Buffer.alloc(0),
      decryptSegmentFn: () => compressed,
      keyRing: {},
      cache: new Map(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("needle");
  });

  it("respects a decoded-segment cache keyed by storage_key (immutable segments)", async () => {
    const compressed = buildEncodedSegment([line({ message: "cached" })]);
    const getStorageObjectFn = jest.fn(async () => Buffer.alloc(0));
    const cache = new Map();
    const opts = {
      storageConfigForSegmentFn: async () => ({}),
      getStorageObjectFn,
      decryptSegmentFn: () => compressed,
      keyRing: {},
      cache,
    };
    await fetchSegmentLines(row(), opts);
    await fetchSegmentLines(row(), opts);
    expect(getStorageObjectFn).toHaveBeenCalledTimes(1);
  });
});

describe("searchLogs orchestration (items 1-7)", () => {
  function makeDeps({ rows = [], linesByKey = {}, workspaceByAgent = {}, findAgent, fetchWorkerBuffer } = {}) {
    const db = fakeDb(workspaceByAgent);
    return {
      db,
      findAccessibleAgentForActor: findAgent || agentOwner("user-1"),
      // Real selectCandidateSegments returns rows ORDER BY ts_to DESC — the
      // fake replicates that regardless of the order test data was built
      // in, since searchLogs's early-termination logic depends on it.
      selectCandidateSegments: jest.fn(async () =>
        rows.slice().sort((a, b) => new Date(b.ts_to).getTime() - new Date(a.ts_to).getTime()),
      ),
      fetchSegmentLines: jest.fn(async (r) => linesByKey[r.storage_key] || []),
      fetchWorkerBuffer: fetchWorkerBuffer || jest.fn(async () => null),
      keyRing: {},
    };
  }

  it("candidates are fetched concurrently, not serially", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ id: `s${i}`, ts_to: `2026-01-01T00:${15 + i}:00.000Z` }));
    let concurrentActive = 0;
    let maxConcurrent = 0;
    const fetchSegmentLines = jest.fn(async () => {
      concurrentActive += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentActive);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrentActive -= 1;
      return [];
    });
    const deps = makeDeps({ rows });
    deps.fetchSegmentLines = fetchSegmentLines;
    deps.fetchConcurrency = 8;

    await searchLogs({ agentId: "agent-1", limit: 5 }, { id: "user-1" }, deps);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("an unfiltered newest-first query fetches a bounded wave, not every candidate", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ id: `s${i}`, ts_to: `2026-01-01T${String(i).padStart(2, "0")}:00:00.000Z` }),
    );
    const linesByKey = {};
    for (const r of rows) linesByKey[r.storage_key] = [line({ ts: r.ts_to, ord: 0 })];
    const deps = makeDeps({ rows, linesByKey });
    deps.fetchConcurrency = 10;

    const result = await searchLogs({ agentId: "agent-1", limit: 3 }, { id: "user-1" }, deps);
    expect(result.lines.length).toBeGreaterThan(0);
    // Only the first wave (<= concurrency) should ever be fetched, not all 50.
    expect(deps.fetchSegmentLines).toHaveBeenCalledTimes(10);
  });

  it("q filtering respects limit", async () => {
    const rows = [row({ id: "a" })];
    const linesByKey = {
      "key-a": [line({ message: "match one" }), line({ message: "match two" }), line({ message: "no hit" })],
    };
    const deps = makeDeps({ rows, linesByKey });
    // fetchSegmentLines is mocked directly above (bypassing the real q logic
    // inside fetchSegmentLines), so apply the limit check on the merge:
    const result = await searchLogs({ agentId: "agent-1", limit: 2 }, { id: "user-1" }, deps);
    expect(result.lines).toHaveLength(2);
  });

  describe("workspace isolation (items 8/8a/8b/8c)", () => {
    it("workspace-A actor receives zero workspace-B rows", async () => {
      const deps = makeDeps({
        rows: [row()],
        linesByKey: { "key-seg-1": [line()] },
        workspaceByAgent: { "agent-1": "ws-A" },
      });
      await expect(
        searchLogs({ agentId: "agent-1", workspaceId: "ws-B" }, { id: "user-1" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
    });

    it("a platform admin querying workspace A receives zero workspace-B rows despite the per-agent admin bypass", async () => {
      const deps = makeDeps({
        rows: [row()],
        linesByKey: { "key-seg-1": [line()] },
        workspaceByAgent: { "agent-1": "ws-A" },
        findAgent: agentAdminBypass("agent-1"),
      });
      await expect(
        searchLogs({ agentId: "agent-1", workspaceId: "ws-B" }, { id: "admin-1", role: "admin" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });

      // The matching workspace still succeeds for the same admin bypass.
      const ok = await searchLogs({ agentId: "agent-1", workspaceId: "ws-A" }, { id: "admin-1", role: "admin" }, deps);
      expect(ok.lines).toHaveLength(1);
    });

    it("an agent with no workspace is returned to its owner and to nobody else", async () => {
      const deps = makeDeps({
        rows: [row()],
        linesByKey: { "key-seg-1": [line()] },
        workspaceByAgent: {}, // no workspace row for agent-1
      });
      const ok = await searchLogs({ agentId: "agent-1" }, { id: "user-1" }, deps);
      expect(ok.lines).toHaveLength(1);

      // Someone else (not the owner) is rejected by findAccessibleAgentForActor itself.
      await expect(searchLogs({ agentId: "agent-1" }, { id: "someone-else" }, deps)).rejects.toMatchObject({
        statusCode: 404,
      });

      // A workspaceId filter can never match an unassigned agent.
      await expect(
        searchLogs({ agentId: "agent-1", workspaceId: "ws-X" }, { id: "user-1" }, deps),
      ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
    });
  });

  describe("recency gap (item 7)", () => {
    it("closes the recency gap: a line written ~30 seconds ago (buffer only) is returned", async () => {
      const recentLine = line({
        ts: new Date(Date.now() - 30000).toISOString(),
        message: "very recent",
        ord: null,
      });
      const deps = makeDeps({
        rows: [],
        fetchWorkerBuffer: jest.fn(async (_agentId, stream) =>
          stream === "runtime" ? { lines: [recentLine], tsTo: recentLine.ts } : null,
        ),
      });
      const result = await searchLogs({ agentId: "agent-1", streams: ["runtime"] }, { id: "user-1" }, deps);
      expect(result.lines.map((l) => l.message)).toContain("very recent");
    });

    it("a flush landing exactly between the buffer read and the storage read produces no duplicate and no gap", async () => {
      const overlapLine = line({ ts: "2026-01-01T00:10:00.000Z", stream: "runtime", ord: 0 });
      // Buffer snapshot (read FIRST) still has the line, taken before the
      // flush that moves it into storage.
      const fetchWorkerBuffer = jest.fn(async (_agentId, stream) =>
        stream === "runtime" ? { lines: [overlapLine] } : null,
      );
      // selectCandidateSegments (read AFTER the buffer) already sees the
      // newly-flushed segment containing the very same line.
      const flushedRow = row({ id: "flushed", ts_to: "2026-01-01T00:10:00.000Z" });
      const deps = makeDeps({
        rows: [flushedRow],
        linesByKey: { [flushedRow.storage_key]: [overlapLine] },
        fetchWorkerBuffer,
      });

      const result = await searchLogs({ agentId: "agent-1", streams: ["runtime"] }, { id: "user-1" }, deps);
      const matches = result.lines.filter((l) => l.ts === overlapLine.ts && l.stream === "runtime");
      expect(matches).toHaveLength(1); // not 0 (gap), not 2 (duplicate)
    });

    it("an unreachable worker degrades to storage-only results with a marker, rather than failing the query", async () => {
      const deps = makeDeps({
        rows: [row()],
        linesByKey: { "key-seg-1": [line()] },
        fetchWorkerBuffer: jest.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const result = await searchLogs({ agentId: "agent-1" }, { id: "user-1" }, deps);
      expect(result.lines).toHaveLength(1);
      expect(result.warning).toBe(RECENT_LINES_UNAVAILABLE);
    });
  });
});

describe("enforceWorkspaceScope (items 8a/8b) — direct unit coverage", () => {
  it("rejects a workspaceId that does not match the agent's real workspace", async () => {
    const db = fakeDb({ "agent-1": "ws-A" });
    await expect(enforceWorkspaceScope({ agentId: "agent-1", workspaceId: "ws-B" }, { db })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("accepts a matching workspaceId", async () => {
    const db = fakeDb({ "agent-1": "ws-A" });
    await expect(
      enforceWorkspaceScope({ agentId: "agent-1", workspaceId: "ws-A" }, { db }),
    ).resolves.toBeUndefined();
  });

  it("lets an admin session read an agent in any workspace without naming one", async () => {
    const db = fakeDb({ "agent-1": "ws-A" });
    await expect(
      enforceWorkspaceScope(
        { agentId: "agent-1", workspaceId: null, actor: { id: "admin-1", role: "admin" } },
        { db },
      ),
    ).resolves.toBeUndefined();
  });

  it("still rejects an admin session that names the wrong workspace", async () => {
    const db = fakeDb({ "agent-1": "ws-A" });
    await expect(
      enforceWorkspaceScope(
        { agentId: "agent-1", workspaceId: "ws-B", actor: { id: "admin-1", role: "admin" } },
        { db },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
  });

  it("does not extend the admin exception to an API key issued by an admin", async () => {
    const db = fakeDb({ "agent-1": "ws-A" });
    await expect(
      enforceWorkspaceScope(
        {
          agentId: "agent-1",
          workspaceId: null,
          actor: { id: "admin-1", role: "admin", authMethod: "api_key" },
        },
        { db },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
  });

  it("still requires a non-admin to name the agent's workspace", async () => {
    const db = fakeDb({ "agent-1": "ws-A" });
    await expect(
      enforceWorkspaceScope(
        { agentId: "agent-1", workspaceId: null, actor: { id: "user-1", role: "user" } },
        { db },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "wrong_workspace" });
  });
});

describe("listLoggingAgents", () => {
  function capturingDb(rows = []) {
    return { query: jest.fn(async () => ({ rows })) };
  }

  it("gives an admin session every agent on the installation", async () => {
    const db = capturingDb();
    await listLoggingAgents({ id: "admin-1", role: "admin" }, {}, { db });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE TRUE/);
    expect(params).toEqual([]);
  });

  it("limits a non-admin to owned agents plus agents in their workspaces", async () => {
    const db = capturingDb();
    await listLoggingAgents({ id: "user-1", role: "user" }, {}, { db });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/a\.user_id = \$1/);
    expect(sql).toMatch(/workspace_members/);
    expect(params).toEqual(["user-1"]);
  });

  it("limits an API key to its bound workspace even when issued by an admin", async () => {
    const db = capturingDb();
    await listLoggingAgents(
      { id: "admin-1", role: "admin", authMethod: "api_key" },
      { workspaceId: "ws-A" },
      { db },
    );
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/wa\.workspace_id = \$1/);
    expect(sql).not.toMatch(/WHERE TRUE/);
    expect(params).toEqual(["ws-A"]);
  });

  it("never selects agent secrets such as the gateway token", async () => {
    const db = capturingDb();
    await listLoggingAgents({ id: "admin-1", role: "admin" }, {}, { db });
    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/a\.\*/);
    expect(sql).not.toMatch(/gateway_token/);
  });

  it("attaches each agent's real workspace, or none for an unassigned agent", async () => {
    const db = capturingDb([
      { id: "a1", name: "one", runtime_family: "openclaw", deploy_target: "docker", workspace_id: "ws-A", workspace_name: "A" },
      { id: "a2", name: "two", runtime_family: "openclaw", deploy_target: "docker", workspace_id: null, workspace_name: null },
    ]);
    const agents = await listLoggingAgents({ id: "admin-1", role: "admin" }, {}, { db });
    expect(agents).toEqual([
      { id: "a1", name: "one", runtime_family: "openclaw", deploy_target: "docker", workspaces: [{ id: "ws-A", name: "A" }] },
      { id: "a2", name: "two", runtime_family: "openclaw", deploy_target: "docker", workspaces: [] },
    ]);
  });
});

describe("HTTP layer: API-key workspace binding (item 9)", () => {
  it("rejects an API key scoped to workspace A when used against an agent in workspace B", async () => {
    jest.resetModules();
    jest.doMock("../db", () => ({
      query: jest.fn(async (sql, params = []) => {
        if (sql.includes("FROM workspace_agents wa") && sql.includes("JOIN agents a")) {
          // enforceApiKeyAgentScope's lookup: agent-1 actually belongs to ws-B.
          return { rows: params[0] === "ws-B" && params[1] === "agent-1" ? [{ id: "agent-1" }] : [] };
        }
        return { rows: [] };
      }),
    }));
    jest.doMock("../logSearch.ts", () => ({
      searchLogs: jest.fn(async () => ({ lines: [], nextCursor: null })),
    }));
    jest.doMock("../monitoring", () => ({ logEvent: jest.fn() }));
    jest.doMock("../crypto", () => ({
      decrypt: jest.fn(),
      encrypt: jest.fn(),
      ensureEncryptionConfigured: jest.fn(),
    }));

    const express = require("express");
    const request = require("supertest");
    const router = require("../routes/observability.ts");

    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: "user-1" };
      req.apiKey = { scopes: ["logs:read"] };
      req.apiKeyWorkspace = { id: "ws-A" }; // key is bound to ws-A
      next();
    });
    app.use(router);

    const response = await request(app).get("/logs/search").query({ agentId: "agent-1" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("wrong_workspace");

    jest.dontMock("../db");
    jest.dontMock("../logSearch.ts");
    jest.dontMock("../monitoring");
    jest.dontMock("../crypto");
  });
});
