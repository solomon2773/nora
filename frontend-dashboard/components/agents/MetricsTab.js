import { useState, useEffect } from "react";
import { fetchWithAuth } from "../../lib/api";
import {
  MessageSquare, Zap, AlertTriangle, DollarSign, Clock, Loader2
} from "lucide-react";
import dynamic from "next/dynamic";

// Lazy-load recharts to avoid SSR issues
const AreaChart = dynamic(() => import("recharts").then(m => m.AreaChart), { ssr: false });
const BarChart = dynamic(() => import("recharts").then(m => m.BarChart), { ssr: false });
const Area = dynamic(() => import("recharts").then(m => m.Area), { ssr: false });
const Bar = dynamic(() => import("recharts").then(m => m.Bar), { ssr: false });
const XAxis = dynamic(() => import("recharts").then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import("recharts").then(m => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import("recharts").then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import("recharts").then(m => m.ResponsiveContainer), { ssr: false });

export default function MetricsTab({ agentId }) {
  const [metrics, setMetrics] = useState([]);
  const [summary, setSummary] = useState({});
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentId) return;
    Promise.all([
      fetchWithAuth(`/api/agents/${agentId}/metrics`).then(r => r.ok ? r.json() : []),
      fetchWithAuth(`/api/agents/${agentId}/metrics/summary`).then(r => r.ok ? r.json() : {}),
      fetchWithAuth(`/api/agents/${agentId}/cost`).then(r => r.ok ? r.json() : null),
    ])
      .then(([m, s, c]) => { setMetrics(m); setSummary(s); setCost(c); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-blue-500" size={24} />
      </div>
    );
  }

  // Build chart data from hourly buckets
  const messagesData = metrics
    .filter(m => m.metric_type === "messages_sent")
    .map(m => ({ time: formatHour(m.bucket), messages: parseFloat(m.total) }));

  const tokensData = metrics
    .filter(m => m.metric_type === "tokens_used")
    .map(m => ({ time: formatHour(m.bucket), tokens: parseFloat(m.total) }));

  const errorsData = metrics
    .filter(m => m.metric_type === "error")
    .map(m => ({ time: formatHour(m.bucket), errors: parseFloat(m.total) }));

  const totalMessages = summary.messages_sent?.total || 0;
  const totalTokens = summary.tokens_used?.total || 0;
  const totalErrors = summary.error?.total || 0;
  const errorRate = totalMessages > 0 ? ((totalErrors / totalMessages) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={MessageSquare}
          label="Messages (24h)"
          value={totalMessages}
          color="text-blue-600"
          bg="bg-blue-50"
        />
        <StatCard
          icon={Zap}
          label="Tokens Used"
          value={formatNumber(totalTokens)}
          color="text-emerald-600"
          bg="bg-emerald-50"
        />
        <StatCard
          icon={AlertTriangle}
          label="Error Rate"
          value={`${errorRate}%`}
          color="text-red-600"
          bg="bg-red-50"
        />
        {cost && (
          <StatCard
            icon={DollarSign}
            label="Est. Cost"
            value={`$${cost.total_cost}`}
            color="text-purple-600"
            bg="bg-purple-50"
            subtitle={`${cost.uptime_hours}h uptime`}
          />
        )}
        {!cost && (
          <StatCard
            icon={Clock}
            label="Uptime"
            value="—"
            color="text-slate-600"
            bg="bg-slate-50"
          />
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Messages Over Time" isEmpty={messagesData.length === 0}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={messagesData}>
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Area type="monotone" dataKey="messages" stroke="#3b82f6" fill="#dbeafe" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Tokens Per Hour" isEmpty={tokensData.length === 0}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={tokensData}>
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="tokens" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {errorsData.length > 0 && (
          <ChartCard title="Errors Over Time" isEmpty={false}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={errorsData}>
                <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="errors" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* Cost Breakdown */}
      {cost && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <h3 className="text-sm font-bold text-slate-900 mb-4">Cost Breakdown</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-slate-400 font-bold uppercase">Compute</p>
              <p className="text-lg font-black text-slate-900">${cost.compute_cost}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 font-bold uppercase">Tokens</p>
              <p className="text-lg font-black text-slate-900">${cost.token_cost}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 font-bold uppercase">Total</p>
              <p className="text-lg font-black text-blue-600">${cost.total_cost}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color, bg, subtitle }) {
  return (
    <div className={`${bg} border border-slate-200 rounded-2xl p-4`}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={color} />
        <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">{label}</span>
      </div>
      <p className="text-xl font-black text-slate-900">{value}</p>
      {subtitle && <p className="text-[10px] text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function ChartCard({ title, children, isEmpty }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <h3 className="text-sm font-bold text-slate-900 mb-3">{title}</h3>
      {isEmpty ? (
        <div className="flex items-center justify-center h-[200px] text-slate-400 text-xs">
          No data yet — metrics appear after first usage
        </div>
      ) : children}
    </div>
  );
}

function formatHour(bucket) {
  if (!bucket) return "";
  const d = new Date(bucket);
  return `${d.getHours().toString().padStart(2, "0")}:00`;
}

function formatNumber(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
