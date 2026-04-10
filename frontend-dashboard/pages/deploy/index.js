import Layout from "../../components/layout/Layout";
import { useState, useEffect, useMemo, useRef } from "react";
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
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";

function slugifyName(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export default function Deploy() {
  const [name, setName] = useState("");
  const [containerName, setContainerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [sub, setSub] = useState(null);
  const [agentCount, setAgentCount] = useState(0);
  const [selectedBackend, setSelectedBackend] = useState("");
  const [backendConfig, setBackendConfig] = useState(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [platformConfig, setPlatformConfig] = useState(null);
  const [selVcpu, setSelVcpu] = useState(1);
  const [selRam, setSelRam] = useState(1024);
  const [selDisk, setSelDisk] = useState(10);
  const resourceDefaultsInitializedRef = useRef(false);
  const resourceSelectionDirtyRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    fetchWithAuth("/api/billing/subscription")
      .then((r) => r.json())
      .then(setSub)
      .catch((err) => console.error(err));
    fetchWithAuth("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgentCount(Array.isArray(data) ? data.length : 0))
      .catch((err) => console.error(err));
    fetch("/api/config/backends")
      .then((r) => r.json())
      .then(setBackendConfig)
      .catch(() => {});
    fetch("/api/config/platform")
      .then((r) => r.json())
      .then(setPlatformConfig)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const backends = backendConfig?.backends || [];
    if (!backends.length) return;

    const current = backends.find((backend) => backend.id === selectedBackend);
    const nextBackend =
      (current && current.enabled ? current : null) ||
      backends.find((backend) => backend.available && backend.isDefault) ||
      backends.find((backend) => backend.available) ||
      backends.find((backend) => backend.enabled) ||
      null;

    if (nextBackend && nextBackend.id !== selectedBackend) {
      setSelectedBackend(nextBackend.id);
    }

    if (
      nextBackend?.id === "nemoclaw" &&
      nextBackend.defaultModel &&
      !selectedModel
    ) {
      setSelectedModel(nextBackend.defaultModel);
    }
  }, [backendConfig, selectedBackend, selectedModel]);

  const deploymentDefaults = platformConfig?.deploymentDefaults || {
    vcpu: 1,
    ram_mb: 1024,
    disk_gb: 10,
  };

  useEffect(() => {
    if (
      !platformConfig?.deploymentDefaults ||
      resourceDefaultsInitializedRef.current ||
      resourceSelectionDirtyRef.current
    ) {
      return;
    }

    setSelVcpu(deploymentDefaults.vcpu);
    setSelRam(deploymentDefaults.ram_mb);
    setSelDisk(deploymentDefaults.disk_gb);
    resourceDefaultsInitializedRef.current = true;
  }, [deploymentDefaults, platformConfig?.deploymentDefaults]);

  const isSelfHosted = platformConfig?.mode !== "paas";
  const plan = sub?.plan || "free";
  const planLabel = isSelfHosted ? "Self-hosted" : plan.charAt(0).toUpperCase() + plan.slice(1);
  const limit = isSelfHosted ? (platformConfig?.selfhosted?.max_agents || 50) : (sub?.agent_limit || 3);
  const atLimit = agentCount >= limit;
  const enabledBackends = useMemo(
    () => (backendConfig?.backends || []).filter((backend) => backend.enabled),
    [backendConfig]
  );
  const activeBackend = useMemo(
    () => enabledBackends.find((backend) => backend.id === selectedBackend) || null,
    [enabledBackends, selectedBackend]
  );
  const ramOptions = useMemo(() => {
    const maxRam = platformConfig?.selfhosted?.max_ram_mb || 32768;
    return Array.from(
      new Set(
        [selRam, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].filter(
          (value) => value <= maxRam || value === selRam
        )
      )
    ).sort((left, right) => left - right);
  }, [platformConfig?.selfhosted?.max_ram_mb, selRam]);
  const diskOptions = useMemo(() => {
    const maxDisk = platformConfig?.selfhosted?.max_disk_gb || 500;
    return Array.from(
      new Set(
        [selDisk, 10, 20, 50, 100, 200, 500, 1000].filter(
          (value) => value <= maxDisk || value === selDisk
        )
      )
    ).sort((left, right) => left - right);
  }, [platformConfig?.selfhosted?.max_disk_gb, selDisk]);
  const canDeployBackend = Boolean(activeBackend?.available);
  const isNemoClaw = activeBackend?.id === "nemoclaw";
  const suggestedContainerName = useMemo(() => {
    const slug = slugifyName(name);
    return slug ? `nora-${slug}` : "nora-my-first-agent";
  }, [name]);

  async function deploy() {
    if (atLimit) return;
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/agents/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          backend: selectedBackend,
          ...(containerName.trim() ? { container_name: containerName.trim() } : {}),
          ...(isNemoClaw && selectedModel ? { model: selectedModel } : {}),
          ...(isSelfHosted ? { vcpu: selVcpu, ram_mb: selRam, disk_gb: selDisk } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        window.location.href = data?.id ? `/app/agents/${data.id}` : "/app/agents";
      } else if (res.status === 402) {
        toast.error("You've reached your plan's agent limit. Please upgrade.");
      } else {
        toast.error("Deployment failed. Please try again.");
      }
    } catch (err) {
      console.error(err);
      toast.error("Network error during deployment.");
    }
    setLoading(false);
  }

  const checklist = [
    "Pick a clear operator-friendly agent name.",
    "Choose the backend that matches your infrastructure.",
    "Size CPU, RAM, and disk for the workload.",
    "After deploy, add or sync your LLM provider key if needed.",
    "Open chat, logs, and terminal to validate the runtime immediately.",
  ];

  function backendIcon(backendId) {
    switch (backendId) {
      case "k8s":
        return Boxes;
      case "proxmox":
        return Network;
      case "nemoclaw":
        return ShieldCheck;
      default:
        return Server;
    }
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
                <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none">Deploy New Agent</h1>
                <p className="text-slate-400 font-medium mt-1">Provision a new autonomous OpenClaw agent to your Nora control plane.</p>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-5">
              <p className="text-xs font-black uppercase tracking-widest text-blue-700 mb-2">Fast path to activation</p>
              <p className="text-sm text-blue-700/80 leading-relaxed">
                The goal of this screen is not just deployment — it is a complete first-run loop. Once the agent is live, finish activation by syncing an LLM provider and validating chat, logs, and terminal access.
              </p>
            </div>
          </div>

          <div className={`flex flex-col gap-4 p-6 rounded-[2rem] border ${atLimit ? "bg-red-50 border-red-200" : "bg-slate-900 border-slate-800"}`}>
            <div className="flex items-center gap-3">
              {atLimit ? <AlertTriangle size={20} className="text-red-500" /> : <Shield size={20} className="text-blue-400" />}
              <div>
                <p className={`text-sm font-bold ${atLimit ? "text-red-700" : "text-white"}`}>
                  {planLabel} Plan — {agentCount}/{limit} agents used
                </p>
                <p className={`text-xs mt-0.5 ${atLimit ? "text-red-500" : "text-slate-400"}`}>
                  {atLimit
                    ? (isSelfHosted ? "Contact your administrator to increase the limit." : "Upgrade your plan to deploy more agents.")
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
            <div className="flex flex-col gap-3">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">Agent Name</label>
              <input
                className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none transition-all focus:ring-2 focus:ring-blue-500/20 focus:bg-white focus:border-blue-500/40 placeholder:text-slate-400"
                placeholder="e.g. customer-support-operator"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-xs text-slate-500 ml-2">
                Choose a name other operators will understand at a glance. Example container slug: <span className="font-mono">{suggestedContainerName}</span>
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">
                Container Name <span className="text-slate-300 font-medium normal-case tracking-normal">(optional)</span>
              </label>
              <input
                className="w-full px-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 font-mono outline-none transition-all focus:ring-2 focus:ring-blue-500/20 focus:bg-white focus:border-blue-500/40 placeholder:text-slate-400 placeholder:font-sans"
                placeholder={suggestedContainerName}
                value={containerName}
                onChange={(e) => setContainerName(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">Deploy Backend</label>
              <div className={`grid grid-cols-1 ${enabledBackends.length > 2 ? "md:grid-cols-2" : "md:grid-cols-2"} gap-3`}>
                {enabledBackends.map((backend) => {
                  const Icon = backendIcon(backend.id);
                  const isSelected = selectedBackend === backend.id;
                  const isAvailable = backend.available;
                  return (
                    <button
                      key={backend.id}
                      type="button"
                      onClick={() => {
                        if (isAvailable) setSelectedBackend(backend.id);
                      }}
                      className={`relative p-5 rounded-2xl border-2 text-left transition-all ${
                        !isAvailable
                          ? "border-slate-200 bg-slate-100 opacity-70 cursor-not-allowed"
                          : isSelected
                            ? backend.id === "nemoclaw"
                              ? "border-green-500 bg-green-50"
                              : "border-blue-500 bg-blue-50"
                            : "border-slate-200 bg-slate-50 hover:border-slate-300"
                      }`}
                      disabled={!isAvailable}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Icon
                          size={16}
                          className={
                            !isAvailable
                              ? "text-slate-400"
                              : backend.id === "nemoclaw"
                                ? "text-green-600"
                                : "text-blue-600"
                          }
                        />
                        <span className="text-sm font-bold text-slate-900">{backend.label}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 leading-relaxed">
                        {backend.summary}
                      </p>
                      {!isAvailable && backend.issue ? (
                        <p className="text-[10px] text-amber-600 font-medium mt-2">{backend.issue}</p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {enabledBackends.length === 0 ? (
                <p className="text-xs text-amber-600 ml-2">
                  No deploy backends are enabled for this Nora control plane.
                </p>
              ) : null}
            </div>

            {isNemoClaw && activeBackend?.models?.length > 0 && (
              <div className="flex flex-col gap-3">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest leading-none ml-2">Nemotron Model</label>
                <div className="flex items-center gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-2xl">
                  <Brain size={16} className="text-green-600 shrink-0" />
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="flex-1 bg-transparent text-sm font-bold text-slate-900 outline-none"
                  >
                    {activeBackend.models.map((model) => (
                      <option key={model} value={model}>{model.replace("nvidia/", "")}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-4 text-[10px] text-green-700 font-medium ml-2 flex-wrap">
                  <span className="flex items-center gap-1"><ShieldCheck size={10} /> Deny-by-default network</span>
                  <span className="flex items-center gap-1"><Shield size={10} /> Capability-restricted</span>
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
                    {Array.from({ length: platformConfig?.selfhosted?.max_vcpu || 16 }, (_, i) => i + 1).map((v) => (
                      <option key={v} value={v}>{v}</option>
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
              onClick={deploy}
              disabled={loading || atLimit || !name.trim() || !canDeployBackend}
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 transition-all text-sm font-black text-white px-8 py-5 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95 disabled:opacity-50 group"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} className="group-hover:scale-125 transition-transform" />}
              {atLimit ? "Agent Limit Reached" : !canDeployBackend ? "Backend Unavailable" : "Deploy Agent & Open Validation"}
            </button>
          </div>

          <div className="flex flex-col gap-6">
            <div className={`flex items-start gap-4 p-6 border rounded-[2rem] ${isNemoClaw ? "bg-green-50 border-green-100" : "bg-blue-50 border-blue-100"}`}>
              {isNemoClaw ? <ShieldCheck size={24} className="text-green-600 flex-shrink-0" /> : <Server size={24} className="text-blue-600 flex-shrink-0" />}
              <div>
                <p className={`text-xs font-black uppercase tracking-widest mb-2 ${isNemoClaw ? "text-green-700" : "text-blue-700"}`}>
                  Runtime summary
                </p>
                <p className={`text-sm font-medium leading-relaxed ${isNemoClaw ? "text-green-700" : "text-blue-700"}`}>
                  {activeBackend?.detail || "Select an enabled backend to see the runtime summary."}
                </p>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-[2rem] p-6 shadow-sm">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">What happens next</p>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                    <KeyRound size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">1. Verify provider keys</p>
                    <p className="text-sm text-slate-500 leading-relaxed">If your agent needs model access, add or sync an LLM provider in Settings before deeper testing.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <MessagesSquare size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">2. Validate the runtime</p>
                    <p className="text-sm text-slate-500 leading-relaxed">After deploy, Nora sends you straight to the new agent so you can verify chat, logs, and terminal without hunting for the next screen.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
                    <Shield size={18} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-900">3. Move into operations</p>
                    <p className="text-sm text-slate-500 leading-relaxed">Once the first agent is healthy, use Nora for channels, integrations, scheduling, and broader fleet management.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-[2rem] p-6">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-4">Operator checklist</p>
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
