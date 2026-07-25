import { Loader2, RefreshCw, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import type {
  AdminUserGroupOption,
  AdminUserOption,
  AdminWorkspaceOption,
  RemoteHostAccess,
} from "../../lib/remoteHosts";

type Props = {
  access: RemoteHostAccess | null;
  users: AdminUserOption[];
  groups: AdminUserGroupOption[];
  workspaces: AdminWorkspaceOption[];
  loading: boolean;
  error: string;
  notice: string;
  busyKeys: Set<string>;
  onRetry: () => void;
  onToggleAll: (enabled: boolean) => void;
  onToggleUser: (user: AdminUserOption, enabled: boolean) => void;
  onToggleGroup: (group: AdminUserGroupOption, enabled: boolean) => void;
  onToggleWorkspace: (workspace: AdminWorkspaceOption, enabled: boolean) => void;
};

function AccessRow({
  label,
  description,
  checked,
  busy,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 transition ${
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-white"
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-slate-900">{label}</span>
        {description ? (
          <span className="mt-0.5 block truncate text-xs font-medium text-slate-500">
            {description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {busy ? <Loader2 size={15} className="animate-spin text-brand-ink" /> : null}
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="h-5 w-5 rounded border-slate-300 accent-brand-cyan focus:ring-brand-cyan disabled:opacity-60"
        />
      </span>
    </label>
  );
}

function DirectorySection({
  title,
  description,
  empty,
  children,
}: {
  title: string;
  description: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-base font-black text-slate-950">{title}</h3>
      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">{description}</p>
      {empty ? (
        <p className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-medium text-slate-500">
          No entries available.
        </p>
      ) : (
        <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1">{children}</div>
      )}
    </section>
  );
}

export default function RemoteHostAccessPanel({
  access,
  users,
  groups,
  workspaces,
  loading,
  error,
  notice,
  busyKeys,
  onRetry,
  onToggleAll,
  onToggleUser,
  onToggleGroup,
  onToggleWorkspace,
}: Props) {
  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-[2rem] border border-slate-200 bg-white text-sm font-semibold text-slate-500 shadow-sm">
        <Loader2 size={20} className="mr-2 animate-spin text-brand-ink" />
        Loading platform access…
      </div>
    );
  }

  if (!access || error) {
    return (
      <div className="rounded-[2rem] border border-red-200 bg-red-50 p-6 text-red-900">
        <p className="font-black">Platform access could not be loaded</p>
        <p className="mt-2 text-sm font-medium">{error || "The access response was empty."}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-red-300 bg-white px-4 py-2.5 text-sm font-bold text-red-800 hover:bg-red-100"
        >
          <RefreshCw size={15} />
          Retry access load
        </button>
      </div>
    );
  }

  const selectedUsers = new Set(access.users.map((entry) => entry.userId));
  const selectedGroups = new Set(access.groups.map((entry) => entry.groupId));
  const selectedWorkspaces = new Set(access.workspaces.map((entry) => entry.workspaceId));
  const locked = busyKeys.size > 0;

  return (
    <div className="space-y-5">
      {notice ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[1.5rem] border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900"
        >
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-amber-700" />
          <div>
            <p className="font-black">Platform access changed elsewhere</p>
            <p className="mt-1 font-medium">{notice}</p>
          </div>
        </div>
      ) : null}

      <section className="rounded-[2rem] border border-brand-cyan/35 bg-brand-ink p-5 text-brand-foreground shadow-sm sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-cyan/15 text-brand-cyan">
              <ShieldCheck size={20} />
            </span>
            <div>
              <h2 className="text-lg font-black">Available to all accounts</h2>
              <p className="mt-1 max-w-2xl text-sm font-medium leading-relaxed text-brand-foreground/65">
                When enabled, every account can select this platform host. Direct users, groups, and
                workspaces remain saved for use if broad access is disabled later.
              </p>
            </div>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-3 self-start rounded-2xl border border-brand-cyan/20 bg-brand-cyan/10 px-4 py-3 text-sm font-bold sm:self-center">
            {busyKeys.has("all") ? (
              <Loader2 size={16} className="animate-spin text-brand-cyan" />
            ) : null}
            <input
              type="checkbox"
              checked={access.availableToAll}
              disabled={locked}
              onChange={(event) => onToggleAll(event.target.checked)}
              className="h-5 w-5 accent-brand-cyan focus:ring-brand-cyan disabled:opacity-60"
            />
            {access.availableToAll ? "All accounts enabled" : "Restricted access"}
          </label>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        <DirectorySection
          title="Direct users"
          description="Grant named accounts direct access without requiring workspace membership."
          empty={users.length === 0}
        >
          {users.map((user) => (
            <AccessRow
              key={user.id}
              label={user.name || user.email || user.id}
              description={user.name ? user.email : user.id}
              checked={selectedUsers.has(user.id)}
              busy={busyKeys.has(`user:${user.id}`)}
              disabled={locked}
              onChange={(enabled) => onToggleUser(user, enabled)}
            />
          ))}
        </DirectorySection>

        <DirectorySection
          title="User groups"
          description="Grant reusable platform groups access to this host."
          empty={groups.length === 0}
        >
          {groups.map((group) => (
            <AccessRow
              key={group.id}
              label={group.name}
              description={
                group.memberCount == null
                  ? group.id
                  : `${group.memberCount} member${group.memberCount === 1 ? "" : "s"}`
              }
              checked={selectedGroups.has(group.id)}
              busy={busyKeys.has(`group:${group.id}`)}
              disabled={locked}
              onChange={(enabled) => onToggleGroup(group, enabled)}
            />
          ))}
        </DirectorySection>

        <DirectorySection
          title="Workspaces"
          description="Workspace members use their existing role to see or deploy to the host."
          empty={workspaces.length === 0}
        >
          {workspaces.map((workspace) => (
            <AccessRow
              key={workspace.id}
              label={workspace.name}
              description={workspace.id}
              checked={selectedWorkspaces.has(workspace.id)}
              busy={busyKeys.has(`workspace:${workspace.id}`)}
              disabled={locked}
              onChange={(enabled) => onToggleWorkspace(workspace, enabled)}
            />
          ))}
        </DirectorySection>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-brand-cyan/30 bg-brand-cyan/10 p-4 text-sm font-medium text-brand-ink">
        <Users size={18} className="mt-0.5 shrink-0" />
        <p>
          Access is grant-based. Workspace viewers can discover a shared host, while deployment
          remains governed by the backend workspace role policy.
        </p>
      </div>
    </div>
  );
}
