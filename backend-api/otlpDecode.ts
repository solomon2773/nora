// @ts-nocheck
// Decodes OTLP/HTTP trace export requests (protobuf or JSON) into a flat,
// normalized list of { span, resource, scope } tuples, and maps a normalized
// span onto an `agent_spans` row.
//
// Decoding uses `protobufjs` against the vendored `proto/trace_service.proto`
// schema rather than an OTLP SDK (see the Phase 11 plan: no new OTLP SDK
// dependency). `protobufjs` renders message fields in camelCase by default
// (matching the proto3 canonical JSON mapping), and `bytes` fields as
// base64-encoded strings — which is also how real OTLP JSON exporters encode
// `trace_id`/`span_id`. That convergence is what lets the protobuf and JSON
// code paths below share one normalization step and produce byte-identical
// output for equivalent payloads.
//
// IMPORTANT: nothing in this file ever reads a workspace id out of a span or
// resource attribute. `workspace_id` is not a concept this module knows about
// at all — it is supplied by the caller (routes/otlp.ts) as the authenticated
// agent's resolved workspace, after decoding has already happened. See the
// manifest's "Trace ingest is the one new trust boundary" section.

const path = require("path");
const protobuf = require("protobufjs");

const PROTO_PATH = path.join(__dirname, "proto", "trace_service.proto");

let _root = null;
let _requestType = null;

function getRequestType() {
  if (!_requestType) {
    _root = protobuf.loadSync(PROTO_PATH);
    _requestType = _root.lookupType(
      "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
    );
  }
  return _requestType;
}

class OtlpDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "OtlpDecodeError";
  }
}

