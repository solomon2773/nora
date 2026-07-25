import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Waypoints,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import MetricCard from "../components/MetricCard";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { KubernetesCluster, statusClass } from "../lib/kubernetes";
import { formatCount, formatDate } from "../lib/format";

function matchesCluster(cluster: KubernetesCluster, search: string) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [
    cluster.label,
    cluster.id,
    cluster.clusterName,
    cluster.providerLabel,
    cluster.provider,
    cluster.namespace,
    cluster.openclawNamespace,
    cluster.hermesNamespace,
    cluster.kubeContext,
    cluster.runtimeHost,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

export default function KubernetesRegistryPage() {
  const toast = useToast();
  const [clusters, setClusters] = useState<KubernetesCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const deferredSearch = useDeferredValue(search);

  const availableCount = useMemo(
    () => clusters.filter((cluster) => cluster.available).length,
    [clusters],
  );

  const policyReadyCount = useMemo(
    () => clusters.filter((cluster) => cluster.supportsNetworkPolicy).length,
    [clusters],
  );

  const attentionCount = useMemo(
    () =>
      clusters.filter(
        (cluster) =>
          cluster.lastTestStatus === "failed" ||
          cluster.available === false ||
          cluster.enabled === false,
      ).length,
    [clusters],
  );

  const loadClusters = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchWithAuth("/api/admin/kubernetes-clusters");
      const payload = await response.json().catch(() => []);
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load Kubernetes clusters");
      }
      setClusters(Array.isArray(payload) ? payload : []);
    } catch (error) {
      console.error("Failed to load Kubernetes clusters:", error);
      toast.error(error instanceof Error ? error.message : "Failed to load Kubernetes clusters");
      setClusters([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);

  const filteredClusters = useMemo(
    () =>
      clusters.filter((cluster) => {
        if (statusFilter === "available" && !cluster.available) return false;
        if (statusFilter === "failed" && cluster.lastTestStatus !== "failed") return false;
        if (statusFilter === "untested" && cluster.lastTestStatus) return false;
        if (statusFilter === "disabled" && cluster.enabled !== false) return false;
        return matchesCluster(cluster, deferredSearch);
      }),
    [clusters, deferredSearch, statusFilter],
  );

  return (
    <AdminLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Runtime Placement
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Kubernetes clusters
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Inspect every registered execution target, watch readiness at a glance, and open a
              dedicated detail page for config and network policy management.
            </p>
          </div>
          <Link
            href="/kubernetes/new"
            className="inline-flex items-center justify-center gap-2 self-start rounded-2xl bg-red-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-red-700"
          >
            <Plus size={16} />
            Add cluster
          </Link>
        </header>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Registered Clusters"
            value={formatCount(clusters.length)}
            icon={Boxes}
            tone="blue"
            caption="All Nora execution targets"
          />
          <MetricCard
            label="Available"
            value={formatCount(availableCount)}
            icon={Waypoints}
            tone="emerald"
            caption="Ready for deploy traffic"
          />
          <MetricCard
            label="Policy Capable"
            value={formatCount(policyReadyCount)}
            icon={Shield}
            tone="purple"
            caption="Targets advertising NetworkPolicy support"
          />
          <MetricCard
            label="Needs Attention"
            value={formatCount(attentionCount)}
            icon={RefreshCw}
            tone="red"
            caption="Failed, unavailable, or disabled"
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
                placeholder="Search by label, cluster, namespace, provider, context, or id"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-red-200 focus:bg-white"
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 outline-none transition-colors focus:border-red-200 focus:bg-white"
              >
                <option value="all">All clusters</option>
                <option value="available">Available</option>
                <option value="failed">Failed test</option>
                <option value="untested">Untested</option>
                <option value="disabled">Disabled</option>
              </select>

              <button
                type="button"
                onClick={() => void loadClusters()}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-6 overflow-x-auto">
            {loading ? (
              <div className="flex h-56 items-center justify-center">
                <Loader2 size={28} className="animate-spin text-red-500" />
              </div>
            ) : filteredClusters.length === 0 ? (
              <div className="flex h-56 items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-sm font-medium text-slate-400">
                {clusters.length === 0
                  ? "No Kubernetes clusters are registered yet."
                  : "No clusters match the current filters."}
              </div>
            ) : (
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="w-[28%] px-4 py-4 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Cluster
                    </th>
                    <th className="w-[12%] px-4 py-4 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Provider
                    </th>
                    <th className="w-[24%] px-4 py-4 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Namespaces
                    </th>
                    <th className="w-[14%] px-4 py-4 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Status
                    </th>
                    <th className="w-[14%] px-4 py-4 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Created On
                    </th>
                    <th className="px-4 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClusters.map((cluster) => {
                    const namespaces =
                      cluster.openclawNamespace === cluster.hermesNamespace
                        ? cluster.openclawNamespace || cluster.namespace || "openclaw-agents"
                        : `${cluster.openclawNamespace || cluster.namespace || "openclaw-agents"} / ${cluster.hermesNamespace || cluster.namespace || "hermes-agents"}`;

                    return (
                      <tr key={cluster.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-4 py-4 align-middle">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">{cluster.label}</p>
                            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                              <span>{cluster.clusterName || cluster.id}</span>
                              <span className="text-slate-400">•</span>
                              <span className="text-slate-400">{cluster.id}</span>
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4 align-middle">
                          <div>
                            <p className="text-sm font-medium text-slate-700">
                              {cluster.providerLabel || cluster.provider || "kubernetes"}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4 align-middle">
                          <div>
                            <p className="text-sm font-medium text-slate-700">{namespaces}</p>
                            <p className="mt-1 text-xs text-slate-400">
                              context {cluster.kubeContext || "default"}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4 align-middle">
                          <div>
                            <span
                              className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                                cluster.lastTestStatus,
                              )}`}
                            >
                              {cluster.lastTestStatus || "untested"}
                            </span>
                            <p className="mt-1 text-xs text-slate-500">
                              {cluster.available ? "available" : "not available"}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4 align-middle">
                          <div>
                            <p className="text-sm font-medium text-slate-500">
                              {cluster.createdAt ? formatDate(cluster.createdAt) : "—"}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right align-middle">
                          <Link
                            href={`/kubernetes/${encodeURIComponent(cluster.id)}`}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                          >
                            Open
                            <ArrowRight size={15} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
