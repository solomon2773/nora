import Link from "next/link";
import { useRouter } from "next/router";
import Script from "next/script";
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, CheckCircle2, Loader2, Lock, Mail, Server, Shield, Zap } from "lucide-react";
import { useAuthBootstrap } from "../components/AuthBootstrapProvider";
import LanguageSwitcher from "../components/LanguageSwitcher";
import SeoHead from "../components/SeoHead";
import { normalizeLocale, useI18n } from "../lib/i18n";
import { trackEvent } from "../lib/analytics";

const OSS_REPO_URL = "https://github.com/solomon2773/nora";
const QUICKSTART_URL = `${OSS_REPO_URL}#quick-start`;

const SIGNUP_CONFIG_LOAD_ERROR =
  "Could not load signup verification configuration. Refresh the page or contact the administrator.";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId?: string) => void;
    };
    grecaptcha?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => number;
      reset: (widgetId?: number) => void;
    };
  }
}

const NEXT_STEPS = [
  "Create the first operator account for this Nora instance.",
  "Add an LLM provider key and confirm workspace access.",
  "Deploy OpenClaw or Hermes to the runtime target that fits your environment.",
  "Validate readiness with chat, logs, metrics, terminal access, and alerts.",
];

const DEMO_NEXT_STEPS = [
  "Create an operator account for this Nora instance.",
  "Enable the built-in deterministic demo provider — no API key or usage cost.",
  "Deploy the demo agent from Getting Started with one click.",
  "Validate chat, logs, metrics, and terminal access from the operator dashboard.",
];

export function SignupAccessState({
  loading,
  error,
  disabled,
  children,
}: {
  loading: boolean;
  error: string;
  disabled: boolean;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div
        aria-live="polite"
        className="flex min-h-[240px] items-center justify-center gap-2 text-sm font-semibold text-slate-600"
      >
        <Loader2 size={17} className="animate-spin" />
        Loading signup verification configuration...
      </div>
    );
  }

  if (disabled) {
    return (
      <>
        <div className="eyebrow eyebrow-warm mb-5">
          <Shield size={14} />
          Account access
        </div>
        <h2 className="text-3xl font-black leading-tight text-slate-950">
          Registration is disabled
        </h2>
        <p className="mt-3 text-sm leading-7 text-slate-700">
          This Nora operator is not accepting new accounts. Contact the administrator for access.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex items-center justify-center rounded-full bg-slate-950 px-5 py-4 text-sm font-black text-white transition-transform hover:-translate-y-0.5"
        >
          Return to login
        </Link>
      </>
    );
  }

  if (error) {
    return (
      <>
        <div className="eyebrow eyebrow-warm mb-5">
          <Shield size={14} />
          Account access
        </div>
        <h2 className="text-3xl font-black leading-tight text-slate-950">
          Registration is unavailable
        </h2>
        <div
          role="alert"
          data-testid="signup-protection-configuration-error"
          className="mt-4 rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-700"
        >
          {error}
        </div>
        <Link
          href="/login"
          className="mt-6 inline-flex items-center justify-center rounded-full bg-slate-950 px-5 py-4 text-sm font-black text-white transition-transform hover:-translate-y-0.5"
        >
          Return to login
        </Link>
      </>
    );
  }

  return children;
}

