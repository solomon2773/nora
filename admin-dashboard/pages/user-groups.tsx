import { useCallback, useDeferredValue, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import {
  errorMessage,
  normalizeAdminUsers,
  responseError,
  type AdminUserOption,
} from "../lib/remoteHosts";
import {
  normalizeUserGroupMembers,
  normalizeUserGroups,
  type AdminUserGroup,
} from "../lib/userGroups";

const INPUT_CLASS =
  "w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-950 outline-none transition focus:border-brand-cyan focus:bg-white focus:ring-4 focus:ring-brand-cyan/20";

function matchesGroup(group: AdminUserGroup, search: string) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [group.name, group.id].some((value) => String(value).toLowerCase().includes(needle));
}

export default function UserGroupsPage() {
  const toast = useToast();
  const [groups, setGroups] = useState<AdminUserGroup[]>([]);
  const [users, setUsers] = useState<AdminUserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [membersLoadingId, setMembersLoadingId] = useState("");
  const [membersSavingId, setMembersSavingId] = useState("");
  const [memberDrafts, setMemberDrafts] = useState<Record<string, Set<string>>>({});
  const [memberVersions, setMemberVersions] = useState<Record<string, number>>({});
  const [loadedMemberGroups, setLoadedMemberGroups] = useState<Set<string>>(() => new Set());
  const [pageError, setPageError] = useState("");
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});
  const [groupNotices, setGroupNotices] = useState<Record<string, string>>({});

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const [groupsResponse, usersResponse] = await Promise.all([
        fetchWithAuth("/api/admin/user-groups"),
        fetchWithAuth("/api/admin/users"),
      ]);
      if (!groupsResponse.ok) {
        const failure = await responseError(groupsResponse, "Failed to load user groups");
        throw new Error(failure.message);
      }
      if (!usersResponse.ok) {
        const failure = await responseError(usersResponse, "Failed to load users");
        throw new Error(failure.message);
      }
      const [groupsPayload, usersPayload] = await Promise.all([
        groupsResponse.json().catch(() => []),
        usersResponse.json().catch(() => []),
      ]);
      setGroups(normalizeUserGroups(groupsPayload));
      setUsers(normalizeAdminUsers(usersPayload));
      setExpandedId("");
      setMemberDrafts({});
      setMemberVersions({});
      setLoadedMemberGroups(new Set());
      setGroupNotices({});
    } catch (error) {
      const message = errorMessage(error, "Failed to load user groups");
      setPageError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const filteredGroups = useMemo(
    () => groups.filter((group) => matchesGroup(group, deferredSearch.trim())),
    [deferredSearch, groups],
  );

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setPageError("");
    try {
      const response = await fetchWithAuth("/api/admin/user-groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const failure = await responseError(response, "Failed to create user group");
        throw new Error(failure.message);
      }
      const created = normalizeUserGroups([await response.json().catch(() => ({}))])[0];
      if (created) {
        setGroups((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      } else {
        await loadDirectory();
      }
      setNewName("");
      toast.success("User group created");
    } catch (error) {
      const message = errorMessage(error, "Failed to create user group");
      setPageError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  function startRename(group: AdminUserGroup) {
    setEditingId(group.id);
    setNameDraft(group.name);
    setGroupErrors((current) => ({ ...current, [group.id]: "" }));
  }

  async function renameGroup(group: AdminUserGroup) {
    const name = nameDraft.trim();
    if (!name) return;
    setRenamingId(group.id);
    setGroupErrors((current) => ({ ...current, [group.id]: "" }));
    try {
      const response = await fetchWithAuth(
        `/api/admin/user-groups/${encodeURIComponent(group.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({ name }),
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, "Failed to rename user group");
        throw new Error(failure.message);
      }
      const updated = normalizeUserGroups([await response.json().catch(() => ({}))])[0];
      setGroups((current) =>
        current
          .map((entry) => (entry.id === group.id ? updated || { ...entry, name } : entry))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingId("");
      setNameDraft("");
      toast.success("User group renamed");
    } catch (error) {
      const message = errorMessage(error, "Failed to rename user group");
      setGroupErrors((current) => ({ ...current, [group.id]: message }));
      toast.error(message);
    } finally {
      setRenamingId("");
    }
  }

  async function deleteGroup(group: AdminUserGroup) {
    if (
      !window.confirm(
        `Delete user group “${group.name}”? Host grants for this group will be removed.`,
      )
    ) {
      return;
    }
    setDeletingId(group.id);
    setGroupErrors((current) => ({ ...current, [group.id]: "" }));
    try {
      const response = await fetchWithAuth(
        `/api/admin/user-groups/${encodeURIComponent(group.id)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, "Failed to delete user group");
        throw new Error(failure.message);
      }
      setGroups((current) => current.filter((entry) => entry.id !== group.id));
      setMemberDrafts((current) => {
        const next = { ...current };
        delete next[group.id];
        return next;
      });
      setMemberVersions((current) => {
        const next = { ...current };
        delete next[group.id];
        return next;
      });
      setGroupNotices((current) => {
        const next = { ...current };
        delete next[group.id];
        return next;
      });
      if (expandedId === group.id) setExpandedId("");
      toast.success("User group deleted");
    } catch (error) {
      const message = errorMessage(error, "Failed to delete user group");
      setGroupErrors((current) => ({ ...current, [group.id]: message }));
      toast.error(message);
    } finally {
      setDeletingId("");
    }
  }

  async function loadMembers(group: AdminUserGroup, options: { notice?: string } = {}) {
    setMembersLoadingId(group.id);
    setGroupErrors((current) => ({ ...current, [group.id]: "" }));
    setGroupNotices((current) => ({ ...current, [group.id]: options.notice || "" }));
    setLoadedMemberGroups((current) => {
      const next = new Set(current);
      next.delete(group.id);
      return next;
    });
    setMemberDrafts((current) => {
      const next = { ...current };
      delete next[group.id];
      return next;
    });
    setMemberVersions((current) => {
      const next = { ...current };
      delete next[group.id];
      return next;
    });
    try {
      const response = await fetchWithAuth(
        `/api/admin/user-groups/${encodeURIComponent(group.id)}/members`,
      );
      if (!response.ok) {
        const failure = await responseError(response, "Failed to load group members");
        throw new Error(failure.message);
      }
      const snapshot = normalizeUserGroupMembers(
        await response.json().catch(() => ({})),
        group.membersVersion || 0,
      );
      setMemberDrafts((current) => ({
        ...current,
        [group.id]: new Set(snapshot.members.map((member) => member.userId)),
      }));
      setMemberVersions((current) => ({ ...current, [group.id]: snapshot.version }));
      setGroups((current) =>
        current.map((entry) =>
          entry.id === group.id
            ? {
                ...entry,
                memberCount: snapshot.members.length,
                membersVersion: snapshot.version,
              }
            : entry,
        ),
      );
      setLoadedMemberGroups((current) => new Set(current).add(group.id));
    } catch (error) {
      const message = errorMessage(error, "Failed to load group members");
      setGroupErrors((current) => ({ ...current, [group.id]: message }));
      if (options.notice) {
        setGroups((current) =>
          current.map((entry) =>
            entry.id === group.id ? { ...entry, memberCount: null, membersVersion: null } : entry,
          ),
        );
      }
    } finally {
      setMembersLoadingId("");
    }
  }

  async function openMembers(group: AdminUserGroup) {
    if (expandedId === group.id) {
      setExpandedId("");
      return;
    }
    setExpandedId(group.id);
    if (!loadedMemberGroups.has(group.id)) await loadMembers(group);
  }

  function toggleMember(groupId: string, userId: string, enabled: boolean) {
    setMemberDrafts((current) => {
      const selected = new Set(current[groupId] || []);
      if (enabled) selected.add(userId);
      else selected.delete(userId);
      return { ...current, [groupId]: selected };
    });
  }

  async function saveMembers(group: AdminUserGroup) {
    const selected = memberDrafts[group.id] || new Set<string>();
    const expectedVersion = memberVersions[group.id];
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      setGroupErrors((current) => ({
        ...current,
        [group.id]: "Membership version is unavailable. Reload members before saving.",
      }));
      return;
    }
    setMembersSavingId(group.id);
    setGroupErrors((current) => ({ ...current, [group.id]: "" }));
    setGroupNotices((current) => ({ ...current, [group.id]: "" }));
    try {
      const response = await fetchWithAuth(
        `/api/admin/user-groups/${encodeURIComponent(group.id)}/members`,
        {
          method: "PUT",
          body: JSON.stringify({ expectedVersion, users: Array.from(selected) }),
        },
      );
      if (!response.ok) {
        const failure = await responseError(response, "Failed to replace group members");
        if (response.status === 409) {
          const conflictMessage =
            "Another administrator saved newer membership. The latest members were reloaded; review them before saving again.";
          await loadMembers(group, { notice: conflictMessage });
          toast.error(failure.message || conflictMessage);
          return;
        }
        throw new Error(failure.message);
      }
      const saved = normalizeUserGroupMembers(
        await response.json().catch(() => ({})),
        expectedVersion + 1,
      );
      setMemberDrafts((current) => ({
        ...current,
        [group.id]: new Set(saved.members.map((member) => member.userId)),
      }));
      setMemberVersions((current) => ({ ...current, [group.id]: saved.version }));
      setGroups((current) =>
        current.map((entry) =>
          entry.id === group.id
            ? { ...entry, memberCount: saved.members.length, membersVersion: saved.version }
            : entry,
        ),
      );
      toast.success("User group members replaced");
    } catch (error) {
      const message = errorMessage(error, "Failed to replace group members");
      setGroupErrors((current) => ({ ...current, [group.id]: message }));
      toast.error(message);
    } finally {
      setMembersSavingId("");
    }
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-brand-ink/55">
              Platform access directory
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">User groups</h1>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
              Build reusable account groups for platform-managed Remote Host access. Membership
              replacement is atomic, so invalid users never leave a partial update.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadDirectory()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-brand-cyan/20 disabled:opacity-60"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        <form
          onSubmit={createGroup}
          className="rounded-[2rem] border border-brand-cyan/15 bg-brand-ink p-5 text-brand-foreground shadow-sm sm:p-6"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
            <label className="flex-1" htmlFor="new-user-group-name">
              <span className="text-[11px] font-black uppercase tracking-[0.16em] text-brand-cyan/70">
                Group name
              </span>
              <input
                id="new-user-group-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                required
                className="mt-2 w-full rounded-2xl border border-brand-cyan/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-brand-cyan focus:ring-4 focus:ring-brand-cyan/20"
                placeholder="Platform engineering"
              />
            </label>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-cyan px-4 py-3 text-sm font-black text-brand-ink hover:bg-brand-cyan/80 disabled:opacity-60"
            >
              {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Create user group
            </button>
          </div>
        </form>

        {pageError ? (
          <div
            role="alert"
            className="rounded-[1.5rem] border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800"
          >
            {pageError}
          </div>
        ) : null}

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="relative max-w-xl">
            <Search
              size={16}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search user groups"
              placeholder="Search by group name or id"
              className={`${INPUT_CLASS} pl-11`}
            />
          </div>

          {loading ? (
            <div className="flex h-56 items-center justify-center text-sm font-semibold text-slate-500">
              <Loader2 size={21} className="mr-2 animate-spin text-brand-ink" />
              Loading user groups…
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="mt-6 flex h-52 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-center">
              <UsersRound size={28} className="text-slate-300" />
              <p className="mt-3 text-sm font-bold text-slate-600">
                {groups.length === 0 ? "No user groups exist yet." : "No groups match this search."}
              </p>
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              {filteredGroups.map((group) => {
                const editing = editingId === group.id;
                const expanded = expandedId === group.id;
                const selectedMembers = memberDrafts[group.id] || new Set<string>();
                const membersReady = loadedMemberGroups.has(group.id);
                return (
                  <article
                    key={group.id}
                    className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white"
                  >
                    <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-cyan/15 text-brand-ink">
                          <UsersRound size={20} />
                        </span>
                        <div className="min-w-0 flex-1">
                          {editing ? (
                            <label htmlFor={`group-name-${group.id}`}>
                              <span className="sr-only">Group name for {group.name}</span>
                              <input
                                id={`group-name-${group.id}`}
                                value={nameDraft}
                                onChange={(event) => setNameDraft(event.target.value)}
                                className={INPUT_CLASS}
                                autoFocus
                              />
                            </label>
                          ) : (
                            <>
                              <h2 className="truncate text-base font-black text-slate-950">
                                {group.name}
                              </h2>
                              <p className="mt-1 font-mono text-xs text-slate-500">{group.id}</p>
                            </>
                          )}
                          <p className="mt-2 text-xs font-bold text-slate-500">
                            {group.memberCount == null
                              ? "Members unavailable"
                              : `${group.memberCount} member${group.memberCount === 1 ? "" : "s"}`}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {editing ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId("");
                                setNameDraft("");
                              }}
                              disabled={renamingId === group.id}
                              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                            >
                              <X size={14} />
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void renameGroup(group)}
                              disabled={renamingId === group.id || !nameDraft.trim()}
                              className="inline-flex items-center gap-2 rounded-2xl bg-brand-cyan px-3 py-2 text-sm font-black text-brand-ink hover:bg-brand-cyan/80 disabled:opacity-60"
                            >
                              {renamingId === group.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Check size={14} />
                              )}
                              Save name
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startRename(group)}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                          >
                            <Pencil size={14} />
                            Rename
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void openMembers(group)}
                          disabled={membersLoadingId === group.id || membersSavingId === group.id}
                          aria-expanded={expanded}
                          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                          {membersLoadingId === group.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : expanded ? (
                            <ChevronUp size={14} />
                          ) : (
                            <ChevronDown size={14} />
                          )}
                          Manage members
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteGroup(group)}
                          disabled={deletingId === group.id}
                          className="inline-flex items-center gap-2 rounded-2xl border border-red-200 px-3 py-2 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-60"
                        >
                          {deletingId === group.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                          Delete group
                        </button>
                      </div>
                    </div>

                    {groupErrors[group.id] ? (
                      <div
                        role="alert"
                        className="mx-5 mb-5 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800"
                      >
                        {groupErrors[group.id]}
                      </div>
                    ) : null}

                    {groupNotices[group.id] ? (
                      <div
                        role="status"
                        className="mx-5 mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900"
                      >
                        <p className="font-black">Membership changed elsewhere</p>
                        <p className="mt-1 font-medium">{groupNotices[group.id]}</p>
                      </div>
                    ) : null}

                    {expanded ? (
                      <div className="border-t border-slate-100 bg-slate-50 p-5">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <h3 className="font-black text-slate-950">Replace members</h3>
                            <p className="mt-1 text-sm font-medium text-slate-500">
                              Select the complete desired membership, then save once.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void saveMembers(group)}
                            disabled={
                              membersSavingId === group.id ||
                              membersLoadingId === group.id ||
                              !membersReady
                            }
                            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-ink px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
                          >
                            {membersSavingId === group.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Save size={14} />
                            )}
                            Save members
                          </button>
                        </div>

                        {membersLoadingId === group.id ? (
                          <div className="mt-4 flex h-28 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-500">
                            <Loader2 size={18} className="mr-2 animate-spin text-brand-ink" />
                            Loading members…
                          </div>
                        ) : !membersReady ? (
                          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800">
                            Membership is unavailable. Retry the read before replacing members.
                            <button
                              type="button"
                              onClick={() => void loadMembers(group)}
                              className="ml-3 rounded-xl border border-red-300 bg-white px-3 py-1.5 text-xs font-bold hover:bg-red-100"
                            >
                              Retry members
                            </button>
                          </div>
                        ) : users.length === 0 ? (
                          <p className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-white p-5 text-center text-sm font-medium text-slate-500">
                            No user accounts are available.
                          </p>
                        ) : (
                          <div className="mt-4 grid max-h-80 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
                            {users.map((user) => (
                              <label
                                key={user.id}
                                className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 hover:border-brand-cyan/60"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-bold text-slate-900">
                                    {user.name || user.email || user.id}
                                  </span>
                                  <span className="mt-0.5 block truncate text-xs font-medium text-slate-500">
                                    {user.name ? user.email : user.id}
                                  </span>
                                </span>
                                <input
                                  type="checkbox"
                                  checked={selectedMembers.has(user.id)}
                                  disabled={membersSavingId === group.id}
                                  onChange={(event) =>
                                    toggleMember(group.id, user.id, event.target.checked)
                                  }
                                  className="h-5 w-5 shrink-0 accent-brand-cyan focus:ring-brand-cyan disabled:opacity-60"
                                />
                              </label>
                            ))}
                          </div>
                        )}

                        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-brand-cyan/30 bg-brand-cyan/10 p-4 text-sm font-medium text-brand-ink">
                          <UserRoundCheck size={18} className="mt-0.5 shrink-0" />
                          <p>
                            Saving replaces the entire group membership in one transaction. Remote
                            Host grants continue to reference the group itself.
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}
