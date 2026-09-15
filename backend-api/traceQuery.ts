// @ts-nocheck
// backend-api/traceQuery.ts — Logging control plane Phase 13 (Traces lens).
//
// Backs `GET /traces` (list) and `GET /traces/:traceId` (span tree +
// correlated logs) in routes/observability.ts. Reads `agent_spans`
// (populated by Phase 11's OTLP ingest) and reuses Phase 6's
// `selectCandidateSegments`/`fetchSegmentLines` from logSearch.ts to pull the
// log lines that fall inside a trace's time window — it does NOT
// reimplement segment fetching, decryption, or decompression.
//
// ── API contract (read this before wiring a frontend against it) ─────────
//
// GET /traces response:
//   {
//     agentId: string,
//     workspaceId: string | null,   // the agent's ACTUAL workspace (via
//                                    // workspace_agents), null if unassigned
//     tracesEnabled: boolean,       // resolved workspace_log_settings —
//                                    // see "tracing disabled vs empty" below
//     traceSampleRate: number,
//     traces: [
//       {
//         traceId: string,
//         agentId: string,
//         startedAt: string,        // ISO 8601, earliest span's started_at
//         endedAt: string,          // ISO 8601, latest (started_at + duration_ms)
//                                    // across every span in the trace
//         durationMs: number,       // endedAt - startedAt, in milliseconds
//         spanCount: number,
//         rootSpanName: string | null,  // name of the span with parent_span_id
//                                        // IS NULL; the earliest-started span
//                                        // if no such row exists (data anomaly)
//         status: string | null,        // that same root span's `status` column
//         tokensIn: number,             // SUM(tokens_in) across every span
//         tokensOut: number,            // SUM(tokens_out) across every span
//         costUsd: number,              // SUM(cost_usd) across every span
//       },
//       ...
//     ],
//   }
//   Sorted `startedAt` descending (newest trace first).
//
// GET /traces/:traceId response:
//   {
//     trace: { ...same per-trace shape as one `traces[]` entry above,
//               minus `agentId`/`workspaceId` being redundant with the
//               parent object -- both are still included on `trace` too,
//               so a caller that only fetches trace detail has everything },
//     spans: [
//       {
//         spanId: string,
//         parentSpanId: string | null,
//         name: string,
//         kind: string | null,
//         startedAt: string,        // ISO 8601
//         durationMs: number | null,
//         status: string | null,
//         model: string | null,
//         provider: string | null,
//         tokensIn: number | null,
//         tokensOut: number | null,
//         costUsd: number | null,
//         attrs: object,            // raw `attrs` JSONB column
//         depth: number,            // 0 for a root span (parentSpanId is
//                                    // null OR points outside this trace's
//                                    // own span set), parent's depth + 1
//                                    // otherwise -- this is a FLAT array,
//                                    // not a nested tree; the frontend
//                                    // reconstructs the waterfall's
//                                    // indentation from `depth` and links
//                                    // rows via `parentSpanId` for any
//                                    // parent/child drawing it needs
//       },
//       ...
//     ],  // sorted `startedAt` ascending (chronological, matches a waterfall's left-to-right reading order)
//     correlatedLogs: [
//       {
//         ...every field `GET /logs/search` returns per line (ts,
//         observed_ts, ts_source, stream, level, message, trace_id,
//         span_id, session_id, channel, agentId, workspaceId, plus whatever
//         else the source line carried),
//         inTrace: boolean,          // true = gateway line whose trace_id
//                                     // matched this trace; false = an
//                                     // untraced runtime line included only
//                                     // because it fell in this trace's time
//                                     // window (see "correlation rule" below)
//         category: "trace" | "window", // same distinction as `inTrace`,
//                                         // spelled out for direct display
//                                         // (e.g. a badge) without the
//                                         // frontend re-deriving it from a
//                                         // boolean
//       },
//       ...
//     ],  // sorted chronologically ascending (ts, falling back to
//         // observed_ts, per logSearch's effectiveTs/compareLines)
//   }
//
// ── Correlation rule (items 3/4) ──────────────────────────────────────────
// correlatedLogs = ALL gateway- and runtime-stream lines in the same
//                   agent_id and the trace's own [startedAt, endedAt] time
//                   window, regardless of trace_id.
// A gateway line's own `trace_id` field is OpenClaw's internal per-request
// correlation id, confirmed empirically to be a DIFFERENT id space than the
// OTel trace_id exported to `agent_spans` -- it essentially never matches,
// so it cannot be used as the primary inclusion filter (an earlier version
// of this function did exactly that, exclude-by-default on trace_id
// mismatch, and it silently hid every gateway line for every real trace).
// A gateway line whose trace_id DOES happen to equal this trace's id is
// still marked with the stronger `inTrace: true`/`category: "trace"`
// signal; every other gateway/runtime line in-window gets `category:
// "window"`. Segments are only pruned by AGENT + TIME (item 3) -- there is
// deliberately no `trace_ids[]` column anywhere to filter segments by trace
// directly; per-line filtering happens after segment lines are already in
// memory.
//
// ── "tracing disabled" vs "enabled but empty" (item 7) ────────────────────
// Chosen approach: `GET /traces` resolves and returns `tracesEnabled` /
// `traceSampleRate` itself (via agentTracing.resolveWorkspaceLogSettings),
// rather than telling the frontend to make a second call to Phase 12's
// `GET /workspaces/:id/log-settings`. That endpoint requires
// `requireWorkspaceRole("admin", "id")` -- a plain workspace viewer who can
// legitimately see a Traces lens would get a 403 calling it directly, so
// embedding the resolved booleans here (which only requires per-agent
// viewer access, the same gate the rest of this endpoint uses) is not
// optional convenience, it is the only way a non-admin viewer can get this
// signal at all. The frontend shows the enable-tracing CTA when
// `tracesEnabled` is false; it shows an ordinary empty state when
// `tracesEnabled` is true and `traces` is `[]`.
//
// ── Workspace scoping (item 8, the highest-severity item in this phase) ──
// Both endpoints gate on `findAccessibleAgentForActor(agentId, actor,
// "viewer")` FIRST -- the same per-agent ownership/workspace-role check
// Phase 6 uses -- and only THEN apply `logSearch.enforceWorkspaceScope` as
// an ADDITIONAL narrowing against an explicit `workspaceId` param, exactly
// mirroring Phase 6 items 8/8a/8b/8c (that function is imported and reused
// verbatim, not reimplemented, so the two lenses can never disagree about
// what "this agent's workspace" means). Concretely:
//   - A `workspaceId` param that doesn't match the agent's actual workspace
//     (or is supplied for an agent with none) -- for ANY actor, including a
//     platform admin whose `findAccessibleAgentForActor` bypass grants
//     unconditional per-agent access -- is rejected 403 `wrong_workspace`.
//   - An unassigned agent (no `workspace_agents` row) is reached through
//     the per-agent gate, not through a workspace filter that would
//     otherwise treat its NULL workspace as matching nothing -- so its
//     owner sees its traces, and a `workspaceId` param can never match it.
//   - An actor who is neither the agent's owner nor an admin never reaches
//     the workspace check at all: `findAccessibleAgentForActor` returns
//     null first, and this module always raises the same generic 404 in
//     that case as it does for "trace/agent genuinely does not exist" --
//     deliberately, so a 404 never confirms or denies a trace/agent's mere
//     existence to someone without access to it.
//
// ── History is never backfilled (item 9) ──────────────────────────────────
// `agent_spans.workspace_id` is whatever it was at ingest time and is NEVER
// rewritten when an agent later joins a workspace -- this module does not
// read that column for scoping at all (see above: scoping always resolves
// the agent's CURRENT workspace via `workspace_agents`, matching Phase 6).
// The column is only echoed back verbatim inside `attrs`-adjacent raw span
// data if a caller wants it; no code here backfills or migrates it.

