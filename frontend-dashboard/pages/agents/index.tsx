import Layout from "../../components/layout/Layout";
import {
  ArrowRight,
  Bot,
  Loader2,
  ListChecks,
  Plus,
  Power,
  RotateCcw,
  Search,
  Terminal,
} from "lucide-react";
import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";
import StatusBadge from "../../components/agents/StatusBadge";
import {
  formatExecutionTargetLabel,
  formatRuntimeFamilyLabel,
  formatRuntimePathLabel,
  formatSandboxProfileLabel,
  resolveAgentExecutionTarget,
  resolveAgentSandboxProfile,
} from "../../lib/runtime";

function formatResourceSummary(agent) {
  const cpu = Number.parseFloat(agent?.vcpu);
  const ramMb = Number.parseInt(agent?.ram_mb, 10);
  const diskGb = Number.parseInt(agent?.disk_gb, 10);
  const parts = [];

  if (Number.isFinite(cpu) && cpu > 0) {
    parts.push(`${Number.isInteger(cpu) ? cpu.toFixed(0) : cpu.toFixed(1)} vCPU`);
  }

  if (Number.isFinite(ramMb) && ramMb > 0) {
    if (ramMb >= 1024) {
      const ramGb = ramMb / 1024;
      parts.push(`${Number.isInteger(ramGb) ? ramGb.toFixed(0) : ramGb.toFixed(1)} GB RAM`);
    } else {
      parts.push(`${ramMb} MB RAM`);
    }
  }

  if (Number.isFinite(diskGb) && diskGb > 0) {
    parts.push(`${diskGb} GB disk`);
  }

  return parts.join(" · ") || "Not configured";
}

function formatPlacement(agent) {
  const parts = [agent?.node, agent?.runtime_host, agent?.host]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return [...new Set(parts)].join(" · ") || "Local host";
}

function agentTone(status) {
  switch (status) {
    case "running":
      return "bg-emerald-50 text-emerald-600 shadow-emerald-500/10";
    case "deploying":
      return "bg-amber-50 text-amber-600 shadow-amber-500/10";
    case "warning":
      return "bg-amber-50 text-amber-600 shadow-amber-500/10";
    case "error":
      return "bg-red-50 text-red-600 shadow-red-500/10";
    case "stopped":
      return "bg-slate-100 text-slate-600 shadow-slate-400/10";
    default:
      return "bg-blue-50 text-blue-600 shadow-blue-500/10";
  }
}

