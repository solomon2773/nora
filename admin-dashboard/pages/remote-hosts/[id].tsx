import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  Loader2,
  Power,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import DangerConfirmPanel from "../../components/remote-hosts/DangerConfirmPanel";
import RemoteHostAccessPanel from "../../components/remote-hosts/RemoteHostAccessPanel";
import RemoteHostConfigForm from "../../components/remote-hosts/RemoteHostConfigForm";
import RemoteHostsAvailability from "../../components/remote-hosts/RemoteHostsAvailability";
import RemoteHostStatusBadge from "../../components/remote-hosts/RemoteHostStatusBadge";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { useVerifiedPlatformMode } from "../../lib/platform";
import {
  buildRemoteHostAccessPayload,
  buildRemoteHostForm,
  buildRemoteHostPayload,
  errorMessage,
  isPlatformRemoteHost,
  normalizeAdminUserGroups,
  normalizeAdminUsers,
  normalizeAdminWorkspaces,
  normalizeRemoteHostAccess,
  remoteHostSshTarget,
  responseError,
  updateRemoteHostFormField,
  type AdminUserGroupOption,
  type AdminUserOption,
  type AdminWorkspaceOption,
  type RemoteHost,
  type RemoteHostAccess,
  type RemoteHostFormState,
} from "../../lib/remoteHosts";

type TabKey = "overview" | "config" | "access";
type ConfirmAction = "reset" | "delete" | null;
type Translate = ReturnType<typeof useI18n>["t"];

function extractHost(payload: any): RemoteHost | null {
  const host = payload?.host || payload;
  return host && typeof host.id === "string" ? (host as RemoteHost) : null;
}

function accessAvailabilityLabel(host: RemoteHost, t: Translate, detailed = false) {
  if (host.availableToAll === true) {
    return detailed ? t("Available to all accounts") : t("all accounts");
  }
  if (host.availableToAll === false) {
    return detailed ? t("Restricted grants") : t("restricted");
  }
  return detailed ? t("Access state unavailable") : t("access unavailable");
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.25rem] bg-slate-50 px-4 py-4">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-2 break-words text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Server;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-bold transition focus:outline-none focus:ring-4 focus:ring-brand-cyan/20 ${
        active
          ? "bg-brand-ink text-brand-foreground shadow-sm"
          : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

