// @ts-nocheck
// OTLP/HTTP trace receiver. Mounted PRE-auth and PRE-`express.json()` in
// server.ts (like the Stripe webhook route) because it needs the raw request
// body regardless of content type: real OTLP exporters push
// `application/x-protobuf`, and this route also accepts a JSON-encoded
// equivalent for testability.
//
// This is the one endpoint in Nora where an agent initiates a connection INTO
// the control plane, so tenancy cannot be inferred from anything the agent
// sends. Two steps, kept strictly separate (see the logging-control-plane
// manifest's "Trace ingest is the one new trust boundary" /
// "Authentication and attribution are separate steps" sections):
//
//   1. Authentication — `verifyIngestKey(agentId, key)` — is this really
//      agent X? Inputs are the agent ID (`x-nora-agent-id` header) and the
//      ingest key (`x-nora-ingest-key` header) only. Workspace membership is
//      NEVER consulted here.
//   2. Attribution — resolving the authenticated agent's current workspace —
//      runs only after authentication succeeds, and is the ONLY source of
//      the `workspace_id` persisted on every span from this request. Nothing
//      in a span or resource attribute is ever trusted for tenancy, even an
//      attribute that explicitly claims a workspace.
//
// An agent with no workspace authenticates exactly as rigorously as any
// other agent and its spans persist with `workspace_id = NULL` — this is not
// an error case (see manifest "An agent with no workspace").
//
// Spans are never written to Postgres on this request path: decoding is
// cheap and safe to do inline (it is pure computation, no I/O), but the
// resulting normalized spans are enqueued onto the `span-ingest` BullMQ
// queue and persisted asynchronously by `workers/provisioner/spanDrain.ts`.

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const db = require("../db");
const { asyncHandler } = require("../middleware/errorHandler");
const { decodeTraceRequest, OtlpDecodeError } = require("../otlpDecode");
const { addSpanIngestJob } = require("../redisQueue");

const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;

const AGENT_ID_HEADER = "x-nora-agent-id";
const INGEST_KEY_HEADER = "x-nora-ingest-key";

function parsePositiveIntegerEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Deliberately much tighter than the app-wide default: this is a high-volume,
// unauthenticated-by-session endpoint (no JWT, no CORS-scoped browser
// session), so it needs its own bound layered on top of the global limiter
// and mutationLimiter already applied in server.ts before requests even
// reach here in production.
const MAX_BODY_BYTES = parsePositiveIntegerEnv("NORA_OTLP_MAX_BODY_BYTES", 2 * 1024 * 1024); // 2MB

function getIngestSecret() {
  return String(process.env.NORA_OTLP_INGEST_SECRET || "");
}

/**
 * Derive the expected ingest key for an agent: HMAC-SHA256(agentId) keyed by
 * NORA_OTLP_INGEST_SECRET, hex-encoded. Exported so agent-side enablement
 * (Phase 12) can mint keys with the identical derivation.
 *
 * @param {string} agentId
 * @returns {string} hex-encoded HMAC digest
 */
function computeIngestKey(agentId) {
  const secret = getIngestSecret();
  return crypto.createHmac("sha256", secret).update(String(agentId)).digest("hex");
}

/**
 * Constant-time verification of an ingest key against the agent ID it claims
 * to authenticate. Workspace membership is never an input — see module
 * header. Recomputes the HMAC server-side and compares with
 * `crypto.timingSafeEqual` rather than `===`, since `key` is secret-derived.
 *
 * @param {string} agentId
 * @param {string} key - hex-encoded HMAC digest from the x-nora-ingest-key header
 * @returns {boolean}
 */
