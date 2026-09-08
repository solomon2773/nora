import { Download, Loader2, Radio, Search, WifiOff } from "lucide-react";
import { clsx } from "clsx";
import type { LogStream } from "../../lib/observabilityClient";

const STREAM_OPTIONS: LogStream[] = ["runtime", "gateway"];
const LEVEL_OPTIONS = ["DEBUG", "INFO", "WARN", "ERROR"];

export interface LogFilterBarProps {
  q: string;
  onQChange: (value: string) => void;
  streams: LogStream[];
  onStreamsChange: (streams: LogStream[]) => void;
  levels: string[];
  onLevelsChange: (levels: string[]) => void;
  liveTail: boolean;
  onLiveTailChange: (value: boolean) => void;
  liveTailConnected: boolean;
  onExport: () => void;
  exporting?: boolean;
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export default function LogFilterBar({
  q,
  onQChange,
  streams,
  onStreamsChange,
  levels,
  onLevelsChange,
  liveTail,
  onLiveTailChange,
  liveTailConnected,
  onExport,
  exporting = false,
}: LogFilterBarProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(event) => onQChange(event.target.value)}
            placeholder="Search message text"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-8 pr-3 text-xs font-medium text-slate-900 outline-none focus:border-blue-200 focus:bg-white"
          />
        </div>

        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          {STREAM_OPTIONS.map((stream) => (
            <button
              key={stream}
              type="button"
              onClick={() => onStreamsChange(toggleValue(streams, stream))}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide transition-all",
                streams.includes(stream)
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700",
              )}
            >
              {stream}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          {LEVEL_OPTIONS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => onLevelsChange(toggleValue(levels, level))}
              className={clsx(
                "rounded-lg px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-all",
                levels.includes(level)
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700",
              )}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onLiveTailChange(!liveTail)}
          className={clsx(
            "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition-all",
            liveTail
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
          )}
        >
          {liveTail ? (
            liveTailConnected ? (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            ) : (
              <WifiOff size={12} className="text-red-500" />
            )
          ) : (
            <Radio size={12} />
          )}
          {liveTail ? (liveTailConnected ? "Live" : "Reconnecting") : "Live tail"}
        </button>

        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition-all hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Export
        </button>
      </div>
    </div>
  );
}
