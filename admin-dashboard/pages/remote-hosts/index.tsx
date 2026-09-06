import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CircleAlert,
  Globe2,
  HardDrive,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import MetricCard from "../../components/MetricCard";
import RemoteHostsAvailability from "../../components/remote-hosts/RemoteHostsAvailability";
import RemoteHostStatusBadge from "../../components/remote-hosts/RemoteHostStatusBadge";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useVerifiedPlatformMode } from "../../lib/platform";
import {
  errorMessage,
  isPlatformRemoteHost,
  normalizeRemoteHostList,
  remoteHostSshTarget,
  responseError,
  type RemoteHost,
} from "../../lib/remoteHosts";

type ScopeFilter = "all" | "platform" | "user";
type Translate = ReturnType<typeof useI18n>["t"];

function ownerLabel(host: RemoteHost, t: Translate) {
  if (isPlatformRemoteHost(host)) {
    return host.createdByName || host.createdByEmail || host.createdByUserId || t("Platform admin");
  }
  return host.ownerName || host.ownerEmail || host.ownerUserId || t("Operator account");
}

function matchesHost(host: RemoteHost, search: string, t: Translate) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [host.label, host.id, host.executionTargetId, ownerLabel(host, t)]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function accessLabel(host: RemoteHost, t: Translate) {
  if (!isPlatformRemoteHost(host)) return t("Personal");
  return host.availableToAll ? t("All accounts") : t("Restricted");
}

