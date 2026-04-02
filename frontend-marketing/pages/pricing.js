import Link from "next/link";
import { Check, Server, Globe, GitBranch, ArrowRight, Scale, Shield, FileText } from "lucide-react";

const PATHS = [
  {
    key: "selfhost",
    name: "Self-host Nora",
    price: "Free",
    period: "Apache 2.0",
    description: "Run Nora on infrastructure you control and adapt it to your own workflows.",
    icon: Server,
    features: [
      "Clone, modify, and self-host the full repo",
      "Install from GitHub + raw setup scripts",
      "Use the product internally without asking permission",
      "OpenClaw is the strongest supported runtime today",
    ],
    cta: "Open self-host quick start",
    href: "https://github.com/solomon2773/nora#quick-start",
    external: true,
  },
  {
    key: "commercial-use",
    name: "Use it commercially yourself",
    price: "Commercial use",
    period: "Apache 2.0",
    description: "You can run Nora as part of a service business, host it for clients, or build on top of it.",
    icon: Globe,
    features: [
      "Commercial use is allowed",
      "Offer hosted services on your own infrastructure",
      "Serve clients or internal business units",
      "Keep your own packaging, operations, and customer relationships",
    ],
    cta: "Read commercial-use rights",
    href: "https://github.com/solomon2773/nora/blob/master/docs/OPEN_SOURCE_USAGE.md",
    external: true,
  },
  {
    key: "runtime-direction",
    name: "Extend beyond OpenClaw",
    price: "Direction",
    period: "OpenClaw-first today",
    description: "Nora should stay useful as an agent-operations control plane even as more runtimes are integrated over time.",
    icon: GitBranch,
    features: [
      "Avoid locking the product story to one runtime forever",
      "Keep terminology and docs broad enough for future integrations",
      "Use OpenClaw as the best-supported proof path today",
      "Design for cleaner runtime adapters over time",
    ],
    cta: "Read runtime direction",
    href: "https://github.com/solomon2773/nora#runtime-direction",
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
    label: "Repo",
    href: "https://github.com/solomon2773/nora",
    text: "github.com/solomon2773/nora",
  },
  {
    label: "Live app / hosted eval / managed path",
    href: "https://nora.solomontsao.com",
    text: "nora.solomontsao.com",
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

const PROOF_RESOURCES = [
  {
    title: "Open-source usage guide",
    desc: "Repo-native explanation of Apache 2.0 rights, self-hosting, and runtime direction framing.",
    href: "https://github.com/solomon2773/nora/blob/master/docs/OPEN_SOURCE_USAGE.md",
  },
  {
    title: "Implementation proof",
    desc: "Code-backed proof that install flows, auth, operator UI, and runtime direction all exist in-repo today.",
    href: "https://github.com/solomon2773/nora/blob/master/docs/IMPLEMENTATION_PROOF.md",
  },
  {
    title: "README screenshot plan",
    desc: "Plan for expanding README proof with onboarding and operator screenshots.",
    href: "https://github.com/solomon2773/nora/blob/master/docs/README_SCREENSHOT_PLAN.md",
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
        <p className="text-blue-400 text-sm font-bold uppercase tracking-widest mb-4">Open-source usage & runtime direction</p>
        <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-tight mb-6">
          Fully open source.
          <br />
          <span className="text-blue-400">Self-host it, extend it, or run it commercially yourself.</span>
        </h1>
        <p className="text-lg text-slate-400 max-w-3xl mx-auto">
          Nora is Apache 2.0 licensed. That means the full repo can stay public, teams can self-host it, and operators can
          commercially offer Nora-based services on infrastructure they control. OpenClaw is the strongest supported runtime today,
          but the long-term product direction should remain runtime-friendly.
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

      <div className="max-w-6xl mx-auto px-6 pb-12 grid md:grid-cols-2 gap-6">
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <GitBranch size={18} className="text-blue-400" />
            <h2 className="text-xl font-black">Runtime direction</h2>
          </div>
          <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
            <p><span className="font-bold text-white">Today:</span> OpenClaw is the clearest and strongest supported runtime path in Nora.</p>
            <p><span className="font-bold text-white">Direction:</span> Nora should stay useful as a broader agent-operations control plane rather than a permanently single-runtime shell.</p>
            <p><span className="font-bold text-white">Rule:</span> use OpenClaw to prove current product value, but keep docs and UX compatible with future runtime integrations.</p>
          </div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <FileText size={18} className="text-blue-400" />
            <h2 className="text-xl font-black">Public repo rule</h2>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">
            The repo should center the product itself: installability, screenshots, operator workflows, and clear Apache 2.0 rights.
            It should not depend on maintainer-commercial framing as the main reason to trust Nora.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-6">
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
          <h2 className="text-2xl md:text-4xl font-black tracking-tight">Evidence operators can inspect today</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
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
