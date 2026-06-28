// @ts-nocheck
// OpenTelemetry GenAI export for the Nora control plane.
//
// Emits, per recorded LLM exchange, a coarse `chat` span plus token/cost
// metrics, and exposes resource (cpu/mem) gauges — over OTLP (push) and an
// optional Prometheus pull endpoint. This is the aggregate/per-exchange tier
// that maps to the data Nora actually observes; per-tool-call sub-spans depend
// on runtime event streams Nora does not see today and are tracked separately.
//
// Contract:
//   - Disabled unless NORA_OTEL_ENABLED=true (and never enabled under tests).
//   - Fully FAIL-OPEN: any load/init/runtime error disables OTel with a warning
//     and never propagates into request handling. The SDK is lazy-required
//     inside try/catch so a missing/incompatible dependency cannot crash boot.
//
// Config (all optional except the enable flag):
//   NORA_OTEL_ENABLED=true                 — master switch
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318  — OTLP/HTTP push target
//   OTEL_EXPORTER_OTLP_HEADERS=...         — read natively by the OTLP exporters
//   OTEL_SERVICE_NAME=nora-control-plane   — service.name (default below)
//   NORA_OTEL_PROMETHEUS_PORT=9464         — Prometheus /metrics port (0/empty = off)
//   NORA_OTEL_PROMETHEUS_HOST=127.0.0.1    — bind host for the Prometheus endpoint (loopback default)

const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;

// gen_ai.* semantic-convention attribute keys. The GenAI conventions are still
// incubating, so we pin the string keys here rather than import an unstable
// semconv export.
const ATTR = Object.freeze({
  GEN_AI_OPERATION: "gen_ai.operation.name",
  GEN_AI_SYSTEM: "gen_ai.system",
  GEN_AI_REQUEST_MODEL: "gen_ai.request.model",
  GEN_AI_USAGE_INPUT: "gen_ai.usage.input_tokens",
  GEN_AI_USAGE_OUTPUT: "gen_ai.usage.output_tokens",
  GEN_AI_TOKEN_TYPE: "gen_ai.token.type",
  GEN_AI_CONVERSATION_ID: "gen_ai.conversation.id",
  // Nora-scoped attribution
  AGENT_ID: "nora.agent.id",
  RUNTIME_FAMILY: "nora.runtime.family",
  SANDBOX_PROFILE: "nora.sandbox.profile",
  SOURCE: "nora.source",
});

const DEFAULT_SERVICE_NAME = "nora-control-plane";
const DEFAULT_PROM_PORT = 9464;