function verifyIngestKey(agentId, key) {
  const secret = getIngestSecret();
  if (!secret || !agentId || !key) return false;

  const expected = Buffer.from(computeIngestKey(agentId), "hex");
  let provided;
  try {
    provided = Buffer.from(String(key), "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch, and a length check itself
  // leaks a (very coarse) timing signal only about digest length, not
  // content, which is expected/fixed for a well-formed key; still, guard it
  // rather than let a malformed short key throw.
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/**
 * Reject requests missing either required header before any body is read,
 * let alone decoded. Authentication needs a concrete agent ID to recompute
 * the HMAC against, and a request can carry spans from several resources, so
 * there is no trustworthy way to recover an ID from the payload itself.
 */
function requireIngestHeaders(req, res, next) {
  const agentIdHeader = req.headers[AGENT_ID_HEADER];
  const ingestKeyHeader = req.headers[INGEST_KEY_HEADER];

  const agentId = Array.isArray(agentIdHeader) ? agentIdHeader[0] : agentIdHeader;
  const ingestKey = Array.isArray(ingestKeyHeader) ? ingestKeyHeader[0] : ingestKeyHeader;

  if (!agentId || !String(agentId).trim()) {
    return res.status(401).json({ error: `missing ${AGENT_ID_HEADER} header` });
  }
  if (!ingestKey || !String(ingestKey).trim()) {
    return res.status(401).json({ error: `missing ${INGEST_KEY_HEADER} header` });
  }

  req.noraAgentId = String(agentId).trim();
  req.noraIngestKey = String(ingestKey).trim();
  next();
}

// Own, tighter rate limit on top of the app-wide limiters (see MAX_BODY_BYTES
// comment above). Keyed by the claimed agent ID rather than IP so one noisy
// agent behind a shared egress IP (e.g. many agents on one node/cluster)
// doesn't throttle its neighbors, and so an agent cannot dodge the limit by
// spoofing distinct agent IDs from the same source without a valid ingest
// key for each one (an unauthenticated/invalid-key request still consumes
// its own bucket, but that bucket is keyed by the ID the caller chose, at
// worst self-limiting that spoofed identity).
const otlpIngestLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("NORA_OTLP_RATE_LIMIT_WINDOW_MS", 60 * 1000),
  max: parsePositiveIntegerEnv("NORA_OTLP_RATE_LIMIT_MAX", 240),
  standardHeaders: true,
  legacyHeaders: false,
  // Always set: this limiter only runs after requireIngestHeaders has
  // already 401'd any request without an agent ID, so req.noraAgentId is
  // guaranteed present here and there is no IP fallback to worry about.
  keyGenerator: (req) => req.noraAgentId || "unknown",
  message: { error: "Too many trace exports, please slow down" },
  skip: () => IS_TEST_ENV,
});

// Buffers the raw request body regardless of Content-Type (real OTLP/HTTP
// protobuf exporters send `application/x-protobuf`; JSON is accepted for
// testability). `limit` makes an oversized body a 413 raised by body-parser
// itself, before this route's handler — and therefore before decode — ever runs.
const rawBodyParser = express.raw({ type: () => true, limit: MAX_BODY_BYTES });

const router = express.Router();

router.post(
  "/v1/traces",
  requireIngestHeaders,
  otlpIngestLimiter,
  rawBodyParser,
  asyncHandler(async (req, res) => {
    const agentId = req.noraAgentId;
    const ingestKey = req.noraIngestKey;

    // Step 1: Authentication. Identity only — workspace is not an input.
    if (!verifyIngestKey(agentId, ingestKey)) {
      return res.status(401).json({ error: "invalid ingest key" });
    }

    // Step 2: Attribution. Runs only after authentication succeeds, and is
    // the ONLY source of workspace_id for every span in this request. A
    // NULL result (agent belongs to no workspace, or the agent ID doesn't
    // resolve to anything) is a normal, expected outcome — not an error.
    let workspaceId = null;
    try {
      const { rows } = await db.query(
        `SELECT workspace_id FROM workspace_agents WHERE agent_id = $1::uuid ORDER BY created_at ASC LIMIT 1`,
        [agentId],
      );
      workspaceId = rows[0]?.workspace_id ?? null;
    } catch {
      // A malformed (non-UUID) agent ID, or a transient DB error, resolves to
      // "no workspace" rather than failing an otherwise-authenticated
      // request — identity was already proven above via HMAC.
      workspaceId = null;
    }

    const contentType = req.headers["content-type"];
    let decoded;
    try {
      decoded = decodeTraceRequest(req.body, contentType);
    } catch (err) {
      if (err instanceof OtlpDecodeError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    await addSpanIngestJob({ agentId, workspaceId, spans: decoded });

    res.status(202).json({ accepted: decoded.length });
  }),
);

module.exports = router;
module.exports.verifyIngestKey = verifyIngestKey;
module.exports.computeIngestKey = computeIngestKey;
module.exports.requireIngestHeaders = requireIngestHeaders;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
