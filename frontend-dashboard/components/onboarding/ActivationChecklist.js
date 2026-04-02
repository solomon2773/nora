import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, CheckCircle2, KeyRound, Loader2, MessagesSquare, Rocket, ShieldCheck } from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { clsx } from "clsx";

export default function ActivationChecklist({ compact = false, title = "Activation checklist", subtitle, showHeader = true }) {
  const [loading, setLoading] = useState(true);
  const [providerCount, setProviderCount] = useState(0);
  const [agentCount, setAgentCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchWithAuth("/api/llm-providers").then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetchWithAuth("/api/agents").then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
      .then(([providers, agents]) => {
        if (cancelled) return;
        setProviderCount(Array.isArray(providers) ? providers.length : 0);
        setAgentCount(Array.isArray(agents) ? agents.length : 0);
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

  const steps = useMemo(() => {
    const hasProvider = providerCount > 0;
    const hasAgent = agentCount > 0;

    return [
      {
        key: "account",
        title: "Operator account ready",
        desc: "Your Nora workspace is ready. Next, connect one LLM provider so agents can authenticate cleanly.",
        href: "/app/settings",
        cta: "Open Settings",
        icon: ShieldCheck,
        status: "complete",
      },
      {
        key: "provider",
        title: hasProvider ? "LLM provider connected" : "Add an LLM provider key",
        desc: hasProvider
          ? `${providerCount} provider${providerCount === 1 ? "" : "s"} configured. Nora can sync credentials to your agents.`
          : "Save one provider key in Settings. That is the fastest path to a successful first deploy.",
        href: "/app/settings",
        cta: hasProvider ? "Manage Providers" : "Add Provider",
        icon: KeyRound,
        status: hasProvider ? "complete" : "current",
      },
      {
        key: "deploy",
        title: hasAgent ? "First agent deployed" : "Deploy your first OpenClaw agent",
        desc: hasAgent
          ? `${agentCount} agent${agentCount === 1 ? "" : "s"} currently in Nora. Use Deploy to add more capacity when needed.`
          : "Use the default OpenClaw + Docker path for the clearest self-hosted MVP activation loop.",
        href: "/app/deploy",
        cta: hasAgent ? "Deploy Another Agent" : "Deploy First Agent",
        icon: Rocket,
        status: hasAgent ? "complete" : hasProvider ? "current" : "upcoming",
      },
      {
        key: "validate",
        title: "Validate chat, logs, and terminal",
        desc: hasAgent
          ? "Open the agent detail page and prove the control plane works end-to-end: chat, logs, terminal, and runtime health."
          : "Once your first agent is live, validate the runtime immediately from the agent detail page.",
        href: "/app/agents",
        cta: hasAgent ? "Validate Runtime" : "View Agents",
        icon: MessagesSquare,
        status: hasAgent ? "current" : "upcoming",
      },
    ];
  }, [providerCount, agentCount]);

  const completed = steps.filter((step) => step.status === "complete").length;
  const progress = Math.round((completed / steps.length) * 100);

  return (
    <div className={clsx(
      "border border-slate-200 bg-white rounded-[2rem] shadow-sm",
      compact ? "p-5 sm:p-6" : "p-6 sm:p-8"
    )}>
      {showHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-600 mb-2">First-run activation</p>
            <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">{title}</h2>
            <p className="text-sm text-slate-500 mt-2 max-w-2xl">
              {subtitle || "The fastest path to value is simple: connect one provider, deploy one agent, then validate the runtime from Nora itself."}
            </p>
          </div>

          <div className="min-w-[150px] rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">Progress</p>
            <div className="flex items-end justify-between mt-2">
              <span className="text-2xl font-black text-blue-700">{completed}/{steps.length}</span>
              <span className="text-sm font-bold text-blue-600">{progress}%</span>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-slate-400">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
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
                      ? "border-blue-200 bg-blue-50/70"
                      : "border-slate-200 bg-slate-50"
                )}
              >
                <div className="flex items-start gap-4">
                  <div className={clsx(
                    "w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border",
                    isComplete
                      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                      : isCurrent
                        ? "bg-blue-100 text-blue-700 border-blue-200"
                        : "bg-white text-slate-400 border-slate-200"
                  )}>
                    {isComplete ? <CheckCircle2 size={20} /> : <step.icon size={20} />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Step {index + 1}</span>
                      <span className={clsx(
                        "text-[10px] font-black uppercase tracking-[0.2em] px-2.5 py-1 rounded-full border",
                        isComplete
                          ? "text-emerald-700 bg-emerald-100 border-emerald-200"
                          : isCurrent
                            ? "text-blue-700 bg-blue-100 border-blue-200"
                            : "text-slate-500 bg-white border-slate-200"
                      )}>
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
                      ? "Proof of value = successful operator workflow from within Nora."
                      : step.key === "deploy"
                        ? "Default recommendation = OpenClaw + Docker for MVP evaluation."
                        : ""}
                  </div>
                  <a
                    href={step.href}
                    className={clsx(
                      "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all shrink-0",
                      isComplete
                        ? "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
                        : isCurrent
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
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
      )}

      {!loading && (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600 leading-relaxed">
          <span className="font-bold text-slate-900">Best-fit evaluator:</span> platform teams, AI product builders, and ops-minded technical teams who want a credible self-hosted control plane for OpenClaw agents.
        </div>
      )}
    </div>
  );
}
