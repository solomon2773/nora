// @ts-nocheck
// agent-runtime/lib/logLine.ts — shared log-line normalization.
//
// This module is the single place that turns raw bytes from a container's
// stdout/stderr stream, or a structured record from OpenClaw's gateway
// `logs.tail` RPC, into Nora's normalized line envelope (see the logging
// control plane manifest's "Line schema" section). It is consumed today by
// `backend-api/logStream.ts` (the live WebSocket viewer) and will be
// consumed by the Phase 3 segment writer and the Phase 9/10 gateway
// collector — two processes that must never parse the same bytes two
// different ways, or persisted history and the live tail would disagree
// about the same line.
//
// Deliberately DB- and HTTP-agnostic, like `objectStorage.ts` alongside it:
// every function is a pure transform over its arguments so it behaves
// identically inside `worker-provisioner` and `backend-api`.
//
// Two bug fixes live here (see the manifest's "Known deficiencies" section):
//
//   1. Level inference tries `JSON.parse` first and trusts a real `level`
//      field when present. The old substring heuristic
//      (`message.toUpperCase().includes("ERROR")`) misclassifies plain
//      text like "no errors found" as ERROR; it now only runs as a
//      fallback for genuinely unstructured output.
//   2. An unparseable/missing timestamp no longer fabricates `ts` from the
//      collector's own clock. It emits `ts: null`, `observed_ts: <collector
//      now>`, `ts_source: "collector"`. A successfully parsed timestamp
//      emits `ts: <parsed>`, `observed_ts: <collector now>`,
//      `ts_source: "source"`. `ts` is never fabricated.
//
// `ord` (position-within-segment) is intentionally never assigned here.
// See the manifest's revised `ord` section: a parse-time counter cannot
// reproduce the same values on crash-replay, because it depends on process
// state (how many lines this process has parsed since it started) rather
// than on the content of the window. `ord` is a pure function of a
// flushed window's contents, computed once by Phase 3's segment writer at
// flush time. Callers must not add one upstream of that.

const { StringDecoder } = require("string_decoder");

// Docker prefixes each line it timestamps with an RFC3339-ish string
// followed by whitespace, e.g. "2024-01-15T12:34:56.789123456Z <message>".
const RFC3339_PREFIX = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+([\s\S]*)$/;

// OpenClaw's own logger vocabulary (pino-shaped), widest to narrowest:
// silent | fatal | error | warn | info | debug | trace. `silent` is a
// *threshold* value (pino uses it to mean "log nothing at this sink") and
// is not a level a real log statement should carry — if one shows up
// tagged `silent` it is treated as suppressed and dropped rather than
// surfaced under an invented Nora level. `fatal` and `trace` don't have
// literal Nora counterparts, so they collapse onto the nearest severity:
// fatal -> ERROR (it's a severity signal, not a distinct one in Nora's
// four-level vocabulary), trace -> DEBUG (most-verbose maps to
// most-verbose).
const GATEWAY_LEVEL_MAP = {
  silent: null,
  fatal: "ERROR",
  error: "ERROR",
  warn: "WARN",
  warning: "WARN",
  info: "INFO",
  debug: "DEBUG",
  trace: "DEBUG",
};

/**
 * Map a level name (OpenClaw/pino vocabulary, or a generic structured log's
 * own `level` field) onto Nora's ERROR/WARN/INFO/DEBUG vocabulary.
 *
 * Returns:
 *   - a Nora level string when the name is recognized and should surface
 *   - `null` when the name is recognized but explicitly suppressed (`silent`)
 *   - `undefined` when the name is not recognized at all
 */
function mapLevelName(name) {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(GATEWAY_LEVEL_MAP, key)) return undefined;
  return GATEWAY_LEVEL_MAP[key];
}

function nowIso(ctx) {
  if (ctx && typeof ctx.now === "function") return ctx.now();
  return new Date().toISOString();
}

/**
 * Infer a Nora log level for one line.
 *
 * Structured-first: if `parsed` is a JSON object with a string `level`
 * field, that field wins (mapped through the same vocabulary as the
 * gateway stream, since structured container output commonly uses the
 * same pino-style names). Falls back to a heuristic only when the line is
 * unstructured or carries no usable `level` field.
 *
 * The fallback heuristic matches on whole words (`\bERROR\b`, not a raw
 * substring) — this is part of the fix, not just the JSON-first check.
 * The old `message.toUpperCase().includes("ERROR")` matched inside
 * "ERRORS", so "no errors found" came out ERROR; a word-boundary match
 * does not.
 */
function inferLevel(message, parsed) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const mapped = mapLevelName(parsed.level);
    if (mapped) return mapped;
  }

  const upper = String(message ?? "").toUpperCase();
  if (/\bERR(OR)?\b/.test(upper)) return "ERROR";
  if (/\bWARN(ING)?\b/.test(upper)) return "WARN";
  if (/\bDEBUG\b/.test(upper)) return "DEBUG";
  return "INFO";
}

