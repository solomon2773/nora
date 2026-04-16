import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CalendarClock,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Puzzle,
  Radio,
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import IntegrationsTab from "./IntegrationsTab";
import HermesChannelsPanel from "./hermes/ChannelsPanel";
import HermesChatPanel from "./hermes/ChatPanel";
import HermesCronPanel from "./hermes/CronPanel";
import OfficialDashboardPanel from "./hermes/OfficialDashboardPanel";
import HermesStatusPanel from "./hermes/StatusPanel";

const STATUS_POLL_MS = 5000;

const subTabs = [
  { id: "official-dashboard", label: "Official Dashboard", icon: LayoutDashboard },
  { id: "status", label: "Status", icon: Radio },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "integrations", label: "Integrations", icon: Puzzle },
  { id: "cron", label: "Cron", icon: CalendarClock },
  { id: "channels", label: "Channels", icon: MessagesSquare },
];

function HermesIntegrationsPanel({ agentId }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-sky-700">
          Hermes Integrations
        </p>
        <p className="mt-1 text-sm font-bold text-slate-900">
          Integration changes sync through Hermes&apos;s managed runtime env and may restart the
          agent.
        </p>
        <p className="mt-1 text-xs text-slate-600">
          Connect and disconnect actions update Hermes-native configuration. Tool invocation stays
          disabled for Hermes runtimes for now.
        </p>
      </div>
      <IntegrationsTab agentId={agentId} />
    </div>
  );
}

export default function HermesWebUITab({ agentId, agentStatus }) {
  const [activeSubTab, setActiveSubTab] = useState("official-dashboard");
  const [loading, setLoading] = useState(true);
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [error, setError] = useState("");
  const pollRef = useRef(null);
  const cancelledRef = useRef(false);

  function clearStatusPoll() {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }

  async function loadRuntimeInfo({ showSpinner = true } = {}) {
    clearStatusPoll();
    if (showSpinner) {
      setLoading(true);
    }
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load Hermes WebUI");
      }

      if (cancelledRef.current) return;
      setRuntimeInfo(data);

      const dashboardStillBooting =
        data.dashboard?.ready === false && data.dashboard?.retryable !== false;

      if (
        (!data.health?.ok || dashboardStillBooting) &&
        (agentStatus === "running" || agentStatus === "warning")
      ) {
        pollRef.current = window.setTimeout(() => {
          loadRuntimeInfo({ showSpinner: false });
        }, STATUS_POLL_MS);
      }
    } catch (nextError) {
      if (cancelledRef.current) return;
      setError(nextError.message || "Failed to load Hermes WebUI");
      if (agentStatus === "running" || agentStatus === "warning") {
        pollRef.current = window.setTimeout(() => {
          loadRuntimeInfo({ showSpinner: false });
        }, STATUS_POLL_MS);
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    setActiveSubTab("official-dashboard");
  }, [agentId]);

  useEffect(() => {
    cancelledRef.current = false;

    if (agentId && (agentStatus === "running" || agentStatus === "warning")) {
      loadRuntimeInfo();
    } else {
      setLoading(false);
      setRuntimeInfo(null);
      setError("");
      clearStatusPoll();
    }

    return () => {
      cancelledRef.current = true;
      clearStatusPoll();
    };
  }, [agentId, agentStatus]);

  if (agentStatus !== "running" && agentStatus !== "warning") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-12">
        <Bot size={32} className="text-slate-400" />
        <p className="text-sm font-medium text-slate-500">
          Hermes WebUI available when agent is{" "}
          <span className="font-bold text-green-500">running</span>
        </p>
        <p className="text-xs text-slate-400">
          Agent is currently <span className="font-bold">{agentStatus}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="w-full overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1 scrollbar-hide">
        <div className="flex items-center gap-1">
          {subTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveSubTab(tab.id)}
                className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all sm:px-3 ${
                  isActive
                    ? "border border-blue-100 bg-white text-blue-600 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Icon size={12} />
                  <span className="hidden xs:inline sm:inline">{tab.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        {activeSubTab === "official-dashboard" && (
          <OfficialDashboardPanel
            agentId={agentId}
            runtimeInfo={runtimeInfo}
            loadingRuntime={loading}
            runtimeError={error}
            onRefreshRuntime={() => loadRuntimeInfo({ showSpinner: false })}
          />
        )}
        {activeSubTab === "status" && (
          <HermesStatusPanel
            agentId={agentId}
            runtimeInfo={runtimeInfo}
            loading={loading}
            error={error}
            onRefresh={() => loadRuntimeInfo({ showSpinner: false })}
          />
        )}
        {activeSubTab === "chat" && (
          <HermesChatPanel
            agentId={agentId}
            runtimeInfo={runtimeInfo}
            loadingRuntime={loading}
            runtimeError={error}
            onRefreshRuntime={() => loadRuntimeInfo({ showSpinner: false })}
          />
        )}
        {activeSubTab === "integrations" && <HermesIntegrationsPanel agentId={agentId} />}
        {activeSubTab === "cron" && <HermesCronPanel agentId={agentId} />}
        {activeSubTab === "channels" && <HermesChannelsPanel agentId={agentId} />}
      </div>
    </div>
  );
}
