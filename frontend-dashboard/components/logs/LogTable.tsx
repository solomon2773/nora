import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Clock, Loader2 } from "lucide-react";
import {
  computeVirtualRangeFromOffsets,
  formatLogTime,
  isApproximateTimestamp,
  isScrolledToBottom,
  logRowIdentity,
  logTimeZoneLabel,
  rowIndexAtOffset,
  stripRedundantTimestamp,
  type CapacityHaltWindow,
  type LogLine,
  type RuntimeLensCapability,
} from "../../lib/observabilityClient";

// Runtime lens row list. Deliberately NOT `components/LogViewer.tsx` — see
// that file's header and the Phase 8 spec: LogViewer caps at 2,000 lines,
// keys rows with `key={i}`, and has no virtualization or pause-on-scroll.
// It stays untouched for the agent detail page's live tail.
//
// Virtualization: this package has no `react-window` /
// `@tanstack/react-virtual` dependency today (checked package.json and
// existing component usage before reaching for a new one — see
// observabilityClient.ts's comment on `computeVirtualRange`). Rather than
// add a new dependency for a single list, this hand-rolls a minimal windowed
// list: a tall spacer div sized to the full (measured) row extent so native
// scrolling behaves normally, with only the rows in the current scroll
// window actually mounted. This is a well-understood, small amount of code
// and keeps the dependency surface unchanged; if a second virtualized list
// shows up elsewhere in this app, that's the point at which pulling in a
// real library stops being premature.
//
// Rows wrap (no truncation) since a log message can be any length, so row
// height is variable rather than fixed. Each mounted row reports its actual
// rendered height via ResizeObserver; `ESTIMATED_ROW_HEIGHT` is only the
// placeholder used for rows that haven't been measured yet (off-screen ones,
// and the initial paint), so the scrollbar doesn't jump around as real
// measurements come in.
//
// Ordering / scrolling: `lines` run oldest → newest with the newest at the
// bottom. While the operator is parked at the bottom the table follows new
// lines; once they scroll up it holds their place — the row at the top of
// the viewport is recorded as an anchor and restored whenever rows are added,
// trimmed, or re-measured above it — and a "new lines" button jumps back.
// A changed `resultSetKey` (new query/filters) re-pins to the bottom.

const ESTIMATED_ROW_HEIGHT = 28;
const OVERSCAN = 12;

const LEVEL_STYLES: Record<string, string> = {
  DEBUG: "bg-slate-100 text-slate-500",
  INFO: "bg-blue-50 text-blue-700",
  WARN: "bg-amber-50 text-amber-700",
  ERROR: "bg-red-50 text-red-700",
};

const STREAM_STYLES: Record<string, string> = {
  runtime: "bg-slate-900 text-white",
  gateway: "bg-violet-100 text-violet-700",
};

const UTC_PREFERENCE_KEY = "nora.logs.timeInUtc";