// Shared per-line normalization used by both the stateless (single-chunk)
// and stateful (long-lived stream) parsers below, so the two never drift on
// timestamp extraction, JSON detection, or level inference.
function normalizeRawLine(rawLine, ctx) {
  const line = rawLine.trim();
  if (!line) return null;

  // Docker timestamp format: 2024-01-15T12:34:56.789Z <message>
  let ts = null;
  let tsSource = "collector";
  let message = line;
  const tsMatch = line.match(RFC3339_PREFIX);
  if (tsMatch) {
    ts = tsMatch[1];
    tsSource = "source";
    message = tsMatch[2];
  }

  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    parsed = undefined;
  }

  const level = inferLevel(message, parsed);

  return {
    ts,
    observed_ts: nowIso(ctx),
    ts_source: tsSource,
    stream: ctx.stream || "runtime",
    level,
    message,
  };
}

/**
 * Parse one *standalone* chunk of a container's stdout/stderr stream into
 * normalized `LogLine` objects. Handles the Docker multiplexed-stream
 * framing (an 8-byte header per frame — stream type byte, three zero
 * bytes, then a 4-byte big-endian length) transparently: a chunk carrying
 * that header has it stripped, a raw stream (Kubernetes, Proxmox
 * `journalctl`, remote-Docker demuxed upstream) is left untouched.
 *
 * This function is stateless and decodes/demuxes only within the one
 * chunk it's given — correct for a single self-contained chunk (a test
 * fixture, a one-shot log fetch), but NOT for a long-lived stream: a real
 * `data` event lands at an arbitrary byte offset with no relation to frame
 * or UTF-8 character boundaries, so calling this once per chunk on a live
 * stream can split a multi-byte character or a frame header across two
 * chunks and corrupt the byte(s) that straddle them (typically surfacing
 * as a stray U+FFFD `�` character). For any open stream — the WebSocket
 * live viewer, the log collector — use `createLogChunkStreamParser`
 * instead, which carries partial frames and partial characters across
 * chunk boundaries.
 *
 * @param {Buffer} chunk
 * @param {{ stream?: string, now?: () => string }} [ctx]
 *   `stream` labels the resulting lines (default "runtime"); `now` is an
 *   injectable clock for tests, defaulting to `() => new Date().toISOString()`.
 * @returns {Array<object>} normalized lines, in encounter order, without `ord`.
 */
function parseContainerLogChunk(chunk, ctx = {}) {
  if (!chunk || chunk.length === 0) return [];

  // Docker multiplexed stream: 8-byte header per frame. Skip it when
  // present; a stream_type byte > 2 means there is no such header.
  let payload = chunk;
  if (chunk.length > 8 && chunk[0] <= 2 && chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0) {
    payload = chunk.slice(8);
  }

  const text = payload.toString("utf8").trim();
  if (!text) return [];

  const lines = [];
  for (const rawLine of text.split("\n")) {
    const normalized = normalizeRawLine(rawLine, ctx);
    if (normalized) lines.push(normalized);
  }
  return lines;
}

/**
 * Stateful counterpart to `parseContainerLogChunk`, for a long-lived
 * container log stream. Create one instance per open stream attach (one
 * per WebSocket connection, one per log-collector attach — never share an
 * instance across streams), feed it every `data` chunk via `push()`, and
 * call `flush()` once on stream end/close to emit any trailing line that
 * never saw its terminating newline.
 *
 * Carries two kinds of state across chunk boundaries that
 * `parseContainerLogChunk` cannot, because a stream `data` event can split
 * either of them at an arbitrary byte offset:
 *
 *   1. A Docker multiplexed-stream frame (8-byte header + payload) whose
 *      header or payload spans two chunks — resolved by buffering
 *      undecided raw bytes (`frameBuffer`) until a complete frame arrives.
 *   2. A multi-byte UTF-8 character split across two chunks — resolved by
 *      decoding through a single persistent `StringDecoder`, which (unlike
 *      `Buffer#toString('utf8')` called separately per chunk) holds an
 *      incomplete trailing byte sequence until the rest of it arrives
 *      instead of immediately replacing it with U+FFFD.
 *
 * Whether the stream is multiplexed at all is decided once, from the first
 * chunk — it's a per-stream property (whether the container was created
 * with a TTY), not something that can change mid-stream.
 *
 * @param {{ stream?: string, now?: () => string }} [ctx]
 * @returns {{ push: (chunk: Buffer) => Array<object>, flush: () => Array<object> }}
 */
