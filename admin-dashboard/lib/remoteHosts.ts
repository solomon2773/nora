export const REMOTE_DOCKER_GUIDE_URL =
  "https://docs.norafleet.ai/configuration/provisioner-backends/remote-docker";

export const REMOTE_HOST_INPUT_CLASS =
  "w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-brand-cyan focus:bg-white focus:ring-4 focus:ring-brand-cyan/20 disabled:cursor-not-allowed disabled:opacity-60";

export type RemoteHostManagementScope = "platform" | "user";
export type RemoteHostAuthMode = "key" | "password";

export type RemoteHost = {
  id: string;
  label: string;
  executionTargetId?: string | null;
  managementScope?: RemoteHostManagementScope | string | null;
  ownerUserId?: string | null;
  ownerEmail?: string | null;
  ownerName?: string | null;
  createdByUserId?: string | null;
  createdByEmail?: string | null;
  createdByName?: string | null;
  availableToAll?: boolean;
  accessVersion?: number | null;
  enabled?: boolean;
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthMode?: RemoteHostAuthMode | string | null;
  gatewayHost?: string | null;
  hasSshPrivateKey?: boolean;
  hasSshPassword?: boolean;
  hasSshPassphrase?: boolean;
  sshHostKey?: string | null;
  issue?: string | null;
  lastTestStatus?: string | null;
  lastTestMessage?: string | null;
  lastTestedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type RemoteHostFormState = {
  id: string;
  label: string;
  enabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuthMode: RemoteHostAuthMode;
  gatewayHost: string;
  sshPrivateKey: string;
  sshPassword: string;
  sshPassphrase: string;
};

export type AdminUserOption = {
  id: string;
  email: string;
  name?: string | null;
};

export type AdminWorkspaceOption = {
  id: string;
  name: string;
};

export type AdminUserGroupOption = {
  id: string;
  name: string;
  memberCount?: number | null;
  membersVersion?: number | null;
};

export type RemoteHostAccessUser = {
  userId: string;
  email: string;
  name?: string | null;
};

export type RemoteHostAccessGroup = {
  groupId: string;
  name: string;
};

export type RemoteHostAccessWorkspace = {
  workspaceId: string;
  name: string;
};

export type RemoteHostAccess = {
  version: number;
  availableToAll: boolean;
  users: RemoteHostAccessUser[];
  groups: RemoteHostAccessGroup[];
  workspaces: RemoteHostAccessWorkspace[];
};

export const EMPTY_REMOTE_HOST_FORM: RemoteHostFormState = {
  id: "",
  label: "",
  enabled: true,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuthMode: "key",
  gatewayHost: "",
  sshPrivateKey: "",
  sshPassword: "",
  sshPassphrase: "",
};

export function isPlatformRemoteHost(host: RemoteHost | null | undefined) {
  return host?.managementScope === "platform";
}

export function slugifyRemoteHostId(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function updateRemoteHostFormField(
  current: RemoteHostFormState,
  field: keyof RemoteHostFormState,
  value: string | boolean,
) {
  const next = { ...current, [field]: value } as RemoteHostFormState;
  if (field === "label" && !current.id) {
    next.id = slugifyRemoteHostId(String(value));
  }
  if (field === "id") {
    next.id = slugifyRemoteHostId(String(value));
  }
  return next;
}

export function buildRemoteHostForm(host: RemoteHost | null = null): RemoteHostFormState {
  if (!host) return { ...EMPTY_REMOTE_HOST_FORM };
  return {
    ...EMPTY_REMOTE_HOST_FORM,
    id: host.id || "",
    label: host.label || "",
    enabled: host.enabled !== false,
    sshHost: host.sshHost || "",
    sshPort: String(host.sshPort || 22),
    sshUser: host.sshUser || "",
    sshAuthMode: host.sshAuthMode === "password" ? "password" : "key",
    gatewayHost: host.gatewayHost && host.gatewayHost !== host.sshHost ? host.gatewayHost : "",
    // Stored credentials are intentionally never copied into browser form state.
    sshPrivateKey: "",
    sshPassword: "",
    sshPassphrase: "",
  };
}

export function buildRemoteHostPayload(
  form: RemoteHostFormState,
  options: { editing?: boolean } = {},
) {
  const payload: Record<string, unknown> = {
    label: form.label.trim(),
    enabled: form.enabled,
    sshHost: form.sshHost.trim(),
    sshPort: Number.parseInt(form.sshPort, 10) || 22,
    sshUser: form.sshUser.trim(),
    sshAuthMode: form.sshAuthMode,
    gatewayHost: form.gatewayHost.trim(),
  };

  if (!options.editing) payload.id = form.id.trim();
  if (form.sshAuthMode === "password") {
    if (form.sshPassword) payload.sshPassword = form.sshPassword;
  } else {
    if (form.sshPrivateKey) payload.sshPrivateKey = form.sshPrivateKey;
    if (form.sshPassphrase) payload.sshPassphrase = form.sshPassphrase;
  }

  return payload;
}

export function normalizeRemoteHostList(payload: unknown): RemoteHost[] {
  if (Array.isArray(payload)) return payload as RemoteHost[];
  if (Array.isArray((payload as { hosts?: unknown[] })?.hosts)) {
    return (payload as { hosts: RemoteHost[] }).hosts;
  }
  return [];
}

export function normalizeAdminUsers(payload: unknown): AdminUserOption[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { users?: unknown[] })?.users)
      ? (payload as { users: unknown[] }).users
      : [];
  return rows
    .map((entry: any) => ({
      id: String(entry?.id || entry?.userId || ""),
      email: String(entry?.email || entry?.userEmail || ""),
      name: entry?.name ?? entry?.userName ?? null,
    }))
    .filter((entry) => entry.id);
}

