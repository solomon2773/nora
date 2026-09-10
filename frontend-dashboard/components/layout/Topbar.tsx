import { CheckCircle2, ChevronDown, LogOut, Menu } from "lucide-react";
import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { useRouter } from "next/router";
import { fetchWithAuth } from "../../lib/api";
import LanguageSwitcher from "../LanguageSwitcher";
import WorkspaceSwitcher from "../WorkspaceSwitcher";
import { useI18n } from "../../lib/i18n";

const PAGE_META = {
  "/dashboard": {
    title: "Dashboard",
    subtitle: "System status and first-run progress.",
  },
  "/agents": {
    title: "Agents",
    subtitle: "Inspect, filter, and operate your deployed agents.",
  },
  "/agents/[id]": {
    title: "Agent Details",
    subtitle: "Validate runtime health, logs, chat, and terminal access.",
  },
  "/cost": {
    title: "Cost",
    subtitle: "Workspace token spend, unique fleet totals, and per-agent usage.",
  },
  "/deploy": {
    title: "Deploy",
    subtitle: "Step 2 of 3 — deploy an agent, then validate it immediately.",
  },
  "/logs": {
    title: "Logs",
    subtitle: "Operator activity, per-agent runtime logs, and trace correlation in one place.",
  },
  "/workspaces": {
    title: "Workspaces",
    subtitle: "Group agents and share them with teammates.",
  },
  "/workspaces/[id]/agents": {
    title: "Workspace Agents",
    subtitle: "Assign owned agents and manage team access.",
  },
  "/workspaces/[id]/cost": {
    title: "Workspace Cost",
    subtitle: "Per-agent token spend for this workspace.",
  },
  "/workspaces/[id]/members": {
    title: "Workspace Members",
    subtitle: "Manage teammates, roles, and invitations.",
  },
  "/settings": {
    title: "Settings",
    subtitle: "Step 1 of 3 — connect one provider before the first deploy.",
  },
  "/getting-started": {
    title: "Getting Started",
    subtitle: "Follow the shortest path from setup to live operations.",
  },
};

export default function Topbar({ onMenuClick }) {
  const router = useRouter();
  const { loginPath, t } = useI18n();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    fetchWithAuth("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setUser(data);
      })
      .catch(() => {});
  }, []);

  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const initial = displayName.charAt(0).toUpperCase();
  const role = user?.role || "member";
  const pageMeta = PAGE_META[router.pathname] || {
    title: "Nora",
    subtitle: "Operate your agent fleet from one operator surface.",
  };

  return (
    <div className="sticky top-0 z-40 flex h-16 items-center justify-between gap-4 border-b border-brand-cyan/20 bg-white/82 px-4 backdrop-blur-md md:h-20 md:px-8">
      <div className="flex items-center gap-4 min-w-0">
        <button
          className="shrink-0 rounded-xl p-2 text-slate-500 transition-all hover:bg-brand-cyan/12 hover:text-brand-ink lg:hidden"
          onClick={onMenuClick}
        >
          <Menu size={24} />
        </button>

        <div className="min-w-0">
          <p className="text-sm md:text-base font-black text-slate-900 truncate">
            {t(pageMeta.title)}
          </p>
          <p className="hidden sm:block text-xs text-slate-500 truncate">{t(pageMeta.subtitle)}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 md:gap-6 shrink-0">
        <WorkspaceSwitcher className="hidden md:inline-flex" />
        <LanguageSwitcher className="hidden sm:inline-flex" />
        <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-100 bg-emerald-50 text-emerald-700">
          <CheckCircle2 size={14} />
          <span className="text-xs font-bold">{t("Operational")}</span>
        </div>

        <div className="relative">
          <button
            className="flex items-center gap-2 md:gap-3 p-1 rounded-xl hover:bg-slate-50 transition-all border border-transparent hover:border-slate-200"
            onClick={() => setUserMenuOpen(!userMenuOpen)}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-cyan text-sm font-bold text-brand-ink shadow-lg shadow-brand-cyan/25 md:h-10 md:w-10 md:text-base">
              {initial}
            </div>
            <div className="hidden sm:flex flex-col items-start mr-2">
              <span className="text-sm font-bold text-slate-900 leading-none">{displayName}</span>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 opacity-70 leading-none">
                {role}
              </span>
            </div>
            <ChevronDown
              size={14}
              className={clsx(
                "text-slate-400 transition-transform hidden sm:block",
                userMenuOpen ? "rotate-180" : "",
              )}
            />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-12 md:top-14 w-48 bg-white border border-slate-200 rounded-2xl shadow-xl p-2 z-[60] animate-in fade-in zoom-in-95 duration-200">
              <div
                className="flex items-center gap-3 p-3 text-red-600 hover:bg-red-50 rounded-xl transition-all text-sm font-medium cursor-pointer"
                onClick={() => {
                  localStorage.removeItem("token");
                  // Navigate only after the cookie clear round-trips, otherwise
                  // the user can race back into an authed page.
                  const clearAuth = fetch("/api/auth/logout", {
                    method: "POST",
                    credentials: "include",
                  }).catch(() => {});
                  clearAuth.finally(() => {
                    window.location.href = loginPath;
                  });
                }}
              >
                <LogOut size={16} />
                {t("Log Out")}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
