import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, Loader2, Lock, Mail, Shield, Zap } from "lucide-react";
import { useAuthBootstrap } from "../components/AuthBootstrapProvider";
import LanguageSwitcher from "../components/LanguageSwitcher";
import SeoHead from "../components/SeoHead";
import { SignupGate } from "../components/SignupGate";
import { normalizeLocale, useI18n } from "../lib/i18n";

const OSS_REPO_URL = "https://github.com/solomon2773/nora";
const QUICKSTART_URL = `${OSS_REPO_URL}#quick-start`;

const LOGIN_NOTES = [
  "Use this account to enter the operator dashboard for this Nora instance.",
  "Provider keys, workspaces, deployments, logs, and alerts stay tied to the instance you control.",
  "New environments route you to getting started so you can add a provider and deploy the first runtime.",
];

type LanguageProfile = {
  effectiveLocale?: string;
  defaultLocale?: string;
};

function readLegacyToken() {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

function clearLegacyToken() {
  try {
    localStorage.removeItem("token");
  } catch {
    // A valid HttpOnly cookie session should still proceed when storage is unavailable.
  }
}

export default function Login() {
  const { localizePath, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState("");
  const [error, setError] = useState("");
  const { status: bootstrapStatus, error: bootstrapLoadError } = useAuthBootstrap();
  const bootstrapError = bootstrapLoadError
    ? "OAuth availability could not be checked. Email and password login remains available."
    : "";
  const oauthLoginEnabled = bootstrapStatus?.oauthLoginEnabled === true;
  const platformMode = bootstrapStatus?.platformMode || null;

  const routeAfterLogin = useCallback(async () => {
    try {
      const [profileRes, providersRes, agentsRes] = await Promise.all([
        fetch("/api/auth/me", { credentials: "include" }),
        fetch("/api/llm-providers", { credentials: "include" }),
        fetch("/api/agents", { credentials: "include" }),
      ]);

      const [profile, providers, agents] = await Promise.all([
        profileRes.ok
          ? profileRes.json().catch(() => ({}) as LanguageProfile)
          : ({} as LanguageProfile),
        providersRes.ok ? providersRes.json() : [],
        agentsRes.ok ? agentsRes.json() : [],
      ]);

      const hasProviders = Array.isArray(providers) && providers.length > 0;
      const hasAgents = Array.isArray(agents) && agents.length > 0;
      const targetLocale = normalizeLocale(profile.effectiveLocale || profile.defaultLocale);

      window.location.assign(
        localizePath(
          hasProviders || hasAgents ? "/app/dashboard" : "/app/getting-started",
          targetLocale,
        ),
      );
    } catch (routeErr) {
      console.error(routeErr);
      window.location.assign(localizePath("/app/dashboard"));
    }
  }, [localizePath]);
  const routeAfterLoginRef = useRef(routeAfterLogin);

  useEffect(() => {
    routeAfterLoginRef.current = routeAfterLogin;
  }, [routeAfterLogin]);

  useEffect(() => {
    let cancelled = false;

    async function redirectAuthenticatedSession() {
      let sessionResponse;
      try {
        sessionResponse = await fetch("/api/auth/me", { credentials: "include" });
      } catch {
        return;
      }
      if (cancelled) return;
      if (sessionResponse.ok) {
        clearLegacyToken();
        await routeAfterLoginRef.current();
        return;
      }
      if (sessionResponse.status !== 401) return;

      // Legacy migration: clear any stale HttpOnly cookie first because backend
      // auth deliberately prefers cookies over bearer headers. Then upgrade the
      // legacy bearer into a fresh HttpOnly cookie before deleting localStorage.
      const legacyToken = readLegacyToken();
      if (!legacyToken) return;
      try {
        const logoutResponse = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
        });
        if (cancelled || !logoutResponse.ok) return;

        const upgradeResponse = await fetch("/api/auth/session-upgrade", {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${legacyToken}` },
        });
        if (cancelled || !upgradeResponse.ok) return;

        clearLegacyToken();
        await routeAfterLoginRef.current();
      } catch {
        // Preserve the bearer token so a transient network or backend failure
        // cannot strand an otherwise valid legacy session.
      }
    }

    void redirectAuthenticatedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.token) {
        // The backend set an HttpOnly nora_auth cookie in the response — the
        // JWT is no longer stored client-side, which keeps it out of reach of
        // any script (including XSS payloads). Clear any stale legacy token.
        clearLegacyToken();
        await routeAfterLogin();
        return;
      }

      setError(data.error || t("Login failed. Check your email and password and try again."));
    } catch (loginErr) {
      console.error(loginErr);
      setError(t("Login failed. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  function handleOAuth(provider) {
    if (!oauthLoginEnabled) return;
    setOauthLoading(provider);
    window.location.assign(localizePath(`/auth/oauth/${provider}`));
  }

  return (
    <>
      <SeoHead
        title="Log In | Nora"
        description="Log in to your Nora operator account to deploy and operate OpenClaw and Hermes runtimes on infrastructure you control."
        path="/login"
      />

      <div className="site-shell min-h-screen px-4 pb-10 pt-4 text-brand-ink sm:px-6">
        <header className="mx-auto flex max-w-6xl items-center justify-between rounded-2xl border border-brand-cyan/25 bg-white/90 px-4 py-3 shadow-xl shadow-brand-ink/10 backdrop-blur-xl sm:px-5">
          <Link href="/" className="flex items-center gap-3">
            <img src="/logo-mark.png" alt="Nora" width={40} height={40} className="h-10 w-10" />
            <div>
              <div className="text-sm font-black uppercase tracking-[0.28em] text-brand-ink">
                Nora
              </div>
              <div className="text-xs text-slate-600">Deploy intelligence anywhere.</div>
            </div>
          </Link>

          <div className="flex items-center gap-3">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <a
              href={OSS_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-full border border-brand-ink/10 px-4 py-2 text-sm font-bold text-brand-ink transition-colors hover:bg-brand-cyan/16 sm:inline-flex sm:items-center sm:gap-2"
            >
              GitHub <ArrowUpRight size={16} />
            </a>
            <SignupGate>
              <Link
                href="/signup"
                className="rounded-full bg-brand-cyan px-4 py-2 text-sm font-black text-brand-ink shadow-lg shadow-brand-cyan/25 transition-transform hover:-translate-y-0.5"
              >
                Create Account
              </Link>
            </SignupGate>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-6 pt-10 lg:grid-cols-[minmax(0,1.02fr)_420px] lg:pt-12">
          <section className="order-2 rounded-[36px] panel-shell px-6 py-8 sm:px-8 lg:order-1 lg:px-10">
            <div className="eyebrow mb-5">
              <Shield size={14} />
              Public repo first
            </div>
            <h1 className="max-w-xl text-4xl font-black leading-tight text-white sm:text-5xl">
              Log in to the Nora instance you operate.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-8 text-slate-300">
              Continue to the dashboard for your workspaces, provider keys, runtime deployments,
              monitoring, logs, and terminal access. Nora keeps the account flow simple while the
              control plane stays self-hostable and open source.
            </p>

            <div className="mt-8 rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
              <div className="text-xs font-black uppercase tracking-[0.28em] text-[#f2d7a1]">
                After login
              </div>
              <div className="mt-4 space-y-4">
                {LOGIN_NOTES.map((item) => (
                  <div
                    key={item}
                    className="flex items-start gap-3 text-sm leading-7 text-slate-300"
                  >
                    <CheckCircle2 size={18} className="mt-1 shrink-0 text-[#8ae6ff]" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <a
                href={OSS_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-4 transition-colors hover:bg-white/[0.06]"
              >
                <div className="text-xs font-black uppercase tracking-[0.28em] text-slate-500">
                  Open source repo
                </div>
                <div className="mt-2 text-lg font-black text-white">Browse Nora on GitHub</div>
                <div className="mt-2 text-sm leading-7 text-slate-400">
                  Review the public product code and architecture directly.
                </div>
              </a>
              <a
                href={QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-4 transition-colors hover:bg-white/[0.06]"
              >
                <div className="text-xs font-black uppercase tracking-[0.28em] text-slate-500">
                  Self-host guide
                </div>
                <div className="mt-2 text-lg font-black text-white">Open the quick start</div>
                <div className="mt-2 text-sm leading-7 text-slate-400">
                  Clone the repo, run the installer, and bring up your own Nora instance.
                </div>
              </a>
            </div>

            <div className="mt-6 rounded-[28px] border border-[#8ae6ff]/18 bg-[#8ae6ff]/7 px-5 py-5">
              <div className="text-xs font-black uppercase tracking-[0.28em] text-[#eef4fb]">
                Instance note
              </div>
              <p className="mt-3 text-sm leading-7 text-slate-300">
                {platformMode === "selfhosted"
                  ? "If this is a fresh self-hosted instance, use the operator account created during setup or create the first account before continuing into Settings and Deploy."
                  : platformMode === "paas"
                    ? "If this hosted instance is new for you, create an account first and then come back here to continue into the operator surface."
                    : "Use the operator account created for this Nora instance, or create the first account if registration is still open."}
              </p>
            </div>
          </section>

          <section className="order-1 rounded-[36px] panel-warm px-6 py-8 sm:px-8 lg:order-2">
            <div className="eyebrow eyebrow-warm mb-5">
              <Zap size={14} />
              Easy access
            </div>
            <h2 className="text-3xl font-black leading-tight text-slate-950">
              Log in to your operator account
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-700">
              Use email and password for this Nora instance. If OAuth is enabled here, you can use
              that too.
            </p>

            {oauthLoginEnabled && (
              <div className="mt-6 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => handleOAuth("google")}
                  disabled={!!oauthLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-4 py-3 text-sm font-black text-slate-950 transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {oauthLoading === "google" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24">
                      <path
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                        fill="#4285F4"
                      />
                      <path
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        fill="#34A853"
                      />
                      <path
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        fill="#FBBC05"
                      />
                      <path
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        fill="#EA4335"
                      />
                    </svg>
                  )}
                  Continue with Google
                </button>

                <button
                  type="button"
                  onClick={() => handleOAuth("github")}
                  disabled={!!oauthLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-full bg-slate-950 px-4 py-3 text-sm font-black text-white transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {oauthLoading === "github" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                  )}
                  Continue with GitHub
                </button>
              </div>
            )}

            <div className="my-6 flex items-center gap-4">
              <div className="h-px flex-1 bg-black/10" />
              <div className="text-[0.65rem] font-black uppercase tracking-[0.28em] text-slate-500">
                {oauthLoginEnabled ? "or use email" : "email login"}
              </div>
              <div className="h-px flex-1 bg-black/10" />
            </div>

            {bootstrapError && (
              <div
                role="status"
                data-testid="auth-bootstrap-warning"
                className="mb-4 rounded-[22px] border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-800"
              >
                {bootstrapError}
              </div>
            )}

            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[0.68rem] font-black uppercase tracking-[0.28em] text-slate-500">
                  Email address
                </span>
                <div className="relative">
                  <Mail
                    size={18}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"
                  />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    placeholder="you@company.com"
                    className="w-full rounded-[24px] border border-black/10 bg-white/70 px-12 py-4 text-sm font-semibold text-slate-950 outline-none transition-colors focus:border-slate-950"
                    required
                  />
                </div>
              </label>

              <label className="flex flex-col gap-2">
                <span className="text-[0.68rem] font-black uppercase tracking-[0.28em] text-slate-500">
                  Password
                </span>
                <div className="relative">
                  <Lock
                    size={18}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    className="w-full rounded-[24px] border border-black/10 bg-white/70 px-12 py-4 text-sm font-semibold text-slate-950 outline-none transition-colors focus:border-slate-950"
                    required
                  />
                </div>
              </label>

              {error && (
                <div className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-slate-950 px-5 py-4 text-sm font-black text-white transition-transform hover:-translate-y-0.5 disabled:opacity-60"
              >
                {loading ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} />}
                {loading ? "Logging in..." : "Log In"}
              </button>
            </form>

            <div className="mt-6 flex flex-col gap-3 text-sm text-slate-700">
              <SignupGate>
                <p>
                  Need an account?{" "}
                  <Link
                    href="/signup"
                    className="font-black text-slate-950 underline underline-offset-4"
                  >
                    Create one here.
                  </Link>
                </p>
              </SignupGate>
              <p>
                Prefer to self-host first?{" "}
                <a
                  href={QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-black text-slate-950 underline underline-offset-4"
                >
                  Open the quick start.
                </a>
              </p>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
