import Layout from "../../components/layout/Layout";
import { 
  Bot, Search, Filter, Power, Terminal, Plus, Cpu, Clock, Zap, Loader2
} from "lucide-react";
import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const toast = useToast();

  const loadAgents = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
      }
    } catch (err) {
      console.error(err);
      toast.error("Failed to load agents");
    }
    setLoading(false);
  };

  useEffect(() => { loadAgents(); }, []);

  // Poll every 15s + refresh on tab visibility change
  useEffect(() => {
    const interval = setInterval(() => {
      fetchWithAuth("/api/agents")
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then(setAgents)
        .catch(() => {});
    }, 15000);
    const onVisible = () => { if (document.visibilityState === "visible") loadAgents(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const handleAction = async (id, action) => {
    try {
      const res = await fetchWithAuth(`/api/agents/${id}/${action}`, { method: "POST" });
      if (res.ok) loadAgents();
    } catch (err) {
      console.error(err);
      toast.error(`Failed to ${action} agent`);
    }
  };

  const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 relative p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
           <div className="flex flex-col gap-2 relative z-10">
              <div className="flex items-center gap-3 mb-2">
                 <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
                    <Bot size={28} strokeWidth={2.5} />
                 </div>
                 <div className="flex flex-col">
                    <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">Fleet Management</h1>
                    <div className="flex items-center gap-2">
                       <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">Nora Control Plane</span>
                       <div className="w-1 h-1 bg-slate-300 rounded-full"></div>
                       <span className="text-xs font-bold text-blue-600 leading-none">{agents.length} Nodes Configured</span>
                    </div>
                 </div>
              </div>
           </div>
           
           <div className="flex items-center gap-4 w-full md:w-auto">
              <div className="relative group flex-1 md:flex-initial">
                 <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                 <input
                   className="pl-12 pr-6 py-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none w-full md:w-72"
                   placeholder="Filter agents by name..."
                   value={search}
                   onChange={e => setSearch(e.target.value)}
                 />
              </div>
              <button 
                 onClick={() => window.location.href = "/app/deploy"}
                 className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 transition-all text-sm font-bold text-white px-8 py-4 rounded-2xl shadow-xl shadow-blue-500/30 active:scale-95"
              >
                 <Plus size={18} />
                 New Agent
              </button>
           </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
           {loading ? (
             <div className="col-span-full h-96 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white border border-slate-200 rounded-[3rem] border-dashed">
                <Loader2 size={40} className="animate-spin text-blue-500" />
                <span className="text-sm font-bold uppercase tracking-widest leading-none">Querying Nora Nodes...</span>
             </div>
           ) : filteredAgents.map(agent => (
             <AgentCard key={agent.id} agent={agent} onAction={handleAction} />
           ))}
        </div>
      </div>
    </Layout>
  );
}

function AgentCard({ agent, onAction }) {
  const isRunning = agent.status === "running";
  
  return (
    <div className="group bg-white border border-slate-200 rounded-[2.5rem] shadow-sm hover:shadow-2xl hover:shadow-blue-500/10 hover:border-blue-500/20 transition-all duration-500 overflow-hidden flex flex-col p-1">
       <div className="p-8 pb-4 flex items-start justify-between">
          <a href={`/app/agents/${agent.id}`} className="flex items-start gap-4 cursor-pointer">
             <div className={clsx(
                "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg",
                isRunning ? "bg-emerald-50 text-emerald-600 shadow-emerald-500/10" :
                "bg-blue-50 text-blue-600 shadow-blue-500/10"
             )}>
                {agent.status === "queued" ? <Loader2 size={24} className="animate-spin" /> : <Bot size={24} />}
             </div>
             <div className="flex flex-col">
                <h3 className="text-lg font-black text-slate-900 leading-tight mb-1 hover:text-blue-600 transition-colors">{agent.name}</h3>
                <div className="flex items-center gap-1.5">
                   <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest leading-none opacity-80">OpenClaw Agent</span>
                </div>
             </div>
          </a>

       </div>

       <div className="px-8 py-6">
          {(agent.container_name || agent.container_id) && (
            <div className="mb-4 flex items-center gap-2">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none opacity-80">Container</span>
              <span className="text-xs font-mono text-slate-500 truncate">{agent.container_name || agent.container_id}</span>
            </div>
          )}
          <div className="flex items-center justify-between mb-4">
             <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none opacity-80">Execution Status</span>
             <div className={clsx(
                "px-2 py-1 rounded-lg text-[9px] font-black uppercase flex items-center gap-1 border shadow-sm",
                isRunning ? "bg-emerald-50 text-emerald-700 border-emerald-100" :
                "bg-blue-50 text-blue-700 border-blue-100"
             )}>
                <div className={clsx(
                   "w-1.5 h-1.5 rounded-full",
                   isRunning ? "bg-emerald-500 animate-pulse" : "bg-blue-500 animate-pulse"
                )}></div>
                {agent.status}
             </div>
          </div>
       </div>

       <div className="mt-auto p-4 flex items-center gap-2 border-t border-slate-50">
          <a href={`/app/agents/${agent.id}`} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-900 transition-all shadow-sm">
             <Terminal size={14} className="text-slate-400" />
             Details
          </a>
          <button 
             onClick={() => onAction(agent.id, isRunning ? "stop" : "start")}
             className={clsx(
                "w-12 h-12 flex items-center justify-center border rounded-2xl transition-all shadow-sm",
                isRunning ? "bg-red-50 border-red-100 text-red-500 hover:bg-red-100" : 
                "bg-emerald-50 border-emerald-100 text-emerald-500 hover:bg-emerald-100"
             )}
          >
             <Power size={18} />
          </button>
       </div>
    </div>
  );
}