export function SignupSupportingPanel({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  if (!disabled) return children;

  return (
    <>
      <div className="eyebrow mb-5">
        <Shield size={14} />
        Account access
      </div>
      <h1 className="max-w-xl text-4xl font-black leading-tight text-white sm:text-5xl">
        Registration is disabled on this Nora instance.
      </h1>
      <p className="mt-5 max-w-xl text-base leading-8 text-slate-300">
        Existing operators can return to login. Contact the administrator for access.
      </p>
      <Link
        href="/login"
        className="mt-8 inline-flex items-center justify-center rounded-full border border-[#8ae6ff]/25 bg-[#8ae6ff]/10 px-5 py-3 text-sm font-black text-white transition-colors hover:bg-[#8ae6ff]/20"
      >
        Return to login
      </Link>
    </>
  );
}

export default function Signup() {
  const router = useRouter();
  const { localizePath, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState("");
  const [error, setError] = useState("");
  const [botProtectionToken, setBotProtectionToken] = useState("");
  const {
    status: bootstrapStatus,
    error: bootstrapLoadError,
    loading: bootstrapLoading,
  } = useAuthBootstrap();
  const bootstrapError = bootstrapLoadError ? SIGNUP_CONFIG_LOAD_ERROR : "";
  const [challengeLoadError, setChallengeLoadError] = useState("");
  const botProtectionRef = useRef<HTMLDivElement | null>(null);
  const botProtectionWidgetId = useRef<string | number | null>(null);
  const needsFirstAdmin = bootstrapStatus?.needsFirstAdmin === true;
  const signupDisabled = bootstrapStatus?.signupEnabled === false;
  const oauthLoginEnabled = bootstrapStatus?.oauthLoginEnabled === true;
  const platformMode = bootstrapStatus?.platformMode || null;
  const botProtection = bootstrapStatus?.signupBotProtection || null;
  const botProtectionProvider = botProtection?.provider || null;
  const botProtectionSiteKey = botProtection?.siteKey || "";
  const botProtectionEnabled = botProtection?.enabled === true;
  const botProtectionReady =
    botProtectionEnabled &&
    botProtection?.configured === true &&
    (botProtectionProvider === "turnstile" || botProtectionProvider === "recaptcha") &&
    Boolean(botProtectionSiteKey);
  const botProtectionConfigurationError =
    bootstrapError ||
    (botProtectionEnabled && !botProtectionReady
      ? botProtection?.configurationError ||
        "Signup verification is enabled, but its runtime configuration is incomplete. Contact the administrator."
      : "") ||
    challengeLoadError;
  const signupBlocked =
    bootstrapLoading ||
    signupDisabled ||
    Boolean(botProtectionConfigurationError) ||
    (botProtectionEnabled && !botProtectionToken);
  const isDemoIntent = router.query.intent === "demo";
  const nextSteps = isDemoIntent ? DEMO_NEXT_STEPS : NEXT_STEPS;

  const resetBotProtection = useCallback(() => {
    setBotProtectionToken("");
    const widgetId = botProtectionWidgetId.current;
    try {
      if (botProtectionProvider === "turnstile" && typeof widgetId === "string") {
        window.turnstile?.reset(widgetId);
      }
      if (botProtectionProvider === "recaptcha" && typeof widgetId === "number") {
        window.grecaptcha?.reset(widgetId);
      }
    } catch {
      // Challenge reset is best-effort; a fresh page load will render a new token.
    }
  }, [botProtectionProvider]);

  const renderBotProtectionWidget = useCallback(() => {
    if (!botProtectionReady || !botProtectionRef.current || botProtectionWidgetId.current != null) {
      return;
    }

    if (botProtectionProvider === "turnstile" && window.turnstile) {
      botProtectionWidgetId.current = window.turnstile.render(botProtectionRef.current, {
        sitekey: botProtectionSiteKey,
        theme: "light",
        callback: (token: string) => {
          setChallengeLoadError("");
          setBotProtectionToken(token);
        },
        "expired-callback": () => setBotProtectionToken(""),
        "error-callback": () => setBotProtectionToken(""),
      });
    }

    if (botProtectionProvider === "recaptcha" && window.grecaptcha) {
      botProtectionWidgetId.current = window.grecaptcha.render(botProtectionRef.current, {
        sitekey: botProtectionSiteKey,
        callback: (token: string) => {
          setChallengeLoadError("");
          setBotProtectionToken(token);
        },
        "expired-callback": () => setBotProtectionToken(""),
        "error-callback": () => setBotProtectionToken(""),
      });
    }
  }, [botProtectionProvider, botProtectionReady, botProtectionSiteKey]);

  useEffect(() => {
    renderBotProtectionWidget();
  }, [renderBotProtectionWidget]);

  async function handleSignup(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    if (bootstrapLoading || botProtectionConfigurationError) {
      setError(botProtectionConfigurationError || SIGNUP_CONFIG_LOAD_ERROR);
      setLoading(false);
      return;
    }

    if (botProtectionEnabled && !botProtectionToken) {
      setError(t("Complete the verification challenge and try again."));
      setLoading(false);
      return;
    }

    try {
      const signupPayload = botProtectionEnabled
        ? { email, password, botProtectionToken }
        : { email, password };
      const signupRes = await fetch("/api/auth/signup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signupPayload),
      });

      const signupData = await signupRes.json().catch(() => ({}));

      if (!signupRes.ok) {
        setError(signupData.error || t("Could not create the account. Please try again."));
        resetBotProtection();
        return;
      }

      trackEvent("Signup");

      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const loginData = await loginRes.json().catch(() => ({}));

      if (loginRes.ok && loginData.token) {
        // Backend set an HttpOnly nora_auth cookie; we don't mirror the token
        // into localStorage anymore. Any stale legacy token gets dropped here.
        localStorage.removeItem("token");
        const profileRes = await fetch("/api/auth/me", { credentials: "include" });
        const profile = profileRes.ok ? await profileRes.json().catch(() => ({})) : {};
        window.location.assign(
          localizePath(
            "/app/getting-started",
            normalizeLocale(profile.effectiveLocale || profile.defaultLocale),
          ),
        );
        return;
      }

      window.location.assign(localizePath("/login"));
    } catch (signupErr) {
      console.error(signupErr);
      setError(t("Could not create the account. Please try again."));
      resetBotProtection();
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
        title={isDemoIntent ? "Try Nora Without an API Key | Nora" : "Create Account | Nora"}
        description={
          isDemoIntent
            ? "Create a Nora operator account, then deploy the built-in zero-key demo agent and validate the control plane without API usage costs."
            : "Create a Nora operator account for deploying OpenClaw and Hermes runtimes on a self-hosted, Apache-2.0 control plane."
        }
        path="/signup"
      />
      {!signupDisabled && botProtectionReady && botProtectionProvider === "turnstile" && (
        <Script
          id="signup-turnstile-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onReady={renderBotProtectionWidget}
          onError={() =>
            setChallengeLoadError(
              "Could not load the signup verification challenge. Refresh the page or contact the administrator.",
            )
          }
        />
      )}
      {!signupDisabled && botProtectionReady && botProtectionProvider === "recaptcha" && (
        <Script
          id="signup-recaptcha-script"
          src="https://www.google.com/recaptcha/api.js?render=explicit"
          strategy="afterInteractive"
          onReady={renderBotProtectionWidget}
          onError={() =>
            setChallengeLoadError(
              "Could not load the signup verification challenge. Refresh the page or contact the administrator.",
            )
          }
        />
      )}

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
            <Link
              href="/login"
              className="rounded-full bg-brand-cyan px-4 py-2 text-sm font-black text-brand-ink shadow-lg shadow-brand-cyan/25 transition-transform hover:-translate-y-0.5"
            >
              Log In
            </Link>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-6 pt-10 lg:grid-cols-[minmax(0,1.02fr)_420px] lg:pt-12">
          <section className="order-2 rounded-[36px] panel-shell px-6 py-8 sm:px-8 lg:order-1 lg:px-10">
            <SignupSupportingPanel disabled={signupDisabled}>
              <>
                <div className="eyebrow mb-5">
                  <Server size={14} />
                  Open-source operator signup
                </div>
                <h1 className="max-w-xl text-4xl font-black leading-tight text-white sm:text-5xl">
                  {isDemoIntent
                    ? "Try Nora without an API key."
                    : needsFirstAdmin
                      ? "Claim this Nora server."
                      : "Create the operator account for this Nora instance."}
                </h1>
                {needsFirstAdmin && (
                  <p className="mt-3 max-w-xl text-sm font-bold uppercase tracking-[0.2em] text-[#f2d7a1]">
                    First-run setup — the account you create here becomes the platform admin.
                  </p>
                )}
                <p className="mt-5 max-w-xl text-base leading-8 text-slate-300">
                  {isDemoIntent
                    ? "Create an account, then use Getting Started to enable Nora's built-in deterministic demo provider and deploy a working agent with zero external keys and zero model cost."
                    : "Use this account to enter the Nora dashboard, add provider keys, create workspaces, and deploy OpenClaw or Hermes runtimes on infrastructure you control. The source stays public, and the deployment path stays self-hostable."}
                </p>

                <div className="mt-8 rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
                  <div className="text-xs font-black uppercase tracking-[0.28em] text-[#f2d7a1]">
                    After account creation
                  </div>
                  <div className="mt-4 space-y-4">
                    {nextSteps.map((item, index) => (
                      <div
                        key={item}
                        className="flex items-start gap-3 text-sm leading-7 text-slate-300"
                      >
                        <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#8ae6ff]/20 bg-[#8ae6ff]/10 text-[0.68rem] font-black text-[#eef4fb]">
                          {index + 1}
                        </div>
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
                      Public repo
                    </div>
                    <div className="mt-2 text-lg font-black text-white">Inspect Nora on GitHub</div>
                    <div className="mt-2 text-sm leading-7 text-slate-400">
                      Review the source before or after creating the account.
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
                      Clone the repo, run the installer, and create the first account on your own
                      deployment.
                    </div>
                  </a>
                </div>

                <div className="mt-6 rounded-[28px] border border-[#8ae6ff]/18 bg-[#8ae6ff]/7 px-5 py-5">
                  <div className="text-xs font-black uppercase tracking-[0.28em] text-[#eef4fb]">
                    Instance note
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-300">
                    {platformMode === "selfhosted"
                      ? "This account belongs to this self-hosted Nora instance. On a brand-new Nora instance, the first created account becomes the admin account. If a bootstrap operator was already created during setup, use that instead of creating a duplicate."
                      : platformMode === "paas"
                        ? "This account belongs to this hosted Nora instance. If you already created one earlier, use the login page instead."
                        : "Account registration is configured by the operator of this Nora instance."}
                  </p>
                </div>
              </>
            </SignupSupportingPanel>
          </section>

          <section className="order-1 rounded-[36px] panel-warm px-6 py-8 sm:px-8 lg:order-2">
            <SignupAccessState
              loading={bootstrapLoading}
              error={bootstrapError}
              disabled={signupDisabled}
            >
              <>
                <div className="eyebrow eyebrow-warm mb-5">
                  <Shield size={14} />
                  Easy account creation
                </div>
                <h2 className="text-3xl font-black leading-tight text-slate-950">
                  {isDemoIntent
                    ? "Start the zero-key demo"
                    : needsFirstAdmin
                      ? "Claim this server"
                      : "Create operator account"}
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-700">
                  {isDemoIntent
                    ? "After signup, Nora sends you directly to Getting Started, where the demo provider and demo agent are one click away."
                    : "Use this account to enter the Nora operator surface for OpenClaw and Hermes deployments on this instance. OAuth appears here only when it is enabled."}
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
                    {oauthLoginEnabled ? "or use email" : "email signup"}
                  </div>
                  <div className="h-px flex-1 bg-black/10" />
                </div>

                <form onSubmit={handleSignup} className="flex flex-col gap-4">
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
                        autoComplete="new-password"
                        placeholder="Create a secure password"
                        className="w-full rounded-[24px] border border-black/10 bg-white/70 px-12 py-4 text-sm font-semibold text-slate-950 outline-none transition-colors focus:border-slate-950"
                        required
                      />
                    </div>
                  </label>

                  {botProtectionReady && (
                    <div className="rounded-[24px] border border-black/10 bg-white/60 px-4 py-4">
                      <div
                        data-testid="signup-bot-protection"
                        className="flex min-h-[64px] items-center justify-center"
                      >
                        <div ref={botProtectionRef} />
                      </div>
                      {!botProtectionToken && (
                        <p className="mt-2 text-center text-xs font-semibold text-slate-600">
                          Complete the verification challenge to enable account creation.
                        </p>
                      )}
                    </div>
                  )}

                  {botProtectionConfigurationError && (
                    <div
                      role="alert"
                      data-testid="signup-protection-configuration-error"
                      className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-700"
                    >
                      {botProtectionConfigurationError}
                    </div>
                  )}

                  {error && (
                    <div
                      role="alert"
                      className="rounded-[22px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-700"
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading || signupBlocked}
                    className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-slate-950 px-5 py-4 text-sm font-black text-white transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                  >
                    {loading ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <CheckCircle2 size={18} />
                    )}
                    {loading ? "Creating account..." : "Create Account"}
                  </button>
                  <p className="mt-3 text-xs leading-5 text-slate-500">
                    By creating an account you agree to our{" "}
                    <Link
                      href="/terms"
                      className="font-bold text-slate-700 underline underline-offset-2"
                    >
                      Terms
                    </Link>{" "}
                    and{" "}
                    <Link
                      href="/privacy"
                      className="font-bold text-slate-700 underline underline-offset-2"
                    >
                      Privacy Policy
                    </Link>
                    .
                  </p>
                </form>

                <div className="mt-6 flex flex-col gap-3 text-sm text-slate-700">
                  <p>
                    Already have an account?{" "}
                    <Link
                      href="/login"
                      className="font-black text-slate-950 underline underline-offset-4"
                    >
                      Log in here.
                    </Link>
                  </p>
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
              </>
            </SignupAccessState>
          </section>
        </main>
      </div>
    </>
  );
}
