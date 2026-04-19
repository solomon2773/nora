import { useEffect, useState } from "react";
import {
  Settings,
  Trash2,
  Loader2,
  Save,
  Copy,
  Share2,
  Download,
} from "lucide-react";
import ConfirmDialog from "../ConfirmDialog";
import { useToast } from "../Toast";
import {
  formatExecutionTargetLabel,
  formatRuntimeFamilyLabel,
  formatSandboxProfileLabel,
  runtimeSupportsMarketplacePublishing,
  resolveAgentExecutionTarget,
  resolveAgentSandboxProfile,
} from "../../lib/runtime";

export default function SettingsTab({
  agent,
  onDelete,
  onRename,
  onDuplicate,
  onPublish,
  onExport,
  actionLoading,
}) {
  const [envVars, setEnvVars] = useState("");
  const [agentName, setAgentName] = useState(agent.name || "");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const toast = useToast();
  const runtimeFamilyLabel = formatRuntimeFamilyLabel(agent.runtime_family);
  const supportsMarketplace = runtimeSupportsMarketplacePublishing(agent);
  const executionTargetLabel = formatExecutionTargetLabel(
    resolveAgentExecutionTarget(agent)
  );
  const sandboxLabel = formatSandboxProfileLabel(
    resolveAgentSandboxProfile(agent)
  );

  useEffect(() => {
    setAgentName(agent.name || "");
  }, [agent.name]);

  async function handleRenameSubmit(e) {
    e?.preventDefault();
    const nextName = agentName.trim();
    if (!nextName) {
      toast.error("Agent name is required");
      return;
    }
    if (nextName === agent.name) return;
    await onRename?.(nextName);
  }

  return (
    <div className="space-y-8">
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete Agent"
        message="Are you sure you want to permanently delete this agent? This will destroy the container and all data. This action cannot be undone."
        confirmLabel="Delete Agent"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          onDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* Agent Name */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Settings size={16} className="text-blue-600" />
          General Settings
        </h3>
        <form className="space-y-4" onSubmit={handleRenameSubmit}>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Agent Name</label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              className="w-full md:w-1/2 text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!!actionLoading || agentName.trim() === (agent.name || "")}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-xl hover:bg-blue-700 transition-all disabled:opacity-50"
            >
              {actionLoading === "rename" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save Name
            </button>
            <button
              type="button"
              onClick={onDuplicate}
              disabled={!!actionLoading}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-800 text-xs font-bold rounded-xl hover:bg-slate-200 transition-all disabled:opacity-50"
            >
              {actionLoading === "duplicate" ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
              Duplicate Agent
            </button>
            {supportsMarketplace ? (
              <button
                type="button"
                onClick={onPublish}
                disabled={!!actionLoading}
                className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 text-blue-700 text-xs font-bold rounded-xl hover:bg-blue-100 transition-all disabled:opacity-50"
              >
                {actionLoading === "publish" ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
                Publish to Marketplace
              </button>
            ) : null}
          </div>
        </form>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Current Name</label>
          <p className="text-sm text-slate-900">{agent.name}</p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Runtime Family</label>
          <p className="text-sm text-slate-900 bg-slate-50 px-4 py-2 rounded-lg w-fit">{runtimeFamilyLabel}</p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Execution Target</label>
          <p className="text-sm text-slate-900 bg-slate-50 px-4 py-2 rounded-lg w-fit">{executionTargetLabel}</p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Sandbox</label>
          <p className="text-sm text-slate-900 bg-slate-50 px-4 py-2 rounded-lg w-fit">{sandboxLabel}</p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Agent ID</label>
          <p className="text-sm text-slate-500 font-mono">{agent.id}</p>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700">Migration & Backup</h3>
        <p className="text-sm text-slate-500 leading-relaxed">
          Export this Nora-managed agent as a migration bundle when you need to recreate it on another Nora control plane.
          Use the Files tab when you need live access to the runtime filesystem itself.
        </p>
        <button
          type="button"
          onClick={onExport}
          disabled={!!actionLoading}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-50 text-blue-700 text-xs font-bold rounded-xl hover:bg-blue-100 transition-all disabled:opacity-50"
        >
          {actionLoading === "export" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          Export Nora Bundle
        </button>
      </section>

      {/* Environment Variables */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700">Environment Variables</h3>
        <textarea
          value={envVars}
          onChange={(e) => setEnvVars(e.target.value)}
          placeholder="KEY=value&#10;ANOTHER_KEY=value"
          rows={6}
          className="w-full text-xs font-mono border border-slate-200 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        <p className="text-[10px] text-slate-400">One variable per line. Changes take effect on next restart.</p>
      </section>

      {/* Resource Limits */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700">Resource Limits</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">vCPU</label>
            <p className="text-sm font-bold text-slate-900">{agent.vcpu || 2}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">RAM</label>
            <p className="text-sm font-bold text-slate-900">{agent.ram_mb ? `${agent.ram_mb / 1024} GB` : "2 GB"}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Disk</label>
            <p className="text-sm font-bold text-slate-900">{agent.disk_gb || 20} GB</p>
          </div>
        </div>
        <p className="text-[10px] text-slate-400">Resource limits are set by your subscription plan.</p>
      </section>

      {/* Danger Zone */}
      <section className="bg-red-50 border border-red-200 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-red-700">Danger Zone</h3>
        <p className="text-xs text-red-600">Deleting this agent will permanently destroy the container and all associated data including integrations, channels, and message history.</p>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          disabled={!!actionLoading}
          className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white text-xs font-bold rounded-xl hover:bg-red-700 transition-all disabled:opacity-50"
        >
          {actionLoading === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Delete Agent
        </button>
      </section>
    </div>
  );
}
