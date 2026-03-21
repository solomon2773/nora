import { Activity, Terminal, ScrollText, Zap, Settings, ShieldCheck, BarChart3 } from "lucide-react";

const baseTabs = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "metrics", label: "Metrics", icon: BarChart3 },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "openclaw", label: "OpenClaw", icon: Zap },
  { id: "nemoclaw", label: "NemoClaw", icon: ShieldCheck, needsNemoClaw: true },
  { id: "settings", label: "Settings", icon: Settings },
];

export default function TabBar({ activeTab, onTabChange, badges = {}, sandboxType }) {
  return (
    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl overflow-x-auto scrollbar-hide w-full">
      {baseTabs.filter((t) => !t.needsNemoClaw || sandboxType === "nemoclaw").map((tab) => {
        const Icon = tab.icon;
        const badge = badges[tab.id];
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap shrink-0 ${
              isActive
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Icon size={14} />
            <span className="hidden sm:inline">{tab.label}</span>
            {badge > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-100 text-blue-700">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