function createLogChunkStreamParser(ctx = {}) {
  const decoder = new StringDecoder("utf8");
  let frameBuffer = null;
  let demuxed = null;
  let textBuffer = "";

  function decideDemuxed() {
    // Only ever called once `frameBuffer` holds > 8 bytes — deciding from a
    // shorter prefix would misread a chunk that just happens to be tiny
    // (e.g. the frame header itself split across two chunks) as "no
    // header," permanently disabling demuxing for the rest of the stream.
    demuxed =
      frameBuffer[0] <= 2 && frameBuffer[1] === 0 && frameBuffer[2] === 0 && frameBuffer[3] === 0;
  }

  function extractPayload(chunk) {
    if (demuxed === null) {
      frameBuffer = frameBuffer ? Buffer.concat([frameBuffer, chunk]) : chunk;
      if (frameBuffer.length <= 8) return null; // not enough bytes to decide yet
      decideDemuxed();
      if (!demuxed) {
        const buffered = frameBuffer;
        frameBuffer = null;
        return buffered;
      }
      // demuxed === true: fall through to the frame walk below, which
      // consumes the already-accumulated `frameBuffer`.
    } else if (!demuxed) {
      return chunk;
    } else {
      frameBuffer = frameBuffer ? Buffer.concat([frameBuffer, chunk]) : chunk;
    }

    const payloads = [];
    while (frameBuffer.length >= 8) {
      const frameLength = frameBuffer.readUInt32BE(4);
      if (frameBuffer.length < 8 + frameLength) break; // frame not fully arrived yet
      payloads.push(frameBuffer.subarray(8, 8 + frameLength));
      frameBuffer = frameBuffer.subarray(8 + frameLength);
    }
    return payloads.length ? Buffer.concat(payloads) : null;
  }

  function consumeText(newText) {
    textBuffer += newText;
    if (!textBuffer.includes("\n")) return [];
    const parts = textBuffer.split("\n");
    textBuffer = parts.pop();
    const lines = [];
    for (const rawLine of parts) {
      const normalized = normalizeRawLine(rawLine, ctx);
      if (normalized) lines.push(normalized);
    }
    return lines;
  }

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return [];
      const payload = extractPayload(chunk);
      if (!payload || payload.length === 0) return [];
      return consumeText(decoder.write(payload));
    },
    flush() {
      // The stream ended before enough bytes ever arrived to decide
      // whether it was Docker-multiplexed (extractPayload's >8-byte
      // threshold) — too short to have carried a meaningful frame anyway,
      // so treat whatever's left as raw rather than silently dropping it.
      if (demuxed === null && frameBuffer && frameBuffer.length > 0) {
        textBuffer += decoder.write(frameBuffer);
        frameBuffer = null;
      }
      const lines = consumeText(decoder.end());
      if (textBuffer) {
        const normalized = normalizeRawLine(textBuffer, ctx);
        if (normalized) lines.push(normalized);
        textBuffer = "";
      }
      return lines;
    },
  };
}

/**
 * Normalize one record from OpenClaw's `logs.tail` gateway RPC (JSONL,
 * pino-shaped) into the same line envelope `parseContainerLogChunk`
 * produces, so the two streams merge by timestamp sort rather than
 * per-stream parsing at read time.
 *
 * Returns `null` when the record's level is `silent` — that vocabulary
 * entry means "suppressed at the sink," not a real event, so the caller
 * (the Phase 9/10 gateway collector) should drop the line rather than
 * inventing a Nora level for it.
 *
 * @param {object} record - one parsed JSONL record from `logs.tail`.
 * @param {{ stream?: string, now?: () => string }} [ctx]
 * @returns {object|null}
 */
function normalizeGatewayLogLine(record, ctx = {}) {
  if (!record || typeof record !== "object") return null;

  const mappedLevel = mapLevelName(record.level);
  if (mappedLevel === null) return null; // silent — suppressed, not surfaced
  const level = mappedLevel || "INFO";

  let ts = null;
  let tsSource = "collector";
  const rawTs = record.ts ?? record.time ?? record.timestamp;
  if (rawTs !== undefined && rawTs !== null) {
    const asDate = typeof rawTs === "number" ? new Date(rawTs) : new Date(String(rawTs));
    if (!Number.isNaN(asDate.getTime())) {
      ts = asDate.toISOString();
      tsSource = "source";
    }
  }

  return {
    ts,
    observed_ts: nowIso(ctx),
    ts_source: tsSource,
    stream: ctx.stream || "gateway",
    level,
    message: String(record.msg ?? record.message ?? ""),
    trace_id: record.traceId ?? record.trace_id ?? null,
    span_id: record.spanId ?? record.span_id ?? null,
    session_id: record.sessionId ?? record.session_id ?? null,
    channel: record.channel ?? null,
  };
}

module.exports = {
  parseContainerLogChunk,
  createLogChunkStreamParser,
  normalizeGatewayLogLine,
  inferLevel,
  mapLevelName,
};
