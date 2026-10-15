import { useEffect, useState, type ReactElement } from "react";
import { useRouter } from "next/router";
import {
  Loader2,
  Users,
  UserPlus,
  Mail,
  Trash2,
  Copy,
  Crown,
  Shield,
  Eye,
  Pencil,
} from "lucide-react";
import Layout from "../../../components/layout/Layout";
import WorkspaceBackLink from "../../../components/workspaces/WorkspaceBackLink";
import { useToast } from "../../../components/Toast";
import { useI18n } from "../../../lib/i18n";
import { fetchWithAuth } from "../../../lib/api";
import {
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceRole,
  createInvitation,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  roleSatisfies,
  updateMemberRole,
} from "../../../lib/workspaceClient";

const ASSIGNABLE_ROLES: Exclude<WorkspaceRole, "owner">[] = ["admin", "editor", "viewer"];
const ALL_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

const ROLE_ICONS: Record<WorkspaceRole, ReactElement> = {
  owner: <Crown size={14} />,
  admin: <Shield size={14} />,
  editor: <Pencil size={14} />,
  viewer: <Eye size={14} />,
};

const ROLE_COLORS: Record<WorkspaceRole, string> = {
  owner: "bg-amber-50 text-amber-700 border-amber-200",
  admin: "bg-violet-50 text-violet-700 border-violet-200",
  editor: "bg-blue-50 text-blue-700 border-blue-200",
  viewer: "bg-slate-50 text-slate-600 border-slate-200",
};

export default function WorkspaceMembersPage() {
  const router = useRouter();
  const workspaceId = typeof router.query.id === "string" ? router.query.id : null;
  const { t } = useI18n();
  const toast = useToast();

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, "owner">>("editor");
  const [submitting, setSubmitting] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setCurrentUserId(data?.id || null))
      .catch(() => setCurrentUserId(null));
  }, []);

  const myRole = members.find((m) => m.userId === currentUserId)?.role ?? null;
  const canManage = roleSatisfies(myRole, "admin");

  async function reload() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [m, i] = await Promise.all([
        listMembers(workspaceId),
        listInvitations(workspaceId).catch(() => [] as WorkspaceInvitation[]),
      ]);
      setMembers(m);
      setInvitations(i);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load members"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [workspaceId]);

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !inviteEmail.trim()) return;
    setSubmitting(true);
    try {
      const invitation = await createInvitation(workspaceId, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      const emailSent = invitation.emailDelivery?.sent === true;
      // Always copy the link to the clipboard so the admin has a manual
      // fallback even when SMTP is configured (network issues, spam folders).
      if (invitation.token) {
        const link = `${window.location.origin}/app/invitations/accept?token=${encodeURIComponent(invitation.token)}`;
        try {
          await navigator.clipboard.writeText(link);
          if (emailSent) {
            toast.success(`${t("Email sent to")} ${invitation.email}`);
          } else {
            toast.success(t("Invitation link copied"));
          }
        } catch {
          toast.success(
            emailSent ? `${t("Email sent to")} ${invitation.email}` : t("Send invitation"),
          );
        }
      }
      await reload();
    } catch (err: any) {
      toast.error(err?.message || t("Failed to send invitation"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRoleChange(member: WorkspaceMember, role: WorkspaceRole) {
    if (!workspaceId) return;
    try {
      await updateMemberRole(workspaceId, member.userId, role);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || t("Failed to update role"));
    }
  }

  async function handleRemoveMember(member: WorkspaceMember) {
    if (!workspaceId) return;
    try {
      await removeMember(workspaceId, member.userId);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || t("Cannot remove the last owner of a workspace"));
    }
  }

  async function handleRevoke(invitation: WorkspaceInvitation) {
    if (!workspaceId) return;
    try {
      await revokeInvitation(workspaceId, invitation.id);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to revoke invitation");
    }
  }

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <WorkspaceBackLink />
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
              <Users size={28} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">
                {t("Members & invitations")}
              </h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">
                {workspaceId}
              </span>
            </div>
          </div>
        </header>

        {canManage && (
          <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
            <h2 className="text-lg font-black text-slate-900 mb-4">{t("Invite a teammate")}</h2>
            <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
              <input
                type="email"
                placeholder={t("Email")}
                className="flex-1 px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                required
              />
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
                className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
                aria-label={t("Role")}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(role.charAt(0).toUpperCase() + role.slice(1))}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-6 py-3.5 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <UserPlus size={16} />
                )}
                {t("Send invitation")}
              </button>
            </form>
          </section>
        )}

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Members")}</h2>
          {loading ? (
            <div className="h-32 flex items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : members.length === 0 ? (
            <div className="text-sm text-slate-500 py-8 text-center">
              {t("No workspaces yet. Create one above.")}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {members.map((member) => (
                <li key={member.userId} className="py-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white text-sm shrink-0">
                      {(member.name || member.email || "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900 truncate">
                        {member.name || member.email}
                      </div>
                      <div className="text-xs text-slate-500 truncate">{member.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canManage ? (
                      <select
                        value={member.role}
                        onChange={(event) =>
                          handleRoleChange(member, event.target.value as WorkspaceRole)
                        }
                        className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-900 outline-none"
                        aria-label={t("Role")}
                      >
                        {ALL_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(role.charAt(0).toUpperCase() + role.slice(1))}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border text-[11px] font-black uppercase tracking-widest ${ROLE_COLORS[member.role]}`}
                      >
                        {ROLE_ICONS[member.role]}
                        {t(member.role.charAt(0).toUpperCase() + member.role.slice(1))}
                      </span>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => handleRemoveMember(member)}
                        aria-label={t("Remove")}
                        className="p-2 rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage && invitations.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
            <h2 className="text-lg font-black text-slate-900 mb-4">{t("Pending invitations")}</h2>
            <ul className="divide-y divide-slate-100">
              {invitations
                .filter((invitation) => invitation.status === "pending")
                .map((invitation) => (
                  <li key={invitation.id} className="py-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <Mail size={18} className="text-slate-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-900 truncate">
                          {invitation.email}
                        </div>
                        <div className="text-xs text-slate-500">
                          {t(invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1))} ·{" "}
                          {new Date(invitation.expiresAt).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {invitation.token && (
                        <button
                          type="button"
                          onClick={() => {
                            const link = `${window.location.origin}/app/invitations/accept?token=${encodeURIComponent(invitation.token!)}`;
                            navigator.clipboard.writeText(link).then(
                              () => toast.success(t("Invitation link copied")),
                              () => toast.error("Clipboard unavailable"),
                            );
                          }}
                          aria-label={t("Copy invitation link")}
                          className="p-2 rounded-xl text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-all"
                        >
                          <Copy size={16} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRevoke(invitation)}
                        aria-label={t("Revoke")}
                        className="p-2 rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </Layout>
  );
}
