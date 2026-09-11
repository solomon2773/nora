// @ts-nocheck
// agent-runtime/lib/gatewayRpc.ts — gateway WebSocket RPC client for
// worker-provisioner (Logging Control Plane Phase 9).
//
// backend-api already has a full gateway WS-RPC client (gatewayProxy.ts) used
// by the operator-facing chat/exec/restart surface. That module is not
// reusable from worker-provisioner: it depends on backend-api-only modules
// (db, crypto, remoteHosts, middleware/ownership) that resolve Postgres-backed
// Remote-Docker-host authorization and PaaS-mode gating — concerns specific to
// a user-facing HTTP/WS proxy, not to a worker polling its own agents for
// `logs.tail`. This module is a smaller, self-contained sibling: same wire
// protocol shape, same "never dial an unresolved/unsafe address" discipline,
// reusing `gatewayUrlForAgent` / `buildRuntimeAuthHeaders` from
// `agentEndpoints.ts` for URL construction and auth-header shaping so both
// clients agree on how a token becomes a bearer credential.
//
// Frame protocol (per the logging control plane plan, Phase 9):
//   request:  { type: "req",   id, method, params }
//   response: { type: "res",   id, ok, payload } | { type: "res", id, ok: false, error }
//   event:    { type: "event", event, payload }

const dns = require("node:dns").promises;
const net = require("node:net");

const { gatewayUrlForAgent, buildRuntimeAuthHeaders } = require("./agentEndpoints.ts");

// ─── Errors ──────────────────────────────────────────────────────

class GatewayRpcError extends Error {
  constructor(message, { code = "GATEWAY_RPC_ERROR", cause, serverError } = {}) {
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (serverError !== undefined) this.serverError = serverError;
  }
}

// The socket never opened, timed out, or was dropped by the network layer —
// distinct from a credential problem the gateway itself reported.
class GatewayConnectionError extends GatewayRpcError {
  constructor(message, opts = {}) {
    super(message, { code: "GATEWAY_CONNECTION_ERROR", ...opts });
    this.name = "GatewayConnectionError";
  }
}

// The gateway rejected the `connect` handshake itself (bad/expired/missing
// token). This is a connect-time failure, checked once per connection.
class GatewayAuthError extends GatewayRpcError {
  constructor(message, opts = {}) {
    super(message, { code: "GATEWAY_AUTH_FAILED", ...opts });
    this.name = "GatewayAuthError";
  }
}

// The connection authenticated fine, but a specific RPC call was refused for
// lacking a required scope (e.g. `logs.tail` needs `operator.read`). This is
// a runtime, per-call failure — deliberately not raised at connect time,
// since a token can be valid but under-scoped for one particular method.
class GatewayScopeError extends GatewayRpcError {
  constructor(message, opts = {}) {
    super(message, { code: "GATEWAY_SCOPE_DENIED", ...opts });
    this.name = "GatewayScopeError";
  }
}

// Reconnect attempts were exhausted (see MAX_RECONNECT_ATTEMPTS below). The
// client will not retry again on its own; callers should treat this as
// "come back later" rather than "misconfigured."
class GatewayUnavailableError extends GatewayRpcError {
  constructor(message, opts = {}) {
    super(message, { code: "GATEWAY_UNAVAILABLE", ...opts });
    this.name = "GatewayUnavailableError";
  }
}

// ─── SSRF-safe target resolution ────────────────────────────────
//
// backend-api/externalHealth.ts routes every outbound gateway probe through
// backend-api/gatewayProxy.ts's resolveSafeGatewayHttpTarget /
// resolveGatewayHostForProxy: DNS-pin the agent's advertised host to a
// concrete IP and reject anything outside an explicit allow/deny policy
// before dialling. That resolver can't be imported here — it is wired to
// backend-api's Remote-Docker-host registry and PLATFORM_MODE-gated PaaS
// rules, neither of which exist in worker-provisioner. This mirrors its core
// floor instead: reject syntactically invalid hosts/ports, then DNS-pin to a
// resolved address and refuse anything clearly unroutable as a gateway
// target (unspecified, link-local, multicast, broadcast). RFC1918/loopback
// are allowed on purpose — Docker and Kubernetes agents legitimately live
// there, exactly as gatewayProxy.ts's own default policy allows.

const GATEWAY_HOST_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeAgentAddress(addr, label = "agent gateway") {
  if (!addr || typeof addr !== "object") {
    throw new GatewayConnectionError(`${label} address is missing`);
  }
  const host = typeof addr.host === "string" ? addr.host.trim() : "";
  if (!host || host.length > 253 || (!net.isIP(host) && !GATEWAY_HOST_RE.test(host))) {
    throw new GatewayConnectionError(`${label} host is not a valid hostname`);
  }
  const port = Number(addr.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GatewayConnectionError(`${label} port is out of range`);
  }
  return { host, port };
}

