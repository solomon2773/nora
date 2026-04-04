import Link from "next/link";
import { Check, Server, LifeBuoy, Building2, Cloud, ArrowRight, Scale, Shield, FileText } from "lucide-react";

const PATHS = [
  {
    key: "selfhost",
    name: "Self-host Nora",
    price: "Free",
    period: "Apache 2.0",
    description: "Run Nora on infrastructure you control and validate the operator workflow directly from the public repo.",
    icon: Server,
    features: [
      "Clone, modify, and self-host the full repo",
      "Install from GitHub + canonical public setup scripts",
      "Use the product commercially under Apache 2.0",
      "Best fit for teams that want full infrastructure ownership",
    ],
    cta: "Open self-host quick start",
    href: "https://github.com/solomon2773/nora#quick-start",
    external: true,
  },
  {
    key: "rollout-help",
    name: "Rollout help / paid support",
    price: "Scoped",
    period: "Based on rollout needs",
    description: "Keep Nora on your own infrastructure, but shorten the time to first value with guided rollout help and support.",
    icon: LifeBuoy,
    features: [
      "Best for setup guidance and deployment review",
      "Support around a real self-hosted Nora environment",
      "Current public intake path is GitHub Discussions",
      "Scope depends on environment, rollout depth, and support needs",
    ],
    cta: "Start a support discussion",
    href: "https://github.com/solomon2773/nora/discussions",
    external: true,
  },
  {
    key: "managed",
    name: "Hosted eval / managed PaaS",
    price: "Scoped",
    period: "Based on environment",
    description: "Start with a less DIY path when you want a faster hosted evaluation or a managed Nora experience.",
    icon: Cloud,
    features: [
      "Hosted evaluation path",
      "Managed PaaS qualification",
      "Best for teams that do not want to start fully self-managed",
      "Use signup to begin the current public intake path",
    ],
    cta: "Start hosted evaluation",
    href: "https://nora.solomontsao.com/signup",
    external: true,
  },
  {
    key: "enterprise",
    name: "Enterprise / custom deployment",
    price: "Custom",
    period: "Scoped to requirements",
    description: "For larger teams, tailored deployment footprints, or more complex security, networking, and rollout requirements.",
    icon: Building2,
    features: [
      "Private cloud / on-prem / AWS / Azure / GCP scoping",
      "Best for larger-team or enterprise-capable environments",
      "Scope depends on deployment footprint and rollout complexity",
      "Deployment-path page is the current public qualification entry point",
    ],
    cta: "Review deployment paths",
    href: "https://nora.solomontsao.com/pricing",
    external: true,
  },
];

const RIGHTS = [
  "Use Nora privately or inside your company",
  "Modify the source code and redistribute changes under Apache 2.0 terms",
  "Offer Nora as a hosted or managed service yourself",
  "Build runtime integrations and workflow extensions around Nora",
];

const ENTRY_POINTS = [
  {
    label: "Repo / self-host source",
    href: "https://github.com/solomon2773/nora",
    text: "github.com/solomon2773/nora",
  },
  {
    label: "Hosted eval / managed PaaS",
    href: "https://nora.solomontsao.com",
    text: "nora.solomontsao.com",
  },
  {
    label: "Bash install",
    href: "https://storage.solomontsao.com/setup.sh",
    text: "storage.solomontsao.com/setup.sh",
  },
  {
    label: "PowerShell install",
    href: "https://storage.solomontsao.com/setup.ps1",
    text: "storage.solomontsao.com/setup.ps1",
  },
];

const PROOF_RESOURCES = [
  {
    title: "Repo proof pack",
    desc: "Public entry point for what Nora is, what it does, and how to evaluate it from the OSS repo.",
    href: "https://github.com/solomon2773/nora#what-is-nora",
  },
  {
    title: "Open-source usage + commercial guide",
    desc: "Public explanation of Apache 2.0 rights, self-hosting, and Nora's OSS-first framing.",
    href: "https://github.com/solomon2773/nora#open-source-means-open-source",
  },
  {
    title: "Commercial paths",
    desc: "Public pricing/deployment page covering self-hosted OSS, support, hosted evaluation, and custom deployment paths.",
    href: "https://nora.solomontsao.com/pricing",
  },
  {
    title: "Implementation proof",
    desc: "Public quick-start entry for evaluating the product from the source repo and install flow.",
    href: "https://github.com/solomon2773/nora#quick-start",
  },
];

const PRICING_RULES = [
  "Self-hosted OSS is free under Apache 2.0.",
  "Rollout help / paid support is scoped based on environment, rollout depth, and support needs.",
  "Hosted evaluation / managed PaaS is scoped based on the evaluation path and environment requirements.",
  "Enterprise / custom deployment is scoped based on deployment footprint, security, identity, networking, and rollout complexity.",
];

const PATH_COMPARISON = [
  {
    path: "Self-host Nora",
    canVerify: "Repo, setup scripts, Docker Compose flow, and the public OSS product surface.",
    bestFit: "Teams that want full infrastructure ownership and the clearest trust path.",
    nextStep: "Run the quick start and validate the first operator workflow.",
  },
  {
    path: "Rollout help / paid support",
    canVerify: "The same OSS product plus a public support intake path through GitHub Discussions.",
    bestFit: "Teams that want self-hosting but less setup friction or faster time to first value.",
    nextStep: "Share target environment, first proof milestone, and current blocker in a Discussion.",
  },
  {
    path: "Hosted eval / managed PaaS",
    canVerify: "Public hosted app, signup path, deployment/support page, and the OSS repo entry point.",
    bestFit: "Teams that want a less DIY evaluation path or lighter operational overhead.",
    nextStep: "Use signup or the deployment/support path page to start the evaluation path.",
  },
  {
    path: "Enterprise / custom deployment",
    canVerify: "Deployment-footprint direction, path clarity, and the OSS proof pack in the repo.",
    bestFit: "Teams with larger-team requirements or more complex security, identity, networking, or infra scope.",
    nextStep: "Start with deployment footprint, rollout stage, and environment constraints.",
  },
];

