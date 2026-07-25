import { useEffect, useState } from "react";
import Layout from "../components/layout/Layout";
import ActivationChecklist from "../components/onboarding/ActivationChecklist";
import { fetchWithAuth } from "../lib/api";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  FolderKanban,
  KeyRound,
  Loader2,
  Shield,
  Sparkles,
} from "lucide-react";

type DemoAvailability = "loading" | "available" | "unavailable" | "error";

const LOCAL_DOCKER_DEMO_FALLBACK =
  "The zero-key demo requires the OpenClaw runtime, local Docker execution target, and standard sandbox profile to be enabled together.";

// One-click zero-key demo: the backend atomically enables the built-in provider
// and queues one local-Docker agent, then we land on the agent page for chat.
function TryDemoButton({
  availability,
  unavailableReason,
}: {
  availability: DemoAvailability;
  unavailableReason: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const demoAvailable = availability === "available";

  async function startDemo() {
    setBusy(true);
    setError("");
    try {
      const activationRes = await fetchWithAuth("/api/agents/activate-demo", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const agent = await activationRes.json().catch(() => ({}));
      if (!activationRes.ok || !agent.id) {
        throw new Error(
          agent.error ||
            "Could not start the local Docker demo. Make sure Docker is running and Nora can access its socket.",
        );
      }
      window.location.assign(`/app/agents/${agent.id}`);
    } catch (err: any) {
      setError(err?.message || "Demo setup failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={startDemo}
        disabled={busy || !demoAvailable}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-cyan px-4 py-3 text-sm font-black text-brand-ink shadow-lg shadow-brand-cyan/20 transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy || availability === "loading" ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Sparkles size={15} />
        )}
        {busy
          ? "Starting local Docker demo…"
          : availability === "loading"
            ? "Checking local Docker demo…"
            : demoAvailable
              ? "Launch local Docker demo — no API key"
              : "Local Docker demo unavailable"}
      </button>
      {availability === "unavailable" ? (
        <p
          className="max-w-md text-xs font-semibold leading-5 text-amber-700"
          role="status"
          data-testid="demo-activation-unavailable"
        >
          {unavailableReason || LOCAL_DOCKER_DEMO_FALLBACK} Add a provider in Settings and deploy to
          one of the targets enabled by your operator.
        </p>
      ) : null}
      {availability === "error" ? (
        <p className="max-w-md text-xs font-semibold leading-5 text-red-600" role="alert">
          Nora could not confirm whether the local Docker demo is available. Refresh this page or
          start with a provider in Settings.
        </p>
      ) : null}
      {error ? (
        <p className="text-xs font-semibold text-red-600" role="alert" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const bestFit = [
  {
    icon: Shield,
    title: "Internal AI platform teams",
    desc: "Use Nora as the operator layer around self-hosted OpenClaw infrastructure instead of building internal glue from scratch.",
  },
  {
    icon: Bot,
    title: "Technical product teams",
    desc: "Give OpenClaw-backed products a more credible operator surface with deployment, key sync, and observability already packaged together.",
  },
  {
    icon: FolderKanban,
    title: "Ops-minded founders",
    desc: "Keep infrastructure, networking, and provider credentials under your own control from day one.",
  },
];

export default function GettingStartedPage() {
  const [demoAvailability, setDemoAvailability] = useState<DemoAvailability>("loading");
  const [demoCapabilityIssue, setDemoCapabilityIssue] = useState<string | null>(null);
  const demoAvailable = demoAvailability === "available";
  const launchSignals =
    demoAvailability === "loading"
      ? [
          "Nora checks the running deployment before presenting an activation path.",
          "Enabled targets come from the control plane rather than frontend build settings.",
          "Provider and runtime choices remain under the operator's control.",
          "Chat, logs, and terminal stay reachable from the same operator surface.",
        ]
      : demoAvailable
        ? [
            "The first proof needs no external API key or model spend.",
            "The built-in demo provider and local Docker agent launch in one action.",
            "A real provider can be added only after the operator loop is validated.",
            "Chat, logs, and terminal are all reachable from the same operator surface.",
          ]
        : [
            "Nora shows only activation paths supported by this deployment.",
            "Local Docker installs can use the deterministic zero-key demo.",
            "Kubernetes-only installs start with a configured model provider.",
            "Chat, logs, and terminal stay reachable from the same operator surface.",
          ];

  useEffect(() => {
    const controller = new AbortController();
    async function loadDemoAvailability() {
      try {
        const response = await fetch("/api/config/platform", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Platform config failed with ${response.status}`);
        const config = await response.json();
        const capability = config?.capabilities?.localDockerDemo;
        const enabled = capability?.enabled === true;
        const issue = typeof capability?.issue === "string" ? capability.issue.trim() : "";
        setDemoCapabilityIssue(enabled ? null : issue || null);
        setDemoAvailability(enabled ? "available" : "unavailable");
      } catch (availabilityError) {
        if (controller.signal.aborted) return;
        console.error(availabilityError);
        setDemoCapabilityIssue(null);
        setDemoAvailability("error");
      }
    }
    void loadDemoAvailability();
    return () => controller.abort();
  }, []);

  return (
    <Layout>
      <div className="max-w-6xl mx-auto flex flex-col gap-8 sm:gap-10 pb-12">
        <section className="grid xl:grid-cols-[1.2fr,0.8fr] gap-6 items-start">
          <div className="bg-slate-950 text-white rounded-[2rem] p-6 sm:p-8 border border-slate-800 shadow-2xl">
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-brand-cyan mb-3">
              Getting started
            </p>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight leading-tight mb-4">
              Bring Nora online like a production operator platform
            </h1>
            <p className="text-slate-300 leading-relaxed max-w-2xl">
              {demoAvailability === "loading"
                ? "Nora is checking the enabled deployment targets before recommending the fastest supported first proof."
                : demoAvailable
                  ? "Prove Nora's operator loop before connecting a paid model: deploy the deterministic demo agent, validate the runtime, then add a real provider and workload when you are ready."
                  : "Validate Nora through the targets enabled for this deployment. The zero-key demo is available on local Docker installs; other deployments start by connecting a model provider."}
            </p>

            <div className="grid sm:grid-cols-2 gap-4 mt-8">
              {launchSignals.map((item) => (
                <div
                  key={item}
                  className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 flex items-start gap-3"
                >
                  <CheckCircle2 size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-slate-300 leading-relaxed">{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div
            id="demo-path"
            className="scroll-mt-24 bg-white border border-slate-200 rounded-[2rem] p-6 sm:p-8 shadow-sm"
          >
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 mb-4">
              {demoAvailable
                ? "Fastest path to first proof"
                : "Provider-first path for this deployment"}
            </p>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-brand-cyan/20 text-brand-ink flex items-center justify-center shrink-0">
                  <Sparkles size={18} />
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">
                    {demoAvailable ? "1. Launch the local Docker demo" : "1. Add a model provider"}
                  </p>
                  <p className="text-sm text-slate-500 mt-1">
                    {demoAvailable
                      ? "Nora verifies local Docker, enables its deterministic demo provider, and deploys one demo agent. No external account or usage bill is required."
                      : "Open Settings and connect a model provider before deploying to one of the targets enabled by your operator."}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                  <Bot size={18} />
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">
                    {demoAvailable
                      ? "2. Validate the operator loop"
                      : "2. Deploy to an enabled target"}
                  </p>
                  <p className="text-sm text-slate-500 mt-1">
                    {demoAvailable
                      ? "Open the agent page and prove chat, logs, terminal access, and runtime health from inside Nora."
                      : "Use Deploy to select a configured Kubernetes, remote-host, or other operator-approved target."}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-brand-gold/35 text-brand-ink flex items-center justify-center shrink-0">
                  <KeyRound size={18} />
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">
                    {demoAvailable ? "3. Connect a real provider" : "3. Validate the operator loop"}
                  </p>
                  <p className="text-sm text-slate-500 mt-1">
                    {demoAvailable
                      ? "Add a provider in Settings, then deploy OpenClaw or Hermes to a GA Docker or Kubernetes target for a live workload."
                      : "Open the agent page and prove chat, logs, terminal access, and runtime health from inside Nora."}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 mt-8">
              <TryDemoButton
                availability={demoAvailability}
                unavailableReason={demoCapabilityIssue}
              />
              <a
                href="/app/settings"
                className="inline-flex items-center gap-2 rounded-xl border border-brand-cyan/40 bg-brand-cyan/15 px-4 py-3 text-sm font-bold text-brand-ink hover:bg-brand-cyan/25 transition-all"
              >
                Start in Settings <ArrowRight size={15} />
              </a>
              <a
                href="/app/deploy"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-all"
              >
                Deploy first agent <ArrowRight size={15} />
              </a>
            </div>
            <p className="text-xs text-slate-400 mt-3">
              The demo model is served by your Nora control plane on local Docker installs. It
              proves product flow, not model quality; swap in a real provider whenever you are
              ready.
            </p>
          </div>
        </section>

        <ActivationChecklist
          title="Self-hosted launch checklist"
          subtitle={
            demoAvailable
              ? "Use the local Docker demo for the fastest first proof, then connect a real provider and deploy a live workload when the operator loop is clear."
              : "Connect a model provider, deploy to a target enabled for this installation, and validate the operator loop from the agent page."
          }
        />

        <section className="grid lg:grid-cols-3 gap-5">
          {bestFit.map((item) => (
            <div
              key={item.title}
              className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm"
            >
              <div className="w-11 h-11 rounded-2xl bg-slate-950 text-white flex items-center justify-center mb-4">
                <item.icon size={18} />
              </div>
              <h2 className="text-lg font-black text-slate-900 mb-2">{item.title}</h2>
              <p className="text-sm text-slate-500 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </section>
      </div>
    </Layout>
  );
}
