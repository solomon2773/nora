import { useEffect, useState } from "react";
import { fetchWithAuth } from "../../lib/api";
import {
  Activity,
  AlertTriangle,
  Brain,
  Clock,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  Shield,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import dynamic from "next/dynamic";

const MetricsAreaChart = dynamic(() => import("./MetricsAreaChart"), { ssr: false });

const RANGE_OPTIONS = [
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
];

const EMPTY_CAPABILITIES = {
  cpu: false,
  memory: false,
  network: false,
  disk: false,
  pids: false,
};

function formatUptime(seconds) {
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatBytes(mb) {
  if (mb == null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(mb * 1024).toFixed(0)} KB`;
}

function formatRate(rate) {
  if (rate == null) return "—";
  return `${rate.toFixed(2)} MB/s`;
}

function formatBackendLabel(backendType) {
  switch (backendType) {
    case "nemoclaw":
      return "NemoClaw";
    case "proxmox":
      return "Proxmox";
    case "k8s":
    case "kubernetes":
      return "Kubernetes";
    default:
      return "Docker";
  }
}

function fmtTime(iso, range) {
  const date = new Date(iso);
  if (range === "7d") {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  if (range === "3d") {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  if (["6h", "24h"].includes(range)) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function rangeWindowMs(range) {
  switch (range) {
    case "5m":
      return 5 * 60 * 1000;
    case "30m":
      return 30 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "6h":
      return 6 * 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "3d":
      return 3 * 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeChartSample(sample, range) {
  return {
    recorded_at: sample.recorded_at,
    time: fmtTime(sample.recorded_at, range),
    cpu_percent: toNumberOrNull(sample.cpu_percent),
    memory_percent: toNumberOrNull(sample.memory_percent),
    memory_usage_mb: toNumberOrNull(sample.memory_usage_mb),
    memory_limit_mb: toNumberOrNull(sample.memory_limit_mb),
    network_rx_mb: toNumberOrNull(sample.network_rx_mb),
    network_tx_mb: toNumberOrNull(sample.network_tx_mb),
    disk_read_mb: toNumberOrNull(sample.disk_read_mb),
    disk_write_mb: toNumberOrNull(sample.disk_write_mb),
    network_rx_rate_mbps: toNumberOrNull(sample.network_rx_rate_mbps),
    network_tx_rate_mbps: toNumberOrNull(sample.network_tx_rate_mbps),
    disk_read_rate_mbps: toNumberOrNull(sample.disk_read_rate_mbps),
    disk_write_rate_mbps: toNumberOrNull(sample.disk_write_rate_mbps),
    pids: toNumberOrNull(sample.pids),
  };
}

function normalizeHistory(samples, range) {
  return (samples || []).map((sample) => normalizeChartSample(sample, range));
}

function mergeHistorySamples(previous, nextSamples) {
  const merged = new Map();

  for (const sample of previous) {
    if (sample?.recorded_at) {
      merged.set(sample.recorded_at, sample);
    }
  }

  for (const sample of nextSamples) {
    if (sample?.recorded_at) {
      merged.set(sample.recorded_at, sample);
    }
  }

  return [...merged.values()].sort((left, right) => {
    const leftAt = new Date(left.recorded_at).getTime();
    const rightAt = new Date(right.recorded_at).getTime();
    return leftAt - rightAt;
  });
}

function appendHistorySample(previous, sample, range) {
  if (!sample?.recorded_at) return previous;

  const nextSample = normalizeChartSample(sample, range);
  const cutoff = Date.now() - rangeWindowMs(range);
  const deduped = previous.filter((entry) => entry.recorded_at !== nextSample.recorded_at);

  return [...deduped, nextSample]
    .filter((entry) => {
      const timestamp = new Date(entry.recorded_at).getTime();
      return Number.isFinite(timestamp) ? timestamp >= cutoff : true;
    })
    .slice(-2000);
}

async function readJsonOrThrow(url, message) {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    let detail = message;
    try {
      const data = await response.json();
      detail = data.error || data.details || message;
    } catch {
      // Ignore non-JSON errors and keep the fallback message.
    }
    throw new Error(detail);
  }
  return response.json();
}

export default function MetricsTab({ agentId }) {
  const [stats, setStats] = useState(null);
  const [meta, setMeta] = useState({
    backend_type: null,
    capabilities: EMPTY_CAPABILITIES,
  });
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState("15m");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [streamState, setStreamState] = useState("connecting");

  useEffect(() => {
    if (!agentId) return undefined;

    let cancelled = false;
    let socket = null;
    let poller = null;

    async function refreshMetrics({ resetLoading = false } = {}) {
      if (resetLoading) {
        setLoading(true);
        setError(null);
        setStreamState("connecting");
      }

      const [currentData, historyData] = await Promise.all([
        readJsonOrThrow(`/api/agents/${agentId}/stats`, "Cannot fetch current metrics"),
        readJsonOrThrow(`/api/agents/${agentId}/stats/history?range=${range}`, "Cannot fetch metric history"),
      ]);

      if (cancelled) return;

      setStats(currentData);
      setError(currentData.error || null);
      setMeta({
        backend_type: currentData.backend_type || historyData.backend_type || null,
        capabilities: currentData.capabilities || historyData.capabilities || EMPTY_CAPABILITIES,
      });
      const nextHistory = normalizeHistory(historyData.samples || [], range);
      setHistory((previous) =>
        resetLoading ? nextHistory : mergeHistorySamples(previous, nextHistory)
      );
    }

    async function loadMetrics() {
      try {
        await refreshMetrics({ resetLoading: true });
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message || "Cannot fetch metrics");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }

      if (cancelled || typeof window === "undefined") {
        return;
      }

      const token = localStorage.getItem("token");
      if (!token) {
        setStreamState("disconnected");
        return;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/api/ws/metrics/${agentId}?token=${token}`
      );

      socket.onopen = () => {
        if (!cancelled) {
          setStreamState("connected");
        }
      };

      socket.onmessage = (event) => {
        if (cancelled) return;

        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot" && message.payload) {
            setStreamState("connected");
            setStats(message.payload);
            setError(message.payload.error || null);
            setMeta({
              backend_type: message.payload.backend_type || null,
              capabilities: message.payload.capabilities || EMPTY_CAPABILITIES,
            });
            setHistory((previous) =>
              appendHistorySample(previous, message.payload.current, range)
            );
            return;
          }

          if (message.type === "error") {
            setStreamState("disconnected");
            setError(message.message || "Metrics stream disconnected");
          }
        } catch {
          setStreamState("disconnected");
          setError("Received an invalid metrics update");
        }
      };

      socket.onerror = () => {
        if (!cancelled) {
          setStreamState("disconnected");
        }
      };

      socket.onclose = () => {
        if (!cancelled) {
          setStreamState("disconnected");
        }
      };

      poller = setInterval(() => {
        refreshMetrics().catch((pollError) => {
          if (!cancelled) {
            setError(pollError.message || "Cannot refresh metrics");
          }
        });
      }, 15000);
    }

    loadMetrics();

    return () => {
      cancelled = true;
      if (poller) {
        clearInterval(poller);
      }
      if (socket) {
        socket.close();
      }
    };
  }, [agentId, range]);

  const capabilities = stats?.capabilities || meta.capabilities || EMPTY_CAPABILITIES;
  const current = stats?.current || {};
  const backendLabel = formatBackendLabel(stats?.backend_type || meta.backend_type);
  const liveError = error || stats?.error || null;
  const liveStateLabel = streamState === "connected" ? "Live" : "Offline";
  const liveStateClass =
    streamState === "connected"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : "bg-slate-100 text-slate-500 border-slate-200";

  if (loading && !stats && history.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-blue-500" size={24} />
      </div>
    );
  }

  if (liveError && !stats && history.length === 0) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 flex items-center gap-3">
        <AlertTriangle size={20} className="text-red-500 shrink-0" />
        <div>
          <p className="text-sm font-bold text-red-700">Cannot fetch metrics</p>
          <p className="text-xs text-red-500 mt-1">{liveError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500 font-medium">Time Range:</span>
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setRange(option.value)}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all ${
                  range === option.value
                    ? "bg-white text-blue-600 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="px-2.5 py-1 rounded-full border text-[10px] font-bold bg-white text-slate-600 border-slate-200">
            {backendLabel}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400 flex-wrap">
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border font-bold ${liveStateClass}`}>
            <Activity size={10} />
            {liveStateLabel}
          </span>
          <span>
            <Clock size={10} className="inline mr-1" />
            Uptime: <strong className="text-slate-600">{formatUptime(current.uptime_seconds)}</strong>
          </span>
          <span>
            PIDs:{" "}
            <strong className="text-slate-600">
              {capabilities.pids ? current.pids ?? 0 : "Unavailable"}
            </strong>
          </span>
          <span>{history.length} samples</span>
        </div>
      </div>

      {liveError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-amber-800">Showing last available telemetry</p>
            <p className="text-[11px] text-amber-700 mt-1">{liveError}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard
          title="CPU Usage"
          icon={Cpu}
          available={capabilities.cpu}
          current={capabilities.cpu && current.cpu_percent != null ? `${current.cpu_percent.toFixed(1)}%` : "Unavailable"}
          color="#3b82f6"
          data={history}
          dataKey="cpu_percent"
          unit="%"
          domain={[0, "auto"]}
        />
        <ChartCard
          title="Memory Usage"
          icon={MemoryStick}
          available={capabilities.memory}
          current={
            capabilities.memory && current.memory_usage_mb != null
              ? `${formatBytes(current.memory_usage_mb)} / ${formatBytes(current.memory_limit_mb)} (${(current.memory_percent || 0).toFixed(1)}%)`
              : "Unavailable"
          }
          color="#0f766e"
          data={history}
          dataKey="memory_percent"
          unit="%"
          domain={[0, 100]}
        />
        <ChartCard
          title="Network Throughput"
          icon={Network}
          available={capabilities.network}
          current={
            capabilities.network
              ? `↓ ${formatRate(current.network_rx_rate_mbps)}  ↑ ${formatRate(current.network_tx_rate_mbps)}`
              : "Unavailable"
          }
          secondary={
            capabilities.network
              ? `Totals ↓ ${formatBytes(current.network_rx_mb)}  ↑ ${formatBytes(current.network_tx_mb)}`
              : null
          }
          color="#10b981"
          secondColor="#f59e0b"
          data={history}
          dataKey="network_rx_rate_mbps"
          secondDataKey="network_tx_rate_mbps"
          unit=" MB/s"
          legend={["Received", "Sent"]}
        />
        <ChartCard
          title="Disk Throughput"
          icon={HardDrive}
          available={capabilities.disk}
          current={
            capabilities.disk
              ? `Read ${formatRate(current.disk_read_rate_mbps)}  Write ${formatRate(current.disk_write_rate_mbps)}`
              : "Unavailable"
          }
          secondary={
            capabilities.disk
              ? `Totals ${formatBytes(current.disk_read_mb)} read  ${formatBytes(current.disk_write_mb)} write`
              : null
          }
          color="#06b6d4"
          secondColor="#f97316"
          data={history}
          dataKey="disk_read_rate_mbps"
          secondDataKey="disk_write_rate_mbps"
          unit=" MB/s"
          legend={["Read", "Write"]}
        />
      </div>

      {stats?.nemo && <NemoSummaryPanel nemo={stats.nemo} />}
    </div>
  );
}

function ChartCard({
  title,
  icon: Icon,
  current,
  secondary,
  color,
  secondColor,
  data,
  dataKey,
  secondDataKey,
  unit,
  domain,
  legend,
  available,
}) {
  const hasValues = data.some(
    (entry) => entry[dataKey] != null || (secondDataKey && entry[secondDataKey] != null)
  );

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-1.5">
          <Icon size={12} className="text-slate-500 shrink-0" />
          <span className="text-xs font-bold text-slate-700">{title}</span>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-slate-600 font-medium">{current}</div>
          {secondary && <div className="text-[9px] text-slate-400 mt-0.5">{secondary}</div>}
        </div>
      </div>
      <div style={{ height: 150 }}>
        {!available ? (
          <div className="flex items-center justify-center h-full text-[10px] text-slate-400">
            Unavailable for this backend
          </div>
        ) : data.length >= 1 && hasValues ? (
          <MetricsAreaChart
            color={color}
            data={data}
            dataKey={dataKey}
            domain={domain}
            legend={legend}
            secondColor={secondColor}
            secondDataKey={secondDataKey}
            title={title}
            unit={unit}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-[10px] text-slate-400">
            Collecting data... (live samples every 5s)
          </div>
        )}
      </div>
      {legend && available && data.length > 1 && hasValues && (
        <div className="flex items-center justify-center gap-3 mt-1">
          <span className="flex items-center gap-1 text-[9px] text-slate-500">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            {legend[0]}
          </span>
          <span className="flex items-center gap-1 text-[9px] text-slate-500">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: secondColor }} />
            {legend[1]}
          </span>
        </div>
      )}
    </div>
  );
}

function NemoSummaryPanel({ nemo }) {
  return (
    <section className="bg-gradient-to-r from-emerald-50 to-cyan-50 border border-emerald-200 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center">
            <ShieldCheck size={18} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-900">NemoClaw Sandbox</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Read-only runtime status for the Nemotron-backed sandbox.
            </p>
          </div>
        </div>
        <span
          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${
            nemo.available
              ? "bg-white text-emerald-700 border-emerald-200"
              : "bg-white text-slate-500 border-slate-200"
          }`}
        >
          {nemo.available ? "Live runtime" : nemo.status || "Unavailable"}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-4">
        <NemoStat
          icon={Brain}
          label="Model"
          value={nemo.model ? nemo.model.replace("nvidia/", "") : "Unknown"}
        />
        <NemoStat
          icon={Wifi}
          label="Inference"
          value={nemo.inferenceConfigured ? "Configured" : "Missing API key"}
        />
        <NemoStat
          icon={Shield}
          label="Policy"
          value={
            nemo.policyActive
              ? `${nemo.policyRuleCount ?? 0} rules active`
              : "Policy inactive"
          }
        />
        <NemoStat
          icon={AlertTriangle}
          label="Approvals"
          value={
            nemo.pendingApprovalsCount
              ? `${nemo.pendingApprovalsCount} pending`
              : "No pending approvals"
          }
        />
      </div>
    </section>
  );
}

function NemoStat({ icon: Icon, label, value }) {
  return (
    <div className="bg-white/80 border border-white rounded-xl px-3 py-3">
      <div className="flex items-center gap-2">
        <Icon size={13} className="text-emerald-600 shrink-0" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {label}
        </span>
      </div>
      <p className="text-xs font-bold text-slate-800 mt-2">{value}</p>
    </div>
  );
}