function envFlag(name) {
  return (
    String(process.env[name] || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function toPositiveInt(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Pure, dependency-free mapping from a recorded exchange to the gen_ai.*
 * attribute bag. Exported for unit testing without standing up the SDK.
 *
 * `includeConversation` MUST be false for metric attributes: gen_ai.conversation.id
 * is the user-supplied session id (unbounded, attacker-influenceable), and using
 * it as a metric label would blow up time-series cardinality / memory on the
 * Prometheus and OTLP backends. It is safe on spans (each span is a discrete
 * event, not an aggregated series), so the span path keeps it.
 */
function chatAttributes(
  { model, provider, runtimeFamily, sandboxProfile, source, sessionId, agentId } = {},
  { includeConversation = true } = {},
) {
  const attrs = { [ATTR.GEN_AI_OPERATION]: "chat" };
  if (provider) attrs[ATTR.GEN_AI_SYSTEM] = String(provider);
  if (model) attrs[ATTR.GEN_AI_REQUEST_MODEL] = String(model);
  if (agentId) attrs[ATTR.AGENT_ID] = String(agentId);
  if (runtimeFamily) attrs[ATTR.RUNTIME_FAMILY] = String(runtimeFamily);
  if (sandboxProfile) attrs[ATTR.SANDBOX_PROFILE] = String(sandboxProfile);
  if (source) attrs[ATTR.SOURCE] = String(source);
  if (includeConversation && sessionId) attrs[ATTR.GEN_AI_CONVERSATION_ID] = String(sessionId);
  return attrs;
}

const state = {
  enabled: false,
  tracer: null,
  tokenHistogram: null,
  costCounter: null,
  meterProvider: null,
  tracerProvider: null,
  SpanKind: null,
  shutdownFns: [],
};

// Throttle the resource-gauge DB query: observable callbacks fire on every OTLP
// push AND every Prometheus scrape, so memoize briefly to avoid hammering PG.
const RESOURCE_CACHE_TTL_MS = 5000;
const RESOURCE_QUERY_LIMIT = 1000;
let _resourceCache = { at: 0, rows: [] };
let _resourceTruncationWarned = false;

async function loadResourceSamples() {
  const now = Date.now();
  if (now - _resourceCache.at < RESOURCE_CACHE_TTL_MS) return _resourceCache.rows;
  try {
    const db = require("./db");
    const result = await db.query(
      `SELECT DISTINCT ON (s.agent_id)
              s.agent_id, a.runtime_family,
              s.cpu_percent, s.memory_percent, s.memory_usage_mb
         FROM container_stats s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.recorded_at > NOW() - INTERVAL '5 minutes'
          AND a.status IN ('running', 'warning')
        ORDER BY s.agent_id, s.recorded_at DESC
        LIMIT 1000`,
    );
    // No silent caps: warn once if the fleet exceeds the gauge query limit so
    // operators know resource gauges cover only the first N agents.
    if ((result.rows || []).length >= RESOURCE_QUERY_LIMIT && !_resourceTruncationWarned) {
      _resourceTruncationWarned = true;
      console.warn(
        `[otel] resource gauges cover only the first ${RESOURCE_QUERY_LIMIT} running agents; ` +
          "fleet exceeds that — gauges are truncated (token/cost metrics + spans are unaffected).",
      );
    }
    _resourceCache = { at: now, rows: result.rows || [] };
  } catch (err) {
    // Never let a telemetry query failure surface — serve the last good sample.
    _resourceCache = { at: now, rows: _resourceCache.rows };
  }
  return _resourceCache.rows;
}

function init() {
  if (state.enabled) return;
  if (IS_TEST_ENV) return;
  if (!envFlag("NORA_OTEL_ENABLED")) return;

  try {
    const { metrics, trace, SpanKind } = require("@opentelemetry/api");
    // OTel JS 2.x removed the `Resource` class in favor of resourceFromAttributes().
    const { resourceFromAttributes } = require("@opentelemetry/resources");
    const {
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
    } = require("@opentelemetry/semantic-conventions");
    const { MeterProvider, PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
    const { BasicTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");

    const otlpEndpoint = String(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim();
    const promPort =
      process.env.NORA_OTEL_PROMETHEUS_PORT != null
        ? toPositiveInt(process.env.NORA_OTEL_PROMETHEUS_PORT)
        : DEFAULT_PROM_PORT;

    let serviceVersion = "unknown";
    try {
      serviceVersion = require("./package.json").version || "unknown";
    } catch {
      /* version is best-effort */
    }
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: String(process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME),
      [ATTR_SERVICE_VERSION]: serviceVersion,
    });

    // ── Metric readers: OTLP push + optional Prometheus pull ──
    const readers = [];
    if (otlpEndpoint) {
      const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
      readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }));
    }
    if (promPort) {
      const { PrometheusExporter } = require("@opentelemetry/exporter-prometheus");
      readers.push(
        new PrometheusExporter({
          // Default to loopback: the scrape surface is unauthenticated and its
          // labels (agent id / model / provider) are operational intelligence.
          // Operators opt into a wider bind explicitly.
          host: String(process.env.NORA_OTEL_PROMETHEUS_HOST || "127.0.0.1"),
          port: promPort,
        }),
      );
    }

    if (readers.length) {
      const meterProvider = new MeterProvider({ resource, readers });
      const meter = meterProvider.getMeter("nora-control-plane");
      state.meterProvider = meterProvider;
      state.tokenHistogram = meter.createHistogram("gen_ai.client.token.usage", {
        description: "Tokens used per GenAI exchange, split by gen_ai.token.type",
        unit: "{token}",
      });
      state.costCounter = meter.createCounter("nora.agent.cost.usd", {
        description: "Estimated LLM spend attributed per agent/model",
        unit: "USD",
      });
      const cpuGauge = meter.createObservableGauge("nora.agent.cpu.percent", {
        description: "Latest sampled container CPU percent per running agent",
        unit: "%",
      });
      const memGauge = meter.createObservableGauge("nora.agent.memory.percent", {
        description: "Latest sampled container memory percent per running agent",
        unit: "%",
      });
      const memUsageGauge = meter.createObservableGauge("nora.agent.memory.usage", {
        description: "Latest sampled container memory usage per running agent",
        unit: "MB",
      });
      meter.addBatchObservableCallback(
        async (observableResult) => {
          const rows = await loadResourceSamples();
          for (const row of rows) {
            const attrs = {
              [ATTR.AGENT_ID]: String(row.agent_id),
              ...(row.runtime_family ? { [ATTR.RUNTIME_FAMILY]: String(row.runtime_family) } : {}),
            };
            observableResult.observe(cpuGauge, Number(row.cpu_percent) || 0, attrs);
            observableResult.observe(memGauge, Number(row.memory_percent) || 0, attrs);
            observableResult.observe(memUsageGauge, Number(row.memory_usage_mb) || 0, attrs);
          }
        },
        [cpuGauge, memGauge, memUsageGauge],
      );
      state.shutdownFns.push(() => meterProvider.shutdown());
      void metrics; // global registration intentionally skipped (module-local providers)
    }

    // ── Traces: coarse per-exchange chat spans over OTLP ──
    if (otlpEndpoint) {
      const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
      const tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
      });
      state.tracerProvider = tracerProvider;
      state.tracer = tracerProvider.getTracer("nora-control-plane");
      state.SpanKind = SpanKind;
      state.shutdownFns.push(() => tracerProvider.shutdown());
      void trace;
    }

    state.enabled = Boolean(state.meterProvider || state.tracer);
    if (state.enabled) {
      const sinks = [otlpEndpoint ? "OTLP" : null, promPort ? `Prometheus:${promPort}` : null]
        .filter(Boolean)
        .join(" + ");
      console.log(`[otel] GenAI export enabled (${sinks || "no sinks configured"})`);
    } else {
      console.warn(
        "[otel] NORA_OTEL_ENABLED is set but no exporter is configured " +
          "(set OTEL_EXPORTER_OTLP_ENDPOINT and/or NORA_OTEL_PROMETHEUS_PORT) — OTel disabled.",
      );
    }
  } catch (err) {
    state.enabled = false;
    console.warn(`[otel] Disabled — initialization failed: ${err?.message || err}`);
  }
}

