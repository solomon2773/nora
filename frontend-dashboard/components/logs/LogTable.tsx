import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock, Loader2 } from "lucide-react";
import {
  computeVirtualRange,
  isApproximateTimestamp,
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
// add a new dependency for a single fixed-row-height list, this hand-rolls
// a minimal windowed list: a tall spacer div sized to the full row count so
// native scrolling behaves normally, with only the rows in the current
// scroll window actually mounted. This is a well-understood, small amount
// of code and keeps the dependency surface unchanged; if a second
// virtualized list shows up elsewhere in this app, that's the point at
// which pulling in a real library stops being premature.

const ROW_HEIGHT = 28;
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

function formatRowTime(line: LogLine): string {
  const value = line.ts || line.observed_ts;
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, { hour12: false }) + "." + String(date.getMilliseconds()).padStart(3, "0");
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
  lines: LogLine[];
  loading?: boolean;
  capability: RuntimeLensCapability;
  warning?: string | null;
  capacityWindows?: CapacityHaltWindow[];
  height?: number;
}

export default function LogTable({
  lines,
  loading = false,
  capability,
  warning = null,
  capacityWindows = [],
  height = 480,
}: LogTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const range = useMemo(
    () => computeVirtualRange(scrollTop, height, ROW_HEIGHT, lines.length, OVERSCAN),
    [scrollTop, height, lines.length],
  );

  const visibleLines = lines.slice(range.startIndex, range.endIndex);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {capacityWindows.length > 0 ? (
        <div className="space-y-1 border-b border-amber-100 bg-amber-50 px-4 py-3">
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
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-500">
          <AlertTriangle size={12} />
          Recent lines (last few minutes) could not be fetched from the collector — showing
          persisted results only.
        </div>
      ) : null}

      <div
        ref={containerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ height }}
        className="overflow-y-auto font-mono text-xs"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-blue-500" />
          </div>
        ) : lines.length === 0 ? (
          <CapabilityMessage capability={capability} />
        ) : (
          <div style={{ height: lines.length * ROW_HEIGHT, position: "relative" }}>
            {visibleLines.map((line, i) => {
              const absoluteIndex = range.startIndex + i;
              const approximate = isApproximateTimestamp(line);
              return (
                <div
                  key={`${absoluteIndex}-${line.ord ?? ""}-${line.ts || line.observed_ts}`}
                  style={{
                    position: "absolute",
                    top: absoluteIndex * ROW_HEIGHT,
                    height: ROW_HEIGHT,
                    left: 0,
                    right: 0,
                  }}
                  className={`flex items-center gap-2 border-b border-slate-50 px-3 ${line._live ? "bg-emerald-50/40" : ""}`}
                >
                  <span
                    className={`w-24 shrink-0 tabular-nums ${approximate ? "text-amber-600" : "text-slate-400"}`}
                    title={
                      approximate
                        ? "Approximate ordering — this line's source timestamp could not be parsed; sorted by collector receive time instead."
                        : undefined
                    }
                  >
                    {formatRowTime(line)}
                    {approximate ? "*" : ""}
                  </span>
                  <StreamBadge stream={line.stream} />
                  <LevelBadge level={line.level} />
                  <span className="min-w-0 flex-1 truncate text-slate-800" title={line.message}>
                    {line.message}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
