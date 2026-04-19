import Head from "next/head";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  Cloud,
  Globe,
  Scale,
  Server,
  Shield,
  Zap,
} from "lucide-react";

const OSS_REPO_URL = "https://github.com/solomon2773/nora";
const QUICKSTART_URL = `${OSS_REPO_URL}#quick-start`;
const PUBLIC_SITE_URL = "https://nora.solomontsao.com";
const LOGIN_URL = `${PUBLIC_SITE_URL}/login`;
const SIGNUP_URL = `${PUBLIC_SITE_URL}/signup`;
const RAW_REPO_BASE_URL =
  "https://raw.githubusercontent.com/solomon2773/nora/master";
const SETUP_SH_URL = `${RAW_REPO_BASE_URL}/setup.sh`;
const SETUP_PS1_URL = `${RAW_REPO_BASE_URL}/setup.ps1`;

const RIGHTS = [
  "Self-host Nora on infrastructure you control.",
  "Use Nora commercially inside your own company.",
  "Run Nora in PaaS mode as your own hosted business or internal platform.",
  "Modify the codebase and extend it with your own workflows, integrations, and packaging.",
  "Host Nora for clients or customers on infrastructure you operate.",
];

const DEPLOYMENT_MODES = [
  {
    icon: Server,
    eyebrow: "Self-hosted mode",
    title: "Run Nora as your own agent operations platform.",
    body: "Use the public repo, install scripts, Docker Compose flow, and your own infrastructure as the trust path.",
    points: [
      "Best fit when you want full infrastructure ownership.",
      "Use the public repo as the source of truth for the OSS product.",
      "Start with the quick start, then create the first operator account.",
    ],
  },
  {
    icon: Cloud,
    eyebrow: "PaaS mode",
    title: "Operate Nora as your own hosted product or internal platform.",
    body: "PaaS mode is part of the open product. It is not a locked maintainer-only service path.",
    points: [
      "Set `PLATFORM_MODE=paas` for plan-locked resources and hosted-style operation.",
      "Connect your own Stripe keys, plans, and billing model.",
      "Customer onboarding, infrastructure, support model, and go-to-market stay under your control.",
    ],
  },
  {
    icon: Globe,
    eyebrow: "Public browser entry",
    title: "Use the default public domain as a reference deployment.",
    body: "The public site is the easiest browser entry, while the public GitHub repo stays the trust anchor.",
    points: [
      "Default public site: `nora.solomontsao.com`.",
      "Use `/login` and `/signup` for fast account entry.",
      "Use `/pricing` as the public OSS, license, and PaaS-mode explainer.",
    ],
  },
];

const TRUST_SURFACES = [
  {
    title: "Public GitHub repo",
    copy: "The open-source platform, architecture, and product code live in the public repository.",
    href: OSS_REPO_URL,
  },
  {
    title: "README quick start",
    copy: "Clone the repo, run the installer, and bring up Nora on infrastructure you control.",
    href: QUICKSTART_URL,
  },
  {
    title: "Bash installer",
    copy: "Use the public install script for macOS, Linux, or WSL2 when you want a faster first run.",
    href: SETUP_SH_URL,
  },
  {
    title: "PowerShell installer",
    copy: "Use the PowerShell installer for Windows-first self-hosted setups.",
    href: SETUP_PS1_URL,
  },
];

const ENTRY_LINKS = [
  { label: "Public site", href: PUBLIC_SITE_URL, text: "nora.solomontsao.com" },
  { label: "Log in", href: LOGIN_URL, text: "nora.solomontsao.com/login" },
  { label: "Create account", href: SIGNUP_URL, text: "nora.solomontsao.com/signup" },
  { label: "GitHub repo", href: OSS_REPO_URL, text: "github.com/solomon2773/nora" },
];

