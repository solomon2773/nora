// @ts-nocheck
const crypto = require("crypto");
const { shellSingleQuote } = require("../../agent-runtime/lib/containerCommand.ts");

const DEMO_ACTIVATION_CANARY_MARKER = "NORA_ACTIVATION_READY";
const DEMO_ACTIVATION_CANARY_PROMPT = `Activation check: reply with a message containing ${DEMO_ACTIVATION_CANARY_MARKER}.`;
const DEFAULT_DEMO_ACTIVATION_CANARY_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_DEMO_ACTIVATION_CANARY_TIMEOUT_MS = 60 * 1000;
const MAX_DEMO_ACTIVATION_CANARY_TIMEOUT_MS = 10 * 60 * 1000;
const DEMO_ACTIVATION_CANARY_EXEC_GRACE_MS = 10 * 1000;
const DEMO_ACTIVATION_CANARY_CLEANUP_TIMEOUT_MS = 15 * 1000;
const DEMO_ACTIVATION_CANARY_MAX_OUTPUT_BYTES = 1024 * 1024;

function createCanaryError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function resolveDemoActivationCanaryTimeoutMs(
  rawValue = process.env.DEMO_ACTIVATION_CANARY_TIMEOUT_MS,
) {
  const normalized = String(rawValue ?? "").trim();
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_DEMO_ACTIVATION_CANARY_TIMEOUT_MS;
  }
  return Math.max(
    MIN_DEMO_ACTIVATION_CANARY_TIMEOUT_MS,
    Math.min(MAX_DEMO_ACTIVATION_CANARY_TIMEOUT_MS, parsed),
  );
}

function normalizeCanaryTimeoutMs(timeoutMs) {
  if (timeoutMs == null) return resolveDemoActivationCanaryTimeoutMs();
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DEMO_ACTIVATION_CANARY_TIMEOUT_MS;
  }
  return Math.max(
    MIN_DEMO_ACTIVATION_CANARY_TIMEOUT_MS,
    Math.min(MAX_DEMO_ACTIVATION_CANARY_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function buildOpenClawBinResolution() {
  return [
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}";',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi;',
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] || { echo "OpenClaw CLI unavailable for activation canary" >&2; exit 127; };',
  ];
}

function assertNonMainSessionKey(sessionKey) {
  const normalized = String(sessionKey || "").trim();
  if (!normalized || normalized === "main" || normalized === "agent:main:main") {
    throw new Error("Demo activation canary requires a non-main OpenClaw session key");
  }
  return normalized;
}

function buildDemoActivationCanaryCommand({ sessionKey, timeoutMs } = {}) {
  const normalizedSessionKey = assertNonMainSessionKey(sessionKey);
  const resolvedTimeoutMs = normalizeCanaryTimeoutMs(timeoutMs);
  const commandTimeoutSeconds = Math.max(1, Math.floor(resolvedTimeoutMs / 1000));
  // OpenClaw adds a 30-second transport allowance to --timeout. Leave another
  // 15 seconds for JSON serialization and orderly process teardown before the
  // outer container timeout fires.
  const agentTimeoutSeconds = Math.max(1, Math.floor((resolvedTimeoutMs - 45_000) / 1000));

  return [
    ...buildOpenClawBinResolution(),
    `set -- "$OPENCLAW_BIN" agent --agent ${shellSingleQuote("main")} --session-key ${shellSingleQuote(normalizedSessionKey)} --message ${shellSingleQuote(DEMO_ACTIVATION_CANARY_PROMPT)} --thinking ${shellSingleQuote("off")} --json --timeout ${shellSingleQuote(String(agentTimeoutSeconds))};`,
    'command -v timeout >/dev/null 2>&1 || { echo "Container timeout utility unavailable for activation canary" >&2; exit 127; };',
    `if ! CANARY_OUTPUT="$(timeout -k 5s ${commandTimeoutSeconds}s "$@" 2>/dev/null)"; then`,
    '  echo "OpenClaw Gateway activation canary command failed" >&2;',
    "  exit 1;",
    "fi;",
    'printf "%s\\n" "$CANARY_OUTPUT";',
  ].join("\n");
}

