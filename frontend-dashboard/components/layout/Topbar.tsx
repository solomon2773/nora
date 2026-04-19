import { CheckCircle2, ChevronDown, LogOut, Menu } from "lucide-react";
import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { useRouter } from "next/router";
import { fetchWithAuth } from "../../lib/api";

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
  "/deploy": {
    title: "Deploy",
    subtitle: "Step 2 of 3 — deploy an agent, then validate it immediately.",
  },
  "/logs": {
    title: "Logs",
    subtitle: "Review account activity, request failures, and runtime events.",
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
    <div className="h-16 md:h-20 bg-white/80 backdrop-blur-md border-b border-slate-200 px-4 md:px-8 flex items-center justify-between gap-4 z-40 sticky top-0">
      <div className="flex items-center gap-4 min-w-0">
        <button className="lg:hidden p-2 text-slate-500 hover:bg-slate-50 rounded-xl transition-all shrink-0" onClick={onMenuClick}>
          <Menu size={24} />
        </button>

        <div className="min-w-0">
          <p className="text-sm md:text-base font-black text-slate-900 truncate">{pageMeta.title}</p>
          <p className="hidden sm:block text-xs text-slate-500 truncate">{pageMeta.subtitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 md:gap-6 shrink-0">
        <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-100 bg-emerald-50 text-emerald-700">
          <CheckCircle2 size={14} />
          <span className="text-xs font-bold">Operational</span>
        </div>

        <div className="relative">
          <button
            className="flex items-center gap-2 md:gap-3 p-1 rounded-xl hover:bg-slate-50 transition-all border border-transparent hover:border-slate-200"
            onClick={() => setUserMenuOpen(!userMenuOpen)}
          >
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20 text-sm md:text-base">
              {initial}
            </div>
            <div className="hidden sm:flex flex-col items-start mr-2">
              <span className="text-sm font-bold text-slate-900 leading-none">{displayName}</span>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 opacity-70 leading-none">{role}</span>
            </div>
            <ChevronDown size={14} className={clsx("text-slate-400 transition-transform hidden sm:block", userMenuOpen ? "rotate-180" : "")} />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-12 md:top-14 w-48 bg-white border border-slate-200 rounded-2xl shadow-xl p-2 z-[60] animate-in fade-in zoom-in-95 duration-200">
              <div
                className="flex items-center gap-3 p-3 text-red-600 hover:bg-red-50 rounded-xl transition-all text-sm font-medium cursor-pointer"
                onClick={() => {
                  localStorage.removeItem("token");
                  fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
                  window.location.href = "/login";
                }}
              >
                <LogOut size={16} />
                Log Out
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
