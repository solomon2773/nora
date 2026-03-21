import { useState, useEffect } from "react";
import { fetchWithAuth } from "../../../lib/api";
import { Radio, RefreshCw, CheckCircle, XCircle, Loader2, Key, ChevronDown, Settings, Plus } from "lucide-react";
import { useToast } from "../../Toast";

export default function StatusPanel({ agentId }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [providers, setProviders] = useState(null); // null=loading
  const [changingModel, setChangingModel] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const toast = useToast();

  async function fetchStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/status`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err.message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  // Fetch LLM providers for model picker
  useEffect(() => {
    fetchWithAuth("/api/llm-providers")
      .then((r) => r.json())
      .then((data) => setProviders(Array.isArray(data) ? data : []))
      .catch(() => setProviders([]));
  }, []);

  // Fetch available models catalog
  const [availableProviders, setAvailableProviders] = useState([]);
  useEffect(() => {
    fetchWithAuth("/api/llm-providers/available")
      .then((r) => r.json())
      .then((data) => setAvailableProviders(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [agentId]);

  async function handleSyncKeys() {
    setSyncing(true);
    try {
      const res = await fetchWithAuth("/api/llm-providers/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const data = await res.json();
      if (res.ok && data.synced > 0) {
        toast.success("LLM keys & model synced to agent");
        setTimeout(fetchStatus, 3000); // refresh status after sync
      } else if (res.ok) {
        toast.error("Sync completed but no agents were updated");
      } else {
        toast.error(data.error || "Sync failed");
      }
    } catch {
      toast.error("Failed to sync keys");
    }
    setSyncing(false);
  }

  async function handleChangeModel(providerId, modelId) {
    setChangingModel(true);
    setShowModelPicker(false);
    try {
      // Set as default and sync
      const provider = providers?.find(p => p.provider === providerId);
      if (provider) {
        await fetchWithAuth(`/api/llm-providers/${provider.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, is_default: true }),
        });
      }
      // Sync to agent
      const res = await fetchWithAuth("/api/llm-providers/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (res.ok) {
        toast.success(`Model changed to ${providerId}/${modelId}`);
        setTimeout(fetchStatus, 3000);
      }
    } catch {
      toast.error("Failed to change model");
    }
    setChangingModel(false);
  }

  // Build a flat list of all available models from configured providers
  const configuredProviderIds = new Set((providers || []).map(p => p.provider));
  const modelOptions = availableProviders
    .filter(p => configuredProviderIds.has(p.id))
    .flatMap(p => (p.models || []).map(m => ({ provider: p.id, providerName: p.name, model: m })));

  const hasProviders = providers && providers.length > 0;

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-blue-500" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Radio size={14} />
          Gateway Status
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSyncKeys}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 text-[11px] font-bold rounded-lg transition-all disabled:opacity-50"
          >
            {syncing ? <Loader2 size={11} className="animate-spin" /> : <Key size={11} />}
            Sync LLM Keys
          </button>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="text-xs text-slate-500 hover:text-blue-600 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* No LLM provider banner */}
      {hasProviders === false && providers !== null && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <Key size={16} className="text-amber-500 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-bold text-amber-700">No LLM provider configured</p>
            <p className="text-xs text-amber-600 mt-1">
              Add an API key (Anthropic, OpenAI, etc.) to enable chat and autonomous capabilities.
            </p>
          </div>
          <a
            href="/settings"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-[11px] font-bold rounded-lg hover:bg-amber-700 transition-colors shrink-0"
          >
            <Plus size={11} />
            Add Provider
          </a>
        </div>
      )}

      {error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <XCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-bold text-red-700">Gateway Unreachable</p>
            <p className="text-xs text-red-500 mt-1">{error}</p>
            <p className="text-xs text-red-400 mt-2">
              The gateway may still be starting up. Try refreshing in a few seconds.
            </p>
          </div>
        </div>
      ) : status ? (() => {
        const h = status.health || {};
        const s = status.status || {};
        const version = s.runtimeVersion || h.server?.version || "";
        const sessionCount = s.sessions?.count ?? h.sessions?.count ?? h.agents?.[0]?.sessions?.count;
        const defaultAgent = h.defaultAgentId || s.heartbeat?.defaultAgentId || "main";
        const heartbeatEvery = s.heartbeat?.agents?.[0]?.every || h.heartbeatSeconds ? `${h.heartbeatSeconds}s` : null;
        const currentModel = s.sessions?.defaults?.model || h.agents?.[0]?.model || "";

        return (
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-xs text-slate-500 font-medium">Status</span>
              <span className={`flex items-center gap-1.5 text-xs font-bold ${h.ok ? "text-green-600" : "text-yellow-600"}`}>
                {h.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                {h.ok ? "Online" : "Degraded"}
              </span>
            </div>
            {version && (
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-xs text-slate-500 font-medium">Version</span>
                <span className="text-xs font-mono text-slate-700">{version}</span>
              </div>
            )}
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-xs text-slate-500 font-medium">Default Agent</span>
              <span className="text-xs font-mono text-slate-700">{defaultAgent}</span>
            </div>
            {sessionCount !== undefined && (
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-xs text-slate-500 font-medium">Sessions</span>
                <span className="text-xs font-bold text-slate-700">{sessionCount}</span>
              </div>
            )}
            {heartbeatEvery && (
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-xs text-slate-500 font-medium">Heartbeat</span>
                <span className="text-xs font-mono text-slate-700">{heartbeatEvery}</span>
              </div>
            )}

            {/* Default Model — with inline picker */}
            <div className="flex items-center justify-between px-4 py-3 relative">
              <span className="text-xs text-slate-500 font-medium">Default Model</span>
              {currentModel ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono text-slate-700">{currentModel}</span>
                  {modelOptions.length > 0 && (
                    <button
                      onClick={() => setShowModelPicker(!showModelPicker)}
                      disabled={changingModel}
                      className="text-blue-500 hover:text-blue-700 transition-colors"
                    >
                      {changingModel ? <Loader2 size={11} className="animate-spin" /> : <ChevronDown size={11} />}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => modelOptions.length > 0 ? setShowModelPicker(!showModelPicker) : null}
                  className="text-xs text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 transition-colors"
                >
                  {modelOptions.length > 0 ? (
                    <>Select model <ChevronDown size={10} /></>
                  ) : (
                    <a href="/settings" className="flex items-center gap-1">
                      <Settings size={10} /> Add LLM provider first
                    </a>
                  )}
                </button>
              )}

              {/* Model dropdown */}
              {showModelPicker && modelOptions.length > 0 && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[240px] max-h-64 overflow-y-auto">
                  {modelOptions.map((opt) => (
                    <button
                      key={`${opt.provider}/${opt.model}`}
                      onClick={() => handleChangeModel(opt.provider, opt.model)}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-blue-50 transition-colors flex items-center justify-between gap-2 ${
                        currentModel === `${opt.provider}/${opt.model}` ? "bg-blue-50 text-blue-700 font-bold" : "text-slate-700"
                      }`}
                    >
                      <span className="font-mono">{opt.provider}/{opt.model}</span>
                      {currentModel === `${opt.provider}/${opt.model}` && (
                        <CheckCircle size={10} className="text-blue-500 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })() : null}
    </div>
  );
}
