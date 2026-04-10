import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import MetricCard from "../components/MetricCard";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatCount, formatDateTime } from "../lib/format";

function formatJobPayload(data) {
  try {
    return JSON.stringify(data || {}, null, 2);
  } catch {
    return "{}";
  }
}

export default function QueuePage() {
  const [metrics, setMetrics] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [loading, setLoading] = useState(true);
  const [retryLoadingId, setRetryLoadingId] = useState("");
  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      const [statsRes, jobsRes] = await Promise.all([
        fetchWithAuth("/api/admin/stats"),
        fetchWithAuth("/api/admin/dlq"),
      ]);

      if (statsRes.ok) {
        setMetrics(await statsRes.json());
      }
      if (jobsRes.ok) {
        const payload = await jobsRes.json();
        const nextJobs = Array.isArray(payload) ? payload : [];
        setJobs(nextJobs);
        setSelectedJobId((current) => {
          if (current && nextJobs.some((job) => job.id === current)) {
            return current;
          }
          return nextJobs[0]?.id || "";
        });
      }
    } catch (error) {
      console.error("Failed to load queue view:", error);
      toast.error(error.message || "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    const intervalId = setInterval(loadData, 30000);
    return () => clearInterval(intervalId);
  }, [loadData]);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) || null;
  const queue = metrics?.queue || {};

  async function retryJob(jobId) {
    setRetryLoadingId(jobId);
    try {
      const response = await fetchWithAuth(`/api/admin/dlq/${jobId}/retry`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to retry job");
      }

      toast.success("Job requeued");
      loadData();
    } catch (error) {
      console.error("Failed to retry DLQ job:", error);
      toast.error(error.message || "Failed to retry job");
    } finally {
      setRetryLoadingId("");
    }
  }

  const cards = [
    {
      label: "Waiting",
      value: formatCount(queue.waiting ?? 0),
      icon: Clock3,
      tone: "blue",
      caption: "Queued deploy jobs",
    },
    {
      label: "Active",
      value: formatCount(queue.active ?? 0),
      icon: RefreshCw,
      tone: "purple",
      caption: "Currently processing",
    },
    {
      label: "Completed",
      value: formatCount(queue.completed ?? 0),
      icon: CheckCircle2,
      tone: "emerald",
      caption: "Finished deployments",
    },
    {
      label: "Failed / DLQ",
      value: formatCount(jobs.length),
      icon: TriangleAlert,
      tone: jobs.length > 0 ? "red" : "orange",
      caption: "Jobs needing retry or inspection",
    },
  ];

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Queue Admin
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Deployment queue and DLQ
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Inspect queue pressure, review failed jobs, and retry dead-lettered
              deployments without leaving the admin surface.
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

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <MetricCard key={card.label} {...card} />
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
          <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black tracking-tight text-slate-950">
                  Dead-letter jobs
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Most recent failed deploy jobs retained for operator recovery.
                </p>
              </div>
            </div>

            <div className="mt-6">
              {loading ? (
                <div className="flex h-56 items-center justify-center">
                  <Loader2 size={28} className="animate-spin text-red-500" />
                </div>
              ) : jobs.length === 0 ? (
                <div className="flex h-56 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
                  <CheckCircle2 size={34} className="mb-3 text-emerald-500" />
                  <p className="text-sm font-semibold">DLQ is empty.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {jobs.map((job) => {
                    const active = job.id === selectedJobId;
                    return (
                      <button
                        key={job.id}
                        onClick={() => setSelectedJobId(job.id)}
                        className={`w-full rounded-[1.5rem] border px-4 py-4 text-left transition-colors ${
                          active
                            ? "border-red-200 bg-red-50/60"
                            : "border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-950">
                              {job.name || "Deploy job"}
                            </p>
                            <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                              {job.failedReason || "No failure reason recorded"}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-white">
                            {formatCount(job.attemptsMade)} tries
                          </span>
                        </div>
                        <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                          Failed {formatDateTime(job.finishedOn || job.timestamp)}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black tracking-tight text-slate-950">
                  Job detail
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Inspect payloads and retry failed work from the DLQ.
                </p>
              </div>
              {selectedJob ? (
                <button
                  onClick={() => retryJob(selectedJob.id)}
                  disabled={retryLoadingId === selectedJob.id}
                  className="inline-flex items-center gap-2 rounded-2xl border border-red-100 px-4 py-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {retryLoadingId === selectedJob.id ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <RotateCcw size={15} />
                  )}
                  Retry job
                </button>
              ) : null}
            </div>

            {!selectedJob ? (
              <div className="mt-6 flex h-56 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
                <AlertTriangle size={34} className="mb-3 opacity-60" />
                <p className="text-sm font-semibold">
                  Select a DLQ job to inspect it.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-[1.5rem] bg-slate-50 px-4 py-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Job Name
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {selectedJob.name || "Deploy job"}
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] bg-slate-50 px-4 py-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Attempts
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {formatCount(selectedJob.attemptsMade)}
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] bg-slate-50 px-4 py-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Created
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {formatDateTime(selectedJob.timestamp)}
                    </p>
                  </div>
                  <div className="rounded-[1.5rem] bg-slate-50 px-4 py-4">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Failed
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {formatDateTime(selectedJob.finishedOn)}
                    </p>
                  </div>
                </div>

                <div className="rounded-[1.5rem] border border-red-100 bg-red-50/60 px-4 py-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-red-500">
                    Failure Reason
                  </p>
                  <p className="mt-2 text-sm font-semibold text-red-900">
                    {selectedJob.failedReason || "No failure reason recorded"}
                  </p>
                </div>

                <div className="rounded-[1.5rem] border border-slate-200 bg-slate-950">
                  <div className="border-b border-slate-800 px-4 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                    Job Payload
                  </div>
                  <pre className="max-h-[420px] overflow-auto p-4 text-xs leading-relaxed text-slate-200">
                    {formatJobPayload(selectedJob.data)}
                  </pre>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </AdminLayout>
  );
}
