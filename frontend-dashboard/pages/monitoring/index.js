import Layout from "../../components/layout/Layout";
import { Activity, Zap, Cpu, HardDrive, LayoutDashboard, Globe, AlertCircle, CheckCircle2, Loader2, RefreshCw, BarChart3 } from "lucide-react";
import { clsx } from "clsx";
import { useState, useEffect, useCallback } from "react";
import { fetchWithAuth } from "../../lib/api";

export default function Monitoring() {
  const [metrics, setMetrics] = useState(null);
  const [events, setEvents] = useState([]);
  const [perfMetrics, setPerfMetrics] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [metricsRes, eventsRes, perfRes] = await Promise.all([
        fetchWithAuth("/api/monitoring/metrics"),
        fetchWithAuth("/api/monitoring/events?limit=20"),
        fetchWithAuth("/api/monitoring/performance"),
      ]);
      if (metricsRes.ok) setMetrics(await metricsRes.json());
      if (eventsRes.ok) setEvents(await eventsRes.json());
      if (perfRes.ok) setPerfMetrics(await perfRes.json());
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const statCards = metrics
    ? [
        { name: "Active Agents", value: metrics.activeAgents ?? 0, icon: Zap, color: "blue" },
        { name: "Total Deployments", value: metrics.totalDeployments ?? 0, icon: LayoutDashboard, color: "emerald" },
        { name: "Queued Jobs", value: metrics.queue?.waiting ?? 0, icon: Globe, color: "purple" },
        { name: "Total Users", value: metrics.totalUsers ?? 0, icon: Activity, color: "pink" },
      ]
    : [];

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
              <Activity size={28} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none">System Monitoring</h1>
              <p className="text-slate-400 font-medium text-sm mt-1">Real-time health and performance metrics for the Nora fleet. Auto-refreshes every 30s.</p>
            </div>
          </div>
          <button onClick={() => { setLoading(true); loadData(); }} className="flex items-center gap-2 px-5 py-3 bg-white border border-slate-200 rounded-2xl text-sm font-bold text-slate-600 hover:bg-slate-50 transition-all shadow-sm active:scale-95">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        {loading && !metrics ? (
          <div className="h-64 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white border border-slate-200 rounded-[3rem] border-dashed">
            <Loader2 size={40} className="animate-spin text-blue-500" />
            <span className="text-sm font-bold uppercase tracking-widest">Loading metrics...</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {statCards.map((m) => (
                <div key={m.name} className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-xl transition-all group">
                  <div className={clsx(
                    "w-12 h-12 rounded-2xl flex items-center justify-center mb-6 shadow-sm transition-transform group-hover:scale-110",
                    m.color === "blue" ? "bg-blue-50 text-blue-600" :
                    m.color === "emerald" ? "bg-emerald-50 text-emerald-600" :
                    m.color === "purple" ? "bg-purple-50 text-purple-600" :
                    "bg-pink-50 text-pink-600"
                  )}>
                    <m.icon size={24} />
                  </div>
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.15em] mb-1">{m.name}</h3>
                  <div className="text-3xl font-black text-slate-900 leading-none">{m.value}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
              <div className="flex flex-col gap-6">
                <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <Cpu size={20} className="text-blue-600" /> Queue Health
                </h2>
                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-10 flex flex-col gap-8 shadow-sm">
                  {metrics?.queue && Object.entries(metrics.queue).map(([key, val]) => (
                    <div key={key} className="flex flex-col gap-3">
                      <div className="flex justify-between items-center text-sm font-bold text-slate-900">
                        <span className="capitalize">{key}</span>
                        <span>{val}</span>
                      </div>
                      <div className="w-full bg-slate-100 h-3 rounded-full overflow-hidden">
                        <div className={clsx("h-full rounded-full", key === "failed" ? "bg-red-500" : key === "completed" ? "bg-emerald-500" : "bg-blue-600")} style={{ width: `${Math.min((val / Math.max(metrics.totalDeployments || 1, 1)) * 100, 100)}%` }}></div>
                      </div>
                    </div>
                  ))}
                  {!metrics?.queue && <span className="text-sm text-slate-400 font-medium">Queue metrics unavailable</span>}
                </div>
              </div>

              <div className="flex flex-col gap-6">
                <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <AlertCircle size={20} className="text-orange-600" /> Recent Events
                </h2>
                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-4 shadow-sm flex flex-col gap-2 max-h-[500px] overflow-y-auto">
                  {events.length === 0 ? (
                    <div className="p-8 text-center text-sm text-slate-400 font-medium">No events recorded yet.</div>
                  ) : events.map((ev) => (
                    <div key={ev.id} className="p-4 flex items-start gap-4 hover:bg-slate-50 transition-all rounded-2xl">
                      {ev.type === "deployment" ? (
                        <CheckCircle2 size={18} className="text-emerald-500 mt-0.5 flex-shrink-0" />
                      ) : (
                        <Activity size={18} className="text-blue-500 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-bold text-slate-900 leading-tight mb-1 truncate">{ev.message}</span>
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                          {new Date(ev.created_at).toLocaleString()} — {ev.type}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* API Performance */}
            {perfMetrics.length > 0 && (
              <div className="flex flex-col gap-6">
                <h2 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                  <BarChart3 size={20} className="text-purple-600" /> API Performance (24h)
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {(() => {
                    const latest = perfMetrics[perfMetrics.length - 1];
                    const meta = typeof latest.metadata === 'string' ? JSON.parse(latest.metadata) : latest.metadata;
                    const totalReqs = perfMetrics.reduce((s, p) => s + parseFloat(p.value), 0);
                    const avgLatency = perfMetrics.reduce((s, p) => {
                      const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
                      return s + (m.avgLatencyMs || 0);
                    }, 0) / perfMetrics.length;
                    const totalErrors = perfMetrics.reduce((s, p) => {
                      const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
                      return s + (m.errorCount || 0);
                    }, 0);

                    return [
                      { label: "Total Requests", value: totalReqs, color: "text-blue-600" },
                      { label: "Avg Latency", value: `${avgLatency.toFixed(1)}ms`, color: "text-emerald-600" },
                      { label: "Server Errors", value: totalErrors, color: totalErrors > 0 ? "text-red-600" : "text-emerald-600" },
                    ].map(s => (
                      <div key={s.label} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                        <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">{s.label}</p>
                        <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
