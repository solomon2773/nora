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
