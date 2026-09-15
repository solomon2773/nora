import { useMemo } from "react";
import { AlertTriangle, Loader2, ScrollText } from "lucide-react";
import { clsx } from "clsx";
import {
  computeWaterfallLayout,
  partitionCorrelatedLogs,
  type CorrelatedLogRow,
  type SpanRow,
  type TraceDetail,
} from "../../lib/observabilityClient";

// Split-pane detail view — right pane of the Traces lens (Phase 13):
// a span waterfall above, correlated log lines below, for whichever trace
// is selected in TraceList. The layout math (offset/width/depth) lives in
// `computeWaterfallLayout` (observabilityClient.ts) so it's unit-testable
// without a DOM — this component only renders what that function computes.
//
// This is deliberately NOT a pixel-perfect Gantt chart (Phase 13 spec item
// 3 says as much): a legible hierarchy of what ran when and for how long is
// the bar, not a full tracing-UI clone.

const STATUS_BAR_STYLES: Record<string, string> = {
  ok: "bg-emerald-500",
  success: "bg-emerald-500",
  error: "bg-red-500",
  failed: "bg-red-500",
  running: "bg-blue-500",
};

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return (
    date.toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(date.getMilliseconds()).padStart(3, "0")
  );
}

function SpanBar({ span }: { span: ReturnType<typeof computeWaterfallLayout>[number] }) {
  const barColor = STATUS_BAR_STYLES[(span.status || "").toLowerCase()] || "bg-slate-400";
  const detail = [span.provider, span.model].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-2 py-1.5">
      <div
        className="flex min-w-0 shrink-0 items-center gap-1.5 pr-2 text-xs font-semibold text-slate-700"
        style={{ paddingLeft: span.depth * 16, width: 260 }}
        title={span.name}
      >
        <span className="truncate">{span.name}</span>
      </div>
      <div className="relative h-4 flex-1 rounded-full bg-slate-100">
        <div
          className={clsx("absolute top-0 h-4 min-w-[3px] rounded-full", barColor)}
          style={{ left: `${span.offsetPct}%`, width: `${span.widthPct}%` }}
          title={`${span.name} — ${formatDuration(span.durationMs)} starting at ${formatTime(span.startedAt)}${detail ? ` (${detail})` : ""}`}
        />
      </div>
      <div className="w-20 shrink-0 text-right text-[11px] font-medium tabular-nums text-slate-500">
        {formatDuration(span.durationMs)}
      </div>
    </div>
  );
}

function CorrelatedLogRowView({ log }: { log: CorrelatedLogRow }) {
  return (
    <div
      className={clsx(
        "flex items-start gap-2 border-b border-slate-50 px-3 py-1.5 text-xs",
        !log.inTrace && "bg-slate-50/60",
      )}
    >
      <span className="w-24 shrink-0 tabular-nums text-slate-400">
        {formatTime(log.ts || log.observedTs)}
      </span>
      <span
        className={clsx(
          "inline-flex w-16 shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
          log.stream === "gateway" ? "bg-violet-100 text-violet-700" : "bg-slate-900 text-white",
        )}
      >
        {log.stream}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-800">
        {log.message}
      </span>
      {!log.inTrace ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700"
          title="Untraced runtime line from the same agent and time window — included for context, not part of this trace."
        >
          In window
        </span>
      ) : null}
    </div>
  );
}

export interface TraceWaterfallProps {
  detail: TraceDetail | null;
  loading?: boolean;
  error?: string | null;
}

export default function TraceWaterfall({ detail, loading = false, error = null }: TraceWaterfallProps) {
  const layout = useMemo(() => {
    if (!detail) return [];
    return computeWaterfallLayout(detail.spans as SpanRow[], detail.trace.startedAt, detail.trace.durationMs);
  }, [detail]);

  const { inTrace, inWindowOnly } = useMemo(
    () => partitionCorrelatedLogs(detail?.correlatedLogs || []),
    [detail],
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-red-100 bg-red-50 px-6 text-center">
        <AlertTriangle size={24} className="text-red-500" />
        <p className="text-sm font-semibold text-red-800">{error}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
        <ScrollText size={26} className="opacity-60" />
        <p className="text-sm font-semibold">Select a trace to view its span waterfall and logs.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-4">
      <section className="max-h-[45%] shrink-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="mb-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
          Span waterfall ({detail.spans.length})
        </p>
        {layout.length === 0 ? (
          <p className="py-6 text-center text-xs font-medium text-slate-400">
            No spans recorded for this trace.
          </p>
        ) : (
          <div className="flex flex-col">
            {layout.map((span) => (
              <SpanBar key={span.spanId} span={span} />
            ))}
          </div>
        )}
      </section>

      <section className="flex min-h-[160px] flex-1 flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
            Correlated logs ({inTrace.length + inWindowOnly.length})
          </p>
          <p className="text-[11px] font-medium text-slate-400">
            {inTrace.length} in trace · {inWindowOnly.length} in window only
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto font-mono">
          {inTrace.length === 0 && inWindowOnly.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs font-medium text-slate-400">
              No correlated log lines for this trace or its window.
            </p>
          ) : (
            <>
              {inTrace.map((log, index) => (
                <CorrelatedLogRowView key={`traced-${index}-${log.ts || log.observedTs}`} log={log} />
              ))}
              {inWindowOnly.map((log, index) => (
                <CorrelatedLogRowView key={`window-${index}-${log.ts || log.observedTs}`} log={log} />
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
