import assert from "node:assert/strict";
import test from "node:test";

import {
  computeVirtualRange,
  computeVirtualRangeFromOffsets,
  computeWaterfallLayout,
  extractFilenameFromContentDisposition,
  formatLogTime,
  isApproximateTimestamp,
  isScrolledToBottom,
  logRowIdentity,
  logTimeZoneLabel,
  orderRuntimeLensLines,
  pairCapacityHaltWindows,
  partitionCorrelatedLogs,
  resolveRuntimeLensCapability,
  resolveTracesLensView,
  rowIndexAtOffset,
  stripRedundantTimestamp,
  windowOverlapsRange,
  type CorrelatedLogRow,
  type LogLine,
  type SpanRow,
} from "./observabilityClient";

// ── extractFilenameFromContentDisposition ──────────────────────────────

test("extracts filename from a well-formed Content-Disposition header", () => {
  const header = 'attachment; filename="nora-logs-2026-01-01T00-00-00-000Z.ndjson"';
  assert.equal(
    extractFilenameFromContentDisposition(header, "fallback.ndjson"),
    "nora-logs-2026-01-01T00-00-00-000Z.ndjson",
  );
});

test("falls back when the header is missing or malformed", () => {
  assert.equal(extractFilenameFromContentDisposition(null, "fallback.csv"), "fallback.csv");
  assert.equal(extractFilenameFromContentDisposition("attachment", "fallback.csv"), "fallback.csv");
});

// ── isApproximateTimestamp (ts_source === "collector" marking) ──────────

test("marks a collector-stamped row as approximate", () => {
  assert.equal(isApproximateTimestamp({ ts_source: "collector" }), true);
});

test("does not mark a source-stamped row as approximate", () => {
  assert.equal(isApproximateTimestamp({ ts_source: "source" }), false);
});

// ── Runtime lens ordering / follow-bottom ──────────────────────────────

function lensLine(message: string, extra: Partial<LogLine> = {}): LogLine {
  return {
    ts: "2026-09-14T18:00:00.000Z",
    observed_ts: "2026-09-14T18:00:00.000Z",
    ts_source: "source",
    stream: "runtime",
    level: "INFO",
    message,
    ...extra,
  };
}

test("orders search (desc) then live lines oldest to newest", () => {
  const ordered = orderRuntimeLensLines(
    [lensLine("s3"), lensLine("s2"), lensLine("s1")],
    [lensLine("l1", { _live: true }), lensLine("l2", { _live: true })],
  );
  assert.deepEqual(
    ordered.map((l) => l.message),
    ["s1", "s2", "s3", "l1", "l2"],
  );
});

test("treats positions within the threshold as at the bottom", () => {
  assert.equal(isScrolledToBottom(1000, 560, 400, 40), true);
  assert.equal(isScrolledToBottom(1000, 600, 400, 40), true);
  assert.equal(isScrolledToBottom(1000, 500, 400, 40), false);
});

test("finds the row under a vertical offset", () => {
  const offsets = [0, 20, 60, 80];
  assert.equal(rowIndexAtOffset(offsets, 0), 0);
  assert.equal(rowIndexAtOffset(offsets, 25), 1);
  assert.equal(rowIndexAtOffset(offsets, 60), 2);
  assert.equal(rowIndexAtOffset(offsets, 500), 2);
  assert.equal(rowIndexAtOffset([0], 10), -1);
});

test("row identity distinguishes live and search rows with the same ord", () => {
  assert.notEqual(
    logRowIdentity(lensLine("a", { ord: 1 })),
    logRowIdentity(lensLine("a", { ord: 1, _live: true })),
  );
});

// ── formatLogTime / stripRedundantTimestamp ────────────────────────────

test("formats a row timestamp in UTC with milliseconds", () => {
  assert.equal(formatLogTime("2026-09-14T18:44:09.090Z", true), "18:44:09.090");
});

test("formats a missing or invalid row timestamp as a dash", () => {
  assert.equal(formatLogTime(null, true), "—");
  assert.equal(formatLogTime("not a date", false), "—");
});

test("labels the UTC zone explicitly", () => {
  assert.equal(logTimeZoneLabel(true), "UTC");
});

