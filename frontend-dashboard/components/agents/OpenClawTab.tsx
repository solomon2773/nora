import { useState } from "react";
import { MessageSquare, Radio, CalendarClock, Puzzle, MonitorPlay } from "lucide-react";
import StatusPanel from "./openclaw/StatusPanel";
import ChatPanel from "./openclaw/ChatPanel";
import IntegrationsTab from "./IntegrationsTab";
import CronPanel from "./openclaw/CronPanel";
import OpenClawUIPanel from "./openclaw/OpenClawUIPanel";

const subTabs = [
  { id: "status", label: "Status", icon: Radio },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "integrations", label: "Integrations", icon: Puzzle },
  { id: "cron", label: "Cron", icon: CalendarClock },
  { id: "ui", label: "UI", icon: MonitorPlay },
];

export default function OpenClawTab({ agentId, agentStatus }) {
  const [activeSubTab, setActiveSubTab] = useState("status");

  if (agentStatus !== "running" && agentStatus !== "warning") {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-12 flex flex-col items-center justify-center gap-3">
        <Radio size={32} className="text-slate-400" />
        <p className="text-sm text-slate-500 font-medium">
          OpenClaw Gateway available when agent is{" "}
          <span className="text-green-500 font-bold">running</span>
        </p>
        <p className="text-xs text-slate-400">
          Agent is currently <span className="font-bold">{agentStatus}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Sub-tab navigation */}
      <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 p-1 rounded-xl overflow-x-auto scrollbar-hide w-full">
        {subTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap shrink-0 ${
                isActive
                  ? "bg-white text-blue-600 shadow-sm border border-blue-100"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Icon size={12} />
              <span className="hidden xs:inline sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Sub-panel content */}
      <div>
        {activeSubTab === "status" && <StatusPanel agentId={agentId} />}
        {activeSubTab === "chat" && <ChatPanel agentId={agentId} />}
        {activeSubTab === "integrations" && <IntegrationsTab agentId={agentId} />}
        {activeSubTab === "cron" && <CronPanel agentId={agentId} />}
        {activeSubTab === "ui" && <OpenClawUIPanel agentId={agentId} />}
      </div>
    </div>
  );
}
