// Logging control plane — Runtime lens API client.
//
// Typed helpers over `fetchWithAuth`, mirroring `workspaceClient.ts`'s
// `jsonOrThrow` error-handling shape. Wraps `GET /logs/search` and
// `GET /logs/export` (Phase 6/7, `backend-api/routes/observability.ts` +
// `backend-api/logSearch.ts`) plus a couple of best-effort helpers used to
// surface the capacity-halt state described in the Phase 8 spec (item 8a).
//
// Also home to a handful of small, deliberately pure functions (windowing
// math, capability-state resolution, capacity-window pairing, filename
// extraction, "is this row's timestamp approximate" check) so they can be
// unit-tested under this package's actual test runner
// (`tsx --test lib/*.test.ts` — see package.json). This package has no
// component-testing harness (no Jest/RTL/jsdom), so anything that needs a
// DOM or React rendering to verify is exercised manually instead; see
// observabilityClient.test.ts and the Phase 8 completion report for exactly
// which behaviors that applies to.

import { fetchWithAuth } from "./api";

export type LogStream = "runtime" | "gateway";
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | string;
export type TsSource = "source" | "collector";

export interface LogLine {
  ts: string | null;
  observed_ts: string;
  ts_source: TsSource;
  stream: LogStream;
  level: LogLevel | null;
  message: string;
  agentId?: string;
  workspaceId?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  session_id?: string | null;
  channel?: string | null;
  ord?: number;
  // Client-only marker for lines appended by the live-tail WebSocket rather
  // than returned by `/logs/search` — see `RuntimeLens`'s live-tail section
  // in pages/logs/index.tsx for why this stream is not merged server-side.
  _live?: boolean;
}

export interface SearchLogsParams {
  workspaceId?: string | null;
  agentId: string;
  streams?: LogStream[];
  levels?: string[];
  from?: string;
  to?: string;
  q?: string;
  traceId?: string;
  cursor?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export interface SearchLogsResult {
  lines: LogLine[];
  nextCursor: string | null;
  warning?: "recent_lines_unavailable";
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function buildLogQuery(params: SearchLogsParams | LogExportParams): URLSearchParams {
  const query = new URLSearchParams();
  query.set("agentId", params.agentId);
  if (params.workspaceId) query.set("workspaceId", params.workspaceId);
  if (params.streams?.length) query.set("streams", params.streams.join(","));
  if (params.levels?.length) query.set("levels", params.levels.join(","));
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.q) query.set("q", params.q);
  return query;
}

/**
 * `GET /logs/search` — one agent's merged runtime/gateway timeline.
 * `agentId` is required; see the manifest's Non-Goals for why this is
 * intentionally single-agent, not fleet-wide.
 */
export async function searchLogs(params: SearchLogsParams): Promise<SearchLogsResult> {
  const query = buildLogQuery(params);
  if ("traceId" in params && params.traceId) query.set("traceId", params.traceId);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  if (params.order) query.set("order", params.order);
  const res = await fetchWithAuth(`/api/logs/search?${query.toString()}`);
  return jsonOrThrow<SearchLogsResult>(res);
}

export interface LogExportParams {
  workspaceId?: string | null;
  agentId: string;
  streams?: LogStream[];
  levels?: string[];
  from: string;
  to: string;
  q?: string;
  format?: "ndjson" | "csv";
}

/**
 * Extracts the filename from a `Content-Disposition: attachment;
 * filename="..."` header value. Pure and unit-tested — mirrors
 * `admin-dashboard/pages/audit.tsx`'s `extractFilename`.
 */
export function extractFilenameFromContentDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const match = header.match(/filename="([^"]+)"/i);
  return match?.[1] || fallback;
}

/**
 * `GET /logs/export` — downloads the filtered range as NDJSON or CSV,
 * mirroring the Blob-download pattern already used for agent export
 * (`pages/agents/[id].tsx`'s `handleExport`).
 */