const runtimeLine = {
  ts: "2026-09-14T18:44:09.090Z",
  ts_source: "source" as const,
  message: "2026-09-14T18:44:09.085+00:00 [ws] ⇄ res ✓ logs.tail 160ms",
};

test("strips a leading timestamp that matches the row ts", () => {
  assert.equal(stripRedundantTimestamp(runtimeLine), "[ws] ⇄ res ✓ logs.tail 160ms");
});

test("strips a bracketed, space-separated Z timestamp", () => {
  assert.equal(
    stripRedundantTimestamp({ ...runtimeLine, message: "[2026-09-14 18:44:09Z] hello" }),
    "hello",
  );
});

test("keeps a leading timestamp outside the tolerance", () => {
  const message = "2026-09-14T18:40:00.000+00:00 replayed line";
  assert.equal(stripRedundantTimestamp({ ...runtimeLine, message }), message);
});

test("keeps a zone-less leading timestamp", () => {
  const message = "2026-09-14T18:44:09.085 no zone";
  assert.equal(stripRedundantTimestamp({ ...runtimeLine, message }), message);
});

test("keeps the timestamp on collector-stamped rows", () => {
  assert.equal(
    stripRedundantTimestamp({ ...runtimeLine, ts_source: "collector" }),
    runtimeLine.message,
  );
});

test("leaves messages without a leading timestamp unchanged", () => {
  const message = "⇄ res ✓ logs.tail 160ms conn=24103215…7966";
  assert.equal(stripRedundantTimestamp({ ...runtimeLine, message }), message);
});

// ── pairCapacityHaltWindows / windowOverlapsRange ────────────────────────

