import Image from "next/image";
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
  Scale,
  Server,
  Shield,
  Star,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import LanguageSwitcher from "../components/LanguageSwitcher";
import SeoHead from "../components/SeoHead";
import { SignupGate } from "../components/SignupGate";
import { trackEvent } from "../lib/analytics";
import { useI18n } from "../lib/i18n";

const OSS_REPO_URL = "https://github.com/solomon2773/nora";
const STAR_URL = OSS_REPO_URL;
const RELEASES_URL = `${OSS_REPO_URL}/releases/latest`;
const CONTRIBUTING_URL = `${OSS_REPO_URL}/blob/master/CONTRIBUTING.md`;
const COMMUNITY_URL = `${OSS_REPO_URL}/discussions`;
const DOCS_URL = "https://noradocs.solomontsao.com";
const QUICKSTART_URL = `${DOCS_URL}/quickstart`;
const DEMO_SIGNUP_PATH = "/signup?intent=demo";
const SITE_URL = "https://nora.solomontsao.com/";
const SEO_TITLE = "Nora — Run OpenClaw & Hermes on your infrastructure";
const SEO_DESCRIPTION =
  "Try a zero-key demo, then deploy, monitor, and operate OpenClaw and Hermes fleets on Docker or Kubernetes with Nora's Apache-2.0 control plane.";
const HOMEPAGE_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Nora",
  description: SEO_DESCRIPTION,
  url: SITE_URL,
  codeRepository: OSS_REPO_URL,
  downloadUrl: `${OSS_REPO_URL}/releases/latest`,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Linux, macOS, Windows",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  isAccessibleForFree: true,
};

const TRUST_ITEMS = [
  {
    label: "Open source",
    text: "Read the source, audit the architecture, and run Nora before you commit to it.",
  },
  {
    label: "Zero-key first proof",
    text: "Deploy the built-in deterministic demo agent before connecting a paid model provider.",
  },
  {
    label: "Self-hosted control",
    text: "Deploy the control plane on infrastructure you operate, with GA agent placement on Docker and Kubernetes.",
  },
  {
    label: "Runtime operations",
    text: "Deploy OpenClaw or Hermes, manage provider keys, inspect logs, and open runtime terminals.",
  },
];

const PLATFORM_ROWS = [
  {
    icon: Server,
    title: "Provision real runtime targets",
    copy: "Use GA Docker or Admin-registered Kubernetes today. Proxmox unprivileged LXC is experimental for OpenClaw and prepared Hermes images; real-hardware smoke is still required before production.",
  },
  {
    icon: Lock,
    title: "Keep credentials under control",
    copy: "Store provider keys and integration secrets encrypted, scope them by workspace, and rotate them when needed.",
  },
  {
    icon: Globe,
    title: "Connect the systems agents need",
    copy: "Configure communication channels, developer tools, cloud providers, and automation endpoints from one surface.",
  },
  {
    icon: BarChart3,
    title: "Debug from the same place",
    copy: "Use chat, metrics, logs, terminal access, alert rules, and cost views to understand what each runtime is doing.",
  },
];

const WORKFLOW = [
  {
    step: "01",
    title: "Install or create an operator account",
    body: "Run Nora on your infrastructure or use the reference deployment, then enter the guided Getting Started path.",
  },
  {
    step: "02",
    title: "Launch the zero-key demo",
    body: "Enable the built-in deterministic demo provider and deploy a working agent without an external API key or model bill.",
  },
  {
    step: "03",
    title: "Validate, then connect a real provider",
    body: "Prove chat, logs, metrics, and terminal access first. Add your provider and choose Docker or Kubernetes when you are ready for a live workload.",
  },
];

