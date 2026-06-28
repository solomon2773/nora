import { useState, useEffect, useCallback } from "react";
import { CalendarClock, Plus, Trash2, Loader2, Play, Pause, AlertTriangle } from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const ACTION_TYPES = [
  { value: "prompt", label: "Send a prompt" },
  { value: "restart", label: "Restart agent" },
  { value: "stop", label: "Stop agent" },
  { value: "start", label: "Start agent" },
  { value: "redeploy", label: "Redeploy agent" },
];

const EMPTY_FORM = {
  name: "",
  cron: "0 9 * * *",
  timezone: "UTC",
  action_type: "prompt",
  prompt: "",
};

function fmt(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function SchedulesTab({ agentId }) {
  const toast = useToast();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/schedules`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load");
      const data = await res.json();
      setSchedules(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.message || "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [agentId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function create(event) {
    event.preventDefault();
    if (!form.name.trim() || !form.cron.trim()) {
      toast.error("Name and cron are required");
      return;
    }
    if (form.action_type === "prompt" && !form.prompt.trim()) {
      toast.error("A prompt is required for the prompt action");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        cron: form.cron,
        timezone: form.timezone || "UTC",
        action_type: form.action_type,
        ...(form.action_type === "prompt" ? { prompt: form.prompt } : {}),
      };
      const res = await fetchWithAuth(`/api/agents/${agentId}/schedules`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Create failed");
      toast.success("Schedule created");
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      toast.error(e.message || "Failed to create schedule");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(schedule) {
    setBusyId(schedule.id);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/schedules/${schedule.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Update failed");
      await load();
    } catch (e) {
      toast.error(e.message || "Failed to update schedule");
    } finally {
      setBusyId("");
    }
  }

  async function remove(schedule) {
    if (typeof window !== "undefined" && !window.confirm(`Delete schedule "${schedule.name}"?`)) {
      return;
    }
    setBusyId(schedule.id);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/schedules/${schedule.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
      toast.success("Schedule deleted");
      await load();
    } catch (e) {
      toast.error(e.message || "Failed to delete schedule");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-slate-900">
        <CalendarClock size={18} className="text-blue-600" />
        <h3 className="text-lg font-bold">Scheduled runs</h3>
      </div>
      <p className="text-sm text-slate-500">
        Run a prompt or a lifecycle action on this agent on a recurring cron schedule. Each run is
        recorded in the agent&apos;s events, and prompt runs count toward any budget you&apos;ve
        set.
      </p>

      {/* Create form */}
      <form
        onSubmit={create}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Daily standup summary"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Action</span>
            <select
              value={form.action_type}
              onChange={(e) => update("action_type", e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
            >
              {ACTION_TYPES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Cron (5-field)</span>
            <input
              type="text"
              value={form.cron}
              onChange={(e) => update("cron", e.target.value)}
              placeholder="0 9 * * *"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Timezone</span>
            <input
              type="text"
              value={form.timezone}
              onChange={(e) => update("timezone", e.target.value)}
              placeholder="UTC"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
            />
          </label>
        </div>
        {form.action_type === "prompt" && (
          <label className="mt-4 block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Prompt</span>
            <textarea
              value={form.prompt}
              onChange={(e) => update("prompt", e.target.value)}
              rows={3}
              placeholder="Summarize today's open issues and post the highlights."
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
            />
          </label>
        )}
        <button
          type="submit"
          disabled={saving}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          Add schedule
        </button>
      </form>

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500">
          <Loader2 size={18} className="animate-spin" /> Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No schedules yet. Add one above to run this agent on a cron.
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => (
            <div key={s.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{s.name}</span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                      {ACTION_TYPES.find((a) => a.value === s.action_type)?.label || s.action_type}
                    </span>
                    {s.enabled ? (
                      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                        Enabled
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                        Paused
                      </span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    {s.cron} · {s.timezone}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Next: {s.enabled ? fmt(s.next_run_at) : "—"} · Last: {fmt(s.last_run_at)}
                    {s.last_status && s.last_status !== "success" && (
                      <span className="ml-2 inline-flex items-center gap-1 text-amber-700">
                        <AlertTriangle size={12} /> {s.last_status}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => toggle(s)}
                    disabled={busyId === s.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {busyId === s.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : s.enabled ? (
                      <Pause size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                    {s.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={() => remove(s)}
                    disabled={busyId === s.id}
                    className="rounded-lg border border-red-200 px-2.5 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-60"
                    aria-label="Delete schedule"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