function normalizeContentType(contentType) {
  return String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/**
 * Decode an OTLP ExportTraceServiceRequest body into a flat list of
 * { span, resource, scope } tuples. Accepts either the real OTLP/HTTP
 * protobuf wire format (`application/x-protobuf` / `application/protobuf`)
 * or, for testability, a JSON-encoded equivalent of the same proto message
 * shape (`application/json`, using the proto3 canonical JSON mapping:
 * camelCase field names, base64 for `bytes`, decimal strings for 64-bit
 * integers).
 *
 * @param {Buffer} buffer - Raw request body.
 * @param {string} contentType - Request `Content-Type` header value.
 * @returns {Array<{span: object, resource: object, scope: object}>}
 */
function decodeTraceRequest(buffer, contentType) {
  const ReqType = getRequestType();
  const ct = normalizeContentType(contentType);

  let message;
  if (ct === "application/json") {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || ""));
    } catch (err) {
      throw new OtlpDecodeError(`invalid JSON body: ${err.message || err}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OtlpDecodeError("invalid OTLP JSON payload: expected an object");
    }
    try {
      message = ReqType.fromObject(parsed);
    } catch (err) {
      throw new OtlpDecodeError(`invalid OTLP JSON payload: ${err.message || err}`);
    }
  } else if (ct === "application/x-protobuf" || ct === "application/protobuf") {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new OtlpDecodeError("empty protobuf body");
    }
    try {
      message = ReqType.decode(buffer);
    } catch (err) {
      throw new OtlpDecodeError(`invalid protobuf payload: ${err.message || err}`);
    }
  } else {
    throw new OtlpDecodeError(`unsupported content type: ${contentType || "(none)"}`);
  }

  let normalized;
  try {
    normalized = ReqType.toObject(message, {
      longs: String,
      enums: String,
      bytes: String,
      defaults: true,
    });
  } catch (err) {
    throw new OtlpDecodeError(`failed to normalize decoded payload: ${err.message || err}`);
  }

  return flattenResourceSpans(normalized);
}

function flattenResourceSpans(normalized) {
  const out = [];
  const resourceSpansList = Array.isArray(normalized?.resourceSpans) ? normalized.resourceSpans : [];
  for (const resourceSpans of resourceSpansList) {
    const resource = resourceSpans?.resource || { attributes: [] };
    const scopeSpansList = Array.isArray(resourceSpans?.scopeSpans) ? resourceSpans.scopeSpans : [];
    for (const scopeSpans of scopeSpansList) {
      const scope = scopeSpans?.scope || null;
      const spans = Array.isArray(scopeSpans?.spans) ? scopeSpans.spans : [];
      for (const span of spans) {
        out.push({ span, resource, scope });
      }
    }
  }
  return out;
}

// ── Attribute helpers ──────────────────────────────────────────────────

/**
 * Convert a decoded `AnyValue` object (protobufjs toObject shape, oneof
 * collapsed to whichever field is actually set) into a plain JS value.
 */
function anyValueToJs(anyValue) {
  if (!anyValue || typeof anyValue !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(anyValue, "stringValue")) return anyValue.stringValue;
  if (Object.prototype.hasOwnProperty.call(anyValue, "boolValue")) return anyValue.boolValue;
  if (Object.prototype.hasOwnProperty.call(anyValue, "intValue")) {
    const n = Number(anyValue.intValue);
    return Number.isFinite(n) ? n : anyValue.intValue;
  }
  if (Object.prototype.hasOwnProperty.call(anyValue, "doubleValue")) return anyValue.doubleValue;
  if (Object.prototype.hasOwnProperty.call(anyValue, "arrayValue")) {
    return (anyValue.arrayValue?.values || []).map(anyValueToJs);
  }
  if (Object.prototype.hasOwnProperty.call(anyValue, "kvlistValue")) {
    return attributesToObject(anyValue.kvlistValue?.values || []);
  }
  if (Object.prototype.hasOwnProperty.call(anyValue, "bytesValue")) return anyValue.bytesValue;
  return null;
}

/**
 * Flatten a decoded `repeated KeyValue` list into a plain `{ key: value }`
 * object. Later duplicate keys win, matching typical semconv reader behavior.
 */
function attributesToObject(attributes) {
  const out = {};
  for (const kv of Array.isArray(attributes) ? attributes : []) {
    if (!kv || typeof kv.key !== "string") continue;
    out[kv.key] = anyValueToJs(kv.value);
  }
  return out;
}

// GenAI semantic-convention attribute keys we read from span attributes.
// The GenAI conventions are still incubating upstream (mirrors the note in
// backend-api/otel.ts), so string keys are pinned here directly.
const GEN_AI_ATTR = Object.freeze({
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  SYSTEM: "gen_ai.system",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
});

// Cost is not (yet) part of the upstream GenAI semantic conventions, so this
// checks a couple of plausible attribute names OpenClaw/exporters may emit
// and takes the first one present, in priority order.
const COST_ATTR_CANDIDATES = ["gen_ai.usage.cost", "gen_ai.usage.cost_usd", "nora.cost.usd"];

const SPAN_KIND_MAP = Object.freeze({
  SPAN_KIND_UNSPECIFIED: "unspecified",
  SPAN_KIND_INTERNAL: "internal",
  SPAN_KIND_SERVER: "server",
  SPAN_KIND_CLIENT: "client",
  SPAN_KIND_PRODUCER: "producer",
  SPAN_KIND_CONSUMER: "consumer",
});

const STATUS_CODE_MAP = Object.freeze({
  STATUS_CODE_UNSET: "unset",
  STATUS_CODE_OK: "ok",
  STATUS_CODE_ERROR: "error",
});

function base64ToHex(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const buf = Buffer.from(value, "base64");
    return buf.length ? buf.toString("hex") : null;
  } catch {
    return null;
  }
}

function nanosToDate(nanosString) {
  if (nanosString === undefined || nanosString === null || nanosString === "") return null;
  try {
    const nanos = BigInt(nanosString);
    const millis = nanos / 1000000n;
    return new Date(Number(millis));
  } catch {
    const asNumber = Number(nanosString);
    return Number.isFinite(asNumber) ? new Date(asNumber / 1e6) : null;
  }
}

function durationMs(startNanosString, endNanosString) {
  try {
    const start = BigInt(startNanosString ?? "0");
    const end = BigInt(endNanosString ?? "0");
    if (end <= start) return null;
    const diffNanos = end - start;
    // Sub-millisecond precision isn't meaningful for the numeric(duration_ms)
    // column here; keep it simple and lossless enough for aggregation.
    return Number(diffNanos) / 1e6;
  } catch {
    return null;
  }
}

function firstPresentCostAttr(attrs) {
  for (const key of COST_ATTR_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      const value = Number(attrs[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function toIntOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Map one normalized OTLP span (plus its resource and the already-resolved,
 * authenticated agent) onto the exact row shape `agent_spans` expects.
 *
 * `agent.workspace_id` is the ONLY source of truth for the row's
 * `workspace_id` — nothing here reads a workspace out of `resource` or
 * `span` attributes, by design (see module header).
 *
 * @param {object} span - Normalized span (protobufjs toObject shape).
 * @param {object} resource - Normalized resource (protobufjs toObject shape).
 * @param {{id: string, workspace_id: string|null}} agent - Resolved, authenticated agent.
 * @returns {object} A row ready to insert into `agent_spans`.
 */
function mapSpanToRow(span, resource, agent) {
  const spanAttrs = attributesToObject(span?.attributes || []);
  const resourceAttrs = attributesToObject(resource?.attributes || []);

  const model =
    (typeof spanAttrs[GEN_AI_ATTR.REQUEST_MODEL] === "string" && spanAttrs[GEN_AI_ATTR.REQUEST_MODEL]) ||
    (typeof spanAttrs[GEN_AI_ATTR.RESPONSE_MODEL] === "string" && spanAttrs[GEN_AI_ATTR.RESPONSE_MODEL]) ||
    null;
  const provider = typeof spanAttrs[GEN_AI_ATTR.SYSTEM] === "string" ? spanAttrs[GEN_AI_ATTR.SYSTEM] : null;
  const tokensIn = toIntOrNull(spanAttrs[GEN_AI_ATTR.USAGE_INPUT_TOKENS]);
  const tokensOut = toIntOrNull(spanAttrs[GEN_AI_ATTR.USAGE_OUTPUT_TOKENS]);
  const costUsd = firstPresentCostAttr(spanAttrs);

  const kindRaw = typeof span?.kind === "string" ? span.kind : "SPAN_KIND_UNSPECIFIED";
  const statusCodeRaw = typeof span?.status?.code === "string" ? span.status.code : "STATUS_CODE_UNSET";

  return {
    trace_id: base64ToHex(span?.traceId),
    span_id: base64ToHex(span?.spanId),
    parent_span_id: base64ToHex(span?.parentSpanId),
    workspace_id: agent?.workspace_id ?? null,
    agent_id: agent?.id ?? null,
    name: typeof span?.name === "string" ? span.name : "",
    kind: SPAN_KIND_MAP[kindRaw] || "unspecified",
    started_at: nanosToDate(span?.startTimeUnixNano),
    duration_ms: durationMs(span?.startTimeUnixNano, span?.endTimeUnixNano),
    status: STATUS_CODE_MAP[statusCodeRaw] || "unset",
    model,
    provider,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    attrs: { ...spanAttrs, resource: resourceAttrs },
  };
}

module.exports = {
  OtlpDecodeError,
  decodeTraceRequest,
  mapSpanToRow,
  // Exported for unit testing / reuse.
  anyValueToJs,
  attributesToObject,
  GEN_AI_ATTR,
  COST_ATTR_CANDIDATES,
};