function readUtcPreference(): boolean {
  try {
    return window.localStorage.getItem(UTC_PREFERENCE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeUtcPreference(utc: boolean) {
  try {
    window.localStorage.setItem(UTC_PREFERENCE_KEY, utc ? "1" : "0");
  } catch {
    // Storage unavailable (private mode, blocked site data) — the toggle
    // still works for this page view.
  }
}

// Hover text for the time column: both the source and collector times in
// full UTC, so the column can be reconciled with the message text and any
// ingest lag is visible without adding another column.
function rowTimeTitle(line: LogLine, approximate: boolean): string {
  const parts: string[] = [];
  if (approximate) {
    parts.push(
      "Approximate ordering — this line's source timestamp could not be parsed; sorted by collector receive time instead.",
    );
  }
  if (line.ts) parts.push(`Source: ${line.ts}`);
  if (line.observed_ts) parts.push(`Collected: ${line.observed_ts}`);
  return parts.join("\n");
}

function LevelBadge({ level }: { level: string | null }) {
  const key = (level || "").toUpperCase();
  return (
    <span
      className={`inline-flex w-14 shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${LEVEL_STYLES[key] || "bg-slate-100 text-slate-500"}`}
    >
      {key || "—"}
    </span>
  );
}

function StreamBadge({ stream }: { stream: string }) {
  return (
    <span
      className={`inline-flex w-16 shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STREAM_STYLES[stream] || "bg-slate-100 text-slate-500"}`}
    >
      {stream}
    </span>
  );
}

function CapabilityMessage({ capability }: { capability: RuntimeLensCapability }) {
  if (capability === "k8s_local_unsupported") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangle size={28} className="text-amber-500" />
        <p className="text-sm font-bold text-slate-700">
          Log storage not configured for Kubernetes deployments
        </p>
        <p className="max-w-md text-xs text-slate-500">
          This agent runs on Kubernetes, but the platform's log storage destination is set to the
          local driver, which is not supported there. Switch to an S3 or R2 destination in log
          storage settings to collect logs for this agent.
        </p>
      </div>
    );
  }

  if (capability === "no_gateway_stream") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Clock size={28} className="text-slate-300" />
        <p className="text-sm font-bold text-slate-700">No gateway log stream for this agent</p>
        <p className="max-w-md text-xs text-slate-500">
          This agent's runtime family does not emit a separate gateway log stream. Runtime
          (container) logs, if any, still appear when the gateway filter is cleared.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Clock size={28} className="text-slate-300" />
      <p className="text-sm font-bold text-slate-700">No log lines in this range</p>
      <p className="max-w-md text-xs text-slate-500">
        Nothing matched the current filters and time range for this agent.
      </p>
    </div>
  );
}

export interface LogTableProps {
  // Oldest → newest.
  lines: LogLine[];
  // Changes when the underlying result set is replaced (agent, filters,
  // range, query) — not on live-tail appends. Re-pins to the bottom.
  resultSetKey?: string;
  loading?: boolean;
  capability: RuntimeLensCapability;
  warning?: string | null;
  capacityWindows?: CapacityHaltWindow[];
  // Fallback height used only until the container's actual rendered height
  // is measured (and if ResizeObserver is unavailable). The scroll container
  // otherwise flexes to fill whatever vertical space its parent gives it —
  // see the `flex-1 min-h-0` wiring in RuntimeLens — rather than clipping at
  // a fixed pixel value regardless of viewport size.
  height?: number;
}