test("pairs halted/resumed events chronologically into windows", () => {
  const windows = pairCapacityHaltWindows(
    ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
    ["2026-01-01T06:00:00.000Z", "2026-01-03T12:00:00.000Z"],
  );
  assert.equal(windows.length, 2);
  assert.equal(windows[0].haltedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(windows[0].resumedAt, "2026-01-01T06:00:00.000Z");
  assert.equal(windows[1].haltedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(windows[1].resumedAt, "2026-01-03T12:00:00.000Z");
});

test("a still-open halt (no matching resume) keeps resumedAt null", () => {
  const windows = pairCapacityHaltWindows(["2026-01-05T00:00:00.000Z"], []);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resumedAt, null);
});

test("a stray resume with no matching halt is dropped, not paired backwards", () => {
  const windows = pairCapacityHaltWindows(
    ["2026-01-05T00:00:00.000Z"],
    ["2026-01-01T00:00:00.000Z"],
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resumedAt, null);
});

test("a window overlapping the queried range is detected", () => {
  const window = { haltedAt: "2026-01-01T00:00:00.000Z", resumedAt: "2026-01-01T06:00:00.000Z" };
  assert.equal(
    windowOverlapsRange(window, "2026-01-01T05:00:00.000Z", "2026-01-01T08:00:00.000Z"),
    true,
  );
});

test("a window entirely outside the queried range is not detected", () => {
  const window = { haltedAt: "2026-01-01T00:00:00.000Z", resumedAt: "2026-01-01T06:00:00.000Z" };
  assert.equal(
    windowOverlapsRange(window, "2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"),
    false,
  );
});

test("a still-open window overlaps a range that extends to 'now'", () => {
  const window = { haltedAt: "2026-01-01T00:00:00.000Z", resumedAt: null };
  assert.equal(windowOverlapsRange(window, "2026-01-01T00:00:00.000Z", undefined), true);
});

// ── resolveRuntimeLensCapability ─────────────────────────────────────────

test("non-empty results are always 'ok', regardless of other conditions", () => {
  assert.equal(
    resolveRuntimeLensCapability({
      runtimeSupportsGatewayStream: false,
      streamsFilter: ["gateway"],
      storageBackend: "local",
      deployTarget: "k8s",
      lineCount: 5,
    }),
    "ok",
  );
});

test("a Kubernetes agent on the local storage driver gets the misconfiguration state", () => {
  assert.equal(
    resolveRuntimeLensCapability({
      runtimeSupportsGatewayStream: true,
      streamsFilter: [],
      storageBackend: "local",
      deployTarget: "k8s",
      lineCount: 0,
    }),
    "k8s_local_unsupported",
  );
});

test("a hermes agent filtered to gateway-only gets the no-gateway-stream state", () => {
  assert.equal(
    resolveRuntimeLensCapability({
      runtimeSupportsGatewayStream: false,
      streamsFilter: ["gateway"],
      storageBackend: "s3",
      deployTarget: "docker",
      lineCount: 0,
    }),
    "no_gateway_stream",
  );
});

test("a hermes agent with no stream filter still gets the no-gateway-stream state", () => {
  assert.equal(
    resolveRuntimeLensCapability({
      runtimeSupportsGatewayStream: false,
      streamsFilter: [],
      storageBackend: "s3",
      deployTarget: "docker",
      lineCount: 0,
    }),
    "no_gateway_stream",
  );
});

test("an ordinary empty result (no special condition) falls back to generic empty", () => {
  assert.equal(
    resolveRuntimeLensCapability({
      runtimeSupportsGatewayStream: true,
      streamsFilter: [],
      storageBackend: "s3",
      deployTarget: "docker",
      lineCount: 0,
    }),
    "empty",
  );
});

test("k8s+local misconfiguration takes priority over the gateway-support question", () => {
  assert.equal(
    resolveRuntimeLensCapability({
      runtimeSupportsGatewayStream: false,
      streamsFilter: ["gateway"],
      storageBackend: "local",
      deployTarget: "k8s",
      lineCount: 0,
    }),
    "k8s_local_unsupported",
  );
});

// ── computeVirtualRange (bounded-mount proxy for the 50,000-line test) ──

test("virtual range stays bounded regardless of total row count", () => {
  const small = computeVirtualRange(0, 600, 24, 50);
  const huge = computeVirtualRange(0, 600, 24, 50000);
  const smallMounted = small.endIndex - small.startIndex;
  const hugeMounted = huge.endIndex - huge.startIndex;
  assert.ok(hugeMounted < 100, `expected a bounded mount count, got ${hugeMounted}`);
  // Mounting the same viewport window shouldn't materially differ whether
  // the underlying list has 50 or 50,000 rows.
  assert.ok(Math.abs(hugeMounted - smallMounted) <= 1);
});

test("virtual range tracks scroll position, not just the top of the list", () => {
  const range = computeVirtualRange(24 * 10000, 600, 24, 50000);
  assert.ok(range.startIndex > 9000);
  assert.ok(range.endIndex <= 50000);
});

test("virtual range clamps to the total count near the end of a long list", () => {
  const range = computeVirtualRange(24 * 49990, 600, 24, 50000);
  assert.equal(range.endIndex, 50000);
});

test("an empty list yields an empty range", () => {
  assert.deepEqual(computeVirtualRange(0, 600, 24, 0), { startIndex: 0, endIndex: 0 });
});

// ── computeVirtualRangeFromOffsets (variable/wrapped row heights) ───────

function buildOffsets(rowHeights: number[]): number[] {
  const offsets = [0];
  for (const h of rowHeights) offsets.push(offsets[offsets.length - 1] + h);
  return offsets;
}

test("uniform offsets behave like the fixed-height computation", () => {
  const offsets = buildOffsets(new Array(50000).fill(24));
  const range = computeVirtualRangeFromOffsets(offsets, 24 * 10000, 600, 12);
  const fixed = computeVirtualRange(24 * 10000, 600, 24, 50000, 12);
  // Not required to match exactly — the two implementations round viewport
  // coverage at the boundary differently (ceil'd row count vs. the exact
  // offset the viewport bottom falls in) — but they should stay within a
  // row of each other on both ends.
  assert.ok(Math.abs(range.startIndex - fixed.startIndex) <= 1);
  assert.ok(Math.abs(range.endIndex - fixed.endIndex) <= 1);
});

test("mixed row heights (wrapped multi-line rows) still bound the mount count", () => {
  // Every 10th row is a long, multi-line-wrapped message (200px); the rest
  // are single-line (24px) — mirrors a real log stream.
  const heights = Array.from({ length: 10000 }, (_, i) => (i % 10 === 0 ? 200 : 24));
  const offsets = buildOffsets(heights);
  const range = computeVirtualRangeFromOffsets(offsets, 0, 600, 12);
  const mounted = range.endIndex - range.startIndex;
  assert.ok(mounted < 100, `expected a bounded mount count, got ${mounted}`);
});

test("scrolling past tall rows still lands on the row actually under the viewport", () => {
  // Rows 0-4 are 200px tall each (1000px total), then uniform 24px rows.
  const heights = [200, 200, 200, 200, 200, ...new Array(1000).fill(24)];
  const offsets = buildOffsets(heights);
  // Scroll to 1000 + 24*10 = 1240 — should land just past row 5 + 10 more rows.
  const range = computeVirtualRangeFromOffsets(offsets, 1240, 300, 0);
  assert.equal(range.startIndex, 15);
});

test("clamps to the end of the list when scrolled past all measured content", () => {
  const offsets = buildOffsets(new Array(20).fill(24));
  const range = computeVirtualRangeFromOffsets(offsets, 100000, 600, 4);
  assert.equal(range.endIndex, 20);
  assert.ok(range.startIndex <= 20);
});

test("an empty offsets array yields an empty range", () => {
  assert.deepEqual(computeVirtualRangeFromOffsets([0], 0, 600, 8), { startIndex: 0, endIndex: 0 });
});

// ── resolveTracesLensView (Phase 13 item 6/7) ────────────────────────────

test("tracing disabled gets the enable-CTA state, regardless of trace count", () => {
  assert.equal(resolveTracesLensView({ tracesEnabled: false, traceCount: 0 }), "enable_cta");
  assert.equal(resolveTracesLensView({ tracesEnabled: false, traceCount: 5 }), "enable_cta");
});

test("unknown tracing state (settings fetch failed/unavailable) also gets the enable-CTA state", () => {
  assert.equal(resolveTracesLensView({ tracesEnabled: null, traceCount: 0 }), "enable_cta");
});

test("tracing enabled with zero traces in range gets the empty state, not the CTA", () => {
  assert.equal(resolveTracesLensView({ tracesEnabled: true, traceCount: 0 }), "empty");
});

test("tracing enabled with traces present gets the list state", () => {
  assert.equal(resolveTracesLensView({ tracesEnabled: true, traceCount: 3 }), "list");
});

test("tracing enabled but this agent's OpenClaw can't support it gets the unsupported state, even with zero traces", () => {
  assert.equal(
    resolveTracesLensView({ tracesEnabled: true, traceCount: 0, tracingCapability: "unsupported" }),
    "unsupported",
  );
});

test("workspace policy off still wins over per-agent capability", () => {
  assert.equal(
    resolveTracesLensView({ tracesEnabled: false, traceCount: 0, tracingCapability: "supported" }),
    "enable_cta",
  );
});

test("supported capability doesn't block the normal empty state", () => {
  assert.equal(
    resolveTracesLensView({ tracesEnabled: true, traceCount: 0, tracingCapability: "supported" }),
    "empty",
  );
});

test("traces already present prove capability, regardless of what the persisted 'unknown' verdict says", () => {
  assert.equal(
    resolveTracesLensView({ tracesEnabled: true, traceCount: 3, tracingCapability: "unknown" }),
    "list",
  );
});

test("unknown capability with zero traces (e.g. a stopped agent that's never been checked) gets its own distinct unverified state, not empty", () => {
  assert.equal(
    resolveTracesLensView({ tracesEnabled: true, traceCount: 0, tracingCapability: "unknown" }),
    "unverified",
  );
});

test("an absent tracingCapability field (older caller) still falls back to empty, not unverified", () => {
  assert.equal(resolveTracesLensView({ tracesEnabled: true, traceCount: 0 }), "empty");
});

// ── partitionCorrelatedLogs (Phase 13 item 4) ────────────────────────────

function correlatedLog(overrides: Partial<CorrelatedLogRow>): CorrelatedLogRow {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    observedTs: "2026-01-01T00:00:00.000Z",
    tsSource: "source",
    stream: "gateway",
    level: "INFO",
    message: "line",
    traceId: "trace-1",
    spanId: "span-1",
    inTrace: true,
    ...overrides,
  };
}

