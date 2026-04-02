import { useEffect } from "react";
import { useSession } from "next-auth/react";

// Bridge page: extracts the platform JWT from NextAuth session,
// stores it in localStorage so the dashboard's fetchWithAuth() works,
// then redirects new users into the first-run activation flow.
export default function AuthCallback() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "loading") return;

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
      } catch {
        window.location.href = "/app/dashboard";
      }
    }

    if (session?.accessToken) {
      localStorage.setItem("token", session.accessToken);
      routeAfterLogin(session.accessToken);
    } else {
      // No session — redirect to login
      window.location.href = "/login";
    }
  }, [session, status]);

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm text-slate-400 font-medium">Signing you in...</p>
      </div>
    </div>
  );
}