const logSearch = require("./logSearch.ts");
const agentTracing = require("./agentTracing.ts");
const { findAccessibleAgentForActor } = require("./middleware/ownership");

// ── Errors ───────────────────────────────────────────────────────────────

function requireAgentId(params) {
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  if (!agentId) {
    const error = new Error("agentId is required");
    error.statusCode = 400;
    error.code = "agent_id_required";
    throw error;
  }
  return agentId;
}

/**
 * One generic 404 for "agent/trace not found" AND "actor cannot access
 * it" -- see the module header's workspace-scoping note on why these two
 * cases must be indistinguishable from the response alone.
 */
function notFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

// ── Aggregation helpers ──────────────────────────────────────────────────

function toNumberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function spanEndMs(row) {
  const startMs = new Date(row.started_at).getTime();
  const durationMs = Number(row.duration_ms) || 0;
  return startMs + Math.max(0, durationMs);
}

/**
 * Aggregates one trace's span rows into the summary shape documented at the
 * top of this file (shared by a `traces[]` entry and `GET /traces/:traceId`'s
 * `trace` field). `rows` must all share the same `trace_id`/`agent_id`.
 */
function summarizeTrace(rows) {
  let startedAtMs = Infinity;
  let endedAtMs = -Infinity;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let rootRow = null;

  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    if (startMs < startedAtMs) startedAtMs = startMs;
    const endMs = spanEndMs(row);
    if (endMs > endedAtMs) endedAtMs = endMs;
    tokensIn += Number(row.tokens_in) || 0;
    tokensOut += Number(row.tokens_out) || 0;
    costUsd += Number(row.cost_usd) || 0;

    if (row.parent_span_id === null || row.parent_span_id === undefined) {
      if (!rootRow || startMs < new Date(rootRow.started_at).getTime()) rootRow = row;
    }
  }

  // No row had a null parent_span_id (a data anomaly -- ingest should
  // always produce exactly one root) -- fall back to the earliest-started
  // span so `rootSpanName`/`status` are still populated rather than null.
  if (!rootRow) {
    rootRow = rows.slice().sort((a, b) => new Date(a.started_at) - new Date(b.started_at))[0];
  }

  return {
    traceId: rows[0].trace_id,
    agentId: rows[0].agent_id,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    spanCount: rows.length,
    rootSpanName: rootRow ? rootRow.name : null,
    status: rootRow ? rootRow.status ?? null : null,
    tokensIn,
    tokensOut,
    costUsd,
  };
}

