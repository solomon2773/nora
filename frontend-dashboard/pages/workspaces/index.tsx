import Layout from "../../components/layout/Layout";
import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2, Plus, FolderOpen, Trash2, Bot, Users } from "lucide-react";
import { useRouter } from "next/router";
import { clsx } from "clsx";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";
import ConfirmDialog from "../../components/ConfirmDialog";

export default function Workspaces() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // Phase 5c item 1 / Phase 8 item 11: workspace delete had NO confirmation
  // dialog at all before this change — the trash icon called `remove(id)`
  // directly. The backend now also rejects a delete request missing
  // `deleteLogs`, so this needed both a confirmation step and the explicit
  // keep-or-delete-logs choice, with no default.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteLogsChoice, setDeleteLogsChoice] = useState(null);
  const toast = useToast();
  const router = useRouter();

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/workspaces");
      if (res.ok) setWorkspaces(await res.json());
    } catch (err) {
      console.error(err);
      toast.error("Failed to load workspaces");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Enter a workspace name first");
      return;
    }
    setCreating(true);
    try {
      const res = await fetchWithAuth("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        setName("");
        load();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || "Failed to create workspace");
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to create workspace");
    }
    setCreating(false);
  };

  const remove = async (id, deleteLogs) => {
    try {
      const res = await fetchWithAuth(`/api/workspaces/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ deleteLogs: Boolean(deleteLogs) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete workspace");
      }
      load();
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Failed to delete workspace");
    }
  };

  const confirmDelete = () => {
    if (!pendingDelete || deleteLogsChoice === null) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setDeleteLogsChoice(null);
    remove(target.id, deleteLogsChoice);
  };

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 relative p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
              <FolderOpen size={28} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">
                Workspaces
              </h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">
                Logical groupings for your agents
              </span>
            </div>
          </div>
          <form onSubmit={create} className="flex items-center gap-3 w-full md:w-auto">
            <input
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none flex-1 md:w-64"
              placeholder="New workspace name..."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              disabled={creating}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-6 py-3.5 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95 disabled:opacity-50"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Create
            </button>
          </form>
        </header>

        {loading ? (
          <div className="h-64 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white border border-slate-200 rounded-[3rem] border-dashed">
            <Loader2 size={40} className="animate-spin text-blue-500" />
            <span className="text-sm font-bold uppercase tracking-widest">
              Loading workspaces...
            </span>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-slate-400 gap-3 bg-white border border-slate-200 rounded-[3rem] border-dashed">
            <FolderOpen size={40} className="text-slate-300" />
            <span className="text-sm font-bold">No workspaces yet. Create one above.</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
            {workspaces.map((w) => (
              <div
                key={w.id}
                className="group bg-white border border-slate-200 rounded-[2.5rem] shadow-sm hover:shadow-2xl hover:shadow-blue-500/10 hover:border-blue-500/20 transition-all duration-500 p-8 flex flex-col gap-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center shadow-sm">
                      <FolderOpen size={22} />
                    </div>
                    <div className="flex flex-col">
                      <h3 className="text-lg font-black text-slate-900 leading-tight">{w.name}</h3>
                      <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                        ID: {w.id}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => router.push(`/workspaces/${w.id}/members`)}
                      aria-label={`Manage members of ${w.name}`}
                      className="p-2.5 rounded-xl hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-all"
                    >
                      <Users size={18} />
                    </button>
                    {w.role === "owner" && (
                      <button
                        onClick={() => setPendingDelete(w)}
                        aria-label={`Delete workspace ${w.name}`}
                        className="p-2.5 rounded-xl hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs font-bold text-slate-500">
                  <span className="inline-flex items-center gap-2">
                    <Bot size={14} />
                    {w.agent_count || w.agents?.length || 0} agent
                    {(w.agent_count || w.agents?.length || 0) === 1 ? "" : "s"}
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <Users size={14} />
                    {w.member_count || 0} member{(w.member_count || 0) === 1 ? "" : "s"}
                  </span>
                </div>
                <span className="text-[10px] text-slate-400 font-medium">
                  Created {new Date(w.created_at).toLocaleDateString()}
                </span>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => router.push(`/workspaces/${w.id}/agents`)}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
                  >
                    <Bot size={14} />
                    Agents
                  </button>
                  <button
                    onClick={() => router.push(`/workspaces/${w.id}/members`)}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
                  >
                    <ArrowUpRight size={14} />
                    Members
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete workspace"
        message={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? This removes the workspace and its member/agent assignments. This action cannot be undone.`
            : "Are you sure?"
        }
        confirmLabel="Delete Workspace"
        confirmDisabled={deleteLogsChoice === null}
        onConfirm={confirmDelete}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteLogsChoice(null);
        }}
      >
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-500">
            This workspace's logs
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Choose whether to keep or delete the runtime logs for every agent in this workspace.
            There is no default — pick one before deleting.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setDeleteLogsChoice(false)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                deleteLogsChoice === false
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              Keep logs
            </button>
            <button
              type="button"
              onClick={() => setDeleteLogsChoice(true)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                deleteLogsChoice === true
                  ? "border-red-500 bg-red-50 text-red-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              Delete logs
            </button>
          </div>
        </div>
      </ConfirmDialog>
    </Layout>
  );
}