export async function exportLogs(params: LogExportParams): Promise<{ filename: string }> {
  const query = buildLogQuery(params);
  if (params.format) query.set("format", params.format);
  const res = await fetchWithAuth(`/api/logs/export?${query.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Export failed (${res.status})`);
  }
  const disposition = res.headers.get("content-disposition");
  const filename = extractFilenameFromContentDisposition(
    disposition,
    `nora-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.${params.format === "csv" ? "csv" : "ndjson"}`,
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { filename };
}

// ── Capacity status (best-effort; see Phase 8 item 8a) ─────────────────────
//
// `GET /admin/log-storage` (Phase 5 item 7a-ii) is platform-admin-only
// (`requireAdmin`) and reports the CURRENT installation-wide capacity state
// only — not a historical per-range signal. This frontend deliberately does
// not add a new backend endpoint (Phase 8's file list is frontend-only), so
// this call is attempted and silently degrades to `null` for any non-admin
// actor (403) or transport failure, rather than being treated as available.
export interface CapacityStatus {
  usedBytes: number;
  limitBytes: number;
  state: "ok" | "warning" | "halted";
}

export async function getCurrentCapacityStatus(): Promise<CapacityStatus | null> {
  try {
    const res = await fetchWithAuth("/api/admin/log-storage");
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.capacity) return null;
    return body.capacity as CapacityStatus;
  } catch {
    return null;
  }
}

/**
 * Historical capacity-halt windows, built from the real `events` rows
 * Phase 5 item 6 writes (`log_storage_capacity_halted` /
 * `log_storage_capacity_resumed`) via the already-workspace-scoped
 * `GET /monitoring/events` (Phase 6 item 10 added `workspaceId` filtering
 * there for exactly this kind of session-side query). This is a REAL signal
 * — not a guess — but it is installation-wide in origin (the capacity gate
 * has no per-workspace dimension) and paired chronologically on the client
 * rather than joined by any shared key, since the events themselves carry
 * no pairing id. Treat gaps between an unmatched trailing "halted" event and
 * "now" as still-open windows.
 */
export interface CapacityHaltWindow {
  haltedAt: string;
  resumedAt: string | null;
}

async function fetchEventTimestamps(
  type: string,
  workspaceId: string | null | undefined,
): Promise<string[]> {
  try {
    const query = new URLSearchParams({ type, limit: "100" });
    if (workspaceId) query.set("workspaceId", workspaceId);
    const res = await fetchWithAuth(`/api/monitoring/events?${query.toString()}`);
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [];
    return events.map((event: any) => event.created_at).filter(Boolean);
  } catch {
    return [];
  }
}

/** Pure: pairs sorted halted/resumed timestamps into windows. */
export function pairCapacityHaltWindows(
  haltedAt: string[],
  resumedAt: string[],
): CapacityHaltWindow[] {
  const halts = [...haltedAt].sort();
  const resumes = [...resumedAt].sort();
  const windows: CapacityHaltWindow[] = [];
  let resumeIndex = 0;
  for (const halt of halts) {
    while (resumeIndex < resumes.length && resumes[resumeIndex] < halt) resumeIndex++;
    const resumedAtValue = resumeIndex < resumes.length ? resumes[resumeIndex] : null;
    windows.push({ haltedAt: halt, resumedAt: resumedAtValue });
    if (resumedAtValue) resumeIndex++;
  }
  return windows;
}

/** Pure: does a capacity-halt window overlap the queried [from, to] range? */
export function windowOverlapsRange(
  window: CapacityHaltWindow,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const windowStart = new Date(window.haltedAt).getTime();
  const windowEnd = window.resumedAt ? new Date(window.resumedAt).getTime() : Date.now();
  const rangeStart = from ? new Date(from).getTime() : -Infinity;
  const rangeEnd = to ? new Date(to).getTime() : Infinity;
  return windowStart <= rangeEnd && windowEnd >= rangeStart;
}

