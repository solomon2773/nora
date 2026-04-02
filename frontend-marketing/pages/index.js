import Link from "next/link";
import {
  Server,
  Zap,
  Shield,
  Globe,
  ShoppingBag,
  Menu,
  X,
  Cpu,
  BarChart3,
  Layers,
  Lock,
  ArrowRight,
} from "lucide-react";
import { useState } from "react";

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const features = [
    {
      icon: Server,
      title: "Dedicated Infrastructure",
      desc: "Every OpenClaw agent runs in its own isolated environment with provisioned compute and storage.",
    },
    {
      icon: Zap,
      title: "One-Click Deploy",
      desc: "Provision and launch agents from the dashboard without hand-wiring infrastructure every time.",
    },
    {
      icon: Shield,
      title: "Security First",
      desc: "JWT + RBAC, encrypted secrets, rate limiting, and isolated agent runtimes built into the control plane.",
    },
    {
      icon: Cpu,
      title: "18 LLM Providers",
      desc: "Connect major model providers from one place and sync credentials to the agents that need them.",
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
      desc: "Track activity, sessions, logs, and metrics from one dashboard as agents run.",
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
      title: "Set up Nora",
      desc: "Run Nora self-hosted or sign in through the hosted flow, then open the dashboard.",
    },
    {
      num: "02",
      title: "Connect models and tools",
      desc: "Choose an LLM provider, add integrations, and configure the channels your agent should use.",
    },
    {
      num: "03",
      title: "Deploy and manage agents",
      desc: "Launch OpenClaw agents, monitor activity, use the terminal, and manage recurring work from one place.",
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
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a>
            <a href="/pricing" className="hover:text-white transition-colors">Pricing</a>
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
            <Link href="/signup" className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-blue-500/20">
              Start self-hosted eval
            </Link>
          </div>

          <button className="md:hidden p-2 text-slate-400" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-[#0f172a] border-b border-white/5 px-4 pt-2 pb-6 flex flex-col gap-4 animate-in slide-in-from-top duration-300">
            <a href="#features" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a href="#how-it-works" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>How It Works</a>
            <a href="/pricing" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
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
            <Link href="/signup" className="bg-blue-600 hover:bg-blue-700 px-4 py-3 rounded-lg text-sm font-semibold text-center" onClick={() => setMobileMenuOpen(false)}>
              Start self-hosted eval
            </Link>
          </div>
        )}
      </nav>

      <section className="pt-32 pb-20 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold mb-8 animate-fade-in">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            Open source • Built for OpenClaw agents
          </div>

          <h1 className="text-4xl md:text-7xl font-extrabold tracking-tight mb-6 bg-gradient-to-b from-white to-slate-400 bg-clip-text text-transparent leading-[1.1]">
            The open-source control plane <br className="hidden md:block" /> for <span className="text-blue-500">OpenClaw agents</span>
          </h1>

          <p className="max-w-3xl mx-auto text-base md:text-xl text-slate-400 mb-10 leading-relaxed">
            For internal AI platform teams, technical founders, and ops-minded OpenClaw builders who want a credible
            self-hosted control plane. Nora handles provisioning, tool wiring, chat access, and observability so you
            can get the first agent operational faster.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 px-4 sm:px-0">
            <Link href="/signup" className="w-full sm:w-auto bg-white text-slate-950 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-100 transition-all flex items-center justify-center gap-2">
              Start self-hosted eval <Zap size={20} className="fill-current" />
            </Link>
            <a
              href="https://github.com/solomon2773/nora#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto bg-slate-900 border border-white/10 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-800 transition-all flex items-center justify-center gap-2"
            >
              Review setup docs <ArrowRight size={20} />
            </a>
          </div>

          <div className="mt-8 flex flex-col sm:flex-row items-stretch justify-center gap-3 max-w-4xl mx-auto text-left">
            {[
              "1. Create your operator account",
              "2. Add one provider key",
              "3. Deploy and validate your first OpenClaw agent",
            ].map((item) => (
              <div key={item} className="flex-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-white/5 bg-white/[0.02]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {[
            { value: "18", label: "LLM providers" },
            { value: "60+", label: "Integrations" },
            { value: "9", label: "Communication channels" },
            { value: "Open source", label: "Apache 2.0 licensed" },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-3xl md:text-4xl font-black text-white">{s.value}</p>
              <p className="text-sm text-slate-500 mt-1 font-medium">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="py-16 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-10">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Best fit</p>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight">Who Nora is for right now</h2>
            <p className="text-slate-400 mt-4 max-w-3xl mx-auto">
              Nora is positioned for teams who already believe in OpenClaw and need a credible self-hosted operator surface — not a generic AI wrapper with vague claims.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {[
              {
                title: "Internal AI platform teams",
                desc: "Run multiple OpenClaw agents with clearer deployment, key management, logs, and operator workflows.",
              },
              {
                title: "Technical founders",
                desc: "Add a real control plane around OpenClaw instead of stitching together provisioning and observability by hand.",
              },
              {
                title: "Ops-minded builders",
                desc: "Self-host from day one and validate first value fast: account, provider key, first agent, then chat/logs/terminal.",
              },
            ].map((item) => (
              <div key={item.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                <h3 className="text-lg font-bold mb-2">{item.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="py-24 px-4 sm:px-6 scroll-mt-20">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Platform</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">Everything You Need</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              Production-grade orchestration for OpenClaw agents, from deploy to monitoring.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map((f) => (
              <div key={f.title} className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-blue-500/20 rounded-2xl p-6 transition-all duration-300">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4 group-hover:bg-blue-500/20 transition-colors">
                  <f.icon size={20} className="text-blue-400" />
                </div>
                <h3 className="font-bold text-lg mb-2">{f.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="py-24 px-4 sm:px-6 bg-white/[0.02] border-y border-white/5 scroll-mt-20">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">How It Works</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">From setup to live agent control</h2>
          </div>
          <div className="space-y-0">
            {steps.map((step, i) => (
              <div key={step.num} className="flex gap-6 md:gap-10 items-start">
                <div className="flex flex-col items-center">
                  <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-sm font-black shrink-0">
                    {step.num}
                  </div>
                  {i < steps.length - 1 && <div className="w-px h-20 bg-white/10 mt-1" />}
                </div>
                <div className="pb-12">
                  <h3 className="text-xl font-bold mb-2">{step.title}</h3>
                  <p className="text-slate-400 leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-24 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight mb-6">Ready to run Nora?</h2>
          <p className="text-slate-400 mb-10 text-lg">
            Start in the product or review the repo and docs first — whichever fits your workflow.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/signup" className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 px-8 py-4 rounded-xl font-bold text-lg transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
              Open Nora <ArrowRight size={20} />
            </Link>
            <a
              href="https://github.com/solomon2773/nora"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto bg-slate-900 border border-white/10 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-800 transition-all flex items-center justify-center gap-2"
            >
              View the Repo <ShoppingBag size={20} />
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 bg-[#0b1120]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
          <div className="grid md:grid-cols-4 gap-10">
            <div className="md:col-span-1">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-sm text-white">N</div>
                <span className="text-lg font-bold">Nora</span>
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">The open-source control plane for OpenClaw agents.</p>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Product</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
                <li><a href="/pricing" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="/app/agents" className="hover:text-white transition-colors">Dashboard</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Resources</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="https://github.com/solomon2773/nora" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub Repo</a></li>
                <li><a href="https://github.com/solomon2773/nora#readme" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">README</a></li>
                <li><a href="https://github.com/solomon2773/nora/discussions" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Discussions</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Project</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="https://github.com/solomon2773/nora/issues" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Issues</a></li>
                <li><a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">OpenClaw</a></li>
                <li><a href="/login" className="hover:text-white transition-colors">Login</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-white/5 mt-10 pt-6 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-slate-600">&copy; {new Date().getFullYear()} Nora.</p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>Open source.</span>
              <span>Built for OpenClaw agents.</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