function buildDemoActivationCanaryCleanupCommand({ sessionKey } = {}) {
  const normalizedSessionKey = assertNonMainSessionKey(sessionKey);
  return [
    ...buildOpenClawBinResolution(),
    'CANARY_SESSIONS_FILE="$(mktemp /tmp/nora-activation-canary-sessions.XXXXXX.json)";',
    'cleanup_canary_sessions_file() { rm -f "$CANARY_SESSIONS_FILE"; };',
    "trap cleanup_canary_sessions_file EXIT;",
    '"$OPENCLAW_BIN" sessions --agent main --json > "$CANARY_SESSIONS_FILE";',
    `node - "$CANARY_SESSIONS_FILE" ${shellSingleQuote(normalizedSessionKey)} <<'__NORA_REMOVE_ACTIVATION_CANARY_FILES__'`,
    'const fs = require("fs");',
    'const path = require("path");',
    "const [, , file, key] = process.argv;",
    'const data = JSON.parse(fs.readFileSync(file, "utf8"));',
    "const entry = Array.isArray(data.sessions) ? data.sessions.find((item) => item?.key === key) : null;",
    "if (!entry) process.exit(0);",
    'const sessionId = String(entry.sessionId || "");',
    "if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {",
    '  throw new Error("Invalid activation canary session id");',
    "}",
    'const storePath = path.resolve(String(data.path || ""));',
    'if (path.basename(storePath) !== "sessions.json") {',
    '  throw new Error("Invalid OpenClaw session store path");',
    "}",
    "const directory = path.dirname(storePath);",
    'for (const suffix of [".jsonl", ".trajectory.jsonl", ".trajectory-path.json"]) {',
    "  fs.rmSync(path.join(directory, `${sessionId}${suffix}`), { force: true });",
    "}",
    "__NORA_REMOVE_ACTIVATION_CANARY_FILES__",
    '"$OPENCLAW_BIN" sessions cleanup --agent main --fix-missing --enforce --json >/dev/null;',
    '"$OPENCLAW_BIN" sessions --agent main --json > "$CANARY_SESSIONS_FILE";',
    `node - "$CANARY_SESSIONS_FILE" ${shellSingleQuote(normalizedSessionKey)} <<'__NORA_VERIFY_ACTIVATION_CANARY_REMOVED__'`,
    'const fs = require("fs");',
    "const [, , file, key] = process.argv;",
    'const data = JSON.parse(fs.readFileSync(file, "utf8"));',
    "if (Array.isArray(data.sessions) && data.sessions.some((item) => item?.key === key)) {",
    '  throw new Error("Activation canary session cleanup did not remove the session");',
    "}",
    "__NORA_VERIFY_ACTIVATION_CANARY_REMOVED__",
  ].join("\n");
}

function findExplicitEmbeddedFallback(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "transport" && String(entry || "").toLowerCase() === "embedded") {
      return "transport=embedded";
    }
    if (
      ["fallbackfrom", "fallbackreason", "fallbacksessionid", "fallbacksessionkey"].includes(
        normalizedKey,
      ) &&
      entry != null &&
      String(entry) !== ""
    ) {
      return key;
    }
    const nested = findExplicitEmbeddedFallback(entry, seen);
    if (nested) return nested;
  }
  return null;
}

