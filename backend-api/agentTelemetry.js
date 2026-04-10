const db = require("./db");
const containerManager = require("./containerManager");
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const path = require("path");
const telemetryModulePath = resolveTelemetryModulePath();
const {
  DEFAULT_CAPABILITIES,
  DOCKER_CAPABILITIES,
  PROXMOX_DEFAULT_CAPABILITIES,
  buildUnavailableTelemetry,
  normalizeCapabilities,
  normalizeCurrentSample,
  roundMetric,
  toFiniteInteger,
  toFiniteNumber,
} = require(telemetryModulePath);

function resolveTelemetryModulePath() {
  const localPath = path.resolve(__dirname, "backends", "telemetry");
  const workerPath = path.resolve(__dirname, "../workers/provisioner/backends/telemetry");
  try {
    require.resolve(localPath);
    return localPath;
  } catch {
    return workerPath;
  }
}

const SAMPLE_FIELDS = [
  "cpu_percent",
  "memory_usage_mb",
  "memory_limit_mb",
  "memory_percent",
  "network_rx_mb",
  "network_tx_mb",
  "disk_read_mb",
  "disk_write_mb",
  "network_rx_rate_mbps",
  "network_tx_rate_mbps",
  "disk_read_rate_mbps",
  "disk_write_rate_mbps",
  "pids",
  "recorded_at",
];

const TOTAL_TO_RATE_KEYS = {
  network_rx_mb: "network_rx_rate_mbps",
  network_tx_mb: "network_tx_rate_mbps",
  disk_read_mb: "disk_read_rate_mbps",
  disk_write_mb: "disk_write_rate_mbps",
};

function sampleFieldSql(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return SAMPLE_FIELDS.map((field) => `${prefix}${field}`).join(", ");
}

function defaultCapabilitiesForBackend(backendType) {
  switch ((backendType || "docker").toLowerCase()) {
    case "docker":
    case "nemoclaw":
      return DOCKER_CAPABILITIES;
    case "proxmox":
      return PROXMOX_DEFAULT_CAPABILITIES;
    default:
      return DEFAULT_CAPABILITIES;
  }
}

function hasSupportedMetrics(capabilities = {}) {
  return Object.values(capabilities).some(Boolean);
}

function historyWindowMs(fromTime, toTime) {
  const from = parseTimestamp(fromTime);
  const to = parseTimestamp(toTime);
  if (from == null || to == null || to <= from) return 0;
  return to - from;
}

function historyBucketSeconds(fromTime, toTime) {
  const windowMs = historyWindowMs(fromTime, toTime);

  if (windowMs <= 60 * 60 * 1000) return null;
  if (windowMs <= 6 * 60 * 60 * 1000) return 30;
  if (windowMs <= 24 * 60 * 60 * 1000) return 300;
  if (windowMs <= 3 * 24 * 60 * 60 * 1000) return 900;
  return 3600;
}

function normalizeTelemetry(telemetry, agent = {}) {
  const backendType = telemetry?.backend_type || agent.backend_type || "docker";
  return {
    backend_type: backendType,
    capabilities: normalizeCapabilities({
      ...defaultCapabilitiesForBackend(backendType),
      ...(telemetry?.capabilities || {}),
    }),
    current: normalizeCurrentSample(telemetry?.current || {}),
  };
}

