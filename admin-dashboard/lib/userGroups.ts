import { normalizeAdminUsers, normalizeVersion, type AdminUserOption } from "./remoteHosts";

export type AdminUserGroup = {
  id: string;
  name: string;
  memberCount?: number | null;
  membersVersion?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type AdminUserGroupMember = AdminUserOption & {
  userId: string;
};

export type AdminUserGroupMembersSnapshot = {
  version: number;
  members: AdminUserGroupMember[];
};

export function normalizeUserGroups(payload: unknown): AdminUserGroup[] {
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
      createdAt: entry?.createdAt ?? entry?.created_at ?? null,
      updatedAt: entry?.updatedAt ?? entry?.updated_at ?? null,
    }))
    .filter((entry) => entry.id);
}

export function normalizeUserGroupMembers(
  payload: unknown,
  fallbackVersion = 0,
): AdminUserGroupMembersSnapshot {
  const source = (payload || {}) as {
    version?: unknown;
    membersVersion?: unknown;
    members?: unknown[];
    users?: unknown[];
  };
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(source.members)
      ? source.members
      : Array.isArray(source.users)
        ? source.users
        : [];
  return {
    version: normalizeVersion(source.version ?? source.membersVersion, fallbackVersion),
    members: normalizeAdminUsers(rows).map((entry) => ({ ...entry, userId: entry.id })),
  };
}