export function normalizeAdminWorkspaces(payload: unknown): AdminWorkspaceOption[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { workspaces?: unknown[] })?.workspaces)
      ? (payload as { workspaces: unknown[] }).workspaces
      : [];
  return rows
    .map((entry: any) => ({
      id: String(entry?.id || entry?.workspaceId || ""),
      name: String(entry?.name || entry?.workspaceName || entry?.id || ""),
    }))
    .filter((entry) => entry.id);
}

export function normalizeAdminUserGroups(payload: unknown): AdminUserGroupOption[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { groups?: unknown[] })?.groups)
      ? (payload as { groups: unknown[] }).groups
      : [];
  return rows
    .map((entry: any) => ({
      id: String(entry?.id || entry?.groupId || ""),
      name: String(entry?.name || entry?.groupName || entry?.id || ""),
      memberCount: Number.isFinite(Number(entry?.memberCount ?? entry?.member_count))
        ? Number(entry?.memberCount ?? entry?.member_count)
        : null,
      membersVersion: normalizeVersion(entry?.membersVersion ?? entry?.members_version),
    }))
    .filter((entry) => entry.id);
}

export function normalizeRemoteHostAccess(payload: unknown): RemoteHostAccess {
  const source = (payload || {}) as Record<string, any>;
  return {
    version: normalizeVersion(source.version ?? source.accessVersion),
    availableToAll: source.availableToAll === true,
    users: (Array.isArray(source.users) ? source.users : [])
      .map((entry: any) => ({
        userId: String(typeof entry === "string" ? entry : entry?.userId || entry?.id || ""),
        email: String(typeof entry === "string" ? "" : entry?.email || ""),
        name: typeof entry === "string" ? null : (entry?.name ?? null),
      }))
      .filter((entry: RemoteHostAccessUser) => entry.userId),
    groups: (Array.isArray(source.groups) ? source.groups : [])
      .map((entry: any) => ({
        groupId: String(typeof entry === "string" ? entry : entry?.groupId || entry?.id || ""),
        name: String(typeof entry === "string" ? "" : entry?.name || ""),
      }))
      .filter((entry: RemoteHostAccessGroup) => entry.groupId),
    workspaces: (Array.isArray(source.workspaces) ? source.workspaces : [])
      .map((entry: any) => ({
        workspaceId: String(
          typeof entry === "string" ? entry : entry?.workspaceId || entry?.id || "",
        ),
        name: String(typeof entry === "string" ? "" : entry?.name || ""),
      }))
      .filter((entry: RemoteHostAccessWorkspace) => entry.workspaceId),
  };
}

export function buildRemoteHostAccessPayload(access: RemoteHostAccess) {
  return {
    expectedVersion: access.version,
    availableToAll: access.availableToAll,
    users: access.users.map((entry) => entry.userId),
    groups: access.groups.map((entry) => entry.groupId),
    workspaces: access.workspaces.map((entry) => entry.workspaceId),
  };
}

export function normalizeVersion(value: unknown, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function remoteHostSshTarget(host: RemoteHost, masked = false) {
  if (masked) return "Masked operator credential";
  const user = host.sshUser ? `${host.sshUser}@` : "";
  const port = host.sshPort && host.sshPort !== 22 ? `:${host.sshPort}` : "";
  return `${user}${host.sshHost || "Not configured"}${port}`;
}

export function remoteHostStatus(host: RemoteHost) {
  if (!host.enabled) return { label: "Disabled", className: "bg-slate-100 text-slate-600" };
  if (host.connected && host.available) {
    return { label: "Ready", className: "bg-emerald-100 text-emerald-700" };
  }
  if (host.lastTestStatus === "failed") {
    return { label: "Test failed", className: "bg-red-100 text-red-700" };
  }
  if (!host.configured) {
    return { label: "Needs setup", className: "bg-amber-100 text-amber-800" };
  }
  return { label: "Untested", className: "bg-slate-100 text-slate-600" };
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function responseError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}));
  const message =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : fallback;
  return { message, payload };
}
