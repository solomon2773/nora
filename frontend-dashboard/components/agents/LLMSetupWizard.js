import { useState, useEffect } from "react";
import { Key, Plus, Trash2, Loader2, Check, ChevronRight, Sparkles, AlertTriangle, RefreshCw } from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const PROVIDER_META = {
  anthropic: { name: "Anthropic", color: "bg-orange-100 text-orange-700 border-orange-200", icon: "🧠" },
  openai: { name: "OpenAI", color: "bg-green-100 text-green-700 border-green-200", icon: "🤖" },
  google: { name: "Google AI", color: "bg-blue-100 text-blue-700 border-blue-200", icon: "🔵" },
  groq: { name: "Groq", color: "bg-purple-100 text-purple-700 border-purple-200", icon: "⚡" },
  mistral: { name: "Mistral AI", color: "bg-indigo-100 text-indigo-700 border-indigo-200", icon: "🌀" },
  deepseek: { name: "DeepSeek", color: "bg-cyan-100 text-cyan-700 border-cyan-200", icon: "🔍" },
  openrouter: { name: "OpenRouter", color: "bg-pink-100 text-pink-700 border-pink-200", icon: "🔀" },
  together: { name: "Together AI", color: "bg-yellow-100 text-yellow-700 border-yellow-200", icon: "🤝" },
  cohere: { name: "Cohere", color: "bg-teal-100 text-teal-700 border-teal-200", icon: "💎" },
  xai: { name: "xAI", color: "bg-gray-100 text-gray-700 border-gray-200", icon: "✖️" },
  moonshot: { name: "Moonshot AI", color: "bg-violet-100 text-violet-700 border-violet-200", icon: "🌙" },
  zai: { name: "Z.AI", color: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: "🇿" },
  ollama: { name: "Ollama", color: "bg-slate-100 text-slate-700 border-slate-200", icon: "🦙" },
  minimax: { name: "MiniMax", color: "bg-amber-100 text-amber-700 border-amber-200", icon: "🔶" },
  "github-copilot": { name: "GitHub Copilot", color: "bg-gray-100 text-gray-700 border-gray-200", icon: "🐙" },
  huggingface: { name: "Hugging Face", color: "bg-yellow-100 text-yellow-700 border-yellow-200", icon: "🤗" },
  cerebras: { name: "Cerebras", color: "bg-red-100 text-red-700 border-red-200", icon: "🧬" },
  nvidia: { name: "NVIDIA", color: "bg-lime-100 text-lime-700 border-lime-200", icon: "💚" },
};