const TRUST_SURFACES = [
  {
    title: "Public GitHub repo",
    copy: "Review the source, architecture, release notes, and contribution path in the open.",
    href: OSS_REPO_URL,
  },
  {
    title: "Self-host quick start",
    copy: "Install Nora, create an operator account, and validate the first runtime on infrastructure you control.",
    href: QUICKSTART_URL,
  },
  {
    title: "Contributor guide",
    copy: "Find the development workflow, contribution areas, and a path to a focused first pull request.",
    href: CONTRIBUTING_URL,
  },
  {
    title: "GitHub community",
    copy: "Ask setup questions, share an operator workflow, or align on a larger contribution before coding.",
    href: COMMUNITY_URL,
  },
];

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t } = useI18n();
  const localizedSeoTitle = t(SEO_TITLE);
  const localizedSeoDescription = t(SEO_DESCRIPTION);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);

  return (
    <>
      <SeoHead
        title={localizedSeoTitle}
        description={localizedSeoDescription}
        path="/"
        imageAlt={t("Nora operator dashboard for OpenClaw and Hermes fleets")}
        structuredData={{
          ...HOMEPAGE_STRUCTURED_DATA,
          description: localizedSeoDescription,
        }}
      />

      <div className="site-shell min-h-screen text-brand-ink">
        <header className="fixed inset-x-0 top-0 z-50 px-4 sm:px-6">
          <div className="mx-auto mt-4 flex max-w-7xl items-center justify-between rounded-2xl border border-brand-cyan/25 bg-white/90 px-4 py-3 shadow-xl shadow-brand-ink/10 backdrop-blur-xl sm:px-5">
            <Link href="/" className="flex items-center gap-3">
              <img src="/logo-mark.png" alt="Nora" width={40} height={40} className="h-10 w-10" />
              <div>
                <div className="text-sm font-black uppercase tracking-[0.28em] text-brand-ink">
                  Nora
                </div>
                <div className="text-xs text-slate-600">{t("Deploy intelligence anywhere.")}</div>
              </div>
            </Link>

            <nav
              aria-label="Primary navigation"
              className="hidden items-center gap-5 text-sm font-semibold text-slate-600 lg:flex"
            >
              <a href="#platform" className="transition-colors hover:text-brand-ink">
                {t("Platform")}
              </a>
              <a href="#workflow" className="transition-colors hover:text-brand-ink">
                {t("Workflow")}
              </a>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-brand-ink"
              >
                {t("Docs")}
              </a>
              <a
                href={CONTRIBUTING_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-brand-ink"
              >
                {t("Contribute")}
              </a>
            </nav>

            <div className="hidden items-center gap-2.5 lg:flex">
              <LanguageSwitcher />
              <a
                href={STAR_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="link-chip bg-transparent"
              >
                <Star size={15} /> {t("Star")}
              </a>
              <Link
                href="/login"
                className="px-2 py-2 text-sm font-bold text-brand-ink transition-colors hover:text-slate-600"
              >
                {t("Log In")}
              </Link>
              <SignupGate>
                <Link
                  href={DEMO_SIGNUP_PATH}
                  className="rounded-full bg-brand-gold px-4 py-2 text-sm font-black text-brand-ink shadow-lg shadow-brand-gold/25 transition-transform hover:-translate-y-0.5"
                >
                  {t("Try Demo")}
                </Link>
              </SignupGate>
            </div>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-brand-ink/10 bg-white/80 text-brand-ink lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-navigation"
            >
              {mobileMenuOpen ? (
                <X size={18} aria-hidden="true" />
              ) : (
                <Menu size={18} aria-hidden="true" />
              )}
            </button>
          </div>

          {mobileMenuOpen && (
            <nav
              id="mobile-navigation"
              aria-label="Mobile navigation"
              className="mx-auto mt-3 max-w-7xl rounded-2xl border border-brand-cyan/25 bg-white/95 p-5 text-sm font-semibold text-slate-700 shadow-xl shadow-brand-ink/10 backdrop-blur-xl lg:hidden"
            >
              <div className="flex flex-col gap-4">
                <a href="#platform" onClick={() => setMobileMenuOpen(false)}>
                  {t("Platform")}
                </a>
                <a href="#workflow" onClick={() => setMobileMenuOpen(false)}>
                  {t("Workflow")}
                </a>
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {t("Docs")}
                </a>
                <a
                  href={CONTRIBUTING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {t("Contribute")}
                </a>
                <a
                  href={COMMUNITY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {t("Community")}
                </a>
                <div className="soft-rule" />
                <LanguageSwitcher className="w-full justify-between" />
                <SignupGate>
                  <Link href={DEMO_SIGNUP_PATH} onClick={() => setMobileMenuOpen(false)}>
                    {t("Try the zero-key demo")}
                  </Link>
                </SignupGate>
                <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
                  {t("Log In")}
                </Link>
                <a
                  href={STAR_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {t("Star Nora on GitHub")}
                </a>
              </div>
            </nav>
          )}
        </header>

        <main className="px-4 pb-24 pt-24 sm:px-6">
          <section className="mx-auto grid max-w-7xl items-center gap-10 pb-16 pt-8 lg:min-h-[calc(100svh-7rem)] lg:grid-cols-[minmax(0,0.9fr)_minmax(480px,1.1fr)] lg:pb-20">
            <div className="max-w-2xl">
              <div className="eyebrow mb-6">
                <Boxes size={14} />
                {t("Apache-2.0 control plane for agent runtimes")}
              </div>

              <h1 className="max-w-4xl text-5xl font-black leading-[0.95] text-brand-ink sm:text-6xl lg:text-7xl">
                {t("Run OpenClaw and Hermes on infrastructure you control.")}
              </h1>

              <p className="mt-6 max-w-xl text-base leading-7 text-slate-700 sm:text-lg">
                {t(
                  "Nora gives operators one place to deploy, observe, and control agent runtimes on GA Docker and Kubernetes targets. Start with a zero-key demo, then connect providers, inspect logs and metrics, open terminals, and operate the fleet from one dashboard.",
                )}
              </p>

              <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <SignupGate>
                  <Link
                    href={DEMO_SIGNUP_PATH}
                    onClick={() => trackEvent("Demo CTA", { location: "hero" })}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-gold px-6 py-3 text-base font-black text-brand-ink shadow-lg shadow-brand-gold/25 transition-transform hover:-translate-y-0.5"
                  >
                    {t("Try the zero-key demo")} <ArrowRight size={18} />
                  </Link>
                </SignupGate>
                <a
                  href={STAR_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => trackEvent("GitHub", { location: "hero-cta" })}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-brand-cyan/40 bg-brand-cyan/20 px-6 py-3 text-base font-bold text-brand-ink transition-colors hover:bg-brand-cyan/30"
                >
                  <Star size={17} /> {t("Star on GitHub")}
                </a>
                <a
                  href={QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => trackEvent("Self-host CTA", { location: "hero" })}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-brand-ink/10 bg-white/75 px-6 py-3 text-base font-bold text-brand-ink transition-colors hover:bg-brand-cyan/16"
                >
                  {t("Self-host Nora")} <ArrowUpRight size={18} />
                </a>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <span className="inline-flex items-center gap-2 rounded-full border border-brand-gold/50 bg-brand-gold/35 px-3.5 py-1.5 text-sm font-bold text-brand-ink">
                  <Scale size={14} /> Apache-2.0
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border border-brand-cyan/35 bg-brand-cyan/16 px-3.5 py-1.5 text-sm font-bold text-brand-ink">
                  {t("Docker + Kubernetes GA")}
                </span>
                <a
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-full border border-brand-ink/10 bg-white/70 px-3.5 py-1.5 text-sm font-bold text-slate-700 transition-colors hover:text-brand-ink"
                >
                  {t("Latest release")} <ArrowUpRight size={14} />
                </a>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm font-semibold text-slate-600">
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-brand-ink"
                >
                  {t("Read the docs")}
                </a>
                <a
                  href={CONTRIBUTING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-brand-ink"
                >
                  {t("Contribute")}
                </a>
                <a
                  href={COMMUNITY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-brand-ink"
                >
                  {t("Join the community")}
                </a>
              </div>
            </div>

            <div id="product-proof" className="relative scroll-mt-32">
              <div className="absolute inset-0 rounded-[36px] bg-[radial-gradient(circle_at_top_left,rgba(242,215,161,0.24),transparent_36%),radial-gradient(circle_at_bottom_right,rgba(138,230,255,0.2),transparent_28%)] blur-2xl" />
              <div className="panel-shell-strong float-soft relative overflow-hidden rounded-[36px] p-3 sm:p-4">
                <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[#8ae6ff] to-transparent opacity-70" />
                <div className="flex items-center justify-between gap-4 px-2 pb-3 pt-1 sm:px-3">
                  <div>
                    <div className="eyebrow border-[#8ae6ff]/20 bg-[#8ae6ff]/8 text-[#eef4fb]">
                      <Zap size={14} />
                      {t("Real product capture")}
                    </div>
                  </div>
                  <span className="text-xs font-bold text-slate-400">/app/dashboard</span>
                </div>
                <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[#eef4fb] shadow-2xl shadow-black/30">
                  <Image
                    src="/operator-dashboard.png"
                    alt={t("Nora operator dashboard showing active agents and recent deployments")}
                    width={1512}
                    height={1080}
                    priority
                    sizes="(max-width: 1023px) 100vw, 56vw"
                    className="h-auto w-full"
                    data-testid="product-proof-image"
                  />
                </div>
                <div className="flex flex-col gap-3 px-2 pb-1 pt-4 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between sm:px-3">
                  <p>{t("Seeded local capture: fleet health, queues, and deployment status.")}</p>
                  <a
                    href="/walkthrough.mp4"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-2 font-bold text-brand-cyan hover:text-white"
                  >
                    {t("Watch 37s walkthrough")} <ArrowUpRight size={15} />
                  </a>
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
                    <div className="text-xs font-black uppercase tracking-[0.28em] text-[#f2d7a1]">
                      {t(item.label)}
                    </div>
                    <p className="mt-3 text-sm leading-7 text-slate-300">{t(item.text)}</p>
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
                <h2 className="max-w-lg text-4xl font-black leading-tight text-brand-ink sm:text-5xl">
                  One dashboard for the agent lifecycle.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-8 text-slate-700">
                  Nora keeps deployment, secrets, runtime status, logs, alerts, and cost visibility
                  in one operator surface, so teams do not have to stitch together separate tools
                  for every agent backend.
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-brand-cyan/25 bg-white/75 px-4 py-4 shadow-sm">
                    <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">
                      Surface
                    </div>
                    <div className="mt-2 text-lg font-black text-brand-ink">Deploy</div>
                  </div>
                  <div className="rounded-2xl border border-brand-cyan/25 bg-white/75 px-4 py-4 shadow-sm">
                    <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">
                      Surface
                    </div>
                    <div className="mt-2 text-lg font-black text-brand-ink">Observe</div>
                  </div>
                  <div className="rounded-2xl border border-brand-cyan/25 bg-white/75 px-4 py-4 shadow-sm">
                    <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">
                      Surface
                    </div>
                    <div className="mt-2 text-lg font-black text-brand-ink">Control</div>
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
                <h2 className="text-4xl font-black leading-tight text-brand-ink sm:text-5xl">
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
                    <div className="text-sm font-black uppercase tracking-[0.28em] text-[#f2d7a1]">
                      {item.step}
                    </div>
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
                <h2 className="max-w-lg text-4xl font-black leading-tight text-brand-ink sm:text-5xl">
                  The trust path starts with source you can inspect.
                </h2>
                <p className="mt-5 max-w-lg text-base leading-8 text-slate-700">
                  Operators can review the repo, run the quick start, evaluate the dashboard, and
                  decide how far to take Nora without handing over control of keys or
                  infrastructure.
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
                        <p className="mt-2 max-w-xl text-sm leading-7 text-slate-400">
                          {item.copy}
                        </p>
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
                    Prove it before you connect a paid model
                  </div>
                  <h2 className="max-w-2xl text-4xl font-black leading-tight text-slate-950 sm:text-5xl">
                    Try the operator loop, then make Nora yours.
                  </h2>
                  <p className="mt-5 max-w-xl text-base leading-8 text-slate-700">
                    Launch the deterministic demo agent with no external API key, inspect the real
                    operator workflow, then self-host, star, or contribute to the Apache-2.0
                    project.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
                  <SignupGate>
                    <Link
                      href={DEMO_SIGNUP_PATH}
                      className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-gold px-6 py-3 text-sm font-black text-brand-ink transition-transform hover:-translate-y-0.5"
                    >
                      Try Zero-Key Demo <ArrowRight size={16} />
                    </Link>
                  </SignupGate>
                  <a
                    href={QUICKSTART_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-black/10 px-6 py-3 text-sm font-black text-slate-950 transition-colors hover:bg-black/5"
                  >
                    Self-Host <ArrowUpRight size={16} />
                  </a>
                  <a
                    href={CONTRIBUTING_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-full border border-black/10 px-6 py-3 text-sm font-black text-slate-950 transition-colors hover:bg-black/5"
                  >
                    Contribute <ArrowUpRight size={16} />
                  </a>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className="px-4 pb-10 pt-16 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-8 border-t border-brand-ink/10 pt-8 md:flex-row md:items-end md:justify-between">
            <div className="max-w-lg">
              <div className="text-xs font-black uppercase tracking-[0.32em] text-slate-500">
                Nora
              </div>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Deploy intelligence anywhere. Self-hosted, open source, and built for operator teams
                running real agent infrastructure.
              </p>
            </div>

            <div className="flex flex-col gap-3 text-sm font-semibold text-slate-600 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
              <a
                href={STAR_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-brand-ink"
              >
                Star on GitHub
              </a>
              <a
                href={QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-brand-ink"
              >
                Quick Start
              </a>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-brand-ink"
              >
                Docs
              </a>
              <a
                href={CONTRIBUTING_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-brand-ink"
              >
                Contribute
              </a>
              <a
                href={COMMUNITY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-brand-ink"
              >
                Community
              </a>
              <Link href="/pricing" className="hover:text-brand-ink">
                License
              </Link>
              <Link href="/privacy" className="hover:text-brand-ink">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-brand-ink">
                Terms
              </Link>
              <Link href="/login" className="hover:text-brand-ink">
                Log In
              </Link>
              <SignupGate>
                <Link href={DEMO_SIGNUP_PATH} className="hover:text-brand-ink">
                  Try Demo
                </Link>
              </SignupGate>
            </div>
          </div>
          <div className="mx-auto mt-8 max-w-7xl text-xs text-slate-600">
            © {new Date().getFullYear()} Nora · Open source under Apache 2.0
          </div>
        </footer>
      </div>
    </>
  );
}
