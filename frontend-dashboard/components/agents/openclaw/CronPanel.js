import { useState, useEffect } from "react";
import { fetchWithAuth } from "../../../lib/api";
import {
  CalendarClock, Plus, Trash2, RefreshCw, Loader2, Clock, CheckCircle, XCircle,
} from "lucide-react";

export default function CronPanel({ agentId }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: "", schedule: "", message: "" });
  const [creating, setCreating] = useState(false);

  async function fetchJobs() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/cron`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setJobs(Array.isArray(data) ? data : data.jobs || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchJobs();
  }, [agentId]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          schedule: formData.schedule,
          message: formData.message,
        }),
      });
      if (res.ok) {
        setFormData({ name: "", schedule: "", message: "" });
        setShowForm(false);
        await fetchJobs();
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(cronId) {
    try {
      await fetchWithAuth(`/api/agents/${agentId}/gateway/cron/${cronId}`, {
        method: "DELETE",
      });
      setJobs((prev) => prev.filter((j) => (j.id || j.cronId) !== cronId));
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-blue-500" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <CalendarClock size={14} />
          Cron Jobs
          <span className="text-xs font-normal text-slate-400">({jobs.length})</span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchJobs}
            className="text-xs text-slate-500 hover:text-blue-600 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 flex items-center gap-1 font-bold transition-colors"
          >
            <Plus size={12} />
            Add Job
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <div>
            <label className="text-xs font-bold text-slate-600 mb-1 block">Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="Daily summary"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              required
            />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 mb-1 block">Schedule (cron syntax)</label>
            <input
              type="text"
              value={formData.schedule}
              onChange={(e) => setFormData({ ...formData, schedule: e.target.value })}
              placeholder="0 9 * * *"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              required
            />
            <p className="text-[10px] text-slate-400 mt-1">e.g., &quot;0 9 * * *&quot; = every day at 9am, &quot;*/5 * * * *&quot; = every 5 minutes</p>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 mb-1 block">Message / Prompt</label>
            <textarea
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              placeholder="Generate a daily summary report..."
              rows={3}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              required
            />
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-bold flex items-center gap-1 transition-colors"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create
            </button>
          </div>
        </form>
      )}

      {/* Jobs list */}
      {jobs.length === 0 && !error ? (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 text-center">
          <CalendarClock size={24} className="mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-400">No cron jobs configured</p>
          <p className="text-xs text-slate-300 mt-1">
            Schedule recurring tasks for your agent
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job, idx) => {
            const jobId = job.id || job.cronId || idx;
            const jobMsg = job.message || job.payload?.message || "";
            const lastRun = job.last_run || job.lastRun;
            const enabled = job.enabled !== false && job.active !== false;
            return (
              <div
                key={jobId}
                className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <Clock size={14} className="text-slate-400 shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-slate-700">{job.name || "Unnamed"}</p>
                    <p className="text-xs font-mono text-blue-500">
                      {typeof job.schedule === "object"
                        ? (job.schedule.expr || job.schedule.cron || job.schedule.interval || JSON.stringify(job.schedule))
                        : job.schedule}
                    </p>
                    {jobMsg && (
                      <p className="text-[10px] text-slate-400 mt-0.5 max-w-xs truncate">{jobMsg}</p>
                    )}
                    {lastRun && (
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        Last: {new Date(lastRun).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {enabled ? (
                    <CheckCircle size={12} className="text-green-500" />
                  ) : (
                    <XCircle size={12} className="text-slate-300" />
                  )}
                  <button
                    onClick={() => handleDelete(jobId)}
                    className="text-slate-300 hover:text-red-500 transition-colors p-1"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
