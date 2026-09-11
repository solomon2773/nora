import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Activity,
  Database,
  FileText,
  Archive,
  Boxes,
  History,
  LayoutDashboard,
  LogOut,
  SlidersHorizontal,
  Server,
  ShieldCheck,
  ShoppingBag,
  TriangleAlert,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { formatBytes, formatDateTime } from "../lib/format";
import LanguageSwitcher from "./LanguageSwitcher";
import { useI18n } from "../lib/i18n";

const NAV_ITEMS = [
  { name: "Overview", icon: LayoutDashboard, href: "/" },
  { name: "Health", icon: Activity, href: "/health" },
  { name: "Fleet", icon: Server, href: "/fleet" },
  { name: "Queue", icon: TriangleAlert, href: "/queue" },
  { name: "Users", icon: Users, href: "/users" },
  { name: "Members", icon: ShieldCheck, href: "/members" },
  { name: "User Groups", icon: UsersRound, href: "/user-groups" },
  { name: "Kubernetes", icon: Boxes, href: "/kubernetes" },
  { name: "Remote Hosts", icon: Server, href: "/remote-hosts" },
  { name: "Agent Hub", icon: ShoppingBag, href: "/agent-hub" },
  { name: "Backups", icon: Archive, href: "/backups" },
  { name: "Audit", icon: FileText, href: "/audit" },
  { name: "Log Recovery", icon: History, href: "/log-recovery" },
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
  const { loginPath, t } = useI18n();
  const [release, setRelease] = useState(null);
  const [systemBanner, setSystemBanner] = useState(null);
  const [logStorageCapacity, setLogStorageCapacity] = useState(null);
  const [capacityBannerDismissed, setCapacityBannerDismissed] = useState(false);

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

    // Log storage capacity, same polling cadence as the release/system
    // banners above — this is what drives the Drive-style "N% of storage
    // used" banner below. `GET /admin/log-storage` is admin-only (this
    // layout is only ever mounted for an authenticated admin), and its
    // response is small even though it carries the full destination
    // settings alongside `capacity` — a dedicated capacity-only endpoint
    // wasn't worth adding just to shave a few masked-credential fields off
    // a request that already happens every 60s regardless.
    async function loadLogStorageCapacity() {
      try {
        const response = await fetch("/api/admin/log-storage");
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        if (active) setLogStorageCapacity(payload?.capacity || null);
      } catch {
        // Same fallback posture as loadRelease — don't let this block the
        // admin shell from rendering.
      }
    }

    loadRelease();
    loadLogStorageCapacity();
    const intervalId = setInterval(() => {
      loadRelease();
      loadLogStorageCapacity();
    }, 60000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  // Dismissal is per browser tab/session (sessionStorage), not permanent —
  // reopening the admin dashboard in a new tab, or after the browser fully
  // closes, shows it again if still over threshold. A permanent dismiss
  // would let an operator dismiss it once and then never be reminded again
  // even as usage climbs from warning toward halted.
  useEffect(() => {
    try {
      setCapacityBannerDismissed(
        sessionStorage.getItem("nora-admin-log-storage-banner-dismissed") === "1",
      );
    } catch {
      // sessionStorage can throw in some private-browsing modes — just
      // never treat the banner as dismissed in that case.
    }
  }, []);

  function dismissCapacityBanner() {
    setCapacityBannerDismissed(true);
    try {
      sessionStorage.setItem("nora-admin-log-storage-banner-dismissed", "1");
    } catch {
      // Best-effort — the in-memory state above still hides it for the
      // rest of this page's lifetime even if persistence fails.
    }
  }

  function handleLogout() {
    localStorage.removeItem("token");
    // Clear the HttpOnly nora_auth cookie server-side before navigating so
    // /login does not see a still-valid session and bounce back in.
    fetch("/api/auth/logout", { method: "POST", credentials: "include" })
      .catch(() => {})
      .finally(() => {
        window.location.href = loginPath;
      });
  }

  const showReleaseBanner = Boolean(release?.updateAvailable);
  const bannerIsCritical = release?.severity === "critical" || release?.upgradeRequired;
  const showSystemBanner = Boolean(
    systemBanner?.active && systemBanner?.title && systemBanner?.message,
  );
  const systemBannerCritical = systemBanner?.severity === "critical";

  // "warning"/"halted" only ever come back when a real limitBytes is
  // configured (an unlimited local cap, or a remote destination with no
  // cap concept, always resolves to "ok" server-side) — so no separate
  // null-check is needed here for an unlimited destination.
  const showCapacityBanner = Boolean(
    logStorageCapacity &&
      (logStorageCapacity.state === "warning" || logStorageCapacity.state === "halted") &&
      !capacityBannerDismissed,
  );
  const capacityCritical = logStorageCapacity?.state === "halted";
  const capacityPercent =
    logStorageCapacity?.limitBytes != null && logStorageCapacity.limitBytes > 0
      ? Math.min(100, Math.round((logStorageCapacity.usedBytes / logStorageCapacity.limitBytes) * 100))
      : null;

  return (
    <div className="min-h-screen bg-[#eef4fb] text-brand-ink">
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="w-full bg-brand-ink text-brand-foreground md:min-h-screen md:w-72">
          <div className="border-b border-brand-cyan/10 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <img
                src="/admin/logo-mark.png"
                alt="Nora"
                width={44}
                height={44}
                className="h-11 w-11"
              />
              <div>
                <p className="text-lg font-black tracking-tight text-brand-foreground">
                  {t("Nora Admin")}
                </p>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-cyan/65">
                  {t("Full platform control")}
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
                      : "text-brand-foreground/64 hover:bg-brand-cyan/10 hover:text-brand-foreground",
                  )}
                >
                  <item.icon size={18} />
                  {t(item.name)}
                </Link>
              );
            })}
          </nav>

          <div className="hidden px-4 pb-4 md:block">
            <div className="rounded-[1.5rem] border border-brand-cyan/10 bg-brand-cyan/6 p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-cyan/65">
                {t("Guardrail")}
              </p>
              <p className="mt-2 text-sm font-medium leading-relaxed text-brand-foreground/74">
                {t(
                  "This surface is for admins only. Prefer inspect-first workflows, then use lifecycle and delete actions deliberately.",
                )}
              </p>
            </div>
          </div>

          <div className="border-t border-brand-cyan/10 p-3 md:mt-auto md:p-4">
            <LanguageSwitcher className="mb-3 w-full justify-center" />
            <button
              onClick={handleLogout}
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-brand-cyan/12 px-4 py-3 text-sm font-semibold text-brand-foreground/72 transition-colors hover:bg-brand-cyan/10 hover:text-brand-foreground"
            >
              <LogOut size={18} />
              {t("Log Out")}
            </button>
          </div>
        </aside>

        <main className="flex-1">
          <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            {showCapacityBanner ? (
              <div
                className={clsx(
                  "mb-6 flex flex-wrap items-center gap-3 rounded-2xl border px-5 py-4 shadow-sm",
                  capacityCritical ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50",
                )}
              >
                <TriangleAlert
                  size={18}
                  className={clsx("shrink-0", capacityCritical ? "text-red-600" : "text-amber-600")}
                />
                <p className="min-w-0 flex-1 text-sm text-slate-800">
                  <span className="font-black">
                    {capacityPercent != null
                      ? `${capacityPercent}% ${t("of log storage used")}`
                      : t("Log storage capacity")}
                  </span>{" "}
                  {capacityCritical
                    ? t(
                        "Local log storage is full — new runtime/gateway log collection is paused until space frees up or the destination changes.",
                      )
                    : t(
                        "Local log storage is nearing its configured limit. Once it's full, new log collection will pause.",
                      )}{" "}
                  {logStorageCapacity?.limitBytes != null
                    ? `(${formatBytes(logStorageCapacity.usedBytes)} / ${formatBytes(logStorageCapacity.limitBytes)})`
                    : null}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href="/settings#log-storage"
                    className={clsx(
                      "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold shadow-sm transition-all hover:-translate-y-0.5",
                      capacityCritical
                        ? "bg-red-600 text-white hover:bg-red-700"
                        : "bg-amber-500 text-slate-950 hover:bg-amber-400",
                    )}
                  >
                    {t("Manage log storage")}
                  </Link>
                  <button
                    type="button"
                    onClick={dismissCapacityBanner}
                    aria-label={t("Dismiss")}
                    className="rounded-full p-1.5 text-slate-500 hover:bg-black/5"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ) : null}
            {showSystemBanner ? (
              <section
                className={clsx(
                  "mb-6 overflow-hidden rounded-[2rem] border px-5 py-5 shadow-sm sm:px-6",
                  systemBannerCritical
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50",
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={clsx(
                      "mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
                      systemBannerCritical
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700",
                    )}
                  >
                    <TriangleAlert size={20} />
                  </span>
                  <div className="min-w-0">
                    <p
                      className={clsx(
                        "text-[11px] font-black uppercase tracking-[0.18em]",
                        systemBannerCritical ? "text-red-600" : "text-amber-700",
                      )}
                    >
                      {systemBannerCritical ? t("System Critical") : t("System Warning")}
                    </p>
                    <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                      {systemBanner.title}
                    </h2>
                    <p
                      className={clsx(
                        "mt-2 max-w-4xl text-sm font-medium leading-relaxed",
                        systemBannerCritical ? "text-red-700/80" : "text-amber-800/90",
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
                  bannerIsCritical ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50",
                )}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p
                      className={clsx(
                        "text-[11px] font-black uppercase tracking-[0.18em]",
                        bannerIsCritical ? "text-red-600" : "text-amber-700",
                      )}
                    >
                      {bannerIsCritical ? t("Upgrade Required") : t("New Nora Version Available")}
                    </p>
                    <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                      {release?.latestVersion
                        ? `${formatVersionLabel(release.latestVersion)} is ready`
                        : t("A newer Nora release is available")}
                    </h2>
                    <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-700">
                      {release?.currentVersion
                        ? `This control plane is running ${formatVersionLabel(release.currentVersion)}${
                            formatShortCommit(release.currentCommit)
                              ? ` (${formatShortCommit(release.currentCommit)})`
                              : ""
                          }. Review the upgrade guidance to choose one-click or manual upgrade.`
                        : "This instance is not reporting its current version yet. Review the upgrade guidance and verify the host-side build before you upgrade."}
                      {release?.publishedAt
                        ? ` Latest release announced ${formatDateTime(release.publishedAt)}.`
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
                          : "bg-amber-500 text-slate-950 hover:bg-amber-400",
                      )}
                    >
                      {t("Review upgrade")}
                    </Link>
                    {release?.releaseNotesUrl ? (
                      <a
                        href={release.releaseNotesUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50"
                      >
                        {t("Release notes")}
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
