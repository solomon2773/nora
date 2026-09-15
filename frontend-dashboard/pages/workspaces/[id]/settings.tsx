import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/router";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  DollarSign,
  Key,
  Loader2,
  Save,
  ScrollText,
  Settings as SettingsIcon,
} from "lucide-react";
import Layout from "../../../components/layout/Layout";
import { useToast } from "../../../components/Toast";
import { useI18n } from "../../../lib/i18n";
import {
  type WorkspaceLogSettings,
  getWorkspaceLogSettings,
  updateWorkspaceLogSettings,
} from "../../../lib/workspaceClient";

// Tracing requires the OpenClaw `diagnostics-otel` plugin, which in turn
// requires OpenClaw's own plugin API >=2026.9.3 -- newer than the version
// every Nora-managed agent ships with today, and there is no supported,
// safe way to change an agent's OpenClaw version yet (manually running
// `openclaw update` is confirmed unreliable and can corrupt the agent or
// break its provider auth). This copy is deliberately NOT an instruction to
// go update anything -- under Nora's current feature set, no agent can
// legitimately reach a supported version, so telling operators to try would
// just be steering them into a known-broken workaround. The PER-AGENT
// status still lives in the Traces lens (a fact about that agent's own
// install), this note is just the workspace-level context for why the
// toggle above may not visibly do anything yet.
const TRACING_CAPABILITY_NOTE =
  "Tracing isn't available yet on Nora's default OpenClaw version. Enabling this is safe, but you won't see traces yet. No action needed.";

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const workspaceId = typeof router.query.id === "string" ? router.query.id : null;
  const { t } = useI18n();
  const toast = useToast();

  const [settings, setSettings] = useState<WorkspaceLogSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [gatewayLogsEnabled, setGatewayLogsEnabled] = useState(true);
  const [tracesEnabled, setTracesEnabled] = useState(false);
  const [runtimeRetentionDays, setRuntimeRetentionDays] = useState(30);
  const [matchTraceRetention, setMatchTraceRetention] = useState(true);
  const [traceRetentionDays, setTraceRetentionDays] = useState(30);

  async function load() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const result = await getWorkspaceLogSettings(workspaceId);
      setSettings(result);
      setGatewayLogsEnabled(result.gatewayLogsEnabled);
      setTracesEnabled(result.tracesEnabled);
      setRuntimeRetentionDays(result.runtimeRetentionDays);
      setTraceRetentionDays(result.traceRetentionDays);
      setMatchTraceRetention(result.traceRetentionDays === result.runtimeRetentionDays);
    } catch (err: any) {
      toast.error(err?.message || t("Failed to load logging settings"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId) return;
    setSaving(true);
    try {
      const effectiveTraceRetentionDays = matchTraceRetention
        ? runtimeRetentionDays
        : traceRetentionDays;
      const result = await updateWorkspaceLogSettings(workspaceId, {
        gatewayLogsEnabled,
        tracesEnabled,
        runtimeRetentionDays,
        traceRetentionDays: effectiveTraceRetentionDays,
      });
      setSettings(result);
      setTraceRetentionDays(result.traceRetentionDays);
      toast.success(t("Logging settings saved"));
    } catch (err: any) {
      toast.error(err?.message || t("Save failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
              <SettingsIcon size={28} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">
                {t("Settings")}
              </h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">
                {workspaceId}
              </span>
            </div>
          </div>
        </header>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <ScrollText size={18} />
            </div>
            <div>
              <h2 className="text-sm font-black text-slate-900">{t("Logging & traces")}</h2>
              <p className="text-xs text-slate-500">
                {t("What Nora collects for every agent in this workspace, and for how long.")}
              </p>
            </div>
          </div>
          {loading || !settings ? (
            <div className="h-32 flex items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : (
            <form onSubmit={handleSave} className="flex flex-col gap-6">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={gatewayLogsEnabled}
                  onChange={(e) => setGatewayLogsEnabled(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-bold text-slate-900">
                    {t("Collect runtime & gateway logs")}
                  </span>
                  <span className="block text-xs text-slate-500 mt-0.5">
                    {t("Container stdout/stderr and gateway RPC activity for every agent in this workspace.")}
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={tracesEnabled}
                  onChange={(e) => setTracesEnabled(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-bold text-slate-900">
                    {t("Enable tracing")}
                  </span>
                  <span className="block text-xs text-slate-500 mt-0.5">
                    {t("Per-turn OpenTelemetry spans: model calls, timing, and token usage, viewable in each agent's Traces tab.")}
                  </span>
                </span>
              </label>

              <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed">{t(TRACING_CAPABILITY_NOTE)}</p>
              </div>

              <div className="h-px bg-slate-100" />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                    {t("Log retention (days)")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={runtimeRetentionDays}
                    onChange={(e) => setRuntimeRetentionDays(Math.max(1, Number(e.target.value) || 1))}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-300"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                    {t("Trace retention (days)")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={matchTraceRetention ? runtimeRetentionDays : traceRetentionDays}
                    onChange={(e) => setTraceRetentionDays(Math.max(1, Number(e.target.value) || 1))}
                    disabled={matchTraceRetention}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                <input
                  type="checkbox"
                  checked={matchTraceRetention}
                  onChange={(e) => setMatchTraceRetention(e.target.checked)}
                />
                {t("Keep trace retention matched to log retention")}
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {t("Save logging settings")}
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="mb-4 text-sm font-black text-slate-900">{t("More settings")}</h2>
          <div className="flex flex-col divide-y divide-slate-100">
            <SettingsLink
              href={`/workspaces/${workspaceId}/api-keys`}
              icon={<Key size={18} />}
              label={t("API Keys")}
              description={t("Manage programmatic access to this workspace.")}
            />
            <SettingsLink
              href={`/workspaces/${workspaceId}/alerts`}
              icon={<Bell size={18} />}
              label={t("Alert rules")}
              description={t("Webhook notifications for agent and budget events.")}
            />
            <SettingsLink
              href={`/workspaces/${workspaceId}/cost`}
              icon={<DollarSign size={18} />}
              label={t("Cost dashboard")}
              description={t("Spend by agent and provider, budgets and alerts.")}
            />
          </div>
        </section>
      </div>
    </Layout>
  );
}

function SettingsLink({
  href,
  icon,
  label,
  description,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  description: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="flex w-full items-center gap-3 py-4 text-left first:pt-0 last:pb-0"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-slate-900">{label}</div>
        <div className="text-xs text-slate-500">{description}</div>
      </div>
      <ArrowRight size={16} className="shrink-0 text-slate-300" />
    </button>
  );
}
