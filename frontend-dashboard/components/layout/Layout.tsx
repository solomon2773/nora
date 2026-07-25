import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { TriangleAlert } from "lucide-react";
import { useState, useEffect } from "react";
import { useI18n } from "../../lib/i18n";

function readLocalStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The authenticated cookie flow and shell state remain usable when
    // storage is disabled or quota-limited.
  }
}

function removeLocalStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A blocked legacy-token store is equivalent to having no fallback token.
  }
}

export default function Layout({ children }) {
  const { loginPath, t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [systemBanner, setSystemBanner] = useState(null);
  const [platformMode, setPlatformMode] = useState<string | null>(null);

  useEffect(() => {
    // Ask the server whether we're authenticated. The HttpOnly nora_auth
    // cookie (if present) rides along automatically; any legacy localStorage
    // token is sent as a Bearer fallback for sessions predating the cookie
    // migration. If neither works we bounce to login.
    const legacy = readLocalStorage("token");
    const headers: Record<string, string> = {};
    if (legacy) headers["Authorization"] = `Bearer ${legacy}`;
    fetch("/api/auth/me", { credentials: "include", headers })
      .then((res) => {
        if (res.ok) {
          setAuthChecked(true);
        } else {
          removeLocalStorage("token");
          window.location.href = loginPath;
        }
      })
      .catch(() => {
        window.location.href = loginPath;
      });
    // Restore collapsed state
    const saved = readLocalStorage("sidebar-collapsed");
    if (saved === "true") setSidebarCollapsed(true);
  }, [loginPath]);

  useEffect(() => {
    if (!authChecked) return undefined;

    let active = true;

    async function loadSystemBanner() {
      try {
        const response = await fetch("/api/config/platform");
        if (!response.ok) {
          if (active) setPlatformMode(null);
          return;
        }

        const payload = await response.json().catch(() => ({}));
        if (active) {
          setSystemBanner(payload?.systemBanner || null);
          setPlatformMode(
            typeof payload?.mode === "string" ? payload.mode.trim().toLowerCase() : null,
          );
        }
      } catch {
        // Leave the shell usable while self-hosted-only navigation fails closed.
        if (active) setPlatformMode(null);
      }
    }

    void loadSystemBanner();
    const intervalId = setInterval(loadSystemBanner, 60000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [authChecked]);

  const toggleCollapsed = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    writeLocalStorage("sidebar-collapsed", String(next));
  };
  const showSystemBanner = Boolean(
    systemBanner?.active && systemBanner?.title && systemBanner?.message,
  );
  const systemBannerCritical = systemBanner?.severity === "critical";

  if (!authChecked) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-[#eef4fb] selection:bg-brand-cyan/25">
      {/* Sidebar - Desktop (collapsible) */}
      <div className="hidden lg:flex lg:flex-shrink-0 transition-all duration-300">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleCollapsed}
          platformMode={platformMode}
        />
      </div>

      {/* Sidebar - Mobile/Tablet Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <button
            type="button"
            aria-label={t("Close navigation menu")}
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative flex w-64 flex-col bg-brand-ink animate-in slide-in-from-left duration-300">
            <Sidebar
              collapsed={false}
              onClose={() => setSidebarOpen(false)}
              platformMode={platformMode}
            />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />

        {/* Page Content */}
        <main className="flex-1 flex flex-col overflow-hidden bg-[#eef4fb]">
          {showSystemBanner ? (
            <section
              className={`shrink-0 border-b px-3 py-3 sm:px-4 md:px-6 lg:px-8 ${
                systemBannerCritical ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
              }`}
            >
              <div className="mx-auto flex w-full max-w-7xl items-start gap-3">
                <span
                  className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                    systemBannerCritical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
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
                    {systemBannerCritical ? t("System Critical") : t("System Warning")}
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
