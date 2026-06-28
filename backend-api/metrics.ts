// @ts-nocheck
const db = require("./db");
// Lazy OTel handle — required after definition to avoid any load-order coupling;
// otel.ts is fail-open and a no-op when disabled.
let _otel = null;
function otel() {
  if (_otel === null) {
    try {
      _otel = require("./otel");
    } catch {
      _otel = { recordChatExchange() {}, isEnabled: () => false };
    }
  }
  return _otel;
}

/**
 * Record a single metric data point.
 */
async function recordMetric(agentId, userId, metricType, value, metadata = {}) {
  await db.query(
    "INSERT INTO usage_metrics(agent_id, user_id, metric_type, value, metadata) VALUES($1, $2, $3, $4, $5)",
    [agentId, userId, metricType, value, JSON.stringify(metadata)],
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeUsageNumber(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function inferProviderFromModel(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value || !value.includes("/")) return "";
  return value.split("/")[0] || "";
}

function extractTokenUsage(payload = {}, defaults = {}) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  const message = data?.message && typeof data.message === "object" ? data.message : {};
  const response = data?.response && typeof data.response === "object" ? data.response : {};
  const usage =
    data?.usage ||
    message?.usage ||
    response?.usage ||
    result?.usage ||
    result?.message?.usage ||
    {};
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = normalizeUsageNumber(
    firstDefined(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.promptTokens),
  );
  const outputTokens = normalizeUsageNumber(
    firstDefined(
      usage.output_tokens,
      usage.completion_tokens,
      usage.outputTokens,
      usage.completionTokens,
    ),
  );
  const totalTokens =
    normalizeUsageNumber(firstDefined(usage.total_tokens, usage.totalTokens, usage.tokens)) ||
    inputTokens + outputTokens;
  if (!totalTokens) return null;

  const model = firstDefined(
    defaults.model,
    data?.model,
    message?.model,
    response?.model,
    result?.model,
    usage.model,
  );
  const provider =
    firstDefined(
      defaults.provider,
      data?.provider,
      message?.provider,
      response?.provider,
      result?.provider,
      usage.provider,
    ) || inferProviderFromModel(model);

  return {
    totalTokens,
    metadata: {
      ...(model ? { model: String(model) } : {}),
      ...(provider ? { provider: String(provider) } : {}),
      ...(defaults.runtimeFamily ? { runtime_family: String(defaults.runtimeFamily) } : {}),
      ...(defaults.source ? { source: String(defaults.source) } : {}),
      ...(defaults.sessionId ? { session_id: String(defaults.sessionId) } : {}),
      ...(defaults.requestId ? { request_id: String(defaults.requestId) } : {}),
      ...(inputTokens ? { input_tokens: inputTokens } : {}),
      ...(outputTokens ? { output_tokens: outputTokens } : {}),
      total_tokens: totalTokens,
    },
  };
}

async function recordTokenUsage(agentOrId, userId, payload = {}, defaults = {}) {
  const agentId = typeof agentOrId === "object" ? agentOrId?.id : agentOrId;
  if (!agentId || !userId) return null;
  const runtimeFamily =
    defaults.runtimeFamily || (typeof agentOrId === "object" ? agentOrId?.runtime_family : null);
  const sandboxProfile =
    defaults.sandboxProfile || (typeof agentOrId === "object" ? agentOrId?.sandbox_profile : null);
  const usage = extractTokenUsage(payload, { ...defaults, runtimeFamily });
  if (!usage) return null;
  if (sandboxProfile) {
    usage.metadata.sandbox_profile = String(sandboxProfile);
  }
  await recordMetric(agentId, userId, "tokens_used", usage.totalTokens, usage.metadata);
  // Mirror the exchange to the OpenTelemetry GenAI exporter (no-op when
  // disabled; never throws). Cost is estimated in-process from the same pricing
  // as the canonical rollup, so no extra DB round-trip.
  try {
    const m = usage.metadata || {};
    otel().recordChatExchange({
      agentId,
      model: m.model,
      provider: m.provider,
      runtimeFamily,
      sandboxProfile: m.sandbox_profile,
      source: m.source,
      sessionId: m.session_id,
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      totalTokens: usage.totalTokens,
      costUsd: estimateCostUsd({
        model: m.model,
        provider: m.provider,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        totalTokens: usage.totalTokens,
      }),
      startedAtMs: defaults.startedAtMs,
    });
  } catch {
    /* telemetry export is best-effort */
  }
  return usage;
}

/**
 * Get time-bucketed metrics for an agent.
 * Returns hourly aggregates within the given time range.
 */
async function getAgentMetrics(agentId, metricType, since, until) {
  const result = await db.query(
    `SELECT metric_type,
            SUM(value) as total,
            COUNT(*) as count,
            date_trunc('hour', recorded_at) as bucket
     FROM usage_metrics
     WHERE agent_id = $1
       AND ($2::text IS NULL OR metric_type = $2)
       AND recorded_at >= $3 AND recorded_at <= $4
     GROUP BY metric_type, bucket
     ORDER BY bucket`,
    [agentId, metricType || null, since, until],
  );
  return result.rows;
}

/**
 * Get a summary of all metrics for a specific agent.
 */
async function getAgentSummary(agentId) {
  const result = await db.query(
    `SELECT metric_type,
            SUM(value) as total,
            COUNT(*) as count,
            MIN(recorded_at) as first_seen,
            MAX(recorded_at) as last_seen
     FROM usage_metrics
     WHERE agent_id = $1
     GROUP BY metric_type`,
    [agentId],
  );

  const summary = {};
  for (const row of result.rows) {
    summary[row.metric_type] = {
      total: parseFloat(row.total),
      count: parseInt(row.count),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  }
  return summary;
}

/**
 * Get a usage summary for a user across all their agents.
 */
async function getUserSummary(userId, since) {
  const result = await db.query(
    `SELECT metric_type,
            SUM(value) as total,
            COUNT(*) as count
     FROM usage_metrics
     WHERE user_id = $1
       AND recorded_at >= $2
     GROUP BY metric_type`,
    [userId, since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()],
  );

  const summary = {};
  for (const row of result.rows) {
    summary[row.metric_type] = {
      total: parseFloat(row.total),
      count: parseInt(row.count),
    };
  }
  return summary;
}

// ── API Performance Ring Buffer ──────────────────────────────────
// Records API request metrics in-memory, flushes aggregates to DB periodically.

const apiBuffer = [];
const MAX_BUFFER = 1000;

function recordApiMetric(entry) {
  apiBuffer.push(entry);
  if (apiBuffer.length > MAX_BUFFER) apiBuffer.shift();
}

// Flush aggregates every 60 seconds. .unref() so this background timer never
// keeps the event loop alive on its own — important for tests (Jest worker
// would otherwise hang without --forceExit) and for clean shutdowns.
setInterval(async () => {
  if (apiBuffer.length === 0) return;
  const batch = apiBuffer.splice(0);
  const avgLatency = batch.reduce((s, e) => s + e.durationMs, 0) / batch.length;
  const errorCount = batch.filter((e) => e.status >= 500).length;
  try {
    await db.query("INSERT INTO usage_metrics(metric_type, value, metadata) VALUES($1, $2, $3)", [
      "api_performance",
      batch.length,
      JSON.stringify({
        avgLatencyMs: Math.round(avgLatency * 100) / 100,
        errorCount,
        errorRate: Math.round((errorCount / batch.length) * 10000) / 10000,
        sampleSize: batch.length,
      }),
    ]);
  } catch (err) {
    console.error("[metrics] Failed to flush API performance metrics:", err.message);
  }
}, 60000).unref();

/**
 * Get agent token usage and estimated token cost.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COST_WINDOW_DAYS = 365;
const UNKNOWN_MODEL = "Unknown model";

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function roundCurrency(value) {
  return Math.round(normalizeCostNumber(value) * 100) / 100;
}

function normalizeCostNumber(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizePositiveRate(value) {
  const numeric = normalizeCostNumber(value);
  return numeric >= 0 ? numeric : 0;
}

function parsePeriodDays(value, defaultValue = 30) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return defaultValue;
  return Math.max(1, Math.min(MAX_COST_WINDOW_DAYS, numeric));
}

function parseCostDate(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
    : new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError("Invalid cost date");
  }
  return parsed;
}

function resolveCostWindow({
  periodDays = 30,
  periodStart = null,
  periodEnd = null,
  period_start = null,
  period_end = null,
} = {}) {
  const requestedStart = periodStart ?? period_start;
  const requestedEnd = periodEnd ?? period_end;
  const hasCustomWindow =
    (requestedStart !== undefined &&
      requestedStart !== null &&
      String(requestedStart).trim() !== "") ||
    (requestedEnd !== undefined && requestedEnd !== null && String(requestedEnd).trim() !== "");
  const safePeriodDays = parsePeriodDays(periodDays, 30);
  const end = hasCustomWindow
    ? parseCostDate(requestedEnd, { endOfDay: true }) || new Date()
    : new Date();
  const start = hasCustomWindow
    ? parseCostDate(requestedStart) || new Date(end.getTime() - safePeriodDays * DAY_MS)
    : new Date(end.getTime() - safePeriodDays * DAY_MS);

  if (start > end) {
    throw createHttpError("Invalid cost date range");
  }

  const durationDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / DAY_MS));
  if (durationDays > MAX_COST_WINDOW_DAYS) {
    throw createHttpError(`Cost date range cannot exceed ${MAX_COST_WINDOW_DAYS} days`);
  }

  return {
    start,
    end,
    periodDays: durationDays,
    period: hasCustomWindow ? "custom" : `${safePeriodDays}d`,
  };
}

function parseCostQuery(query = {}) {
  const window = resolveCostWindow({
    periodDays: query.period_days ?? query.periodDays ?? 30,
    periodStart: query.period_start ?? query.periodStart,
    periodEnd: query.period_end ?? query.periodEnd,
  });
  return {
    periodDays: window.periodDays,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
  };
}

function normalizeRateEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const inputPer1k =
    entry.input_per_1k ?? entry.inputPer1k ?? entry.prompt_per_1k ?? entry.promptPer1k;
  const outputPer1k =
    entry.output_per_1k ?? entry.outputPer1k ?? entry.completion_per_1k ?? entry.completionPer1k;
  const per1k = entry.per_1k ?? entry.per1k ?? entry.total_per_1k ?? entry.totalPer1k;

  const normalized = {
    inputPer1k:
      inputPer1k === undefined || inputPer1k === null ? null : normalizePositiveRate(inputPer1k),
    outputPer1k:
      outputPer1k === undefined || outputPer1k === null ? null : normalizePositiveRate(outputPer1k),
    per1k: per1k === undefined || per1k === null ? null : normalizePositiveRate(per1k),
  };

  return normalized.inputPer1k === null &&
    normalized.outputPer1k === null &&
    normalized.per1k === null
    ? null
    : normalized;
}

function parseModelRateMap() {
  const raw = process.env.COST_MODEL_RATES_JSON;
  if (!raw || !String(raw).trim()) return new Map();

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();

    const map = new Map();
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || "").trim();
      const normalizedValue = normalizeRateEntry(value);
      if (!normalizedKey || !normalizedValue) continue;
      map.set(normalizedKey, normalizedValue);
      map.set(normalizedKey.toLowerCase(), normalizedValue);
    }
    return map;
  } catch {
    return new Map();
  }
}

function resolveModelRate(model, provider, modelRates) {
  const modelKey = String(model || "").trim();
  const providerKey = String(provider || "").trim();
  const candidates = [];
  if (providerKey && modelKey && !modelKey.includes("/"))
    candidates.push(`${providerKey}/${modelKey}`);
  if (modelKey) candidates.push(modelKey);
  if (providerKey && modelKey && modelKey.includes("/")) {
    const bareModel = modelKey.split("/").slice(1).join("/");
    if (bareModel) candidates.push(`${providerKey}/${bareModel}`);
  }

  for (const candidate of candidates) {
    if (modelRates.has(candidate)) return modelRates.get(candidate);
    const lower = candidate.toLowerCase();
    if (modelRates.has(lower)) return modelRates.get(lower);
  }
  return null;
}

function buildTokenCostModel(row, modelRates, fallbackPer1k) {
  const model = String(row.model || UNKNOWN_MODEL).trim() || UNKNOWN_MODEL;
  const provider = row.provider || null;
  const inputTokens = normalizeCostNumber(row.input_tokens);
  const outputTokens = normalizeCostNumber(row.output_tokens);
  const recordedTotalTokens = normalizeCostNumber(row.total_tokens);
  const totalTokens = recordedTotalTokens || inputTokens + outputTokens;
  const hasSplit = inputTokens > 0 || outputTokens > 0;
  const isUnknownModel = !model || model === UNKNOWN_MODEL;
  const modelRate = isUnknownModel ? null : resolveModelRate(model, provider, modelRates);
  let tokenCost = 0;
  let rateSource = "unknown";
  let appliedRates = {
    input_per_1k: null,
    output_per_1k: null,
    per_1k: fallbackPer1k,
  };

  if (modelRate && hasSplit && (modelRate.inputPer1k !== null || modelRate.outputPer1k !== null)) {
    const inputRate = modelRate.inputPer1k ?? modelRate.per1k ?? fallbackPer1k;
    const outputRate = modelRate.outputPer1k ?? modelRate.per1k ?? fallbackPer1k;
    tokenCost = (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
    rateSource = "model";
    appliedRates = {
      input_per_1k: inputRate,
      output_per_1k: outputRate,
      per_1k: modelRate.per1k,
    };
  } else if (modelRate && modelRate.per1k !== null) {
    tokenCost = (totalTokens / 1000) * modelRate.per1k;
    rateSource = "model_total";
    appliedRates = {
      input_per_1k: modelRate.inputPer1k,
      output_per_1k: modelRate.outputPer1k,
      per_1k: modelRate.per1k,
    };
  } else {
    tokenCost = (totalTokens / 1000) * fallbackPer1k;
    rateSource = isUnknownModel ? "unknown" : "fallback";
  }

  return {
    model,
    provider,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    token_cost: roundCurrency(tokenCost),
    request_count: Number.parseInt(row.request_count, 10) || 0,
    rate_source: rateSource,
    rates: appliedRates,
  };
}

async function getTokenCostBreakdown(agentId, costWindow) {
  const tokenResult = await db.query(
    `SELECT COALESCE(NULLIF(metadata->>'model', ''), $4) AS model,
            NULLIF(metadata->>'provider', '') AS provider,
            COALESCE(SUM(value), 0) AS total_tokens,
            COALESCE(SUM(
              CASE
                WHEN (metadata->>'input_tokens') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'input_tokens')::numeric
                WHEN (metadata->>'prompt_tokens') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'prompt_tokens')::numeric
                ELSE 0
              END
            ), 0) AS input_tokens,
            COALESCE(SUM(
              CASE
                WHEN (metadata->>'output_tokens') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'output_tokens')::numeric
                WHEN (metadata->>'completion_tokens') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'completion_tokens')::numeric
                ELSE 0
              END
            ), 0) AS output_tokens,
            COUNT(*) AS request_count
       FROM usage_metrics
      WHERE agent_id = $1
        AND metric_type = 'tokens_used'
        AND recorded_at >= $2
        AND recorded_at <= $3
      GROUP BY 1, 2
      ORDER BY total_tokens DESC`,
    [agentId, costWindow.start, costWindow.end, UNKNOWN_MODEL],
  );

  const fallbackPer1k = normalizePositiveRate(process.env.COST_PER_1K_TOKENS || "0.002");
  const modelRates = parseModelRateMap();
  const models = tokenResult.rows.map((row) => buildTokenCostModel(row, modelRates, fallbackPer1k));
  const totalTokens = models.reduce((sum, row) => sum + row.total_tokens, 0);
  const inputTokens = models.reduce((sum, row) => sum + row.input_tokens, 0);
  const outputTokens = models.reduce((sum, row) => sum + row.output_tokens, 0);
  const tokenCost = models.reduce((sum, row) => sum + row.token_cost, 0);

  return {
    fallback_per_1k: fallbackPer1k,
    total_tokens: totalTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_cost: roundCurrency(tokenCost),
    models,
  };
}

// Cached model-rate map for the hot per-exchange cost estimate (OTel export).
// The canonical cost path (getTokenCostBreakdown) re-parses each call; this
// cache only serves the high-frequency estimate. A COST_MODEL_RATES_JSON change
// needs a restart, same as any other env change.
let _cachedModelRates = null;
function getCachedModelRates() {
  if (!_cachedModelRates) _cachedModelRates = parseModelRateMap();
  return _cachedModelRates;
}

/**
 * Estimate the USD cost of a single recorded exchange without a DB round-trip,
 * reusing the same model-aware pricing/branching as the canonical cost rollup
 * (buildTokenCostModel) but returning the RAW, unrounded cost. The OTel cost
 * counter sums many sub-cent exchanges, so cent-rounding each one (as the
 * display rollup does) would zero them out. Returns a number (0 on any bad
 * input — never throws).
 */
function estimateCostUsd({ model, provider, inputTokens, outputTokens, totalTokens } = {}) {
  try {
    const fallbackPer1k = normalizePositiveRate(process.env.COST_PER_1K_TOKENS || "0.002");
    const input = normalizeCostNumber(inputTokens);
    const output = normalizeCostNumber(outputTokens);
    const total = normalizeCostNumber(totalTokens) || input + output;
    if (total <= 0) return 0;
    const modelKey = String(model || "").trim();
    const isUnknownModel = !modelKey || modelKey === UNKNOWN_MODEL;
    const rate = isUnknownModel ? null : resolveModelRate(model, provider, getCachedModelRates());
    const hasSplit = input > 0 || output > 0;
    let cost;
    if (rate && hasSplit && (rate.inputPer1k !== null || rate.outputPer1k !== null)) {
      const inRate = rate.inputPer1k ?? rate.per1k ?? fallbackPer1k;
      const outRate = rate.outputPer1k ?? rate.per1k ?? fallbackPer1k;
      cost = (input / 1000) * inRate + (output / 1000) * outRate;
    } else if (rate && rate.per1k !== null) {
      cost = (total / 1000) * rate.per1k;
    } else {
      cost = (total / 1000) * fallbackPer1k;
    }
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
  } catch {
    return 0;
  }
}

async function getAgentCost(agentId, options = {}) {
  const costWindow = resolveCostWindow(options);

  const agentResult = await db.query("SELECT id FROM agents WHERE id = $1", [agentId]);
  if (!agentResult.rows[0]) return null;

  const tokenDetails = await getTokenCostBreakdown(agentId, costWindow);
  const tokenCost = tokenDetails.total_cost;

  return {
    token_cost: roundCurrency(tokenCost),
    total_cost: roundCurrency(tokenCost),
    input_tokens: tokenDetails.input_tokens,
    output_tokens: tokenDetails.output_tokens,
    total_tokens: tokenDetails.total_tokens,
    period: costWindow.period,
    periodDays: costWindow.periodDays,
    periodStart: costWindow.start.toISOString(),
    periodEnd: costWindow.end.toISOString(),
    cost_details: {
      tokens: tokenDetails,
    },
  };
}

async function buildCostRow(agent, options = {}) {
  const cost = await getAgentCost(agent.id, options).catch((error) => {
    if (error?.statusCode) throw error;
    return null;
  });
  return {
    agentId: agent.id,
    agentName: agent.name,
    status: agent.status || null,
    runtime_family: agent.runtime_family || null,
    deploy_target: agent.deploy_target || null,
    execution_target_id: agent.execution_target_id || null,
    sandbox_profile: agent.sandbox_profile || null,
    backend_type: agent.backend_type || null,
    workspaceRole: agent.workspace_role || agent.role || null,
    ...(cost || {
      token_cost: 0,
      total_cost: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      period: options.periodDays ? `${options.periodDays}d` : "custom",
      periodStart: options.periodStart || null,
      periodEnd: options.periodEnd || null,
      cost_details: {
        tokens: { fallback_per_1k: 0, total_cost: 0, models: [] },
      },
    }),
  };
}

/**
 * Sum costs for every agent in a workspace, optionally restricted to a
 * lookback window. Returns token-cost rows plus a workspace total in USD.
 */
async function getWorkspaceCost(workspaceId, options = {}) {
  const costWindow = resolveCostWindow(options);
  const agentRows = await db.query(
    `SELECT a.id, a.name, a.status, a.backend_type, a.runtime_family, a.deploy_target,
            a.execution_target_id, a.sandbox_profile, wa.role AS workspace_role
       FROM agents a
       JOIN workspace_agents wa ON wa.agent_id = a.id
      WHERE wa.workspace_id = $1`,
    [workspaceId],
  );
  const agents = agentRows.rows;
  const windowOptions = {
    periodDays: costWindow.periodDays,
    periodStart: costWindow.start.toISOString(),
    periodEnd: costWindow.end.toISOString(),
  };
  const perAgent = await Promise.all(agents.map((agent) => buildCostRow(agent, windowOptions)));
  const total = perAgent.reduce((sum, row) => sum + (row.total_cost || 0), 0);
  return {
    workspaceId,
    periodDays: costWindow.periodDays,
    periodStart: costWindow.start.toISOString(),
    periodEnd: costWindow.end.toISOString(),
    totalUsd: Math.round(total * 100) / 100,
    perAgent,
  };
}

async function getAccessibleWorkspaceCosts(userId, options = {}) {
  const costWindow = resolveCostWindow(options);
  const windowOptions = {
    periodDays: costWindow.periodDays,
    periodStart: costWindow.start.toISOString(),
    periodEnd: costWindow.end.toISOString(),
  };
  const workspaceRows = await db.query(
    `SELECT w.id, w.name,
            COALESCE(m.role, CASE WHEN w.user_id = $1 THEN 'owner' ELSE NULL END) AS role
       FROM workspaces w
       LEFT JOIN workspace_members m
         ON m.workspace_id = w.id AND m.user_id = $1
      WHERE m.user_id = $1 OR w.user_id = $1
      ORDER BY w.created_at DESC`,
    [userId],
  );

  const workspaces = await Promise.all(
    workspaceRows.rows.map(async (workspace) => {
      const cost = await getWorkspaceCost(workspace.id, windowOptions);
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        role: workspace.role,
        ...cost,
      };
    }),
  );

  const unassignedRows = await db.query(
    `SELECT a.id, a.name, a.status, a.backend_type, a.runtime_family, a.deploy_target,
            a.execution_target_id, a.sandbox_profile
       FROM agents a
      WHERE a.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM workspace_agents wa WHERE wa.agent_id = a.id
        )
      ORDER BY a.created_at DESC`,
    [userId],
  );
  const unassignedPerAgent = await Promise.all(
    unassignedRows.rows.map((agent) => buildCostRow(agent, windowOptions)),
  );
  const unassignedTotalUsd =
    Math.round(unassignedPerAgent.reduce((sum, row) => sum + (row.total_cost || 0), 0) * 100) / 100;

  const uniqueAgents = new Map();
  for (const workspace of workspaces) {
    for (const agent of workspace.perAgent || []) {
      if (!uniqueAgents.has(agent.agentId)) uniqueAgents.set(agent.agentId, agent);
    }
  }
  for (const agent of unassignedPerAgent) {
    if (!uniqueAgents.has(agent.agentId)) uniqueAgents.set(agent.agentId, agent);
  }

  const uniqueFleetTotalUsd =
    Math.round(
      [...uniqueAgents.values()].reduce((sum, row) => sum + (row.total_cost || 0), 0) * 100,
    ) / 100;
  const workspaceTotalUsd =
    Math.round(workspaces.reduce((sum, row) => sum + (row.totalUsd || 0), 0) * 100) / 100;

  return {
    periodDays: costWindow.periodDays,
    periodStart: costWindow.start.toISOString(),
    periodEnd: costWindow.end.toISOString(),
    workspaceTotalUsd,
    uniqueFleetTotalUsd,
    workspaces,
    unassigned: {
      totalUsd: unassignedTotalUsd,
      perAgent: unassignedPerAgent,
    },
  };
}

module.exports = {
  recordMetric,
  recordTokenUsage,
  estimateCostUsd,
  getAgentMetrics,
  getAgentSummary,
  getUserSummary,
  recordApiMetric,
  parseCostQuery,
  getAgentCost,
  getWorkspaceCost,
  getAccessibleWorkspaceCosts,
};
