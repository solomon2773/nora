import Link from "next/link";
import { useRouter } from "next/router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  Clock3,
  Cpu,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import AdminLayout from "../../components/AdminLayout";
import LogViewer from "../../components/LogViewer";
import MetricCard from "../../components/MetricCard";
import StatusBadge from "../../components/StatusBadge";
import { useToast } from "../../components/Toast";
import { fetchWithAuth } from "../../lib/api";
import {
  formatDateTime,
  formatDurationSeconds,
  formatMemoryMb,
  formatPercent,
  formatRateMb,
  formatShortId,
} from "../../lib/format";

function ActionButton({
  label,
  icon: Icon,
  tone = "slate",
  loading = false,
  disabled = false,
  onClick,
}) {
  const tones = {
    slate: "border-slate-200 text-slate-700 hover:bg-slate-50",
    blue: "border-blue-100 text-blue-700 hover:bg-blue-50",
    red: "border-red-100 text-red-700 hover:bg-red-50",
    orange: "border-orange-100 text-orange-700 hover:bg-orange-50",
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${tones[tone] || tones.slate}`}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {label}
    </button>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="rounded-[1.25rem] bg-slate-50 px-4 py-4">
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}

export default function FleetAgentDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const [agent, setAgent] = useState(null);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const logHistoryRef = useRef([]);
  const toast = useToast();
  const actionMessages = {
    start: "Agent started",
    stop: "Agent stopped",
    restart: "Agent restarted",
    redeploy: "Agent requeued for deploy",
  };

  const loadAgent = useCallback(async () => {
    if (!id) return;

    try {
      setErrorMessage("");
      const [agentRes, statsRes, historyRes] = await Promise.all([
        fetchWithAuth(`/api/admin/agents/${id}`),
        fetchWithAuth(`/api/admin/agents/${id}/stats`),
        fetchWithAuth(`/api/admin/agents/${id}/stats/history?range=1h`),
      ]);

      if (agentRes.status === 404) {
        setAgent(null);
        return;
      }

      if (!agentRes.ok) {
        const payload = await agentRes.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to load agent");
      }

      const agentPayload = await agentRes.json();
      setAgent(agentPayload);

      if (statsRes.ok) {
        setStats(await statsRes.json());
      } else {
        setStats(null);
      }

      if (historyRes.ok) {
        setHistory(await historyRes.json());
      } else {
        setHistory(null);
      }
    } catch (error) {
      console.error("Failed to load admin fleet detail:", error);
      setErrorMessage(error.message || "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  useEffect(() => {
    if (!id || loading) return undefined;
    const isTransient =
      agent && (agent.status === "queued" || agent.status === "deploying");
    const intervalId = setInterval(loadAgent, isTransient ? 5000 : 15000);
    return () => clearInterval(intervalId);
  }, [agent, id, loadAgent, loading]);

  async function runAction(action) {
    if (!id || !agent) return;

    if (
      action === "delete" &&
      !window.confirm(
        `Delete ${agent.name}? This permanently removes the agent and its runtime.`
      )
    ) {
      return;
    }

    const endpoint =
      action === "start"
        ? `/api/admin/agents/${id}/start`
        : action === "stop"
        ? `/api/admin/agents/${id}/stop`
        : action === "restart"
        ? `/api/admin/agents/${id}/restart`
        : action === "redeploy"
        ? `/api/admin/agents/${id}/redeploy`
        : `/api/admin/agents/${id}`;

    const method = action === "delete" ? "DELETE" : "POST";

    setActionLoading(action);
    try {
      const response = await fetchWithAuth(endpoint, { method });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Failed to ${action} agent`);
      }

      if (action === "delete") {
        toast.success("Agent deleted");
        router.push("/fleet");
        return;
      }

      toast.success(actionMessages[action] || "Agent updated");
      loadAgent();
    } catch (error) {
      console.error(`Failed to ${action} agent:`, error);
      toast.error(error.message || `Failed to ${action} agent`);
    } finally {
      setActionLoading("");
    }
  }

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex h-80 items-center justify-center rounded-[2rem] border border-slate-200 bg-white shadow-sm">
          <Loader2 size={32} className="animate-spin text-red-500" />
        </div>
      </AdminLayout>
    );
  }

  if (!agent) {
    return (
      <AdminLayout>
        <div className="flex h-80 flex-col items-center justify-center rounded-[2rem] border border-slate-200 bg-white text-center shadow-sm">
          <p className="text-lg font-black text-slate-950">Agent not found</p>
          <Link
            href="/fleet"
            className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-red-600"
          >
            <ArrowLeft size={15} />
            Back to fleet
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const current = stats?.current || {};
  const historySamples = Array.isArray(history?.samples)
    ? history.samples.slice(-8).reverse()
    : [];

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-5">
          <Link
            href="/fleet"
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-800"
          >
            <ArrowLeft size={15} />
            Back to fleet
          </Link>

          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
                Fleet Detail
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                {agent.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <StatusBadge status={agent.status} />
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  Owner {agent.ownerEmail || "unknown"}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  {agent.backend_type || "docker"} · {agent.node || "node n/a"}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  {formatShortId(agent.id)}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <ActionButton
                label="Start"
                icon={Play}
                tone="blue"
                loading={actionLoading === "start"}
                disabled={!agent.container_id || agent.status === "running"}
                onClick={() => runAction("start")}
              />
              <ActionButton
                label="Stop"
                icon={Square}
                tone="slate"
                loading={actionLoading === "stop"}
                disabled={!["running", "warning"].includes(agent.status)}
                onClick={() => runAction("stop")}
              />
              <ActionButton
                label="Restart"
                icon={RefreshCw}
                tone="blue"
                loading={actionLoading === "restart"}
                disabled={!agent.container_id}
                onClick={() => runAction("restart")}
              />
              <ActionButton
                label="Redeploy"
                icon={RotateCcw}
                tone="orange"
                loading={actionLoading === "redeploy"}
                disabled={!["warning", "error", "stopped"].includes(agent.status)}
                onClick={() => runAction("redeploy")}
              />
              <ActionButton
                label="Delete"
                icon={Trash2}
                tone="red"
                loading={actionLoading === "delete"}
                onClick={() => runAction("delete")}
              />
            </div>
          </div>
        </header>

        {errorMessage ? (
          <div className="rounded-[1.5rem] border border-red-100 bg-red-50 px-4 py-4 text-sm font-semibold text-red-800">
            {errorMessage}
          </div>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="CPU"
            value={formatPercent(current.cpu_percent)}
            icon={Cpu}
            tone="blue"
            caption="Latest sampled CPU usage"
          />
          <MetricCard
            label="Memory"
            value={formatMemoryMb(current.memory_usage_mb)}
            icon={HardDrive}
            tone="emerald"
            caption={`Limit ${formatMemoryMb(current.memory_limit_mb)}`}
          />
          <MetricCard
            label="Network Rate"
            value={formatRateMb(current.network_rx_rate_mbps)}
            icon={ArrowLeftRight}
            tone="purple"
            caption={`TX ${formatRateMb(current.network_tx_rate_mbps)}`}
          />
          <MetricCard
            label="Uptime"
            value={formatDurationSeconds(current.uptime_seconds)}
            icon={Clock3}
            tone="orange"
            caption={`PIDs ${current.pids ?? "—"}`}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
          <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              Runtime metadata
            </h2>
            <p className="mt-1 text-sm font-medium text-slate-500">
              Last-known ownership and runtime placement details.
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <InfoRow label="Owner" value={agent.ownerEmail || "Unknown"} />
              <InfoRow
                label="Created"
                value={formatDateTime(agent.created_at)}
              />
              <InfoRow
                label="Backend / Node"
                value={`${agent.backend_type || "docker"} · ${agent.node || "node n/a"}`}
              />
              <InfoRow
                label="Container"
                value={agent.container_id || "No active container"}
              />
              <InfoRow
                label="Runtime Host"
                value={
                  agent.runtime_host && agent.runtime_port
                    ? `${agent.runtime_host}:${agent.runtime_port}`
                    : "Unavailable"
                }
              />
              <InfoRow
                label="Gateway"
                value={
                  agent.gateway_host && agent.gateway_port
                    ? `${agent.gateway_host}:${agent.gateway_port}`
                    : "Unavailable"
                }
              />
            </div>
          </section>

          <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              Recent telemetry samples
            </h2>
            <p className="mt-1 text-sm font-medium text-slate-500">
              Latest 1h samples from the container telemetry pipeline.
            </p>

            <div className="mt-6 overflow-x-auto">
              {historySamples.length === 0 ? (
                <div className="flex h-48 items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-sm font-medium text-slate-400">
                  No telemetry samples available yet.
                </div>
              ) : (
                <table className="min-w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Time
                      </th>
                      <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        CPU
                      </th>
                      <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        Memory
                      </th>
                      <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        RX / TX
                      </th>
                      <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                        PIDs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {historySamples.map((sample) => (
                      <tr
                        key={sample.recorded_at}
                        className="border-b border-slate-100 last:border-b-0"
                      >
                        <td className="px-2 py-4 text-sm font-medium text-slate-600">
                          {formatDateTime(sample.recorded_at)}
                        </td>
                        <td className="px-2 py-4 text-sm font-semibold text-slate-900">
                          {formatPercent(sample.cpu_percent)}
                        </td>
                        <td className="px-2 py-4 text-sm font-semibold text-slate-900">
                          {formatMemoryMb(sample.memory_usage_mb)}
                        </td>
                        <td className="px-2 py-4 text-sm font-semibold text-slate-900">
                          {formatRateMb(sample.network_rx_rate_mbps)} / {formatRateMb(sample.network_tx_rate_mbps)}
                        </td>
                        <td className="px-2 py-4 text-sm font-semibold text-slate-900">
                          {sample.pids ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-col gap-1">
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              Live runtime logs
            </h2>
            <p className="text-sm font-medium text-slate-500">
              Direct websocket log stream for admin diagnosis.
            </p>
          </div>

          <LogViewer agentId={agent.id} historyRef={logHistoryRef} />
        </section>
      </div>
    </AdminLayout>
  );
}
