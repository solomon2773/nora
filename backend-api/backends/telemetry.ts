// @ts-nocheck
const DEFAULT_CAPABILITIES = Object.freeze({
  cpu: false,
  memory: false,
  network: false,
  disk: false,
  pids: false,
});

const DOCKER_CAPABILITIES = Object.freeze({
  cpu: true,
  memory: true,
  network: true,
  disk: true,
  pids: true,
});

const PROXMOX_DEFAULT_CAPABILITIES = Object.freeze({
  cpu: true,
  memory: true,
  network: true,
  disk: true,
  pids: false,
});

function toFiniteNumber(value) {
  const parsed =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteInteger(value) {
  const parsed = toFiniteNumber(value);
  return parsed == null ? null : Math.round(parsed);
}

function roundMetric(value, digits = 2) {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function bytesToMegabytes(value, digits = 2) {
  const parsed = toFiniteNumber(value);
  if (parsed == null) return null;
  return roundMetric(parsed / 1024 / 1024, digits);
}

function normalizeRecordedAt(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeCapabilities(capabilities = {}) {
  return {
    cpu: Boolean(capabilities.cpu),
    memory: Boolean(capabilities.memory),
    network: Boolean(capabilities.network),
    disk: Boolean(capabilities.disk),
    pids: Boolean(capabilities.pids),
  };
}

function normalizeCurrentSample(sample = {}) {
  return {
    recorded_at: normalizeRecordedAt(sample.recorded_at),
    running: Boolean(sample.running),
    uptime_seconds: toFiniteInteger(sample.uptime_seconds) ?? 0,
    cpu_percent: roundMetric(sample.cpu_percent),
    memory_usage_mb: roundMetric(sample.memory_usage_mb),
    memory_limit_mb: roundMetric(sample.memory_limit_mb),
    memory_percent: roundMetric(sample.memory_percent),
    network_rx_mb: roundMetric(sample.network_rx_mb),
    network_tx_mb: roundMetric(sample.network_tx_mb),
    disk_read_mb: roundMetric(sample.disk_read_mb),
    disk_write_mb: roundMetric(sample.disk_write_mb),
    network_rx_rate_mbps: roundMetric(sample.network_rx_rate_mbps, 3),
    network_tx_rate_mbps: roundMetric(sample.network_tx_rate_mbps, 3),
    disk_read_rate_mbps: roundMetric(sample.disk_read_rate_mbps, 3),
    disk_write_rate_mbps: roundMetric(sample.disk_write_rate_mbps, 3),
    pids: toFiniteInteger(sample.pids),
  };
}

function buildTelemetry({ backendType = "unknown", capabilities = {}, current = {} } = {}) {
  return {
    backend_type: backendType,
    capabilities: normalizeCapabilities({
      ...DEFAULT_CAPABILITIES,
      ...capabilities,
    }),
    current: normalizeCurrentSample(current),
  };
}

function buildUnavailableTelemetry({
  backendType = "unknown",
  running = false,
  uptime_seconds = 0,
  capabilities = DEFAULT_CAPABILITIES,
} = {}) {
  return buildTelemetry({
    backendType,
    capabilities,
    current: {
      running,
      uptime_seconds,
    },
  });
}

function uptimeFromContainerInfo(info) {
  const startedAt = info?.State?.StartedAt
    ? new Date(info.State.StartedAt).getTime()
    : 0;
  if (!info?.State?.Running || !startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function sumDockerNetworkBytes(stats) {
  let received = 0;
  let transmitted = 0;

  for (const iface of Object.values(stats?.networks || {})) {
    received += iface?.rx_bytes || 0;
    transmitted += iface?.tx_bytes || 0;
  }

  return { received, transmitted };
}

function sumDockerDiskBytes(stats) {
  let read = 0;
  let write = 0;

  for (const entry of stats?.blkio_stats?.io_service_bytes_recursive || []) {
    if (entry?.op === "read" || entry?.op === "Read") read += entry.value || 0;
    if (entry?.op === "write" || entry?.op === "Write") write += entry.value || 0;
  }

  return { read, write };
}

function dockerCpuPercent(stats) {
  const cpuDelta =
    (stats?.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta =
    (stats?.cpu_stats?.system_cpu_usage || 0) -
    (stats?.precpu_stats?.system_cpu_usage || 0);
  const cpuCount =
    stats?.cpu_stats?.online_cpus ||
    stats?.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    1;

  if (systemDelta <= 0) return 0;
  return roundMetric((cpuDelta / systemDelta) * cpuCount * 100);
}

function buildDockerTelemetry({ stats, info, backendType = "docker" }) {
  const memUsage = stats?.memory_stats?.usage || 0;
  const memCache = stats?.memory_stats?.stats?.cache || 0;
  const memActual = Math.max(0, memUsage - memCache);
  const memLimit = stats?.memory_stats?.limit || 0;
  const network = sumDockerNetworkBytes(stats);
  const disk = sumDockerDiskBytes(stats);

  return buildTelemetry({
    backendType,
    capabilities: DOCKER_CAPABILITIES,
    current: {
      recorded_at: new Date().toISOString(),
      running: Boolean(info?.State?.Running),
      uptime_seconds: uptimeFromContainerInfo(info),
      cpu_percent: dockerCpuPercent(stats),
      memory_usage_mb: bytesToMegabytes(memActual, 0),
      memory_limit_mb: bytesToMegabytes(memLimit, 0),
      memory_percent:
        memLimit > 0 ? roundMetric((memActual / memLimit) * 100) : 0,
      network_rx_mb: bytesToMegabytes(network.received),
      network_tx_mb: bytesToMegabytes(network.transmitted),
      disk_read_mb: bytesToMegabytes(disk.read),
      disk_write_mb: bytesToMegabytes(disk.write),
      pids: stats?.pids_stats?.current,
    },
  });
}

module.exports = {
  DEFAULT_CAPABILITIES,
  DOCKER_CAPABILITIES,
  PROXMOX_DEFAULT_CAPABILITIES,
  buildDockerTelemetry,
  buildTelemetry,
  buildUnavailableTelemetry,
  bytesToMegabytes,
  normalizeCapabilities,
  normalizeCurrentSample,
  roundMetric,
  toFiniteInteger,
  toFiniteNumber,
  uptimeFromContainerInfo,
};