function normalizeHistorySample(sample = {}) {
  return {
    recorded_at: sample.recorded_at
      ? new Date(sample.recorded_at).toISOString()
      : new Date().toISOString(),
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

function maskUnsupportedMetrics(sample, capabilities) {
  const masked = { ...sample };

  if (!capabilities.cpu) masked.cpu_percent = null;
  if (!capabilities.memory) {
    masked.memory_usage_mb = null;
    masked.memory_limit_mb = null;
    masked.memory_percent = null;
  }
  if (!capabilities.network) {
    masked.network_rx_mb = null;
    masked.network_tx_mb = null;
    masked.network_rx_rate_mbps = null;
    masked.network_tx_rate_mbps = null;
  }
  if (!capabilities.disk) {
    masked.disk_read_mb = null;
    masked.disk_write_mb = null;
    masked.disk_read_rate_mbps = null;
    masked.disk_write_rate_mbps = null;
  }
  if (!capabilities.pids) masked.pids = null;

  return masked;
}

function parseTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function deriveLiveRates(currentSample, previousSample) {
  const current = { ...currentSample };
  const currentTime = parseTimestamp(current.recorded_at);
  const previousTime = parseTimestamp(previousSample?.recorded_at);
  const elapsedSeconds =
    currentTime != null && previousTime != null
      ? (currentTime - previousTime) / 1000
      : null;

  for (const [totalKey, rateKey] of Object.entries(TOTAL_TO_RATE_KEYS)) {
    const currentTotal = toFiniteNumber(current[totalKey]);
    if (currentTotal == null) {
      current[rateKey] = null;
      continue;
    }

    const previousTotal = toFiniteNumber(previousSample?.[totalKey]);
    const previousRate = toFiniteNumber(previousSample?.[rateKey]);

    if (elapsedSeconds != null && elapsedSeconds >= 0 && elapsedSeconds < 1) {
      current[rateKey] = roundMetric(previousRate ?? 0, 3);
      continue;
    }

    if (previousTotal == null || elapsedSeconds == null || elapsedSeconds <= 0) {
      current[rateKey] = roundMetric(current[rateKey] ?? 0, 3);
      continue;
    }

    const delta = currentTotal - previousTotal;
    current[rateKey] = roundMetric(delta >= 0 ? delta / elapsedSeconds : 0, 3);
  }

  return current;
}

function fillStaticTotalsFromPrevious(currentSample, previousSample) {
  if (!previousSample) return currentSample;

  const next = { ...currentSample };
  for (const field of [
    "memory_limit_mb",
    "network_rx_mb",
    "network_tx_mb",
    "disk_read_mb",
    "disk_write_mb",
  ]) {
    if (next[field] == null && previousSample[field] != null) {
      next[field] = previousSample[field];
    }
  }

  return next;
}

function numericOrZero(value) {
  return toFiniteNumber(value) ?? 0;
}

function integerOrZero(value) {
  return toFiniteInteger(value) ?? 0;
}

function buildFallbackTelemetry(agent, error = null) {
  const capabilities = defaultCapabilitiesForBackend(agent?.backend_type || "docker");
  const running = ["running", "warning"].includes(agent?.status || "");
  const telemetry = buildUnavailableTelemetry({
    backendType: agent?.backend_type || "docker",
    running,
    capabilities,
  });

  if (error) telemetry.error = error;
  return telemetry;
}

async function fetchLiveTelemetry(agent) {
  if (!agent?.container_id) {
    return buildFallbackTelemetry(agent, "No container assigned");
  }

  try {
    const telemetry = await containerManager.stats(agent);
    return normalizeTelemetry(telemetry, agent);
  } catch (error) {
    return buildFallbackTelemetry(agent, error.message);
  }
}

async function getLatestStoredSample(agentId) {
  const result = await db.query(
    `SELECT ${sampleFieldSql()}
       FROM container_stats
      WHERE agent_id = $1
      ORDER BY recorded_at DESC
      LIMIT 1`,
    [agentId]
  );

  return result.rows[0] ? normalizeHistorySample(result.rows[0]) : null;
}

async function getHistorySamples(agentId, fromTime, toTime) {
  const bucketSeconds = historyBucketSeconds(fromTime, toTime);

  if (!bucketSeconds) {
    const result = await db.query(
      `SELECT ${sampleFieldSql()}
         FROM container_stats
        WHERE agent_id = $1
          AND recorded_at BETWEEN $2 AND $3
        ORDER BY recorded_at ASC
        LIMIT 5000`,
      [agentId, fromTime, toTime]
    );
    return result.rows.map((row) => normalizeHistorySample(row));
  }

  const result = await db.query(
    `SELECT TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM recorded_at) / $4) * $4) AS recorded_at,
            AVG(cpu_percent) AS cpu_percent,
            AVG(memory_usage_mb) AS memory_usage_mb,
            AVG(memory_limit_mb) AS memory_limit_mb,
            AVG(memory_percent) AS memory_percent,
            MAX(network_rx_mb) AS network_rx_mb,
            MAX(network_tx_mb) AS network_tx_mb,
            MAX(disk_read_mb) AS disk_read_mb,
            MAX(disk_write_mb) AS disk_write_mb,
            AVG(network_rx_rate_mbps) AS network_rx_rate_mbps,
            AVG(network_tx_rate_mbps) AS network_tx_rate_mbps,
            AVG(disk_read_rate_mbps) AS disk_read_rate_mbps,
            AVG(disk_write_rate_mbps) AS disk_write_rate_mbps,
            AVG(pids) AS pids
       FROM container_stats
      WHERE agent_id = $1
        AND recorded_at BETWEEN $2 AND $3
      GROUP BY 1
      ORDER BY 1 ASC
      LIMIT 4000`,
    [agentId, fromTime, toTime, bucketSeconds]
  );

  return result.rows.map((row) => normalizeHistorySample(row));
}

function appendOrReplaceCurrentSample(samples, currentSample) {
  if (!currentSample?.recorded_at) return samples;

  const currentAt = parseTimestamp(currentSample.recorded_at);
  if (currentAt == null) return samples;

  if (samples.length === 0) {
    return [currentSample];
  }

  const lastSample = samples[samples.length - 1];
  const lastAt = parseTimestamp(lastSample?.recorded_at);
  if (lastAt == null) {
    return [...samples.slice(0, -1), currentSample];
  }

  if (Math.abs(currentAt - lastAt) <= 1000) {
    return [...samples.slice(0, -1), currentSample];
  }

  if (currentAt > lastAt) {
    return [...samples, currentSample];
  }

  return samples;
}

async function persistTelemetrySample(agentId, telemetry) {
  const current = normalizeCurrentSample(telemetry.current);
  const previous = await getLatestStoredSample(agentId);
  const enriched = deriveLiveRates(current, previous);

  await db.query(
    `INSERT INTO container_stats(
       agent_id,
       cpu_percent,
       memory_usage_mb,
       memory_limit_mb,
       memory_percent,
       network_rx_mb,
       network_tx_mb,
       disk_read_mb,
       disk_write_mb,
       network_rx_rate_mbps,
       network_tx_rate_mbps,
       disk_read_rate_mbps,
       disk_write_rate_mbps,
       pids
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      agentId,
      numericOrZero(enriched.cpu_percent),
      integerOrZero(enriched.memory_usage_mb),
      integerOrZero(enriched.memory_limit_mb),
      numericOrZero(enriched.memory_percent),
      numericOrZero(enriched.network_rx_mb),
      numericOrZero(enriched.network_tx_mb),
      numericOrZero(enriched.disk_read_mb),
      numericOrZero(enriched.disk_write_mb),
      numericOrZero(enriched.network_rx_rate_mbps),
      numericOrZero(enriched.network_tx_rate_mbps),
      numericOrZero(enriched.disk_read_rate_mbps),
      numericOrZero(enriched.disk_write_rate_mbps),
      integerOrZero(enriched.pids),
    ]
  );

  return enriched;
}

async function collectAgentTelemetrySample(agent) {
  const telemetry = await fetchLiveTelemetry(agent);

  if (
    telemetry.error ||
    !telemetry.current.running ||
    !hasSupportedMetrics(telemetry.capabilities)
  ) {
    return null;
  }

  return persistTelemetrySample(agent.id, telemetry);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`Runtime returned ${response.status}`);
  }
  return response.json();
}

async function loadNemoSummary(agent) {
  if (agent?.sandbox_type !== "nemoclaw") {
    return null;
  }

  const summary = {
    sandbox: "nemoclaw",
    available: false,
    status: agent.status,
    model: null,
    inferenceConfigured: false,
    policyActive: false,
    policyRuleCount: null,
    pendingApprovalsCount: 0,
    uptime_seconds: null,
    pid: null,
  };

  const statusUrl = runtimeUrlForAgent(agent, "/nemoclaw/status");
  if (!statusUrl || agent.status !== "running") {
    return summary;
  }

  const policyUrl = runtimeUrlForAgent(agent, "/nemoclaw/policy");
  const approvalsUrl = runtimeUrlForAgent(agent, "/nemoclaw/approvals");
  const [statusResult, policyResult, approvalsResult] = await Promise.allSettled([
    fetchJson(statusUrl),
    fetchJson(policyUrl),
    fetchJson(approvalsUrl),
  ]);

  if (statusResult.status === "fulfilled") {
    summary.available = true;
    summary.model = statusResult.value.model || null;
    summary.inferenceConfigured = Boolean(statusResult.value.inferenceConfigured);
    summary.policyActive = Boolean(statusResult.value.policyActive);
    summary.uptime_seconds = toFiniteInteger(statusResult.value.uptime);
    summary.pid = toFiniteInteger(statusResult.value.pid);
  }

  if (policyResult.status === "fulfilled") {
    const rules = policyResult.value?.network?.rules;
    summary.policyRuleCount = Array.isArray(rules) ? rules.length : 0;
  }

  if (approvalsResult.status === "fulfilled") {
    const approvals = approvalsResult.value?.approvals;
    summary.pendingApprovalsCount = Array.isArray(approvals) ? approvals.length : 0;
  }

  return summary;
}

async function buildAgentStatsResponse(agent, liveTelemetry = null) {
  const telemetry = liveTelemetry
    ? normalizeTelemetry(liveTelemetry, agent)
    : await fetchLiveTelemetry(agent);
  const latest = await getLatestStoredSample(agent.id);
  let current = deriveLiveRates(telemetry.current, latest);
  current = fillStaticTotalsFromPrevious(current, latest);
  current = maskUnsupportedMetrics(current, telemetry.capabilities);

  const response = {
    backend_type: telemetry.backend_type,
    capabilities: telemetry.capabilities,
    current,
  };

  if (telemetry.error) {
    response.error = telemetry.error;
  }

  const nemo = await loadNemoSummary(agent);
  if (nemo) {
    response.nemo = nemo;
  }

  return response;
}

async function buildAgentHistoryResponse(agent, fromTime, toTime) {
  const telemetry = await fetchLiveTelemetry(agent);
  const latestStored = await getLatestStoredSample(agent.id);
  let samples = await getHistorySamples(agent.id, fromTime, toTime);
  let current = deriveLiveRates(telemetry.current, latestStored);
  current = fillStaticTotalsFromPrevious(current, latestStored);
  current = maskUnsupportedMetrics(current, telemetry.capabilities);

  if (telemetry.current.running && hasSupportedMetrics(telemetry.capabilities)) {
    samples = appendOrReplaceCurrentSample(samples, current);
  }

  return {
    backend_type: telemetry.backend_type,
    capabilities: telemetry.capabilities,
    samples: samples.map((row) => maskUnsupportedMetrics(row, telemetry.capabilities)),
  };
}

module.exports = {
  buildAgentHistoryResponse,
  buildAgentStatsResponse,
  collectAgentTelemetrySample,
  defaultCapabilitiesForBackend,
  fetchLiveTelemetry,
  getLatestStoredSample,
  hasSupportedMetrics,
  maskUnsupportedMetrics,
  persistTelemetrySample,
  sampleFieldSql,
};
