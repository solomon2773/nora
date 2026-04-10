import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  FileText,
  Loader2,
  RefreshCw,
  Server,
  TriangleAlert,
  Users,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import MetricCard from "../components/MetricCard";
import { fetchWithAuth } from "../lib/api";
import { formatCount, formatDateTime } from "../lib/format";

const EVENT_STYLES = {
  agent_deployed: { icon: Activity, tone: "text-emerald-600 bg-emerald-50" },
  agent_redeployed: { icon: RefreshCw, tone: "text-blue-600 bg-blue-50" },
  marketplace_published: {
    icon: FileText,
    tone: "text-violet-600 bg-violet-50",
  },
  default: { icon: Activity, tone: "text-slate-500 bg-slate-100" },
};

function EventRow({ event }) {
  const config = EVENT_STYLES[event.type] || EVENT_STYLES.default;
  const Icon = config.icon;
  return (
    <div className="flex items-start gap-4 rounded-[1.5rem] px-4 py-4 transition-colors hover:bg-slate-50">
      <div
        className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${config.tone}`}
      >
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{event.message}</p>
        <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
          {event.type} · {formatDateTime(event.created_at)}
        </p>
      </div>
    </div>
  );
}

export default function AdminHome() {
  const [metrics, setMetrics] = useState(null);
  const [events, setEvents] = useState([]);
  const [dlqJobs, setDlqJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, eventsRes, dlqRes] = await Promise.all([
        fetchWithAuth("/api/admin/stats"),
        fetchWithAuth("/api/admin/audit"),
        fetchWithAuth("/api/admin/dlq"),
      ]);

      if (statsRes.ok) {
        setMetrics(await statsRes.json());
      }
      if (eventsRes.ok) {
        const auditPayload = await eventsRes.json();
        const auditEvents = Array.isArray(auditPayload?.events)
          ? auditPayload.events
          : Array.isArray(auditPayload)
            ? auditPayload
            : [];
        setEvents(auditEvents.slice(0, 6));
      }
      if (dlqRes.ok) {
        const jobs = await dlqRes.json();
        setDlqJobs(Array.isArray(jobs) ? jobs : []);
      }
    } catch (error) {
      console.error("Failed to load admin overview:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const intervalId = setInterval(loadData, 30000);
    return () => clearInterval(intervalId);
  }, [loadData]);

  const queue = metrics?.queue || {};
  const cards = [
    {
      label: "Total Users",
      value: formatCount(metrics?.totalUsers ?? 0),
      icon: Users,
      tone: "blue",
      href: "/users",
      caption: "Accounts across the platform",
    },
    {
      label: "Total Agents",
      value: formatCount(metrics?.totalAgents ?? 0),
      icon: Server,
      tone: "emerald",
      href: "/fleet",
      caption: "All runtimes and queued agents",
    },
    {
      label: "Live Agents",
      value: formatCount(metrics?.activeAgents ?? 0),
      icon: Activity,
      tone: "purple",
      href: "/fleet",
      caption: `${formatCount(metrics?.warningAgents ?? 0)} warning · ${formatCount(metrics?.errorAgents ?? 0)} error`,
    },
    {
      label: "Queue Pressure",
      value: formatCount(queue.waiting ?? 0),
      icon: TriangleAlert,
      tone: dlqJobs.length > 0 ? "red" : "orange",
      href: "/queue",
      caption: `${formatCount(dlqJobs.length)} jobs in DLQ`,
    },
  ];

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Platform Overview
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Admin control plane
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Ops-first visibility for fleet health, queue pressure, user
              management, and recent platform activity.
            </p>
          </div>

          <button
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        {loading && !metrics ? (
          <div className="flex h-64 items-center justify-center rounded-[2rem] border border-slate-200 bg-white shadow-sm">
            <Loader2 size={32} className="animate-spin text-red-500" />
          </div>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {cards.map((card) => (
                <MetricCard key={card.label} {...card} />
              ))}
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-black tracking-tight text-slate-950">
                      Queue health
                    </h2>
                    <p className="mt-1 text-sm font-medium text-slate-500">
                      Waiting, active, completed, and failed deploy work.
                    </p>
                  </div>
                  <Link
                    href="/queue"
                    className="inline-flex items-center gap-1 text-sm font-semibold text-red-600 transition-colors hover:text-red-700"
                  >
                    Open queue
                    <ArrowRight size={15} />
                  </Link>
                </div>

                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  {[
                    { label: "Waiting", value: queue.waiting ?? 0 },
                    { label: "Active", value: queue.active ?? 0 },
                    { label: "Completed", value: queue.completed ?? 0 },
                    { label: "Failed", value: queue.failed ?? 0 },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-[1.5rem] bg-slate-50 px-5 py-5"
                    >
                      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        {item.label}
                      </p>
                      <p className="mt-2 text-3xl font-black text-slate-950">
                        {formatCount(item.value)}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-black tracking-tight text-slate-950">
                  Attention now
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Quick triage shortcuts for the highest-value admin actions.
                </p>

                <div className="mt-6 space-y-3">
                  {[
                    {
                      label: "Warning agents",
                      value: metrics?.warningAgents ?? 0,
                      href: "/fleet",
                    },
                    {
                      label: "Error agents",
                      value: metrics?.errorAgents ?? 0,
                      href: "/fleet",
                    },
                    {
                      label: "Stopped agents",
                      value: metrics?.stoppedAgents ?? 0,
                      href: "/fleet",
                    },
                    {
                      label: "DLQ jobs",
                      value: dlqJobs.length,
                      href: "/queue",
                    },
                  ].map((item) => (
                    <Link
                      key={item.label}
                      href={item.href}
                      className="flex items-center justify-between rounded-[1.5rem] border border-slate-200 px-4 py-4 transition-colors hover:border-red-200 hover:bg-red-50/50"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {item.label}
                        </p>
                        <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                          Open relevant admin flow
                        </p>
                      </div>
                      <span className="text-2xl font-black text-slate-950">
                        {formatCount(item.value)}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
              <section className="rounded-[2rem] border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-black tracking-tight text-slate-950">
                      Recent audit events
                    </h2>
                    <p className="mt-1 text-sm font-medium text-slate-500">
                      Latest platform-wide activity recorded by the control plane.
                    </p>
                  </div>
                  <Link
                    href="/audit"
                    className="inline-flex items-center gap-1 text-sm font-semibold text-red-600 transition-colors hover:text-red-700"
                  >
                    View audit
                    <ArrowRight size={15} />
                  </Link>
                </div>

                <div className="mt-4 divide-y divide-slate-100">
                  {events.length === 0 ? (
                    <div className="rounded-[1.5rem] px-4 py-10 text-center text-sm font-medium text-slate-400">
                      No audit events recorded yet.
                    </div>
                  ) : (
                    events.map((event) => <EventRow key={event.id} event={event} />)
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-black tracking-tight text-slate-950">
                      Dead-letter queue
                    </h2>
                    <p className="mt-1 text-sm font-medium text-slate-500">
                      Most recent failed deployment jobs.
                    </p>
                  </div>
                  <Link
                    href="/queue"
                    className="inline-flex items-center gap-1 text-sm font-semibold text-red-600 transition-colors hover:text-red-700"
                  >
                    Inspect jobs
                    <ArrowRight size={15} />
                  </Link>
                </div>

                <div className="mt-5 space-y-3">
                  {dlqJobs.length === 0 ? (
                    <div className="rounded-[1.5rem] bg-emerald-50 px-4 py-5 text-sm font-semibold text-emerald-700">
                      No failed jobs in the DLQ.
                    </div>
                  ) : (
                    dlqJobs.slice(0, 4).map((job) => (
                      <div
                        key={job.id}
                        className="rounded-[1.5rem] border border-slate-200 px-4 py-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">
                              {job.name || "Deploy job"}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {job.failedReason || "No failure reason recorded"}
                            </p>
                          </div>
                          <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-bold text-red-700">
                            {formatCount(job.attemptsMade)} tries
                          </span>
                        </div>
                        <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                          Failed {formatDateTime(job.finishedOn || job.timestamp)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