export async function fetchCapacityHaltWindows(
  workspaceId: string | null | undefined,
  from: string | undefined,
  to: string | undefined,
): Promise<CapacityHaltWindow[]> {
  const [halted, resumed] = await Promise.all([
    fetchEventTimestamps("log_storage_capacity_halted", workspaceId),
    fetchEventTimestamps("log_storage_capacity_resumed", workspaceId),
  ]);
  const windows = pairCapacityHaltWindows(halted, resumed);
  return windows.filter((window) => windowOverlapsRange(window, from, to));
}

// ── Row timestamp approximation marker (item 7) ─────────────────────────

/** Pure: true when a line's ordering is approximate (collector clock). */
export function isApproximateTimestamp(line: Pick<LogLine, "ts_source">): boolean {
  return line.ts_source === "collector";
}

// ── Capability-state resolution (item 8) ─────────────────────────────────

export type RuntimeLensCapability =
  | "ok"
  | "no_gateway_stream"
  | "k8s_local_unsupported"
  | "empty";

export interface RuntimeLensCapabilityInput {
  runtimeSupportsGatewayStream: boolean;
  streamsFilter: LogStream[];
  storageBackend: string | null; // null when unknown (non-admin actor)
  deployTarget: string | null;
  lineCount: number;
}

/**
 * Pure: decides which explicit capability state (if any) should replace a
 * misleading blank list. Order matters — the Kubernetes+local
 * misconfiguration is a platform-level condition and takes priority over
 * the runtime's own gateway-support question.
 */
export function resolveRuntimeLensCapability(
  input: RuntimeLensCapabilityInput,
): RuntimeLensCapability {
  if (input.lineCount > 0) return "ok";

  const isKubernetes = (input.deployTarget || "").toLowerCase().startsWith("k8s");
  if (isKubernetes && input.storageBackend === "local") {
    return "k8s_local_unsupported";
  }

  const wantsGatewayOnly =
    input.streamsFilter.length > 0 &&
    input.streamsFilter.every((stream) => stream === "gateway");
  if (!input.runtimeSupportsGatewayStream && wantsGatewayOnly) {
    return "no_gateway_stream";
  }
  if (!input.runtimeSupportsGatewayStream && input.streamsFilter.length === 0) {
    // No explicit stream filter, but this runtime family never emits a
    // gateway stream at all — still worth naming rather than leaving blank.
    return "no_gateway_stream";
  }

  return "empty";
}

// ── Virtualization math (item 4 / 50,000-line proxy test) ───────────────
//
// This package has no `react-window`/`@tanstack/react-virtual` dependency
// today (checked package.json and existing component usage before adding
// one) — see the Phase 8 report for the decision to hand-roll a small
// fixed-row-height virtualizer here rather than pull in a new dependency
// for one table. The windowing math itself is pure and unit-tested; the
// DOM-mounting side of it lives in `components/logs/LogTable.tsx`.

export interface VirtualRange {
  startIndex: number;
  endIndex: number; // exclusive
}

/**
 * Given a scroll position, viewport height, row height, total row count,
 * and an overscan margin, returns the inclusive-exclusive index range that
 * should actually be mounted. Bounded regardless of `totalCount` — this is
 * what keeps a 50,000-line result set from mounting 50,000 DOM nodes.
 */
export function computeVirtualRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  totalCount: number,
  overscan = 8,
): VirtualRange {
  if (totalCount <= 0 || rowHeight <= 0) return { startIndex: 0, endIndex: 0 };
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(totalCount, firstVisible + visibleCount + overscan);
  return { startIndex, endIndex };
}