function isBlockedGatewayIP(address) {
  const normalized = String(address || "").toLowerCase();
  return (
    normalized === "0.0.0.0" ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("224.") ||
    normalized.startsWith("255.") ||
    normalized === "::" ||
    normalized.startsWith("fe80:")
  );
}

async function resolveSafeGatewayHost(host, label = "agent gateway") {
  const normalizedHost = String(host || "").trim();
  if (net.isIP(normalizedHost)) {
    if (isBlockedGatewayIP(normalizedHost)) {
      throw new GatewayConnectionError(`${label} host is not an allowed gateway address`);
    }
    return normalizedHost;
  }

  let addresses;
  try {
    addresses = await dns.lookup(normalizedHost, { all: true, verbatim: true });
  } catch (error) {
    throw new GatewayConnectionError(
      `${label} host could not be resolved (${error.code || error.message})`,
      { cause: error },
    );
  }

  const firstAllowed = addresses.find((entry) => !isBlockedGatewayIP(entry.address));
  if (!firstAllowed) {
    throw new GatewayConnectionError(`${label} host does not resolve to an allowed gateway network`);
  }
  return firstAllowed.address;
}

function hostForWsUrl(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

// Resolve the agent's gateway to a DNS-pinned, SSRF-safe `ws://` target.
// Exported for tests and for callers that want to pre-validate without
// opening a socket; `createGatewayClient` calls it on every (re)connect
// attempt so a mid-life DNS change is picked up rather than cached forever.
async function resolveSafeGatewayTarget(agent, options = {}) {
  const httpUrl = gatewayUrlForAgent(agent, "/", options);
  if (!httpUrl) {
    throw new GatewayConnectionError("agent gateway endpoint is not available");
  }
  const parsed = new URL(httpUrl);
  const addr = assertSafeAgentAddress({ host: parsed.hostname, port: parsed.port || 80 });
  const resolvedHost = await resolveSafeGatewayHost(addr.host);
  return {
    url: `ws://${hostForWsUrl(resolvedHost)}:${addr.port}/`,
    host: addr.host,
    resolvedHost,
    port: addr.port,
  };
}

// ─── Reconnect backoff ──────────────────────────────────────────
//
// OpenClaw's own client backoff curve could not be located in this repo's
// runtime images or vendored docs (searched agent-runtime/, workers/
// provisioner/, and the OpenClaw bundle materializer output). Per the task's
// fallback instruction, this uses a standard doubling backoff — 1s base,
// doubling each attempt — capped at 30s, for at most 8 attempts, matching
// only the two caps the task specified as known-correct. This is a stated
// assumption, not a verified match to OpenClaw's internal client.
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 8;

function computeReconnectDelay(attempt) {
  return Math.min(BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RECONNECT_DELAY_MS);
}

// ─── Scope-failure classification ───────────────────────────────
//
// The gateway's exact error vocabulary for a scope refusal isn't nailed down
// here (Phase 10 owns the real wire contract). Recognize the shapes a
// scope-checking RPC layer conventionally uses so a real gateway's response
// is very likely already covered, while still being overridable by callers
// that discover the actual code later.
const SCOPE_ERROR_CODE_RE = /scope/i;
const SCOPE_ERROR_MESSAGE_RE = /\bscope\b/i;

function isScopeError(error) {
  if (!error) return false;
  if (typeof error.code === "string" && SCOPE_ERROR_CODE_RE.test(error.code)) return true;
  if (typeof error.message === "string" && SCOPE_ERROR_MESSAGE_RE.test(error.message)) return true;
  return false;
}

// ─── Gateway client ─────────────────────────────────────────────

const WS_OPEN = 1;

function defaultCreateSocket(url) {
  return new WebSocket(url);
}

/**
 * Open (and keep open) one persistent, authenticated WebSocket-RPC
 * connection to an agent's OpenClaw gateway, with reconnect/backoff and
 * request/response correlation by `id`.
 *
 * @param {Object} agent - Agent row carrying gateway host/port fields.
 * @param {Object} [opts]
 * @param {string} [opts.token] - Per-agent gateway token (already decrypted
 *   by the caller — this module has no database/crypto access).
 * @param {Function} [opts.createSocket] - WebSocket factory, for tests.
 * @param {Function} [opts.resolveTarget] - Target resolver override, for tests.
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.callTimeoutMs]
 * @param {number} [opts.maxReconnectAttempts]
 * @param {(event: string, detail: Object) => void} [opts.onEvent] - Gateway
 *   `event` frames the caller wants to observe (e.g. connection state).
 * @returns {{ call: Function, close: Function }}
 */
function createGatewayClient(agent, opts = {}) {
  const {
    token = null,
    createSocket = defaultCreateSocket,
    resolveTarget = (a) => resolveSafeGatewayTarget(a, opts.urlOptions),
    connectTimeoutMs = 8000,
    callTimeoutMs = 30000,
    maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS,
    onEvent = null,
  } = opts;

  const authHeaders = buildRuntimeAuthHeaders(token);
  const bearerToken = authHeaders.Authorization
    ? authHeaders.Authorization.replace(/^Bearer\s+/i, "")
    : null;

  let socket = null;
  let connected = false;
  let closed = false;
  let unavailable = false;
  let terminalError = null; // set once `unavailable` becomes true
  let reconnectAttempts = 0; // retries consumed so far (excludes the initial attempt)
  let attemptInFlight = false;
  let reqCounter = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const connectWaiters = new Set(); // { resolve, reject } waiting on the CURRENT attempt cycle

  function rejectAllPending(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function settleConnectWaiters(fn) {
    const waiters = [...connectWaiters];
    connectWaiters.clear();
    for (const waiter of waiters) fn(waiter);
  }

  function teardownSocket() {
    if (!socket) return;
    try {
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("message", onMessage);
      socket.removeEventListener?.("error", onError);
      socket.removeEventListener?.("close", onClose);
      socket.close?.();
    } catch {
      // socket already gone
    }
    socket = null;
    connected = false;
  }

  let onOpen;
  let onMessage;
  let onError;
  let onClose;

  // Run exactly one connection attempt. Resolves once the `connect` handshake
  // succeeds; rejects with the attempt's failure otherwise. Never retries by
  // itself — `runAttemptLoop` below owns the retry/backoff decision so that
  // concurrent callers all observe one shared attempt cycle rather than each
  // triggering their own socket.
  function connectOnce() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      const timer = setTimeout(() => {
        settleReject(new GatewayConnectionError("gateway connect timeout"));
        teardownSocket();
      }, connectTimeoutMs);
      timer.unref?.();

      resolveTarget(agent).then(
        (target) => {
          if (settled) return;
          let sock;
          try {
            sock = createSocket(target.url);
          } catch (error) {
            settleReject(
              new GatewayConnectionError(`failed to open gateway socket: ${error.message}`, { cause: error }),
            );
            return;
          }
          socket = sock;

          onOpen = () => {
            const connectFrame = {
              type: "req",
              id: "__connect__",
              method: "connect",
              params: { auth: bearerToken ? { token: bearerToken } : {} },
            };
            try {
              sock.send(JSON.stringify(connectFrame));
            } catch (error) {
              settleReject(
                new GatewayConnectionError(`failed to send connect frame: ${error.message}`, { cause: error }),
              );
            }
          };

          onMessage = (event) => {
            let msg;
            try {
              msg = JSON.parse(typeof event?.data === "string" ? event.data : String(event?.data));
            } catch {
              return;
            }

            if (msg.type === "res" && msg.id === "__connect__") {
              if (msg.ok) {
                connected = true;
                settleResolve();
              } else {
                const serverError = msg.error || { message: "unknown" };
                settleReject(
                  new GatewayAuthError(`gateway handshake failed: ${serverError.message || "unknown"}`, {
                    serverError,
                  }),
                );
                teardownSocket();
              }
              return;
            }

            if (msg.type === "res" && msg.id && pending.has(msg.id)) {
              const { resolve: res, reject: rej, timer: t } = pending.get(msg.id);
              clearTimeout(t);
              pending.delete(msg.id);
              if (msg.ok) {
                res(msg.payload);
              } else if (isScopeError(msg.error)) {
                rej(
                  new GatewayScopeError(
                    `gateway call refused (insufficient scope): ${msg.error?.message || "scope denied"}`,
                    { serverError: msg.error },
                  ),
                );
              } else {
                rej(
                  new GatewayRpcError(`gateway call failed: ${msg.error?.message || "unknown error"}`, {
                    code: "GATEWAY_CALL_FAILED",
                    serverError: msg.error,
                  }),
                );
              }
              return;
            }

            if (msg.type === "event" && msg.event) {
              onEvent?.(msg.event, msg.payload);
            }
          };

          onError = (event) => {
            const wasSettled = settled;
            settleReject(
              new GatewayConnectionError(
                `gateway socket error: ${event?.message || event?.error?.message || "unknown"}`,
                { cause: event?.error || event },
              ),
            );
            // A drop AFTER this attempt already succeeded (i.e. a live,
            // previously-connected socket erroring later) isn't caught by
            // the settleReject above (settled is already true, so it's a
            // no-op) and isn't inside runAttemptLoop's try/catch either —
            // proactively kick off a fresh attempt cycle rather than
            // waiting passively for the next caller to notice.
            if (wasSettled && !closed && !unavailable) void runAttemptLoop();
          };

          onClose = () => {
            const wasConnectedBeforeClose = connected;
            const wasSettled = settled;
            connected = false;
            settleReject(new GatewayConnectionError("gateway connection closed"));
            if (!closed) rejectAllPending(new GatewayConnectionError("gateway connection closed"));
            if (wasSettled && wasConnectedBeforeClose && !closed && !unavailable) void runAttemptLoop();
          };

          sock.addEventListener?.("open", onOpen);
          sock.addEventListener?.("message", onMessage);
          sock.addEventListener?.("error", onError);
          sock.addEventListener?.("close", onClose);

          // Support fake sockets that use plain on* properties instead of
          // addEventListener (a minimal EventTarget shim is more test
          // ceremony than this module should require of a double).
          if (typeof sock.addEventListener !== "function") {
            sock.onopen = onOpen;
            sock.onmessage = onMessage;
            sock.onerror = onError;
            sock.onclose = onClose;
          }
        },
        (error) => {
          settleReject(
            error instanceof GatewayRpcError
              ? error
              : new GatewayConnectionError(`failed to resolve gateway target: ${error.message}`, { cause: error }),
          );
        },
      );
    });
  }

  // Drives the whole attempt/backoff cycle. Only one instance of this loop
  // ever runs at a time (`attemptInFlight` guards re-entry): every caller of
  // `ensureConnected()` — however many are waiting concurrently — observes
  // the outcome of the SAME cycle rather than each triggering its own socket
  // and its own independent backoff counter.
  async function runAttemptLoop() {
    if (attemptInFlight) return;
    attemptInFlight = true;
    try {
      for (;;) {
        try {
          await connectOnce();
          reconnectAttempts = 0;
          settleConnectWaiters(({ resolve }) => resolve());
          return;
        } catch (error) {
          if (error instanceof GatewayAuthError) {
            unavailable = true;
            terminalError = error;
            settleConnectWaiters(({ reject }) => reject(error));
            return;
          }
          if (reconnectAttempts >= maxReconnectAttempts) {
            const finalError = new GatewayUnavailableError(
              `gateway unreachable after ${maxReconnectAttempts} reconnect attempt(s): ${error.message}`,
              { cause: error },
            );
            unavailable = true;
            terminalError = finalError;
            settleConnectWaiters(({ reject }) => reject(finalError));
            return;
          }
          reconnectAttempts += 1;
          const delay = computeReconnectDelay(reconnectAttempts);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            timer.unref?.();
          });
          if (closed) return;
          // loop around for the next attempt
        }
      }
    } finally {
      attemptInFlight = false;
    }
  }

  function ensureConnected() {
    if (closed) return Promise.reject(new GatewayConnectionError("gateway client is closed"));
    if (unavailable) return Promise.reject(terminalError);
    if (connected && socket) return Promise.resolve();

    return new Promise((resolve, reject) => {
      connectWaiters.add({ resolve, reject });
      void runAttemptLoop();
    });
  }

  async function call(method, params = {}, { timeoutMs = callTimeoutMs } = {}) {
    await ensureConnected();
    if (!socket || socket.readyState !== WS_OPEN || !connected) {
      throw new GatewayConnectionError("gateway socket is not open");
    }

    const id = `r${++reqCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new GatewayConnectionError(`gateway call timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new GatewayConnectionError(`failed to send gateway call: ${error.message}`, { cause: error }));
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    rejectAllPending(new GatewayConnectionError("gateway client closed"));
    settleConnectWaiters(({ reject }) => reject(new GatewayConnectionError("gateway client closed")));
    teardownSocket();
  }

  return { call, close };
}

// Thin typed wrapper over `call()` for the `logs.tail` method (`operator.read`
// scope family). Kept separate from the generic client so Phase 10's gateway
// log collector has one obvious, documented entry point rather than needing
// to know the gateway's raw method name and payload shape.
async function callLogsTail(client, { cursor, limit, maxBytes } = {}) {
  const payload = await client.call("logs.tail", { cursor, limit, maxBytes });
  return {
    lines: payload?.lines ?? [],
    cursor: payload?.cursor ?? null,
    sourceKind: payload?.sourceKind ?? null,
  };
}

module.exports = {
  createGatewayClient,
  callLogsTail,
  resolveSafeGatewayTarget,
  computeReconnectDelay,
  isScopeError,
  GatewayRpcError,
  GatewayConnectionError,
  GatewayAuthError,
  GatewayScopeError,
  GatewayUnavailableError,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  BASE_RECONNECT_DELAY_MS,
};
