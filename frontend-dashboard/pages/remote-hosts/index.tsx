import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import Layout from "../../components/layout/Layout";
import {
  Server,
  Plus,
  RefreshCw,
  Trash2,
  Loader2,
  PlugZap,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Share2,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { partitionRemoteHosts, remoteHostAccessSource } from "../../lib/remoteHosts";
import { useToast } from "../../components/Toast";

const EMPTY_FORM = {
  id: "",
  label: "",
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuthMode: "key",
  sshPrivateKey: "",
  sshPassphrase: "",
  sshPassword: "",
  gatewayHost: "",
};

function sshTarget(host) {
  const user = host.sshUser ? `${host.sshUser}@` : "";
  const port = host.sshPort && host.sshPort !== 22 ? `:${host.sshPort}` : "";
  return `${user}${host.sshHost || "—"}${port}`;
}

function StatusBadge({ host }) {
  if (!host.enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
        Disabled
      </span>
    );
  }
  if (host.connected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
        <CheckCircle2 size={12} /> SSH + Docker tested
      </span>
    );
  }
  if (!host.configured) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
        <AlertTriangle size={12} /> Needs setup
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
      <XCircle size={12} /> Untested
    </span>
  );
}

export default function RemoteHostsPage() {
  const toast = useToast();
  const [hosts, setHosts] = useState<any[]>([]);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [sharesByHost, setSharesByHost] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [pinResetHostId, setPinResetHostId] = useState("");
  const [pinResetConfirmation, setPinResetConfirmation] = useState("");
  const [pinResetBusyId, setPinResetBusyId] = useState("");
  const [sharePanelId, setSharePanelId] = useState("");
  const [shareSelection, setShareSelection] = useState("");
  const [platformMode, setPlatformMode] = useState<string | null>(null);
  // Host id whose share/unshare request is in flight (""=none), so a slow
  // request on one host never disables another host's controls.
  const [shareBusyId, setShareBusyId] = useState("");
  // Monotonic token bumped by every shares write (eager load + add/remove). An
  // in-flight eager load checks it before committing, so a slow load can't
  // clobber a share/unshare the operator made while it was running.
  const shareSeq = useRef(0);

  const editing = Boolean(editingId);

  const loadHosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/remote-hosts");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load");
      const data = await res.json();
      setHosts(Array.isArray(data) ? data : []);
      // Render the host inventory as soon as it is available. Workspace-share
      // badges can hydrate independently instead of holding the whole page on
      // one slow per-host request.
      setLoading(false);
      // Eager-load each owned host's workspace shares so the "Shared with N"
      // indicator is accurate without expanding every panel. Shared-with-me
      // hosts have no owner-only shares endpoint, so we skip them.
      const owned = partitionRemoteHosts(Array.isArray(data) ? data : []).owned;
      const startSeq = ++shareSeq.current;
      const entries = await Promise.all(
        owned.map(async (h): Promise<[string, any[]]> => {
          try {
            const r = await fetchWithAuth(`/api/remote-hosts/${encodeURIComponent(h.id)}/shares`);
            const shares = r.ok ? await r.json().catch(() => []) : [];
            return [h.id, Array.isArray(shares) ? shares : []];
          } catch {
            return [h.id, []];
          }
        }),
      );
      // A newer eager load or an add/remove bumped the token while we awaited —
      // its fresher data wins; drop this now-stale snapshot. Merge (not replace)
      // so any host not in this batch keeps its existing entry.
      if (shareSeq.current === startSeq) {
        setSharesByHost((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    } catch (error) {
      toast.error(error.message || "Failed to load remote hosts");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetchWithAuth("/api/workspaces");
      if (!res.ok) return;
      const data = await res.json();
      setWorkspaces(Array.isArray(data) ? data : []);
    } catch {
      // Sharing is optional — a workspace fetch failure just hides the picker.
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function loadPage() {
      try {
        const response = await fetch("/api/config/platform");
        if (!response.ok) throw new Error("Platform configuration is unavailable");
        const payload = await response.json().catch(() => ({}));
        const mode =
          typeof payload?.mode === "string" ? payload.mode.trim().toLowerCase() : "unknown";
        if (!active) return;
        setPlatformMode(mode);
        if (mode !== "selfhosted") {
          setLoading(false);
          return;
        }
        await Promise.all([loadHosts(), loadWorkspaces()]);
      } catch {
        if (!active) return;
        setPlatformMode("unknown");
        setLoading(false);
      }
    }

    void loadPage();
    return () => {
      active = false;
    };
  }, [loadHosts, loadWorkspaces]);

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId("");
  }

  function startEdit(host) {
    setEditingId(host.id);
    setForm({
      ...EMPTY_FORM,
      id: host.id,
      label: host.label || "",
      sshHost: host.sshHost || "",
      sshPort: String(host.sshPort || 22),
      sshUser: host.sshUser || "",
      sshAuthMode: host.sshAuthMode || "key",
      gatewayHost: host.gatewayHost && host.gatewayHost !== host.sshHost ? host.gatewayHost : "",
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveHost(event) {
    event.preventDefault();
    if (!form.sshHost.trim() || !form.sshUser.trim()) {
      toast.error("SSH host and username are required");
      return;
    }
    setSaving(true);
    try {
      // On edit, blank secret fields are preserved server-side, so we only send
      // what the operator actually typed.
      const payload: Record<string, unknown> = {
        label: form.label,
        sshHost: form.sshHost,
        sshPort: Number(form.sshPort) || 22,
        sshUser: form.sshUser,
        sshAuthMode: form.sshAuthMode,
        gatewayHost: form.gatewayHost,
      };
      if (!editing) payload.id = form.id || form.label;
      if (form.sshAuthMode === "password") {
        if (form.sshPassword) payload.sshPassword = form.sshPassword;
      } else {
        if (form.sshPrivateKey) payload.sshPrivateKey = form.sshPrivateKey;
        if (form.sshPassphrase) payload.sshPassphrase = form.sshPassphrase;
      }
      const res = await fetchWithAuth(
        editing ? `/api/remote-hosts/${encodeURIComponent(editingId)}` : "/api/remote-hosts",
        { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) },
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Save failed");
      toast.success(editing ? "Remote host updated" : "Remote host registered");
      resetForm();
      await loadHosts();
    } catch (error) {
      toast.error(error.message || "Failed to save remote host");
    } finally {
      setSaving(false);
    }
  }

  async function testHost(host) {
    setTestingId(host.id);
    try {
      const res = await fetchWithAuth(`/api/remote-hosts/${encodeURIComponent(host.id)}/test`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Test failed");
      if (payload.lastTestStatus === "ok") {
        toast.success("SSH and Docker version check passed; deploy validation is still required");
      } else toast.error(payload.lastTestMessage || "Connection test failed");
      await loadHosts();
    } catch (error) {
      toast.error(error.message || "Connection test failed");
    } finally {
      setTestingId("");
    }
  }

  async function deleteHost(host) {
    if (typeof window !== "undefined" && !window.confirm(`Delete remote host "${host.label}"?`)) {
      return;
    }
    setDeletingId(host.id);
    try {
      const res = await fetchWithAuth(`/api/remote-hosts/${encodeURIComponent(host.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
      toast.success("Remote host deleted");
      if (editingId === host.id) resetForm();
      if (pinResetHostId === host.id) {
        setPinResetHostId("");
        setPinResetConfirmation("");
      }
      await loadHosts();
    } catch (error) {
      toast.error(error.message || "Failed to delete remote host");
    } finally {
      setDeletingId("");
    }
  }

  function togglePinReset(host) {
    setPinResetConfirmation("");
    setPinResetHostId((current) => (current === host.id ? "" : host.id));
  }

  async function resetHostKeyPin(event, host) {
    event.preventDefault();
    const confirmation = pinResetConfirmation.trim();
    if (confirmation !== host.label && confirmation !== host.id) {
      toast.error(`Type "${host.label}" or "${host.id}" to confirm`);
      return;
    }

    setPinResetBusyId(host.id);
    try {
      const res = await fetchWithAuth(
        `/api/remote-hosts/${encodeURIComponent(host.id)}/reset-host-key`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation }),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Failed to reset SSH host-key pin");
      setPinResetHostId("");
      setPinResetConfirmation("");
      toast.success("SSH pin cleared. Run Test to verify and pin the replacement host key.");
      await loadHosts();
    } catch (error) {
      toast.error(error.message || "Failed to reset SSH host-key pin");
    } finally {
      setPinResetBusyId("");
    }
  }

  function toggleSharePanel(host) {
    setShareSelection("");
    setSharePanelId((prev) => (prev === host.id ? "" : host.id));
  }

  async function addShare(host) {
    if (!shareSelection) return;
    setShareBusyId(host.id);
    try {
      const res = await fetchWithAuth(`/api/remote-hosts/${encodeURIComponent(host.id)}/shares`, {
        method: "POST",
        body: JSON.stringify({ workspace_id: shareSelection }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Failed to share host");
      // On a success status with an unexpected (non-array) body, keep the
      // existing shares rather than wiping them to []. Bump the token so an
      // in-flight eager load doesn't overwrite this fresh value.
      shareSeq.current += 1;
      setSharesByHost((prev) => ({
        ...prev,
        [host.id]: Array.isArray(payload) ? payload : prev[host.id] || [],
      }));
      setShareSelection("");
      toast.success("Host shared with workspace");
    } catch (error) {
      toast.error(error.message || "Failed to share host");
    } finally {
      setShareBusyId("");
    }
  }

  async function removeShare(host, workspaceId) {
    setShareBusyId(host.id);
    try {
      const res = await fetchWithAuth(
        `/api/remote-hosts/${encodeURIComponent(host.id)}/shares/${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Failed to remove share");
      shareSeq.current += 1;
      setSharesByHost((prev) => ({
        ...prev,
        [host.id]: Array.isArray(payload) ? payload : prev[host.id] || [],
      }));
      toast.success("Stopped sharing host");
    } catch (error) {
      toast.error(error.message || "Failed to remove share");
    } finally {
      setShareBusyId("");
    }
  }

  if (platformMode === null) {
    return (
      <Layout>
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 py-8 text-slate-600">
          <Loader2 size={18} className="animate-spin text-brand-ink" /> Checking Remote Docker
          availability…
        </div>
      </Layout>
    );
  }

  if (platformMode !== "selfhosted") {
    const hosted = platformMode === "paas";
    return (
      <Layout>
        <div className="mx-auto w-full max-w-3xl px-4 py-10">
          <section className="rounded-3xl border border-brand-cyan/25 bg-white p-8 shadow-sm">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-cyan/20 text-brand-ink">
              <Server size={24} />
            </div>
            <h1 className="mt-5 text-2xl font-black text-brand-ink">
              {hosted ? "Remote Hosts require self-hosted Nora" : "Remote Hosts are unavailable"}
            </h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-slate-600">
              {hosted
                ? "Hosted mode does not accept or use customer SSH credentials. Run Nora on infrastructure you control to register a Remote Docker host."
                : "Nora could not verify this installation's platform mode. Restore the public platform configuration endpoint before managing SSH credentials."}
            </p>
            <a
              href="https://noradocs.solomontsao.com/configuration/provisioner-backends/remote-docker"
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex rounded-xl bg-brand-cyan px-4 py-2.5 text-sm font-black text-brand-ink transition hover:bg-brand-cyan/80 focus:outline-none focus:ring-2 focus:ring-brand-cyan/40"
            >
              Read the Remote Docker guide
            </a>
          </section>
        </div>
      </Layout>
    );
  }

  const { owned: ownedHosts, accessible: sharedHosts } = partitionRemoteHosts(hosts);

  function renderShareSection(host) {
    const shares = sharesByHost[host.id] || [];
    const sharedIds = new Set(shares.map((s) => s.workspaceId));
    const available = workspaces.filter((w) => !sharedIds.has(w.id));
    const busy = shareBusyId === host.id;
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Users size={15} /> Workspace access
        </div>
        {shares.length === 0 ? (
          <p className="text-xs text-slate-500">
            Not shared yet. Members of a workspace you share this host with can deploy agents to it
            using your stored credentials (editors and above) or view it read-only (viewers).
          </p>
        ) : (
          <ul className="space-y-2">
            {shares.map((share) => (
              <li
                key={share.workspaceId}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <span className="truncate text-sm text-slate-700">
                  {share.workspaceName || share.workspaceId}
                </span>
                <button
                  onClick={() => removeShare(host, share.workspaceId)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                  aria-label="Stop sharing with this workspace"
                >
                  <X size={13} /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {workspaces.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            You aren&apos;t a member of any workspace yet.{" "}
            <Link
              href="/workspaces"
              className="font-bold text-brand-ink underline decoration-brand-cyan decoration-2 underline-offset-2"
            >
              Create one
            </Link>{" "}
            to share this host with a team.
          </p>
        ) : available.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">Shared with all of your workspaces.</p>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <select
              value={shareSelection}
              onChange={(e) => setShareSelection(e.target.value)}
              aria-label="Workspace to share this host with"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">Select a workspace…</option>
              {available.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => addShare(host)}
              disabled={busy || !shareSelection}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-cyan px-3 py-2 text-sm font-black text-brand-ink transition hover:bg-brand-cyan/80 disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
              Share
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Layout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-brand-cyan/20 p-2 text-brand-ink">
            <Server size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Remote Hosts</h1>
            <p className="text-sm text-slate-500">
              Register a Linux Docker server, VPS, or cloud VM so Nora can deploy agents to it over
              SSH. Credentials are encrypted at rest.
            </p>
          </div>
        </div>

        <section className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 shrink-0 text-amber-700" size={20} />
            <div>
              <h2 className="text-sm font-black">Private network and deploy validation required</h2>
              <p className="mt-1 text-sm font-medium leading-relaxed text-amber-900/85">
                Remote runtime ports use plain HTTP/WebSocket and bind to <code>0.0.0.0</code> on
                the selected host. Restrict the published port range to Nora over a private
                encrypted network. <strong>Test</strong> only checks that backend-api can run{" "}
                <code>docker version</code> over SSH; its result does not expire and does not verify
                the provisioner worker, gateway routing, readiness, lifecycle, or backups.
              </p>
              <a
                href="https://noradocs.solomontsao.com/configuration/provisioner-backends/remote-docker"
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex text-sm font-black text-brand-ink underline decoration-brand-cyan decoration-2 underline-offset-2"
              >
                Review the security and validation checklist
              </a>
            </div>
          </div>
        </section>

        {/* Add / edit form */}
        <form
          onSubmit={saveHost}
          className="mb-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 className="mb-4 text-lg font-semibold text-slate-900">
            {editing ? `Edit "${form.label || editingId}"` : "Register a remote host"}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Label</span>
              <input
                type="text"
                value={form.label}
                onChange={(e) => updateField("label", e.target.value)}
                placeholder="Build Host"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Gateway address <span className="text-slate-400">(optional)</span>
              </span>
              <input
                type="text"
                value={form.gatewayHost}
                onChange={(e) => updateField("gatewayHost", e.target.value)}
                placeholder="defaults to the SSH host"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">SSH host</span>
              <input
                type="text"
                value={form.sshHost}
                onChange={(e) => updateField("sshHost", e.target.value)}
                placeholder="192.168.1.50 or host.example.com"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label className="col-span-1 block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.sshPort}
                  onChange={(e) => updateField("sshPort", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
                />
              </label>
              <label className="col-span-2 block">
                <span className="mb-1 block text-sm font-medium text-slate-700">SSH user</span>
                <input
                  type="text"
                  value={form.sshUser}
                  onChange={(e) => updateField("sshUser", e.target.value)}
                  placeholder="operator"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Authentication</span>
              <select
                value={form.sshAuthMode}
                onChange={(e) => updateField("sshAuthMode", e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
              >
                <option value="key">SSH private key</option>
                <option value="password">Password</option>
              </select>
            </label>
          </div>

          {form.sshAuthMode === "password" ? (
            <label className="mt-4 block">
              <span className="mb-1 block text-sm font-medium text-slate-700">SSH password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={form.sshPassword}
                onChange={(e) => updateField("sshPassword", e.target.value)}
                placeholder={editing ? "Leave blank to keep the stored password" : ""}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
              />
            </label>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  SSH private key
                </span>
                <textarea
                  value={form.sshPrivateKey}
                  onChange={(e) => updateField("sshPrivateKey", e.target.value)}
                  rows={5}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    editing
                      ? "Leave blank to keep the stored key"
                      : "-----BEGIN OPENSSH PRIVATE KEY-----"
                  }
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 font-mono text-xs"
                />
              </label>
              <label className="block max-w-sm">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Key passphrase <span className="text-slate-400">(optional)</span>
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={form.sshPassphrase}
                  onChange={(e) => updateField("sshPassphrase", e.target.value)}
                  placeholder={editing ? "Leave blank to keep" : ""}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
                />
              </label>
            </div>
          )}

          <div className="mt-5 flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-cyan px-5 py-2.5 text-sm font-black text-brand-ink transition hover:bg-brand-cyan/80 focus:outline-none focus:ring-2 focus:ring-brand-cyan/40 disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {editing ? "Save changes" : "Register host"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={resetForm}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        {/* Host list */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Your hosts</h2>
          <button
            type="button"
            onClick={loadHosts}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {loading ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500"
          >
            <Loader2 size={18} className="animate-spin" /> Loading remote hosts…
          </div>
        ) : ownedHosts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No remote hosts yet. Register one above to deploy agents to your own machine.
          </div>
        ) : (
          <div className="space-y-3">
            {ownedHosts.map((host) => {
              const shareCount = (sharesByHost[host.id] || []).length;
              const pinResetOpen = pinResetHostId === host.id;
              const pinResetConfirmed =
                pinResetConfirmation.trim() === host.label ||
                pinResetConfirmation.trim() === host.id;
              return (
                <div
                  key={host.id}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{host.label}</span>
                        <StatusBadge host={host} />
                        {shareCount > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-brand-cyan/15 px-2.5 py-0.5 text-xs font-bold text-brand-ink">
                            <Users size={12} /> Shared · {shareCount}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        {sshTarget(host)} · {host.executionTargetId}
                      </p>
                      {host.lastTestStatus === "failed" && host.lastTestMessage && (
                        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                          {host.lastTestMessage}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => testHost(host)}
                        disabled={testingId === host.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {testingId === host.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <PlugZap size={14} />
                        )}
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSharePanel(host)}
                        aria-expanded={sharePanelId === host.id}
                        aria-controls={`remote-host-shares-${host.id}`}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
                          sharePanelId === host.id
                            ? "border-brand-cyan/40 bg-brand-cyan/15 text-brand-ink"
                            : "border-slate-200 text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        <Share2 size={14} /> Share
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(host)}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Edit
                      </button>
                      {host.sshHostKey && (
                        <button
                          type="button"
                          onClick={() => togglePinReset(host)}
                          disabled={pinResetBusyId === host.id}
                          aria-expanded={pinResetOpen}
                          aria-controls={`remote-host-pin-reset-${host.id}`}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition disabled:opacity-60 ${
                            pinResetOpen
                              ? "border-red-300 bg-red-50 text-red-700"
                              : "border-amber-300 text-amber-800 hover:bg-amber-50"
                          }`}
                        >
                          <ShieldAlert size={14} /> Reset SSH pin
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => deleteHost(host)}
                        disabled={deletingId === host.id}
                        className="rounded-lg border border-red-200 px-2.5 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-60"
                        aria-label="Delete host"
                      >
                        {deletingId === host.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                  {pinResetOpen && (
                    <form
                      id={`remote-host-pin-reset-${host.id}`}
                      onSubmit={(event) => resetHostKeyPin(event, host)}
                      className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4"
                    >
                      <div className="flex items-start gap-3">
                        <ShieldAlert className="mt-0.5 shrink-0 text-red-700" size={20} />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-black text-red-950">
                            Verify the replacement host before resetting trust
                          </h3>
                          <p className="mt-1 text-sm font-medium leading-relaxed text-red-900/85">
                            Use this only after independently confirming that this machine was
                            intentionally rebuilt or its SSH host key was rotated. Nora will remove
                            the pinned key and previous Test result, but will not change stored SSH
                            credentials. Deployments and active use stay blocked until you run Test
                            successfully and Nora pins the new key.
                          </p>
                          <label className="mt-3 block max-w-xl">
                            <span className="block text-xs font-bold text-red-900">
                              Type <code>{host.label}</code> or <code>{host.id}</code> to confirm
                            </span>
                            <input
                              type="text"
                              value={pinResetConfirmation}
                              onChange={(event) => setPinResetConfirmation(event.target.value)}
                              autoComplete="off"
                              autoFocus
                              className="mt-1.5 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200"
                            />
                          </label>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="submit"
                              disabled={!pinResetConfirmed || pinResetBusyId === host.id}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-black text-white transition hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {pinResetBusyId === host.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <ShieldAlert size={14} />
                              )}
                              Clear pin and require Test
                            </button>
                            <button
                              type="button"
                              onClick={() => togglePinReset(host)}
                              disabled={pinResetBusyId === host.id}
                              className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-100 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>
                  )}
                  {sharePanelId === host.id ? (
                    <div id={`remote-host-shares-${host.id}`}>{renderShareSection(host)}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* Hosts granted by the platform, a user group, direct access, or a workspace (read-only). */}
        {sharedHosts.length > 0 && (
          <>
            <div className="mb-3 mt-8 flex items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">Shared with you</h2>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                platform and team access
              </span>
            </div>
            <div className="space-y-3">
              {sharedHosts.map((host) => (
                <div
                  key={host.id}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{host.label}</span>
                        <StatusBadge host={host} />
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-cyan/15 px-2.5 py-0.5 text-xs font-bold text-brand-ink">
                          <Users size={12} /> Shared
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        {sshTarget(host)} · {host.executionTargetId}
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        {host.canDeploy
                          ? `You can deploy agents to this host using its stored credentials (${remoteHostAccessSource(host)}).`
                          : `Read-only access ${remoteHostAccessSource(host)} — ask an authorized editor, platform admin, or the host owner to deploy.`}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