test("partitionCorrelatedLogs splits traced lines from in-window-only lines", () => {
  const logs = [
    correlatedLog({ message: "a", inTrace: true }),
    correlatedLog({ message: "b", inTrace: false, spanId: null }),
    correlatedLog({ message: "c", inTrace: true }),
    correlatedLog({ message: "d", inTrace: false, spanId: null }),
  ];
  const { inTrace, inWindowOnly } = partitionCorrelatedLogs(logs);
  assert.deepEqual(inTrace.map((l) => l.message), ["a", "c"]);
  assert.deepEqual(inWindowOnly.map((l) => l.message), ["b", "d"]);
});

test("partitionCorrelatedLogs handles an all-traced or all-in-window list", () => {
  const allTraced = [correlatedLog({ message: "a" }), correlatedLog({ message: "b" })];
  assert.equal(partitionCorrelatedLogs(allTraced).inWindowOnly.length, 0);

  const allWindowOnly = [
    correlatedLog({ message: "a", inTrace: false }),
    correlatedLog({ message: "b", inTrace: false }),
  ];
  assert.equal(partitionCorrelatedLogs(allWindowOnly).inTrace.length, 0);
});

// ── computeWaterfallLayout (Phase 13 item 3) ─────────────────────────────

function span(overrides: Partial<SpanRow>): SpanRow {
  return {
    spanId: "root",
    parentSpanId: null,
    name: "span",
    kind: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1000,
    status: "ok",
    model: null,
    provider: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ...overrides,
  };
}

