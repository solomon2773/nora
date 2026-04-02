import Link from "next/link";
import { Check, Zap, Shield, Crown, ArrowRight } from "lucide-react";

const PLANS = [
  {
    key: "free",
    name: "Free",
    price: "Included",
    period: "",
    description: "Default PaaS starter tier in the current billing code.",
    icon: Zap,
    features: [
      "Up to 3 agents",
      "2 vCPU per agent",
      "2 GB RAM per agent",
      "20 GB SSD storage",
      "Dashboard deployment flow",
      "Works with 18 LLM providers",
    ],
    cta: "Get Started",
    href: "/signup",
    highlight: false,
  },
  {
    key: "pro",
    name: "Pro",
    price: "Upgrade",
    period: "",
    description: "Current mid-tier limits defined for Stripe-enabled PaaS setups.",
    icon: Shield,
    features: [
      "Up to 10 agents",
      "8 vCPU per agent",
      "16 GB RAM per agent",
      "200 GB SSD storage",
      "60+ integrations",
      "9 communication channels",
      "Checkout path exists when billing is enabled",
      "Team-ready dashboard workflows",
    ],
    cta: "Continue to Signup",
    href: "/signup",
    highlight: true,
  },
  {
    key: "enterprise",
    name: "Enterprise",
    price: "Contact",
    period: "",
    description: "Highest default PaaS resource envelope currently defined in code.",
    icon: Crown,
    features: [
      "Up to 100 agents",
      "16 vCPU per agent",
      "32 GB RAM per agent",
      "500 GB SSD storage",
      "60+ integrations",
      "9 communication channels",
      "Workspace and RBAC support",
      "Enterprise checkout path exists when billing is enabled",
    ],
    cta: "Request Enterprise",
    href: "/signup",
    highlight: false,
  },
];

function PlanCard({ plan }) {
  const Icon = plan.icon;
  const isHighlight = plan.highlight;

  return (
    <div
      className={`relative flex flex-col rounded-3xl p-8 transition-all ${
        isHighlight
          ? "bg-gradient-to-b from-blue-600/20 to-blue-900/20 border-2 border-blue-500/50 shadow-2xl shadow-blue-500/10 scale-105"
          : "bg-white/5 border border-white/10 hover:border-white/20"
      }`}
    >
      {isHighlight && (
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs font-black uppercase tracking-widest px-4 py-1.5 rounded-full">
          Current Upgrade Path
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            isHighlight ? "bg-blue-600" : "bg-white/10"
          }`}
        >
          <Icon size={20} />
        </div>
        <h3 className="text-xl font-black">{plan.name}</h3>
      </div>

      <div className="flex items-baseline gap-1 mb-2">
        <span className="text-4xl font-black">{plan.price}</span>
        {plan.period ? <span className="text-sm text-slate-400 font-medium">{plan.period}</span> : null}
      </div>

      <p className="text-sm text-slate-400 mb-8">{plan.description}</p>

      <ul className="flex flex-col gap-3 mb-8 flex-1">
        {plan.features.map((f, i) => (
          <li key={i} className="flex items-center gap-3 text-sm">
            <Check
              size={16}
              className={isHighlight ? "text-blue-400" : "text-green-400"}
            />
            <span className="text-slate-300">{f}</span>
          </li>
        ))}
      </ul>

      <Link
        href={plan.href}
        className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm transition-all active:scale-95 ${
          isHighlight
            ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20"
            : "bg-white/10 hover:bg-white/15 text-white"
        }`}
      >
        {plan.cta}
        <ArrowRight size={16} />
      </Link>
    </div>
  );
}

export default function Pricing() {
  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans">
      <nav className="flex items-center justify-between px-6 md:px-12 py-6 max-w-7xl mx-auto">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Zap size={18} className="fill-current" />
          </div>
          <span className="text-lg font-black tracking-tight">Nora</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-slate-400 hover:text-white transition-colors font-medium">
            Sign In
          </Link>
          <Link
            href="/signup"
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 transition-colors text-sm font-bold rounded-xl"
          >
            Get Started
          </Link>
        </div>
      </nav>

      <div className="text-center px-6 py-16 md:py-24 max-w-5xl mx-auto">
        <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-4">Pricing & packaging</p>
        <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-tight mb-6">
          Self-hosted first.
          <br />
          <span className="text-blue-400">PaaS limits second.</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-3xl mx-auto">
          Nora&apos;s clearest offer today is the open-source, self-hosted control plane for OpenClaw teams. This page keeps the current billing-code reality visible while making the self-hosted path the most credible way to evaluate the MVP.
        </p>
      </div>

      <div className="max-w-5xl mx-auto px-6 pb-12 grid md:grid-cols-2 gap-6">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
          <h2 className="text-lg font-black mb-2">PaaS mode</h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            The code defines Free, Pro, and Enterprise tiers. When billing is enabled, Nora can create checkout
            sessions for Pro and Enterprise through Stripe.
          </p>
        </div>
        <div className="bg-blue-500/10 border border-blue-400/20 rounded-3xl p-6">
          <h2 className="text-lg font-black mb-2 text-blue-100">Self-hosted mode</h2>
          <p className="text-sm text-blue-50/80 leading-relaxed">
            Self-hosted operators are not locked to the PaaS plan table. Max agents, CPU, RAM, and disk limits are configured through environment variables, and this is the recommended path for first proof of value today.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-8">
        <div className="bg-blue-500/10 border border-blue-400/20 rounded-3xl p-6 text-left">
          <p className="text-blue-300 text-sm font-bold uppercase tracking-widest mb-2">Recommended evaluation path</p>
          <p className="text-sm text-blue-50/80 leading-relaxed">
            If you are evaluating Nora today, use the self-hosted path first. The plan grid below reflects the current PaaS billing code and resource envelopes, not the primary MVP motion.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-6 md:gap-8 items-start">
        {PLANS.map((plan) => (
          <PlanCard key={plan.key} plan={plan} />
        ))}
      </div>

      <div className="max-w-3xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-black text-center mb-12">Frequently Asked Questions</h2>
        <div className="flex flex-col gap-6">
          {[
            {
              q: "How are deployment limits enforced?",
              a: "Before creating a new agent, Nora checks the user subscription and current agent count in the backend billing flow.",
            },
            {
              q: "What happens when billing is disabled?",
              a: "In PaaS mode, the backend allows new deployments without Stripe enforcement when billing is turned off.",
            },
            {
              q: "What changes in self-hosted mode?",
              a: "Self-hosted deployments use operator-configured environment limits instead of the public PaaS plan table.",
            },
            {
              q: "What does a successful Nora evaluation look like?",
              a: "For the current MVP, success is simple: create an operator account, add one provider key, deploy the first OpenClaw agent, and validate chat, logs, and terminal from the same control plane.",
            },
            {
              q: "Can Nora still support upgrades?",
              a: "Yes. The backend includes checkout routes for Pro and Enterprise when Stripe billing is configured and enabled.",
            },
          ].map((item, i) => (
            <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <h3 className="font-bold mb-2">{item.q}</h3>
              <p className="text-sm text-slate-400">{item.a}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="text-center px-6 pb-24 text-sm text-slate-500">
        Questions or feedback?{" "}
        <a href="https://github.com/solomon2773/nora/discussions" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          GitHub Discussions
        </a>
        {" "}or{" "}
        <a href="https://github.com/solomon2773/nora/issues" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          Issues
        </a>
        .
      </div>
    </div>
  );
}