function groupByTraceId(rows) {
  const byTrace = new Map();
  for (const row of rows) {
    if (!byTrace.has(row.trace_id)) byTrace.set(row.trace_id, []);
    byTrace.get(row.trace_id).push(row);
  }
  return byTrace;
}

/**
 * `buildSpanTree(spanRows)` — reconstructs parent/child nesting from
 * `parent_span_id` as a FLAT array (not a nested tree — see the module
 * header's response-shape comment for why) with a computed `depth` per
 * span, sorted chronologically by `startedAt`.
 */
function buildSpanTree(spanRows) {
  const depthBySpanId = new Map();

  function depthOf(spanId, seen = new Set()) {
    if (depthBySpanId.has(spanId)) return depthBySpanId.get(spanId);
    const row = spanRows.find((r) => r.span_id === spanId);
    if (!row || row.parent_span_id === null || row.parent_span_id === undefined) {
      depthBySpanId.set(spanId, 0);
      return 0;
    }
    if (seen.has(spanId)) {
      // Cycle guard -- should never happen with real ingest data, but never
      // infinite-loop on malformed rows.
      depthBySpanId.set(spanId, 0);
      return 0;
    }
    seen.add(spanId);
    const parentExists = spanRows.some((r) => r.span_id === row.parent_span_id);
    if (!parentExists) {
      // Parent isn't part of this trace's row set (e.g. a stray span_id) --
      // treat as a root rather than crashing on a missing lookup.
      depthBySpanId.set(spanId, 0);
      return 0;
    }
    const depth = depthOf(row.parent_span_id, seen) + 1;
    depthBySpanId.set(spanId, depth);
    return depth;
  }

  const nodes = spanRows.map((row) => ({
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? null,
    name: row.name,
    kind: row.kind ?? null,
    startedAt: new Date(row.started_at).toISOString(),
    durationMs: toNumberOrNull(row.duration_ms),
    status: row.status ?? null,
    model: row.model ?? null,
    provider: row.provider ?? null,
    tokensIn: toNumberOrNull(row.tokens_in),
    tokensOut: toNumberOrNull(row.tokens_out),
    costUsd: toNumberOrNull(row.cost_usd),
    attrs: row.attrs || {},
    depth: depthOf(row.span_id),
  }));

  nodes.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  return nodes;
}

// ── correlatedLogsForTrace (item 3/4) ────────────────────────────────────

/**
 * `correlatedLogsForTrace(spanRows, deps)` — given one trace's span rows
 * (all sharing `trace_id`/`agent_id`), computes the trace's actual time
 * window and reuses `logSearch.selectCandidateSegments` /
 * `logSearch.fetchSegmentLines` to fetch the matching log lines. See the
 * module header's "Correlation rule" for the exact inclusion logic.
 *
 * @param {Array<Object>} spanRows - rows shaped like `agent_spans` (as
 *   returned by the SQL in `getTraceDetail`).
 * @param {Object} [deps] - dependency injection for tests; `db`,
 *   `selectCandidateSegments`, `fetchSegmentLines`, `keyRing`.
 * @returns {Promise<Array<Object>>} correlated log lines, each the parsed
 *   line plus `inTrace`/`category` (see module header), sorted ascending.
 */