export default function LogTable({
  lines,
  resultSetKey = "",
  loading = false,
  capability,
  warning = null,
  capacityWindows = [],
  height: fallbackHeight = 480,
}: LogTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(fallbackHeight);
  // Read after mount so SSR and the first client render agree.
  const [utc, setUtc] = useState(false);
  const [zoneLabel, setZoneLabel] = useState("Local");

  useEffect(() => {
    setUtc(readUtcPreference());
  }, []);

  useEffect(() => {
    setZoneLabel(logTimeZoneLabel(utc));
  }, [utc]);

  const toggleUtc = useCallback(() => {
    setUtc((prev) => {
      writeUtcPreference(!prev);
      return !prev;
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Unique per-row keys (identity plus an occurrence suffix for the rare
  // duplicate). Used as React keys, for measured heights, and for the scroll
  // anchor, so all three survive live-tail appends and buffer trimming that
  // shift row positions.
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return lines.map((line) => {
      const identity = logRowIdentity(line);
      const count = seen.get(identity) ?? 0;
      seen.set(identity, count + 1);
      return count === 0 ? identity : `${identity}#${count}`;
    });
  }, [lines]);

  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    rowKeys.forEach((key, index) => map.set(key, index));
    return map;
  }, [rowKeys]);

  const heightsRef = useRef<Map<string, number>>(new Map());
  const elementKeyRef = useRef<Map<Element, string>>(new Map());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [heightsVersion, setHeightsVersion] = useState(0);

  // Drop measurements for rows that have left the list (trimmed live lines,
  // replaced result sets) so the map doesn't grow without bound.
  useEffect(() => {
    const heights = heightsRef.current;
    if (heights.size <= rowKeys.length * 2) return;
    for (const key of heights.keys()) {
      if (!indexByKey.has(key)) heights.delete(key);
    }
  }, [rowKeys, indexByKey]);

  const recordHeight = useCallback((key: string, measured: number) => {
    const rounded = Math.round(measured);
    if (rounded <= 0 || heightsRef.current.get(key) === rounded) return;
    heightsRef.current.set(key, rounded);
    setHeightsVersion((v) => v + 1);
  }, []);

  const getResizeObserver = useCallback(() => {
    if (!resizeObserverRef.current) {
      resizeObserverRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const key = elementKeyRef.current.get(entry.target);
          if (key !== undefined) {
            recordHeight(key, entry.target.getBoundingClientRect().height);
          }
        }
      });
    }
    return resizeObserverRef.current;
  }, [recordHeight]);

  const rowRef = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      if (!el) return undefined;
      const observer = getResizeObserver();
      elementKeyRef.current.set(el, key);
      observer.observe(el);
      recordHeight(key, el.getBoundingClientRect().height);
      return () => {
        observer.unobserve(el);
        elementKeyRef.current.delete(el);
      };
    },
    [getResizeObserver, recordHeight],
  );

  // Cumulative offsets: offsets[i] is the top of row i, offsets[n] is the
  // total (measured-or-estimated) content height.
  const offsets = useMemo(() => {
    const result = new Array<number>(rowKeys.length + 1);
    result[0] = 0;
    for (let i = 0; i < rowKeys.length; i++) {
      const measured = heightsRef.current.get(rowKeys[i]);
      result[i + 1] = result[i] + (measured ?? ESTIMATED_ROW_HEIGHT);
    }
    return result;
    // heightsVersion is a trigger, not a value read here — it bumps whenever
    // a real measurement lands so offsets recompute with fresh data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeys, heightsVersion]);

  const range = useMemo(
    () => computeVirtualRangeFromOffsets(offsets, scrollTop, height, OVERSCAN),
    [offsets, scrollTop, height],
  );

  const visibleLines = lines.slice(range.startIndex, range.endIndex);
  const totalHeight = offsets[offsets.length - 1];

  // ── Follow-bottom / scroll anchoring ──────────────────────────────────
  // Refs drive the layout effect (no stale closures, no extra renders);
  // `following` mirrors followRef for the jump button.
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  // Row at the top of the viewport and how far into it the viewport starts.
  const anchorRef = useRef<{ key: string; delta: number } | null>(null);
  // Newest row when the operator scrolled away, for the "N new lines" count.
  const lastSeenKeyRef = useRef<string | null>(null);
  const resultSetKeyRef = useRef(resultSetKey);

  const setFollow = useCallback((follow: boolean) => {
    followRef.current = follow;
    setFollowing(follow);
    if (follow) {
      anchorRef.current = null;
      lastSeenKeyRef.current = null;
    }
  }, []);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setScrollTop(el.scrollTop);
    if (isScrolledToBottom(el.scrollHeight, el.scrollTop, el.clientHeight)) {
      if (!followRef.current) setFollow(true);
      return;
    }
    if (followRef.current) {
      lastSeenKeyRef.current = rowKeys[rowKeys.length - 1] ?? null;
      setFollow(false);
    }
    const index = rowIndexAtOffset(offsets, el.scrollTop);
    anchorRef.current =
      index >= 0 ? { key: rowKeys[index], delta: el.scrollTop - offsets[index] } : null;
  };

  // Runs before paint whenever content height or the viewport changes:
  // either stick to the bottom, or put the anchored row back where the
  // operator left it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (resultSetKeyRef.current !== resultSetKey) {
      resultSetKeyRef.current = resultSetKey;
      setFollow(true);
    }
    if (followRef.current) {
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
      if (el.scrollTop !== bottom) {
        el.scrollTop = bottom;
        setScrollTop(el.scrollTop);
      }
      return;
    }
    const anchor = anchorRef.current;
    const index = anchor ? indexByKey.get(anchor.key) : undefined;
    if (anchor && index !== undefined) {
      const target = offsets[index] + anchor.delta;
      if (Math.abs(el.scrollTop - target) > 1) {
        el.scrollTop = target;
        setScrollTop(el.scrollTop);
      }
    }
  }, [offsets, indexByKey, height, resultSetKey, loading, setFollow]);

  const jumpToLatest = () => {
    setFollow(true);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const lastSeenIndex =
    lastSeenKeyRef.current !== null ? indexByKey.get(lastSeenKeyRef.current) : undefined;
  const newLineCount = lastSeenIndex !== undefined ? rowKeys.length - 1 - lastSeenIndex : 0;

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      {capacityWindows.length > 0 ? (
        <div className="shrink-0 space-y-1 border-b border-amber-100 bg-amber-50 px-4 py-3">
          {capacityWindows.map((window) => (
            <p
              key={`${window.haltedAt}-${window.resumedAt || "open"}`}
              className="flex items-center gap-2 text-xs font-semibold text-amber-800"
            >
              <AlertTriangle size={13} className="shrink-0" />
              Log collection was paused (storage at capacity) from{" "}
              {new Date(window.haltedAt).toLocaleString()} to{" "}
              {window.resumedAt ? new Date(window.resumedAt).toLocaleString() : "now"}. This is a
              collection gap, not deleted data — nothing within retention was removed.
            </p>
          ))}
        </div>
      ) : null}

      {warning === "recent_lines_unavailable" ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-500">
          <AlertTriangle size={12} />
          Recent lines (last few minutes) could not be fetched from the collector — showing
          persisted results only.
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
        <button
          type="button"
          onClick={toggleUtc}
          className="w-24 shrink-0 text-left hover:text-slate-600"
          title={utc ? "Showing UTC — click for local time" : "Showing local time — click for UTC"}
        >
          Time ({zoneLabel})
        </button>
        <span className="w-16 shrink-0 text-center">Stream</span>
        <span className="w-14 shrink-0 text-center">Level</span>
        <span className="min-w-0 flex-1">Message</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          // Native scroll anchoring would fight the manual anchor restore.
          style={{ overflowAnchor: "none" }}
          className="h-full overflow-y-auto font-mono text-xs"
        >
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={20} className="animate-spin text-blue-500" />
            </div>
          ) : lines.length === 0 ? (
            <CapabilityMessage capability={capability} />
          ) : (
            <div style={{ height: totalHeight, position: "relative" }}>
              {visibleLines.map((line, i) => {
                const absoluteIndex = range.startIndex + i;
                const rowKey = rowKeys[absoluteIndex];
                const approximate = isApproximateTimestamp(line);
                return (
                  <div
                    key={rowKey}
                    ref={rowRef(rowKey)}
                    style={{
                      position: "absolute",
                      top: offsets[absoluteIndex],
                      left: 0,
                      right: 0,
                    }}
                    className={`flex items-start gap-2 border-b border-slate-50 px-3 py-1.5 ${line._live ? "bg-emerald-50/40" : ""}`}
                  >
                    <span
                      className={`w-24 shrink-0 tabular-nums ${approximate ? "text-amber-600" : "text-slate-400"}`}
                      title={rowTimeTitle(line, approximate)}
                    >
                      {formatLogTime(line.ts || line.observed_ts, utc)}
                      {approximate ? "*" : ""}
                    </span>
                    <StreamBadge stream={line.stream} />
                    <LevelBadge level={line.level} />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-800">
                      {stripRedundantTimestamp(line)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!following && !loading && lines.length > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-slate-700"
          >
            <ArrowDown size={13} />
            {newLineCount > 0
              ? `${newLineCount} new line${newLineCount === 1 ? "" : "s"}`
              : "Jump to latest"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
