// @ts-nocheck
// workers/provisioner/logs/redaction.ts — Phase 10 of the logging control
// plane: a second, pattern-based redaction pass applied to every gateway log
// line at ingest time, independent of whatever redaction OpenClaw itself
// already applied upstream.
//
// Why a second pass at all: OpenClaw's own redaction is known-value pattern
// matching against its own configured secrets (provider API keys it holds),
// not semantic classification of arbitrary text. There is a known gap where
// `config.get` calls have leaked secret values into transcript JSONL that
// OpenClaw's own redaction never saw coming (a value round-tripped through a
// config dump rather than a known credential field). Since Nora persists
// gateway lines under long retention (up to the platform ceiling — see
// retentionSweeper.ts) to what may be a third-party storage bucket, this is
// defense in depth: pattern-match secret-*shaped* strings regardless of
// whether OpenClaw's own pass already caught them.
//
// This is deliberately NOT exhaustive semantic secret detection (that would
// require a much heavier entropy/classifier pass this phase does not attempt
// to build). It covers the common, well-known shapes named in the Phase 10
// spec: provider API key prefixes, bearer tokens, JWTs, and a generic
// "suspicious key name assigned a high-entropy-looking value" pattern for
// config-dump-style leaks (the `config.get` gap above). Patterns are
// documented individually below so a future pass can extend this file
// without re-deriving the reasoning.
//
// NEEDS HUMAN REVIEW: the exact pattern list here is a judgment call between
// two failure modes with real costs — too narrow leaves a real secret in
// long-retention storage, too broad mangles legitimate log content (a long
// non-secret token, a hash, a trace id). The patterns below lean toward
// covering the specific gap named in the spec (`config.get` leaking
// configured provider credentials) plus the handful of shapes named
// explicitly (`sk-...`, bearer tokens, generic high-entropy secret
// assignments) rather than attempting broader coverage. Revisit if a
// specific upstream leak shape is identified that this doesn't catch.

const REDACTED = "[REDACTED]";

// ── Individual secret-shaped patterns ────────────────────────────────────

// OpenAI-style and OpenAI-compatible provider keys: "sk-", "sk-proj-",
// "sk-ant-" (Anthropic), etc. — a "sk-" (or "rk-"/"pk-" for some providers)
// prefix followed by a long alphanumeric/underscore/hyphen run.
const PROVIDER_SECRET_PREFIX_RE = /\b(?:sk|rk|pk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g;

// AWS access key ids (not secret keys, which have no fixed prefix, but the
// access key id alone is still a credential identifier worth masking).
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;

// Bearer tokens in an Authorization-header-shaped string.
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi;

// JWTs: three base64url segments separated by dots. Matches regardless of
// where they appear in the message (Authorization header, a logged payload,
// a config dump).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

// GitHub-style tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_).
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b/g;

// Slack tokens (xox[baprs]-...).
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;

// Generic "suspicious key name assigned a high-entropy-looking value" — this
// is the pattern aimed at the `config.get` leak gap: a structured or
// semi-structured dump of a config object where a field named like a secret
// carries its actual value inline, e.g. `"apiKey": "abc123..."`,
// `api_key=abc123...`, `token: "abc123..."`. Matches `key`/`"key"` (JSON or
// bare), a `:`/`=` separator, then a quoted-or-bare value of at least 12
// non-whitespace characters. The value itself is masked, the key name is
// preserved (it's useful for debugging which field leaked; the key name
// itself is never the secret).
const SUSPICIOUS_KEY_NAMES =
  "api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret|token|password|passwd|" +
  "private[_-]?key|client[_-]?secret|auth[_-]?token|bearer[_-]?token|credential(?:s)?";

const SUSPICIOUS_ASSIGNMENT_RE = new RegExp(
  `("?(?:${SUSPICIOUS_KEY_NAMES})"?\\s*[:=]\\s*)("[^"\\s]{12,}"|'[^'\\s]{12,}'|[^\\s,}]{12,})`,
  "gi",
);

// Every pattern this module knows about, applied in order. Order matters
// only in that more specific patterns (provider prefixes, JWTs) run before
// the generic suspicious-assignment catch-all, so a value already masked by
// a specific pattern doesn't get double-processed oddly (masking an already
// masked "[REDACTED]" is harmless either way, but running specific patterns
// first keeps the resulting message more informative when only one pattern
// actually matched).
const SIMPLE_PATTERNS = [
  PROVIDER_SECRET_PREFIX_RE,
  AWS_ACCESS_KEY_RE,
  BEARER_TOKEN_RE,
  JWT_RE,
  GITHUB_TOKEN_RE,
  SLACK_TOKEN_RE,
];

/**
 * Apply the pattern-based redaction pass to one string. Pure function, no
 * side effects — safe to call on any text, including non-log strings.
 *
 * @param {string} text
 * @returns {string}
 */
function redactText(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let result = text;
  for (const pattern of SIMPLE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  SUSPICIOUS_ASSIGNMENT_RE.lastIndex = 0;
  result = result.replace(SUSPICIOUS_ASSIGNMENT_RE, (_match, prefix) => `${prefix}${REDACTED}`);
  return result;
}

/**
 * Apply the pattern-based redaction pass to a normalized log line's
 * `message` field. Returns a new line object (never mutates the input) with
 * `message` redacted; every other field (ts, trace_id, span_id, session_id,
 * channel, level, ...) passes through unchanged, since the goal is to mask
 * secret-shaped substrings inside the message body, not to touch structured
 * context fields the search/trace surfaces depend on.
 *
 * @param {object} line - a normalized line envelope (Phase 2 shape).
 * @returns {object}
 */
function redactLine(line) {
  if (!line || typeof line !== "object") return line;
  const message = redactText(line.message);
  if (message === line.message) return line;
  return { ...line, message };
}

module.exports = {
  redactLine,
  redactText,
};