async function correlatedLogsForTrace(spanRows, deps = {}) {
  if (!Array.isArray(spanRows) || spanRows.length === 0) return [];

  const db = deps.db || require("./db");
  const selectFn = deps.selectCandidateSegments || logSearch.selectCandidateSegments;
  const fetchFn = deps.fetchSegmentLines || logSearch.fetchSegmentLines;

  const traceId = spanRows[0].trace_id;
  const agentId = spanRows[0].agent_id;

  let startedAtMs = Infinity;
  let endedAtMs = -Infinity;
  for (const row of spanRows) {
    const startMs = new Date(row.started_at).getTime();
    if (startMs < startedAtMs) startedAtMs = startMs;
    const endMs = spanEndMs(row);
    if (endMs > endedAtMs) endedAtMs = endMs;
  }
  const windowFrom = new Date(startedAtMs).toISOString();
  const windowTo = new Date(endedAtMs).toISOString();

  // Item 3: prune candidate segments by AGENT + TIME only -- never by
  // trace. There is deliberately no `traceId` field passed here.
  const candidateRows = await selectFn(
    { agentId, streams: ["runtime", "gateway"], from: windowFrom, to: windowTo },
    { db },
  );

  const fetched = await Promise.all(
    candidateRows.map((row) => fetchFn(row, { keyRing: deps.keyRing, dispatcher: deps.dispatcher })),
  );

  const correlated = [];
  for (const lines of fetched) {
    for (const rawLine of lines) {
      if (rawLine.stream === "gateway") {
        // A gateway line's own `trace_id` is OpenClaw's internal per-request
        // correlation id (used to pair its own "start"/"response" log lines)
        // -- confirmed empirically against a real agent to be a DIFFERENT id
        // space than the OTel trace_id exported to `agent_spans`, so it can
        // never be relied on to match this trace's id. Fall back to the same
        // window-based inclusion runtime lines use below, so real gateway
        // activity during the trace is never silently hidden. If a line's
        // trace_id DOES happen to equal this trace's id, still mark it
        // `inTrace: true`/`category: "trace"` -- a strictly stronger signal
        // than the window match, worth keeping if it's ever available.
        if (rawLine.trace_id === traceId) {
          correlated.push({ ...rawLine, inTrace: true, category: "trace" });
          continue;
        }
      }

      // Item 4: EVERY runtime line in the agent+time window is included,
      // regardless of trace_id (which runtime lines never carry in the
      // first place) -- a crash/OOM/segfault during the trace is often the
      // real root cause and must not be hidden by a strict trace_id filter.
      // Segments are pruned to a 15-minute bucket (wider than the trace),
      // so also re-check each line's own timestamp against the trace's
      // exact window before admitting it.
      const ts = logSearch.effectiveTs(rawLine);
      const tsMs = new Date(ts).getTime();
      if (tsMs >= startedAtMs && tsMs <= endedAtMs) {
        correlated.push({ ...rawLine, inTrace: false, category: "window" });
      }
    }
  }

  correlated.sort((a, b) => logSearch.compareLines(a, b, "asc"));
  return correlated;
}

// ── listTraces (item 1) ───────────────────────────────────────────────────

const SPAN_COLUMNS = `trace_id, span_id, parent_span_id, workspace_id, agent_id, name, kind,
       started_at, duration_ms, status, model, provider, tokens_in, tokens_out, cost_usd, attrs`;

/**
 * `listTraces(params, actor, deps)` — see the module header for the exact
 * response shape. `params.agentId` is required, mirroring Phase 6's
 * `searchLogs`: this endpoint lists one agent's traces, never a merged
 * cross-agent view (Assumption 5: one agent maps to one trace root).
 *
 * @param {Object} params - `{ agentId, workspaceId?, from?, to?, limit? }`.
 * @param {Object} actor - authenticated actor (`req.user`-shaped).
 * @param {Object} [deps] - dependency injection for tests.
 */