// ── Traces lens (Phase 13) — ASSUMED API CONTRACT ───────────────────────
//
// IMPORTANT: this section is written against the CONTRACT documented in the
// Phase 13 frontend implementation brief, not against real backend code —
// the backend half of this phase (`GET /traces`, `GET /traces/:traceId`,
// `backend-api/traceQuery.ts`) is being built concurrently in a different
// git worktree from the same plan section
// (`plans/logging_control_plane/logging-control-plane-implementation-plan-v2.md`,
// "Phase 13: Traces Lens And Cross-Lens Correlation"). This file never saw
// that code. When both halves land on the same branch, diff the shapes
// below against what actually shipped — this comment block plus
// `normalizeTraceSummary` / `normalizeTraceDetail` / `normalizeSpanRow` /
// `normalizeCorrelatedLog` are the ONLY places a field-name mismatch should
// need touching; every component reads through those.
//
// Assumed shapes:
//
//   GET /traces?workspaceId=&agentId=&from=&to=&cursor=&limit=
//     -> TraceSummary[] (defensively also accepts `{ traces: [...],
//        nextCursor }`, mirroring how `searchLogs` above tolerates a bare
//        array vs. an enveloped result)
//     TraceSummary: { traceId, startedAt, agentId, rootSpanName,
//       durationMs, spanCount, status, tokensIn, tokensOut, costUsd }
//
//   GET /traces/:traceId
//     -> { trace: { traceId, agentId, workspaceId, startedAt, durationMs,
//            status },
//          spans: SpanRow[],
//          correlatedLogs: CorrelatedLogRow[] }
//     SpanRow: { spanId, parentSpanId, name, kind, startedAt, durationMs,
//       status, model, provider, tokensIn, tokensOut, costUsd }
//     CorrelatedLogRow: { ts, observedTs, tsSource, stream, level, message,
//       traceId, spanId, inTrace } — `inTrace: false` marks an untraced
//       runtime line included because it's in the same agent+time window,
//       NOT because it belongs to the trace (see Phase 13 spec item 4/9).
//
// The normalizers below accept both the assumed camelCase field names and
// their snake_case equivalents (`trace_id`, `started_at`, `span_id`,
// `parent_span_id`, `tokens_in`, `tokens_out`, `cost_usd`,
// `observed_ts`/`ts_source`, `in_trace`), since this codebase's other
// endpoints (`/logs/search`) use snake_case for exactly these concepts —
// there is a real chance the traces endpoints land snake_case too despite
// the plan spec's camelCase. Whichever it actually is, this file keeps
// working without a component-level change.

/** `GET /workspaces/:id/log-settings` — Phase 12, assumed already built. */
export interface WorkspaceLogSettings {
  tracesEnabled: boolean;
}

