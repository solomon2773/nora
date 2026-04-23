import Layout from "../../components/layout/Layout";
import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import {
  Rocket,
  Server,
  Boxes,
  Network,
  Shield,
  Loader2,
  CheckCircle2,
  Cpu,
  HardDrive,
  MemoryStick,
  AlertTriangle,
  ShieldCheck,
  Brain,
  KeyRound,
  MessagesSquare,
  Upload,
  Database,
  FolderTree,
  RefreshCw,
  Trash2,
  Download,
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";
import {
  activeExecutionTargetFromConfig,
  containerNamePrefixForSelection,
  formatRuntimeFamilyLabel,
  pickExecutionTargetSelection,
  pickRuntimeFamilySelection,
  runtimeFamilyFromConfig,
  visibleExecutionTargetsFromConfig,
  visibleRuntimeFamiliesFromConfig,
} from "../../lib/runtime";
import {
  loadDeployDraft,
  normalizeDeployDraftResources,
  saveDeployDraft,
} from "../../lib/clawhubDeploy";

function slugifyName(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function maturityClasses(maturityTier) {
  switch (maturityTier) {
    case "blocked":
      return "bg-red-50 text-red-700 border-red-200";
    case "experimental":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "beta":
      return "bg-blue-50 text-blue-700 border-blue-200";
    default:
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
}

function MaturityBadge({ maturityTier = "ga", maturityLabel = "GA" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-widest ${maturityClasses(
        maturityTier,
      )}`}
    >
      {maturityLabel}
    </span>
  );
}

function createEmptyMigrationSource() {
  return {
    name: "",
    transport: "docker",
    container: "",
    host: "",
    username: "root",
    port: "22",
    privateKey: "",
    workspaceRoot: "",
    agentRoot: "",
    sessionRoot: "",
  };
}

function formatDateTime(value) {
  if (!value) return "Unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "Unknown";
  }
}

function formatMigrationTransportLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "ssh") return "SSH";
  if (normalized === "docker") return "Docker";
  return "Bundle";
}

export default function Deploy() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [containerName, setContainerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [sub, setSub] = useState(null);
  const [agentCount, setAgentCount] = useState(0);
  const [selectedRuntimeFamily, setSelectedRuntimeFamily] = useState("");
  const [selectedExecutionTarget, setSelectedExecutionTarget] = useState("");
  const [selectedSandboxProfile, setSelectedSandboxProfile] = useState("");
  const [backendConfig, setBackendConfig] = useState(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [deploymentMode, setDeploymentMode] = useState("blank");
  const [migrationMethod, setMigrationMethod] = useState("upload");
  const [migrationDraft, setMigrationDraft] = useState(null);
  const [migrationBusyAction, setMigrationBusyAction] = useState("");
  const [migrationSource, setMigrationSource] = useState(() => createEmptyMigrationSource());
  const [platformConfig, setPlatformConfig] = useState(null);
  const [viewerRole, setViewerRole] = useState("user");
  const migrationUploadInputRef = useRef(null);
  const [selVcpu, setSelVcpu] = useState(1);
  const [selRam, setSelRam] = useState(1024);
  const [selDisk, setSelDisk] = useState(10);
  const deployDraftHydratedRef = useRef(false);
  const deployDraftRef = useRef<any>(null);
  const resourceDefaultsInitializedRef = useRef(false);
  const resourceSelectionDirtyRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    if (deployDraftHydratedRef.current) return;
    const draft = loadDeployDraft();
    if (!draft) {
      deployDraftHydratedRef.current = true;
      return;
    }

    deployDraftRef.current = draft;
    setName(draft.name || "");
    setContainerName(draft.containerName || "");
    setSelectedRuntimeFamily(draft.runtimeFamily || "");
    setSelectedExecutionTarget(draft.deployTarget || "");
    setSelectedSandboxProfile(draft.sandboxProfile || "");
    setSelectedModel(draft.model || "");
    setDeploymentMode(draft.deploymentMode || "blank");
    setMigrationMethod(draft.migrationMethod || "upload");
    setMigrationDraft(draft.migrationDraft || null);
    setMigrationSource(draft.migrationSource || createEmptyMigrationSource());
    deployDraftHydratedRef.current = true;
  }, []);

  useEffect(() => {
    fetchWithAuth("/api/billing/subscription")
      .then((r) => r.json())
      .then(setSub)
      .catch((err) => console.error(err));
    fetchWithAuth("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgentCount(Array.isArray(data) ? data.length : 0))
      .catch((err) => console.error(err));
    fetchWithAuth("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((profile) => setViewerRole(profile?.role || "user"))
      .catch(() => {});
    fetch("/api/config/backends")
      .then((r) => r.json())
      .then(setBackendConfig)
      .catch(() => {});
    fetch("/api/config/platform")
      .then((r) => r.json())
      .then(setPlatformConfig)
      .catch(() => {});
  }, []);

  const deploymentDefaults = platformConfig?.deploymentDefaults || {
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
  };

  useEffect(() => {
    if (!platformConfig?.deploymentDefaults || resourceDefaultsInitializedRef.current) {
      return;
    }

    if (deployDraftRef.current) {
      const normalizedResources = normalizeDeployDraftResources(deployDraftRef.current, {
        defaultVcpu: deploymentDefaults.vcpu,
        defaultRamMb: deploymentDefaults.ram_mb,
        defaultDiskGb: deploymentDefaults.disk_gb,
        maxVcpu: platformConfig?.selfhosted?.max_vcpu || 16,
        maxRamMb: platformConfig?.selfhosted?.max_ram_mb || 32768,
        maxDiskGb: platformConfig?.selfhosted?.max_disk_gb || 500,
      });

      setSelVcpu(normalizedResources.vcpu);
      setSelRam(normalizedResources.ramMb);
      setSelDisk(normalizedResources.diskGb);
      resourceSelectionDirtyRef.current = true;
    } else {
      setSelVcpu(deploymentDefaults.vcpu);
      setSelRam(deploymentDefaults.ram_mb);
      setSelDisk(deploymentDefaults.disk_gb);
    }

    resourceDefaultsInitializedRef.current = true;
  }, [deploymentDefaults, platformConfig?.deploymentDefaults]);

  const isSelfHosted = platformConfig?.mode !== "paas";
  const plan = sub?.plan || "free";
  const planLabel = isSelfHosted ? "Self-hosted" : plan.charAt(0).toUpperCase() + plan.slice(1);
  const limit = isSelfHosted ? platformConfig?.selfhosted?.max_agents || 50 : sub?.agent_limit || 3;
  const atLimit = agentCount >= limit;
  const isAdmin = viewerRole === "admin";
  const runtimeFamilyLocked =
    deploymentMode === "migrate"
      ? String(migrationDraft?.runtimeFamily || "")
          .trim()
          .toLowerCase()
      : "";
  const defaultRuntimeFamily = useMemo(
    () => runtimeFamilyFromConfig(backendConfig),
    [backendConfig],
  );
  const activeRuntimeFamily = useMemo(
    () => runtimeFamilyFromConfig(backendConfig, selectedRuntimeFamily),
    [backendConfig, selectedRuntimeFamily],
  );
  const visibleRuntimeFamilies = useMemo(
    () => visibleRuntimeFamiliesFromConfig(backendConfig, viewerRole),
    [backendConfig, viewerRole],
  );
  const visibleExecutionTargets = useMemo(
    () =>
      visibleExecutionTargetsFromConfig(
        backendConfig,
        viewerRole,
        runtimeFamilyLocked || activeRuntimeFamily?.id || selectedRuntimeFamily,
      ),
    [
      backendConfig,
      viewerRole,
      runtimeFamilyLocked,
      activeRuntimeFamily?.id,
      selectedRuntimeFamily,
    ],
  );
  const activeExecutionTarget = useMemo(
    () =>
      activeExecutionTargetFromConfig(
        backendConfig,
        runtimeFamilyLocked || activeRuntimeFamily?.id || selectedRuntimeFamily,
        selectedExecutionTarget,
      ),
    [
      backendConfig,
      runtimeFamilyLocked,
      activeRuntimeFamily?.id,
      selectedRuntimeFamily,
      selectedExecutionTarget,
    ],
  );
  const visibleSandboxOptions = useMemo(() => {
    const sandboxProfiles = activeExecutionTarget?.sandboxProfiles || [];
    const enabledProfiles = sandboxProfiles.filter((profile) => profile.enabled);

    return isAdmin
      ? enabledProfiles
      : enabledProfiles.filter((profile) => profile.availableForOnboarding);
  }, [activeExecutionTarget, isAdmin]);
  const activeSandboxOption = useMemo(
    () =>
      (activeExecutionTarget?.sandboxProfiles || []).find(
        (profile) => profile.id === selectedSandboxProfile,
      ) || null,
    [activeExecutionTarget, selectedSandboxProfile],
  );
  const ramOptions = useMemo(() => {
    const maxRam = platformConfig?.selfhosted?.max_ram_mb || 32768;
    return Array.from(
      new Set(
        [selRam, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].filter(
          (value) => value <= maxRam || value === selRam,
        ),
      ),
    ).sort((left, right) => left - right);
  }, [platformConfig?.selfhosted?.max_ram_mb, selRam]);
  const diskOptions = useMemo(() => {
    const maxDisk = platformConfig?.selfhosted?.max_disk_gb || 500;
    return Array.from(
      new Set(
        [selDisk, 10, 20, 50, 100, 200, 500, 1000].filter(
          (value) => value <= maxDisk || value === selDisk,
        ),
      ),
    ).sort((left, right) => left - right);
  }, [platformConfig?.selfhosted?.max_disk_gb, selDisk]);
  const canDeployExecutionTarget = Boolean(activeSandboxOption?.available);
  const isNemoClaw = activeSandboxOption?.id === "nemoclaw";
  const effectiveRuntimeFamily =
    runtimeFamilyLocked ||
    activeRuntimeFamily?.id ||
    selectedRuntimeFamily ||
    defaultRuntimeFamily?.id ||
    "openclaw";
  const isHermes = effectiveRuntimeFamily === "hermes";
  const showSandboxSelection = visibleSandboxOptions.length > 1;
  const showRuntimeFamilySelection = visibleRuntimeFamilies.length > 1;
  const suggestedContainerName = useMemo(() => {
    const slug = slugifyName(name);
    const prefix = containerNamePrefixForSelection({
      runtimeFamily: effectiveRuntimeFamily,
      sandboxProfile: selectedSandboxProfile || activeSandboxOption?.id || "standard",
    });
    return slug ? `${prefix}-${slug}` : `${prefix}-my-first-agent`;
  }, [activeSandboxOption?.id, effectiveRuntimeFamily, name, selectedSandboxProfile]);

  useEffect(() => {
    if (!runtimeFamilyLocked) return;
    if (selectedRuntimeFamily !== runtimeFamilyLocked) {
      setSelectedRuntimeFamily(runtimeFamilyLocked);
    }
  }, [runtimeFamilyLocked, selectedRuntimeFamily]);

  useEffect(() => {
    if (!migrationDraft?.name) return;
    setName(migrationDraft.name);
  }, [migrationDraft?.id, migrationDraft?.name]);

  useEffect(() => {
    if (!backendConfig) return;
    if (runtimeFamilyLocked) return;
    const nextRuntimeFamily = pickRuntimeFamilySelection(
      backendConfig,
      viewerRole,
      selectedRuntimeFamily,
    );
    if (nextRuntimeFamily && nextRuntimeFamily !== selectedRuntimeFamily) {
      setSelectedRuntimeFamily(nextRuntimeFamily);
    }
  }, [backendConfig, viewerRole, selectedRuntimeFamily]);

  useEffect(() => {
    if (!backendConfig) return;
    const nextTarget = pickExecutionTargetSelection(
      backendConfig,
      viewerRole,
      selectedExecutionTarget,
      runtimeFamilyLocked || activeRuntimeFamily?.id || selectedRuntimeFamily,
    );
    if (nextTarget && nextTarget !== selectedExecutionTarget) {
      setSelectedExecutionTarget(nextTarget);
    }
  }, [
    backendConfig,
    viewerRole,
    runtimeFamilyLocked,
    selectedExecutionTarget,
    activeRuntimeFamily?.id,
    selectedRuntimeFamily,
  ]);

  useEffect(() => {
    const candidateSandboxProfiles = isAdmin
      ? (activeExecutionTarget?.sandboxProfiles || []).filter((profile) => profile.enabled)
      : visibleSandboxOptions;
    if (!candidateSandboxProfiles.length) return;

    const current = candidateSandboxProfiles.find(
      (profile) => profile.id === selectedSandboxProfile,
    );
    const nextSandboxProfile =
      current ||
      candidateSandboxProfiles.find((profile) => profile.available && profile.isDefault) ||
      candidateSandboxProfiles.find((profile) => profile.available) ||
      candidateSandboxProfiles[0] ||
      null;

    if (nextSandboxProfile && nextSandboxProfile.id !== selectedSandboxProfile) {
      setSelectedSandboxProfile(nextSandboxProfile.id);
    }

    if (
      nextSandboxProfile?.id === "nemoclaw" &&
      nextSandboxProfile.defaultModel &&
      !selectedModel
    ) {
      setSelectedModel(nextSandboxProfile.defaultModel);
    }
  }, [
    activeExecutionTarget,
    isAdmin,
    selectedModel,
    selectedSandboxProfile,
    visibleSandboxOptions,
  ]);

  function goToClawHubSelection() {
    if (atLimit) return;
    if (deploymentMode === "migrate" && !migrationDraft?.id) {
      toast.error("Prepare a migration draft before deploying.");
      return;
    }
    const normalizedResources = normalizeDeployDraftResources(
      {
        vcpu: selVcpu,
        ramMb: selRam,
        diskGb: selDisk,
      } as any,
      {
        defaultVcpu: deploymentDefaults.vcpu,
        defaultRamMb: deploymentDefaults.ram_mb,
        defaultDiskGb: deploymentDefaults.disk_gb,
        maxVcpu: platformConfig?.selfhosted?.max_vcpu || 16,
        maxRamMb: platformConfig?.selfhosted?.max_ram_mb || 32768,
        maxDiskGb: platformConfig?.selfhosted?.max_disk_gb || 500,
      },
    );

    saveDeployDraft({
      name,
      containerName,
      runtimeFamily: effectiveRuntimeFamily,
      deployTarget: selectedExecutionTarget,
      sandboxProfile: selectedSandboxProfile || "standard",
      model: isNemoClaw && selectedModel ? selectedModel : "",
      deploymentMode,
      migrationMethod,
      migrationDraft,
      migrationSource,
      vcpu: isSelfHosted ? normalizedResources.vcpu : 0,
      ramMb: isSelfHosted ? normalizedResources.ramMb : 0,
      diskGb: isSelfHosted ? normalizedResources.diskGb : 0,
      clawhubSkills: loadDeployDraft()?.clawhubSkills || [],
    });
    router.push("/clawhub");
  }

  async function uploadMigrationFile(file) {
    if (!file) return;
    setMigrationBusyAction("upload");
    try {
      const res = await fetchWithAuth("/api/agent-migrations/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Upload-Filename": file.name,
        },
        body: await file.arrayBuffer(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to import migration bundle");
      }
      setMigrationDraft(data.draft || null);
      setSelectedRuntimeFamily(data.draft?.runtimeFamily || "openclaw");
      setDeploymentMode("migrate");
      toast.success("Migration draft ready");
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to import migration bundle");
    } finally {
      setMigrationBusyAction("");
      if (migrationUploadInputRef.current) {
        migrationUploadInputRef.current.value = "";
      }
    }
  }

  async function handleMigrationUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    await uploadMigrationFile(file);
  }

  async function inspectLiveMigrationSource() {
    const transport = String(migrationSource.transport || "")
      .trim()
      .toLowerCase();
    const runtimeFamily = runtimeFamilyLocked || effectiveRuntimeFamily;

    if (transport === "docker" && !migrationSource.container.trim()) {
      toast.error("Enter the source Docker container id or name.");
      return;
    }

    if (transport === "ssh") {
      if (!migrationSource.host.trim()) {
        toast.error("Enter the source SSH host.");
        return;
      }
      if (!migrationSource.username.trim()) {
        toast.error("Enter the source SSH username.");
        return;
      }
    }

    setMigrationBusyAction("inspect");
    try {
      const payload = {
        runtime_family: runtimeFamily,
        transport,
        ...(migrationSource.name.trim()
          ? { name: migrationSource.name.trim() }
          : name.trim()
            ? { name: name.trim() }
            : {}),
        ...(transport === "docker"
          ? { container_id: migrationSource.container.trim() }
          : {
              host: migrationSource.host.trim(),
              username: migrationSource.username.trim(),
              ...(migrationSource.port.trim()
                ? { port: Number(migrationSource.port) || migrationSource.port.trim() }
                : {}),
              ...(migrationSource.privateKey.trim()
                ? { privateKey: migrationSource.privateKey }
                : {}),
            }),
        ...(migrationSource.workspaceRoot.trim()
          ? { workspace_root: migrationSource.workspaceRoot.trim() }
          : {}),
        ...(runtimeFamily === "openclaw" && migrationSource.agentRoot.trim()
          ? { agent_root: migrationSource.agentRoot.trim() }
          : {}),
        ...(runtimeFamily === "openclaw" && migrationSource.sessionRoot.trim()
          ? { session_root: migrationSource.sessionRoot.trim() }
          : {}),
      };

      const res = await fetchWithAuth("/api/agent-migrations/live-inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to inspect source runtime");
      }

      setMigrationDraft(data.draft || null);
      setSelectedRuntimeFamily(data.draft?.runtimeFamily || runtimeFamily);
      setDeploymentMode("migrate");
      toast.success("Live source inspected");
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to inspect source runtime");
    } finally {
      setMigrationBusyAction("");
    }
  }

  async function discardMigrationDraft() {
    if (!migrationDraft?.id) {
      setMigrationDraft(null);
      return;
    }

    setMigrationBusyAction("discard");
    try {
      const res = await fetchWithAuth(`/api/agent-migrations/${migrationDraft.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to discard migration draft");
      }
      setMigrationDraft(null);
      toast.success("Migration draft cleared");
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to discard migration draft");
    } finally {
      setMigrationBusyAction("");
    }
  }

  const checklist =
    deploymentMode === "migrate"
      ? [
          "Inspect the source runtime or upload a Nora migration bundle first.",
          "Review the imported files, secrets, and warnings before recreating the agent.",
          "Choose the destination execution target and resource profile Nora should own.",
          "After deploy, validate provider keys, logs, files, and runtime health from the agent detail view.",
          isHermes
            ? "Use Files, Hermes WebUI, logs, and terminal to confirm the migrated runtime behaves the same under Nora."
            : "Use Files, chat, logs, and terminal to confirm the migrated runtime behaves the same under Nora.",
        ]
      : [
          "Pick a clear operator-friendly agent name.",
          showRuntimeFamilySelection
            ? "Choose the runtime family and execution target that match your workload."
            : "Choose the execution target that matches your infrastructure.",
          "Size CPU, RAM, and disk for the workload.",
          "After deploy, add or sync your LLM provider key if needed.",
          isHermes
            ? "Open logs and terminal to validate the Hermes runtime immediately."
            : "Open chat, logs, and terminal to validate the runtime immediately.",
        ];

  function executionTargetIcon(targetId) {
    switch (targetId) {
      case "k8s":
        return Boxes;
      case "proxmox":
        return Network;
      default:
        return Server;
    }
  }

  function sandboxIcon(profileId) {
    return profileId === "nemoclaw" ? ShieldCheck : Shield;
  }

  return (
    <Layout>
      <div className="w-full max-w-5xl mx-auto flex flex-col gap-8 sm:gap-10">
        <header className="grid lg:grid-cols-[1.3fr,0.9fr] gap-6 items-start">
          <div className="bg-white border border-slate-200 rounded-[2rem] p-6 sm:p-8 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                <Rocket size={28} strokeWidth={2.5} />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none">
                  {deploymentMode === "migrate" ? "Migrate Existing Agent" : "Deploy New Agent"}
                </h1>
                <p className="text-slate-400 font-medium mt-1">
                  {deploymentMode === "migrate"
                    ? "Inspect an existing OpenClaw or Hermes runtime, then recreate it under Nora control."
                    : isHermes
                      ? "Provision a new Hermes runtime path to your Nora control plane."
                      : "Provision a new OpenClaw runtime path to your Nora control plane."}
                </p>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-5">
              <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-2">
                Fast path to activation
              </p>
              <p className="text-sm text-blue-700/80 leading-relaxed">
                {deploymentMode === "migrate"
                  ? "This flow does not adopt the old runtime in place. Nora inspects the source, stores a migration draft, then recreates the workload as a Nora-managed agent so files, managed secrets, and runtime validation all land in one control surface."
                  : isHermes
                    ? "The goal of this screen is not just deployment - it is a complete first-run loop. Once the agent is live, finish activation by syncing an LLM provider and validating runtime health, logs, and terminal access."
                    : "The goal of this screen is not just deployment - it is a complete first-run loop. Once the agent is live, finish activation by syncing an LLM provider and validating chat, logs, and terminal access."}
              </p>
            </div>
          </div>

          <div
            className={`flex flex-col gap-4 p-6 rounded-[2rem] border ${atLimit ? "bg-red-50 border-red-200" : "bg-slate-900 border-slate-800"}`}
          >
            <div className="flex items-center gap-3">
              {atLimit ? (
                <AlertTriangle size={20} className="text-red-500" />
              ) : (
                <Shield size={20} className="text-blue-400" />
              )}
              <div>
                <p className={`text-sm font-bold ${atLimit ? "text-red-700" : "text-white"}`}>
                  {planLabel} Plan — {agentCount}/{limit} agents used
                </p>
                <p className={`text-xs mt-0.5 ${atLimit ? "text-red-500" : "text-slate-400"}`}>
                  {atLimit
                    ? isSelfHosted
                      ? "Contact your administrator to increase the limit."
                      : "Upgrade your plan to deploy more agents."
                    : `${limit - agentCount} deployment slot${limit - agentCount !== 1 ? "s" : ""} remaining.`}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {checklist.slice(0, 3).map((item) => (
                <div key={item} className="flex items-start gap-2 text-sm text-slate-300">
                  <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </header>

        <div className="grid xl:grid-cols-[1.4fr,0.8fr] gap-8 items-start">
          <div className="bg-white p-6 sm:p-10 rounded-2xl sm:rounded-[2.5rem] border border-slate-200 shadow-2xl shadow-slate-200/50 flex flex-col gap-8">
            <input
              ref={migrationUploadInputRef}
              type="file"
              className="hidden"
              accept=".json,.tgz,.gz,.nora-migration.tgz,.nora-template.json"
              onChange={handleMigrationUpload}
            />

            <div className="rounded-[2rem] border border-slate-200 bg-slate-50 px-5 py-5 sm:px-6 sm:py-6">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-slate-400">
                      Deployment Mode
                    </p>
                    <h2 className="mt-2 text-lg font-black text-slate-900">
                      Start clean or recreate an existing runtime under Nora.
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
                      Blank deploy provisions a fresh agent. Migrate existing inspects an OpenClaw
                      or Hermes runtime, previews the import surface, then deploys a new
                      Nora-managed agent from that draft.
                    </p>
                  </div>
                  {migrationDraft ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">
                        Draft Ready
                      </p>
                      <p className="mt-1 text-sm font-bold text-emerald-900">
                        {migrationDraft.name}
                      </p>
                      <p className="mt-1 text-xs text-emerald-700/80">
                        {formatRuntimeFamilyLabel(migrationDraft.runtimeFamily)} via{" "}
                        {formatMigrationTransportLabel(migrationDraft?.source?.transport)}
                      </p>
                    </div>
                  ) : null}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setDeploymentMode("blank")}
                    className={`rounded-2xl border-2 px-5 py-5 text-left transition-all ${
                      deploymentMode === "blank"
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white">
                        <Rocket size={20} />
                      </div>
                      <div>
                        <p className="text-sm font-black text-slate-900">Blank Deploy</p>
                        <p className="text-xs text-slate-500">
                          Fresh Nora-owned agent with no imported state.
                        </p>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeploymentMode("migrate")}
                    className={`rounded-2xl border-2 px-5 py-5 text-left transition-all ${
                      deploymentMode === "migrate"
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white">
                        <Database size={20} />
                      </div>
                      <div>
                        <p className="text-sm font-black text-slate-900">Migrate Existing</p>
                        <p className="text-xs text-slate-500">
                          Import files, managed state, and supported secrets first.
                        </p>
                      </div>
                    </div>
                  </button>
                </div>

                {deploymentMode === "migrate" ? (
                  <div className="grid gap-5 xl:grid-cols-[0.95fr,1.05fr]">
                    <div className="space-y-4">
                      {runtimeFamilyLocked ? (
                        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
                          <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">
                            Runtime Family Locked
                          </p>
                          <p className="mt-1 text-sm text-blue-800">
                            This draft is locked to{" "}
                            <span className="font-bold">
                              {formatRuntimeFamilyLabel(runtimeFamilyLocked)}
                            </span>
                            . Clear the draft to inspect a different source runtime.
                          </p>
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => setMigrationMethod("upload")}
                          className={`rounded-2xl border px-4 py-4 text-left transition-all ${
                            migrationMethod === "upload"
                              ? "border-blue-500 bg-blue-50"
                              : "border-slate-200 bg-white hover:border-slate-300"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <Upload size={18} className="text-blue-600" />
                            <div>
                              <p className="text-sm font-bold text-slate-900">Upload Bundle</p>
                              <p className="text-xs text-slate-500">
                                Nora export bundle or legacy OpenClaw template JSON.
                              </p>
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setMigrationMethod("live")}
                          className={`rounded-2xl border px-4 py-4 text-left transition-all ${
                            migrationMethod === "live"
                              ? "border-blue-500 bg-blue-50"
                              : "border-slate-200 bg-white hover:border-slate-300"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <RefreshCw size={18} className="text-blue-600" />
                            <div>
                              <p className="text-sm font-bold text-slate-900">Live Pull</p>
                              <p className="text-xs text-slate-500">
                                Inspect a running Docker container or remote host.
                              </p>
                            </div>
                          </div>
                        </button>
                      </div>

                      {migrationMethod === "upload" ? (
                        <div className="rounded-2xl border border-slate-200 bg-white p-5">
                          <p className="text-xs font-black uppercase tracking-widest text-slate-400">
                            Upload Migration Bundle
                          </p>
                          <h3 className="mt-2 text-base font-black text-slate-900">
                            Import an existing Nora bundle or OpenClaw template snapshot.
                          </h3>
                          <p className="mt-2 text-sm leading-relaxed text-slate-500">
                            Upload Nora migration bundles, Nora legacy template JSON, or previous
                            exports from another Nora control plane. Nora will parse the package,
                            summarize the managed state, and keep the source runtime family aligned
                            for deploy.
                          </p>
                          <div className="mt-4 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={() => migrationUploadInputRef.current?.click()}
                              disabled={migrationBusyAction === "upload"}
                              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition-all hover:bg-slate-800 disabled:opacity-50"
                            >
                              {migrationBusyAction === "upload" ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Upload size={14} />
                              )}
                              {migrationDraft ? "Replace Draft From File" : "Choose Bundle"}
                            </button>
                            <span className="text-xs text-slate-500">
                              Accepted: `.nora-migration.tgz`, `.json`, or legacy template files.
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setMigrationSource((current) => ({
                                  ...current,
                                  transport: "docker",
                                }))
                              }
                              className={`rounded-xl px-3 py-2 text-xs font-bold transition-all ${
                                migrationSource.transport === "docker"
                                  ? "bg-blue-600 text-white"
                                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                              }`}
                            >
                              Docker Source
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setMigrationSource((current) => ({
                                  ...current,
                                  transport: "ssh",
                                }))
                              }
                              className={`rounded-xl px-3 py-2 text-xs font-bold transition-all ${
                                migrationSource.transport === "ssh"
                                  ? "bg-blue-600 text-white"
                                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                              }`}
                            >
                              SSH Source
                            </button>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <label className="flex flex-col gap-2">
                              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                Imported Name
                              </span>
                              <input
                                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
                                placeholder="Optional source label override"
                                value={migrationSource.name}
                                onChange={(event) =>
                                  setMigrationSource((current) => ({
                                    ...current,
                                    name: event.target.value,
                                  }))
                                }
                              />
                            </label>

                            {migrationSource.transport === "docker" ? (
                              <label className="flex flex-col gap-2">
                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                  Container ID or Name
                                </span>
                                <input
                                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
                                  placeholder="e.g. hermes-agent-prod"
                                  value={migrationSource.container}
                                  onChange={(event) =>
                                    setMigrationSource((current) => ({
                                      ...current,
                                      container: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                            ) : (
                              <label className="flex flex-col gap-2">
                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                  Host
                                </span>
                                <input
                                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
                                  placeholder="source.example.com"
                                  value={migrationSource.host}
                                  onChange={(event) =>
                                    setMigrationSource((current) => ({
                                      ...current,
                                      host: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                            )}
                          </div>

                          {migrationSource.transport === "ssh" ? (
                            <>
                              <div className="grid gap-3 md:grid-cols-[0.8fr,0.4fr]">
                                <label className="flex flex-col gap-2">
                                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                    Username
                                  </span>
                                  <input
                                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
                                    placeholder="root"
                                    value={migrationSource.username}
                                    onChange={(event) =>
                                      setMigrationSource((current) => ({
                                        ...current,
                                        username: event.target.value,
                                      }))
                                    }
                                  />
                                </label>
                                <label className="flex flex-col gap-2">
                                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                    Port
                                  </span>
                                  <input
                                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
                                    placeholder="22"
                                    value={migrationSource.port}
                                    onChange={(event) =>
                                      setMigrationSource((current) => ({
                                        ...current,
                                        port: event.target.value,
                                      }))
                                    }
                                  />
                                </label>
                              </div>
                              <label className="flex flex-col gap-2">
                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                  Private Key
                                </span>
                                <textarea
                                  rows={6}
                                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-mono text-slate-900 outline-none focus:border-blue-400 focus:bg-white"
                                  placeholder="Optional if the Nora host already has SSH access to the source."
                                  value={migrationSource.privateKey}
                                  onChange={(event) =>
                                    setMigrationSource((current) => ({
                                      ...current,
                                      privateKey: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                            </>
                          ) : null}

                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                              Optional Root Overrides
                            </p>
                            <p className="mt-2 text-sm text-slate-500">
                              Leave these blank to use Nora&apos;s standard import paths.
                            </p>
                            <div className="mt-3 grid gap-3">
                              <label className="flex flex-col gap-2">
                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                  Workspace Root
                                </span>
                                <input
                                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-mono text-slate-900 outline-none focus:border-blue-400"
                                  placeholder={
                                    effectiveRuntimeFamily === "hermes"
                                      ? "/opt/data/workspace"
                                      : "/root/.openclaw/workspace"
                                  }
                                  value={migrationSource.workspaceRoot}
                                  onChange={(event) =>
                                    setMigrationSource((current) => ({
                                      ...current,
                                      workspaceRoot: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              {effectiveRuntimeFamily === "openclaw" ? (
                                <>
                                  <label className="flex flex-col gap-2">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                      Agent Root
                                    </span>
                                    <input
                                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-mono text-slate-900 outline-none focus:border-blue-400"
                                      placeholder="/root/.openclaw/agents/main/agent"
                                      value={migrationSource.agentRoot}
                                      onChange={(event) =>
                                        setMigrationSource((current) => ({
                                          ...current,
                                          agentRoot: event.target.value,
                                        }))
                                      }
                                    />
                                  </label>
                                  <label className="flex flex-col gap-2">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                      Session Root
                                    </span>
                                    <input
                                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-mono text-slate-900 outline-none focus:border-blue-400"
                                      placeholder="/root/.openclaw/agents/main/sessions"
                                      value={migrationSource.sessionRoot}
                                      onChange={(event) =>
                                        setMigrationSource((current) => ({
                                          ...current,
                                          sessionRoot: event.target.value,
                                        }))
                                      }
                                    />
                                  </label>
                                </>
                              ) : null}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={inspectLiveMigrationSource}
                            disabled={migrationBusyAction === "inspect"}
                            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition-all hover:bg-slate-800 disabled:opacity-50"
                          >
                            {migrationBusyAction === "inspect" ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Download size={14} />
                            )}
                            {migrationDraft ? "Refresh Live Draft" : "Inspect Live Source"}
                          </button>
                        </div>
                      )}
                    </div>

                    <MigrationDraftPreview
                      draft={migrationDraft}
                      busyAction={migrationBusyAction}
                      onDiscard={discardMigrationDraft}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">
                {deploymentMode === "migrate" ? "Destination Agent Name" : "Agent Name"}
              </label>
              <input
                className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none transition-all focus:ring-2 focus:ring-blue-500/20 focus:bg-white focus:border-blue-500/40 placeholder:text-slate-400"
                placeholder="e.g. customer-support-operator"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-xs text-slate-500 ml-2">
                {deploymentMode === "migrate"
                  ? "Choose the name Nora should use for the recreated agent. The imported source name can stay as-is or be replaced here."
                  : "Choose a name other operators will understand at a glance."}{" "}
                Example container slug: <span className="font-mono">{suggestedContainerName}</span>
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    Runtime Family
                  </p>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600">
                    {activeRuntimeFamily?.contractStatusLabel ||
                      defaultRuntimeFamily?.contractStatusLabel ||
                      "Stable contract"}
                  </span>
                </div>
                <p className="text-sm font-bold text-slate-900 mt-2">
                  {activeRuntimeFamily?.label || formatRuntimeFamilyLabel(effectiveRuntimeFamily)}
                </p>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  {runtimeFamilyLocked
                    ? `The current migration draft was captured from ${formatRuntimeFamilyLabel(runtimeFamilyLocked)}. Nora keeps the runtime family aligned while you choose the destination execution target and sandbox profile.`
                    : activeRuntimeFamily?.operatorContractSummary ||
                      "Nora keeps the operator workflow fixed while you choose where the runtime executes and which sandbox profile it uses."}
                </p>
                <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                  {activeRuntimeFamily?.expansionPolicy}
                </p>
              </div>
              {runtimeFamilyLocked ? (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">
                    Runtime Family Locked
                  </p>
                  <p className="mt-2 text-sm font-bold text-blue-900">
                    {formatRuntimeFamilyLabel(runtimeFamilyLocked)}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-blue-700/80">
                    Clear the migration draft to switch between OpenClaw and Hermes on this screen.
                  </p>
                </div>
              ) : showRuntimeFamilySelection ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {visibleRuntimeFamilies.map((family) => {
                    const isSelected = selectedRuntimeFamily === family.id;
                    const isAvailable = family.available;

                    return (
                      <button
                        key={family.id}
                        type="button"
                        onClick={() => {
                          if (isAvailable) setSelectedRuntimeFamily(family.id);
                        }}
                        className={`relative p-5 rounded-2xl border-2 text-left transition-all ${
                          !isAvailable
                            ? "border-slate-200 bg-slate-100 opacity-70 cursor-not-allowed"
                            : isSelected
                              ? "border-blue-500 bg-blue-50"
                              : "border-slate-200 bg-slate-50 hover:border-slate-300"
                        }`}
                        disabled={!isAvailable}
                      >
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <span className="text-sm font-bold text-slate-900">{family.label}</span>
                          <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-1 text-[10px] font-bold text-slate-600 border border-slate-200">
                            {family.contractStatusLabel}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          {family.summary}
                        </p>
                        {!isAvailable && family.issue ? (
                          <p className="text-[10px] text-amber-600 font-medium mt-2">
                            {family.issue}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">
                Container Name{" "}
                <span className="text-slate-300 font-medium normal-case tracking-normal">
                  (optional)
                </span>
              </label>
              <input
                className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 font-mono outline-none transition-all focus:ring-2 focus:ring-blue-500/20 focus:bg-white focus:border-blue-500/40 placeholder:text-slate-400 placeholder:font-sans"
                placeholder={suggestedContainerName}
                value={containerName}
                onChange={(e) => setContainerName(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">
                Execution Target
              </label>
              <div
                className={`grid grid-cols-1 ${visibleExecutionTargets.length > 2 ? "md:grid-cols-2" : "md:grid-cols-2"} gap-3`}
              >
                {visibleExecutionTargets.map((target) => {
                  const Icon = executionTargetIcon(target.id);
                  const isSelected = selectedExecutionTarget === target.id;
                  const isAvailable = target.available;
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => {
                        if (isAvailable) setSelectedExecutionTarget(target.id);
                      }}
                      className={`relative p-5 rounded-2xl border-2 text-left transition-all ${
                        !isAvailable
                          ? "border-slate-200 bg-slate-100 opacity-70 cursor-not-allowed"
                          : isSelected
                            ? "border-blue-500 bg-blue-50"
                            : "border-slate-200 bg-slate-50 hover:border-slate-300"
                      }`}
                      disabled={!isAvailable}
                    >
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2">
                          <Icon
                            size={16}
                            className={!isAvailable ? "text-slate-400" : "text-blue-600"}
                          />
                          <span className="text-sm font-bold text-slate-900">{target.label}</span>
                        </div>
                        <MaturityBadge
                          maturityTier={target.maturityTier}
                          maturityLabel={target.maturityLabel}
                        />
                      </div>
                      <p className="text-[11px] text-slate-500 leading-relaxed">{target.summary}</p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-1 text-[10px] font-bold text-slate-600 border border-slate-200">
                          {target.runtimeFamilyLabel || "OpenClaw"}
                        </span>
                        {target.supportsSandboxSelection ? (
                          <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-1 text-[10px] font-bold text-slate-600 border border-slate-200">
                            Sandbox choice available
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-1 text-[10px] font-bold text-slate-600 border border-slate-200">
                            {`Sandbox: ${target.defaultSandboxProfile === "nemoclaw" ? "NemoClaw" : "Standard"}`}
                          </span>
                        )}
                      </div>
                      {!isAvailable && target.issue ? (
                        <p className="text-[10px] text-amber-600 font-medium mt-2">
                          {target.issue}
                        </p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {visibleExecutionTargets.length === 0 ? (
                <p className="text-xs text-amber-600 ml-2">
                  {isAdmin
                    ? "No execution targets are enabled for this Nora control plane."
                    : "No onboarding-ready execution targets are enabled for this Nora control plane."}
                </p>
              ) : null}
            </div>

            {showSandboxSelection && (
              <div className="flex flex-col gap-3">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">
                  Sandbox
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {visibleSandboxOptions.map((profile) => {
                    const Icon = sandboxIcon(profile.id);
                    const isSelected = selectedSandboxProfile === profile.id;
                    const isAvailable = profile.available;

                    return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => {
                          if (isAvailable) setSelectedSandboxProfile(profile.id);
                        }}
                        className={`relative p-5 rounded-2xl border-2 text-left transition-all ${
                          !isAvailable
                            ? "border-slate-200 bg-slate-100 opacity-70 cursor-not-allowed"
                            : isSelected
                              ? profile.id === "nemoclaw"
                                ? "border-green-500 bg-green-50"
                                : "border-blue-500 bg-blue-50"
                              : "border-slate-200 bg-slate-50 hover:border-slate-300"
                        }`}
                        disabled={!isAvailable}
                      >
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <div className="flex items-center gap-2">
                            <Icon
                              size={16}
                              className={
                                !isAvailable
                                  ? "text-slate-400"
                                  : profile.id === "nemoclaw"
                                    ? "text-green-600"
                                    : "text-blue-600"
                              }
                            />
                            <span className="text-sm font-bold text-slate-900">
                              {profile.label}
                            </span>
                          </div>
                          <MaturityBadge
                            maturityTier={profile.maturityTier}
                            maturityLabel={profile.maturityLabel}
                          />
                        </div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          {profile.summary}
                        </p>
                        {!isAvailable && profile.issue ? (
                          <p className="text-[10px] text-amber-600 font-medium mt-2">
                            {profile.issue}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {isNemoClaw && activeSandboxOption?.models?.length > 0 && (
              <div className="flex flex-col gap-3">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">
                  Nemotron Model
                </label>
                <div className="flex items-center gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-2xl">
                  <Brain size={16} className="text-green-600 shrink-0" />
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="flex-1 bg-transparent text-sm font-bold text-slate-900 outline-none"
                  >
                    {activeSandboxOption.models.map((model) => (
                      <option key={model} value={model}>
                        {model.replace("nvidia/", "")}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-4 text-[10px] text-green-700 font-medium ml-2 flex-wrap">
                  <span className="flex items-center gap-1">
                    <ShieldCheck size={10} /> Deny-by-default network
                  </span>
                  <span className="flex items-center gap-1">
                    <Shield size={10} /> Capability-restricted
                  </span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-5 rounded-2xl bg-slate-50 border border-slate-100 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-blue-600">
                  <Cpu size={16} />
                  <span className="text-[10px] font-black uppercase tracking-widest">vCPU</span>
                </div>
                {isSelfHosted ? (
                  <select
                    value={selVcpu}
                    onChange={(e) => {
                      resourceSelectionDirtyRef.current = true;
                      setSelVcpu(Number(e.target.value));
                    }}
                    className="text-xl font-black text-slate-900 bg-transparent outline-none"
                  >
                    {Array.from(
                      { length: platformConfig?.selfhosted?.max_vcpu || 16 },
                      (_, i) => i + 1,
                    ).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xl font-black text-slate-900">
                    {sub?.vcpu || deploymentDefaults.vcpu}
                  </span>
                )}
                <span className="text-[10px] text-slate-400 font-medium">cores</span>
              </div>
              <div className="p-5 rounded-2xl bg-slate-50 border border-slate-100 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-emerald-600">
                  <MemoryStick size={16} />
                  <span className="text-[10px] font-black uppercase tracking-widest">RAM</span>
                </div>
                {isSelfHosted ? (
                  <select
                    value={selRam}
                    onChange={(e) => {
                      resourceSelectionDirtyRef.current = true;
                      setSelRam(Number(e.target.value));
                    }}
                    className="text-xl font-black text-slate-900 bg-transparent outline-none"
                  >
                    {ramOptions.map((value) => (
                      <option key={value} value={value}>
                        {value >= 1024 ? `${value / 1024} GB` : `${value} MB`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xl font-black text-slate-900">
                    {(sub?.ram_mb || deploymentDefaults.ram_mb) / 1024}
                  </span>
                )}
                <span className="text-[10px] text-slate-400 font-medium">GB</span>
              </div>
              <div className="p-5 rounded-2xl bg-slate-50 border border-slate-100 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-purple-600">
                  <HardDrive size={16} />
                  <span className="text-[10px] font-black uppercase tracking-widest">Disk</span>
                </div>
                {isSelfHosted ? (
                  <select
                    value={selDisk}
                    onChange={(e) => {
                      resourceSelectionDirtyRef.current = true;
                      setSelDisk(Number(e.target.value));
                    }}
                    className="text-xl font-black text-slate-900 bg-transparent outline-none"
                  >
                    {diskOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xl font-black text-slate-900">
                    {sub?.disk_gb || deploymentDefaults.disk_gb}
                  </span>
                )}
                <span className="text-[10px] text-slate-400 font-medium">GB SSD</span>
              </div>
            </div>

            <button
              onClick={goToClawHubSelection}
              disabled={
                loading ||
                atLimit ||
                !name.trim() ||
                !canDeployExecutionTarget ||
                (deploymentMode === "migrate" && !migrationDraft?.id)
              }
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 transition-all text-sm font-black text-white px-8 py-5 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95 disabled:opacity-50 group"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <CheckCircle2 size={18} className="group-hover:scale-125 transition-transform" />
              )}
              {atLimit
                ? "Agent Limit Reached"
                : deploymentMode === "migrate" && !migrationDraft?.id
                  ? "Prepare Migration Draft First"
                  : !canDeployExecutionTarget
                    ? "Selected Runtime Path Unavailable"
                    : deploymentMode === "migrate"
                      ? "Next: Choose Skills"
                      : "Next: Choose Skills"}
            </button>
          </div>

          <div className="flex flex-col gap-6">
            <div
              className={`flex items-start gap-4 p-6 border rounded-[2rem] ${isNemoClaw ? "bg-green-50 border-green-100" : isHermes ? "bg-cyan-50 border-cyan-100" : "bg-blue-50 border-blue-100"}`}
            >
              {isNemoClaw ? (
                <ShieldCheck size={24} className="text-green-600 flex-shrink-0" />
              ) : (
                <Server
                  size={24}
                  className={`${isHermes ? "text-cyan-600" : "text-blue-600"} flex-shrink-0`}
                />
              )}
              <div>
                <p
                  className={`text-xs font-black uppercase tracking-widest mb-2 ${isNemoClaw ? "text-green-700" : isHermes ? "text-cyan-700" : "text-blue-700"}`}
                >
                  {deploymentMode === "migrate"
                    ? "Destination Runtime Summary"
                    : "Runtime Path Summary"}
                </p>
                <p
                  className={`text-sm font-medium leading-relaxed ${isNemoClaw ? "text-green-700" : isHermes ? "text-cyan-700" : "text-blue-700"}`}
                >
                  {activeSandboxOption?.detail ||
                    activeExecutionTarget?.detail ||
                    "Select an enabled execution target to see the runtime summary."}
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <span
                    className={`text-xs font-bold ${isNemoClaw ? "text-green-700/80" : isHermes ? "text-cyan-700/80" : "text-blue-700/80"}`}
                  >
                    {(activeExecutionTarget?.runtimeFamilyLabel ||
                      activeRuntimeFamily?.label ||
                      defaultRuntimeFamily?.label ||
                      "OpenClaw") +
                      " runtime" +
                      " • " +
                      (activeExecutionTarget?.label || "Docker") +
                      " target" +
                      " • " +
                      ((activeSandboxOption?.label || "Standard") + " sandbox")}
                  </span>
                  <MaturityBadge
                    maturityTier={
                      activeSandboxOption?.maturityTier || activeExecutionTarget?.maturityTier
                    }
                    maturityLabel={
                      activeSandboxOption?.maturityLabel || activeExecutionTarget?.maturityLabel
                    }
                  />
                </div>
                {isAdmin && activeExecutionTarget?.maturityTier === "blocked" ? (
                  <p className="text-[11px] text-red-700 mt-2 leading-relaxed">
                    Blocked targets stay visible to admins for release awareness, but they remain
                    disabled for onboarding and deployment.
                  </p>
                ) : null}
                {deploymentMode === "migrate" && migrationDraft ? (
                  <p className="text-[11px] mt-2 leading-relaxed text-inherit">
                    Source draft:{" "}
                    <span className="font-bold">
                      {migrationDraft?.source?.label || migrationDraft.name}
                    </span>
                  </p>
                ) : null}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-[2rem] p-6 shadow-sm">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">
                What happens next
              </p>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                    <KeyRound size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">1. Verify provider keys</p>
                    <p className="text-sm text-slate-500 leading-relaxed">
                      {deploymentMode === "migrate"
                        ? "Nora imports supported provider and secret material into managed storage. Review the result in Settings before deeper testing."
                        : "If your agent needs model access, add or sync an LLM provider in Settings before deeper testing."}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <MessagesSquare size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">2. Validate the runtime</p>
                    <p className="text-sm text-slate-500 leading-relaxed">
                      {deploymentMode === "migrate"
                        ? "After deploy, Nora sends you straight to the recreated agent so you can compare files, logs, and runtime behavior without leaving the operator flow."
                        : isHermes
                          ? "After deploy, Nora sends you straight to the new agent so you can verify runtime health, logs, and terminal access without hunting for the next screen."
                          : "After deploy, Nora sends you straight to the new agent so you can verify chat, logs, and terminal without hunting for the next screen."}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
                    <Shield size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">3. Move into operations</p>
                    <p className="text-sm text-slate-500 leading-relaxed">
                      {deploymentMode === "migrate"
                        ? "Once the recreated agent is healthy, treat the old runtime as legacy and keep the Nora-managed version as the operational source of truth."
                        : "Once the first agent is healthy, use Nora for channels, integrations, scheduling, and broader fleet management."}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-[2rem] p-6">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">
                Operator checklist
              </p>
              <div className="space-y-3">
                {checklist.map((item) => (
                  <div key={item} className="flex items-start gap-2 text-sm text-slate-300">
                    <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function MigrationDraftPreview({ draft, busyAction, onDiscard }) {
  if (!draft) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5">
        <p className="text-xs font-black uppercase tracking-widest text-slate-400">
          Migration Preview
        </p>
        <h3 className="mt-2 text-base font-black text-slate-900">No draft prepared yet.</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          Upload a Nora export bundle or inspect a live Docker or SSH source to preview files,
          imported channels, provider keys, warnings, and the runtime family Nora will recreate.
        </p>
      </div>
    );
  }

  const isHermesDraft = draft.runtimeFamily === "hermes";
  const managedWiringCount =
    Number(draft.summary?.integrationCount || 0) + Number(draft.summary?.channelCount || 0);
  const sourceKindLabel =
    draft?.source?.kind === "docker" || draft?.source?.kind === "ssh"
      ? "Live source"
      : draft?.source?.kind === "legacy-template"
        ? "Legacy template upload"
        : draft?.source?.kind === "nora-agent"
          ? "Nora export"
          : "Uploaded bundle";
  const statCards = isHermesDraft
    ? [
        {
          label: "Workspace Files",
          value: draft.hermes?.fileCount || draft.summary?.hermesFileCount || 0,
        },
        {
          label: "Hermes Channels",
          value: draft.hermes?.channels?.length || draft.summary?.hermesChannelCount || 0,
        },
        {
          label: "LLM Providers",
          value: draft.summary?.llmProviderCount || 0,
        },
        {
          label: "Secret Overrides",
          value: draft.summary?.agentSecretCount || 0,
        },
      ]
    : [
        {
          label: "Agent Files",
          value: draft.openclaw?.fileCount || draft.summary?.fileCount || 0,
        },
        {
          label: "Session Memory",
          value: draft.openclaw?.memoryFileCount || draft.summary?.memoryFileCount || 0,
        },
        {
          label: "LLM Providers",
          value: draft.summary?.llmProviderCount || 0,
        },
        {
          label: "Managed Wiring",
          value: managedWiringCount,
        },
      ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-slate-400">
            Migration Preview
          </p>
          <h3 className="mt-2 text-base font-black text-slate-900">{draft.name}</h3>
          <p className="mt-1 text-sm text-slate-500">
            {formatRuntimeFamilyLabel(draft.runtimeFamily)} from{" "}
            <span className="font-bold text-slate-700">
              {draft.source?.label || "Imported source"}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busyAction === "discard"}
          className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 transition-all hover:bg-red-100 disabled:opacity-50"
        >
          {busyAction === "discard" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Trash2 size={14} />
          )}
          Clear Draft
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Source</p>
          <p className="mt-2 text-sm font-bold text-slate-900">
            {formatMigrationTransportLabel(draft?.source?.transport)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">{sourceKindLabel}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            Draft Expires
          </p>
          <p className="mt-2 text-sm font-bold text-slate-900">{formatDateTime(draft.expiresAt)}</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Deploy attaches this draft to the new agent and clears the expiry.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {statCards.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
          >
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              {item.label}
            </p>
            <p className="mt-2 text-2xl font-black text-slate-900">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-slate-900">
            <Database size={16} className="text-blue-600" />
            <p className="text-sm font-black">Managed State</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(draft.managed?.llmProviders || []).map((entry) => (
              <span
                key={`provider-${entry.provider}`}
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200"
              >
                LLM: {entry.provider}
              </span>
            ))}
            {(draft.managed?.integrations || []).map((entry) => (
              <span
                key={`integration-${entry.provider}`}
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200"
              >
                Integration: {entry.provider}
              </span>
            ))}
            {(draft.managed?.channels || []).map((entry) => (
              <span
                key={`channel-${entry.type}-${entry.name}`}
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200"
              >
                Channel: {entry.type}
              </span>
            ))}
            {(draft.managed?.agentSecretOverrides || []).map((entry) => (
              <span
                key={`secret-${entry.key}`}
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200"
              >
                Secret: {entry.key}
              </span>
            ))}
            {!draft.managed?.llmProviders?.length &&
            !draft.managed?.integrations?.length &&
            !draft.managed?.channels?.length &&
            !draft.managed?.agentSecretOverrides?.length ? (
              <p className="text-sm text-slate-500">
                No Nora-managed records were detected in this source. Nora will still import files
                and any supported runtime state it can see.
              </p>
            ) : null}
          </div>
        </div>

        {isHermesDraft ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-slate-900">
              <MessagesSquare size={16} className="text-blue-600" />
              <p className="text-sm font-black">Hermes Runtime Seed</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {draft.hermes?.modelConfig?.defaultModel ? (
                <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200">
                  Model: {draft.hermes.modelConfig.defaultModel}
                </span>
              ) : null}
              {draft.hermes?.modelConfig?.provider ? (
                <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200">
                  Provider: {draft.hermes.modelConfig.provider}
                </span>
              ) : null}
              {(draft.hermes?.channels || []).map((entry) => (
                <span
                  key={`hermes-${entry.type}`}
                  className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 border border-slate-200"
                >
                  Hermes: {entry.type}
                </span>
              ))}
              {!draft.hermes?.modelConfig?.defaultModel &&
              !draft.hermes?.modelConfig?.provider &&
              !(draft.hermes?.channels || []).length ? (
                <p className="text-sm text-slate-500">
                  No persisted Hermes model or channel state was detected.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-slate-900">
              <FolderTree size={16} className="text-blue-600" />
              <p className="text-sm font-black">OpenClaw Import Surface</p>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">
              Nora imports the agent files, workspace contents, session memory, and supported
              provider material from the source runtime. Deploy target and sandbox profile remain
              operator-controlled on this screen.
            </p>
          </div>
        )}

        <div
          className={`rounded-2xl border p-4 ${
            (draft.warnings || []).length > 0
              ? "border-amber-200 bg-amber-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
        >
          <div className="flex items-center gap-2">
            <KeyRound
              size={16}
              className={(draft.warnings || []).length > 0 ? "text-amber-600" : "text-emerald-600"}
            />
            <p className="text-sm font-black text-slate-900">Warnings</p>
          </div>
          {(draft.warnings || []).length > 0 ? (
            <div className="mt-3 space-y-2">
              {draft.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`} className="text-sm text-amber-800">
                  <span className="font-bold">{warning.path ? `${warning.path}: ` : ""}</span>
                  {warning.message}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-emerald-800">
              No import warnings were raised for this draft.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