async function listTraces(params, actor, deps = {}) {
  const db = deps.db || require("./db");
  const findAgentFn = deps.findAccessibleAgentForActor || findAccessibleAgentForActor;
  const resolveWorkspaceIdFn = deps.resolveAgentWorkspaceId || agentTracing.resolveAgentWorkspaceId;
  const resolveSettingsFn = deps.resolveWorkspaceLogSettings || agentTracing.resolveWorkspaceLogSettings;

  const agentId = requireAgentId(params);
  const agent = await findAgentFn(agentId, actor, "viewer");
  if (!agent) throw notFoundError("Agent not found");

  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : null;
  await logSearch.enforceWorkspaceScope({ agentId, workspaceId, actor }, { db });

  const actualWorkspaceId = await resolveWorkspaceIdFn(agentId, { db });
  const settings = await resolveSettingsFn(actualWorkspaceId, { db });

  const conditions = ["agent_id = $1"];
  const values = [agentId];
  if (params.from) {
    values.push(new Date(params.from).toISOString());
    conditions.push(`started_at >= $${values.length}`);
  }
  if (params.to) {
    values.push(new Date(params.to).toISOString());
    conditions.push(`started_at <= $${values.length}`);
  }
  const result = await db.query(
    `SELECT ${SPAN_COLUMNS} FROM agent_spans WHERE ${conditions.join(" AND ")}`,
    values,
  );

  const byTrace = groupByTraceId(result.rows);
  const traces = Array.from(byTrace.values())
    .map((rows) => summarizeTrace(rows))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const limit = Number.isFinite(Number(params.limit)) && Number(params.limit) > 0
    ? Math.min(1000, Math.floor(Number(params.limit)))
    : 200;

  return {
    agentId,
    workspaceId: actualWorkspaceId,
    tracesEnabled: Boolean(settings.traces_enabled),
    // The workspace-level POLICY toggle above says whether Nora should try.
    // This says whether trying actually works on THIS agent's own OpenClaw
    // install -- 'unknown' until applyTracingConfig has run against it at
    // least once (e.g. tracesEnabled just turned on and the 30s reconcile
    // tick hasn't reached this agent yet).
    tracingCapability: agent.tracing_capability || "unknown",
    // Diagnostic-only, alongside tracingCapability -- see the migration
    // comment in server.ts for why this is never the trigger for the
    // supported/unsupported verdict itself.
    tracingOpenclawVersion: agent.tracing_openclaw_version || null,
    traceSampleRate: Number(settings.trace_sample_rate),
    traces: traces.slice(0, limit),
  };
}

// ── getTraceDetail (item 2) ───────────────────────────────────────────────

/**
 * `getTraceDetail(traceId, actor, params, deps)` — see the module header
 * for the exact response shape.
 *
 * @param {string} traceId
 * @param {Object} actor - authenticated actor (`req.user`-shaped).
 * @param {Object} [params] - `{ workspaceId? }`, an optional additional
 *   narrowing (item 8), same semantics as `listTraces`'s `workspaceId`.
 * @param {Object} [deps] - dependency injection for tests.
 */
async function getTraceDetail(traceId, actor, params = {}, deps = {}) {
  const db = deps.db || require("./db");
  const findAgentFn = deps.findAccessibleAgentForActor || findAccessibleAgentForActor;
  const correlatedLogsFn = deps.correlatedLogsForTrace || correlatedLogsForTrace;

  const spanResult = await db.query(
    `SELECT ${SPAN_COLUMNS} FROM agent_spans WHERE trace_id = $1`,
    [traceId],
  );
  const spanRows = spanResult.rows;
  if (!spanRows.length) throw notFoundError("Trace not found");

  const agentId = spanRows[0].agent_id;
  const agent = await findAgentFn(agentId, actor, "viewer");
  // Deliberately the SAME error as "trace has no rows" above -- see the
  // module header's workspace-scoping note on why a 404 must never confirm
  // a trace's existence to an actor without access to it.
  if (!agent) throw notFoundError("Trace not found");

  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : null;
  await logSearch.enforceWorkspaceScope({ agentId, workspaceId, actor }, { db });

  const trace = summarizeTrace(spanRows);
  const spans = buildSpanTree(spanRows);
  const correlatedLogs = await correlatedLogsFn(spanRows, deps);

  return { trace, spans, correlatedLogs };
}

module.exports = {
  listTraces,
  getTraceDetail,
  correlatedLogsForTrace,
  buildSpanTree,
  summarizeTrace,
};
