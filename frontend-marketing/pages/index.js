import Link from "next/link";
import {
  Server,
  Zap,
  Shield,
  Globe,
  Menu,
  X,
  Cpu,
  BarChart3,
  Layers,
  Lock,
  ArrowRight,
  Boxes,
  LifeBuoy,
  Cloud,
  Building2,
} from "lucide-react";
import { useState } from "react";

const PATHS = [
  {
    icon: Server,
    title: "Self-host Nora",
    badge: "Apache 2.0 · Free",
    desc: "Run Nora on infrastructure you control with the repo, raw install scripts, and Docker Compose path as the trust anchor.",
    bullets: [
      "Open-source repo + quick start",
      "Raw install scripts + Docker Compose",
      "Enterprise-capable self-hosted control plane for teams that want transparency and control",
    ],
    href: "https://github.com/solomon2773/nora#quick-start",
    cta: "Open self-host quick start",
    external: true,
  },
  {
    icon: LifeBuoy,
    title: "Rollout help / paid support",
    badge: "Scoped",
    desc: "Keep Nora on your own infrastructure, but shorten the path to first value with guided rollout help and support.",
    bullets: [
      "Best for setup guidance and deployment review",
      "Current public intake path: GitHub Discussions",
      "Fits teams that want help without giving up self-hosting",
    ],
    href: "https://github.com/solomon2773/nora/discussions",
    cta: "Start a support discussion",
    external: true,
  },
  {
    icon: Cloud,
    title: "Hosted eval / managed PaaS",
    badge: "Scoped",
    desc: "Use a less DIY path when you want to evaluate Nora quickly through a hosted or managed route.",
    bullets: [
      "Hosted evaluation path",
      "Managed PaaS qualification",
      "Best for teams that do not want to start fully self-managed",
    ],
    href: "https://nora.solomontsao.com/signup",
    cta: "Start hosted evaluation",
    external: true,
  },
  {
    icon: Building2,
    title: "Enterprise / custom deployment",
    badge: "Custom",
    desc: "For larger teams, tailored deployment footprints, or more complex security, networking, and rollout requirements.",
    bullets: [
      "Private cloud / on-prem / AWS / Azure / GCP scoping",
      "Best for larger-team or enterprise-capable environments",
      "Scope depends on deployment footprint and rollout complexity",
    ],
    href: "https://nora.solomontsao.com/pricing",
    cta: "Review deployment paths",
    external: true,
  },
];