export default function RemoteHostDetailPage() {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const platformMode = useVerifiedPlatformMode();
  const hostId = useMemo(() => String(router.query.id || "").trim(), [router.query.id]);
  const [host, setHost] = useState<RemoteHost | null>(null);
  const [form, setForm] = useState<RemoteHostFormState>(() => buildRemoteHostForm());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmation, setConfirmation] = useState("");
  const [actionError, setActionError] = useState("");

  const [access, setAccess] = useState<RemoteHostAccess | null>(null);
  const accessRef = useRef<RemoteHostAccess | null>(null);
  const accessMutationRef = useRef(false);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
  const [users, setUsers] = useState<AdminUserOption[]>([]);
  const [groups, setGroups] = useState<AdminUserGroupOption[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceOption[]>([]);
  const [accessBusyKeys, setAccessBusyKeys] = useState<Set<string>>(() => new Set());

  const commitAccess = useCallback((next: RemoteHostAccess | null) => {
    accessRef.current = next;
    setAccess(next);
  }, []);

  const loadHost = useCallback(
    async (options: { background?: boolean } = {}) => {
      if (!hostId || platformMode !== "selfhosted") return;
      if (!options.background) setLoading(true);
      try {
        if (!options.background) setActionError("");
        const response = await fetchWithAuth(
          `/api/admin/remote-hosts/${encodeURIComponent(hostId)}`,
        );
        if (response.status === 404) {
          setHost(null);
          setNotFound(true);
          return;
        }
        if (!response.ok) {
          const failure = await responseError(response, t("Failed to load platform host"));
          throw new Error(failure.message);
        }
        const nextHost = extractHost(await response.json().catch(() => ({})));
        if (!nextHost) throw new Error(t("Remote Host response was empty"));
        setHost(nextHost);
        setNotFound(false);
        if (!options.background) setForm(buildRemoteHostForm(nextHost));
      } catch (error) {
        setActionError(errorMessage(error, t("Failed to load platform host")));
      } finally {
        if (!options.background) setLoading(false);
      }
    },
    [hostId, platformMode, t],
  );

  useEffect(() => {
    if (platformMode !== "selfhosted") {
      if (platformMode !== "loading") setLoading(false);
      return;
    }
    void loadHost();
  }, [loadHost, platformMode]);

  const loadAccess = useCallback(
    async (options: { notice?: string } = {}) => {
      if (!hostId || platformMode !== "selfhosted" || !isPlatformRemoteHost(host)) return false;
      setAccessLoading(true);
      setAccessError("");
      setAccessNotice(options.notice || "");
      try {
        const [accessResponse, usersResponse, groupsResponse, workspacesResponse] =
          await Promise.all([
            fetchWithAuth(`/api/admin/remote-hosts/${encodeURIComponent(hostId)}/access`),
            fetchWithAuth("/api/admin/users"),
            fetchWithAuth("/api/admin/user-groups"),
            fetchWithAuth("/api/admin/workspaces"),
          ]);

        const responses = [accessResponse, usersResponse, groupsResponse, workspacesResponse];
        const failure = responses.find((response) => !response.ok);
        if (failure) {
          const parsed = await responseError(failure, t("Failed to load platform access"));
          throw new Error(parsed.message);
        }

        const [accessPayload, usersPayload, groupsPayload, workspacesPayload] = await Promise.all([
          accessResponse.json().catch(() => ({})),
          usersResponse.json().catch(() => []),
          groupsResponse.json().catch(() => []),
          workspacesResponse.json().catch(() => []),
        ]);
        const nextAccess = normalizeRemoteHostAccess(accessPayload);
        commitAccess(nextAccess);
        setHost((current) =>
          current
            ? {
                ...current,
                availableToAll: nextAccess.availableToAll,
                accessVersion: nextAccess.version,
              }
            : current,
        );
        setUsers(normalizeAdminUsers(usersPayload));
        setGroups(normalizeAdminUserGroups(groupsPayload));
        setWorkspaces(normalizeAdminWorkspaces(workspacesPayload));
        setAccessLoaded(true);
        return true;
      } catch (error) {
        setAccessError(errorMessage(error, t("Failed to load platform access")));
        setAccessLoaded(true);
        return false;
      } finally {
        setAccessLoading(false);
      }
    },
    [commitAccess, host, hostId, platformMode, t],
  );

  useEffect(() => {
    if (activeTab === "access" && !accessLoaded && !accessLoading) {
      void loadAccess();
    }
  }, [accessLoaded, accessLoading, activeTab, loadAccess]);

  function updateField(field: keyof RemoteHostFormState, value: string | boolean) {
    setForm((current) => updateRemoteHostFormField(current, field, value));
  }

  async function saveHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!host || !isPlatformRemoteHost(host) || platformMode !== "selfhosted") return;
    setSaving(true);
    setActionError("");
    try {
      const response = await fetchWithAuth(
        `/api/admin/remote-hosts/${encodeURIComponent(host.id)}`,
        {
          method: "PUT",
          body: JSON.stringify(buildRemoteHostPayload(form, { editing: true })),
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, t("Failed to save platform host"));
        throw new Error(failure.message);
      }
      const saved = extractHost(await response.json().catch(() => ({})));
      if (saved) {
        setHost(saved);
        setForm(buildRemoteHostForm(saved));
      } else {
        await loadHost();
      }
      toast.success(t("Platform host configuration saved"));
    } catch (error) {
      const message = errorMessage(error, t("Failed to save platform host"));
      setActionError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (!host || !isPlatformRemoteHost(host) || platformMode !== "selfhosted") return;
    setTesting(true);
    setActionError("");
    try {
      const response = await fetchWithAuth(
        `/api/admin/remote-hosts/${encodeURIComponent(host.id)}/test`,
        { method: "POST" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || t("Remote Host connection test failed"));
      }
      if (payload?.lastTestStatus === "failed") {
        throw new Error(payload?.lastTestMessage || t("Remote Host connection test failed"));
      }
      toast.success(t("SSH and Docker test passed; the host key is pinned"));
      await loadHost();
    } catch (error) {
      const message = errorMessage(error, t("Remote Host connection test failed"));
      setActionError(message);
      toast.error(message);
      await loadHost({ background: true });
    } finally {
      setTesting(false);
    }
  }

  async function toggleEnabled() {
    if (!host || !isPlatformRemoteHost(host) || platformMode !== "selfhosted") return;
    setToggling(true);
    setActionError("");
    try {
      const response = await fetchWithAuth(
        `/api/admin/remote-hosts/${encodeURIComponent(host.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled: host.enabled === false }),
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, t("Failed to update platform host"));
        throw new Error(failure.message);
      }
      toast.success(
        host.enabled === false ? t("Platform host enabled") : t("Platform host disabled"),
      );
      await loadHost();
    } catch (error) {
      const message = errorMessage(error, t("Failed to update platform host"));
      setActionError(message);
      toast.error(message);
    } finally {
      setToggling(false);
    }
  }

  function openConfirmation(action: Exclude<ConfirmAction, null>) {
    setConfirmation("");
    setConfirmAction(action);
    setActionError("");
  }

  async function resetSshPin() {
    if (!host || !isPlatformRemoteHost(host) || platformMode !== "selfhosted") return;
    setResetting(true);
    setActionError("");
    try {
      const response = await fetchWithAuth(
        `/api/admin/remote-hosts/${encodeURIComponent(host.id)}/reset-host-key`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation: confirmation.trim() }),
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, t("Failed to reset SSH pin"));
        throw new Error(failure.message);
      }
      setConfirmAction(null);
      setConfirmation("");
      toast.success(t("SSH pin cleared. Test connection to trust the replacement host key."));
      await loadHost();
    } catch (error) {
      const message = errorMessage(error, t("Failed to reset SSH pin"));
      setActionError(message);
      toast.error(message);
    } finally {
      setResetting(false);
    }
  }

  async function deleteHost() {
    if (!host || !isPlatformRemoteHost(host) || platformMode !== "selfhosted") return;
    setDeleting(true);
    setActionError("");
    try {
      const response = await fetchWithAuth(
        `/api/admin/remote-hosts/${encodeURIComponent(host.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const failure = await responseError(response, t("Failed to delete platform host"));
        const prefix = response.status === 409 ? t("Delete conflict: ") : "";
        throw new Error(`${prefix}${failure.message}`);
      }
      toast.success(t("Platform host deleted"));
      await router.push("/remote-hosts");
    } catch (error) {
      const message = errorMessage(error, t("Failed to delete platform host"));
      setActionError(message);
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  }

  async function saveAccessUpdate(next: RemoteHostAccess, busyKey: string) {
    if (!host || platformMode !== "selfhosted" || accessMutationRef.current) return;
    const before = accessRef.current;
    if (!before) return;
    if (!Number.isSafeInteger(before.version) || before.version < 1) {
      setAccessError(t("Access version is unavailable. Reload platform access before saving."));
      return;
    }
    accessMutationRef.current = true;
    commitAccess(next);
    setHost((current) => (current ? { ...current, availableToAll: next.availableToAll } : current));
    setAccessBusyKeys(new Set([busyKey]));
    setAccessError("");
    setAccessNotice("");

    try {
      const response = await fetchWithAuth(
        `/api/admin/remote-hosts/${encodeURIComponent(host.id)}/access`,
        {
          method: "PUT",
          body: JSON.stringify(buildRemoteHostAccessPayload(next)),
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, t("Failed to update platform access"));
        if (response.status === 409) {
          const conflictMessage = t(
            "Another administrator saved a newer access policy. The latest grants were reloaded; review them before trying again.",
          );
          const reloaded = await loadAccess({ notice: conflictMessage });
          if (!reloaded) {
            commitAccess(null);
            setHost((current) => (current ? { ...current, availableToAll: undefined } : current));
          }
          toast.error(failure.message || conflictMessage);
          return;
        }
        throw new Error(failure.message);
      }
      const saved = normalizeRemoteHostAccess(await response.json().catch(() => ({})));
      commitAccess(saved);
      setHost((current) =>
        current
          ? {
              ...current,
              availableToAll: saved.availableToAll,
              accessVersion: saved.version,
            }
          : current,
      );
      toast.success(t("Platform access updated"));
    } catch (error) {
      commitAccess(before);
      setHost((current) =>
        current ? { ...current, availableToAll: before.availableToAll } : current,
      );
      const message = errorMessage(error, t("Failed to update platform access"));
      setAccessError(message);
      toast.error(message);
    } finally {
      accessMutationRef.current = false;
      setAccessBusyKeys(new Set());
    }
  }

  function toggleAllAccounts(enabled: boolean) {
    const current = accessRef.current;
    if (!current) return;
    void saveAccessUpdate({ ...current, availableToAll: enabled }, "all");
  }

  function toggleUser(user: AdminUserOption, enabled: boolean) {
    const current = accessRef.current;
    if (!current) return;
    const usersNext = enabled
      ? [
          ...current.users.filter((entry) => entry.userId !== user.id),
          { userId: user.id, email: user.email, name: user.name },
        ]
      : current.users.filter((entry) => entry.userId !== user.id);
    void saveAccessUpdate({ ...current, users: usersNext }, `user:${user.id}`);
  }

  function toggleGroup(group: AdminUserGroupOption, enabled: boolean) {
    const current = accessRef.current;
    if (!current) return;
    const groupsNext = enabled
      ? [
          ...current.groups.filter((entry) => entry.groupId !== group.id),
          { groupId: group.id, name: group.name },
        ]
      : current.groups.filter((entry) => entry.groupId !== group.id);
    void saveAccessUpdate({ ...current, groups: groupsNext }, `group:${group.id}`);
  }

  function toggleWorkspace(workspace: AdminWorkspaceOption, enabled: boolean) {
    const current = accessRef.current;
    if (!current) return;
    const workspacesNext = enabled
      ? [
          ...current.workspaces.filter((entry) => entry.workspaceId !== workspace.id),
          { workspaceId: workspace.id, name: workspace.name },
        ]
      : current.workspaces.filter((entry) => entry.workspaceId !== workspace.id);
    void saveAccessUpdate({ ...current, workspaces: workspacesNext }, `workspace:${workspace.id}`);
  }

  if (platformMode !== "selfhosted") {
    return (
      <AdminLayout>
        <RemoteHostsAvailability mode={platformMode} />
      </AdminLayout>
    );
  }

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex h-80 items-center justify-center rounded-[2rem] border border-slate-200 bg-white text-sm font-semibold text-slate-500 shadow-sm">
          <Loader2 size={22} className="mr-2 animate-spin text-brand-ink" />
          {t("Loading platform host…")}
        </div>
      </AdminLayout>
    );
  }

  if (notFound || !host) {
    return (
      <AdminLayout>
        <div className="flex h-80 flex-col items-center justify-center rounded-[2rem] border border-slate-200 bg-white px-5 text-center shadow-sm">
          <p className="text-lg font-black text-slate-950">{t("Remote Host not found")}</p>
          {actionError ? (
            <p className="mt-2 text-sm font-medium text-red-700">{actionError}</p>
          ) : null}
          <Link
            href="/remote-hosts"
            className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-brand-cyan px-4 py-2.5 text-sm font-black text-brand-ink"
          >
            <ArrowLeft size={15} />
            {t("Back to Remote Hosts")}
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const platformHost = isPlatformRemoteHost(host);
  const authLabel = host.sshAuthMode === "password" ? t("SSH password") : t("SSH private key");
  const gatewayLabel = platformHost
    ? host.gatewayHost || host.sshHost || t("Not configured")
    : t("Masked operator credential");

  if (!platformHost) {
    return (
      <AdminLayout>
        <div className="space-y-6">
          <Link
            href="/remote-hosts"
            className="inline-flex items-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft size={15} />
            {t("Back to Remote Hosts")}
          </Link>
          <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-600">
              <UserRound size={23} />
            </span>
            <h1 className="mt-5 text-2xl font-black tracking-tight text-slate-950">{host.label}</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
              {t(
                "This is a personal / operator-managed host. Admin oversight is read-only, endpoint values stay masked, and credential or access mutations are unavailable.",
              )}
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <InfoRow label={t("Host id")} value={host.id} />
              <InfoRow label={t("Management")} value={t("Personal / operator managed")} />
              <InfoRow
                label={t("Owner")}
                value={
                  host.ownerName || host.ownerEmail || host.ownerUserId || t("Operator account")
                }
              />
              <InfoRow label={t("SSH target")} value={t("Masked operator credential")} />
              <InfoRow label={t("Gateway")} value={t("Masked operator credential")} />
              <InfoRow
                label={t("Created")}
                value={host.createdAt ? formatDateTime(host.createdAt) : t("Unknown")}
              />
            </div>
          </section>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-7">
        <Link
          href="/remote-hosts"
          className="inline-flex items-center gap-2 text-sm font-bold text-slate-500 transition hover:text-slate-800 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20"
        >
          <ArrowLeft size={15} />
          {t("Back to Remote Hosts")}
        </Link>

        <header className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-ink/55">
              {t("Platform host")}
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">{host.label}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <RemoteHostStatusBadge host={host} />
              <span className="rounded-full bg-brand-cyan/15 px-3 py-1 text-xs font-bold text-brand-ink">
                {host.executionTargetId || `remote:${host.id}`}
              </span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                {accessAvailabilityLabel(host, t)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadHost()}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20"
            >
              <RefreshCw size={15} />
              {t("Refresh")}
            </button>
            <button
              type="button"
              onClick={() => void toggleEnabled()}
              disabled={toggling}
              className={`inline-flex items-center gap-2 rounded-2xl border bg-white px-4 py-3 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-brand-cyan/20 disabled:opacity-60 ${
                host.enabled === false
                  ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                  : "border-slate-200 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {toggling ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
              {host.enabled === false ? t("Enable host") : t("Disable host")}
            </button>
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testing}
              className="inline-flex items-center gap-2 rounded-2xl bg-brand-cyan px-4 py-3 text-sm font-black text-brand-ink hover:bg-brand-cyan/80 focus:outline-none focus:ring-4 focus:ring-brand-cyan/30 disabled:opacity-60"
            >
              {testing ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <CheckCircle2 size={15} />
              )}
              {t("Test connection")}
            </button>
            <button
              type="button"
              onClick={() => openConfirmation("reset")}
              className="inline-flex items-center gap-2 rounded-2xl border border-amber-200 bg-white px-4 py-3 text-sm font-bold text-amber-800 hover:bg-amber-50 focus:outline-none focus:ring-4 focus:ring-amber-100"
            >
              <KeyRound size={15} />
              {t("Reset SSH pin")}
            </button>
            <button
              type="button"
              onClick={() => openConfirmation("delete")}
              className="inline-flex items-center gap-2 rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm font-bold text-red-700 hover:bg-red-50 focus:outline-none focus:ring-4 focus:ring-red-100"
            >
              <Trash2 size={15} />
              {t("Delete host")}
            </button>
          </div>
        </header>

        {actionError ? (
          <div
            role="alert"
            className="rounded-[1.5rem] border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800"
          >
            {actionError}
          </div>
        ) : null}

        {confirmAction === "reset" ? (
          <DangerConfirmPanel
            title={t("Reset the pinned SSH host key?")}
            description={t(
              "Nora will refuse future Remote Docker operations until Test connection succeeds and pins the replacement key. Verify the host change out of band first.",
            )}
            expectedValues={[host.label, host.id]}
            value={confirmation}
            onChange={setConfirmation}
            onCancel={() => setConfirmAction(null)}
            onConfirm={() => void resetSshPin()}
            busy={resetting}
            confirmLabel={t("Confirm reset")}
          />
        ) : null}

        {confirmAction === "delete" ? (
          <DangerConfirmPanel
            title={t("Delete this platform host?")}
            description={t(
              "The registry row and its access grants will be removed. Active agents can block deletion; Nora will surface that conflict instead of silently orphaning them.",
            )}
            expectedValues={[host.label, host.id]}
            value={confirmation}
            onChange={setConfirmation}
            onCancel={() => setConfirmAction(null)}
            onConfirm={() => void deleteHost()}
            busy={deleting}
            confirmLabel={t("Confirm deletion")}
            danger
          />
        ) : null}

        <div className="flex flex-wrap gap-3" role="tablist" aria-label={t("Platform host detail")}>
          <TabButton
            active={activeTab === "overview"}
            icon={Server}
            label={t("Overview")}
            onClick={() => setActiveTab("overview")}
          />
          <TabButton
            active={activeTab === "config"}
            icon={Settings2}
            label={t("Configuration")}
            onClick={() => setActiveTab("config")}
          />
          <TabButton
            active={activeTab === "access"}
            icon={ShieldCheck}
            label={t("Platform access")}
            onClick={() => setActiveTab("access")}
          />
        </div>

        {activeTab === "overview" ? (
          <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
            <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-black tracking-tight text-slate-950">
                {t("Host overview")}
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {t("Last-known endpoint, trust, availability, and registration state.")}
              </p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <InfoRow label={t("Host id")} value={host.id} />
                <InfoRow
                  label={t("Execution target")}
                  value={host.executionTargetId || `remote:${host.id}`}
                />
                <InfoRow label={t("SSH target")} value={remoteHostSshTarget(host)} />
                <InfoRow label={t("Gateway")} value={gatewayLabel} />
                <InfoRow label={t("Authentication")} value={authLabel} />
                <InfoRow
                  label={t("SSH host key")}
                  value={host.sshHostKey ? t("Pinned") : t("Not pinned — run Test connection")}
                />
                <InfoRow
                  label={t("Last tested")}
                  value={host.lastTestedAt ? formatDateTime(host.lastTestedAt) : t("Never")}
                />
                <InfoRow
                  label={t("Updated")}
                  value={host.updatedAt ? formatDateTime(host.updatedAt) : t("Unknown")}
                />
              </div>
              {host.issue ? (
                <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
                  {host.issue}
                </div>
              ) : null}
              {host.lastTestStatus === "failed" && host.lastTestMessage ? (
                <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800">
                  {host.lastTestMessage}
                </div>
              ) : null}
            </section>

            <section className="rounded-[2rem] border border-brand-cyan/15 bg-brand-ink p-5 text-brand-foreground shadow-sm sm:p-6">
              <h2 className="text-lg font-black">{t("Platform ownership")}</h2>
              <p className="mt-1 text-sm font-medium text-brand-foreground/60">
                {t("Admin-created target with centrally managed credentials and access grants.")}
              </p>
              <dl className="mt-6 space-y-4">
                <div className="rounded-2xl bg-brand-cyan/10 px-4 py-4">
                  <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-brand-cyan/70">
                    {t("Created by")}
                  </dt>
                  <dd className="mt-2 text-sm font-bold">
                    {host.createdByName ||
                      host.createdByEmail ||
                      host.createdByUserId ||
                      t("Platform administrator")}
                  </dd>
                </div>
                <div className="rounded-2xl bg-brand-cyan/10 px-4 py-4">
                  <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-brand-cyan/70">
                    {t("Account availability")}
                  </dt>
                  <dd className="mt-2 text-sm font-bold">
                    {accessAvailabilityLabel(host, t, true)}
                  </dd>
                </div>
                <div className="rounded-2xl bg-brand-cyan/10 px-4 py-4">
                  <dt className="text-[10px] font-black uppercase tracking-[0.16em] text-brand-cyan/70">
                    {t("Registered")}
                  </dt>
                  <dd className="mt-2 text-sm font-bold">
                    {host.createdAt ? formatDateTime(host.createdAt) : t("Unknown")}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        ) : null}

        {activeTab === "config" ? (
          <RemoteHostConfigForm
            form={form}
            editing
            host={host}
            saving={saving}
            credentialsAllowed={platformMode === "selfhosted"}
            submitLabel={t("Save configuration")}
            onFieldChange={updateField}
            onSubmit={saveHost}
          />
        ) : null}

        {activeTab === "access" ? (
          <section aria-labelledby="platform-access-heading">
            <h2 id="platform-access-heading" className="sr-only">
              {t("Platform access")}
            </h2>
            <RemoteHostAccessPanel
              access={access}
              users={users}
              groups={groups}
              workspaces={workspaces}
              loading={accessLoading}
              error={accessError}
              notice={accessNotice}
              busyKeys={accessBusyKeys}
              onRetry={() => void loadAccess()}
              onToggleAll={toggleAllAccounts}
              onToggleUser={toggleUser}
              onToggleGroup={toggleGroup}
              onToggleWorkspace={toggleWorkspace}
            />
          </section>
        ) : null}
      </div>
    </AdminLayout>
  );
}
