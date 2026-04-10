import Layout from "../../components/layout/Layout";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { clsx } from "clsx";
import { useState, useEffect, useCallback } from "react";
import { fetchWithAuth } from "../../lib/api";

const STATUS_CONFIG = {
  running: {
    label: "Active Agents",
    shortLabel: "Running",
    color: "blue",
    icon: Zap,
    dot: "bg-blue-500",
    pill: "bg-blue-50 text-blue-700 border-blue-200",
  },
  warning: {
    label: "Warning Agents",
    shortLabel: "Warning",
    color: "amber",
    icon: AlertCircle,
    dot: "bg-amber-500",
    pill: "bg-amber-50 text-amber-700 border-amber-200",
  },
  error: {
    label: "Error Agents",
    shortLabel: "Error",
    color: "red",
    icon: ShieldAlert,
    dot: "bg-red-500",
    pill: "bg-red-50 text-red-700 border-red-200",
  },
  queued: {
    label: "Queued Agents",
    shortLabel: "Queued",
    color: "violet",
    icon: Clock3,
    dot: "bg-violet-500",
    pill: "bg-violet-50 text-violet-700 border-violet-200",
  },
  stopped: {
    label: "Stopped Agents",
    shortLabel: "Stopped",
    color: "slate",
    icon: Bot,
    dot: "bg-slate-400",
    pill: "bg-slate-100 text-slate-700 border-slate-200",
  },
};

function formatTimestamp(value) {
  if (!value) return "Unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "Unknown";
  }
}

function buildStatusCounts(metrics, agents) {
  return {
    running:
      metrics?.activeAgents ?? agents.filter((agent) => agent.status === "running").length,
    warning:
      metrics?.warningAgents ?? agents.filter((agent) => agent.status === "warning").length,
    error:
      metrics?.errorAgents ?? agents.filter((agent) => agent.status === "error").length,
    queued:
      metrics?.queuedAgents ?? agents.filter((agent) => agent.status === "queued").length,
    stopped:
      metrics?.stoppedAgents ?? agents.filter((agent) => agent.status === "stopped").length,
    total: metrics?.totalAgents ?? agents.length,
  };
}

