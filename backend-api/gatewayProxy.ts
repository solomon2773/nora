// @ts-nocheck
// backend-api/gatewayProxy.ts — WebSocket-RPC proxy between platform and OpenClaw Gateway
// The Gateway exposes a WebSocket-RPC protocol (not HTTP REST).
// This module maintains a connection pool, translates HTTP routes to WS-RPC calls,
// and relays WebSocket connections for streaming chat.
const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const db = require("./db");
const { decrypt } = require("./crypto");
const integrations = require("./integrations");
const { resolveAgentRuntimeFamily } = require("./agentRuntimeFields");
const remoteHosts = require("./remoteHosts");
const { normalizeDeployTargetName } = require("../agent-runtime/lib/backendCatalog");

const metrics = require("./metrics");
const agentBudgets = require("./agentBudgets");
const { OPENCLAW_GATEWAY_PORT, HERMES_DASHBOARD_PORT } = require("../agent-runtime/lib/contracts");
const {
  resolveGatewayAddress,
  resolveHermesDashboardAddress,
  hasGatewayEndpoint,
} = require("../agent-runtime/lib/agentEndpoints");
const GATEWAY_PORT = OPENCLAW_GATEWAY_PORT;
const CONNECT_TIMEOUT = 8000;
const CALL_TIMEOUT = 30000;
const CHAT_TIMEOUT = 120000;
const RELAY_CONNECT_DELAY_MS = 750;
const DOCKER_GATEWAY_HOST_PORT_MIN = 19000;
const DOCKER_GATEWAY_HOST_PORT_MAX = 19999;
const K8S_NODE_PORT_MIN = 30000;
const K8S_NODE_PORT_MAX = 32767;
const GATEWAY_PROXY_PATH_RE = /^[A-Za-z0-9._~/-]*$/;
const GATEWAY_PROXY_SEARCH_RE = /^\?[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*$/;
// Advertise a protocol RANGE rather than a single version so the handshake
// negotiates with both the current OpenClaw runtime (speaks v3) and newer
// gateways (v4+). Pinning a single version that ran ahead of the deployed
// runtime caused "Gateway handshake failed: protocol mismatch".
const GATEWAY_MIN_PROTOCOL_VERSION = 3;
const GATEWAY_MAX_PROTOCOL_VERSION = 4;

// Hostname must be a plain DNS name / IP literal — no URL meta-chars that
// could alter the parsed origin (no "@", "/", "?", "#", ":", whitespace, etc.).
// Compose-internal aliases like "worker-provisioner" are intentionally allowed;
// this is a syntactic guard against injection via agent DB fields, not an
// allowlist of ranges.
const GATEWAY_HOST_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeAgentAddress(addr, label = "agent gateway") {
  if (!addr || typeof addr !== "object") {
    throw new Error(`${label} address is missing`);
  }
  const host = typeof addr.host === "string" ? addr.host.trim() : "";
  if (!host || host.length > 253 || !GATEWAY_HOST_RE.test(host)) {
    throw new Error(`${label} host is not a valid hostname`);
  }
  const port = Number(addr.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} port is out of range`);
  }
  return { host, port };
}

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseCsvPortSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
  );
}

function isAllowedGatewayPort(port) {
  const configuredPorts = parseCsvPortSet(process.env.NORA_GATEWAY_PROXY_ALLOWED_PORTS);
  return (
    port === OPENCLAW_GATEWAY_PORT ||
    (port >= DOCKER_GATEWAY_HOST_PORT_MIN && port <= DOCKER_GATEWAY_HOST_PORT_MAX) ||
    (port >= K8S_NODE_PORT_MIN && port <= K8S_NODE_PORT_MAX) ||
    configuredPorts.has(port)
  );
}

function isAllowedGatewayIPv4(address) {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isAllowedGatewayIPv6(address) {
  const normalized = String(address || "").toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
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

const EMPTY_ALLOWED_HOSTS = new Set();

// A registered remote host's advertised address is operator-trusted, so allow
// it even though it is not RFC1918/loopback. Scoped to the agent's OWN host
// (looked up by execution target) AND to a user who may use it — the agent's
// owner, OR (C3) a workspace the host is shared into where the owner is editor+.
// A cross-tenant execution_target_id reference still can't reach a host that was
// never shared to the agent owner. Blocked addresses (0.0.0.0, link-local, …) still apply.
async function allowedRemoteHostsForAgent(agent) {
  if (normalizeDeployTargetName(agent?.deploy_target) !== "remote-docker") {
    return EMPTY_ALLOWED_HOSTS;
  }
  try {
    const host = await remoteHosts.getRemoteHostByExecutionTarget(agent.execution_target_id);
    if (!host) return EMPTY_ALLOWED_HOSTS;
    // Trust the host only if the agent's owner may use it: direct owner, or an
    // editor+ grant via a workspace the host is shared into (positive check). Fail
    // closed on a null/foreign owner — never let the owner check short-circuit on a
    // null owner into trusting the host.
    if (agent.user_id && host.ownerUserId !== agent.user_id) {
      const allowed = await remoteHosts.userCanUseRemoteHost(agent.user_id, host.id);
      if (!allowed) return EMPTY_ALLOWED_HOSTS;
    }
    const allowed = new Set();
    if (host.gatewayHost) allowed.add(String(host.gatewayHost).toLowerCase());
    if (host.sshHost) allowed.add(String(host.sshHost).toLowerCase());
    return allowed;
  } catch {
    return EMPTY_ALLOWED_HOSTS;
  }
}

// The host allowance for an agent's gateway, used identically by the HTTP,
// RPC-pool, and WS-relay paths so all three enforce the same SSRF policy:
//  - remote-docker: the agent's OWN registered host address (owner-scoped).
//  - k8s: the operator-provisioned cluster exposure address (LoadBalancer /
//    NodePort / ClusterIP host the k8s adapter recorded). Trusting it matches
//    the prior RPC/WS behavior (they did no host check), so k8s chat — incl.
//    public LoadBalancer IPs — does not regress.
//  - external: the operator-declared endpoint of an adopted runtime (BYOC C),
//    trusted from the agent's OWN row. Owner-scoped inherently (the agent row is
//    loaded user-scoped, so you can only reach YOUR external agent's endpoint),
//    and the hard isBlockedGatewayIP floor + port allowlist still apply. In PaaS
//    mode the endpoint is forced to a public IP at registration (no RFC1918
//    pivot); selfhosted may adopt RFC1918 runtimes on the operator's own network.
//  - docker / other: none — falls through to the RFC1918/loopback floor.
async function allowedGatewayHostsForAgent(agent) {
  const target = normalizeDeployTargetName(agent?.deploy_target);
  if (target === "remote-docker") return allowedRemoteHostsForAgent(agent);
  if (target === "external" || target === "k8s") {
    const allowed = new Set();
    if (agent?.gateway_host) allowed.add(String(agent.gateway_host).toLowerCase());
    if (agent?.runtime_host) allowed.add(String(agent.runtime_host).toLowerCase());
    return allowed.size ? allowed : EMPTY_ALLOWED_HOSTS;
  }
  // docker / other: trust the operator-configured published host — the address
  // the control plane uses to reach the docker host's published port (GATEWAY_HOST
  // or host.docker.internal). It is GLOBAL config, not a per-agent value, so this
  // is not a per-agent SSRF vector; a docker agent's own gateway_host is NOT
  // trusted here, so a public docker gateway_host still hits the RFC1918 floor.
  const publishedHost = String(process.env.GATEWAY_HOST || "host.docker.internal").toLowerCase();
  return new Set([publishedHost]);
}

function isAllowedGatewayIP(address, hostname, extraAllowedHosts) {
  if (isBlockedGatewayIP(address)) return false;
  const normalizedHostname = String(hostname || "").toLowerCase();
  const allowedHosts = parseCsvSet(process.env.NORA_GATEWAY_PROXY_ALLOWED_HOSTS);
  if (allowedHosts.has(normalizedHostname)) return true;
  if (extraAllowedHosts && extraAllowedHosts.has(normalizedHostname)) return true;
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) return isAllowedGatewayIPv4(address);
  if (ipVersion === 6) return isAllowedGatewayIPv6(address);
  return false;
}

async function resolveGatewayHostForProxy(host, label = "agent gateway", extraAllowedHosts) {
  const normalizedHost = String(host || "").trim();
  if (net.isIP(normalizedHost)) {
    if (!isAllowedGatewayIP(normalizedHost, normalizedHost, extraAllowedHosts)) {
      throw new Error(`${label} host is not an allowed gateway address`);
    }
    return normalizedHost;
  }

  let addresses;
  try {
    addresses = await dns.lookup(normalizedHost, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`${label} host could not be resolved (${error.code || error.message})`);
  }

  const firstAllowed = addresses.find((entry) =>
    isAllowedGatewayIP(entry.address, normalizedHost, extraAllowedHosts),
  );
  if (!firstAllowed) {
    throw new Error(`${label} host does not resolve to an allowed gateway network`);
  }
  return firstAllowed.address;
}

function hostHeaderForGateway(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function hostForUrl(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function normalizeProxySearch(search) {
  const normalized = String(search || "");
  if (!normalized) return "";
  if (!GATEWAY_PROXY_SEARCH_RE.test(normalized) || /[\r\n]/.test(normalized)) {
    throw new Error("gateway query string is not valid");
  }
  return normalized;
}

function normalizeProxyPath(gatewayPath) {
  const cleanPath = String(gatewayPath || "").replace(/^\/+/, "");
  if (
    cleanPath.startsWith("//") ||
    cleanPath.includes("..") ||
    !GATEWAY_PROXY_PATH_RE.test(cleanPath)
  ) {
    throw new Error("gateway path is not valid");
  }
  return cleanPath;
}

async function resolveSafeGatewayHttpTarget(agent, gatewayPath = "", search = "") {
  const addr = assertSafeAgentAddress(resolveGatewayAddress(agent));
  if (!isAllowedGatewayPort(addr.port)) {
    throw new Error("agent gateway port is not allowed for proxying");
  }
  const extraAllowedHosts = await allowedGatewayHostsForAgent(agent);
  const resolvedHost = await resolveGatewayHostForProxy(
    addr.host,
    "agent gateway",
    extraAllowedHosts,
  );
  // The connection is pinned to the validated, resolved IP (no re-resolution at
  // fetch time, so no DNS-rebinding window). The Host header intentionally keeps
  // the operator-configured hostname, not the resolved IP: a gateway reached
  // through a vhost/ingress that routes by Host needs the hostname to land on the
  // right backend. addr.host is already syntactically validated by
  // assertSafeAgentAddress, and it cannot redirect the connection (the URL holds
  // the IP), so this is not an SSRF vector.
  const targetUrl = new URL(`http://${hostForUrl(resolvedHost)}:${addr.port}/`);
  const cleanPath = normalizeProxyPath(gatewayPath);
  targetUrl.pathname = cleanPath ? `/${cleanPath}` : "/";
  targetUrl.search = normalizeProxySearch(search);
  return {
    url: targetUrl.toString(),
    hostHeader: hostHeaderForGateway(addr.host, addr.port),
  };
}

// Validate + resolve a Hermes agent's dashboard address before the embed proxy
// connects to it — the Hermes equivalent of resolveSafeGatewayHttpTarget, which
// closes the SSRF gap where the embed proxy reached runtime_host unchecked.
// Returns the resolved (allowlisted) host + port; throws if disallowed.
async function resolveSafeHermesDashboardTarget(agent) {
  const address = resolveHermesDashboardAddress(agent);
  if (!address) {
    throw new Error("hermes dashboard is not available for this agent");
  }
  const addr = assertSafeAgentAddress(address, "hermes dashboard");
  // Allow either the default dashboard port (HERMES_DASHBOARD_PORT = 9119, the
  // local container) OR a published host port (Docker published port / k8s
  // NodePort) in the gateway port range — those are the two ways the dashboard
  // is exposed. 9119 is outside the gateway port range, hence the explicit OR.
  if (addr.port !== HERMES_DASHBOARD_PORT && !isAllowedGatewayPort(addr.port)) {
    throw new Error("hermes dashboard port is not allowed for proxying");
  }
  const extraAllowedHosts = await allowedGatewayHostsForAgent(agent);
  const resolvedHost = await resolveGatewayHostForProxy(
    addr.host,
    "hermes dashboard",
    extraAllowedHosts,
  );
  return { host: resolvedHost, port: addr.port };
}

// Registration-time gate for adopting an EXTERNAL runtime (BYOC Phase C). Applied
// when an operator registers an already-running OpenClaw/Hermes endpoint by URL,
// so the stored endpoint can never be one the proxy would later refuse — and so a
// PaaS tenant can't register a private-network pivot. Enforces the same hard floor
// (isBlockedGatewayIP, via resolveGatewayHostForProxy) + port allowlist the proxy
// uses; and in hosted (PaaS) mode additionally requires the endpoint to resolve to
// a PUBLIC IP (selfhosted may adopt RFC1918 runtimes on the operator's own network).
//
// Returns the RESOLVED IP (not the hostname): the caller pins this IP on the agent
// row so the proxy connects to the exact validated address at reach time. Storing
// the hostname instead would reopen a DNS-rebinding/TOCTOU hole — the proxy would
// re-resolve it later and trust whatever it then points at (incl. loopback/RFC1918)
// because the hostname sits in the allowlist. Pinning the IP closes that window
// (re-adopt if a runtime's address legitimately changes). Throws if disallowed.
async function assertExternalEndpointReachable(address, { paas = false } = {}) {
  const addr = assertSafeAgentAddress(address, "external runtime");
  if (addr.port !== HERMES_DASHBOARD_PORT && !isAllowedGatewayPort(addr.port)) {
    throw new Error(
      "external runtime port is not allowed — use the gateway port, the Hermes dashboard port, or a published port",
    );
  }
  const resolved = await resolveGatewayHostForProxy(
    addr.host,
    "external runtime",
    new Set([addr.host.toLowerCase()]),
  );
  if (paas && (isAllowedGatewayIPv4(resolved) || isAllowedGatewayIPv6(resolved))) {
    throw new Error(
      "external runtime endpoint must be a public address in hosted mode (private/RFC1918 addresses are not allowed)",
    );
  }
  return { host: resolved, port: addr.port };
}

// ─── Device Identity (Ed25519 keypair for Gateway auth) ──────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function deriveDeviceIdentity(gatewayToken) {
  const seed = crypto
    .createHash("sha256")
    .update("openclaw-device:" + gatewayToken)
    .digest();
  const privateDer = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(ED25519_SPKI_PREFIX.length);
  const deviceId = crypto.createHash("sha256").update(raw).digest("hex");
  const publicKeyB64 = base64UrlEncode(raw);
  return { deviceId, privateKeyPem, publicKeyB64 };
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function buildConnectDevice(identity, role, scopes, nonce) {
  const signedAtMs = Date.now();
  const payload = [
    "v3",
    identity.deviceId,
    "gateway-client",
    "backend",
    role,
    scopes.join(","),
    String(signedAtMs),
    "",
    nonce,
    process.platform,
    "",
  ].join("|");
  const signature = signDevicePayload(identity.privateKeyPem, payload);
  return {
    device: {
      id: identity.deviceId,
      publicKey: identity.publicKeyB64,
      signature,
      signedAt: signedAtMs,
      nonce,
    },
    scopes,
  };
}

// ─── WS-RPC Connection Pool ─────────────────────────────────────

class GatewayConnection {
  constructor(host, token, port) {
    this.host = host;
    this.token = token;
    this.port = port || GATEWAY_PORT;
    this.ws = null;
    this.connected = false;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.eventListeners = new Map(); // event -> Set<callback>
    this._reqId = 0;
    this._connectPromise = null;
    this._identity = deriveDeviceIdentity(token);

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 8;
    this._baseDelay = 1000; // 1s base, doubles each attempt (max ~2 min)

    // Circuit breaker state
    this._circuitState = "closed"; // closed | open | half-open
    this._circuitOpenedAt = 0;
    this._circuitCooldown = 30000; // 30s before half-open probe
    this._consecutiveFailures = 0;
    this._circuitThreshold = 3; // failures before opening circuit
  }

  /** Open WS, complete challenge-response handshake, resolve when ready. */
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error("Gateway connect timeout"));
      }, CONNECT_TIMEOUT);

      this.ws = new WebSocket(`ws://${this.host}:${this.port}`);

      this.ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Phase 1: Challenge → send connect frame with password + device identity.
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const nonce = msg.payload?.nonce || "";
          const role = "operator";
          const scopes = [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
          ];
          const { device } = buildConnectDevice(this._identity, role, scopes, nonce);
          this.ws.send(
            JSON.stringify({
              type: "req",
              id: "__connect__",
              method: "connect",
              params: {
                minProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
                maxProtocol: GATEWAY_MAX_PROTOCOL_VERSION,
                client: {
                  id: "gateway-client",
                  version: "1.0.0",
                  platform: "linux",
                  mode: "backend",
                },
                role,
                scopes,
                caps: ["thinking-events"],
                commands: [],
                auth: this.token ? { password: this.token } : {},
                device,
              },
            }),
          );
          return;
        }

        // Phase 2: Connect response
        if (msg.id === "__connect__") {
          clearTimeout(timer);
          if (msg.ok) {
            this.connected = true;
            resolve(this);
          } else {
            reject(new Error(`Gateway handshake failed: ${msg.error?.message || "unknown"}`));
          }
          return;
        }

        // Dispatch pending RPC responses
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, timer: t } = this.pending.get(msg.id);
          clearTimeout(t);
          this.pending.delete(msg.id);
          res(msg);
          return;
        }

        // Dispatch events
        if (msg.type === "event" && msg.event) {
          const cbs = this.eventListeners.get(msg.event);
          if (cbs) cbs.forEach((cb) => cb(msg));
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timer);
        this.connected = false;
        this._connectPromise = null;
        reject(err);
      });

      this.ws.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._connectPromise = null;
        // Reject all pending
        for (const [id, { reject: rej, timer: t }] of this.pending) {
          clearTimeout(t);
          rej(new Error("Gateway connection closed"));
        }
        this.pending.clear();
        // Attempt background reconnect if we were previously connected
        if (wasConnected) {
          this._scheduleBackgroundReconnect();
        }
      });
    });
    return this._connectPromise;
  }

  /** Send an RPC call and await the response. */
  call(method, params = {}, timeout = CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
        return reject(new Error("Not connected"));
      }
      const id = `r${++this._reqId}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** Subscribe to gateway events. */
  on(event, callback) {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event).add(callback);
  }

  off(event, callback) {
    this.eventListeners.get(event)?.delete(callback);
  }

  /** Attempt reconnection with exponential backoff, respecting circuit breaker. */
  async reconnect() {
    if (this._circuitState === "open") {
      if (Date.now() - this._circuitOpenedAt < this._circuitCooldown) {
        throw new Error("Circuit breaker open — gateway temporarily unavailable");
      }
      this._circuitState = "half-open";
    }

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._openCircuit();
      throw new Error(`Max reconnect attempts (${this._maxReconnectAttempts}) exceeded`);
    }

    this.close();
    const delay = Math.min(this._baseDelay * Math.pow(2, this._reconnectAttempts), 120000);
    console.log(
      `[gatewayProxy] Reconnecting to ${this.host}:${this.port} in ${delay}ms (attempt ${this._reconnectAttempts + 1}/${this._maxReconnectAttempts})`,
    );
    await new Promise((r) => setTimeout(r, delay));
    this._reconnectAttempts++;

    try {
      await this.connect();
      this._reconnectAttempts = 0;
      this._consecutiveFailures = 0;
      this._circuitState = "closed";
    } catch (err) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= this._circuitThreshold) {
        this._openCircuit();
      }
      throw err;
    }
  }

  _openCircuit() {
    this._circuitState = "open";
    this._circuitOpenedAt = Date.now();
    console.warn(
      `[gatewayProxy] Circuit breaker OPEN for ${this.host} — cooling down ${this._circuitCooldown / 1000}s`,
    );
  }

  /** Schedule a background reconnect attempt (non-blocking). */
  _scheduleBackgroundReconnect() {
    if (this._backgroundReconnecting) return;
    this._backgroundReconnecting = true;
    this.reconnect()
      .then(() => console.log(`[gatewayProxy] Background reconnect succeeded for ${this.host}`))
      .catch(() => {}) // silently fail — next getConnection() call will retry
      .finally(() => {
        this._backgroundReconnecting = false;
      });
  }

  close() {
    this.connected = false;
    this._connectPromise = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* socket already closed */
      }
      this.ws = null;
    }
  }

  get isAlive() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  get circuitState() {
    return this._circuitState;
  }
}

// Simple connection pool: one connection per resolved gateway address
const pool = new Map(); // host:port -> GatewayConnection

async function getConnection(agent) {
  const rawAddr = resolveGatewayAddress(agent);
  if (!rawAddr) throw new Error("Agent gateway not yet provisioned");
  const addr = assertSafeAgentAddress(rawAddr);
  if (!isAllowedGatewayPort(addr.port)) {
    throw new Error("Agent gateway port is not allowed");
  }
  const key = `${addr.host}:${addr.port}`;
  let conn = pool.get(key);
  if (conn?.isAlive) return conn;

  // Check circuit breaker — if cooldown elapsed, reset fully and retry
  if (conn?.circuitState === "open") {
    if (Date.now() - conn._circuitOpenedAt < conn._circuitCooldown) {
      throw new Error("Circuit breaker open — gateway temporarily unavailable");
    }
    // Cooldown expired — clean up and start fresh
    conn.close();
    pool.delete(key);
    conn = null;
  }

  // Clean up dead connection
  if (conn) {
    conn.close();
    pool.delete(key);
  }

  // Validate + resolve the gateway host before opening a NEW connection (the
  // alive-cache hit above already passed this when it was created). Closes the
  // gap where the RPC pool checked only the port, not the host.
  const extraAllowedHosts = await allowedGatewayHostsForAgent(agent);
  const connectHost = await resolveGatewayHostForProxy(
    addr.host,
    "agent gateway",
    extraAllowedHosts,
  );
  // gateway_token is encrypted at rest; decrypt() is transparent to legacy
  // plaintext, so it is safe regardless of the token's storage form.
  conn = new GatewayConnection(connectHost, decrypt(agent.gateway_token), addr.port);
  pool.set(key, conn);
  try {
    await conn.connect();
  } catch (err) {
    // First connect failed — try one reconnect with backoff
    try {
      await conn.reconnect();
    } catch {
      pool.delete(key);
      throw err;
    }
  }
  return conn;
}

// ─── Helpers ─────────────────────────────────────────────────────

async function resolveAgent(agentId, userId) {
  const result = await db.query(
    `SELECT id, name, status, container_id, host, backend_type, gateway_token,
            gateway_host_port, gateway_host, gateway_port, runtime_host,
            runtime_port, runtime_family, deploy_target, execution_target_id, user_id
       FROM agents WHERE id = $1`,
    [agentId],
  );
  const agent = result.rows[0];
  if (!agent || agent.user_id !== userId) return null;
  return agent;
}

/** Make an RPC call to an agent's gateway, return the result or throw. */
async function rpcCall(agent, method, params = {}, timeout) {
  const conn = await getConnection(agent);
  const msg = await conn.call(method, params, timeout);
  if (msg.ok === false) {
    const err = new Error(msg.error?.message || "RPC error");
    err.code = msg.error?.code || "GATEWAY_ERROR";
    throw err;
  }
  return msg.result !== undefined ? msg.result : msg.payload || {};
}

function extractToolList(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.tools)) return result.tools;
  if (Array.isArray(result.catalog)) return result.catalog;
  if (Array.isArray(result.items)) return result.items;
  return [];
}

function replaceToolList(result, tools) {
  if (Array.isArray(result)) return tools;
  if (!result || typeof result !== "object") {
    return { tools };
  }
  if (Array.isArray(result.tools)) return { ...result, tools };
  if (Array.isArray(result.catalog)) return { ...result, catalog: tools };
  if (Array.isArray(result.items)) return { ...result, items: tools };
  return { ...result, tools };
}

function getToolName(tool, index) {
  if (tool?.function?.name) return String(tool.function.name);
  if (tool?.name) return String(tool.name);
  return `tool_${index + 1}`;
}

// ─── HTTP Routes ─────────────────────────────────────────────────

function createGatewayRouter() {
  const router = require("express").Router();

  function normalizeCronScheduleInput(schedule) {
    if (!schedule) return null;
    if (typeof schedule === "string") {
      const trimmed = schedule.trim();
      return trimmed ? { kind: "cron", expr: trimmed } : null;
    }
    if (typeof schedule !== "object" || Array.isArray(schedule)) return null;

    if (typeof schedule.kind === "string") {
      if (schedule.kind === "cron" && typeof schedule.expr === "string" && schedule.expr.trim()) {
        return { kind: "cron", expr: schedule.expr.trim() };
      }
      if (schedule.kind === "interval") {
        const everyMs = Number(schedule.everyMs);
        if (Number.isFinite(everyMs) && everyMs > 0) {
          return { kind: "interval", everyMs: Math.max(1, Math.floor(everyMs)) };
        }
      }
      if (schedule.kind === "at" && typeof schedule.at === "string" && schedule.at.trim()) {
        return { kind: "at", at: schedule.at.trim() };
      }
    }

    if (Number.isFinite(Number(schedule.interval))) {
      return {
        kind: "interval",
        everyMs: Math.max(1, Number(schedule.interval)) * 1000,
      };
    }
    if (typeof schedule.cron === "string" && schedule.cron.trim()) {
      return { kind: "cron", expr: schedule.cron.trim() };
    }
    if (typeof schedule.expr === "string" && schedule.expr.trim()) {
      return { kind: "cron", expr: schedule.expr.trim() };
    }
    if (Number.isFinite(Number(schedule.everyMs))) {
      return {
        kind: "interval",
        everyMs: Math.max(1, Math.floor(Number(schedule.everyMs))),
      };
    }
    if (typeof schedule.at === "string" && schedule.at.trim()) {
      return { kind: "at", at: schedule.at.trim() };
    }
    return null;
  }

  // Middleware: resolve agent + verify ownership
  // Allow both 'running' and 'warning' statuses — 'warning' means the post-deploy
  // health check was inconclusive (e.g. npm install was slow), but the gateway may
  // still be reachable. Blocking 'warning' agents would break all tabs even when the
  // gateway eventually starts successfully.
  router.use("/agents/:agentId/gateway", async (req, res, next) => {
    try {
      const agent = await resolveAgent(req.params.agentId, req.user.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      if (resolveAgentRuntimeFamily(agent) !== "openclaw") {
        return res.status(409).json({
          error: "This runtime family does not expose an OpenClaw gateway",
        });
      }
      if (agent.status !== "running" && agent.status !== "warning") {
        return res.status(409).json({ error: `Agent is ${agent.status}, not running` });
      }
      if (!hasGatewayEndpoint(agent)) {
        return res.status(409).json({ error: "Agent gateway not yet provisioned" });
      }
      req.agent = agent;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Gateway Status (combines health + status) ──
  router.get("/agents/:agentId/gateway/status", async (req, res) => {
    try {
      const [health, status] = await Promise.all([
        rpcCall(req.agent, "health").catch(() => null),
        rpcCall(req.agent, "status").catch(() => null),
      ]);
      if (!health && !status) {
        throw new Error("Gateway returned no health or status response");
      }
      // If we got a successful health response and the agent is in 'warning' state,
      // auto-promote to 'running' — the gateway proved itself healthy.
      if (health && req.agent.status === "warning") {
        db.query("UPDATE agents SET status = 'running' WHERE id = $1", [req.agent.id]).catch(
          () => {},
        );
      }
      res.json({ health, status });
    } catch (err) {
      res.status(502).json({ error: "Gateway unreachable", details: err.message });
    }
  });

  // ── Chat (send message via WebSocket RPC) ──
  router.post("/agents/:agentId/gateway/chat", async (req, res) => {
    try {
      const conn = await getConnection(req.agent);
      const { message, messages, session_id, stream } = req.body;
      const idempotencyKey = crypto.randomUUID();
      // Wall-clock start for the OpenTelemetry chat span duration.
      const chatStartedAtMs = Date.now();

      // Build the text payload: accept either a single `message` string
      // or an array of `messages` (OpenAI-style) and extract the last user turn.
      let text = "";
      if (message) {
        text = message;
      } else if (Array.isArray(messages) && messages.length > 0) {
        const last = messages[messages.length - 1];
        text = typeof last === "string" ? last : last.content || "";
      }

      const params = {
        sessionKey: session_id || "main",
        idempotencyKey,
        message: text,
      };

      if (stream) {
        // SSE streaming: listen for chat events, forward as SSE
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // chat.send is NON-BLOCKING — it returns immediately with { runId, status: "started" }.
        // The actual response streams via "chat" events (state: "delta", "final", "error").
        // We must keep listening for events AFTER the RPC resolves.

        let streamDone = false;
        let sawAssistantContent = false;
        let finalTokenPayload = null;
        const streamHandler = (evt) => {
          const payload = evt.payload || evt;
          const state = payload.state;
          const role = payload.message?.role;

          // Forward every event to the client as SSE
          res.write(`data: ${JSON.stringify(payload)}\n\n`);

          // Track when assistant content starts streaming
          if (role === "assistant" || (!role && state === "delta" && sawAssistantContent)) {
            sawAssistantContent = true;
          }

          // Only mark done on the ASSISTANT's final/error — not the user message echo.
          // The gateway sends a "final" for the user message before the assistant starts.
          if (state === "final" || state === "error" || state === "aborted") {
            if (role !== "user" && role !== "human" && sawAssistantContent) {
              if (state === "final") finalTokenPayload = payload;
              streamDone = true;
            }
          }
        };

        conn.on("chat", streamHandler);
        conn.on("agent", streamHandler);

        // Send the message — resolves immediately with { runId, status: "started" }
        let runId = null;
        try {
          const result = await conn.call("chat.send", params, CALL_TIMEOUT);
          runId = result.result?.runId || result.payload?.runId;
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
          conn.off("chat", streamHandler);
          conn.off("agent", streamHandler);
          res.write("data: [DONE]\n\n");
          res.end();
          metrics
            .recordMetric(req.agent.id, req.user.id, "error", 1, { error: err.message })
            .catch(() => {});
          return;
        }

        // Wait for the stream to complete (chat:final / chat:error / timeout)
        const streamTimeout = CHAT_TIMEOUT;
        const startTime = Date.now();
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (streamDone || Date.now() - startTime > streamTimeout) {
              clearInterval(check);
              resolve();
            }
          }, 200);
          // Also resolve if the client disconnects
          req.on("close", () => {
            clearInterval(check);
            resolve();
          });
        });

        conn.off("chat", streamHandler);
        conn.off("agent", streamHandler);

        // Record metrics
        metrics.recordMetric(req.agent.id, req.user.id, "messages_sent", 1).catch(() => {});
        metrics
          .recordTokenUsage(req.agent, req.user.id, finalTokenPayload, {
            source: "openclaw.gateway",
            sessionId: session_id || "main",
            requestId: idempotencyKey,
            startedAtMs: chatStartedAtMs,
          })
          .then(() => agentBudgets.checkAndEnforce(req.agent))
          .catch(() => {});

        res.write(`data: ${JSON.stringify({ type: "done", runId })}\n\n`);
        res.write("data: [DONE]\n\n");
        if (!res.writableEnded) res.end();
      } else {
        // Non-streaming: wait for final response
        const result = await rpcCall(req.agent, "chat.send", params, CHAT_TIMEOUT);
        // Record metrics
        metrics.recordMetric(req.agent.id, req.user.id, "messages_sent", 1).catch(() => {});
        metrics
          .recordTokenUsage(req.agent, req.user.id, result, {
            source: "openclaw.gateway",
            sessionId: session_id || "main",
            requestId: idempotencyKey,
            startedAtMs: chatStartedAtMs,
          })
          .then(() => agentBudgets.checkAndEnforce(req.agent))
          .catch(() => {});
        res.json(result);
      }
    } catch (err) {
      if (!res.headersSent) {
        if (req.agent?.id && req.user?.id) {
          metrics
            .recordMetric(req.agent.id, req.user.id, "error", 1, { error: err.message })
            .catch(() => {});
        }
        res.status(502).json({ error: "Chat failed", details: err.message });
      }
    }
  });

  // ── Sessions ──
  router.get("/agents/:agentId/gateway/sessions", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "sessions.list");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/agents/:agentId/gateway/sessions/:sessionKey", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "sessions.get", { key: req.params.sessionKey });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.delete("/agents/:agentId/gateway/sessions/:sessionKey", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "sessions.delete", { key: req.params.sessionKey });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Sessions are created implicitly by sending a chat.send with a new sessionKey.
  // This endpoint generates a key and returns it so the UI can start using it.
  router.post("/agents/:agentId/gateway/sessions", async (req, res) => {
    try {
      const { name } = req.body;
      const key = name || `session-${crypto.randomUUID().slice(0, 8)}`;
      res.json({ key, created: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Cron ──
  router.get("/agents/:agentId/gateway/cron", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "cron.list");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/agents/:agentId/gateway/cron/status", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "cron.status");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.post("/agents/:agentId/gateway/cron", async (req, res) => {
    try {
      const { name, schedule, message, agentId: targetAgent } = req.body;
      const scheduleObj = normalizeCronScheduleInput(schedule);
      if (!scheduleObj) {
        return res.status(400).json({ error: "A valid cron schedule is required." });
      }
      const result = await rpcCall(req.agent, "cron.add", {
        name,
        schedule: scheduleObj,
        sessionTarget: "new",
        payload: { message: message || "" },
        agentId: targetAgent || "main",
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.put("/agents/:agentId/gateway/cron/:cronId", async (req, res) => {
    try {
      const cronId = req.params.cronId;
      const { name, schedule, message, agentId: targetAgent } = req.body || {};

      const existingList = await rpcCall(req.agent, "cron.list");
      const jobs = Array.isArray(existingList)
        ? existingList
        : Array.isArray(existingList?.jobs)
          ? existingList.jobs
          : [];
      const existingJob = jobs.find((job) => String(job?.id || job?.cronId) === String(cronId));

      if (!existingJob) {
        return res.status(404).json({ error: "Cron job not found" });
      }

      const scheduleObj =
        normalizeCronScheduleInput(schedule) ||
        normalizeCronScheduleInput(existingJob?.schedule) ||
        normalizeCronScheduleInput(existingJob?.cadence);
      if (!scheduleObj) {
        return res.status(400).json({
          error:
            "This cron job is missing a readable schedule. Enter a cron expression before saving.",
        });
      }

      const addResult = await rpcCall(req.agent, "cron.add", {
        name,
        schedule: scheduleObj,
        sessionTarget: existingJob?.sessionTarget || "new",
        payload: {
          ...(existingJob?.payload && typeof existingJob.payload === "object"
            ? existingJob.payload
            : {}),
          message: message || "",
        },
        agentId: targetAgent || existingJob?.agentId || "main",
      });

      await rpcCall(req.agent, "cron.remove", { id: cronId });

      res.json({
        success: true,
        previousId: cronId,
        ...(addResult && typeof addResult === "object" ? addResult : { job: addResult }),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.delete("/agents/:agentId/gateway/cron/:cronId", async (req, res) => {
    try {
      const linkedIntegration = await integrations.findActiveIntegrationByCronJobId(
        req.params.agentId,
        req.params.cronId,
      );
      const result = await rpcCall(req.agent, "cron.remove", { id: req.params.cronId });
      if (linkedIntegration) {
        await integrations.updateEmailCronJobId(linkedIntegration.id, req.params.agentId, null);
        if (linkedIntegration.provider === "email") {
          await integrations.updateIntegration(linkedIntegration.id, req.params.agentId, null, {
            "cron.enabled": false,
          });
        }
      }
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Tools ──
  router.get("/agents/:agentId/gateway/tools", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "tools.catalog");
      const gatewayTools = extractToolList(result);
      const reservedNames = new Set(gatewayTools.map((tool, index) => getToolName(tool, index)));
      const syncedIntegrations = await integrations
        .getIntegrationsForSync(req.agent.id)
        .catch(() => []);
      const integrationTools = integrations.buildIntegrationToolCatalogEntries(syncedIntegrations, {
        reservedNames,
      });
      res.json(replaceToolList(result, [...gatewayTools, ...integrationTools]));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Models ──
  router.get("/agents/:agentId/gateway/models", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "models.list");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Config ──
  router.get("/agents/:agentId/gateway/config", async (req, res) => {
    try {
      const result = await rpcCall(req.agent, "config.get");
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Generic RPC call (for advanced use) ──
  router.post("/agents/:agentId/gateway/rpc", async (req, res) => {
    try {
      const { method, params } = req.body;
      if (!method) return res.status(400).json({ error: "method required" });
      const result = await rpcCall(req.agent, method, params || {});
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Gateway UI Proxy ──
  // Proxies the OpenClaw gateway's built-in control UI for iframe embedding.
  // The UI HTML uses relative paths (./assets/*, ./favicon.*), so we proxy:
  //   /agents/:id/gateway/ui       → gateway root (HTML)
  //   /agents/:id/gateway/assets/* → gateway /assets/* (JS, CSS)
  //   /agents/:id/gateway/favicon* → gateway /favicon* (icons)
  //   /agents/:id/gateway/__openclaw__/* → gateway internal paths
  const proxyGatewayUiRoot = createGatewayPathProxy("");
  const proxyGatewayUiChild = createGatewayPathProxy("ui");
  const proxyGatewayAssetPath = createGatewayPathProxy("assets");
  const proxyGatewayInternalPath = createGatewayPathProxy("__openclaw__");

  router.get("/agents/:agentId/gateway/ui", proxyGatewayUiRoot);
  router.use("/agents/:agentId/gateway", (req, res, next) => {
    if (req.path.startsWith("/ui/")) return proxyGatewayUiChild(req, res);
    if (req.path === "/assets" || req.path.startsWith("/assets/")) {
      return proxyGatewayAssetPath(req, res);
    }
    if (req.path.startsWith("/favicon")) return proxyGatewayFavicon(req, res);
    if (
      (req.method === "GET" || req.method === "POST") &&
      (req.path === "/__openclaw__" || req.path.startsWith("/__openclaw__/"))
    ) {
      return proxyGatewayInternalPath(req, res);
    }
    return next();
  });

  function createGatewayPathProxy(prefix) {
    return async (req, res) => {
      try {
        const gatewayPath = buildGatewayProxyPath(req, prefix);
        const target = await resolveSafeGatewayHttpTarget(
          req.agent,
          gatewayPath,
          req._parsedUrl?.search || "",
        );

        const resp = await fetch(target.url, {
          method: req.method,
          headers: {
            Accept: req.headers.accept || "*/*",
            "Accept-Encoding": "identity",
            Host: target.hostHeader,
          },
          signal: AbortSignal.timeout(15000),
        });

        res.status(resp.status);
        const ct = resp.headers.get("content-type");
        if (ct) res.setHeader("Content-Type", ct);
        const cc = resp.headers.get("cache-control");
        if (cc) res.setHeader("Cache-Control", cc);

        const body = await resp.arrayBuffer();
        res.send(Buffer.from(body));
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: "Gateway UI unreachable", details: err.message });
        }
      }
    };
  }

  async function proxyGatewayFavicon(req, res) {
    try {
      const fullPath = req.path.replace(/^\/+/, "") || "favicon.svg";
      const target = await resolveSafeGatewayHttpTarget(req.agent, fullPath);
      const resp = await fetch(target.url, {
        headers: { Host: target.hostHeader },
        signal: AbortSignal.timeout(5000),
      });
      res.status(resp.status);
      const ct = resp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      const body = await resp.arrayBuffer();
      res.send(Buffer.from(body));
    } catch {
      res.status(404).end();
    }
  }

  function buildGatewayProxyPath(req, prefix) {
    if (!prefix) return "";
    const normalizedPath = String(req.path || "").replace(/^\/+/, "");
    if (!normalizedPath || normalizedPath === prefix) return prefix;
    if (normalizedPath.startsWith(`${prefix}/`)) return normalizedPath;
    return `${prefix}/${normalizedPath}`;
  }

  return router;
}

// ─── WebSocket Relay ─────────────────────────────────────────────
// Clients connect to: ws://<host>/ws/gateway/<agentId>?token=<jwt>
// The server performs the Gateway handshake, then relays bidirectionally.

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const sep = entry.indexOf("=");
      if (sep === -1) return cookies;
      const key = entry.slice(0, sep).trim();
      const value = entry.slice(sep + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});
}

function attachGatewayWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/gateway\/([a-zA-Z0-9_-]+)$/);
    if (!match) return; // not ours — let other handlers process

    const agentId = match[1];
    // Authenticate via the HttpOnly embed session cookie (scoped+agentId-bound
    // JWT). The browser sends this cookie automatically on same-origin WS
    // upgrades, so the token never appears in the URL/query-string and isn't
    // captured by request-logging layers or browser history.
    const cookies = parseCookieHeader(request.headers.cookie || "");
    const cookieName = `__nora_gateway_embed_${agentId}`;
    const cookieToken = cookies[cookieName];
    if (!cookieToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let payload;
    try {
      payload = jwt.verify(cookieToken, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (payload.scope !== "gateway-embed" || payload.agentId !== agentId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, agentId, payload);
    });
  });

  wss.on("connection", async (ws, _req, agentId, user) => {
    try {
      const agent = await resolveAgent(agentId, user.id);
      if (!agent) {
        ws.send(JSON.stringify({ type: "error", message: "Agent not found" }));
        ws.close();
        return;
      }
      if (
        (agent.status !== "running" && agent.status !== "warning") ||
        !hasGatewayEndpoint(agent)
      ) {
        ws.send(JSON.stringify({ type: "error", message: `Agent is ${agent.status}` }));
        ws.close();
        return;
      }

      // Decrypt once; reused for the device identity and the relay connect auth.
      const gatewayToken = decrypt(agent.gateway_token);
      const identity = deriveDeviceIdentity(gatewayToken);
      let handshakeComplete = false;
      let connectPayload = null; // stored relay handshake payload
      let pendingClientConnect = null; // client's connect msg awaiting relay handshake
      const clientQueue = []; // buffer client messages until handshake is done
      let relayConnectNonce = "";
      let relayConnectSent = false;
      let relayConnectTimer = null;

      const addr = assertSafeAgentAddress(resolveGatewayAddress(agent));
      if (!isAllowedGatewayPort(addr.port)) {
        throw new Error("Agent gateway port is not allowed");
      }
      // Validate + resolve the gateway host (the WS relay previously checked
      // only the port). Throws here are caught below → client gets an error.
      const relayExtraAllowedHosts = await allowedGatewayHostsForAgent(agent);
      const relayHost = await resolveGatewayHostForProxy(
        addr.host,
        "agent gateway",
        relayExtraAllowedHosts,
      );
      const gwWs = new WebSocket(`ws://${relayHost}:${addr.port}`);
      const role = "operator";
      const scopes = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ];

      function clearRelayConnectTimer() {
        if (relayConnectTimer) {
          clearTimeout(relayConnectTimer);
          relayConnectTimer = null;
        }
      }

      function sendRelayConnect() {
        if (relayConnectSent || gwWs.readyState !== WebSocket.OPEN) return;
        relayConnectSent = true;
        clearRelayConnectTimer();
        const { device } = buildConnectDevice(identity, role, scopes, relayConnectNonce);
        gwWs.send(
          JSON.stringify({
            type: "req",
            id: "__relay_connect__",
            method: "connect",
            params: {
              minProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
              maxProtocol: GATEWAY_MAX_PROTOCOL_VERSION,
              client: {
                id: "gateway-client",
                version: "1.0.0",
                platform: "linux",
                mode: "backend",
              },
              role,
              scopes,
              caps: ["thinking-events"],
              commands: [],
              auth: gatewayToken ? { password: gatewayToken } : {},
              device,
            },
          }),
        );
      }

      function queueRelayConnect() {
        if (relayConnectSent) return;
        clearRelayConnectTimer();
        relayConnectTimer = setTimeout(() => {
          sendRelayConnect();
        }, RELAY_CONNECT_DELAY_MS);
      }

      function respondToClientConnect(connectRequestId) {
        if (!connectRequestId || ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            type: "res",
            id: connectRequestId,
            ok: true,
            payload: connectPayload || {},
          }),
        );
      }

      gwWs.on("open", () => {
        queueRelayConnect();
      });

      gwWs.on("message", (raw) => {
        const str = raw.toString();
        if (!handshakeComplete) {
          let msg;
          try {
            msg = JSON.parse(str);
          } catch {
            return;
          }

          if (msg.type === "event" && msg.event === "connect.challenge") {
            // Forward challenge to client so its UI can go through the normal auth flow
            if (ws.readyState === WebSocket.OPEN) ws.send(str);
            if (!relayConnectSent && typeof msg.payload?.nonce === "string" && msg.payload.nonce) {
              relayConnectNonce = msg.payload.nonce;
              sendRelayConnect();
            }
            return;
          }

          if (msg.id === "__relay_connect__") {
            if (msg.ok) {
              handshakeComplete = true;
              connectPayload = msg.payload !== undefined ? msg.payload : msg.result || {};
              // If client already sent connect while we were handshaking, respond now
              if (pendingClientConnect) {
                respondToClientConnect(pendingClientConnect.id);
                pendingClientConnect = null;
              }
              // Flush any buffered non-connect client messages
              for (const queued of clientQueue) {
                if (gwWs.readyState === WebSocket.OPEN) gwWs.send(queued);
              }
              clientQueue.length = 0;
            } else {
              console.error(`[gatewayProxy] WS relay handshake failed for ${agentId}:`, msg.error);
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: `Gateway handshake failed: ${msg.error?.message || "unknown"}`,
                }),
              );
              ws.close();
              gwWs.close();
            }
            return;
          }
        }
        // Post-handshake: relay gateway → client
        if (ws.readyState === WebSocket.OPEN) ws.send(str);
      });

      ws.on("message", (data) => {
        const str = data.toString();
        try {
          const msg = JSON.parse(str);
          if (msg.method === "connect") {
            // Relay already authenticated (or is authenticating) — don't forward to gateway.
            // Respond with the relay's stored result so the client UI completes its auth flow.
            if (handshakeComplete) {
              respondToClientConnect(msg.id);
            } else {
              // Relay still handshaking — respond when ready
              pendingClientConnect = msg;
            }
            return;
          }
        } catch {
          /* not JSON */
        }
        if (!handshakeComplete) {
          clientQueue.push(str);
          return;
        }
        if (gwWs.readyState === WebSocket.OPEN) gwWs.send(str);
      });

      gwWs.on("close", (code, reason) => {
        clearRelayConnectTimer();
        const reasonStr = reason ? reason.toString() : "";
        const phase = handshakeComplete ? "after auth" : "before auth";
        console.error(
          `[gatewayProxy] WS relay gateway closed for ${agentId} ${phase}: code=${code} reason=${reasonStr}`,
        );
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "system",
              message: `Gateway closed (${code}${reasonStr ? ": " + reasonStr : ""})`,
            }),
          );
          ws.close();
        }
      });
      gwWs.on("error", (err) => {
        clearRelayConnectTimer();
        console.error(`[gatewayProxy] WS relay error for agent ${agentId}:`, err.message);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      ws.on("close", () => {
        clearRelayConnectTimer();
        if (gwWs.readyState === WebSocket.OPEN || gwWs.readyState === WebSocket.CONNECTING)
          gwWs.close();
      });
    } catch (err) {
      console.error(`[gatewayProxy] WS error:`, err.message);
      ws.send(JSON.stringify({ type: "error", message: err.message }));
      ws.close();
    }
  });

  return wss;
}

/** Evict a cached gateway connection so the next request creates a fresh one.
 *  Called after authSync restarts an agent container. */
function evictConnection(target) {
  const address =
    typeof target === "string" ? { host: target } : resolveGatewayAddress(target || {});
  if (!address?.host) return;

  const keyPrefix = `${address.host}:`;
  for (const [key, conn] of pool) {
    if (
      key === address.host ||
      key === `${address.host}:${address.port}` ||
      key.startsWith(keyPrefix)
    ) {
      conn.close();
      pool.delete(key);
      console.log(`[gatewayProxy] Evicted connection for ${key}`);
    }
  }
}

module.exports = {
  createGatewayRouter,
  attachGatewayWS,
  rpcCall,
  resolveAgent,
  evictConnection,
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
  assertExternalEndpointReachable,
  resolveGatewayHostForProxy,
  allowedGatewayHostsForAgent,
};