export default function LLMSetupWizard({ onComplete, compact = false }) {
  const [step, setStep] = useState(0); // 0 = select provider, 1 = enter key, 2 = done
  const [available, setAvailable] = useState([]);
  const [existing, setExisting] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const toast = useToast();

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [avail, exist] = await Promise.all([
        fetchWithAuth("/api/llm-providers/available").then((r) => r.json()),
        fetchWithAuth("/api/llm-providers").then((r) => r.json()),
      ]);
      setAvailable(Array.isArray(avail) ? avail : []);
      setExisting(Array.isArray(exist) ? exist : []);
    } catch (e) {
      console.error("Failed to load LLM providers:", e);
    }
    setLoading(false);
  }

  async function handleSave() {
    if (!selectedProvider || !apiKey.trim()) return;
    setSaving(true);
    try {
      const res = await fetchWithAuth("/api/llm-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider.id,
          apiKey: apiKey.trim(),
          model: selectedModel || undefined,
        }),
      });
      if (res.ok) {
        toast.success(`${selectedProvider.name} API key saved`);
        setStep(2);
        setApiKey("");
        setSelectedModel("");
        await loadData();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save provider");
    }
    setSaving(false);
  }

  async function handleDelete(id) {
    try {
      const res = await fetchWithAuth(`/api/llm-providers/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Provider removed");
        await loadData();
      }
    } catch {
      toast.error("Failed to remove provider");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  // If user has no providers configured, show the full wizard
  const hasProviders = existing.length > 0;
  const configuredIds = new Set(existing.map((e) => e.provider));

  async function handleSyncToAgents() {
    setSaving(true);
    try {
      const res = await fetchWithAuth("/api/llm-providers/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Keys synced to ${data.synced}/${data.total} running agent(s)`);
      } else {
        toast.error(data.error || "Sync failed");
      }
    } catch {
      toast.error("Failed to sync keys");
    }
    setSaving(false);
  }

  // Step 2: Success / add more
  if (step === 2) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto">
            <Check size={24} className="text-green-600" />
          </div>
          <h3 className="text-lg font-bold text-slate-900">Provider Added!</h3>
          <p className="text-sm text-slate-500">
            Your API key has been securely saved. Sync to push keys to running agents, or they'll apply on next deploy.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <button
            onClick={handleSyncToAgents}
            disabled={saving}
            className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Sync to Running Agents
          </button>
          <button
            onClick={() => { setStep(0); setSelectedProvider(null); }}
            className="px-4 py-2 text-xs font-bold text-blue-600 bg-blue-50 rounded-xl hover:bg-blue-100 transition-colors flex items-center gap-1.5"
          >
            <Plus size={14} /> Add Another
          </button>
          {onComplete && (
            <button
              onClick={onComplete}
              className="px-4 py-2 text-xs font-bold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors flex items-center gap-1.5"
            >
              Done
            </button>
          )}
        </div>
      </div>
    );
  }

  // Step 1: Enter API key
  if (step === 1 && selectedProvider) {
    const meta = PROVIDER_META[selectedProvider.id] || { name: selectedProvider.name, color: "bg-slate-100 text-slate-700", icon: "🔑" };
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => { setStep(0); setSelectedProvider(null); }} className="text-slate-400 hover:text-slate-600 transition-colors text-sm">← Back</button>
          <div className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${meta.color}`}>
            {meta.icon} {meta.name}
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1.5">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Enter your ${meta.name} API key...`}
              className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              autoFocus
            />
          </div>
          {selectedProvider.models && selectedProvider.models.length > 0 && (
            <div>
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1.5">Default Model (optional)</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Auto (latest)</option>
                {selectedProvider.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={!apiKey.trim() || saving}
          className="w-full py-2.5 text-xs font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
          Save API Key
        </button>
      </div>
    );
  }

  // Step 0: Provider selection (also shows existing providers)
  return (
    <div className={`space-y-6 ${compact ? "" : ""}`}>
      {/* Existing providers */}
      {existing.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
              <Key size={16} className="text-blue-600" />
              Configured LLM Providers
            </h3>
            <button
              onClick={handleSyncToAgents}
              disabled={saving}
              className="px-3 py-1.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              Sync to All Agents
            </button>
          </div>
          <div className="space-y-2">
            {existing.map((p) => {
              const meta = PROVIDER_META[p.provider] || { name: p.provider, color: "bg-slate-100 text-slate-700", icon: "🔑" };
              return (
                <div key={p.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{meta.icon}</span>
                    <div>
                      <span className="text-sm font-bold text-slate-700">{meta.name}</span>
                      {p.model && <span className="text-[10px] text-slate-400 ml-2">{p.model}</span>}
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">{p.api_key_masked}</span>
                    {p.is_default && (
                      <span className="text-[9px] font-bold uppercase bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">Default</span>
                    )}
                  </div>
                  <button onClick={() => handleDelete(p.id)} className="text-red-400 hover:text-red-600 transition-colors" title="Remove">
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Provider picker */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        {!hasProviders && (
          <div className="text-center space-y-2 mb-4">
            <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
              <AlertTriangle size={24} className="text-amber-600" />
            </div>
            <h3 className="text-lg font-bold text-slate-900">Set Up LLM Provider</h3>
            <p className="text-sm text-slate-500 max-w-md mx-auto">
              Your agent needs an API key to use AI models. Select a provider below and enter your API key to get started.
            </p>
          </div>
        )}
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
          {hasProviders ? "Add Another Provider" : "Select a Provider"}
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {available.map((p) => {
            const meta = PROVIDER_META[p.id] || { name: p.name, color: "bg-slate-100 text-slate-700 border-slate-200", icon: "🔑" };
            const isConfigured = configuredIds.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => { setSelectedProvider(p); setStep(1); }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all hover:shadow-sm ${
                  isConfigured ? "opacity-50 border-green-200 bg-green-50" : "border-slate-200 bg-white hover:border-blue-300"
                }`}
              >
                <span className="text-lg">{meta.icon}</span>
                <div className="min-w-0">
                  <span className="text-xs font-bold text-slate-700 block truncate">{meta.name}</span>
                  {isConfigured && <span className="text-[9px] text-green-600 font-bold">Connected</span>}
                </div>
                <ChevronRight size={12} className="text-slate-300 ml-auto shrink-0" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
