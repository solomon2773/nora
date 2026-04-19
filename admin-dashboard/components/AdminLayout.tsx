import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  LayoutDashboard,
  LogOut,
  SlidersHorizontal,
  Server,
  Shield,
  ShoppingBag,
  TriangleAlert,
  Users,
} from "lucide-react";
import { clsx } from "clsx";
import { formatDateTime } from "../lib/format";

const NAV_ITEMS = [
  { name: "Overview", icon: LayoutDashboard, href: "/" },
  { name: "Fleet", icon: Server, href: "/fleet" },
  { name: "Queue", icon: TriangleAlert, href: "/queue" },
  { name: "Users", icon: Users, href: "/users" },
  { name: "Marketplace", icon: ShoppingBag, href: "/marketplace" },
  { name: "Audit", icon: FileText, href: "/audit" },
  { name: "Settings", icon: SlidersHorizontal, href: "/settings" },
];

function isActivePath(pathname, href) {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function formatVersionLabel(version) {
  const normalized = String(version || "").trim();
  if (!normalized) return "Unversioned build";
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function formatShortCommit(commit) {
  const normalized = String(commit || "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 8);
}

export default function AdminLayout({ children }) {
  const router = useRouter();
  const [release, setRelease] = useState(null);
  const [systemBanner, setSystemBanner] = useState(null);

  useEffect(() => {
    let active = true;

    async function loadRelease() {
      try {
        const response = await fetch("/api/config/platform");
        if (!response.ok) return;

        const payload = await response.json().catch(() => ({}));
        if (active) {
          setRelease(payload?.release || null);
          setSystemBanner(payload?.systemBanner || null);
        }
      } catch {
        // Keep the admin shell usable if release metadata is unavailable.
      }
    }

    loadRelease();
    const intervalId = setInterval(loadRelease, 60000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  function handleLogout() {
    localStorage.removeItem("token");
    window.location.href = "/login";
  }

  const showReleaseBanner = Boolean(release?.updateAvailable);
  const bannerIsCritical =
    release?.severity === "critical" || release?.upgradeRequired;
  const showSystemBanner = Boolean(
    systemBanner?.active && systemBanner?.title && systemBanner?.message
  );
  const systemBannerCritical = systemBanner?.severity === "critical";

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="w-full bg-slate-950 text-white md:min-h-screen md:w-72">
          <div className="border-b border-white/10 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-600 shadow-lg shadow-red-500/20">
                <Shield size={22} />
              </div>
              <div>
                <p className="text-lg font-black tracking-tight">Nora Admin</p>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
                  Full platform control
                </p>
              </div>
            </div>
          </div>

          <nav className="flex gap-2 overflow-x-auto px-3 py-3 md:flex-col md:px-4 md:py-5">
            {NAV_ITEMS.map((item) => {
              const active = isActivePath(router.pathname, item.href);
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={clsx(
                    "inline-flex items-center gap-3 whitespace-nowrap rounded-2xl px-4 py-3 text-sm font-semibold transition-all",
                    active
                      ? "bg-red-600 text-white shadow-lg shadow-red-600/20"
                      : "text-slate-400 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <item.icon size={18} />
                  {item.name}
                </Link>
              );
            })}
          </nav>

          <div className="hidden px-4 pb-4 md:block">
            <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">
                Guardrail
              </p>
              <p className="mt-2 text-sm font-medium leading-relaxed text-slate-300">
                This surface is for admins only. Prefer inspect-first workflows,
                then use lifecycle and delete actions deliberately.
              </p>
            </div>
          </div>

          <div className="border-t border-white/10 p-3 md:mt-auto md:p-4">
            <button
              onClick={handleLogout}
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
            >
              <LogOut size={18} />
              Log Out
            </button>
          </div>
        </aside>

        <main className="flex-1">
          <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            {showSystemBanner ? (
              <section
                className={clsx(
                  "mb-6 overflow-hidden rounded-[2rem] border px-5 py-5 shadow-sm sm:px-6",
                  systemBannerCritical
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50"
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={clsx(
                      "mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
                      systemBannerCritical
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700"
                    )}
                  >
                    <TriangleAlert size={20} />
                  </span>
                  <div className="min-w-0">
                    <p
                      className={clsx(
                        "text-[11px] font-black uppercase tracking-[0.18em]",
                        systemBannerCritical ? "text-red-600" : "text-amber-700"
                      )}
                    >
                      {systemBannerCritical ? "System Critical" : "System Warning"}
                    </p>
                    <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                      {systemBanner.title}
                    </h2>
                    <p
                      className={clsx(
                        "mt-2 max-w-4xl text-sm font-medium leading-relaxed",
                        systemBannerCritical
                          ? "text-red-700/80"
                          : "text-amber-800/90"
                      )}
                    >
                      {systemBanner.message}
                    </p>
                  </div>
                </div>
              </section>
            ) : null}
            {showReleaseBanner ? (
              <section
                className={clsx(
                  "mb-6 overflow-hidden rounded-[2rem] border px-5 py-5 shadow-sm sm:px-6",
                  bannerIsCritical
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50"
                )}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p
                      className={clsx(
                        "text-[11px] font-black uppercase tracking-[0.18em]",
                        bannerIsCritical ? "text-red-600" : "text-amber-700"
                      )}
                    >
                      {bannerIsCritical
                        ? "Upgrade Required"
                        : "New Nora Version Available"}
                    </p>
                    <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                      {release?.latestVersion
                        ? `${formatVersionLabel(release.latestVersion)} is ready`
                        : "A newer Nora release is available"}
                    </h2>
                    <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-700">
                      {release?.currentVersion
                        ? `This control plane is running ${formatVersionLabel(release.currentVersion)}${
                            formatShortCommit(release.currentCommit)
                              ? ` (${formatShortCommit(release.currentCommit)})`
                              : ""
                          }. Review the upgrade guidance and use the host-side command to move to the latest release.`
                        : "This instance is not reporting its current version yet. Review the upgrade guidance and verify the host-side build before you upgrade."}
                      {release?.publishedAt
                        ? ` Latest release announced ${formatDateTime(
                            release.publishedAt
                          )}.`
                        : ""}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Link
                      href="/settings#platform-upgrades"
                      className={clsx(
                        "inline-flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold shadow-sm transition-all hover:-translate-y-0.5",
                        bannerIsCritical
                          ? "bg-red-600 text-white hover:bg-red-700"
                          : "bg-amber-500 text-slate-950 hover:bg-amber-400"
                      )}
                    >
                      Review upgrade
                    </Link>
                    {release?.releaseNotesUrl ? (
                      <a
                        href={release.releaseNotesUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50"
                      >
                        Release notes
                        <ArrowUpRight size={15} />
                      </a>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
