import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  GitBranch,
  Lock,
  Menu,
  Server,
  Shield,
  Sparkles,
  TerminalSquare,
  Workflow,
  X,
} from "lucide-react";
import { useState } from "react";

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const proof = [
    { value: "18", label: "LLM providers supported" },
    { value: "60+", label: "tools & integrations catalogued" },
    { value: "9", label: "channel types supported" },
    { value: "3", label: "provisioning backends available" },
  ];

  const audiences = [
    {
      title: "Internal AI platform teams",
      desc: "Operate multiple OpenClaw agents without building your own deployment UI, secret sync, chat proxy, and monitoring layer.",
    },
    {
      title: "AI product builders",
      desc: "Ship customer-facing or internal copilots faster with a control plane that handles provisioning, runtime visibility, and fleet operations.",
    },
    {
      title: "Ops-minded founders",
      desc: "Self-host your agent stack, bring your own model keys, and keep infrastructure decisions in your hands from day one.",
    },
  ];

  const features = [
    {
      icon: Workflow,
      title: "OpenClaw-native operations",
      desc: "Deploy, chat with, inspect, and manage OpenClaw agents from one dashboard instead of stitching together scripts and admin panels.",
    },
    {
      icon: Server,
      title: "Self-hosted first",
      desc: "Run Nora on your own infrastructure with Docker Compose today, and keep your networking, data paths, and runtime boundaries under your control.",
    },
    {
      icon: Lock,
      title: "Bring your own model keys",
      desc: "Store provider credentials centrally, sync them to agents when needed, and avoid manually reconfiguring every runtime.",
    },
    {
      icon: TerminalSquare,
      title: "Operator-grade visibility",
      desc: "Move from deployment to logs, terminal access, live chat, channels, and integrations without leaving the control plane.",
    },
    {
      icon: Cpu,
      title: "Flexible runtime targets",
      desc: "Start with Docker, expand to Proxmox or Kubernetes, and keep the same control surface as your OpenClaw estate grows.",
    },
    {
      icon: Shield,
      title: "Credible security posture",
      desc: "Encrypted secrets, RBAC, rate limiting, JWT auth, and per-agent isolation designed for teams that care where their agents run.",
    },
  ];

  const steps = [
    {
      num: "01",
      title: "Install Nora on your own infra",
      desc: "Run the setup script or Docker Compose stack, create the initial operator account, and open the dashboard on your host.",
    },
    {
      num: "02",
      title: "Add an LLM provider once",
      desc: "Save your Anthropic, OpenAI, Google, or other provider key in Settings so Nora can sync credentials to running agents.",
    },
    {
      num: "03",
      title: "Deploy your first OpenClaw agent",
      desc: "Choose a runtime, size the container, deploy, then open chat/logs/terminal to verify the agent is live.",
    },
    {
      num: "04",
      title: "Operate from one control plane",
      desc: "Use Nora to manage sessions, tools, channels, integrations, cron jobs, and monitoring across your agent fleet.",
    },
  ];

  const differentiators = [
    "Built specifically for OpenClaw rather than generic 'AI workflow' abstractions.",
    "Designed for self-hosted teams that want a usable operator UX before building custom platform glue.",
    "Focuses the MVP on first deploy, key sync, observability, and day-2 operations instead of inflated enterprise promises.",
  ];

  const evaluationSignals = [
    "Create an operator account without setup confusion.",
    "Store one provider key and sync it to agents from Nora.",
    "Deploy the first OpenClaw agent through the default Docker path.",
    "Validate chat, logs, and terminal from the same control plane.",
  ];

  const notFor = [
    "Teams looking for a fully managed hosted platform today.",
    "Buyers who want a generic AI wrapper without caring about OpenClaw operations.",
    "Non-technical users who do not want to self-host infrastructure or manage provider keys.",
  ];

  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans selection:bg-blue-500/30 overflow-x-hidden">
      <nav className="fixed w-full z-50 bg-[#0f172a]/85 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-xl text-white">N</div>
            <span className="text-xl font-bold tracking-tight">Nora</span>
          </Link>

          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-400">
            <a href="#who-its-for" className="hover:text-white transition-colors">Who it&apos;s for</a>
            <a href="#how-it-works" className="hover:text-white transition-colors">How it works</a>
            <a href="#features" className="hover:text-white transition-colors">Why Nora</a>
            <Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link>
          </div>

          <div className="hidden md:flex items-center gap-4">
            <Link href="/login" className="text-sm font-medium hover:text-white transition-colors">Log in</Link>
            <Link href="/signup" className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-blue-500/20">
              Open dashboard
            </Link>
          </div>

          <button className="md:hidden p-2 text-slate-400" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-[#0f172a] border-b border-white/5 px-4 pt-2 pb-6 flex flex-col gap-4 animate-in slide-in-from-top duration-300">
            <a href="#who-its-for" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Who it&apos;s for</a>
            <a href="#how-it-works" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>How it works</a>
            <a href="#features" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Why Nora</a>
            <Link href="/pricing" className="text-sm font-medium text-slate-400 py-2" onClick={() => setMobileMenuOpen(false)}>Pricing</Link>
            <hr className="border-white/5" />
            <Link href="/login" className="text-sm font-medium text-white py-2" onClick={() => setMobileMenuOpen(false)}>Log in</Link>
            <Link href="/signup" className="bg-blue-600 hover:bg-blue-700 px-4 py-3 rounded-lg text-sm font-semibold text-center" onClick={() => setMobileMenuOpen(false)}>
              Open dashboard
            </Link>
          </div>
        )}
      </nav>

      <section className="pt-32 pb-20 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-4xl mx-auto text-center">
            <div className="inline-flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs font-semibold mb-8">
              <Sparkles size={14} />
              Open-source • self-hosted • OpenClaw-native
            </div>

            <h1 className="text-4xl md:text-7xl font-extrabold tracking-tight mb-6 bg-gradient-to-b from-white to-slate-400 bg-clip-text text-transparent leading-[1.05]">
              The open-source control plane
              <br className="hidden md:block" />
              for self-hosted <span className="text-blue-500">OpenClaw agents</span>
            </h1>

            <p className="max-w-3xl mx-auto text-base md:text-xl text-slate-400 mb-8 leading-relaxed">
              Nora helps technical teams deploy, observe, and operate OpenClaw agents from one dashboard — without hand-rolling provisioning, key sync, chat access, logs, and fleet management.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3 text-xs md:text-sm text-slate-300 mb-10">
              {[
                "Apache-2.0 licensed",
                "Bring your own infrastructure",
                "Bring your own model keys",
                "Built for operator workflows",
              ].map((item) => (
                <div key={item} className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-white/[0.03] border border-white/10">
                  <Check size={14} className="text-blue-400" />
                  {item}
                </div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 px-4 sm:px-0 mb-8">
              <Link href="/signup" className="w-full sm:w-auto bg-white text-slate-950 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-100 transition-all flex items-center justify-center gap-2">
                Create operator account <ArrowRight size={20} />
              </Link>
              <a
                href="https://github.com/solomon2773/nora"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full sm:w-auto bg-slate-900 border border-white/10 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-800 transition-all flex items-center justify-center gap-2"
              >
                Read the README <GitBranch size={20} />
              </a>
            </div>

            <div className="max-w-3xl mx-auto bg-amber-500/10 border border-amber-400/20 rounded-2xl p-4 md:p-5 text-left">
              <p className="text-sm md:text-base text-amber-100 font-semibold mb-1">MVP positioning</p>
              <p className="text-sm text-amber-50/80 leading-relaxed">
                Nora is strongest today for teams who want to self-host an OpenClaw control plane and get to a trustworthy first deployment quickly. The product story is operations-first, not generic AI-agent hype.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/5 bg-white/[0.02]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {proof.map((item) => (
            <div key={item.label}>
              <p className="text-3xl md:text-4xl font-black text-white">{item.value}</p>
              <p className="text-sm text-slate-500 mt-1 font-medium">{item.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="py-20 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto bg-[#0b1120] border border-white/5 rounded-[2rem] p-8 md:p-10">
          <div className="text-center mb-10">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Proof of value</p>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight">What a credible Nora evaluation should prove</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              The MVP story is intentionally narrow: get to a trustworthy first deployment and validate the operator workflow end to end.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {evaluationSignals.map((item, index) => (
              <div key={item} className="rounded-3xl border border-white/5 bg-white/[0.03] p-5 flex items-start gap-4">
                <div className="w-9 h-9 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-sm font-black shrink-0">
                  {index + 1}
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="who-its-for" className="py-24 px-4 sm:px-6 scroll-mt-24">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Ideal customer profile</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">Built for technical teams running real agents</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              If your team is already serious enough about agents to care about runtimes, keys, logs, and isolation, Nora is the layer between OpenClaw and the operational chaos around it.
            </p>
          </div>

          <div className="grid lg:grid-cols-3 gap-6 mb-12">
            {audiences.map((audience) => (
              <div key={audience.title} className="bg-white/[0.03] border border-white/5 rounded-3xl p-8">
                <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-5">
                  <Bot size={22} className="text-blue-400" />
                </div>
                <h3 className="text-xl font-bold mb-3">{audience.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{audience.desc}</p>
              </div>
            ))}
          </div>

          <div className="grid xl:grid-cols-3 gap-6">
            <div className="bg-white/[0.03] border border-white/5 rounded-3xl p-8">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 mb-4">What Nora replaces</p>
              <ul className="space-y-3 text-sm text-slate-300">
                {[
                  "Ad hoc scripts to provision and restart agents",
                  "Copy-pasting provider keys into every container",
                  "Separate tabs for chat, logs, shell access, and status",
                  "No consistent operator workflow for day-2 agent management",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <ChevronRight size={16} className="text-blue-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white/[0.03] border border-white/5 rounded-3xl p-8">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 mb-4">Why teams choose Nora</p>
              <ul className="space-y-3 text-sm text-slate-300">
                {differentiators.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <Check size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white/[0.03] border border-white/5 rounded-3xl p-8">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500 mb-4">Nora is not for</p>
              <ul className="space-y-3 text-sm text-slate-300">
                {notFor.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <ChevronRight size={16} className="text-amber-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="py-24 px-4 sm:px-6 bg-white/[0.02] border-y border-white/5 scroll-mt-24">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Activation flow</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">From install to first agent in four steps</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              The onboarding story is intentionally simple: stand up Nora, save one provider key, deploy an agent, and start operating from a single surface.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {steps.map((step) => (
              <div key={step.num} className="bg-[#0b1120] border border-white/5 rounded-3xl p-8">
                <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-sm font-black mb-5">
                  {step.num}
                </div>
                <h3 className="text-xl font-bold mb-3">{step.title}</h3>
                <p className="text-slate-400 leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="py-24 px-4 sm:px-6 scroll-mt-24">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-3">Why Nora</p>
            <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight">A control plane, not just another agent demo</h2>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto">
              Nora&apos;s value is operational leverage: faster time-to-first-agent and a cleaner day-2 workflow for teams running OpenClaw in production or near-production environments.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((feature) => (
              <div key={feature.title} className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-blue-500/20 rounded-3xl p-7 transition-all duration-300">
                <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-5 group-hover:bg-blue-500/20 transition-colors">
                  <feature.icon size={22} className="text-blue-400" />
                </div>
                <h3 className="font-bold text-xl mb-3">{feature.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-24 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto bg-gradient-to-b from-blue-600/20 to-slate-900 border border-blue-500/20 rounded-[2rem] p-8 md:p-12 text-center">
          <p className="text-blue-300 text-sm font-bold uppercase tracking-widest mb-4">Ready to evaluate Nora?</p>
          <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight mb-6">Start with the self-hosted control plane story</h2>
          <p className="text-slate-300 max-w-2xl mx-auto mb-10 text-lg">
            If you want a credible OpenClaw operator experience — not a vague AI-agent landing page — Nora is ready to show its value in the first deployment.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/signup" className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 px-8 py-4 rounded-xl font-bold text-lg transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
              Create operator account <ArrowRight size={20} />
            </Link>
            <Link href="/pricing" className="w-full sm:w-auto bg-slate-900 border border-white/10 px-8 py-4 rounded-xl font-bold text-lg hover:bg-slate-800 transition-all flex items-center justify-center gap-2">
              See self-hosted plans <ChevronRight size={20} />
            </Link>
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
              <p className="text-sm text-slate-500 leading-relaxed">
                The self-hosted control plane for OpenClaw agents.
              </p>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Product</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="#who-its-for" className="hover:text-white transition-colors">Who it&apos;s for</a></li>
                <li><a href="#how-it-works" className="hover:text-white transition-colors">Activation flow</a></li>
                <li><Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Resources</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="https://github.com/solomon2773/nora" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a></li>
                <li><a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">OpenClaw</a></li>
                <li><Link href="/login" className="hover:text-white transition-colors">Console login</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">Positioning</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li>Open-source</li>
                <li>Self-hosted first</li>
                <li>Operator UX over hype</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-white/5 mt-10 pt-6 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-slate-600">&copy; {new Date().getFullYear()} Nora. Open-source control plane for OpenClaw agents.</p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>Apache-2.0</span>
              <span>•</span>
              <span>BYO infra</span>
              <span>•</span>
              <span>BYO keys</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
