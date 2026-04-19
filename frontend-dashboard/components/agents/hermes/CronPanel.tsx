import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";
import { useToast } from "../../Toast";

function formatTimestamp(value) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export default function HermesCronPanel({ agentId }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    schedule: "",
    prompt: "",
  });
  const toast = useToast();

  async function loadJobs() {
    setLoading(true);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load Hermes cron jobs");
      }

      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch (nextError) {
      setError(nextError.message || "Failed to load Hermes cron jobs");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
  }, [agentId]);

  async function handleCreate(event) {
    event.preventDefault();
    setCreating(true);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to create Hermes cron job");
      }

      toast.success("Cron job created");
      setFormData({ name: "", schedule: "", prompt: "" });
      setShowForm(false);
      await loadJobs();
    } catch (nextError) {
      const message = nextError.message || "Failed to create Hermes cron job";
      setError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(jobId) {
    if (!jobId) return;
    setDeletingId(jobId);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/cron/${jobId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete Hermes cron job");
      }

      setJobs((current) => current.filter((job) => String(job.id) !== String(jobId)));
      toast.success("Cron job deleted");
    } catch (nextError) {
      const message = nextError.message || "Failed to delete Hermes cron job";
      setError(message);
      toast.error(message);
    } finally {
      setDeletingId("");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
            Hermes Cron
          </p>
          <p className="mt-1 text-sm font-bold text-slate-900">
            Schedule prompts and recurring work directly through Hermes.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Jobs are stored inside the Hermes runtime and surfaced here through the runtime API.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadJobs}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
          <button
            onClick={() => setShowForm((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700"
          >
            <Plus size={12} />
            Add Job
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-bold text-rose-800">Cron request failed</p>
            <p className="mt-1 text-xs text-rose-700">{error}</p>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <form
          onSubmit={handleCreate}
          className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(event) =>
                  setFormData((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Daily summary"
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-600">
                Schedule (cron syntax)
              </label>
              <input
                type="text"
                value={formData.schedule}
                onChange={(event) =>
                  setFormData((current) => ({
                    ...current,
                    schedule: event.target.value,
                  }))
                }
                placeholder="0 9 * * *"
                required
                className="w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold text-slate-600">Prompt</label>
            <textarea
              value={formData.prompt}
              onChange={(event) =>
                setFormData((current) => ({ ...current, prompt: event.target.value }))
              }
              placeholder="Generate a daily summary of the last 24 hours."
              rows={4}
              required
              className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>

          <p className="text-[11px] text-slate-500">
            Example: <span className="font-mono">0 9 * * *</span> runs every day at 09:00.
          </p>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create Job
            </button>
          </div>
        </form>
      ) : null}

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
          <CalendarClock size={24} className="mx-auto text-slate-300" />
          <p className="mt-3 text-sm font-bold text-slate-600">No cron jobs configured</p>
          <p className="mt-1 text-xs text-slate-500">
            Add a recurring prompt to let Hermes run scheduled tasks.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const jobId = String(job?.id || "");
            const schedule =
              typeof job?.schedule === "string"
                ? job.schedule
                : job?.schedule?.cron || job?.schedule?.expr || "Unknown";
            const prompt = job?.prompt || job?.message || "";
            const lastRun =
              job?.last_run ||
              job?.lastRun ||
              job?.last_run_at ||
              job?.lastRunAt ||
              null;
            const nextRun =
              job?.next_run ||
              job?.nextRun ||
              job?.next_run_at ||
              job?.nextRunAt ||
              null;
            const enabled = job?.enabled !== false;

            return (
              <div
                key={jobId}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Clock3 size={14} className="text-slate-400" />
                      <p className="text-sm font-bold text-slate-900">
                        {job?.name || "Unnamed job"}
                      </p>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${
                          enabled
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {enabled ? "Enabled" : "Paused"}
                      </span>
                    </div>
                    <p className="mt-2 font-mono text-xs text-blue-600">{schedule}</p>
                    {prompt ? (
                      <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-slate-600">
                        {prompt}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      {job?.deliver ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1">
                          deliver: {job.deliver}
                        </span>
                      ) : null}
                      {lastRun ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1">
                          last: {formatTimestamp(lastRun)}
                        </span>
                      ) : null}
                      {nextRun ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1">
                          next: {formatTimestamp(nextRun)}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {enabled ? (
                      <CheckCircle2 size={14} className="text-emerald-500" />
                    ) : null}
                    <button
                      onClick={() => handleDelete(jobId)}
                      disabled={deletingId === jobId}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                    >
                      {deletingId === jobId ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
