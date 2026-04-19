import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck, Globe, Brain, RefreshCw, Loader2, Plus, Trash2,
  CheckCircle2, XCircle, Clock, AlertTriangle, Shield, Wifi,
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";

function PolicyRow({ rule, onRemove }) {
  return (
    <div className="flex items-center justify-between py-3 px-4 bg-slate-50 rounded-xl border border-slate-100">
      <div className="flex items-center gap-3 min-w-0">
        <Globe size={14} className="text-blue-500 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-800 truncate">{rule.name}</p>
          <p className="text-[10px] text-slate-400 truncate">
            {(rule.endpoints || []).join(", ")} &bull; {(rule.methods || ["*"]).join(", ")}
          </p>
        </div>
      </div>
      {!rule.builtin && onRemove && (
        <button
          onClick={() => onRemove(rule.name)}
          className="text-red-400 hover:text-red-600 transition-colors shrink-0 ml-2"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function ApprovalRow({ approval, onDecide }) {
  const [deciding, setDeciding] = useState(false);

  async function handleDecision(action) {
    setDeciding(true);
    await onDecide(approval.id, action);
    setDeciding(false);
  }

  return (
    <div className="flex items-center justify-between py-3 px-4 bg-yellow-50 rounded-xl border border-yellow-100">
      <div className="flex items-center gap-3 min-w-0">
        <AlertTriangle size={14} className="text-yellow-500 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-800 truncate">{approval.endpoint || "Unknown endpoint"}</p>
          <p className="text-[10px] text-slate-400">
            Requested {approval.requestedAt ? new Date(approval.requestedAt).toLocaleString() : "recently"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        <button
          onClick={() => handleDecision("approve")}
          disabled={deciding}
          className="flex items-center gap-1 px-3 py-1.5 bg-green-100 text-green-700 hover:bg-green-200 text-[10px] font-bold rounded-lg transition-all disabled:opacity-50"
        >
          {deciding ? <Loader2 size={10} className="animate-spin" /> : <CheckCircle2 size={10} />}
          Approve
        </button>
        <button
          onClick={() => handleDecision("deny")}
          disabled={deciding}
          className="flex items-center gap-1 px-3 py-1.5 bg-red-100 text-red-700 hover:bg-red-200 text-[10px] font-bold rounded-lg transition-all disabled:opacity-50"
        >
          {deciding ? <Loader2 size={10} className="animate-spin" /> : <XCircle size={10} />}
          Deny
        </button>
      </div>
    </div>
  );
}

export default function NemoClawTab({ agentId, agentStatus }) {
  const [status, setStatus] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newEndpoint, setNewEndpoint] = useState("");
  const [newName, setNewName] = useState("");

  const fetchAll = useCallback(async () => {
    if (agentStatus !== "running") { setLoading(false); return; }
    try {
      const [sRes, pRes, aRes] = await Promise.all([
        fetchWithAuth(`/api/agents/${agentId}/nemoclaw/status`),
        fetchWithAuth(`/api/agents/${agentId}/nemoclaw/policy`),
        fetchWithAuth(`/api/agents/${agentId}/nemoclaw/approvals`),
      ]);
      if (sRes.ok) setStatus(await sRes.json());
      if (pRes.ok) setPolicy(await pRes.json());
      if (aRes.ok) {
        const data = await aRes.json();
        setApprovals(data.approvals || []);
      }
    } catch (e) {
      console.error("NemoClaw fetch error:", e);
    }
    setLoading(false);
  }, [agentId, agentStatus]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Poll approvals while running
  useEffect(() => {
    if (agentStatus !== "running") return;
    const iv = setInterval(async () => {
      try {
        const r = await fetchWithAuth(`/api/agents/${agentId}/nemoclaw/approvals`);
        if (r.ok) { const d = await r.json(); setApprovals(d.approvals || []); }
      } catch { /* ignore */ }
    }, 10000);
    return () => clearInterval(iv);
  }, [agentId, agentStatus]);

  async function addRule() {
    if (!newEndpoint.trim() || !newName.trim() || !policy) return;
    const updated = { ...policy };
    if (!updated.network) updated.network = { rules: [] };
    if (!updated.network.rules) updated.network.rules = [];
    updated.network.rules.push({
      name: newName.trim(),
      endpoints: [newEndpoint.trim()],
      methods: ["*"],
    });
    const res = await fetchWithAuth(`/api/agents/${agentId}/nemoclaw/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    if (res.ok) {
      setPolicy(updated);
      setNewEndpoint("");
      setNewName("");
    }
  }

  async function removeRule(name) {
    if (!policy?.network?.rules) return;
    const updated = {
      ...policy,
      network: {
        ...policy.network,
        rules: policy.network.rules.filter((r) => r.name !== name),
      },
    };
    const res = await fetchWithAuth(`/api/agents/${agentId}/nemoclaw/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    if (res.ok) setPolicy(updated);
  }

  async function handleApprovalDecision(rid, action) {
    const res = await fetchWithAuth(`/api/agents/${agentId}/nemoclaw/approvals/${rid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      setApprovals((prev) => prev.filter((a) => a.id !== rid));
      if (action === "approve") fetchAll(); // Refresh policy to show new rule
    }
  }

  if (agentStatus !== "running") {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-12 flex flex-col items-center justify-center gap-3">
        <ShieldCheck size={32} className="text-slate-300" />
        <p className="text-sm text-slate-500 font-medium">
          NemoClaw controls available when agent is <span className="text-green-500 font-bold">running</span>
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-green-500" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <div className="flex items-center justify-between bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center">
            <ShieldCheck size={20} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">NemoClaw Secure Sandbox</p>
            <div className="flex items-center gap-3 mt-0.5 text-[10px] text-slate-500 font-medium">
              {status?.model && <span className="flex items-center gap-1"><Brain size={10} /> {status.model.replace("nvidia/", "")}</span>}
              {status?.inferenceConfigured && <span className="flex items-center gap-1 text-green-600"><Wifi size={10} /> Inference connected</span>}
              {status?.policyActive && <span className="flex items-center gap-1 text-green-600"><Shield size={10} /> Policy active</span>}
              {status?.uptime != null && <span className="flex items-center gap-1"><Clock size={10} /> {Math.floor(status.uptime / 60)}m uptime</span>}
            </div>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); fetchAll(); }}
          className="text-green-600 hover:text-green-800 transition-colors"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Pending Approvals */}
      {approvals.length > 0 && (
        <section className="bg-white border border-yellow-200 rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <AlertTriangle size={16} className="text-yellow-500" />
            Pending Approvals
            <span className="ml-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-yellow-100 text-yellow-700">
              {approvals.length}
            </span>
          </h3>
          <div className="space-y-2">
            {approvals.map((a) => (
              <ApprovalRow key={a.id} approval={a} onDecide={handleApprovalDecision} />
            ))}
          </div>
        </section>
      )}

      {/* Network Policy */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <Globe size={16} className="text-blue-600" />
          Network Policy Rules
        </h3>

        {policy?.network?.rules?.length > 0 ? (
          <div className="space-y-2">
            {policy.network.rules.map((rule, i) => (
              <PolicyRow key={rule.name || i} rule={rule} onRemove={removeRule} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400 italic">No network policy rules. All egress is blocked by default.</p>
        )}

        {/* Add rule */}
        <div className="flex items-end gap-2 pt-2 border-t border-slate-100">
          <div className="flex-1">
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Rule Name</label>
            <input
              className="w-full mt-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-green-500/30"
              placeholder="e.g. my_api"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="flex-[2]">
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Endpoint</label>
            <input
              className="w-full mt-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium outline-none focus:ring-1 focus:ring-green-500/30"
              placeholder="e.g. api.example.com:443"
              value={newEndpoint}
              onChange={(e) => setNewEndpoint(e.target.value)}
            />
          </div>
          <button
            onClick={addRule}
            disabled={!newName.trim() || !newEndpoint.trim()}
            className="flex items-center gap-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg transition-all disabled:opacity-50 shrink-0"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </section>

      {/* Security Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Capabilities", value: "Dropped", icon: ShieldCheck, color: "text-green-600", bg: "bg-green-50 border-green-100" },
          { label: "Network", value: "Deny-default", icon: Shield, color: "text-green-600", bg: "bg-green-50 border-green-100" },
          { label: "Filesystem", value: "Restricted", icon: ShieldCheck, color: "text-green-600", bg: "bg-green-50 border-green-100" },
          { label: "Bridge", value: "Disabled", icon: Shield, color: "text-green-600", bg: "bg-green-50 border-green-100" },
        ].map((item) => (
          <div key={item.label} className={`${item.bg} border rounded-2xl p-4`}>
            <div className="flex items-center gap-1.5 mb-1">
              <item.icon size={12} className={item.color} />
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">{item.label}</span>
            </div>
            <p className="text-sm font-bold text-slate-900">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