/**
 * Record one LLM exchange as a chat span + token/cost metrics. No-op when OTel
 * is disabled; never throws.
 */
function recordChatExchange({
  agentId,
  model,
  provider,
  runtimeFamily,
  sandboxProfile,
  source,
  sessionId,
  inputTokens,
  outputTokens,
  totalTokens,
  costUsd,
  startedAtMs,
} = {}) {
  if (!state.enabled) return;
  try {
    const input = toCount(inputTokens);
    const output = toCount(outputTokens);
    const id = { model, provider, runtimeFamily, sandboxProfile, source, sessionId, agentId };
    // Metric labels MUST be bounded — exclude the unbounded session id.
    const metricAttrs = chatAttributes(id, { includeConversation: false });

    if (state.tokenHistogram) {
      if (input) {
        state.tokenHistogram.record(input, { ...metricAttrs, [ATTR.GEN_AI_TOKEN_TYPE]: "input" });
      }
      if (output) {
        state.tokenHistogram.record(output, { ...metricAttrs, [ATTR.GEN_AI_TOKEN_TYPE]: "output" });
      }
    }
    if (state.costCounter) {
      const cost = Number(costUsd);
      if (Number.isFinite(cost) && cost > 0) state.costCounter.add(cost, metricAttrs);
    }
    if (state.tracer) {
      const startTime = Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : undefined;
      // Spans tolerate high-cardinality attributes, so the session id stays here.
      const span = state.tracer.startSpan(`chat ${model || ""}`.trim(), {
        kind: state.SpanKind ? state.SpanKind.CLIENT : undefined,
        startTime,
        attributes: {
          ...chatAttributes(id),
          ...(input ? { [ATTR.GEN_AI_USAGE_INPUT]: input } : {}),
          ...(output ? { [ATTR.GEN_AI_USAGE_OUTPUT]: output } : {}),
          ...(toCount(totalTokens) ? { "nora.usage.total_tokens": toCount(totalTokens) } : {}),
        },
      });
      span.end();
    }
  } catch (err) {
    // Telemetry must never break the request path.
    console.warn(`[otel] recordChatExchange failed (ignored): ${err?.message || err}`);
  }
}

function isEnabled() {
  return state.enabled;
}

async function shutdown() {
  const fns = state.shutdownFns.splice(0);
  state.enabled = false;
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      /* best-effort flush on shutdown */
    }
  }
}

init();

module.exports = { recordChatExchange, isEnabled, shutdown, chatAttributes, ATTR };
