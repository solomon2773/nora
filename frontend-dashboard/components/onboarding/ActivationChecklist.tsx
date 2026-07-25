import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessagesSquare,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { clsx } from "clsx";
import {
  hasValidatedAgent,
  markAgentValidatedFromGatewayHistory,
  subscribeAgentValidation,
} from "../../lib/activation";
import { runtimeSupportsGateway } from "../../lib/runtime";

export default function ActivationChecklist({
  compact = false,
  title = "Activation checklist",
  subtitle,
  showHeader = true,
}) {
  const [loading, setLoading] = useState(true);
  const [providerCount, setProviderCount] = useState(0);
  const [agents, setAgents] = useState([]);
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [validationVersion, setValidationVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchWithAuth("/api/llm-providers")
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
      fetchWithAuth("/api/agents")
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
      fetch("/api/config/platform")
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
    ])
      .then(([providers, agentData, platformConfig]) => {
        if (cancelled) return;
        const localDockerDemoEnabled = (
          platformConfig as { capabilities?: { localDockerDemo?: { enabled?: unknown } } }
        ).capabilities?.localDockerDemo?.enabled;
        setProviderCount(Array.isArray(providers) ? providers.length : 0);
        setAgents(Array.isArray(agentData) ? agentData : []);
        setDemoAvailable(localDockerDemoEnabled === true);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribeAgentValidation(() => {
      setValidationVersion((version) => version + 1);
    });
  }, []);

  useEffect(() => {
    if (!agents.length) return;

    let cancelled = false;
    const candidates = agents
      .filter((agent) => agent?.id && runtimeSupportsGateway(agent) && !hasValidatedAgent(agent.id))
      .slice(0, 5);

    if (!candidates.length) return;

    async function validateFromHistory() {
      for (const agent of candidates) {
        if (cancelled) return;
        const validated = await markAgentValidatedFromGatewayHistory(agent.id);
        if (validated) return;
      }
    }

    validateFromHistory();
    return () => {
      cancelled = true;
    };
  }, [agents, validationVersion]);

  const steps = useMemo(() => {
    const hasProvider = providerCount > 0;
    const hasAgent = agents.length > 0;
    const firstAgent = agents[0];
    const hasValidatedRuntime = hasAgent && agents.some((agent) => hasValidatedAgent(agent?.id));

    return [
      {
        key: "account",
        title: "Operator account ready",
        desc: demoAvailable
          ? "Your Nora workspace is ready. Prove the operator loop with the zero-key local Docker demo or connect a real provider."
          : "Your Nora workspace is ready. Connect a model provider, then deploy to a target enabled by your operator.",
        href: demoAvailable ? "/app/getting-started#demo-path" : "/app/settings",
        cta: "Choose First Proof",
        icon: ShieldCheck,
        status: "complete",
      },
      {
        key: "provider",
        title: hasProvider
          ? "LLM provider connected"
          : demoAvailable
            ? "Enable the demo or add a provider"
            : "Add a model provider",
        desc: hasProvider
          ? `${providerCount} provider${providerCount === 1 ? "" : "s"} configured. Nora can sync credentials to your agents.`
          : demoAvailable
            ? "Use the built-in deterministic demo for a zero-key first proof, or save a provider key in Settings for a live model."
            : "Save a provider key in Settings before deploying to one of this installation's enabled targets.",
        href: hasProvider || !demoAvailable ? "/app/settings" : "/app/getting-started#demo-path",
        cta: hasProvider
          ? "Manage Providers"
          : demoAvailable
            ? "Choose Demo or Provider"
            : "Add Provider",
        icon: KeyRound,
        status: hasProvider ? "complete" : "current",
      },
      {
        key: "deploy",
        title: hasAgent ? "First agent deployed" : "Deploy your first OpenClaw agent",
        desc: hasAgent
          ? hasValidatedRuntime
            ? `${agents.length} agent${agents.length === 1 ? " is" : "s are"} now in Nora, and one live runtime has passed chat validation.`
            : `${agents.length} agent${agents.length === 1 ? " is" : "s are"} now in Nora. The next move is to validate one live runtime end-to-end.`
          : "Open Deploy and choose one enabled backend for the clearest first-run launch flow.",
        href: "/app/deploy",
        cta: hasAgent ? "Deploy Another Agent" : "Deploy First Agent",
        icon: Rocket,
        status: hasAgent ? "complete" : hasProvider ? "current" : "upcoming",
      },
      {
        key: "validate",
        title: hasValidatedRuntime
          ? "Runtime validated"
          : hasAgent
            ? "Validate the first live runtime"
            : "Validate chat, logs, and terminal",
        desc: hasValidatedRuntime
          ? "A successful chat has been recorded from a live agent. Logs, terminal, and runtime health remain available from the agent detail page."
          : hasAgent
            ? "Open one agent and prove the control plane works end-to-end: chat, logs, terminal, and runtime health."
            : "Once your first agent is live, validate the runtime immediately from the agent detail page.",
        href: firstAgent?.id ? `/app/agents/${firstAgent.id}` : "/app/agents",
        cta: hasValidatedRuntime ? "Open Agent" : hasAgent ? "Open Validation View" : "View Agents",
        icon: MessagesSquare,
        status: hasValidatedRuntime ? "complete" : hasAgent ? "current" : "upcoming",
      },
    ];
  }, [providerCount, agents, demoAvailable, validationVersion]);

  const completed = steps.filter((step) => step.status === "complete").length;
  const progress = Math.round((completed / steps.length) * 100);
  const nextStep = steps.find((step) => step.status === "current") || {
    title: "Activation complete",
    desc: "Your first runtime passed chat validation. Continue from the fleet or deploy another agent when ready.",
    href: "/app/agents",
    cta: "View Agents",
  };

  return (
    <div
      className={clsx(
        "border border-slate-200 bg-white rounded-[2rem] shadow-sm",
        compact ? "p-5 sm:p-6" : "p-6 sm:p-8",
      )}
    >
      {showHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-brand-ink/65 mb-2">
              First-run activation
            </p>
            <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
              {title}
            </h2>
            <p className="text-sm text-slate-500 mt-2 max-w-2xl">
              {subtitle ||
                "The fastest self-hosted launch path is simple: connect one provider, deploy one agent, then confirm the runtime from Nora itself."}
            </p>
          </div>

          <div className="min-w-[150px] rounded-2xl border border-brand-cyan/40 bg-brand-cyan/15 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-ink/70">
              Progress
            </p>
            <div className="flex items-end justify-between mt-2">
              <span className="text-2xl font-black text-brand-ink">
                {completed}/{steps.length}
              </span>
              <span className="text-sm font-bold text-brand-ink/70">{progress}%</span>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-slate-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <>
          <div className="mb-5 rounded-2xl border border-brand-cyan/40 bg-brand-cyan/15 px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-ink/70">
                Recommended next step
              </p>
              <p className="text-sm text-brand-ink font-bold mt-1">{nextStep.title}</p>
              <p className="text-sm text-brand-ink/70 mt-1">{nextStep.desc}</p>
            </div>
            <a
              href={nextStep.href}
              className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black bg-brand-cyan text-brand-ink hover:brightness-95 transition-all shrink-0"
            >
              {nextStep.cta}
              <ArrowRight size={15} />
            </a>
          </div>

          <div className="space-y-4">
            {steps.map((step, index) => {
              const isComplete = step.status === "complete";
              const isCurrent = step.status === "current";

              return (
                <div
                  key={step.key}
                  className={clsx(
                    "rounded-3xl border p-5 sm:p-6 flex flex-col gap-4",
                    isComplete
                      ? "border-emerald-200 bg-emerald-50/70"
                      : isCurrent
                        ? "border-brand-cyan/50 bg-brand-cyan/10"
                        : "border-slate-200 bg-slate-50",
                  )}
                >
                  <div className="flex items-start gap-4">
                    <div
                      className={clsx(
                        "w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border",
                        isComplete
                          ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                          : isCurrent
                            ? "bg-brand-cyan/25 text-brand-ink border-brand-cyan/40"
                            : "bg-white text-slate-400 border-slate-200",
                      )}
                    >
                      {isComplete ? <CheckCircle2 size={20} /> : <step.icon size={20} />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                          Step {index + 1}
                        </span>
                        <span
                          className={clsx(
                            "text-[10px] font-black uppercase tracking-[0.2em] px-2.5 py-1 rounded-full border",
                            isComplete
                              ? "text-emerald-700 bg-emerald-100 border-emerald-200"
                              : isCurrent
                                ? "text-brand-ink bg-brand-cyan/25 border-brand-cyan/40"
                                : "text-slate-500 bg-white border-slate-200",
                          )}
                        >
                          {isComplete ? "Complete" : isCurrent ? "Next" : "Queued"}
                        </span>
                      </div>
                      <h3 className="text-lg font-black text-slate-900">{step.title}</h3>
                      <p className="text-sm text-slate-600 leading-relaxed mt-2">{step.desc}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 pl-0 sm:pl-[60px]">
                    <div className="text-xs text-slate-500 font-medium">
                      {step.key === "validate"
                        ? "Successful runtime checks happen from inside Nora."
                        : step.key === "deploy"
                          ? "Choose one enabled backend, then validate a single runtime end to end."
                          : ""}
                    </div>
                    <a
                      href={step.href}
                      className={clsx(
                        "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all shrink-0",
                        isComplete
                          ? "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
                          : isCurrent
                            ? "bg-brand-cyan text-brand-ink hover:brightness-95"
                            : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50",
                      )}
                    >
                      {step.cta}
                      <ArrowRight size={15} />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {!loading && !compact && (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600 leading-relaxed">
          <span className="font-bold text-slate-900">Best-fit teams:</span> platform teams,
          technical product teams, and ops-minded technical teams who want a credible self-hosted
          platform for OpenClaw agents.
        </div>
      )}
    </div>
  );
}
