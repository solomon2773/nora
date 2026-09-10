import { useEffect, useState } from "react";
import { Settings, Trash2, Loader2, Save, Copy, Share2, Download } from "lucide-react";
import ConfirmDialog from "../ConfirmDialog";
import BudgetSection from "./BudgetSection";
import { useToast } from "../Toast";
import {
  formatExecutionTargetLabel,
  formatRuntimeFamilyLabel,
  formatSandboxProfileLabel,
  runtimeSupportsAgentHubSharing,
  resolveAgentExecutionTarget,
  resolveAgentSandboxProfile,
} from "../../lib/runtime";

export default function SettingsTab({
  agent,
  backendConfig,
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
  // Phase 5c item 1 / Phase 8 item 11: the backend rejects a delete request
  // that omits `deleteLogs` outright, with no default. `null` here means
  // "no explicit choice yet" — deliberately distinct from `false`, so the
  // confirm button stays disabled until the operator actually clicks one of
  // the two options below, never a pre-selected radio state.
  const [deleteLogsChoice, setDeleteLogsChoice] = useState<boolean | null>(null);
  const toast = useToast();
  const runtimeFamilyLabel = formatRuntimeFamilyLabel(agent.runtime_family);
  const supportsAgentHub = runtimeSupportsAgentHubSharing(agent);
  const executionTargetLabel = formatExecutionTargetLabel(
    resolveAgentExecutionTarget(agent),
    backendConfig,
    agent.runtime_family,
  );
  const sandboxLabel = formatSandboxProfileLabel(resolveAgentSandboxProfile(agent));
  const canDelete = agent.isDirectOwner !== false;
  // External (adopted) runtimes aren't provisioned by Nora, so "delete" only
  // removes the adoption record — surface it as "Deregister", and the
  // duplicate/clone action doesn't apply.
  const isExternal = String(agent?.deploy_target || "").toLowerCase() === "external";

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
        title={isExternal ? "Deregister runtime" : "Delete Agent"}
        message={
          isExternal
            ? "Remove this external runtime from Nora? Nora stops monitoring and proxying it, but the runtime itself keeps running — it is not stopped or destroyed."
            : "Are you sure you want to permanently delete this agent? This will destroy the container and all data. This action cannot be undone."
        }
        confirmLabel={isExternal ? "Deregister" : "Delete Agent"}
        confirmDisabled={deleteLogsChoice === null}
        onConfirm={() => {
          if (deleteLogsChoice === null) return;
          setShowDeleteConfirm(false);
          onDelete(deleteLogsChoice);
          setDeleteLogsChoice(null);
        }}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setDeleteLogsChoice(null);
        }}
      >
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-500">
            This agent's logs
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Choose whether to keep or delete this agent's runtime logs. There is no default —
            pick one before deleting.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setDeleteLogsChoice(false)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                deleteLogsChoice === false
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              Keep logs
            </button>
            <button
              type="button"
              onClick={() => setDeleteLogsChoice(true)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                deleteLogsChoice === true
                  ? "border-red-500 bg-red-50 text-red-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              Delete logs
            </button>
          </div>
        </div>
      </ConfirmDialog>

      {/* Agent Name */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Settings size={16} className="text-blue-600" />
          General Settings
        </h3>
        <form className="space-y-4" onSubmit={handleRenameSubmit}>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
              Agent Name
            </label>
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
              {actionLoading === "rename" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              Save Name
            </button>
            {!isExternal ? (
              <button
                type="button"
                onClick={onDuplicate}
                disabled={!!actionLoading}
                className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-800 text-xs font-bold rounded-xl hover:bg-slate-200 transition-all disabled:opacity-50"
              >
                {actionLoading === "duplicate" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Copy size={14} />
                )}
                Duplicate Agent
              </button>
            ) : null}
            {supportsAgentHub ? (
              <button
                type="button"
                onClick={onPublish}
                disabled={!!actionLoading}
                className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 text-blue-700 text-xs font-bold rounded-xl hover:bg-blue-100 transition-all disabled:opacity-50"
              >
                {actionLoading === "publish" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Share2 size={14} />
                )}
                Share to Agent Hub
              </button>
            ) : null}
          </div>
        </form>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
            Current Name
          </label>
          <p className="text-sm text-slate-900">{agent.name}</p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
            Runtime Family
          </label>
          <p className="text-sm text-slate-900 bg-slate-50 px-4 py-2 rounded-lg w-fit">
            {runtimeFamilyLabel}
          </p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
            Execution Target
          </label>
          <p className="text-sm text-slate-900 bg-slate-50 px-4 py-2 rounded-lg w-fit">
            {executionTargetLabel}
          </p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
            Sandbox
          </label>
          <p className="text-sm text-slate-900 bg-slate-50 px-4 py-2 rounded-lg w-fit">
            {sandboxLabel}
          </p>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
            Agent ID
          </label>
          <p className="text-sm text-slate-500 font-mono">{agent.id}</p>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700">Migration & Backup</h3>
        <p className="text-sm text-slate-500 leading-relaxed">
          Export this Nora-managed agent as a migration bundle when you need to recreate it on
          another Nora control plane. Use the Files tab when you need live access to the runtime
          filesystem itself.
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
        <p className="text-[10px] text-slate-400">
          One variable per line. Changes take effect on next restart.
        </p>
      </section>

      {/* Resource Limits */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-700">Resource Limits</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
              vCPU
            </label>
            <p className="text-sm font-bold text-slate-900">{agent.vcpu || 2}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
              RAM
            </label>
            <p className="text-sm font-bold text-slate-900">
              {agent.ram_mb ? `${agent.ram_mb / 1024} GB` : "2 GB"}
            </p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">
              Disk
            </label>
            <p className="text-sm font-bold text-slate-900">{agent.disk_gb || 20} GB</p>
          </div>
        </div>
        <p className="text-[10px] text-slate-400">
          Resource limits are set by your subscription plan.
        </p>
      </section>

      <BudgetSection agentId={agent.id} />

      {canDelete ? (
        <section className="bg-red-50 border border-red-200 rounded-2xl p-6 space-y-4">
          <h3 className="text-sm font-bold text-red-700">Danger Zone</h3>
          <p className="text-xs text-red-600">
            {isExternal
              ? "Deregistering removes this external runtime from Nora (monitoring, proxy access, and its record). The runtime itself keeps running — Nora does not stop or destroy it."
              : "Deleting this agent will permanently destroy the container and all associated data including integrations, channels, and message history."}
          </p>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white text-xs font-bold rounded-xl hover:bg-red-700 transition-all disabled:opacity-50"
          >
            {actionLoading === "delete" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {isExternal ? "Deregister Runtime" : "Delete Agent"}
          </button>
        </section>
      ) : (
        <section className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-2">
          <h3 className="text-sm font-bold text-slate-700">Workspace-shared agent</h3>
          <p className="text-xs text-slate-500">
            This agent is shared through a workspace. Only the direct owner can delete the runtime;
            workspace admins can remove the assignment from the workspace agents page.
          </p>
        </section>
      )}
    </div>
  );
}
