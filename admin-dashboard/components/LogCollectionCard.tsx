import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ScrollText, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../lib/api";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";
import { formatBytes, formatCount, formatDateTime } from "../lib/format";
import {
  collectionHeadline,
  describeCollectionError,
  hasCollectedLogs,
  needsKeepOrDelete,
  purgeInProgress,
  type LogCollectionState,
} from "../lib/logCollection";

// Platform-wide switch for collecting agent runtime/gateway logs. Collection
// stores agent output on disk, so it is opt-in. Turning it off while logs exist
// asks what to do with them; the server enforces the same rule.

export default function LogCollectionCard() {
  const { t } = useI18n();
  const toast = useToast();

  const [state, setState] = useState<LogCollectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/api/admin/log-collection");
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(describeCollectionError(payload, response.status));
      setState(payload as LogCollectionState);
    } catch (error: any) {
      toast.error(error?.message || t("Failed to load log collection settings"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a delete is running, follow its progress.
  const deleting = purgeInProgress(state?.purge);
  useEffect(() => {
    if (!deleting) return undefined;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [deleting, load]);

  async function save(body: { enabled: boolean; deleteExisting?: boolean }) {
    setSaving(true);
    try {
      const response = await fetchWithAuth("/api/admin/log-collection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (needsKeepOrDelete(response.status, payload)) {
          // Logs appeared since this page loaded: refresh the numbers and ask.
          await load();
          setAsking(true);
          return;
        }
        throw new Error(describeCollectionError(payload, response.status));
      }
      setAsking(false);
      setConfirmingDelete(false);
      await load();
      if (body.enabled) toast.success(t("Log collection turned on"));
      else if (body.deleteExisting) toast.success(t("Log collection turned off — deleting collected logs"));
      else toast.success(t("Log collection turned off — existing logs kept"));
    } catch (error: any) {
      toast.error(error?.message || t("Save failed"));
    } finally {
      setSaving(false);
    }
  }

  function turnOff() {
    if (hasCollectedLogs(state?.stats)) {
      setAsking(true);
      return;
    }
    save({ enabled: false });
  }

  const headline = collectionHeadline(state);
  const stats = state?.stats;
  const agentsLabel = (count: number) => `${formatCount(count)} ${count === 1 ? t("agent") : t("agents")}`;
  const purge = state?.purge;
  const keyProblem = state?.encryptionKeyProblem;

  const badge =
    headline === "on"
      ? { tone: "border-emerald-200 bg-emerald-50 text-emerald-700", label: t("Collecting") }
      : headline === "off"
        ? { tone: "border-slate-200 bg-slate-50 text-slate-600", label: t("Off") }
        : { tone: "border-amber-200 bg-amber-50 text-amber-700", label: t("Not decided yet — off") };

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <header className="mb-4 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <ScrollText size={22} />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-black tracking-tight text-slate-950">{t("Log Collection")}</h2>
          <p className="text-xs text-slate-500">
            {t(
              "Whether Nora collects agent runtime and gateway logs and stores them encrypted. Off until you turn it on.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label={t("Refresh")}
          className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {loading && !state ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 size={20} className="animate-spin text-slate-300" />
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-1 text-[11px] font-black uppercase tracking-widest ${badge.tone}`}
            >
              {headline === "on" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
              {badge.label}
            </span>
            {state?.source === "env" ? (
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {t("Set in .env (NORA_LOG_ENABLED). Changing it here takes over from .env.")}
              </span>
            ) : null}
            {state?.source === "database" ? (
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {t("Set in this dashboard; .env is ignored.")}
              </span>
            ) : null}
          </div>

          {stats && hasCollectedLogs(stats) ? (
            <p className="mb-4 text-xs font-medium text-slate-600">
              {t("Collected so far")}: {formatCount(stats.lines)} {t("lines")} · {formatBytes(stats.bytes)} ·{" "}
              {agentsLabel(stats.agents)}
              {stats.oldest ? ` · ${t("oldest")} ${formatDateTime(stats.oldest)}` : ""}
            </p>
          ) : null}

          {keyProblem && !state?.enabled ? (
            <p className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {t("Logs cannot be saved yet:")} {keyProblem}{" "}
                {t("Set a 64-character hex NORA_LOG_ENCRYPTION_KEY in .env and restart.")}
              </span>
            </p>
          ) : null}

          {purge && purgeInProgress(purge) ? (
            <p className="mb-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800">
              <Loader2 size={14} className="animate-spin" />
              {t("Deleting collected logs…")} {formatCount(purge.segmentsDeleted || 0)} {t("segments removed so far")}
            </p>
          ) : null}
          {purge && purge.status === "failed" ? (
            <p className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {t("Deleting collected logs failed:")} {purge.error || t("unknown error")}
              </span>
            </p>
          ) : null}
          {purge && purge.status === "completed" && purge.finishedAt ? (
            <p className="mb-4 text-xs font-medium text-slate-500">
              {t("Collected logs were deleted")} {formatDateTime(purge.finishedAt)} (
              {formatCount(purge.segmentsDeleted || 0)} {t("segments")}).
            </p>
          ) : null}

          {asking ? (
            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-bold text-slate-900">
                {t("Turn off log collection. What should happen to the logs already collected?")}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {stats
                  ? `${formatCount(stats.lines)} ${t("lines")} · ${formatBytes(stats.bytes)} · ${agentsLabel(stats.agents)}`
                  : null}
              </p>
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
                <li>{t("Keep: they stay searchable and expire on the normal retention schedule.")}</li>
                <li>
                  {t(
                    "Delete: every agent's collected logs are removed permanently. This cannot be undone, and backups do not contain them.",
                  )}
                </li>
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save({ enabled: false, deleteExisting: false })}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {t("Keep existing logs")}
                </button>
                {confirmingDelete ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => save({ enabled: false, deleteExisting: true })}
                    className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-red-700 disabled:opacity-60"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    {t("Confirm: delete all logs")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirmingDelete(true)}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 shadow-sm hover:bg-red-100 disabled:opacity-60"
                  >
                    <Trash2 size={14} />
                    {t("Delete all logs")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setAsking(false);
                    setConfirmingDelete(false);
                  }}
                  className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500 hover:text-slate-800"
                >
                  {t("Cancel")}
                </button>
              </div>
            </div>
          ) : null}

          {!asking ? (
            <div className="flex flex-wrap items-center gap-2">
              {state?.enabled ? (
                <button
                  type="button"
                  disabled={saving || deleting}
                  onClick={turnOff}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {t("Turn off log collection")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={saving || deleting || Boolean(keyProblem)}
                  onClick={() => save({ enabled: true })}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {t("Turn on log collection")}
                </button>
              )}
              {deleting ? (
                <span className="text-xs text-slate-500">{t("Wait for the deletion to finish before turning it back on.")}</span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
