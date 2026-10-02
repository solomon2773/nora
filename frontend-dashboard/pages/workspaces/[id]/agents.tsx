import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Bot, FolderOpen, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import Layout from "../../../components/layout/Layout";
import WorkspaceBackLink from "../../../components/workspaces/WorkspaceBackLink";
import StatusBadge from "../../../components/agents/StatusBadge";
import { useToast } from "../../../components/Toast";
import {
  type Workspace,
  type WorkspaceAgent,
  type WorkspaceAgentCandidate,
  assignWorkspaceAgent,
  listWorkspaceAgentCandidates,
  listWorkspaceAgents,
  listWorkspaces,
  removeWorkspaceAgent,
  roleSatisfies,
} from "../../../lib/workspaceClient";
import {
  formatExecutionTargetLabel,
  formatRuntimeFamilyLabel,
  resolveAgentExecutionTarget,
} from "../../../lib/runtime";

function shortId(value: string) {
  return String(value || "").slice(0, 8);
}

export default function WorkspaceAgentsPage() {
  const router = useRouter();
  const workspaceId = typeof router.query.id === "string" ? router.query.id : null;
  const toast = useToast();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [candidates, setCandidates] = useState<WorkspaceAgentCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutatingAgentId, setMutatingAgentId] = useState("");

  const canAssign = roleSatisfies(workspace?.role || null, "editor");
  const canRemove = roleSatisfies(workspace?.role || null, "admin");

  async function reload() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [workspaceRows, workspaceAgents] = await Promise.all([
        listWorkspaces(),
        listWorkspaceAgents(workspaceId),
      ]);
      const activeWorkspace = workspaceRows.find((row) => row.id === workspaceId) || null;
      setWorkspace(activeWorkspace);
      setAgents(workspaceAgents);
      if (roleSatisfies(activeWorkspace?.role || null, "editor")) {
        setCandidates(await listWorkspaceAgentCandidates(workspaceId));
      } else {
        setCandidates([]);
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to load workspace agents");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [workspaceId]);

  async function handleAssign(candidate: WorkspaceAgentCandidate) {
    if (!workspaceId || candidate.assigned) return;
    setMutatingAgentId(candidate.agentId);
    try {
      await assignWorkspaceAgent(workspaceId, candidate.agentId);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to assign agent");
    } finally {
      setMutatingAgentId("");
    }
  }

  async function handleRemove(agent: WorkspaceAgent) {
    if (!workspaceId) return;
    if (!confirm(`Remove ${agent.agentName || agent.name} from this workspace?`)) return;
    setMutatingAgentId(agent.agentId);
    try {
      await removeWorkspaceAgent(workspaceId, agent.agentId);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to remove workspace assignment");
    } finally {
      setMutatingAgentId("");
    }
  }

  const assignedAgentIds = useMemo(() => new Set(agents.map((agent) => agent.agentId)), [agents]);
  const sortedCandidates = useMemo(
    () =>
      [...candidates].sort((a, b) => {
        if (a.assigned !== b.assigned) return a.assigned ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
    [candidates],
  );

  return (
    <Layout>
      <div className="flex flex-col gap-8">
        <WorkspaceBackLink />
        <header className="flex flex-col gap-4 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-100 bg-blue-50 text-blue-600">
              <FolderOpen size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-900">
                Workspace agents
              </h1>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {workspace?.name || workspaceId || "Workspace"} · {workspace?.role || "member"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={reload}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </header>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-black text-slate-900">Assigned agents</h2>
              <p className="mt-1 text-sm text-slate-500">
                Workspace members can access these agents based on their workspace role.
              </p>
            </div>
            <span className="text-xs font-bold text-slate-500">{agents.length} assigned</span>
          </div>

          {loading ? (
            <div className="flex h-32 items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : agents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
              No agents are assigned to this workspace yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {agents.map((agent) => (
                <div key={agent.agentId} className="flex items-center justify-between gap-4 py-4">
                  <Link
                    href={`/agents/${agent.agentId}`}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                      <Bot size={17} />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-900">
                        {agent.agentName || agent.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {shortId(agent.agentId)} ·{" "}
                        {formatRuntimeFamilyLabel(agent.runtime_family || "")} ·{" "}
                        {formatExecutionTargetLabel(resolveAgentExecutionTarget(agent))}
                      </p>
                    </div>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={agent.agentStatus || agent.status} />
                    {canRemove ? (
                      <button
                        type="button"
                        onClick={() => handleRemove(agent)}
                        disabled={mutatingAgentId === agent.agentId}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                        aria-label="Remove assignment"
                      >
                        {mutatingAgentId === agent.agentId ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <Trash2 size={15} />
                        )}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {canAssign ? (
          <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4">
              <h2 className="text-lg font-black text-slate-900">Add owned agents</h2>
              <p className="mt-1 text-sm text-slate-500">
                You can assign agents you own. Workspace admins can remove assignments later.
              </p>
            </div>

            {sortedCandidates.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
                No owned agents are available to assign.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {sortedCandidates.map((candidate) => {
                  const assigned = candidate.assigned || assignedAgentIds.has(candidate.agentId);
                  return (
                    <div
                      key={candidate.agentId}
                      className="flex items-center justify-between gap-4 py-4"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
                          <Bot size={17} />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900">
                            {candidate.name}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {shortId(candidate.agentId)} ·{" "}
                            {formatRuntimeFamilyLabel(candidate.runtime_family || "")} ·{" "}
                            {formatExecutionTargetLabel(resolveAgentExecutionTarget(candidate))}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAssign(candidate)}
                        disabled={assigned || mutatingAgentId === candidate.agentId}
                        className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold ${
                          assigned
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-blue-600 text-white hover:bg-blue-700"
                        } disabled:opacity-70`}
                      >
                        {mutatingAgentId === candidate.agentId ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Plus size={14} />
                        )}
                        {assigned ? "Assigned" : "Add"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : (
          <section className="rounded-[2rem] border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
            Viewer access can inspect assigned agents, but workspace editor access is required to
            add agents.
          </section>
        )}
      </div>
    </Layout>
  );
}
