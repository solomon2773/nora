import { useState, useEffect } from "react";
import {
  Bot, Cpu, MemoryStick, HardDrive, Globe, Clock, Activity, Power, RefreshCw, Loader2, Zap, Radio, ShieldCheck, Brain,
  AlertTriangle, XCircle, AlertOctagon
} from "lucide-react";
import StatusBadge from "./StatusBadge";
import { fetchWithAuth } from "../../lib/api";

export default function OverviewTab({ agent, actionLoading, onStart, onStop, onRestart, onRedeploy }) {
  const [lastError, setLastError] = useState(null);

  // Fetch last error event when agent is in error state
  useEffect(() => {
    if (agent.status !== "error") { setLastError(null); return; }
    fetchWithAuth(`/api/monitoring/events?agentId=${agent.id}&limit=1`)
      .then(r => r.ok ? r.json() : [])
      .then(events => setLastError(events[0]?.message || null))
      .catch(() => {});
  }, [agent.status, agent.id]);

  const isStaleQueued = agent.status === "queued" && agent.created_at &&
    (Date.now() - new Date(agent.created_at).getTime()) > 5 * 60 * 1000;

  return (
    <div className="space-y-6">
      {/* Status Banners */}
      {isStaleQueued && (
        <div className="flex items-center gap-3 bg-yellow-50 border border-yellow-200 rounded-2xl px-5 py-3">
          <AlertTriangle size={18} className="text-yellow-600 shrink-0" />
          <div>
            <p className="text-sm font-bold text-yellow-800">Deployment is taking longer than expected</p>
            <p className="text-xs text-yellow-600">The system will retry automatically. Check the Logs tab for details.</p>
          </div>
        </div>
      )}

      {agent.status === "queued" && !isStaleQueued && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-2xl px-5 py-3">
          <Loader2 size={18} className="text-blue-600 animate-spin shrink-0" />
          <div>
            <p className="text-sm font-bold text-blue-800">Deploying agent...</p>
            <p className="text-xs text-blue-600">Your agent is being provisioned. This usually takes 30-60 seconds.</p>
          </div>
        </div>
      )}

      {agent.status === "error" && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-2xl px-5 py-3">
          <XCircle size={18} className="text-red-600 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-bold text-red-800">Deployment failed</p>
            <p className="text-xs text-red-600">{lastError || "An error occurred during provisioning."}</p>
          </div>
          <button
            onClick={onRedeploy}
            disabled={!!actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 shrink-0"
          >
            {actionLoading === "redeploy" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Redeploy
          </button>
        </div>
      )}

      {agent.status === "warning" && (
        <div className="flex items-center gap-3 bg-orange-50 border border-orange-200 rounded-2xl px-5 py-3">
          <AlertOctagon size={18} className="text-orange-600 shrink-0" />
          <div>
            <p className="text-sm font-bold text-orange-800">Gateway health check failed</p>
            <p className="text-xs text-orange-600">Agent deployed but the gateway is not responding. It may still be starting up.</p>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex items-center gap-3 flex-wrap">
        {agent.status === "running" && (
          <>
            <button
              onClick={onStop}
              disabled={!!actionLoading}
              className="flex items-center gap-2 px-4 py-2.5 bg-yellow-50 border border-yellow-200 text-yellow-700 hover:bg-yellow-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
            >
              {actionLoading === "stop" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
              Stop Agent
            </button>
            <button
              onClick={onRestart}
              disabled={!!actionLoading}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
            >
              {actionLoading === "restart" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Restart
            </button>
          </>
        )}
        {agent.status === "stopped" && (
          <button
            onClick={onStart}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            {actionLoading === "start" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            Start Agent
          </button>
        )}
        {(agent.status === "error" || agent.status === "stopped") && (
          <button
            onClick={onRedeploy}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-purple-50 border border-purple-200 text-purple-700 hover:bg-purple-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            {actionLoading === "redeploy" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Redeploy
          </button>
        )}
      </div>

      {/* Gateway Badge */}
      {agent.status === "running" && (
        <div className="flex items-center gap-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl px-5 py-3">
          <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
            <Zap size={16} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">OpenClaw Gateway Active</p>
            <p className="text-[10px] text-slate-500">
              Port 18789 &bull; Chat, Sessions, Cron, Tools available in the OpenClaw tab
            </p>
          </div>
          <Radio size={14} className="ml-auto text-green-500 animate-pulse" />
        </div>
      )}

      {/* NemoClaw Sandbox Badge */}
      {agent.sandbox_type === "nemoclaw" && agent.status === "running" && (
        <div className="flex items-center gap-3 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl px-5 py-3">
          <div className="w-8 h-8 bg-green-600 rounded-xl flex items-center justify-center">
            <ShieldCheck size={16} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">NemoClaw Secure Sandbox</p>
            <p className="text-[10px] text-slate-500">
              NVIDIA Nemotron inference &bull; Deny-by-default network &bull; Capability-restricted
            </p>
          </div>
          <Brain size={14} className="ml-auto text-green-500" />
        </div>
      )}

      {/* Resource Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        {[
          { label: "vCPU", value: agent.vcpu || "2", icon: Cpu, color: "text-blue-600" },
          { label: "RAM", value: `${agent.ram_mb ? agent.ram_mb / 1024 : 2} GB`, icon: MemoryStick, color: "text-emerald-600" },
          { label: "Disk", value: `${agent.disk_gb || 20} GB`, icon: HardDrive, color: "text-purple-600" },
          { label: "Host", value: agent.host || "—", icon: Globe, color: "text-orange-600" },
        ].map((item) => (
          <div key={item.label} className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <item.icon size={16} className={item.color} />
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">{item.label}</span>
            </div>
            <p className="text-lg font-black text-slate-900">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Details */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Activity size={18} className="text-blue-600" />
          Details
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Status</label>
            <div className="mt-1"><StatusBadge status={agent.status} /></div>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Deploy Mode</label>
            <p className="text-sm text-slate-900 mt-1">{agent.sandbox_type === "nemoclaw" ? "NemoClaw + OpenClaw" : "OpenClaw + Docker"}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Container Name</label>
            <p className="text-sm text-slate-900 mt-1 font-mono break-all">{agent.container_name || "—"}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Container ID</label>
            <p className="text-sm text-slate-900 mt-1 font-mono break-all">{agent.container_id || "—"}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Image</label>
            <p className="text-sm text-slate-900 mt-1">{agent.image || "node:22-slim"}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Created</label>
            <p className="text-sm text-slate-900 mt-1">
              {agent.created_at ? new Date(agent.created_at).toLocaleString() : "—"}
            </p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Node</label>
            <p className="text-sm text-slate-900 mt-1">{agent.node || "—"}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
