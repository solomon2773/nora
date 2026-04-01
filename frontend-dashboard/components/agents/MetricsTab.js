import { useState, useEffect, useCallback } from "react";
import { fetchWithAuth } from "../../lib/api";
import { Cpu, MemoryStick, Network, HardDrive, Clock, Loader2, AlertTriangle } from "lucide-react";
import dynamic from "next/dynamic";

const AreaChart = dynamic(() => import("recharts").then(m => m.AreaChart), { ssr: false });
const Area = dynamic(() => import("recharts").then(m => m.Area), { ssr: false });
const XAxis = dynamic(() => import("recharts").then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import("recharts").then(m => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import("recharts").then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import("recharts").then(m => m.ResponsiveContainer), { ssr: false });

const RANGE_OPTIONS = [
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
];

function formatUptime(s) {
  if (!s) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatBytes(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(mb * 1024).toFixed(0)} KB`;
}

function fmtTime(iso, range) {
  const d = new Date(iso);
  if (["6h", "24h"].includes(range)) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function MetricsTab({ agentId }) {
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState("15m");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch current stats (live snapshot)
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/stats`);
      if (res.ok) { setStats(await res.json()); setError(null); }
    } catch {}
  }, [agentId]);

  // Fetch historical stats from DB
  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/stats/history?range=${range}`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data.map(r => ({
          time: fmtTime(r.recorded_at, range),
          cpu_percent: parseFloat(r.cpu_percent) || 0,
          memory_percent: parseFloat(r.memory_percent) || 0,
          memory_usage_mb: parseInt(r.memory_usage_mb) || 0,
          memory_limit_mb: parseInt(r.memory_limit_mb) || 0,
          network_rx_mb: parseFloat(r.network_rx_mb) || 0,
          network_tx_mb: parseFloat(r.network_tx_mb) || 0,
          disk_read_mb: parseFloat(r.disk_read_mb) || 0,
          disk_write_mb: parseFloat(r.disk_write_mb) || 0,
          pids: parseInt(r.pids) || 0,
        })));
      }
    } catch {}
    setLoading(false);
  }, [agentId, range]);

  // Initial load + polling
  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    fetchLive();
    fetchHistory();
    const liveInterval = setInterval(fetchLive, 5000);
    const histInterval = setInterval(fetchHistory, 10000);
    return () => { clearInterval(liveInterval); clearInterval(histInterval); };
  }, [agentId, range, fetchLive, fetchHistory]);

  if (loading && !stats) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-blue-500" size={24} /></div>;
  }

  if (error && !stats) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 flex items-center gap-3">
        <AlertTriangle size={20} className="text-red-500 shrink-0" />
        <div><p className="text-sm font-bold text-red-700">Cannot fetch stats</p><p className="text-xs text-red-500 mt-1">{error}</p></div>
      </div>
    );
  }

  const s = stats || {};

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-medium">Time Range:</span>
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all ${
                  range === opt.value ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          <span><Clock size={10} className="inline mr-1" />Uptime: <strong className="text-slate-600">{formatUptime(s.uptime_seconds)}</strong></span>
          <span>PIDs: <strong className="text-slate-600">{s.pids || 0}</strong></span>
          <span>{history.length} samples</span>
        </div>
      </div>

      {/* 4-panel chart grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard
          title="CPU Usage" icon={Cpu}
          current={`${s.cpu_percent?.toFixed(1) || 0}%`}
          color="#3b82f6" data={history} dataKey="cpu_percent" unit="%" domain={[0, "auto"]}
        />
        <ChartCard
          title="Memory Usage" icon={MemoryStick}
          current={`${formatBytes(s.memory_usage_mb || 0)} / ${formatBytes(s.memory_limit_mb || 0)} (${s.memory_percent?.toFixed(1) || 0}%)`}
          color="#a855f7" data={history} dataKey="memory_percent" unit="%" domain={[0, 100]}
        />
        <ChartCard
          title="Network I/O (cumulative)" icon={Network}
          current={`↓ ${formatBytes(s.network_rx_mb || 0)}  ↑ ${formatBytes(s.network_tx_mb || 0)}`}
          color="#10b981" secondColor="#f59e0b"
          data={history} dataKey="network_rx_mb" secondDataKey="network_tx_mb" unit=" MB"
          legend={["Received", "Sent"]}
        />
        <ChartCard
          title="Disk I/O (cumulative)" icon={HardDrive}
          current={`Read: ${formatBytes(s.disk_read_mb || 0)}  Write: ${formatBytes(s.disk_write_mb || 0)}`}
          color="#06b6d4" secondColor="#f97316"
          data={history} dataKey="disk_read_mb" secondDataKey="disk_write_mb" unit=" MB"
          legend={["Read", "Write"]}
        />
      </div>
    </div>
  );
}

function ChartCard({ title, icon: Icon, current, color, secondColor, data, dataKey, secondDataKey, unit, domain, legend }) {
  const g1 = `g-${dataKey}`;
  const g2 = secondDataKey ? `g-${secondDataKey}` : null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <Icon size={12} className="text-slate-500" />
          <span className="text-xs font-bold text-slate-700">{title}</span>
        </div>
        <span className="text-[10px] text-slate-500 font-medium">{current}</span>
      </div>
      <div style={{ height: 150 }}>
        {data.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={g1} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
                {g2 && <linearGradient id={g2} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={secondColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={secondColor} stopOpacity={0.02} />
                </linearGradient>}
              </defs>
              <XAxis dataKey="time" tick={{ fontSize: 9 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9 }} domain={domain || [0, "auto"]} width={40} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ fontSize: 10, borderRadius: 8, border: "1px solid #e2e8f0", padding: "4px 8px" }}
                formatter={(v, name) => {
                  const label = legend ? (name === dataKey ? legend[0] : legend[1]) : title;
                  return [`${Number(v).toFixed(2)}${unit || ""}`, label];
                }}
              />
              <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#${g1})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              {secondDataKey && <Area type="monotone" dataKey={secondDataKey} stroke={secondColor} fill={`url(#${g2})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-[10px] text-slate-400">
            Collecting data... (samples every 10s)
          </div>
        )}
      </div>
      {legend && data.length > 1 && (
        <div className="flex items-center justify-center gap-3 mt-1">
          <span className="flex items-center gap-1 text-[9px] text-slate-500"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} /> {legend[0]}</span>
          <span className="flex items-center gap-1 text-[9px] text-slate-500"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: secondColor }} /> {legend[1]}</span>
        </div>
      )}
    </div>
  );
}
