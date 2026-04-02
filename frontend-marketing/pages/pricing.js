import Link from "next/link";
import { ArrowRight, Check, CheckCircle2, Server, Shield, Sparkles } from "lucide-react";

const PLANS = [
  {
    name: "Community",
    badge: "Self-hosted now",
    price: "Open source",
    description: "Best for builders and small technical teams who want to run Nora on their own infrastructure today.",
    accent: "blue",
    cta: "Start self-hosted evaluation",
    href: "/signup",
    features: [
      "Apache-2.0 licensed",
      "Run with your own Docker-based infrastructure",
      "OpenClaw-native deploy, chat, logs, terminal, and settings UX",
      "Bring your own LLM provider keys",
      "Best path for the current MVP",
      "Recommended starting point for first proof of value",
    ],
  },
  {
    name: "Team",
    badge: "Best fit ICP",
    price: "Contact us",
    description: "For internal platform teams evaluating Nora as their control plane for multiple operators, agents, and environments.",
    accent: "emerald",
    cta: "Talk to the team",
    href: "mailto:support@nora.dev",
    features: [
      "Everything in Community",
      "Support for larger self-hosted rollouts",
      "Help with rollout, architecture, and deployment design",
      "Ideal for platform, ops, and product engineering teams",
      "Roadmap input for enterprise-grade needs",
    ],
  },
  {
    name: "Managed / Enterprise",
    badge: "Later-stage offer",
    price: "Coming soon",
    description: "For buyers who want the Nora experience but prefer hosted operations, support, and enterprise onboarding.",
    accent: "purple",
    cta: "Join interest list",
    href: "mailto:support@nora.dev?subject=Nora%20Managed%20Interest",
    features: [
      "Managed deployment path",
      "Commercial support and onboarding",
      "Enterprise security and compliance discussions",
      "Potential fit for larger regulated teams",
      "Useful if you want Nora without running the stack yourself",
    ],
  },
];

const pricingDecisionPath = [
  "Start with Community if you want the fastest, most credible self-hosted MVP evaluation.",
  "Move to Team when you need rollout help for multiple operators, environments, or internal platform adoption.",
  "Treat Managed / Enterprise as a later-stage option, not the primary Nora story today.",
];

function accentClasses(accent) {
  if (accent === "emerald") {
    return {
      icon: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
      badge: "bg-emerald-500/15 text-emerald-300 border-emerald-400/20",
      button: "bg-emerald-600 hover:bg-emerald-700 text-white",
    };
  }
  if (accent === "purple") {
    return {
      icon: "bg-purple-500/15 text-purple-300 border-purple-400/20",
      badge: "bg-purple-500/15 text-purple-300 border-purple-400/20",
      button: "bg-purple-600 hover:bg-purple-700 text-white",
    };
  }
  return {
    icon: "bg-blue-500/15 text-blue-300 border-blue-400/20",
    badge: "bg-blue-500/15 text-blue-300 border-blue-400/20",
    button: "bg-blue-600 hover:bg-blue-700 text-white",
  };
}

export default function Pricing() {
  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans">
      <nav className="flex items-center justify-between px-6 md:px-12 py-6 max-w-7xl mx-auto">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Sparkles size={18} className="fill-current" />
          </div>
          <span className="text-lg font-black tracking-tight">Nora</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-slate-400 hover:text-white transition-colors font-medium">
            Log in
          </Link>
          <Link
            href="/signup"
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 transition-colors text-sm font-bold rounded-xl"
          >
            Open dashboard
          </Link>
        </div>
      </nav>

      <div className="text-center px-6 py-16 md:py-24 max-w-4xl mx-auto">
        <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-4">Pricing & packaging</p>
        <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-tight mb-6">
          Self-hosted first.
          <br />
          <span className="text-blue-400">Commercial options second.</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-3xl mx-auto leading-relaxed">
          Nora&apos;s clearest offer today is the open-source, self-hosted control plane for OpenClaw teams. This page reflects the current MVP honestly while still making room for team support and future managed offerings.
        </p>
      </div>

      <div className="max-w-5xl mx-auto px-6 pb-12">
        <div className="bg-blue-500/10 border border-blue-400/20 rounded-3xl p-6 md:p-8">
          <p className="text-blue-300 text-sm font-bold uppercase tracking-widest mb-4">Recommended path</p>
          <div className="grid md:grid-cols-3 gap-4">
            {pricingDecisionPath.map((item) => (
              <div key={item} className="bg-slate-950/50 border border-white/5 rounded-2xl p-5 flex items-start gap-3">
                <CheckCircle2 size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                <p className="text-sm text-slate-300 leading-relaxed">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-14 grid md:grid-cols-3 gap-6 md:gap-8 items-stretch">
        {PLANS.map((plan) => {
          const styles = accentClasses(plan.accent);
          const isExternal = plan.href.startsWith("mailto:");

          return (
            <div key={plan.name} className="bg-white/5 border border-white/10 rounded-3xl p-8 flex flex-col">
              <div className={`inline-flex items-center gap-2 self-start px-3 py-1.5 rounded-full text-xs font-bold border mb-5 ${styles.badge}`}>
                <Shield size={12} />
                {plan.badge}
              </div>

              <div className={`w-12 h-12 rounded-2xl border flex items-center justify-center mb-5 ${styles.icon}`}>
                {plan.name === "Community" ? <Server size={22} /> : <Shield size={22} />}
              </div>

              <h2 className="text-2xl font-black mb-2">{plan.name}</h2>
              <div className="text-3xl font-black mb-3">{plan.price}</div>
              <p className="text-sm text-slate-400 leading-relaxed mb-8">{plan.description}</p>

              <ul className="space-y-3 mb-8 flex-1">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-slate-300">
                    <Check size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              {isExternal ? (
                <a
                  href={plan.href}
                  className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm transition-all active:scale-95 ${styles.button}`}
                >
                  {plan.cta}
                  <ArrowRight size={16} />
                </a>
              ) : (
                <Link
                  href={plan.href}
                  className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm transition-all active:scale-95 ${styles.button}`}
                >
                  {plan.cta}
                  <ArrowRight size={16} />
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <div className="max-w-4xl mx-auto px-6 pb-24">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-8 md:p-10">
          <h2 className="text-2xl font-black mb-8 text-center">Frequently asked questions</h2>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                q: "What should most users choose right now?",
                a: "Community / self-hosted. That is the strongest and most credible Nora motion today, especially for first evaluation and operator proof of value.",
              },
              {
                q: "Is Nora open source?",
                a: "Yes. Nora is licensed under Apache-2.0 and can be run on your own infrastructure.",
              },
              {
                q: "Do I need Nora Cloud to get value?",
                a: "No. The current MVP is specifically positioned to deliver value in self-hosted environments.",
              },
              {
                q: "Who is the best-fit buyer?",
                a: "Platform teams, AI product builders, and ops-minded technical teams running OpenClaw agents and needing a clean operational control plane.",
              },
            ].map((item) => (
              <div key={item.q} className="bg-slate-950/50 border border-white/5 rounded-2xl p-6">
                <h3 className="font-bold mb-2">{item.q}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
