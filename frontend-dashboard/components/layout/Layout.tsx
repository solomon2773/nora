import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { TriangleAlert } from "lucide-react";
import { useState, useEffect } from "react";

export default function Layout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [systemBanner, setSystemBanner] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      window.location.href = "/login";
    } else {
      setAuthChecked(true);
    }
    // Restore collapsed state
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true") setSidebarCollapsed(true);
  }, []);

  useEffect(() => {
    if (!authChecked) return undefined;

    let active = true;

    async function loadSystemBanner() {
      try {
        const response = await fetch("/api/config/platform");
        if (!response.ok) return;

        const payload = await response.json().catch(() => ({}));
        if (active) {
          setSystemBanner(payload?.systemBanner || null);
        }
      } catch {
        // Leave the operator shell usable if platform chrome metadata is unavailable.
      }
    }

    loadSystemBanner();
    const intervalId = setInterval(loadSystemBanner, 60000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [authChecked]);

  const toggleCollapsed = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };
  const showSystemBanner = Boolean(
    systemBanner?.active && systemBanner?.title && systemBanner?.message
  );
  const systemBannerCritical = systemBanner?.severity === "critical";

  if (!authChecked) return null;

  return (
    <div className="flex h-screen bg-[#f8fafc] overflow-hidden selection:bg-blue-500/20">
      {/* Sidebar - Desktop (collapsible) */}
      <div className="hidden lg:flex lg:flex-shrink-0 transition-all duration-300">
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleCollapsed} />
      </div>

      {/* Sidebar - Mobile/Tablet Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)}></div>
          <div className="relative flex flex-col w-64 bg-slate-950 animate-in slide-in-from-left duration-300">
            <Sidebar collapsed={false} onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />

        {/* Page Content */}
        <main className="flex-1 flex flex-col overflow-hidden bg-[#f8fafc]">
          {showSystemBanner ? (
            <section
              className={`shrink-0 border-b px-3 py-3 sm:px-4 md:px-6 lg:px-8 ${
                systemBannerCritical
                  ? "border-red-200 bg-red-50"
                  : "border-amber-200 bg-amber-50"
              }`}
            >
              <div className="mx-auto flex w-full max-w-7xl items-start gap-3">
                <span
                  className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                    systemBannerCritical
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  <TriangleAlert size={18} />
                </span>
                <div className="min-w-0">
                  <p
                    className={`text-[11px] font-black uppercase tracking-[0.18em] ${
                      systemBannerCritical ? "text-red-700" : "text-amber-800"
                    }`}
                  >
                    {systemBannerCritical ? "System Critical" : "System Warning"}
                  </p>
                  <p className="mt-1 text-sm font-black text-slate-950 sm:text-base">
                    {systemBanner.title}
                  </p>
                  <p
                    className={`mt-1 text-sm font-medium leading-relaxed ${
                      systemBannerCritical ? "text-red-700/80" : "text-amber-800/90"
                    }`}
                  >
                    {systemBanner.message}
                  </p>
                </div>
              </div>
            </section>
          ) : null}
          <div className="w-full flex-1 flex flex-col overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 md:px-6 lg:px-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
