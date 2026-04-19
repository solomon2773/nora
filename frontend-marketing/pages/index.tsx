import Head from "next/head";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Boxes,
  Cpu,
  Globe,
  Layers,
  Lock,
  Menu,
  Server,
  Shield,
  X,
  Zap,
} from "lucide-react";
import { useState } from "react";

const OSS_REPO_URL = "https://github.com/solomon2773/nora";
const QUICKSTART_URL = `${OSS_REPO_URL}#quick-start`;
const RAW_REPO_BASE_URL =
  "https://raw.githubusercontent.com/solomon2773/nora/master";
const SETUP_SH_URL = `${RAW_REPO_BASE_URL}/setup.sh`;
const SETUP_PS1_URL = `${RAW_REPO_BASE_URL}/setup.ps1`;

const TRUST_ITEMS = [
  {
    label: "Fully open source",
    text: "The public repo is the trust anchor. Teams can inspect the product before they adopt it.",
  },
  {
    label: "Commercial self-hosting",
    text: "Apache 2.0 allows companies to run Nora on their own infrastructure and use it commercially.",
  },
  {
    label: "Operator workflow",
    text: "Deploy OpenClaw or Hermes runtimes, manage keys, inspect logs, and work from the same control surface.",
  },
  {
    label: "User-run PaaS mode",
    text: "PaaS mode is part of the open product. Operators can host Nora for their own business or internal platform.",
  },
];

const CONTROL_LANES = [
  {
    label: "Deploy",
    title: "Launch agent runtimes without stitching together the stack by hand.",
    detail: "OpenClaw is the broadest path today. Hermes is supported as a Docker runtime.",
  },
  {
    label: "Observe",
    title: "Keep chat, logs, metrics, and runtime state in the same operator loop.",
    detail: "OpenClaw chat and metrics or Hermes WebUI, plus logs and terminal access.",
  },
  {
    label: "Control",
    title: "Store provider keys, wire integrations, and manage access from one place.",
    detail: "Built for teams that care about infrastructure ownership.",
  },
];

const PLATFORM_ROWS = [
  {
    icon: Server,
    title: "Isolated runtime infrastructure",
    copy: "Provision dedicated OpenClaw or Hermes environments instead of squeezing operations into a thin dashboard shell.",
  },
  {
    icon: Lock,
    title: "Secrets and operator controls",
    copy: "Keep provider keys and integration credentials inside an operator platform built for real operations.",
  },
  {
    icon: Globe,
    title: "Channels and integrations",
    copy: "Connect communication channels, developer systems, and cloud tools from a single operating surface.",
  },
  {
    icon: BarChart3,
    title: "Logs, metrics, and terminal access",
    copy: "Confirm runtime behavior with OpenClaw chat and metrics or Hermes WebUI, plus logs and terminal access in one operator surface.",
  },
];

const WORKFLOW = [
  {
    step: "01",
    title: "Create an operator account",
    body: "Sign in on the hosted instance or create the first account on a self-hosted Nora deployment.",
  },
  {
    step: "02",
    title: "Add one provider and one runtime",
    body: "Save an LLM key, choose OpenClaw or Hermes, and configure the first deployment.",
  },
  {
    step: "03",
    title: "Validate the operator loop",
    body: "Use OpenClaw chat, logs, metrics, and terminal access or Hermes WebUI, logs, and terminal access to verify that the runtime is actually usable.",
  },
];

