export default function StatusBadge({ status }) {
  const colors = {
    running: "bg-green-100 text-green-700",
    stopped: "bg-slate-100 text-slate-500",
    deploying: "bg-yellow-100 text-yellow-700",
    queued: "bg-blue-100 text-blue-700",
    error: "bg-red-100 text-red-700",
    warning: "bg-orange-100 text-orange-700",
    active: "bg-green-100 text-green-700",
    inactive: "bg-slate-100 text-slate-500",
    connected: "bg-green-100 text-green-700",
    disconnected: "bg-red-100 text-red-700",
    enabled: "bg-green-100 text-green-700",
    disabled: "bg-slate-100 text-slate-500",
  };

  const dotColors = {
    running: "bg-green-500",
    stopped: "bg-slate-400",
    deploying: "bg-yellow-500",
    queued: "bg-blue-500",
    error: "bg-red-500",
    warning: "bg-orange-500",
    active: "bg-green-500",
    inactive: "bg-slate-400",
    connected: "bg-green-500",
    disconnected: "bg-red-500",
    enabled: "bg-green-500",
    disabled: "bg-slate-400",
  };

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full ${colors[status] || colors.stopped}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status] || dotColors.stopped}`} />
      {status}
    </span>
  );
}