export default function Pricing() {
  return (
    <>
      <Head>
        <title>Open Source, License, and PaaS Mode | Nora</title>
        <meta
          name="description"
          content="Nora is fully open source under Apache 2.0. Self-host it, use it commercially, or run Nora in PaaS mode for your own business."
        />
      </Head>

      <div className="site-shell min-h-screen px-4 pb-10 pt-4 text-white sm:px-6">
        <header className="mx-auto flex max-w-7xl items-center justify-between rounded-full border border-white/10 bg-black/25 px-4 py-3 backdrop-blur-xl sm:px-5">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-sm font-black text-white">
              N
            </div>
            <div>
              <div className="text-sm font-black uppercase tracking-[0.28em] text-slate-300">Nora</div>
              <div className="text-xs text-slate-500">Deploy intelligence anywhere.</div>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <a
              href={OSS_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-full border border-white/12 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-white/6 sm:inline-flex sm:items-center sm:gap-2"
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
        </header>

        <main className="mx-auto max-w-7xl pt-10 lg:pt-12">
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-end">
            <div className="max-w-3xl">
              <div className="eyebrow mb-6">
                <Scale size={14} />
                Apache 2.0 rights, self-hosting, and PaaS mode
              </div>
              <h1 className="text-5xl font-black leading-[0.95] text-white sm:text-6xl">
                Nora is open source first, and PaaS mode is yours to run.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
                Public messaging should be direct: Nora is fully open source, the public repo is the trust anchor, commercial use is
                allowed under Apache 2.0, and `PLATFORM_MODE=paas` exists so operators can run Nora as their own hosted business or
                internal platform.
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <a
                  href={QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#f2e3c5] px-6 py-3 text-sm font-black text-slate-950 transition-transform hover:-translate-y-0.5"
                >
                  Open Quick Start <ArrowRight size={16} />
                </a>
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-white/12 px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-white/6"
                >
                  Create Account
                </Link>
                <a
                  href={OSS_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[#8ae6ff]/20 bg-[#8ae6ff]/8 px-6 py-3 text-sm font-bold text-[#dff9ff] transition-colors hover:bg-[#8ae6ff]/14"
                >
                  View GitHub Repo <ArrowUpRight size={16} />
                </a>
              </div>
            </div>

            <div className="panel-warm rounded-[36px] px-6 py-8 sm:px-8">
              <div className="eyebrow eyebrow-warm mb-5">
                <Shield size={14} />
                Apache 2.0 rights
              </div>
              <h2 className="text-3xl font-black leading-tight text-slate-950">
                What Apache 2.0 means here
              </h2>
              <div className="space-y-4">
                {RIGHTS.map((item) => (
                  <div key={item} className="flex items-start gap-3 text-sm leading-7 text-slate-800">
                    <Check size={18} className="mt-1 shrink-0 text-[#b55e18]" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="py-14">
            <div className="grid gap-6 xl:grid-cols-3">
              {DEPLOYMENT_MODES.map((mode) => {
                const Icon = mode.icon;
                return (
                  <div key={mode.title} className="panel-shell rounded-[32px] p-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-[#8ae6ff]">
                      <Icon size={20} />
                    </div>
                    <div className="mt-5 text-xs font-black uppercase tracking-[0.28em] text-[#f2d7a1]">{mode.eyebrow}</div>
                    <h2 className="mt-3 text-2xl font-black text-white">{mode.title}</h2>
                    <p className="mt-4 text-sm leading-7 text-slate-400">{mode.body}</p>
                    <div className="mt-6 space-y-3">
                      {mode.points.map((point) => (
                        <div key={point} className="flex items-start gap-3 text-sm leading-7 text-slate-300">
                          <Check size={18} className="mt-1 shrink-0 text-[#8ae6ff]" />
                          <span>{point}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="grid gap-8 pb-14 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <div>
                <div className="eyebrow mb-5">
                  <Boxes size={14} />
                  Public trust path
                </div>
              <h2 className="max-w-lg text-4xl font-black leading-tight text-white sm:text-5xl">
                The public repo and public site should explain the product without a service pitch.
              </h2>
              <p className="mt-5 max-w-lg text-base leading-8 text-slate-300">
                What matters publicly is straightforward: the source is open, the install path is public, the login and signup
                flow are easy to find, and PaaS mode belongs to the operators who choose to run it.
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
          </section>

          <section className="panel-shell rounded-[36px] px-6 py-8 sm:px-8 sm:py-10">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
              <div>
                <div className="eyebrow mb-5">
                  <Zap size={14} />
                  Public entry points
                </div>
                <h2 className="max-w-2xl text-4xl font-black leading-tight text-white sm:text-5xl">
                  Keep the public route simple: repo, quick start, login, signup, and OSS rights.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-8 text-slate-300">
                  Users should be able to inspect the code, install Nora, create an account, and understand their commercial rights
                  without being pushed into a maintainer-run service narrative.
                </p>
              </div>

              <div className="space-y-3">
                {ENTRY_LINKS.map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-[26px] border border-white/10 bg-white/[0.03] px-4 py-4 transition-colors hover:bg-white/[0.06]"
                  >
                    <div className="text-xs font-black uppercase tracking-[0.28em] text-slate-500">{item.label}</div>
                    <div className="mt-2 text-lg font-black text-white">{item.text}</div>
                  </a>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