const TRUST_SURFACES = [
  {
    title: "Public GitHub repo",
    copy: "Read the source, architecture, and quick start in the open before you trust the platform.",
    href: OSS_REPO_URL,
  },
  {
    title: "README quick start",
    copy: "Clone the repo or use the installer paths to get Nora running on infrastructure you control.",
    href: QUICKSTART_URL,
  },
  {
    title: "Bash installer",
    copy: "Use the public install script when you want a faster self-hosted first run on macOS, Linux, or WSL2.",
    href: SETUP_SH_URL,
  },
  {
    title: "PowerShell installer",
    copy: "Use the PowerShell installer for Windows-first self-hosted setups.",
    href: SETUP_PS1_URL,
  },
];

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <Head>
        <title>Nora | Deploy intelligence anywhere.</title>
        <meta
          name="description"
          content="Nora helps teams deploy, observe, and operate OpenClaw and Hermes agent runtimes. Create an account, inspect the public repo, self-host it, and use it commercially under Apache 2.0."
        />
      </Head>

      <div className="site-shell min-h-screen text-white">
        <header className="fixed inset-x-0 top-0 z-50 px-4 sm:px-6">
          <div className="mx-auto mt-4 flex max-w-7xl items-center justify-between rounded-full border border-white/10 bg-black/25 px-4 py-3 backdrop-blur-xl sm:px-5">
            <Link href="/" className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-sm font-black text-white">
                N
              </div>
              <div>
                <div className="text-sm font-black uppercase tracking-[0.28em] text-slate-300">Nora</div>
                <div className="text-xs text-slate-500">Deploy intelligence anywhere.</div>
              </div>
            </Link>

            <nav className="hidden items-center gap-8 text-sm font-semibold text-slate-300 md:flex">
              <a href="#platform" className="transition-colors hover:text-white">
                Platform
              </a>
              <a href="#workflow" className="transition-colors hover:text-white">
                Workflow
              </a>
              <a href="#trust" className="transition-colors hover:text-white">
                Trust
              </a>
              <Link href="/pricing" className="transition-colors hover:text-white">
                License
              </Link>
            </nav>

            <div className="hidden items-center gap-3 md:flex">
              <a
                href={OSS_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="link-chip bg-transparent"
              >
                GitHub <ArrowUpRight size={16} />
              </a>
              <Link
                href="/login"
                className="rounded-full border border-white/12 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-white/6"
              >
                Log In
              </Link>
              <Link
                href="/signup"
                className="rounded-full bg-[#f2e3c5] px-4 py-2 text-sm font-black text-slate-950 transition-transform hover:-translate-y-0.5"
              >
                Create Account
              </Link>
            </div>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-200 md:hidden"
              aria-label="Toggle navigation"
            >
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>

          {mobileMenuOpen && (
            <div className="mx-auto mt-3 max-w-7xl rounded-[28px] border border-white/10 bg-[#09131d]/94 p-5 text-sm text-slate-200 backdrop-blur-xl md:hidden">
              <div className="flex flex-col gap-4">
                <a href="#platform" onClick={() => setMobileMenuOpen(false)}>
                  Platform
                </a>
                <a href="#workflow" onClick={() => setMobileMenuOpen(false)}>
                  Workflow
                </a>
                <a href="#trust" onClick={() => setMobileMenuOpen(false)}>
                  Trust
                </a>
                <Link href="/pricing" onClick={() => setMobileMenuOpen(false)}>
                  License
                </Link>
                <div className="soft-rule" />
                <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
                  Log In
                </Link>
                <Link href="/signup" onClick={() => setMobileMenuOpen(false)}>
                  Create Account
                </Link>
                <a
                  href={OSS_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  GitHub Repo
                </a>
              </div>
            </div>
          )}
        </header>

        <main className="px-4 pb-24 pt-24 sm:px-6">
          <section className="mx-auto grid max-w-7xl items-end gap-12 pb-16 pt-8 lg:min-h-[calc(100svh-7rem)] lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)] lg:pb-24">
            <div className="max-w-2xl">
              <div className="eyebrow mb-6">
                <Boxes size={14} />
                Fully open source. Commercial self-hosting allowed.
              </div>

              <h1 className="max-w-4xl text-5xl font-black leading-[0.95] text-white sm:text-6xl lg:text-7xl">
                Deploy intelligence anywhere.
              </h1>

              <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
                Nora gives operator teams one place to deploy OpenClaw and Hermes runtimes, manage provider keys, inspect
                logs, open terminals, and monitor activity. OpenClaw is the broadest operator path today, while Hermes is
                supported as a Docker-managed runtime with its own WebUI. The product is fully open source, self-hostable,
                and commercially usable under Apache 2.0, whether you are running it for your own team or operating Nora in
                PaaS mode for your own business.
              </p>

              <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#f2e3c5] px-6 py-3 text-base font-black text-slate-950 transition-transform hover:-translate-y-0.5"
                >
                  Create Account <ArrowRight size={18} />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-white/12 px-6 py-3 text-base font-bold text-white transition-colors hover:bg-white/6"
                >
                  Log In
                </Link>
                <a
                  href={OSS_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[#8ae6ff]/20 bg-[#8ae6ff]/8 px-6 py-3 text-base font-bold text-[#dff9ff] transition-colors hover:bg-[#8ae6ff]/14"
                >
                  View GitHub Repo <ArrowUpRight size={18} />
                </a>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-slate-400">
                <a href={QUICKSTART_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                  Open self-host quick start
                </a>
                <a href={SETUP_SH_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                  Install from bash
                </a>
                <Link href="/pricing" className="hover:text-white">
                  Read license and self-hosting details
                </Link>
              </div>
            </div>

            <div className="relative">
              <div className="absolute inset-0 rounded-[36px] bg-[radial-gradient(circle_at_top_left,rgba(242,215,161,0.24),transparent_36%),radial-gradient(circle_at_bottom_right,rgba(138,230,255,0.2),transparent_28%)] blur-2xl" />
              <div className="panel-shell-strong surface-grid float-soft relative overflow-hidden rounded-[36px] p-5 sm:p-6">
                <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[#8ae6ff] to-transparent opacity-70" />
                <div className="flex items-end justify-between gap-6 border-b border-white/10 pb-6">
                  <div>
                    <div className="eyebrow mb-4 border-[#8ae6ff]/20 bg-[#8ae6ff]/8 text-[#dff9ff]">
                      <Zap size={14} />
                      Operator Surface
                    </div>
                    <h2 className="max-w-sm text-3xl font-black leading-tight text-white">
                      Deploy, observe, and control OpenClaw and Hermes from one operating loop.
                    </h2>
                  </div>
                  <div className="hidden text-right sm:block">
                    <div className="text-[0.62rem] font-black uppercase tracking-[0.28em] text-slate-500">Path</div>
                    <div className="mt-2 text-sm font-semibold text-slate-200">/app/dashboard</div>
                  </div>
                </div>

                <div className="mt-4">
                  {CONTROL_LANES.map((lane, index) => (
                    <div
                      key={lane.label}
                      className={`glow-line grid gap-3 px-1 py-5 sm:grid-cols-[88px_minmax(0,1fr)_160px] ${
                        index !== CONTROL_LANES.length - 1 ? "border-b border-white/8" : ""
                      }`}
                    >
                      <div className="text-xs font-black uppercase tracking-[0.28em] text-[#f2d7a1]">{lane.label}</div>
                      <div className="text-base font-semibold leading-7 text-white">{lane.title}</div>
                      <div className="text-sm text-slate-400 sm:text-right">{lane.detail}</div>
                    </div>
                  ))}
                </div>

              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl pb-8">
            <div className="panel-shell rounded-[32px] p-6 md:p-8">
              <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
                {TRUST_ITEMS.map((item, index) => (
                  <div
                    key={item.label}
                    className={`${index !== TRUST_ITEMS.length - 1 ? "xl:border-r xl:border-white/10 xl:pr-6" : ""}`}
                  >
                    <div className="text-xs font-black uppercase tracking-[0.28em] text-[#f2d7a1]">{item.label}</div>
                    <p className="mt-3 text-sm leading-7 text-slate-300">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="platform" className="mx-auto max-w-7xl py-16">
            <div className="grid gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-start">
              <div>
                <div className="eyebrow mb-5">
                  <Cpu size={14} />
                  Built for operators
                </div>
                <h2 className="max-w-lg text-4xl font-black leading-tight text-white sm:text-5xl">
                  Nora is the working surface, not a wrapper around missing infrastructure.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-8 text-slate-300">
                  The public product story is simple: teams can create an account quickly, inspect the repo, and move from
                  first deploy to live OpenClaw or Hermes operations without hiding the operational details.
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-4">
                    <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">Surface</div>
                    <div className="mt-2 text-lg font-black text-white">Deploy</div>
                  </div>
                  <div className="rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-4">
                    <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">Surface</div>
                    <div className="mt-2 text-lg font-black text-white">Observe</div>
                  </div>
                  <div className="rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-4">
                    <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">Surface</div>
                    <div className="mt-2 text-lg font-black text-white">Control</div>
                  </div>
                </div>
              </div>

              <div className="panel-shell rounded-[32px] p-5 sm:p-6">
                {PLATFORM_ROWS.map((row, index) => {
                  const Icon = row.icon;
                  return (
                    <div
                      key={row.title}
                      className={`grid gap-4 py-5 sm:grid-cols-[52px_minmax(0,1fr)] ${
                        index !== PLATFORM_ROWS.length - 1 ? "border-b border-white/8" : ""
                      }`}
                    >
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-[#8ae6ff]">
                        <Icon size={20} />
                      </div>
                      <div>
                        <h3 className="text-xl font-black text-white">{row.title}</h3>
                        <p className="mt-2 text-sm leading-7 text-slate-400">{row.copy}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section id="workflow" className="mx-auto max-w-7xl py-8">
            <div className="panel-shell rounded-[36px] px-6 py-8 sm:px-8 sm:py-10">
              <div className="max-w-2xl">
                <div className="eyebrow mb-5">
                  <Layers size={14} />
                  Fast path to value
                </div>
                <h2 className="text-4xl font-black leading-tight text-white sm:text-5xl">
                  Move from account creation to a working runtime in one short loop.
                </h2>
              </div>

              <div className="mt-10 grid gap-6 lg:grid-cols-3">
                {WORKFLOW.map((item, index) => (
                  <div
                    key={item.step}
                    className={`rounded-[28px] border border-white/10 bg-white/[0.03] px-5 py-6 ${
                      index === 1 ? "lg:translate-y-6" : ""
                    }`}
                  >
                    <div className="text-sm font-black uppercase tracking-[0.28em] text-[#f2d7a1]">{item.step}</div>
                    <h3 className="mt-3 text-2xl font-black text-white">{item.title}</h3>
                    <p className="mt-4 text-sm leading-7 text-slate-400">{item.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="trust" className="mx-auto max-w-7xl py-16">
            <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div>
                <div className="eyebrow mb-5">
                  <Shield size={14} />
                  Public trust path
                </div>
                <h2 className="max-w-lg text-4xl font-black leading-tight text-white sm:text-5xl">
                  The public repo should answer the first trust questions without extra gatekeeping.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-8 text-slate-300">
                  Nora’s strongest public claim is simple: operators can read the code, run the product, and bring the self-host
                  path online before making a bigger commitment.
                </p>
              </div>

              <div className="panel-shell rounded-[32px] p-5 sm:p-6">
                {TRUST_SURFACES.map((item, index) => (
                  <a
                    key={item.title}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`block rounded-[26px] px-4 py-5 transition-colors hover:bg-white/[0.04] ${
                      index !== TRUST_SURFACES.length - 1 ? "border-b border-white/8" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-lg font-black text-white">{item.title}</div>
                        <p className="mt-2 max-w-xl text-sm leading-7 text-slate-400">{item.copy}</p>
                      </div>
                      <ArrowUpRight size={18} className="mt-1 shrink-0 text-[#8ae6ff]" />
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-7xl pt-4">
            <div className="panel-warm rounded-[36px] px-6 py-8 sm:px-8 sm:py-10">
              <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="max-w-2xl">
                  <div className="eyebrow eyebrow-warm mb-5 border-black/10 bg-black/5 text-black/75">
                    <Zap size={14} />
                    Start with the repo or start with an account
                  </div>
                  <h2 className="max-w-2xl text-4xl font-black leading-tight text-slate-950 sm:text-5xl">
                    Keep the public path simple: inspect the code, then log in or self-host.
                  </h2>
                  <p className="mt-5 max-w-xl text-base leading-8 text-slate-700">
                    Nora should feel straightforward to adopt. The product is fully open source. Self-hosting is allowed.
                    Commercial use is allowed. The GitHub repo stays public and the account flow stays easy.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
                  <Link
                    href="/signup"
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-slate-950 px-6 py-3 text-sm font-black text-white transition-transform hover:-translate-y-0.5"
                  >
                    Create Account <ArrowRight size={16} />
                  </Link>
                  <Link
                    href="/login"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-black/10 px-6 py-3 text-sm font-black text-slate-950 transition-colors hover:bg-black/5"
                  >
                    Log In
                  </Link>
                  <a
                    href={OSS_REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-black/10 px-6 py-3 text-sm font-black text-slate-950 transition-colors hover:bg-black/5"
                  >
                    GitHub Repo <ArrowUpRight size={16} />
                  </a>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className="px-4 pb-10 pt-16 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-8 border-t border-white/8 pt-8 md:flex-row md:items-end md:justify-between">
            <div className="max-w-lg">
              <div className="text-xs font-black uppercase tracking-[0.32em] text-slate-500">Nora</div>
              <p className="mt-3 text-sm leading-7 text-slate-400">
                Deploy intelligence anywhere. Open source, self-hostable, and commercially usable under Apache 2.0.
              </p>
            </div>

            <div className="flex flex-col gap-3 text-sm text-slate-400 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
              <a href={OSS_REPO_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                GitHub
              </a>
              <a href={QUICKSTART_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                Quick Start
              </a>
              <Link href="/pricing" className="hover:text-white">
                License
              </Link>
              <Link href="/login" className="hover:text-white">
                Log In
              </Link>
              <Link href="/signup" className="hover:text-white">
                Create Account
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
