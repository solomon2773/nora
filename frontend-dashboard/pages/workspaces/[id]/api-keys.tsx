import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { Copy, Key, Loader2, Plus, Trash2, Check, AlertTriangle } from "lucide-react";
import Layout from "../../../components/layout/Layout";
import WorkspaceBackLink from "../../../components/workspaces/WorkspaceBackLink";
import { useToast } from "../../../components/Toast";
import { useI18n } from "../../../lib/i18n";
import {
  type ApiKey,
  type ApiKeyScope,
  createApiKey,
  listApiKeyScopes,
  listApiKeys,
  revokeApiKey,
} from "../../../lib/workspaceClient";

export default function WorkspaceApiKeysPage() {
  const router = useRouter();
  const workspaceId = typeof router.query.id === "string" ? router.query.id : null;
  const { t } = useI18n();
  const toast = useToast();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set(["agents:read"]));
  const [submitting, setSubmitting] = useState(false);
  const [justCreated, setJustCreated] = useState<ApiKey | null>(null);
  const [forbidden, setForbidden] = useState(false);

  async function reload() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [keyRows, scopeRows] = await Promise.all([
        listApiKeys(workspaceId),
        listApiKeyScopes(workspaceId),
      ]);
      setKeys(keyRows);
      setScopes(scopeRows);
      setForbidden(false);
    } catch (err: any) {
      const message = String(err?.message || "");
      if (message.includes("Insufficient") || message.includes("403")) {
        setForbidden(true);
      } else {
        toast.error(message || "Failed to load API keys");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [workspaceId]);

  function toggleScope(scope: string) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !label.trim() || selectedScopes.size === 0) return;
    setSubmitting(true);
    try {
      const created = await createApiKey(workspaceId, {
        label: label.trim(),
        scopes: Array.from(selectedScopes),
      });
      setJustCreated(created);
      setLabel("");
      setSelectedScopes(new Set(["agents:read"]));
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to create API key");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(key: ApiKey) {
    if (!workspaceId) return;
    if (!confirm(`Revoke API key "${key.label}"? Any clients using it will start failing.`)) return;
    try {
      await revokeApiKey(workspaceId, key.id);
      toast.success(t("Revoke") + ": " + key.label);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to revoke");
    }
  }

  function copyToClipboard(value: string, successMessage: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(value)
      .then(() => toast.success(successMessage))
      .catch(() => toast.error("Clipboard unavailable"));
  }

  if (forbidden) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col gap-4 text-slate-500">
          <AlertTriangle size={48} className="text-amber-500" />
          <p className="text-base font-bold">{t("Insufficient permissions")}</p>
        </div>
      </Layout>
    );
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
            <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
              <Key size={28} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">
                {t("API Keys")}
              </h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">
                {workspaceId}
              </span>
            </div>
          </div>
        </header>

        {justCreated?.apiKey && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-[2.5rem] p-8 shadow-sm">
            <div className="flex items-start gap-3">
              <Check size={20} className="text-emerald-600 mt-1" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-black text-slate-900 mb-1">
                  {t("New key created — copy it now")}
                </h3>
                <p className="text-xs text-slate-600 mb-4">
                  {t("This is the only time the full token is shown.")}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-4 py-3 bg-white border border-emerald-200 rounded-xl text-xs font-mono text-slate-900 truncate">
                    {justCreated.apiKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(justCreated.apiKey!, t("Copied to clipboard"))}
                    className="p-3 rounded-xl bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-100"
                  >
                    <Copy size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Issue a new API key")}</h2>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <input
              type="text"
              placeholder={t("Label (e.g. ci-deploy)")}
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              required
            />
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {t("Scopes")}
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {scopes.map((scope) => (
                  <label
                    key={scope.value}
                    className="flex items-start gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 cursor-pointer hover:border-blue-300"
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.has(scope.value)}
                      onChange={() => toggleScope(scope.value)}
                      className="mt-0.5"
                    />
                    <div className="flex flex-col">
                      <code className="text-xs font-bold text-slate-900">{scope.value}</code>
                      <span className="text-[11px] text-slate-500">{scope.description}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting || selectedScopes.size === 0 || !label.trim()}
              className="self-start flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-6 py-3.5 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {t("Create key")}
            </button>
          </form>
        </section>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Active keys")}</h2>
          {loading ? (
            <div className="h-32 flex items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : keys.length === 0 ? (
            <div className="text-sm text-slate-500 py-8 text-center">{t("No API keys yet.")}</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {keys.map((key) => (
                <li key={key.id} className="py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-slate-900 truncate">{key.label}</span>
                      {key.status === "revoked" && (
                        <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md bg-red-50 text-red-700 border border-red-200">
                          {t("Revoked")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <code className="font-mono">{key.maskedKey}</code>
                      <span>·</span>
                      <span>{key.scopes.join(", ")}</span>
                      <span>·</span>
                      <span>
                        {t("Created")} {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                      {key.lastUsedAt && (
                        <>
                          <span>·</span>
                          <span>
                            {t("Last used")} {new Date(key.lastUsedAt).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {key.status === "active" && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(key)}
                      aria-label={t("Revoke")}
                      className="p-2 rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Layout>
  );
}
