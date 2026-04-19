import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import {
  ArrowRight,
  Loader2,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import MetricCard from "../../components/MetricCard";
import StatusBadge from "../../components/StatusBadge";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import { formatCount, formatDate, formatShortId } from "../../lib/format";

function matchesAgent(agent, search) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    agent.name?.toLowerCase().includes(needle) ||
    agent.ownerEmail?.toLowerCase().includes(needle) ||
    agent.id?.toLowerCase().includes(needle) ||
    agent.node?.toLowerCase().includes(needle) ||
    agent.backend_type?.toLowerCase().includes(needle)
  );
}

export default function FleetPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const deferredSearch = useDeferredValue(search);
  const toast = useToast();

  const loadAgents = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/api/admin/agents");
      if (!response.ok) {
        throw new Error("Failed to load fleet");
      }

      const data = await response.json();
      setAgents(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Failed to load admin fleet:", error);
      toast.error(error.message || "Failed to load fleet");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadAgents();
    const intervalId = setInterval(loadAgents, 30000);
    return () => clearInterval(intervalId);
  }, [loadAgents]);

  const filteredAgents = agents.filter((agent) => {
    if (statusFilter !== "all" && agent.status !== statusFilter) return false;
    return matchesAgent(agent, deferredSearch);
  });

  const statusCounts = agents.reduce((counts, agent) => {
    counts[agent.status] = (counts[agent.status] || 0) + 1;
    return counts;
  }, {});

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Fleet Admin
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Global agent fleet
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Inspect every agent across all users, filter by status, and drill
              into admin-only lifecycle controls and runtime diagnostics.
            </p>
          </div>

          <button
            onClick={() => {
              setLoading(true);
              loadAgents();
            }}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Total Agents"
            value={formatCount(agents.length)}
            icon={Server}
            tone="blue"
            caption="All admin-visible runtimes"
          />
          <MetricCard
            label="Running"
            value={formatCount(statusCounts.running || 0)}
            icon={RefreshCw}
            tone="emerald"
            caption={`${formatCount(statusCounts.warning || 0)} warning`}
          />
          <MetricCard
            label="Queued / Deploying"
            value={formatCount(
              (statusCounts.queued || 0) + (statusCounts.deploying || 0)
            )}
            icon={ArrowRight}
            tone="purple"
            caption="Work still in flight"
          />
          <MetricCard
            label="Stopped / Error"
            value={formatCount((statusCounts.stopped || 0) + (statusCounts.error || 0))}
            icon={Server}
            tone="red"
            caption="Requires operator attention"
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
                placeholder="Search by agent, owner, backend, node, or id"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-red-200 focus:bg-white"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 outline-none transition-colors focus:border-red-200 focus:bg-white"
            >
              <option value="all">All statuses</option>
              <option value="running">Running</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="queued">Queued</option>
              <option value="deploying">Deploying</option>
              <option value="stopped">Stopped</option>
            </select>
          </div>

          <div className="mt-6 overflow-x-auto">
            {loading ? (
              <div className="flex h-56 items-center justify-center">
                <Loader2 size={28} className="animate-spin text-red-500" />
              </div>
            ) : filteredAgents.length === 0 ? (
              <div className="flex h-56 items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-sm font-medium text-slate-400">
                No agents match the current filters.
              </div>
            ) : (
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Agent
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Owner
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Runtime
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Status
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Created
                    </th>
                    <th className="px-2 py-3 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => (
                    <tr
                      key={agent.id}
                      className="border-b border-slate-100 last:border-b-0"
                    >
                      <td className="px-2 py-4">
                        <div>
                          <p className="text-sm font-semibold text-slate-950">
                            {agent.name}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {formatShortId(agent.id)} · {agent.container_name || "no container name"}
                          </p>
                        </div>
                      </td>
                      <td className="px-2 py-4">
                        <div>
                          <p className="text-sm font-medium text-slate-700">
                            {agent.ownerEmail || "Unknown owner"}
                          </p>
                          <p className="mt-1 text-xs text-slate-400">
                            {formatShortId(agent.user_id)}
                          </p>
                        </div>
                      </td>
                      <td className="px-2 py-4">
                        <div>
                          <p className="text-sm font-medium text-slate-700">
                            {agent.backend_type || "docker"} · {agent.node || "node n/a"}
                          </p>
                          <p className="mt-1 text-xs text-slate-400">
                            {agent.container_id
                              ? formatShortId(agent.container_id, 12)
                              : "no container"}
                          </p>
                        </div>
                      </td>
                      <td className="px-2 py-4">
                        <StatusBadge status={agent.status} />
                      </td>
                      <td className="px-2 py-4 text-sm font-medium text-slate-500">
                        {formatDate(agent.created_at)}
                      </td>
                      <td className="px-2 py-4 text-right">
                        <Link
                          href={`/fleet/${agent.id}`}
                          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Open
                          <ArrowRight size={15} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
