import { useRouter } from "next/router";
import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Layout from "../../components/layout/Layout";
import TabBar from "../../components/agents/TabBar";
import OverviewTab from "../../components/agents/OverviewTab";
import MetricsTab from "../../components/agents/MetricsTab";
import LogViewer from "../../components/LogViewer";
import RuntimePathFields from "../../components/RuntimePathFields";
import OpenClawTab from "../../components/agents/OpenClawTab";
import HermesWebUITab from "../../components/agents/HermesWebUITab";
import SettingsTab from "../../components/agents/SettingsTab";
import NemoClawTab from "../../components/agents/NemoClawTab";
import StatusBadge from "../../components/agents/StatusBadge";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import {
  activeExecutionTargetFromConfig,
  activeSandboxOptionFromTarget,
  formatExecutionTargetLabel,
  formatSandboxProfileLabel,
  resolveAgentRuntimeFamily,
  resolveBackendTypeForSelection,
  runtimeFamilyFromConfig,
  runtimeSupportsGateway,
  resolveAgentExecutionTarget,
  resolveAgentSandboxProfile,
} from "../../lib/runtime";
import {
  Bot, Loader2, ArrowLeft, Terminal, MessagesSquare, ScrollText, Zap, X, Copy, Share2
} from "lucide-react";

const AgentTerminal = dynamic(() => import("../../components/AgentTerminal"), { ssr: false });