export interface TraceSummary {
  traceId: string;
  startedAt: string;
  agentId: string;
  rootSpanName: string | null;
  durationMs: number;
  spanCount: number;
  status: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface SpanRow {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string | null;
  startedAt: string;
  durationMs: number;
  status: string | null;
  model: string | null;
  provider: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface CorrelatedLogRow {
  ts: string | null;
  observedTs: string;
  tsSource: TsSource;
  stream: LogStream | string;
  level: string | null;
  message: string;
  traceId: string | null;
  spanId: string | null;
  /** false = untraced runtime line included for context (same agent+window), not part of the trace. */
  inTrace: boolean;
}

export interface TraceDetail {
  trace: {
    traceId: string;
    agentId: string;
    workspaceId: string | null;
    startedAt: string;
    durationMs: number;
    status: string | null;
  };
  spans: SpanRow[];
  correlatedLogs: CorrelatedLogRow[];
}

function num(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function str(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

function normalizeTraceSummary(raw: any): TraceSummary {
  return {
    traceId: str(raw.traceId, raw.trace_id) || "",
    startedAt: str(raw.startedAt, raw.started_at) || "",
    agentId: str(raw.agentId, raw.agent_id) || "",
    rootSpanName: str(raw.rootSpanName, raw.root_span_name),
    durationMs: num(raw.durationMs, raw.duration_ms),
    spanCount: num(raw.spanCount, raw.span_count),
    status: str(raw.status),
    tokensIn: num(raw.tokensIn, raw.tokens_in),
    tokensOut: num(raw.tokensOut, raw.tokens_out),
    costUsd: num(raw.costUsd, raw.cost_usd),
  };
}

function normalizeSpanRow(raw: any): SpanRow {
  return {
    spanId: str(raw.spanId, raw.span_id) || "",
    parentSpanId: str(raw.parentSpanId, raw.parent_span_id),
    name: str(raw.name) || "(unnamed span)",
    kind: str(raw.kind),
    startedAt: str(raw.startedAt, raw.started_at) || "",
    durationMs: num(raw.durationMs, raw.duration_ms),
    status: str(raw.status),
    model: str(raw.model),
    provider: str(raw.provider),
    tokensIn: num(raw.tokensIn, raw.tokens_in),
    tokensOut: num(raw.tokensOut, raw.tokens_out),
    costUsd: num(raw.costUsd, raw.cost_usd),
  };
}

function normalizeCorrelatedLog(raw: any): CorrelatedLogRow {
  return {
    ts: str(raw.ts),
    observedTs: str(raw.observedTs, raw.observed_ts) || raw.ts || "",
    tsSource: (str(raw.tsSource, raw.ts_source) as TsSource) || "collector",
    stream: str(raw.stream) || "runtime",
    level: str(raw.level),
    message: str(raw.message) || "",
    traceId: str(raw.traceId, raw.trace_id),
    spanId: str(raw.spanId, raw.span_id),
    inTrace: raw.inTrace ?? raw.in_trace ?? false,
  };
}

function normalizeTraceDetail(raw: any): TraceDetail {
  const rawTrace = raw?.trace || {};
  return {
    trace: {
      traceId: str(rawTrace.traceId, rawTrace.trace_id) || "",
      agentId: str(rawTrace.agentId, rawTrace.agent_id) || "",
      workspaceId: str(rawTrace.workspaceId, rawTrace.workspace_id),
      startedAt: str(rawTrace.startedAt, rawTrace.started_at) || "",
      durationMs: num(rawTrace.durationMs, rawTrace.duration_ms),
      status: str(rawTrace.status),
    },
    spans: Array.isArray(raw?.spans) ? raw.spans.map(normalizeSpanRow) : [],
    correlatedLogs: Array.isArray(raw?.correlatedLogs)
      ? raw.correlatedLogs.map(normalizeCorrelatedLog)
      : [],
  };
}

export interface ListTracesParams {
  workspaceId?: string | null;
  agentId: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface ListTracesResult {
  traces: TraceSummary[];
  nextCursor: string | null;
  // Reconciled against the real Phase 13 backend: `GET /traces` embeds the
  // requesting agent's resolved `tracesEnabled`/`traceSampleRate` directly in
  // its response (via `agentTracing.resolveWorkspaceLogSettings`), rather
  // than requiring a separate call to `GET /workspaces/:id/log-settings`.
  // That settings endpoint is guarded by `requireWorkspaceRole("admin", "id")`
  // (Phase 12), so a plain workspace viewer/editor legitimately using the
  // Traces lens would get a 403 from it and `getWorkspaceTracesEnabled`
  // would incorrectly resolve to `null` ("unknown" -> CTA shown) even when
  // tracing is genuinely on. Reading it off this response instead only
  // requires the same per-agent viewer access this endpoint already needs.
  // `getWorkspaceTracesEnabled` below is kept for admin-context callers
  // (e.g. a future settings page) but the Traces lens itself must NOT use it.
  tracesEnabled: boolean | null;
  traceSampleRate: number | null;
}

/**
 * `GET /traces` — trace summaries for one agent's window, plus that agent's
 * resolved tracing enablement (see `ListTracesResult.tracesEnabled` above).
 * Mirrors `searchLogs`'s error-handling shape (`jsonOrThrow`) exactly.
 */
export async function listTraces(params: ListTracesParams): Promise<ListTracesResult> {
  const query = new URLSearchParams();
  query.set("agentId", params.agentId);
  if (params.workspaceId) query.set("workspaceId", params.workspaceId);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  const res = await fetchWithAuth(`/api/traces?${query.toString()}`);
  const body = await jsonOrThrow<any>(res);
  const rawList = Array.isArray(body) ? body : Array.isArray(body?.traces) ? body.traces : [];
  const rawTracesEnabled = body?.tracesEnabled ?? body?.traces_enabled;
  const rawTraceSampleRate = body?.traceSampleRate ?? body?.trace_sample_rate;
  return {
    traces: rawList.map(normalizeTraceSummary),
    nextCursor: body?.nextCursor ?? null,
    tracesEnabled: typeof rawTracesEnabled === "boolean" ? rawTracesEnabled : null,
    traceSampleRate: typeof rawTraceSampleRate === "number" ? rawTraceSampleRate : null,
  };
}

/**
 * `GET /traces/:traceId` — span tree plus correlated log lines for one
 * trace. Mirrors `searchLogs`'s error-handling shape exactly. See the
 * ASSUMED API CONTRACT block above for the field-name caveat.
 */
export async function getTraceDetail(traceId: string): Promise<TraceDetail> {
  const res = await fetchWithAuth(`/api/traces/${encodeURIComponent(traceId)}`);
  const body = await jsonOrThrow<any>(res);
  return normalizeTraceDetail(body);
}

/**
 * `GET /workspaces/:id/log-settings` (Phase 12, assumed already built and
 * merged into the spine this worktree is based on) — used ONLY to read
 * `tracesEnabled` so the Traces lens can show an "enable tracing" CTA
 * instead of a misleadingly empty list (Phase 13 spec item 7/6). Best-effort
 * like `getCurrentCapacityStatus` above: returns `null` (== "unknown") on
 * any transport failure, 404 (endpoint not yet present), or non-boolean
 * field, rather than guessing. `resolveTracesLensView` below treats `null`
 * the same as `false` — the "false/unset" language in the spec — so an
 * unreachable settings endpoint conservatively shows the CTA rather than
 * silently pretending tracing is on.
 *
 * No workspace selected ("My agents (no workspace)") has no workspace-level
 * setting to check, so this returns `null` immediately in that case too.
 */
export async function getWorkspaceTracesEnabled(
  workspaceId: string | null | undefined,
): Promise<boolean | null> {
  if (!workspaceId) return null;
  try {
    const res = await fetchWithAuth(`/api/workspaces/${encodeURIComponent(workspaceId)}/log-settings`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const raw =
      body?.tracesEnabled ??
      body?.traces_enabled ??
      body?.logSettings?.tracesEnabled ??
      body?.logSettings?.traces_enabled;
    return typeof raw === "boolean" ? raw : null;
  } catch {
    return null;
  }
}

// ── Traces lens view resolution (item 6/7) ──────────────────────────────

export type TracesLensView = "enable_cta" | "empty" | "list";

export interface TracesLensViewInput {
  /** `null` = unknown (settings fetch failed, 404'd, or no workspace selected). */
  tracesEnabled: boolean | null;
  traceCount: number;
}

/**
 * Pure: decides which of the three Traces-lens states to render for an
 * agent that's already selected (the "no agent selected yet" state is
 * handled separately, one layer up, the same way the Runtime lens does it).
 * `tracesEnabled !== true` (i.e. `false` OR `null`/unknown) always wins —
 * that is the literal "false/unset" language in the Phase 13 spec — so a
 * workspace this frontend can't confirm has tracing on gets the CTA rather
 * than an empty list that looks like a bug.
 */
export function resolveTracesLensView(input: TracesLensViewInput): TracesLensView {
  if (input.tracesEnabled !== true) return "enable_cta";
  if (input.traceCount === 0) return "empty";
  return "list";
}

// ── Correlated log partitioning (item 4) ────────────────────────────────

export interface PartitionedCorrelatedLogs {
  inTrace: CorrelatedLogRow[];
  inWindowOnly: CorrelatedLogRow[];
}

/**
 * Pure: splits a trace detail's correlated log lines into the ones that
 * actually belong to the trace vs. the untraced-but-same-window runtime
 * lines included for context (`inTrace: false` — see the ASSUMED API
 * CONTRACT block). Order within each group is preserved.
 */
export function partitionCorrelatedLogs(logs: CorrelatedLogRow[]): PartitionedCorrelatedLogs {
  const inTrace: CorrelatedLogRow[] = [];
  const inWindowOnly: CorrelatedLogRow[] = [];
  for (const log of logs) {
    (log.inTrace ? inTrace : inWindowOnly).push(log);
  }
  return { inTrace, inWindowOnly };
}

// ── Span waterfall layout math (item 3) ─────────────────────────────────

const WATERFALL_MIN_WIDTH_PCT = 0.75;

export interface WaterfallSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** Nesting depth from the span's trace root (root = 0). */
  depth: number;
  /** Left offset, as a percentage of the trace's total duration. */
  offsetPct: number;
  /** Bar width, as a percentage of the trace's total duration. */
  widthPct: number;
  startedAt: string;
  durationMs: number;
  status: string | null;
  model: string | null;
  provider: string | null;
}

/**
 * Pure: lays out a trace's span tree for the waterfall visualization —
 * each span's horizontal offset/width relative to the trace's start and
 * total duration, plus its nesting depth for indentation. Returns spans in
 * depth-first, chronological-sibling order (so the array itself is a
 * legible render order — parent immediately followed by its children,
 * children ordered by start time), which is why `TraceWaterfall` maps this
 * array directly into rows rather than re-sorting it.
 *
 * A span whose `parentSpanId` doesn't resolve to another span in the same
 * list (missing, or pointing outside this trace) is treated as a root —
 * this keeps one malformed row from hiding the rest of the tree.
 */
export function computeWaterfallLayout(
  spans: SpanRow[],
  traceStartedAt: string,
  traceDurationMs: number,
): WaterfallSpan[] {
  const traceStart = new Date(traceStartedAt).getTime();
  // Guard divide-by-zero for a zero/negative/unparseable trace duration —
  // every span collapses to offset 0 rather than NaN/Infinity.
  const safeDuration = Number.isFinite(traceDurationMs) && traceDurationMs > 0 ? traceDurationMs : 1;

  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const childrenByParent = new Map<string, SpanRow[]>();
  const roots: SpanRow[] = [];
  for (const span of spans) {
    const parentId = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : null;
    if (parentId) {
      const siblings = childrenByParent.get(parentId) || [];
      siblings.push(span);
      childrenByParent.set(parentId, siblings);
    } else {
      roots.push(span);
    }
  }

  const byStartTime = (a: SpanRow, b: SpanRow) =>
    new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
  roots.sort(byStartTime);
  for (const siblings of childrenByParent.values()) siblings.sort(byStartTime);

  const result: WaterfallSpan[] = [];

  function visit(span: SpanRow, depth: number) {
    const startOffsetMs = new Date(span.startedAt).getTime() - traceStart;
    const offsetPct = Math.min(100, Math.max(0, (startOffsetMs / safeDuration) * 100));
    const rawWidthPct = (Math.max(0, span.durationMs) / safeDuration) * 100;
    const widthPct = Math.max(WATERFALL_MIN_WIDTH_PCT, Math.min(rawWidthPct, 100 - offsetPct));

    result.push({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      depth,
      offsetPct,
      widthPct,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      status: span.status,
      model: span.model,
      provider: span.provider,
    });

    for (const child of childrenByParent.get(span.spanId) || []) {
      visit(child, depth + 1);
    }
  }

  for (const root of roots) visit(root, 0);
  return result;
}
