import { useState, useEffect } from "react";
import Link from "next/link";
import { Lock, Mail, Zap, Loader2, CheckCircle2, Shield, TerminalSquare } from "lucide-react";
import { signIn } from "next-auth/react";

const OAUTH_LOGIN_ENABLED = process.env.NEXT_PUBLIC_OAUTH_LOGIN_ENABLED === "true";
const IS_SELF_HOSTED = process.env.NEXT_PUBLIC_PLATFORM_MODE === "selfhosted";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => {
          if (res.ok) {
            window.location.href = "/app/dashboard";
          } else {
            localStorage.removeItem("token");
          }
        })
        .catch(() => {
          localStorage.removeItem("token");
        });
    }
  }, []);

  async function routeAfterLogin(token) {
    try {
      const [providersRes, agentsRes] = await Promise.all([
        fetch("/api/llm-providers", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/agents", { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const [providers, agents] = await Promise.all([
        providersRes.ok ? providersRes.json() : [],
        agentsRes.ok ? agentsRes.json() : [],
      ]);

      const hasProviders = Array.isArray(providers) && providers.length > 0;
      const hasAgents = Array.isArray(agents) && agents.length > 0;

      window.location.href = hasProviders || hasAgents ? "/app/dashboard" : "/app/getting-started";
    } catch (err) {
      console.error(err);
      window.location.href = "/app/dashboard";
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        localStorage.setItem("token", data.token);
        await routeAfterLogin(data.token);
      } else {
        setError(data.error || "Login failed");
      }
    } catch (err) {
      console.error(err);
      setError("An error occurred. Please try again.");
    }
    setLoading(false);
  }

  function handleOAuth(provider) {
    setOauthLoading(provider);
    signIn(provider, { callbackUrl: "/auth/callback" });
  }

  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans flex flex-col lg:flex-row overflow-x-hidden">
      <div className="hidden lg:flex lg:w-[44%] border-r border-white/5 bg-[#0b1120] p-10 xl:p-14">
        <div className="max-w-lg mx-auto flex flex-col justify-between gap-10">
          <div>
            <Link href="/" className="inline-flex items-center gap-2 mb-10">
              <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center font-bold text-white">N</div>
              <span className="text-xl font-black tracking-tight">Nora</span>
            </Link>

            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs font-semibold mb-6">
              <Shield size={14} />
              OpenClaw operator console
            </div>

            <h1 className="text-4xl font-black tracking-tight leading-tight mb-4">
              Welcome back to your Nora control plane
            </h1>
            <p className="text-slate-400 leading-relaxed text-base">
              Sign in to deploy agents, sync provider keys, inspect logs, open terminals, and manage OpenClaw operations from one place.
            </p>
          </div>

          <div className="space-y-4">
            <div className="bg-white/[0.03] border border-white/5 rounded-3xl p-5">
              <div className="flex items-center gap-2 mb-3 text-blue-300">
                <CheckCircle2 size={16} />
                <span className="text-sm font-bold">Fast path after login</span>
              </div>
              <div className="space-y-3 text-sm text-slate-300">
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                  <span>Add or verify your LLM provider in Settings.</span>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                  <span>Deploy your first OpenClaw agent from the Deploy screen.</span>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
                  <span>Use chat, logs, and terminal to validate the runtime immediately.</span>
                </div>
              </div>
            </div>

            <div className="bg-white/[0.03] border border-white/5 rounded-3xl p-5">
              <div className="flex items-center gap-2 mb-2 text-amber-300">
                <TerminalSquare size={16} />
                <span className="text-sm font-bold">First-time self-hosted install?</span>
              </div>
              <p className="text-sm text-slate-400 leading-relaxed">
                {IS_SELF_HOSTED
                  ? "Use the operator account you created during setup. If this instance is brand new, create an account first and then continue into Settings and Deploy."
                  : "If you just created an account, you can sign in and head straight to the dashboard."}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full flex flex-col gap-8">
          <div className="text-center">
            <h1 className="text-3xl font-black tracking-tight mb-2">Welcome Back</h1>
            <p className="text-sm text-slate-400 font-medium">Sign in to the Nora Console</p>
          </div>

          {OAUTH_LOGIN_ENABLED && (
            <div className="flex flex-col gap-3">
              <button
                onClick={() => handleOAuth("google")}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 py-4 rounded-2xl font-bold text-sm transition-all hover:bg-slate-100 active:scale-95 disabled:opacity-50 shadow-lg"
              >
                {oauthLoading === "google" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                )}
                Continue with Google
              </button>
              <button
                onClick={() => handleOAuth("github")}
                disabled={!!oauthLoading}
                className="w-full flex items-center justify-center gap-3 bg-slate-800 border border-slate-700 text-white py-4 rounded-2xl font-bold text-sm transition-all hover:bg-slate-700 active:scale-95 disabled:opacity-50 shadow-lg"
              >
                {oauthLoading === "github" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                )}
                Continue with GitHub
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-white/10"></div>
            <span className="text-xs text-slate-500 font-bold uppercase tracking-widest">{OAUTH_LOGIN_ENABLED ? "or" : "email"}</span>
            <div className="flex-1 h-px bg-white/10"></div>
          </div>

          <form onSubmit={handleLogin} className="bg-white/5 border border-white/10 p-8 rounded-[2.5rem] flex flex-col gap-6 shadow-2xl">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] text-slate-500 font-black uppercase tracking-widest ml-2">Email Address</label>
                <div className="relative">
                  <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="email"
                    className="w-full pl-12 pr-6 py-4 bg-white/5 border border-white/10 rounded-2xl text-sm font-bold outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] text-slate-500 font-black uppercase tracking-widest ml-2">Password</label>
                <div className="relative">
                  <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="password"
                    className="w-full pl-12 pr-6 py-4 bg-white/5 border border-white/10 rounded-2xl text-sm font-bold outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400 font-medium">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 py-4 rounded-2xl font-black text-sm transition-all shadow-xl shadow-blue-500/20 active:scale-95 disabled:opacity-50"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} className="fill-current" />}
              Sign In with Email
            </button>
          </form>

          <p className="text-center text-sm text-slate-500">
            Don&apos;t have an account? <a href="/signup" className="text-blue-400 font-bold hover:underline">Sign Up</a>
          </p>
        </div>
      </div>
    </div>
  );
}