export default function Monitoring() {
  const [metrics, setMetrics] = useState(null);
  const [events, setEvents] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [metricsRes, eventsRes, agentsRes] = await Promise.all([
        fetchWithAuth("/api/monitoring/metrics"),
        fetchWithAuth("/api/monitoring/events?limit=20"),
        fetchWithAuth("/api/agents"),
      ]);
      if (metricsRes.ok) setMetrics(await metricsRes.json());
      if (eventsRes.ok) setEvents(await eventsRes.json());
      if (agentsRes.ok) setAgents(await agentsRes.json());
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const statusCounts = buildStatusCounts(metrics, agents);
  const statCards = [
    {
      name: "Total Agents",
      value: statusCounts.total,
      icon: Activity,
      color: "emerald",
    },
    {
      name: STATUS_CONFIG.running.label,
      value: statusCounts.running,
      icon: STATUS_CONFIG.running.icon,
      color: STATUS_CONFIG.running.color,
    },
    {
      name: STATUS_CONFIG.warning.label,
      value: statusCounts.warning,
      icon: STATUS_CONFIG.warning.icon,
      color: STATUS_CONFIG.warning.color,
    },
    {
      name: STATUS_CONFIG.error.label,
      value: statusCounts.error,
      icon: STATUS_CONFIG.error.icon,
      color: STATUS_CONFIG.error.color,
    },
    {
      name: STATUS_CONFIG.queued.label,
      value: statusCounts.queued,
      icon: STATUS_CONFIG.queued.icon,
      color: STATUS_CONFIG.queued.color,
    },
  ];

  const statusRows = ["running", "warning", "error", "queued", "stopped"].map((key) => {
    const config = STATUS_CONFIG[key];
    const count = statusCounts[key];
    const total = Math.max(statusCounts.total || 0, 1);
    return {
      key,
      ...config,
      count,
      percentage: statusCounts.total ? Math.round((count / total) * 100) : 0,
    };
  });

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
              <Activity size={28} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none">
                Fleet Monitoring
              </h1>
              <p className="text-slate-400 font-medium text-sm mt-1">
                Live status for your own Nora agents only. Auto-refreshes every 30s.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="flex items-center gap-2 px-5 py-3 bg-white border border-slate-200 rounded-2xl text-sm font-bold text-slate-600 hover:bg-slate-50 transition-all shadow-sm active:scale-95"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        {loading && !metrics && agents.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white border border-slate-200 rounded-[3rem] border-dashed">
            <Loader2 size={40} className="animate-spin text-blue-500" />
            <span className="text-sm font-bold uppercase tracking-widest">Loading fleet health...</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-6">
              {statCards.map((card) => (
                <StatCard
                  key={card.name}
                  title={card.name}
                  value={card.value}
                  icon={card.icon}
                  color={card.color}
                />
              ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-10">
              <section className="flex flex-col gap-6">
                <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <Activity size={20} className="text-blue-600" /> Status Breakdown
                </h2>
                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 flex flex-col gap-6 shadow-sm">
                  {statusRows.map((row) => (
                    <div key={row.key} className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={clsx(
                              "w-10 h-10 rounded-2xl flex items-center justify-center shadow-sm",
                              row.color === "blue"
                                ? "bg-blue-50 text-blue-600"
                                : row.color === "amber"
                                  ? "bg-amber-50 text-amber-600"
                                  : row.color === "red"
                                    ? "bg-red-50 text-red-600"
                                    : row.color === "violet"
                                      ? "bg-violet-50 text-violet-600"
                                      : "bg-slate-100 text-slate-600"
                            )}
                          >
                            <row.icon size={18} />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-slate-900">{row.shortLabel}</p>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                              {row.percentage}% of fleet
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-black text-slate-900">{row.count}</p>
                        </div>
                      </div>
                      <div className="w-full bg-slate-100 h-3 rounded-full overflow-hidden">
                        <div
                          className={clsx(
                            "h-full rounded-full",
                            row.dot
                          )}
                          style={{ width: `${row.percentage}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="flex flex-col gap-6">
                <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <Bot size={20} className="text-emerald-600" /> Your Agents
                </h2>
                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-4 shadow-sm flex flex-col gap-2 max-h-[560px] overflow-y-auto">
                  {agents.length === 0 ? (
                    <div className="p-8 text-center text-sm text-slate-400 font-medium">
                      No agents deployed yet.
                    </div>
                  ) : (
                    agents.map((agent) => {
                      const config = STATUS_CONFIG[agent.status] || STATUS_CONFIG.stopped;
                      return (
                        <a
                          key={agent.id}
                          href={`/app/agents/${agent.id}`}
                          className="p-4 flex items-start gap-4 hover:bg-slate-50 transition-all rounded-2xl border border-transparent hover:border-slate-200"
                        >
                          <div
                            className={clsx(
                              "w-10 h-10 rounded-2xl flex items-center justify-center shadow-sm flex-shrink-0",
                              config.color === "blue"
                                ? "bg-blue-50 text-blue-600"
                                : config.color === "amber"
                                  ? "bg-amber-50 text-amber-600"
                                  : config.color === "red"
                                    ? "bg-red-50 text-red-600"
                                    : config.color === "violet"
                                      ? "bg-violet-50 text-violet-600"
                                      : "bg-slate-100 text-slate-600"
                            )}
                          >
                            <config.icon size={18} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-slate-900 truncate">
                                  {agent.name}
                                </p>
                                <p className="text-xs text-slate-500 mt-1">
                                  {agent.node || "Local host"} {agent.sandbox_type ? `· ${agent.sandbox_type}` : ""}
                                </p>
                              </div>
                              <div className="flex items-center gap-3 flex-shrink-0">
                                <span
                                  className={clsx(
                                    "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest",
                                    config.pill
                                  )}
                                >
                                  <span className={clsx("w-1.5 h-1.5 rounded-full", config.dot)} />
                                  {config.shortLabel}
                                </span>
                                <ArrowUpRight size={16} className="text-slate-400" />
                              </div>
                            </div>
                          </div>
                        </a>
                      );
                    })
                  )}
                </div>
              </section>
            </div>

            <section className="flex flex-col gap-6">
              <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                <CheckCircle2 size={20} className="text-blue-600" /> Recent Events
              </h2>
              <div className="bg-white border border-slate-200 rounded-[2.5rem] p-4 shadow-sm flex flex-col gap-2 max-h-[520px] overflow-y-auto">
                {events.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400 font-medium">
                    No events recorded for your agents yet.
                  </div>
                ) : (
                  events.map((event) => (
                    <div
                      key={event.id}
                      className="p-4 flex items-start gap-4 hover:bg-slate-50 transition-all rounded-2xl"
                    >
                      {event.type === "deployment" ? (
                        <CheckCircle2 size={18} className="text-emerald-500 mt-0.5 flex-shrink-0" />
                      ) : (
                        <Activity size={18} className="text-blue-500 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-bold text-slate-900 leading-tight mb-1 break-words">
                          {event.message}
                        </span>
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                          {formatTimestamp(event.created_at)} · {event.type}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}

function StatCard({ title, value, icon: Icon, color }) {
  return (
    <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-xl transition-all group">
      <div
        className={clsx(
          "w-12 h-12 rounded-2xl flex items-center justify-center mb-6 shadow-sm transition-transform group-hover:scale-110",
          color === "blue"
            ? "bg-blue-50 text-blue-600"
            : color === "emerald"
              ? "bg-emerald-50 text-emerald-600"
              : color === "amber"
                ? "bg-amber-50 text-amber-600"
                : color === "red"
                  ? "bg-red-50 text-red-600"
                  : "bg-violet-50 text-violet-600"
        )}
      >
        <Icon size={24} />
      </div>
      <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.15em] mb-1">
        {title}
      </h3>
      <div className="text-3xl font-black text-slate-900 leading-none">{value}</div>
    </div>
  );
}
