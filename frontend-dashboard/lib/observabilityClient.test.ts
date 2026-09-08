import assert from "node:assert/strict";
import test from "node:test";

import {
  computeVirtualRange,
  extractFilenameFromContentDisposition,
  isApproximateTimestamp,
  pairCapacityHaltWindows,
  resolveRuntimeLensCapability,
  windowOverlapsRange,
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
