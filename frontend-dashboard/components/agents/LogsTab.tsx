import LogViewer from "../LogViewer";

export default function LogsTab({ agentId }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-600">Live Log Stream</h3>
        <span className="text-[10px] text-slate-400 font-medium">Auto-scrolling enabled</span>
      </div>
      <LogViewer agentId={agentId} />
    </div>
  );
}