test("computeWaterfallLayout places a span starting halfway through the trace at 50% offset", () => {
  const spans = [
    span({
      spanId: "root",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
    }),
    span({
      spanId: "child",
      parentSpanId: "root",
      startedAt: "2026-01-01T00:00:00.500Z",
      durationMs: 250,
    }),
  ];
  const layout = computeWaterfallLayout(spans, "2026-01-01T00:00:00.000Z", 1000);
  const root = layout.find((s) => s.spanId === "root")!;
  const child = layout.find((s) => s.spanId === "child")!;
  assert.equal(root.offsetPct, 0);
  assert.equal(root.widthPct, 100);
  assert.equal(child.offsetPct, 50);
  assert.equal(child.widthPct, 25);
});

test("computeWaterfallLayout reflects parent/child nesting depth", () => {
  const spans = [
    span({ spanId: "root", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1000 }),
    span({
      spanId: "mid",
      parentSpanId: "root",
      startedAt: "2026-01-01T00:00:00.100Z",
      durationMs: 800,
    }),
    span({
      spanId: "leaf",
      parentSpanId: "mid",
      startedAt: "2026-01-01T00:00:00.200Z",
      durationMs: 400,
    }),
  ];
  const layout = computeWaterfallLayout(spans, "2026-01-01T00:00:00.000Z", 1000);
  assert.equal(layout.find((s) => s.spanId === "root")!.depth, 0);
  assert.equal(layout.find((s) => s.spanId === "mid")!.depth, 1);
  assert.equal(layout.find((s) => s.spanId === "leaf")!.depth, 2);
});

test("computeWaterfallLayout treats a span with an unresolvable parentSpanId as a root", () => {
  const spans = [span({ spanId: "orphan", parentSpanId: "does-not-exist" })];
  const layout = computeWaterfallLayout(spans, "2026-01-01T00:00:00.000Z", 1000);
  assert.equal(layout[0].depth, 0);
});

test("computeWaterfallLayout orders siblings chronologically within a parent", () => {
  const spans = [
    span({ spanId: "root", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1000 }),
    span({
      spanId: "second",
      parentSpanId: "root",
      startedAt: "2026-01-01T00:00:00.600Z",
      durationMs: 100,
    }),
    span({
      spanId: "first",
      parentSpanId: "root",
      startedAt: "2026-01-01T00:00:00.100Z",
      durationMs: 100,
    }),
  ];
  const layout = computeWaterfallLayout(spans, "2026-01-01T00:00:00.000Z", 1000);
  assert.deepEqual(
    layout.map((s) => s.spanId),
    ["root", "first", "second"],
  );
});

test("computeWaterfallLayout guards against a zero trace duration instead of producing NaN", () => {
  const spans = [span({ spanId: "root", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 0 })];
  const layout = computeWaterfallLayout(spans, "2026-01-01T00:00:00.000Z", 0);
  assert.equal(Number.isFinite(layout[0].offsetPct), true);
  assert.equal(Number.isFinite(layout[0].widthPct), true);
});