function PersonalHostStatus({ host }: { host: RemoteHost }) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${
        host.enabled === false ? "bg-slate-100 text-slate-600" : "bg-brand-cyan/15 text-brand-ink"
      }`}
    >
      {host.enabled === false ? t("Disabled") : t("Registered")}
    </span>
  );
}

function HostMobileCard({ host }: { host: RemoteHost }) {
  const { t } = useI18n();
  const platform = isPlatformRemoteHost(host);
  return (
    <article className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-black text-slate-950">{host.label}</p>
          <p className="mt-1 truncate font-mono text-xs text-slate-500">
            {host.executionTargetId || `remote:${host.id}`}
          </p>
        </div>
        {platform ? <RemoteHostStatusBadge host={host} /> : <PersonalHostStatus host={host} />}
      </div>

      <dl className="mt-5 grid gap-3 text-sm">
        <div className="rounded-2xl bg-slate-50 px-4 py-3">
          <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            {t("Management")}
          </dt>
          <dd className="mt-1 font-bold text-slate-800">
            {platform ? t("Platform managed") : t("Personal / operator managed")}
          </dd>
        </div>
        <div className="rounded-2xl bg-slate-50 px-4 py-3">
          <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            {t("Owner")}
          </dt>
          <dd className="mt-1 truncate font-semibold text-slate-700">{ownerLabel(host, t)}</dd>
        </div>
        <div className="rounded-2xl bg-slate-50 px-4 py-3">
          <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            {t("SSH target")}
          </dt>
          <dd className="mt-1 truncate font-mono text-xs text-slate-600">
            {remoteHostSshTarget(host, !platform)}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <span className="rounded-full bg-brand-cyan/15 px-3 py-1 text-xs font-bold text-brand-ink">
          {accessLabel(host, t)}
        </span>
        {platform ? (
          <Link
            href={`/remote-hosts/${encodeURIComponent(host.id)}`}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20"
          >
            {t("Open")}
            <ArrowRight size={15} />
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500">
            <LockKeyhole size={14} />
            {t("Read only")}
          </span>
        )}
      </div>
    </article>
  );
}

export default function RemoteHostsRegistryPage() {
  const { t } = useI18n();
  const toast = useToast();
  const platformMode = useVerifiedPlatformMode();
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const deferredSearch = useDeferredValue(search);

  const loadHosts = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchWithAuth("/api/admin/remote-hosts");
      if (!response.ok) {
        const failure = await responseError(response, t("Failed to load Remote Hosts"));
        throw new Error(failure.message);
      }
      setHosts(normalizeRemoteHostList(await response.json().catch(() => [])));
    } catch (error) {
      toast.error(errorMessage(error, t("Failed to load Remote Hosts")));
      setHosts([]);
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    if (platformMode !== "selfhosted") {
      if (platformMode !== "loading") setLoading(false);
      return;
    }
    void loadHosts();
  }, [loadHosts, platformMode]);

  const platformHosts = useMemo(() => hosts.filter(isPlatformRemoteHost), [hosts]);
  const personalHosts = useMemo(() => hosts.filter((host) => !isPlatformRemoteHost(host)), [hosts]);
  const availableCount = useMemo(
    () => platformHosts.filter((host) => host.available && host.enabled !== false).length,
    [platformHosts],
  );
  const attentionCount = useMemo(
    () => platformHosts.filter((host) => !host.available).length,
    [platformHosts],
  );

  const filteredHosts = useMemo(
    () =>
      hosts.filter((host) => {
        if (scopeFilter === "platform" && !isPlatformRemoteHost(host)) return false;
        if (scopeFilter === "user" && isPlatformRemoteHost(host)) return false;
        return matchesHost(host, deferredSearch.trim(), t);
      }),
    [deferredSearch, hosts, scopeFilter, t],
  );

  if (platformMode !== "selfhosted") {
    return (
      <AdminLayout>
        <RemoteHostsAvailability mode={platformMode} />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-ink/55">
              {t("Bring Your Own Compute")}
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              {t("Remote Hosts")}
            </h1>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
              {t(
                "Manage platform-owned Remote Docker targets and inspect the masked personal-host fleet without exposing operator credentials.",
              )}
            </p>
          </div>
          <Link
            href="/remote-hosts/new"
            className="inline-flex items-center justify-center gap-2 self-start rounded-2xl bg-brand-cyan px-4 py-3 text-sm font-black text-brand-ink shadow-sm transition hover:bg-brand-cyan/80 focus:outline-none focus:ring-4 focus:ring-brand-cyan/30"
          >
            <Plus size={16} />
            {t("Add platform host")}
          </Link>
        </header>

        <section className="flex items-start gap-3 rounded-[1.5rem] border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <CircleAlert size={19} className="mt-0.5 shrink-0 text-amber-700" />
          <div>
            <h2 className="text-sm font-black">{t("Experimental placement path")}</h2>
            <p className="mt-1 text-sm font-medium leading-relaxed text-amber-900/80">
              {t(
                "Keep runtime ports on a private encrypted network. Test each host so Nora can verify Docker and pin the SSH host key before deployment.",
              )}
            </p>
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label={t("Platform Hosts")}
            value={platformHosts.length}
            icon={ShieldCheck}
            tone="blue"
            caption={t("Admin-managed targets")}
          />
          <MetricCard
            label={t("Personal Hosts")}
            value={personalHosts.length}
            icon={UserRound}
            tone="purple"
            caption={t("Masked operator fleet")}
          />
          <MetricCard
            label={t("Available")}
            value={availableCount}
            icon={Globe2}
            tone="emerald"
            caption={t("Tested and enabled")}
          />
          <MetricCard
            label={t("Needs Attention")}
            value={attentionCount}
            icon={CircleAlert}
            tone="red"
            caption={t("Disabled, untested, or failed")}
          />
        </div>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative max-w-xl flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={t("Search Remote Hosts")}
                placeholder={t("Search by label, id, execution target, or owner")}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm font-semibold text-slate-900 outline-none transition focus:border-brand-cyan focus:bg-white focus:ring-4 focus:ring-brand-cyan/20"
              />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <select
                value={scopeFilter}
                onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
                aria-label={t("Filter Remote Hosts by management scope")}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-brand-cyan focus:ring-4 focus:ring-brand-cyan/20"
              >
                <option value="all">{t("All hosts")}</option>
                <option value="platform">{t("Platform managed")}</option>
                <option value="user">{t("Personal / operator managed")}</option>
              </select>
              <button
                type="button"
                onClick={() => void loadHosts()}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20 disabled:opacity-60"
              >
                <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
                {t("Refresh")}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex h-64 items-center justify-center text-sm font-semibold text-slate-500">
              <Loader2 size={22} className="mr-2 animate-spin text-brand-ink" />
              {t("Loading Remote Hosts…")}
            </div>
          ) : filteredHosts.length === 0 ? (
            <div className="mt-6 flex min-h-56 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-5 text-center">
              <HardDrive size={28} className="text-slate-300" />
              <p className="mt-3 text-sm font-bold text-slate-600">
                {hosts.length === 0
                  ? t("No Remote Hosts are registered yet.")
                  : t("No Remote Hosts match the current filters.")}
              </p>
            </div>
          ) : (
            <>
              <div className="mt-6 grid gap-4 md:hidden">
                {filteredHosts.map((host) => (
                  <HostMobileCard key={host.id} host={host} />
                ))}
              </div>

              <div className="mt-6 hidden overflow-x-auto md:block">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                      <th className="px-4 py-4">{t("Host")}</th>
                      <th className="px-4 py-4">{t("Management")}</th>
                      <th className="px-4 py-4">{t("Owner")}</th>
                      <th className="px-4 py-4">{t("SSH target")}</th>
                      <th className="px-4 py-4">{t("Access")}</th>
                      <th className="px-4 py-4">{t("Status")}</th>
                      <th className="px-4 py-4">{t("Last tested")}</th>
                      <th className="px-4 py-4 text-right">{t("Action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHosts.map((host) => {
                      const platform = isPlatformRemoteHost(host);
                      return (
                        <tr key={host.id} className="border-b border-slate-100 last:border-b-0">
                          <td className="px-4 py-4 align-middle">
                            <p className="font-bold text-slate-950">{host.label}</p>
                            <p className="mt-1 font-mono text-xs text-slate-500">
                              {host.executionTargetId || `remote:${host.id}`}
                            </p>
                          </td>
                          <td className="px-4 py-4 align-middle">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                                platform
                                  ? "bg-brand-cyan/15 text-brand-ink"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {platform ? <ShieldCheck size={13} /> : <UserRound size={13} />}
                              {platform ? t("Platform") : t("Personal")}
                            </span>
                          </td>
                          <td className="max-w-48 px-4 py-4 align-middle">
                            <p
                              className="truncate font-semibold text-slate-700"
                              title={ownerLabel(host, t)}
                            >
                              {ownerLabel(host, t)}
                            </p>
                          </td>
                          <td className="px-4 py-4 align-middle font-mono text-xs text-slate-600">
                            {remoteHostSshTarget(host, !platform)}
                          </td>
                          <td className="px-4 py-4 align-middle text-xs font-bold text-slate-600">
                            {accessLabel(host, t)}
                          </td>
                          <td className="px-4 py-4 align-middle">
                            {platform ? (
                              <RemoteHostStatusBadge host={host} />
                            ) : (
                              <PersonalHostStatus host={host} />
                            )}
                            {platform &&
                            host.lastTestStatus === "failed" &&
                            host.lastTestMessage ? (
                              <p
                                className="mt-1 max-w-48 truncate text-xs font-medium text-red-700"
                                title={host.lastTestMessage}
                              >
                                {host.lastTestMessage}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-4 py-4 align-middle text-xs font-medium text-slate-500">
                            {platform
                              ? host.lastTestedAt
                                ? formatDateTime(host.lastTestedAt)
                                : t("Never")
                              : t("Redacted")}
                          </td>
                          <td className="px-4 py-4 text-right align-middle">
                            {platform ? (
                              <Link
                                href={`/remote-hosts/${encodeURIComponent(host.id)}`}
                                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20"
                              >
                                {t("Open")}
                                <ArrowRight size={15} />
                              </Link>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500">
                                <LockKeyhole size={14} />
                                {t("Read only")}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}
