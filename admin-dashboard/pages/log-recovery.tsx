import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  History,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { fetchWithAuth } from "../lib/api";
import { formatCount, formatDateTime, formatShortId } from "../lib/format";

// Phase 5c of the logging control plane: an agent or workspace deleted with
// "keep logs" leaves a `deleted_log_owners` row behind — this page is the
// only operator-facing way back to that data (view, export) and the only
// way to finally reclaim its storage (purge). See
// workers/provisioner/logs/logDeletion.ts's module header for what the
// underlying read/export endpoints are (and are not) — a real, minimal
// reader that a later phase's search/export machinery is expected to
// replace.

function extractFilename(contentDisposition, fallback) {
  if (!contentDisposition) return fallback;
  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const plainMatch = contentDisposition.match(/filename=([^;]+)/i);
  if (plainMatch?.[1]) return plainMatch[1].trim();
  return fallback;
}

function KindBadge({ kind }) {
  const tone = kind === "workspace" ? "bg-violet-50 text-violet-700" : "bg-blue-50 text-blue-700";
  return (
    <span className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] ${tone}`}>
      {kind}
    </span>
  );
}

function LogLineRow({ line }) {
  const ts = line.ts || line.observed_ts;
  return (
    <div className="grid grid-cols-[auto_auto_auto_1fr] items-baseline gap-3 border-b border-slate-100 px-3 py-2 text-xs last:border-0">
      <span className="font-mono text-slate-400">{formatDateTime(ts)}</span>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 font-bold uppercase tracking-wide text-slate-500">
        {line.stream || "—"}
      </span>
      <span className="rounded-full bg-slate-950 px-2 py-0.5 font-bold uppercase tracking-wide text-slate-100">
        {line.level || "—"}
      </span>
      <span className="min-w-0 truncate font-mono text-slate-700" title={line.message}>
        {line.message}
      </span>
    </div>
  );
}

function RecoveryEntry({ entry, onPurged }) {
  const [expanded, setExpanded] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [lines, setLines] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  const loadLogs = useCallback(
    async ({ cursor = null, replace = false } = {}) => {
      setLoadingLogs(true);
      setLogsError("");
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (cursor) params.set("cursor", cursor);
        const response = await fetchWithAuth(
          `/api/admin/log-recovery/${entry.id}/logs?${params.toString()}`,
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || "Failed to load logs");
        setLines((current) => (replace ? payload.lines || [] : [...current, ...(payload.lines || [])]));
        setNextCursor(payload.nextCursor || null);
      } catch (error) {
        setLogsError(error.message || "Failed to load logs");
      } finally {
        setLoadingLogs(false);
      }
    },
    [entry.id],
  );

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && lines.length === 0) {
      loadLogs({ replace: true });
    }
  };

  const handleExport = useCallback(
    async (format) => {
      setExporting(true);
      try {
        const response = await fetchWithAuth(
          `/api/admin/log-recovery/${entry.id}/export?format=${format}`,
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error || "Failed to export logs");
        }
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = extractFilename(
          response.headers.get("content-disposition"),
          `nora-log-recovery-${entry.id}.${format}`,
        );
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      } catch (error) {
        setLogsError(error.message || "Failed to export logs");
      } finally {
        setExporting(false);
      }
    },
    [entry.id],
  );

  const handlePurge = useCallback(async () => {
    setPurging(true);
    try {
      const response = await fetchWithAuth(`/api/admin/log-recovery/${entry.id}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Failed to purge logs");
      onPurged(entry.id);
    } catch (error) {
      setLogsError(error.message || "Failed to purge logs");
      setPurging(false);
    }
  }, [entry.id, onPurged]);

  return (
    <div className="rounded-[1.5rem] border border-slate-100 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {expanded ? (
            <ChevronUp size={16} className="shrink-0 text-slate-400" />
          ) : (
            <ChevronDown size={16} className="shrink-0 text-slate-400" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={entry.kind} />
              <p className="truncate text-sm font-semibold text-slate-950">
                {entry.display_name || formatShortId(entry.source_id, 12)}
              </p>
            </div>
            <p className="mt-1 text-xs font-medium text-slate-500">
              Deleted {formatDateTime(entry.deleted_at)} · kept {formatCount(entry.retention_days)} day
              {entry.retention_days === 1 ? "" : "s"} · id {formatShortId(entry.source_id, 12)}
            </p>
          </div>
        </button>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            onClick={() => handleExport("ndjson")}
            disabled={exporting}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition-all hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            NDJSON
          </button>
          <button
            onClick={() => handleExport("csv")}
            disabled={exporting}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition-all hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            CSV
          </button>
          {confirmingPurge ? (
            <>
              <button
                onClick={handlePurge}
                disabled={purging}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {purging ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Confirm purge
              </button>
              <button
                onClick={() => setConfirmingPurge(false)}
                disabled={purging}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmingPurge(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 shadow-sm transition-all hover:bg-red-100"
            >
              <Trash2 size={14} />
              Purge
            </button>
          )}
        </div>
      </div>

      {expanded ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-slate-100">
          {logsError ? (
            <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-3 py-3 text-xs font-semibold text-red-700">
              <AlertTriangle size={14} />
              {logsError}
            </div>
          ) : null}
          {lines.length === 0 && !loadingLogs ? (
            <p className="px-3 py-4 text-xs font-medium text-slate-400">
              No log lines recovered for this entry (they may already be expired or purged).
            </p>
          ) : (
            <div className="max-h-96 overflow-auto">
              {lines.map((line, index) => (
                <LogLineRow key={`${entry.id}-${index}`} line={line} />
              ))}
            </div>
          )}
          <div className="flex items-center justify-center border-t border-slate-100 bg-slate-50 px-3 py-2">
            {loadingLogs ? (
              <Loader2 size={14} className="animate-spin text-slate-400" />
            ) : nextCursor ? (
              <button
                onClick={() => loadLogs({ cursor: nextCursor })}
                className="text-xs font-semibold text-slate-600 hover:text-slate-950"
              >
                Load more
              </button>
            ) : (
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-300">
                End of recovered logs
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function LogRecoveryPage() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const loadEntries = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const response = await fetchWithAuth("/api/admin/log-recovery");
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Failed to load recovery entries");
      setEntries(Array.isArray(payload?.entries) ? payload.entries : []);
    } catch (loadError) {
      console.error("Failed to load log-recovery entries:", loadError);
      setError(loadError.message || "Failed to load recovery entries");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handlePurged = useCallback((id) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Deletion & Recovery
            </p>
            <h1 className="mt-2 flex items-center gap-3 text-3xl font-black tracking-tight text-slate-950">
              <History size={28} className="text-slate-400" />
              Log recovery
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              Logs kept when an agent or workspace was deleted with "keep logs" chosen. View or
              export what was kept, or purge an entry to permanently reclaim its storage — there is
              no way back once purged.
            </p>
          </div>

          <button
            onClick={() => loadEntries({ silent: true })}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={16} className={loading || refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          {error ? (
            <div className="mb-4 flex items-center gap-2 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-slate-300" />
            </div>
          ) : entries.length === 0 ? (
            <p className="py-16 text-center text-sm font-medium text-slate-400">
              Nothing kept right now — every deleted agent/workspace either had logs deleted
              outright, or its kept entry has already been purged or fully expired.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {entries.map((entry) => (
                <RecoveryEntry key={entry.id} entry={entry} onPurged={handlePurged} />
              ))}
            </div>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}
