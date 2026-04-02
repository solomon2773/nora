import Link from "next/link";
import { Check, Zap, Shield, Crown, ArrowRight } from "lucide-react";

const OFFERS = [
  {
    key: "oss",
    name: "Self-hosted open source",
    price: "Free",
    period: "Apache 2.0",
    description: "The repo is the front door: install Nora yourself and validate the OpenClaw control-plane workflow on your own infrastructure.",
    icon: Zap,
    features: [
      "Open-source repo on GitHub",
      "Install scripts served from raw.githubusercontent.com",
      "18 LLM providers",
      "60+ integrations",
      "9 communication channels",
      "Environment-based resource control in self-hosted mode",
    ],
    cta: "Open install docs",
    href: "https://github.com/solomon2773/nora#quick-start",
    external: true,
    highlight: false,
  },
  {
    key: "support",
    name: "Paid onboarding & support",
    price: "Contact",
    period: "Keep your own infra",
    description: "For teams that want Nora running faster without turning the rollout into a full DIY project.",
    icon: Shield,
    features: [
      "Best for self-hosting teams short on time",
      "Hands-on setup and rollout guidance",
      "Operator onboarding and first-value support",
      "Security and deployment review conversations",
      "Uses the open-source product as the base",
      "Start with GitHub Discussions today",
    ],
    cta: "Start support discussion",
    href: "https://github.com/solomon2773/nora/discussions",
    external: true,
    highlight: true,
  },
  {
    key: "managed",
    name: "Managed Nora / custom deployment",
    price: "Contact",
    period: "Hosted or tailored rollout",
    description: "For teams exploring less self-managed operations, a hosted evaluation path, or a custom Nora deployment around OpenClaw.",
    icon: Crown,
    features: [
      "Hosted signup flow exists at the live app domain",
      "Useful for managed PaaS or enterprise discovery",
      "Workspace, RBAC, and billing paths exist in product code",
      "Custom deployment scoping can start from current product proof",
      "Best for teams that want less hands-on ops burden",
      "Use pricing + signup as the current conversion path",
    ],
    cta: "Open hosted evaluation",
    href: "/signup",
    external: false,
    highlight: false,
  },
];

const DOMAIN_LINKS = [
  {
    label: "Live app",
    href: "https://nora.solomontsao.com",
    text: "nora.solomontsao.com",
  },
  {
    label: "Pricing page",
    href: "https://nora.solomontsao.com/pricing",
    text: "nora.solomontsao.com/pricing",
  },
  {
    label: "Bash install",
    href: "https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh",
    text: "raw.githubusercontent.com/.../setup.sh",
  },
  {
    label: "PowerShell install",
    href: "https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1",
    text: "raw.githubusercontent.com/.../setup.ps1",
  },
];

function PlanCard({ offer }) {
  const Icon = offer.icon;
  const isHighlight = offer.highlight;

  const classes = `w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm transition-all active:scale-95 ${
    isHighlight
      ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20"
      : "bg-white/10 hover:bg-white/15 text-white"
  }`;

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
          Best monetization bridge from OSS
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
        <h3 className="text-xl font-black">{offer.name}</h3>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-2">
        <span className="text-4xl font-black">{offer.price}</span>
        {offer.period ? <span className="text-sm text-slate-400 font-medium">{offer.period}</span> : null}
      </div>

      <p className="text-sm text-slate-400 mb-8">{offer.description}</p>

      <ul className="flex flex-col gap-3 mb-8 flex-1">
        {offer.features.map((f, i) => (
          <li key={i} className="flex items-center gap-3 text-sm">
            <Check size={16} className={isHighlight ? "text-blue-300" : "text-green-400"} />
            <span className="text-slate-300">{f}</span>
          </li>
        ))}
      </ul>

      {offer.external ? (
        <a href={offer.href} target="_blank" rel="noopener noreferrer" className={classes}>
          {offer.cta}
          <ArrowRight size={16} />
        </a>
      ) : (
        <Link href={offer.href} className={classes}>
          {offer.cta}
          <ArrowRight size={16} />
        </Link>
      )}
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
            Hosted evaluation
          </Link>
        </div>
      </nav>

      <div className="text-center px-6 py-16 md:py-24 max-w-5xl mx-auto">
        <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-4">Pricing & packaging</p>
        <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-tight mb-6">
          Open source first.
          <br />
          <span className="text-blue-400">Commercial help when you need it.</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-3xl mx-auto">
          Nora&apos;s most credible motion starts with the open-source repo and self-hosted proof of value. From there,
          the product can convert teams into paid onboarding/support, a hosted evaluation flow, or a custom deployment
          conversation without relying on unsupported vanity pricing claims.
        </p>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-12 grid md:grid-cols-2 gap-6">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
          <h2 className="text-lg font-black mb-2">Current product reality</h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            Self-hosted Nora is the clearest proof path today. The repo, dashboard, login/signup flow, billing routes,
            and operator surface already exist, so the best public funnel is to keep the open-source core visible and
            attach commercial rollout options around it.
          </p>
        </div>
        <div className="bg-blue-500/10 border border-blue-400/20 rounded-3xl p-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-400/10 border border-blue-300/20 text-blue-200 text-[11px] font-black uppercase tracking-widest mb-3">
            Recommended monetization path
          </div>
          <h2 className="text-lg font-black mb-2 text-blue-100">Repo → support → managed</h2>
          <p className="text-sm text-blue-50/80 leading-relaxed">
            Let the repo and self-hosted install earn trust first. Then use paid onboarding/support for speed or the
            hosted/custom path when teams want less self-managed infrastructure work.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-8">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6 text-left">
          <p className="text-blue-300 text-sm font-bold uppercase tracking-widest mb-4">Current public domains and install links</p>
          <div className="grid md:grid-cols-2 gap-4">
            {DOMAIN_LINKS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 hover:bg-white/[0.05] transition-all"
              >
                <p className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1">{item.label}</p>
                <p className="text-sm text-slate-200 break-all">{item.text}</p>
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-6 md:gap-8 items-start">
        {OFFERS.map((offer) => (
          <PlanCard key={offer.key} offer={offer} />
        ))}
      </div>

      <div className="max-w-3xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-black text-center mb-12">Frequently Asked Questions</h2>
        <div className="flex flex-col gap-6">
          {[
            {
              q: "What is the main conversion path for Nora right now?",
              a: "Open-source repo first, self-hosted proof second, then paid onboarding/support or a hosted/custom deployment conversation once the team sees real operator value.",
            },
            {
              q: "Where do the install scripts live right now?",
              a: "The current public install links should point to raw.githubusercontent.com, while the live app and pricing pages run on nora.solomontsao.com.",
            },
            {
              q: "Is self-hosted still the strongest proof path?",
              a: "Yes. Self-hosted remains the clearest way to prove Nora today because resource limits, infrastructure choices, and rollout timing stay in the operator's control.",
            },
            {
              q: "How should teams start a paid support conversation?",
              a: "Use GitHub Discussions as the current commercial intake path for setup help, onboarding, and rollout support requests.",
            },
            {
              q: "What about managed Nora or enterprise deployment?",
              a: "Use the pricing page and hosted signup flow as the current public path, then scope managed or custom deployment requirements from there. This page intentionally avoids unsupported public price points.",
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
        Need a self-hosted install path, paid rollout help, or a managed deployment conversation?{" "}
        <a href="https://github.com/solomon2773/nora/discussions" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          Start in GitHub Discussions
        </a>
        {" "}or{" "}
        <Link href="/signup" className="text-blue-400 hover:underline">
          open the hosted evaluation flow
        </Link>
        .
      </div>
    </div>
  );
}
