import { Loader2, Waypoints } from "lucide-react";
import { clsx } from "clsx";
import type { TraceSummary } from "../../lib/observabilityClient";

// Trace list — left pane of the Traces lens (Phase 13). Rows show
// started-at, root span name, duration, span count, status, token totals,
// and cost (Phase 13 spec item 2). Clicking a row selects it; loading its
// detail (span tree + correlated logs) into the right-hand pane is the
// parent (`TracesLens` in pages/logs/index.tsx)'s job, not this
// component's — this stays a dumb, presentational list, matching how
// `LogTable` doesn't own its own fetch either.

const STATUS_STYLES: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700",
  success: "bg-emerald-50 text-emerald-700",
  error: "bg-red-50 text-red-700",
  failed: "bg-red-50 text-red-700",
  running: "bg-blue-50 text-blue-700",
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function formatTokens(tokensIn: number, tokensOut: number): string {
  const total = (tokensIn || 0) + (tokensOut || 0);
  if (!total) return "—";
  return `${total.toLocaleString()} (${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out)`;
}

function formatCost(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return "—";
  return `$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

function StatusBadge({ status }: { status: string | null }) {
  const key = (status || "").toLowerCase();
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        STATUS_STYLES[key] || "bg-slate-100 text-slate-500",
      )}
    >
      {status || "unknown"}
    </span>
  );
}

export interface TraceListProps {
  traces: TraceSummary[];
  selectedTraceId: string | null;
  onSelect: (traceId: string) => void;
  loading?: boolean;
}

export default function TraceList({
  traces,
  selectedTraceId,
  onSelect,
  loading = false,
}: TraceListProps) {
  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-4 py-3">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
          Traces ({traces.length})
        </p>
      </div>
      <div className="max-h-[640px] overflow-y-auto">
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 size={20} className="animate-spin text-blue-500" />
          </div>
        ) : traces.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center text-slate-400">
            <Waypoints size={22} className="opacity-60" />
            <p className="text-xs font-semibold">No traces in this range.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {traces.map((trace) => (
              <li key={trace.traceId}>
                <button
                  type="button"
                  onClick={() => onSelect(trace.traceId)}
                  className={clsx(
                    "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-slate-50",
                    selectedTraceId === trace.traceId && "bg-blue-50/60 hover:bg-blue-50/60",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                      {trace.rootSpanName || "(unnamed trace)"}
                    </p>
                    <StatusBadge status={trace.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-500">
                    <span>{formatDateTime(trace.startedAt)}</span>
                    <span>{formatDuration(trace.durationMs)}</span>
                    <span>
                      {trace.spanCount} span{trace.spanCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-400">
                    <span>{formatTokens(trace.tokensIn, trace.tokensOut)} tok</span>
                    <span>{formatCost(trace.costUsd)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