function FleetInfoCard({ label, value, mono = false }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 min-w-0">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none opacity-80">
        {label}
      </p>
      <p
        className={clsx(
          "mt-2 text-sm font-bold text-slate-900 min-w-0",
          mono ? "font-mono text-[11px] break-all" : "leading-5"
        )}
      >
        {value}
      </p>
    </div>
  );
}

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const toast = useToast();

  const loadAgents = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to load agents");
    }
    setLoading(false);
  };

  useEffect(() => {
    loadAgents();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchWithAuth("/api/agents")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(setAgents)
        .catch(() => {});
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAgents();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const handleAction = async (id, action) => {
    try {
      const res = await fetchWithAuth(`/api/agents/${id}/${action}`, { method: "POST" });
      if (res.ok) loadAgents();
    } catch (err) {
      console.error(err);
      toast.error(`Failed to ${action} agent`);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const filteredAgents = agents.filter((agent) => agent.name.toLowerCase().includes(normalizedSearch));
  const hasAgents = agents.length > 0;
  const hasSearch = normalizedSearch.length > 0;
  const showSearchEmpty = !loading && hasAgents && filteredAgents.length === 0;
  const showFleetEmpty = !loading && !hasAgents;

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 relative p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
          <div className="flex flex-col gap-2 relative z-10">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
                <Bot size={28} strokeWidth={2.5} />
              </div>
              <div className="flex flex-col">
                <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">Fleet Management</h1>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">Nora Control Plane</span>
                  <div className="w-1 h-1 bg-slate-300 rounded-full"></div>
                  <span className="text-xs font-bold text-blue-600 leading-none">{agents.length} Agent{agents.length === 1 ? "" : "s"} Configured</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className="relative group flex-1 md:flex-initial">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                className="pl-12 pr-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none w-full md:w-72"
                placeholder="Filter agents by name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => (window.location.href = "/app/deploy")}
              className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 transition-all text-sm font-bold text-white px-8 py-4 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95"
            >
              <Plus size={18} />
              New Agent
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
          {loading ? (
            <div className="col-span-full h-96 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white border border-slate-200 rounded-[3rem] border-dashed">
              <Loader2 size={40} className="animate-spin text-blue-500" />
              <span className="text-sm font-bold uppercase tracking-widest leading-none">Loading Agents...</span>
            </div>
          ) : showFleetEmpty ? (
            <EmptyFleetState />
          ) : showSearchEmpty ? (
            <SearchEmptyState search={search} onClear={() => setSearch("")} />
          ) : (
            filteredAgents.map((agent) => <AgentCard key={agent.id} agent={agent} onAction={handleAction} />)
          )}
        </div>

        {!loading && hasAgents && hasSearch && filteredAgents.length > 0 && (
          <div className="text-sm text-slate-500">
            Showing <span className="font-bold text-slate-900">{filteredAgents.length}</span> of <span className="font-bold text-slate-900">{agents.length}</span> agents.
          </div>
        )}
      </div>
    </Layout>
  );
}

function EmptyFleetState() {
  return (
    <div className="col-span-full bg-white border border-slate-200 rounded-[3rem] p-8 sm:p-12 lg:p-14 shadow-sm">
      <div className="text-center max-w-2xl mx-auto space-y-3">
        <div className="w-16 h-16 rounded-3xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
          <Bot size={30} />
        </div>
        <h3 className="text-2xl font-black text-slate-900">No agents deployed yet</h3>
        <p className="text-sm sm:text-base text-slate-500 leading-relaxed">
          The clearest first-run path is: add one provider in Settings, deploy one OpenClaw agent, then validate chat, logs, and terminal from the agent detail page.
        </p>
      </div>

      <div className="mt-8 bg-blue-50 border border-blue-100 rounded-3xl p-6 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <p className="text-sm font-black text-blue-700 uppercase tracking-widest mb-1">Recommended order</p>
          <p className="text-sm text-blue-700/80">Settings → Deploy → Validate. That is the fastest path to a live runtime.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href="/app/settings" className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-bold hover:bg-blue-50 transition-all">
            <ArrowRight size={15} />
            Open Settings
          </a>
          <a href="/app/getting-started" className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-bold hover:bg-blue-50 transition-all">
            <ListChecks size={15} />
            Open activation guide
          </a>
          <a href="/app/deploy" className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold transition-all">
            Deploy First Agent
          </a>
        </div>
      </div>
    </div>
  );
}

function SearchEmptyState({ search, onClear }) {
  return (
    <div className="col-span-full bg-white border border-slate-200 rounded-[3rem] p-10 sm:p-12 text-center shadow-sm">
      <div className="w-16 h-16 rounded-3xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto mb-4">
        <Search size={28} />
      </div>
      <h3 className="text-2xl font-black text-slate-900">No agents match “{search}”</h3>
      <p className="text-sm sm:text-base text-slate-500 leading-relaxed mt-3 max-w-xl mx-auto">
        Clear the filter to see the full fleet, or deploy a new agent if you were expecting a fresh runtime to appear here.
      </p>
      <div className="mt-6 flex items-center justify-center gap-3 flex-wrap">
        <button onClick={onClear} className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-sm font-bold transition-all">
          <RotateCcw size={15} />
          Clear filter
        </button>
        <a href="/app/deploy" className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold transition-all">
          <Plus size={15} />
          Deploy Agent
        </a>
      </div>
    </div>
  );
}

function AgentCard({ agent, onAction }) {
  const isActive = agent.status === "running" || agent.status === "warning";
  const powerAction = isActive ? "stop" : "start";
  const powerDisabled = !isActive && !agent.container_id;
  const runtimePathLabel = formatRuntimePathLabel(agent);
  const runtimeFamilyLabel = formatRuntimeFamilyLabel(agent.runtime_family);
  const executionTargetLabel = formatExecutionTargetLabel(
    resolveAgentExecutionTarget(agent)
  );
  const sandboxLabel = formatSandboxProfileLabel(resolveAgentSandboxProfile(agent));
  const placementLabel = formatPlacement(agent);
  const resourceSummary = formatResourceSummary(agent);
  const containerLabel = agent.container_name || agent.container_id || "Pending container assignment";
  const isTransient = agent.status === "queued" || agent.status === "deploying";

  return (
    <div className="group bg-white border border-slate-200 rounded-[2.5rem] shadow-sm hover:shadow-2xl hover:shadow-blue-500/10 hover:border-blue-500/20 transition-all duration-500 overflow-hidden flex flex-col p-1">
      <div className="p-8 pb-4 flex items-start justify-between">
        <a href={`/app/agents/${agent.id}`} className="flex items-start gap-4 cursor-pointer">
          <div
            className={clsx(
              "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg",
              agentTone(agent.status)
            )}
          >
            {isTransient ? <Loader2 size={24} className="animate-spin" /> : <Bot size={24} />}
          </div>
          <div className="flex flex-col">
            <h3 className="text-lg font-black text-slate-900 leading-tight mb-1 hover:text-blue-600 transition-colors">{agent.name}</h3>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest leading-none opacity-80">
                Agent {String(agent.id || "").slice(0, 8)}
              </span>
            </div>
          </div>
        </a>
      </div>

      <div className="px-8 py-6 space-y-4">
        <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-4">
          <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest leading-none opacity-80">
            Runtime Path
          </p>
          <p className="mt-2 text-base font-black text-slate-900">{runtimePathLabel}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-[11px] font-bold text-slate-700 border border-blue-100">
              {runtimeFamilyLabel}
            </span>
            <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-[11px] font-bold text-slate-700 border border-blue-100">
              {executionTargetLabel}
            </span>
            <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-[11px] font-bold text-slate-700 border border-blue-100">
              {sandboxLabel}
            </span>
          </div>
        </div>

        <FleetInfoCard label="Container" value={containerLabel} mono />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FleetInfoCard label="Placement" value={placementLabel} />
          <FleetInfoCard label="Resources" value={resourceSummary} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none opacity-80">
            Execution Status
          </span>
          <StatusBadge status={agent.status} />
        </div>
      </div>

      <div className="mt-auto p-4 flex items-center gap-2 border-t border-slate-50">
        <a href={`/app/agents/${agent.id}`} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-900 transition-all shadow-sm">
          <Terminal size={14} className="text-slate-400" />
          Open Validation View
        </a>
        <button
          onClick={() => onAction(agent.id, powerAction)}
          disabled={powerDisabled}
          className={clsx(
            "w-12 h-12 flex items-center justify-center border rounded-2xl transition-all shadow-sm",
            powerDisabled
              ? "bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed"
              : isActive
                ? "bg-red-50 border-red-100 text-red-500 hover:bg-red-100"
                : "bg-emerald-50 border-emerald-100 text-emerald-500 hover:bg-emerald-100"
          )}
          title={
            powerDisabled
              ? "Start is unavailable until a container has been provisioned"
              : isActive
                ? "Stop agent"
                : "Start agent"
          }
        >
          <Power size={18} />
        </button>
      </div>
    </div>
  );
}