const PROOF_LINKS = [
  {
    eyebrow: "Install proof",
    title: "The repo is the trust anchor",
    desc: "Quick start, raw install scripts, and source code remain the clearest entry point for evaluating Nora.",
    href: "https://github.com/solomon2773/nora#quick-start",
    cta: "Open quick start",
    external: true,
  },
  {
    eyebrow: "Commercial paths",
    title: "Paid outcomes are explicit",
    desc: "The deployment-path page explains self-hosting, rollout help / paid support, managed evaluation, and enterprise / custom paths without unsupported claims.",
    href: "/pricing",
    cta: "Review deployment paths",
    external: false,
  },
  {
    eyebrow: "Public codebase",
    title: "Operators can inspect the actual control plane",
    desc: "Dashboard code, backend orchestration, provisioning workers, and smoke tests stay in the repo, so public proof comes from product code instead of a separate write-up.",
    href: "https://github.com/solomon2773/nora",
    cta: "Browse the repo",
    external: true,
  },
  {
    eyebrow: "Runtime direction",
    title: "OpenClaw-first, not permanently OpenClaw-only",
    desc: "The current product is strongest with OpenClaw today while future integration with other runtimes remains part of the direction.",
    href: "https://github.com/solomon2773/nora#runtime-direction",
    cta: "Read roadmap framing",
    external: true,
  },
];

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const features = [
    {
      icon: Server,
      title: "Dedicated Infrastructure",
      desc: "Each agent workspace runs in an isolated environment with provisioned compute and storage.",
    },
    {
      icon: Zap,
      title: "Fast Deploy Flow",
      desc: "Launch agent runtimes from the dashboard instead of stitching the workflow together by hand.",
    },
    {
      icon: Shield,
      title: "Security First",
      desc: "JWT + RBAC, encrypted secrets, rate limiting, and isolated runtimes built into the control plane.",
    },
    {
      icon: Cpu,
      title: "18 LLM Providers",
      desc: "Connect major model providers from one place and sync credentials to the runtimes that need them.",
    },
    {
      icon: Layers,
      title: "60+ Integrations",
      desc: "Wire agents to developer, communication, data, and cloud tools from the Nora interface.",
    },
    {
      icon: Globe,
      title: "9 Communication Channels",
      desc: "Connect agents to Discord, Slack, WhatsApp, Telegram, LINE, Email, Webhook, Teams, or SMS.",
    },
    {
      icon: BarChart3,
      title: "Live Monitoring",
      desc: "Track activity, sessions, logs, and metrics from one dashboard as operators work.",
    },
    {
      icon: Lock,
      title: "Encrypted Secrets",
      desc: "Store provider keys and integration tokens with AES-256-GCM encryption at rest.",
    },
  ];

  const steps = [
    {
      num: "01",
      title: "Install Nora",
      desc: "Start from the open-source quick start and get the control plane running on infrastructure you control.",
    },
    {
      num: "02",
      title: "Connect one model and one runtime",
      desc: "Add one LLM provider key, then configure the runtime, integrations, and channels you want to prove first.",
    },
    {
      num: "03",
      title: "Deploy and validate value",
      desc: "Launch an agent runtime, then validate chat, logs, and terminal from the same control plane.",
    },
  ];

  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans selection:bg-blue-500/30 overflow-x-hidden">
      <nav className="fixed w-full z-50 bg-[#0f172a]/80 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-xl text-white">N</div>
            <span className="text-xl font-bold tracking-tight">Nora</span>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-400">
            <a href="#paths" className="hover:text-white transition-colors">Paths</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="/pricing" className="hover:text-white transition-colors">Deployment Paths</a>
          </div>

          <div className="hidden md:flex items-center gap-4">
            <a
              href="https://github.com/solomon2773/nora"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:text-white transition-colors"
            >
              GitHub
            </a>
            <Link href="/pricing" className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-blue-500/20">
              Deployment Paths
            </Link>
          </div>

          <button className="md:hidden p-2 text-slate-400" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-[#0f172a] border-b border-white/5 px-4 pt-2 pb-6 flex flex-col gap-4 animate-in slide-in-from-top duration-300">
            <a href="#paths" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Paths</a>
            <a href="#features" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a href="/pricing" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Deployment Paths</a>
            <hr className="border-white/5" />
            <a
              href="https://github.com/solomon2773/nora"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-white py-2"
              onClick={() => setMobileMenuOpen(false)}
            >
              GitHub
            </a>
          </div>
        )}
      </nav>

      <section className="pt-32 pb-20 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold mb-8 animate-fade-in">
            <Boxes size={14} />
            Fully open source • Self-hostable • Commercial use allowed • Paid support / managed paths • OpenClaw-first today
          </div>

          <h1 className="text-4xl md:text-7xl font-extrabold tracking-tight mb-6 bg-gradient-to-b from-white to-slate-400 bg-clip-text text-transparent leading-[1.1]">
            The open-source control plane <br className="hidden md:block" /> for <span className="text-blue-500">agent operations</span>
          </h1>

          <p className="max-w-3xl mx-auto text-base md:text-xl text-slate-400 mb-10 leading-relaxed">
            Nora helps teams deploy, observe, and operate agent runtimes from one dashboard. It is built to be practical for
            real operator teams, from lean internal platforms to more enterprise-capable self-hosted environments. OpenClaw is
            the strongest supported path today, but Nora is being shaped to integrate cleanly with more agent runtimes over time.
            You can self-host it, modify it, and use it commercially under Apache 2.0 — then choose the right next step when you
            want rollout help, managed evaluation, or custom deployment.
          </p>

          <div className="flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-4 px-4 sm:px-0 mb-5">
            <a
              href="https://github.com/solomon2773/nora#quick-start"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto bg-white text-slate-950 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-100 transition-all flex items-center justify-center gap-2"
            >
              Self-host Nora <Zap size={20} className="fill-current" />
            </a>
            <Link
              href="/pricing"
              className="w-full sm:w-auto bg-blue-600 px-8 py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
            >
              Deployment & support paths <ArrowRight size={18} />
            </Link>
            <a
              href="https://nora.solomontsao.com/signup"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto bg-slate-900 border border-white/10 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-800 transition-all flex items-center justify-center gap-2"
            >
              Hosted evaluation <Cloud size={18} />
            </a>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-slate-400">
            <a href="https://github.com/solomon2773/nora/discussions" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
              Need rollout help or paid support?
            </a>
            <a href="https://github.com/solomon2773/nora" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
              Browse the public repo
            </a>
          </div>
        </div>
      </section>

      <section id="paths" className="px-4 sm:px-6 pb-20">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Choose your path</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">Open source first. Paid paths are clear.</h2>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
            {PATHS.map((path) => {
              const Icon = path.icon;
              return (
                <div key={path.title} className="bg-white/5 border border-white/10 rounded-3xl p-8 flex flex-col">
                  <div className="w-12 h-12 rounded-2xl bg-blue-600/20 text-blue-300 flex items-center justify-center mb-4">
                    <Icon size={22} />
                  </div>
                  <div className="text-xs font-black uppercase tracking-widest text-blue-300 mb-2">{path.badge}</div>
                  <h3 className="text-2xl font-black mb-3">{path.title}</h3>
                  <p className="text-slate-400 mb-5">{path.desc}</p>
                  <ul className="space-y-2 text-sm text-slate-300 mb-8 flex-1">
                    {path.bullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-2"><span className="text-blue-400">•</span><span>{bullet}</span></li>
                    ))}
                  </ul>
                  {path.external ? (
                    <a href={path.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-bold text-white hover:text-blue-300">
                      {path.cta} <ArrowRight size={16} />
                    </a>
                  ) : (
                    <Link href={path.href} className="inline-flex items-center gap-2 font-bold text-white hover:text-blue-300">
                      {path.cta} <ArrowRight size={16} />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="features" className="px-4 sm:px-6 pb-20">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Why teams use Nora</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">One control plane for agent operators</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="bg-white/5 border border-white/10 rounded-3xl p-6">
                  <div className="w-11 h-11 rounded-2xl bg-white/10 flex items-center justify-center text-blue-300 mb-4">
                    <Icon size={20} />
                  </div>
                  <h3 className="font-black text-lg mb-2">{feature.title}</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">{feature.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="px-4 sm:px-6 pb-20">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">How it works</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">Fastest path to proof</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            {steps.map((step) => (
              <div key={step.num} className="bg-white/5 border border-white/10 rounded-3xl p-8">
                <div className="text-blue-400 text-4xl font-black mb-4">{step.num}</div>
                <h3 className="text-xl font-black mb-3">{step.title}</h3>
                <p className="text-slate-400">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-24">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Proof & direction</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">Keep the product honest</h2>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-6">
            {PROOF_LINKS.map((item) => (
              <div key={item.title} className="bg-white/5 border border-white/10 rounded-3xl p-8">
                <p className="text-blue-300 text-xs font-black uppercase tracking-widest mb-3">{item.eyebrow}</p>
                <h3 className="text-xl font-black mb-3">{item.title}</h3>
                <p className="text-slate-400 mb-5">{item.desc}</p>
                {item.external ? (
                  <a href={item.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-bold text-white hover:text-blue-300">
                    {item.cta} <ArrowRight size={16} />
                  </a>
                ) : (
                  <Link href={item.href} className="inline-flex items-center gap-2 font-bold text-white hover:text-blue-300">
                    {item.cta} <ArrowRight size={16} />
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 px-4 sm:px-6 py-10">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-8 justify-between">
          <div>
            <h3 className="text-lg font-black mb-2">Nora</h3>
            <p className="text-sm text-slate-500 leading-relaxed max-w-md">The open-source control plane for agent operations. Self-hostable, commercially usable, and enterprise-capable, with public paths for self-hosting, rollout help, managed evaluation, and custom deployment.</p>
          </div>
          <div className="grid grid-cols-2 gap-8 text-sm">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Project</h4>
              <ul className="space-y-2 text-slate-400">
                <li><a href="https://github.com/solomon2773/nora" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a></li>
                <li><a href="https://github.com/solomon2773/nora#quick-start" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Quick Start</a></li>
                <li><a href="/pricing" className="hover:text-white transition-colors">Deployment Paths</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Next steps</h4>
              <ul className="space-y-2 text-slate-400">
                <li><a href="https://github.com/solomon2773/nora/discussions" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Rollout Help</a></li>
                <li><a href="https://nora.solomontsao.com/signup" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Hosted Evaluation</a></li>
                <li><a href="https://github.com/solomon2773/nora/blob/master/SUPPORT.md" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Support Paths</a></li>
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