export default function Pricing() {
  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans">
      <nav className="flex items-center justify-between px-6 md:px-12 py-6 max-w-7xl mx-auto">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-white">N</div>
          <span className="text-lg font-black tracking-tight">Nora</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-slate-400 hover:text-white transition-colors font-medium">
            Sign In
          </Link>
          <a
            href="https://github.com/solomon2773/nora"
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 transition-colors text-sm font-bold rounded-xl"
          >
            GitHub
          </a>
        </div>
      </nav>

      <div className="text-center px-6 py-16 md:py-24 max-w-5xl mx-auto">
        <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-4">Deployment, support, and commercial paths</p>
        <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-tight mb-6">
          Open source first.
          <br />
          <span className="text-blue-400">Clear deployment, support, and custom paths.</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-3xl mx-auto">
          Nora is Apache 2.0 licensed. Teams can self-host it, use it commercially, and inspect real proof in the repo first.
          When a non-DIY path makes more sense, the public path should stay clear: rollout help / paid support, hosted evaluation /
          managed PaaS, and enterprise / custom deployment scoping.
        </p>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-12 grid md:grid-cols-2 gap-6">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <Scale size={18} className="text-blue-400" />
            <h2 className="text-xl font-black">What Apache 2.0 means here</h2>
          </div>
          <ul className="space-y-3 text-slate-300 text-sm leading-relaxed">
            {RIGHTS.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check size={16} className="text-emerald-400 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <Shield size={18} className="text-blue-400" />
            <h2 className="text-xl font-black">Current public entry points</h2>
          </div>
          <div className="space-y-3 text-sm">
            {ENTRY_POINTS.map((item) => (
              <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer" className="block rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:bg-white/[0.06] transition-colors">
                <div className="text-slate-500 text-xs font-black uppercase tracking-widest mb-1">{item.label}</div>
                <div className="text-white font-semibold">{item.text}</div>
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-12">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6 md:p-8">
          <div className="flex items-center gap-3 mb-4">
            <FileText size={18} className="text-blue-400" />
            <h2 className="text-xl font-black">How commercial scoping works today</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4 text-sm text-slate-300 leading-relaxed">
            {PRICING_RULES.map((item) => (
              <div key={item} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                {item}
              </div>
            ))}
          </div>
          <p className="text-sm text-slate-500 mt-4">
            The goal is path clarity, not invented fixed-plan promises. Public language should help teams choose the right route and next step.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-12">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6 md:p-8 overflow-x-auto">
          <div className="mb-4">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-2">Path comparison</p>
            <h2 className="text-xl md:text-3xl font-black tracking-tight">What each path already proves before any sales call</h2>
          </div>
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-slate-400">
                <th className="py-3 pr-4 font-black text-white">Path</th>
                <th className="py-3 px-4 font-black text-white">What you can verify now</th>
                <th className="py-3 px-4 font-black text-white">Best fit</th>
                <th className="py-3 pl-4 font-black text-white">Immediate next step</th>
              </tr>
            </thead>
            <tbody>
              {PATH_COMPARISON.map((row) => (
                <tr key={row.path} className="border-b border-white/5 align-top last:border-b-0">
                  <td className="py-4 pr-4 font-semibold text-white">{row.path}</td>
                  <td className="py-4 px-4 text-slate-300">{row.canVerify}</td>
                  <td className="py-4 px-4 text-slate-300">{row.bestFit}</td>
                  <td className="py-4 pl-4 text-slate-300">{row.nextStep}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-24 grid md:grid-cols-2 xl:grid-cols-4 gap-6">
        {PATHS.map((path) => {
          const Icon = path.icon;
          return (
            <div key={path.key} className="relative flex flex-col rounded-3xl p-8 bg-white/5 border border-white/10 hover:border-white/20 transition-all">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/10">
                  <Icon size={20} />
                </div>
                <h3 className="text-xl font-black">{path.name}</h3>
              </div>

              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-2">
                <span className="text-4xl font-black">{path.price}</span>
                <span className="text-sm text-slate-400 font-medium">{path.period}</span>
              </div>

              <p className="text-sm text-slate-400 mb-8">{path.description}</p>

              <ul className="flex flex-col gap-3 mb-8 flex-1">
                {path.features.map((f) => (
                  <li key={f} className="flex items-center gap-3 text-sm">
                    <Check size={16} className="text-green-400" />
                    <span className="text-slate-300">{f}</span>
                  </li>
                ))}
              </ul>

              <a href={path.href} target={path.external ? "_blank" : undefined} rel={path.external ? "noopener noreferrer" : undefined} className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-sm transition-all active:scale-95 bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20">
                {path.cta}
                <ArrowRight size={16} />
              </a>
            </div>
          );
        })}
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-24">
        <div className="text-center mb-8">
          <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Proof resources</p>
          <h2 className="text-2xl md:text-4xl font-black tracking-tight">Evidence operators can inspect before they buy</h2>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
          {PROOF_RESOURCES.map((item) => (
            <a key={item.title} href={item.href} target="_blank" rel="noopener noreferrer" className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 hover:bg-white/[0.05] transition-all">
              <h3 className="text-lg font-black mb-2">{item.title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{item.desc}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
