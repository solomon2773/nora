import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { Bell, Loader2, Plus, Send, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";
import Layout from "../../../components/layout/Layout";
import WorkspaceBackLink from "../../../components/workspaces/WorkspaceBackLink";
import { useToast } from "../../../components/Toast";
import { useI18n } from "../../../lib/i18n";
import {
  type AlertChannel,
  type AlertRule,
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  testAlertRule,
  updateAlertRule,
} from "../../../lib/workspaceClient";

const PATTERN_HINTS = [
  "agent.error",
  "agent.warning",
  "agent.*",
  "workspace.budget_exceeded",
  "workspace.budget_soft_exceeded",
  "*",
];

export default function WorkspaceAlertsPage() {
  const router = useRouter();
  const workspaceId = typeof router.query.id === "string" ? router.query.id : null;
  const { t } = useI18n();
  const toast = useToast();

  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("agent.*");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  async function reload() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setRules(await listAlertRules(workspaceId));
    } catch (err: any) {
      toast.error(err?.message || "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [workspaceId]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !name.trim() || !pattern.trim() || !webhookUrl.trim()) return;
    setSubmitting(true);
    try {
      const channels: AlertChannel[] = [{ type: "webhook", url: webhookUrl.trim() }];
      await createAlertRule(workspaceId, {
        name: name.trim(),
        eventPattern: pattern.trim(),
        channels,
      });
      setName("");
      setPattern("agent.*");
      setWebhookUrl("");
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to create alert");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(rule: AlertRule) {
    if (!workspaceId) return;
    try {
      await updateAlertRule(workspaceId, rule.id, { enabled: !rule.enabled });
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to update");
    }
  }

  async function handleDelete(rule: AlertRule) {
    if (!workspaceId) return;
    if (!confirm(`Delete alert rule "${rule.name}"?`)) return;
    try {
      await deleteAlertRule(workspaceId, rule.id);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete");
    }
  }

  async function handleTest(rule: AlertRule) {
    if (!workspaceId) return;
    setTesting(rule.id);
    try {
      await testAlertRule(workspaceId, rule.id);
      toast.success(`Test alert sent for "${rule.name}"`);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Test failed");
    } finally {
      setTesting(null);
    }
  }

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <WorkspaceBackLink
          href={workspaceId ? `/workspaces/${workspaceId}/settings` : "/workspaces"}
          label="Back to workspace settings"
        />
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-amber-50 border border-amber-100 rounded-2xl flex items-center justify-center text-amber-600 shadow-sm">
              <Bell size={28} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">
                {t("Alert rules")}
              </h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">
                {workspaceId}
              </span>
            </div>
          </div>
        </header>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Create alert rule")}</h2>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <input
              type="text"
              placeholder={t("Rule name (e.g. Slack on errors)")}
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <input
              type="text"
              placeholder={t("Event pattern (e.g. agent.* or workspace.budget_exceeded)")}
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-mono text-slate-900 outline-none"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              list="pattern-hints"
              required
            />
            <datalist id="pattern-hints">
              {PATTERN_HINTS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <input
              type="url"
              placeholder={t("Webhook URL (Slack/Discord/Teams/PagerDuty…)")}
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-mono text-slate-900 outline-none"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              required
            />
            <button
              type="submit"
              disabled={submitting || !name.trim() || !pattern.trim() || !webhookUrl.trim()}
              className="self-start flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-6 py-3.5 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {t("Create alert rule")}
            </button>
          </form>
        </section>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Active rules")}</h2>
          {loading ? (
            <div className="h-32 flex items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : rules.length === 0 ? (
            <div className="text-sm text-slate-500 py-8 text-center">
              {t("No alert rules yet.")}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rules.map((rule) => (
                <li key={rule.id} className="py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-slate-900 truncate">{rule.name}</span>
                      {!rule.enabled && (
                        <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md bg-slate-100 text-slate-500">
                          {t("Disabled")}
                        </span>
                      )}
                      {rule.lastError && (
                        <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md bg-red-50 text-red-700 border border-red-200">
                          <AlertCircle size={10} className="inline mr-1" />
                          {t("Last delivery failed")}
                        </span>
                      )}
                      {rule.lastFiredAt && !rule.lastError && (
                        <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 size={10} className="inline mr-1" />
                          {t("Delivered")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <code className="font-mono">{rule.eventPattern}</code>
                      <span>·</span>
                      <span>{rule.channels.length} channel(s)</span>
                      {rule.lastFiredAt && (
                        <>
                          <span>·</span>
                          <span>
                            {t("Last fired")} {new Date(rule.lastFiredAt).toLocaleString()}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTest(rule)}
                      disabled={testing === rule.id}
                      aria-label={t("Test fire")}
                      className="p-2 rounded-xl text-slate-500 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50"
                    >
                      {testing === rule.id ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Send size={16} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggle(rule)}
                      className="text-xs font-bold px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700"
                    >
                      {rule.enabled ? t("Disable") : t("Enable")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(rule)}
                      aria-label={t("Delete")}
                      className="p-2 rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Layout>
  );
}
