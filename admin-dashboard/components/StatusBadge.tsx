import { clsx } from "clsx";

const LABELS = {
  running: "Running",
  stopped: "Stopped",
  deploying: "Deploying",
  queued: "Queued",
  error: "Error",
  warning: "Warning",
  active: "Active",
  inactive: "Inactive",
  enabled: "Enabled",
  disabled: "Disabled",
};

const STYLES = {
  running: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  stopped: "bg-slate-100 text-slate-600 ring-slate-200",
  deploying: "bg-amber-50 text-amber-700 ring-amber-200",
  queued: "bg-blue-50 text-blue-700 ring-blue-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  warning: "bg-orange-50 text-orange-700 ring-orange-200",
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  inactive: "bg-slate-100 text-slate-600 ring-slate-200",
  enabled: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  disabled: "bg-slate-100 text-slate-600 ring-slate-200",
};

const DOTS = {
  running: "bg-emerald-500",
  stopped: "bg-slate-400",
  deploying: "bg-amber-500",
  queued: "bg-blue-500",
  error: "bg-red-500",
  warning: "bg-orange-500",
  active: "bg-emerald-500",
  inactive: "bg-slate-400",
  enabled: "bg-emerald-500",
  disabled: "bg-slate-400",
};

export default function StatusBadge({ status, className = "" }) {
  const key = status || "stopped";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset",
        STYLES[key] || STYLES.stopped,
        className
      )}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          DOTS[key] || DOTS.stopped
        )}
      />
      {LABELS[key] || String(status || "unknown")}
    </span>
  );
}