export default function AgentDetail() {
  const router = useRouter();
  const { id } = router.query;
  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [showRedeployDialog, setShowRedeployDialog] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateCloneMode, setDuplicateCloneMode] = useState("files_only");
  const [duplicateRuntimeFamily, setDuplicateRuntimeFamily] = useState("");
  const [duplicateExecutionTarget, setDuplicateExecutionTarget] = useState("");
  const [duplicateSandboxProfile, setDuplicateSandboxProfile] = useState("");
  const [redeployRuntimeFamily, setRedeployRuntimeFamily] = useState("");
  const [redeployExecutionTarget, setRedeployExecutionTarget] = useState("");
  const [redeploySandboxProfile, setRedeploySandboxProfile] = useState("");
  const [publishName, setPublishName] = useState("");
  const [publishDescription, setPublishDescription] = useState("");
  const [publishCategory, setPublishCategory] = useState("General");
  const [publishIssues, setPublishIssues] = useState([]);
  const [backendConfig, setBackendConfig] = useState(null);
  const [viewerRole, setViewerRole] = useState("user");
  const toast = useToast();

  // Persistent history refs — survive tab switches
  const terminalHistoryRef = useRef([]);
  const terminalWsRef = useRef(null);
  const logHistoryRef = useRef([]);

  const refreshAgent = () => {
    if (!id) return;
    fetchWithAuth(`/api/agents/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setAgent)
      .catch(() => {});
  };

  useEffect(() => {
    if (!id) return;
    fetchWithAuth(`/api/agents/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setAgent)
      .catch(() => setAgent(null))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchWithAuth("/api/auth/me")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      fetch("/api/config/backends")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ]).then(([profile, config]) => {
      if (cancelled) return;
      setViewerRole(profile?.role || "user");
      setBackendConfig(config);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Poll for status updates — faster (5s) for transient states, normal (10s) otherwise
  useEffect(() => {
    if (!id || loading) return;
    const isTransient = agent && (agent.status === "queued" || agent.status === "deploying");
    const interval = setInterval(refreshAgent, isTransient ? 5000 : 10000);
    return () => clearInterval(interval);
  }, [id, loading, agent?.status]);

  // Refresh immediately when tab becomes visible (e.g. after using Docker Desktop)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible" && id) refreshAgent(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [id]);

  useEffect(() => {
    if (agent?.name) {
      setDuplicateName(`${agent.name} Copy`);
      setPublishName(agent.name);
      setPublishDescription(
        `Shared template built from ${agent.name}. Review the included instructions before installing.`
      );
      setPublishCategory("General");
    }
  }, [agent?.name]);

  function openDuplicateDialog() {
    setDuplicateCloneMode("files_only");
    setDuplicateName(`${agent?.name || "OpenClaw Agent"} Copy`);
    setDuplicateRuntimeFamily(resolveAgentRuntimeFamily(agent));
    setDuplicateExecutionTarget(resolveAgentExecutionTarget(agent));
    setDuplicateSandboxProfile(resolveAgentSandboxProfile(agent));
    setShowDuplicateDialog(true);
  }

  function openRedeployDialog() {
    setRedeployRuntimeFamily(resolveAgentRuntimeFamily(agent));
    setRedeployExecutionTarget(resolveAgentExecutionTarget(agent));
    setRedeploySandboxProfile(resolveAgentSandboxProfile(agent));
    setShowRedeployDialog(true);
  }

  function openPublishDialog() {
    setPublishIssues([]);
    setPublishName(agent?.name || "Untitled Template");
    setPublishDescription(
      `Shared template built from ${agent?.name || "this agent"}. Review the included instructions before installing.`
    );
    setPublishCategory("General");
    setShowPublishDialog(true);
  }

  async function handleAction(action) {
    setActionLoading(action);
    try {
      const endpoint =
        action === "start" ? `/api/agents/${id}/start` :
        action === "stop" ? `/api/agents/${id}/stop` :
        action === "restart" ? `/api/agents/${id}/restart` :
        action === "redeploy" ? `/api/agents/${id}/redeploy` : null;
      if (!endpoint) return;

      const res = await fetchWithAuth(endpoint, { method: "POST" });
      if (res.ok) {
        const statusMap = { start: "running", stop: "stopped", restart: "running", redeploy: "queued" };
        setAgent((a) => ({ ...a, status: statusMap[action] || a.status }));
        toast.success(`Agent ${action === "redeploy" ? "re-queued" : action + (action.endsWith("e") ? "d" : "ed")}`);
        // Refresh to get authoritative state from server
        setTimeout(refreshAgent, 2000);
      } else {
        const data = await res.json();
        const ref = data.correlationId ? ` (ref: ${data.correlationId.slice(0, 8)})` : '';
        toast.error((data.error || `Failed to ${action} agent`) + ref);
      }
    } catch (err) {
      console.error(err);
      toast.error(`Failed to ${action} agent`);
    }
    setActionLoading("");
  }

  async function handleRename(nextName) {
    const trimmedName = typeof nextName === "string" ? nextName.trim() : "";
    if (!trimmedName) {
      toast.error("Agent name is required");
      return false;
    }

    setActionLoading("rename");
    try {
      const res = await fetchWithAuth(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName }),
      });

      if (res.ok) {
        const updated = await res.json();
        setAgent((current) => ({ ...current, ...updated }));
        setDuplicateName(`${updated.name} Copy`);
        toast.success("Agent renamed");
        return true;
      }

      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Failed to rename agent");
      return false;
    } catch (err) {
      console.error(err);
      toast.error("Failed to rename agent");
      return false;
    } finally {
      setActionLoading("");
    }
  }

  async function handleDuplicate() {
    const trimmedName = duplicateName.trim();
    if (!trimmedName) {
      toast.error("Duplicate name is required");
      return;
    }

    setActionLoading("duplicate");
    try {
      const res = await fetchWithAuth(`/api/agents/${id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          clone_mode: duplicateCloneMode,
          runtime_family:
            duplicateRuntimeFamily ||
            runtimeFamilyFromConfig(backendConfig)?.id ||
            "openclaw",
          deploy_target: duplicateExecutionTarget,
          sandbox_profile: duplicateSandboxProfile || "standard",
        }),
      });

      if (res.ok) {
        const duplicated = await res.json();
        setShowDuplicateDialog(false);
        toast.success("Duplicate queued");
        if (duplicated?.id) {
          router.push(`/agents/${duplicated.id}`);
        } else {
          router.push("/agents");
        }
        return;
      }

      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Failed to duplicate agent");
    } catch (err) {
      console.error(err);
      toast.error("Failed to duplicate agent");
    } finally {
      setActionLoading("");
    }
  }

  async function handleRedeploy() {
    setActionLoading("redeploy");
    try {
      const res = await fetchWithAuth(`/api/agents/${id}/redeploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runtime_family:
            redeployRuntimeFamily ||
            runtimeFamilyFromConfig(backendConfig)?.id ||
            "openclaw",
          deploy_target: redeployExecutionTarget,
          sandbox_profile: redeploySandboxProfile || "standard",
        }),
      });

      if (res.ok) {
        const nextSandboxProfile = redeploySandboxProfile || "standard";
        const nextExecutionTarget =
          redeployExecutionTarget || resolveAgentExecutionTarget(agent);
        setShowRedeployDialog(false);
        setAgent((current) =>
          current
            ? {
                ...current,
                status: "queued",
                runtime_family:
                  redeployRuntimeFamily ||
                  runtimeFamilyFromConfig(backendConfig)?.id ||
                  current.runtime_family ||
                  "openclaw",
                deploy_target: nextExecutionTarget,
                sandbox_profile: nextSandboxProfile,
                backend_type: resolveBackendTypeForSelection({
                  runtimeFamily:
                    redeployRuntimeFamily ||
                    current.runtime_family ||
                    "openclaw",
                  deployTarget: nextExecutionTarget,
                  sandboxProfile: nextSandboxProfile,
                }),
                sandbox_type: nextSandboxProfile,
              }
            : current
        );
        toast.success("Agent re-queued");
        setTimeout(refreshAgent, 2000);
        return;
      }

      const data = await res.json().catch(() => ({}));
      const ref = data.correlationId
        ? ` (ref: ${data.correlationId.slice(0, 8)})`
        : "";
      toast.error((data.error || "Failed to redeploy agent") + ref);
    } catch (err) {
      console.error(err);
      toast.error("Failed to redeploy agent");
    } finally {
      setActionLoading("");
    }
  }

  async function handleDelete() {
    setActionLoading("delete");
    try {
      const res = await fetchWithAuth(`/api/agents/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Agent deleted");
        router.push("/agents");
      } else {
        toast.error("Failed to delete agent");
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete agent");
    }
    setActionLoading("");
  }

  async function handlePublish() {
    const trimmedName = publishName.trim();
    const trimmedDescription = publishDescription.trim();
    const trimmedCategory = publishCategory.trim();
    if (!trimmedName) {
      toast.error("Template name is required");
      return;
    }
    if (!trimmedDescription) {
      toast.error("Description is required");
      return;
    }

    setActionLoading("publish");
    setPublishIssues([]);
    try {
      const res = await fetchWithAuth("/api/marketplace/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: id,
          name: trimmedName,
          description: trimmedDescription,
          category: trimmedCategory || "General",
          price: "Free",
        }),
      });

      if (res.ok) {
        setShowPublishDialog(false);
        toast.success("Marketplace listing submitted for review");
        router.push("/marketplace?tab=my");
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.issues) && data.issues.length > 0) {
        setPublishIssues(data.issues);
      }
      toast.error(data.error || "Failed to publish marketplace listing");
    } catch (err) {
      console.error(err);
      toast.error("Failed to publish marketplace listing");
    } finally {
      setActionLoading("");
    }
  }

  const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
  const supportsGateway = runtimeSupportsGateway(runtimeFamily);

  useEffect(() => {
    if (
      runtimeFamily === "hermes" &&
      (activeTab === "openclaw" || activeTab === "nemoclaw")
    ) {
      setActiveTab("overview");
      return;
    }
    if (runtimeFamily !== "hermes" && activeTab === "hermes-webui") {
      setActiveTab("overview");
    }
  }, [activeTab, runtimeFamily]);

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="animate-spin text-blue-500" size={32} />
        </div>
      </Layout>
    );
  }

  if (!agent) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center h-96 text-slate-500">
          <Bot size={48} className="mb-4 opacity-30" />
          <p className="text-lg font-bold mb-4">Agent not found</p>
          <a href="/app/agents" className="flex items-center gap-2 text-blue-400 hover:underline text-sm">
            <ArrowLeft size={16} /> Back to Agents
          </a>
        </div>
      </Layout>
    );
  }

  const executionTargetLabel = formatExecutionTargetLabel(
    resolveAgentExecutionTarget(agent)
  );
  const sandboxProfile = resolveAgentSandboxProfile(agent);
  const sandboxLabel = formatSandboxProfileLabel(sandboxProfile);
  const duplicateActiveExecutionTarget = activeExecutionTargetFromConfig(
    backendConfig,
    duplicateRuntimeFamily,
    duplicateExecutionTarget
  );
  const duplicateActiveSandboxOption = activeSandboxOptionFromTarget(
    duplicateActiveExecutionTarget,
    duplicateSandboxProfile
  );
  const redeployActiveExecutionTarget = activeExecutionTargetFromConfig(
    backendConfig,
    redeployRuntimeFamily,
    redeployExecutionTarget
  );
  const redeployActiveSandboxOption = activeSandboxOptionFromTarget(
    redeployActiveExecutionTarget,
    redeploySandboxProfile
  );
  const canDuplicate = Boolean(
    backendConfig && duplicateActiveSandboxOption?.available
  );
  const canRedeploy = Boolean(
    backendConfig && redeployActiveSandboxOption?.available
  );

  return (
    <Layout>
      <div className={`w-full max-w-full space-y-4 sm:space-y-6 ${activeTab === "terminal" ? "flex-1 flex flex-col min-h-0" : ""}`}>
        {/* Header Bar */}
        <div className="flex items-center justify-between min-w-0">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <a href="/app/agents" className="text-slate-400 hover:text-slate-600 transition-colors shrink-0">
              <ArrowLeft size={20} />
            </a>
            <div className="w-10 h-10 sm:w-12 sm:h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20 shrink-0">
              <Bot size={20} className="text-white sm:hidden" />
              <Bot size={24} className="text-white hidden sm:block" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-black text-slate-900 truncate">{agent.name}</h1>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <StatusBadge status={agent.status} />
                <span className="text-[10px] text-slate-400 font-mono">{agent.id.slice(0, 8)}</span>
                <span className="text-[10px] text-slate-500 font-bold uppercase px-2 py-0.5 bg-slate-100 rounded">
                  {executionTargetLabel}
                </span>
                {sandboxProfile !== "standard" ? (
                  <span className="text-[10px] text-emerald-700 font-bold uppercase px-2 py-0.5 bg-emerald-50 rounded">
                    {sandboxLabel}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className={`rounded-2xl border px-5 py-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between ${agent.status === "running" || agent.status === "warning" ? "bg-blue-50 border-blue-100" : "bg-amber-50 border-amber-100"}`}>
          <div>
            <p className={`text-[10px] font-black uppercase tracking-[0.2em] ${agent.status === "running" || agent.status === "warning" ? "text-blue-700" : "text-amber-700"}`}>Step 3 of 3 — Validate</p>
            <p className="text-sm font-bold text-slate-900 mt-1">
              {agent.status === "running" || agent.status === "warning"
                ? "Use this agent detail view to prove the runtime works end-to-end."
                : "This agent still needs to finish starting before the full validation pass."}
            </p>
            <p className={`text-sm mt-1 ${agent.status === "running" || agent.status === "warning" ? "text-blue-700/80" : "text-amber-700/80"}`}>
              {agent.status === "running" || agent.status === "warning"
                ? supportsGateway
                  ? "Check chat, logs, terminal, and the OpenClaw surface from this page before scaling the fleet."
                  : "Check Hermes WebUI, logs, and terminal from this page before scaling the fleet."
                : supportsGateway
                  ? "Watch the logs first, then validate chat, terminal, and the OpenClaw surface as soon as the agent is live."
                  : "Watch the logs first, then validate Hermes WebUI and terminal access as soon as the agent is live."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {supportsGateway ? (
              <button onClick={() => setActiveTab("openclaw")} className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 hover:bg-slate-50 transition-all">
                <Zap size={14} />
                OpenClaw
              </button>
            ) : (
              <button onClick={() => setActiveTab("hermes-webui")} className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 hover:bg-slate-50 transition-all">
                <Bot size={14} />
                Hermes WebUI
              </button>
            )}
            <button onClick={() => setActiveTab("logs")} className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 hover:bg-slate-50 transition-all">
              <ScrollText size={14} />
              Logs
            </button>
            <button
              onClick={() =>
                setActiveTab(
                  agent.status === "running"
                    ? "terminal"
                    : supportsGateway
                      ? "openclaw"
                      : "logs"
                )
              }
              className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-800 hover:bg-slate-50 transition-all"
            >
              {agent.status === "running" ? <Terminal size={14} /> : supportsGateway ? <MessagesSquare size={14} /> : <ScrollText size={14} />}
              {agent.status === "running" ? "Terminal" : supportsGateway ? "Chat" : "Logs"}
            </button>
          </div>
        </div>

        {/* Tab Bar */}
        <TabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          runtimeFamily={runtimeFamily}
          sandboxProfile={sandboxProfile}
        />

        {/* Tab Content */}
        <div className={`w-full min-w-0 overflow-x-hidden ${activeTab === "terminal" || activeTab === "logs" ? "flex-1 flex flex-col min-h-0" : "min-h-[200px] sm:min-h-[400px]"}`}>
          {activeTab === "overview" && (
            <OverviewTab
              agent={agent}
              actionLoading={actionLoading}
              onDuplicate={openDuplicateDialog}
              onPublish={openPublishDialog}
              onStart={() => handleAction("start")}
              onStop={() => handleAction("stop")}
              onRestart={() => handleAction("restart")}
              onRedeploy={openRedeployDialog}
            />
          )}

          {activeTab === "metrics" && <MetricsTab agentId={id} />}

          {/* Terminal — always mounted when agent is running, hidden via CSS when not active */}
          {agent.status === "running" ? (
            <div
              className="w-full"
              style={{
                height: activeTab === "terminal" ? "calc(100vh - 200px)" : "0",
                minHeight: activeTab === "terminal" ? "300px" : "0",
                overflow: activeTab === "terminal" ? "visible" : "hidden",
                position: activeTab === "terminal" ? "relative" : "absolute",
                visibility: activeTab === "terminal" ? "visible" : "hidden",
              }}
            >
              <AgentTerminal
                agentId={id}
                historyRef={terminalHistoryRef}
                wsRef={terminalWsRef}
                visible={activeTab === "terminal"}
              />
            </div>
          ) : activeTab === "terminal" ? (
            <div className="bg-slate-950 border border-slate-800 rounded-2xl p-12 flex flex-col items-center justify-center gap-3">
              <Terminal size={32} className="text-slate-700" />
              <p className="text-sm text-slate-500 font-medium">
                Terminal available when agent is <span className="text-green-400 font-bold">running</span>
              </p>
              <p className="text-xs text-slate-600">
                Agent is currently <span className="font-bold">{agent.status}</span>
              </p>
            </div>
          ) : null}

          {/* Logs — always mounted, hidden via CSS when not active */}
          <div
            style={{
              height: activeTab === "logs" ? "calc(100vh - 200px)" : "0",
              minHeight: activeTab === "logs" ? "300px" : "0",
              overflow: activeTab === "logs" ? "visible" : "hidden",
              position: activeTab === "logs" ? "relative" : "absolute",
              visibility: activeTab === "logs" ? "visible" : "hidden",
            }}
          >
            <LogViewer
              agentId={id}
              historyRef={logHistoryRef}
              visible={activeTab === "logs"}
            />
          </div>

          {activeTab === "openclaw" && supportsGateway && (
            <OpenClawTab agentId={id} agentStatus={agent.status} />
          )}

          {activeTab === "hermes-webui" && runtimeFamily === "hermes" && (
            <HermesWebUITab agentId={id} agentStatus={agent.status} />
          )}

          {activeTab === "nemoclaw" && supportsGateway && sandboxProfile === "nemoclaw" && (
            <NemoClawTab agentId={id} agentStatus={agent.status} />
          )}

          {activeTab === "settings" && (
            <SettingsTab
              agent={agent}
              actionLoading={actionLoading}
              onDelete={handleDelete}
              onDuplicate={openDuplicateDialog}
              onPublish={openPublishDialog}
              onRename={handleRename}
            />
          )}
        </div>
      </div>

      <DuplicateAgentDialog
        open={showDuplicateDialog}
        name={duplicateName}
        cloneMode={duplicateCloneMode}
        loading={actionLoading === "duplicate"}
        sourceName={agent.name}
        onNameChange={setDuplicateName}
        onCloneModeChange={setDuplicateCloneMode}
        backendConfig={backendConfig}
        viewerRole={viewerRole}
        runtimeFamily={duplicateRuntimeFamily}
        executionTarget={duplicateExecutionTarget}
        sandboxProfile={duplicateSandboxProfile}
        onRuntimeFamilyChange={setDuplicateRuntimeFamily}
        onExecutionTargetChange={setDuplicateExecutionTarget}
        onSandboxProfileChange={setDuplicateSandboxProfile}
        canConfirm={canDuplicate}
        onCancel={() => {
          if (actionLoading === "duplicate") return;
          setShowDuplicateDialog(false);
        }}
        onConfirm={handleDuplicate}
      />

      <RedeployAgentDialog
        open={showRedeployDialog}
        loading={actionLoading === "redeploy"}
        agentName={agent.name}
        backendConfig={backendConfig}
        viewerRole={viewerRole}
        runtimeFamily={redeployRuntimeFamily}
        executionTarget={redeployExecutionTarget}
        sandboxProfile={redeploySandboxProfile}
        onRuntimeFamilyChange={setRedeployRuntimeFamily}
        onExecutionTargetChange={setRedeployExecutionTarget}
        onSandboxProfileChange={setRedeploySandboxProfile}
        canConfirm={canRedeploy}
        onCancel={() => {
          if (actionLoading === "redeploy") return;
          setShowRedeployDialog(false);
        }}
        onConfirm={handleRedeploy}
      />

      <PublishMarketplaceDialog
        open={showPublishDialog}
        name={publishName}
        description={publishDescription}
        category={publishCategory}
        issues={publishIssues}
        loading={actionLoading === "publish"}
        sourceName={agent.name}
        onNameChange={setPublishName}
        onDescriptionChange={setPublishDescription}
        onCategoryChange={setPublishCategory}
        onCancel={() => {
          if (actionLoading === "publish") return;
          setShowPublishDialog(false);
          setPublishIssues([]);
        }}
        onConfirm={handlePublish}
      />
    </Layout>
  );
}

const CLONE_MODE_COPY = {
  files_only: "Copies only the OpenClaw agent files.",
  files_plus_memory: "Copies the agent files plus OpenClaw workspace and session memory.",
  full_clone: "Copies files, memory, and Nora wiring structure. Secrets are stripped and must be reconnected.",
};

function DuplicateAgentDialog({
  open,
  name,
  cloneMode,
  loading,
  sourceName,
  backendConfig,
  viewerRole,
  runtimeFamily,
  executionTarget,
  sandboxProfile,
  onRuntimeFamilyChange,
  onExecutionTargetChange,
  onSandboxProfileChange,
  canConfirm,
  onNameChange,
  onCloneModeChange,
  onCancel,
  onConfirm,
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="duplicate-agent-dialog-title"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <Copy size={18} className="text-slate-700" />
          </div>
          <div className="flex-1">
            <h3
              id="duplicate-agent-dialog-title"
              className="text-lg font-bold text-slate-900"
            >
              Duplicate Agent
            </h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              Create a new agent from <span className="font-semibold text-slate-700">{sourceName}</span>. Wiring structure can be copied, but secrets stay disconnected.
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 transition-colors" disabled={loading}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="duplicate-agent-name"
              className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1"
            >
              New Agent Name
            </label>
            <input
              id="duplicate-agent-name"
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="duplicate-agent-clone-depth"
              className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1"
            >
              Clone Depth
            </label>
            <select
              id="duplicate-agent-clone-depth"
              value={cloneMode}
              onChange={(e) => onCloneModeChange(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="files_only">Files Only</option>
              <option value="files_plus_memory">Files + Memory</option>
              <option value="full_clone">Full Clone</option>
            </select>
            <p className="text-xs text-slate-500 mt-2">{CLONE_MODE_COPY[cloneMode]}</p>
          </div>

          <RuntimePathFields
            backendConfig={backendConfig}
            viewerRole={viewerRole}
            runtimeFamily={runtimeFamily}
            executionTarget={executionTarget}
            sandboxProfile={sandboxProfile}
            onRuntimeFamilyChange={onRuntimeFamilyChange}
            onExecutionTargetChange={onExecutionTargetChange}
            onSandboxProfileChange={onSandboxProfileChange}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-sm font-bold text-slate-700 rounded-xl transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !name.trim() || !canConfirm}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            Duplicate
          </button>
        </div>
      </div>
    </div>
  );
}

function RedeployAgentDialog({
  open,
  loading,
  agentName,
  backendConfig,
  viewerRole,
  runtimeFamily,
  executionTarget,
  sandboxProfile,
  onRuntimeFamilyChange,
  onExecutionTargetChange,
  onSandboxProfileChange,
  canConfirm,
  onCancel,
  onConfirm,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Zap size={18} className="text-blue-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-slate-900">Redeploy Agent</h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              Re-queue <span className="font-semibold text-slate-700">{agentName}</span> and choose the runtime path it should use next.
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 transition-colors" disabled={loading}>
            <X size={18} />
          </button>
        </div>

        <RuntimePathFields
          backendConfig={backendConfig}
          viewerRole={viewerRole}
          runtimeFamily={runtimeFamily}
          executionTarget={executionTarget}
          sandboxProfile={sandboxProfile}
          onRuntimeFamilyChange={onRuntimeFamilyChange}
          onExecutionTargetChange={onExecutionTargetChange}
          onSandboxProfileChange={onSandboxProfileChange}
          disabled={loading}
        />

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-sm font-bold text-slate-700 rounded-xl transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !canConfirm}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            Re-queue Deploy
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishMarketplaceDialog({
  open,
  name,
  description,
  category,
  issues,
  loading,
  sourceName,
  onNameChange,
  onDescriptionChange,
  onCategoryChange,
  onCancel,
  onConfirm,
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-marketplace-dialog-title"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-xl w-full p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Share2 size={18} className="text-blue-600" />
          </div>
          <div className="flex-1">
            <h3
              id="publish-marketplace-dialog-title"
              className="text-lg font-bold text-slate-900"
            >
              Publish to Marketplace
            </h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              Share <span className="font-semibold text-slate-700">{sourceName}</span> as a community template. Nora publishes only the template files and runs a secret scan before submission.
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 transition-colors" disabled={loading}>
            <X size={18} />
          </button>
        </div>

        {issues.length > 0 && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
            <p className="text-xs font-black uppercase tracking-widest text-red-700">Publish blocked</p>
            <div className="mt-2 space-y-2">
              {issues.map((issue, index) => (
                <div key={`${issue.path}-${index}`} className="text-sm text-red-700">
                  <span className="font-semibold">{issue.path}</span>: {issue.message}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label
              htmlFor="publish-marketplace-template-name"
              className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1"
            >
              Template Name
            </label>
            <input
              id="publish-marketplace-template-name"
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="publish-marketplace-category"
              className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1"
            >
              Category
            </label>
            <input
              id="publish-marketplace-category"
              type="text"
              value={category}
              onChange={(e) => onCategoryChange(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="publish-marketplace-description"
              className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1"
            >
              Description
            </label>
            <textarea
              id="publish-marketplace-description"
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={5}
              className="w-full text-sm border border-slate-200 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Credentials, session memory, integrations, and channels are not published. If Nora detects `.env`, token-like values, or private keys, the submission is blocked until you remove them.
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-sm font-bold text-slate-700 rounded-xl transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !name.trim() || !description.trim()}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
            Submit for Review
          </button>
        </div>
      </div>
    </div>
  );
}
