import Layout from "../../components/layout/Layout";
import { useEffect, useState } from "react";
import { Loader2, Plus, FolderOpen, Trash2, Bot } from "lucide-react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";

export default function Workspaces() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const toast = useToast();

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

  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
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
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to create workspace");
    }
    setCreating(false);
  };

  const remove = async (id) => {
    try {
      await fetchWithAuth(`/api/workspaces/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete workspace");
    }
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
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">Workspaces</h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">Logical groupings for your agents</span>
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
            <span className="text-sm font-bold uppercase tracking-widest">Loading workspaces...</span>
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
                      <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">ID: {w.id}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => remove(w.id)}
                    aria-label={`Delete workspace ${w.name}`}
                    className="p-2.5 rounded-xl hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
                {w.agents && w.agents.length > 0 && (
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
                    <Bot size={14} />
                    {w.agents.length} agent{w.agents.length !== 1 ? "s" : ""} assigned
                  </div>
                )}
                <span className="text-[10px] text-slate-400 font-medium">
                  Created {new Date(w.created_at).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