function verifyDemoActivationCanaryOutput(output) {
  const serialized = String(output || "").trim();
  if (!serialized) {
    throw createCanaryError(
      "DEMO_ACTIVATION_CANARY_EMPTY_REPLY",
      "Demo activation Gateway canary returned no JSON reply",
    );
  }

  let response;
  try {
    response = JSON.parse(serialized);
  } catch (error) {
    throw createCanaryError(
      "DEMO_ACTIVATION_CANARY_INVALID_JSON",
      "Demo activation Gateway canary returned invalid JSON",
      error,
    );
  }

  const fallbackMarker = findExplicitEmbeddedFallback(response);
  if (fallbackMarker) {
    throw createCanaryError(
      "DEMO_ACTIVATION_CANARY_EMBEDDED_FALLBACK",
      "Demo activation canary used OpenClaw embedded fallback instead of the Gateway",
    );
  }

  if (
    response?.status !== "ok" ||
    typeof response?.runId !== "string" ||
    !response.runId.trim() ||
    !response?.result ||
    typeof response.result !== "object" ||
    !Array.isArray(response.result.payloads)
  ) {
    throw createCanaryError(
      "DEMO_ACTIVATION_CANARY_INVALID_GATEWAY_REPLY",
      "Demo activation canary did not return a completed OpenClaw Gateway result",
    );
  }

  const replyTexts = response.result.payloads
    .map((payload) => (typeof payload?.text === "string" ? payload.text : ""))
    .filter(Boolean);
  if (!replyTexts.some((text) => text.includes(DEMO_ACTIVATION_CANARY_MARKER))) {
    throw createCanaryError(
      "DEMO_ACTIVATION_CANARY_MARKER_MISSING",
      `Demo activation Gateway reply did not contain ${DEMO_ACTIVATION_CANARY_MARKER}`,
    );
  }

  return {
    status: "ready",
    runId: response.runId,
    payloadCount: replyTexts.length,
  };
}

function createDemoActivationCanarySessionKey() {
  return `agent:main:nora-activation-canary-${crypto.randomUUID()}`;
}

async function runDemoActivationCanary({
  execute,
  agentId,
  timeoutMs,
  sessionKey = createDemoActivationCanarySessionKey(),
  onCleanupFailure,
} = {}) {
  if (typeof execute !== "function") {
    throw new Error("execute is required");
  }
  const normalizedSessionKey = assertNonMainSessionKey(sessionKey);
  const resolvedTimeoutMs = normalizeCanaryTimeoutMs(timeoutMs);

  try {
    let result;
    try {
      result = await execute(
        buildDemoActivationCanaryCommand({
          sessionKey: normalizedSessionKey,
          timeoutMs: resolvedTimeoutMs,
        }),
        {
          timeout: resolvedTimeoutMs + DEMO_ACTIVATION_CANARY_EXEC_GRACE_MS,
          maxOutputBytes: DEMO_ACTIVATION_CANARY_MAX_OUTPUT_BYTES,
          agentId,
        },
      );
    } catch (error) {
      throw createCanaryError(
        "DEMO_ACTIVATION_CANARY_EXEC_FAILED",
        "Demo activation Gateway canary command did not complete successfully",
        error,
      );
    }
    return verifyDemoActivationCanaryOutput(result?.output);
  } finally {
    try {
      await execute(buildDemoActivationCanaryCleanupCommand({ sessionKey: normalizedSessionKey }), {
        timeout: DEMO_ACTIVATION_CANARY_CLEANUP_TIMEOUT_MS + 5000,
        maxOutputBytes: 8192,
        agentId,
      });
    } catch (error) {
      try {
        await onCleanupFailure?.({ agentId, sessionKey: normalizedSessionKey, error });
      } catch {
        // Cleanup and its observer are deliberately best effort.
      }
    }
  }
}

module.exports = {
  DEFAULT_DEMO_ACTIVATION_CANARY_TIMEOUT_MS,
  DEMO_ACTIVATION_CANARY_MAX_OUTPUT_BYTES,
  DEMO_ACTIVATION_CANARY_MARKER,
  buildDemoActivationCanaryCleanupCommand,
  buildDemoActivationCanaryCommand,
  createDemoActivationCanarySessionKey,
  resolveDemoActivationCanaryTimeoutMs,
  runDemoActivationCanary,
  verifyDemoActivationCanaryOutput,
};
