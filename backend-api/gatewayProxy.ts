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
const { scopeByMethod } = require("./middleware/auth");
const {
  buildAccessibleAgentQuery,
  findAccessibleAgentForRequest,
  requireApiKeyAgentScope,
  roleSatisfies,
} = require("./middleware/ownership");

// The OpenClaw gateway — REST routes, the control-UI embed, and the relay
// WebSocket — is an operate-the-agent capability end to end: it carries chat,
// exec, restart, and the runtime password. There is no read-only slice worth
// carving out, so the whole surface takes one bar. Workspace viewers are
// unaffected; this path was owner-only before, so `editor` only widens access.
const GATEWAY_MIN_WORKSPACE_ROLE = "editor";
const remoteHosts = require("./remoteHosts");
const { PRIVATE_IP_RE } = require("./networkSafety");
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
const SESSION_MESSAGE_SUBSCRIBE_TIMEOUT = 5000;
const AGENT_TERMINAL_FALLBACK_GRACE_MS = 100;
// OpenClaw 2026.6 keeps lifecycle errors retryable for 15 seconds while it
// attempts provider/model fallback. Wait just beyond that upstream window
// unless the gateway explicitly reports that fallback is exhausted.
const AGENT_ERROR_FALLBACK_GRACE_MS = 16000;
const RELAY_CONNECT_DELAY_MS = 750;
const REMOTE_HOST_AUTH_RECHECK_MS = Math.max(
  250,
  Number.parseInt(process.env.REMOTE_HOST_AUTH_RECHECK_MS || "1000", 10) || 1000,
);
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
const EXTERNAL_GATEWAY_TOKEN_MIN_LENGTH = 32;
const EXTERNAL_GATEWAY_TOKEN_MAX_LENGTH = 4096;

// Hostname must be a plain DNS name / IP literal — no URL meta-chars that
// could alter the parsed origin (no "@", "/", "?", "#", ":", whitespace, etc.).
// Compose-internal aliases like "worker-provisioner" are intentionally allowed;
// this is a syntactic guard against injection via agent DB fields, not an
// allowlist of ranges.
const GATEWAY_HOST_RE = /^[A-Za-z0-9._-]+$/;

// ─── SSRF-safe endpoint resolution ──────────────────────────────

/**
 * Validate an agent-derived host and port before any proxy resolution or connection.
 *
 * @param {Object} addr - Address resolved from persisted agent fields.
 * @param {string} [label="agent gateway"] - Endpoint label used in validation errors.
 * @returns {Object} Trimmed host and validated numeric port.
 */
function assertSafeAgentAddress(addr, label = "agent gateway") {
  if (!addr || typeof addr !== "object") {
    throw new Error(`${label} address is missing`);
  }
  const host = typeof addr.host === "string" ? addr.host.trim() : "";
  if (!host || host.length > 253 || (!net.isIP(host) && !GATEWAY_HOST_RE.test(host))) {
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

function assertRemoteGatewayAccessSupported(agent) {
  if (!remoteHosts.isRemoteDockerAgent(agent)) return;
  if (
    String(process.env.PLATFORM_MODE || "selfhosted")
      .trim()
      .toLowerCase() !== "paas"
  ) {
    return;
  }

  const error = new Error(
    "Remote Docker gateway access is disabled in hosted mode because runtime traffic is not end-to-end encrypted",
  );
  error.statusCode = 403;
  error.code = "REMOTE_HOSTS_DISABLED_IN_PAAS";
  throw error;
}

// A registered remote host's advertised address is operator-trusted, so allow
// it even though it is not RFC1918/loopback. Scoped to the agent's OWN host
// (looked up by execution target) AND to a user who may use it — the agent's
// owner, OR (C3) a workspace the host is shared into where the owner is editor+.
// A cross-tenant execution_target_id reference still can't reach a host that was
// never shared to the agent owner. Blocked addresses (0.0.0.0, link-local, …) still apply.
async function allowedRemoteHostsForAgent(agent) {
  if (!remoteHosts.isRemoteDockerAgent(agent)) {
    return EMPTY_ALLOWED_HOSTS;
  }
  // Fail before consulting the registry. This protects historical/imported
  // remote-agent rows too, and every caller (HTTP proxy, RPC pool, Hermes
  // embed, and WS relay) shares this boundary.
  assertRemoteGatewayAccessSupported(agent);
  const host = await assertCurrentGatewayAccess(agent);
  if (!host) {
    const error = new Error("Unable to verify Remote Docker gateway host access");
    error.code = "REMOTE_HOST_AUTH_CHECK_FAILED";
    error.statusCode = 503;
    throw error;
  }
  const allowed = new Set();
  if (host.gatewayHost) allowed.add(String(host.gatewayHost).toLowerCase());
  if (host.sshHost) allowed.add(String(host.sshHost).toLowerCase());
  if (host.rawGatewayHost) allowed.add(String(host.rawGatewayHost).toLowerCase());
  if (host.rawSshHost) allowed.add(String(host.rawSshHost).toLowerCase());
  return allowed;
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
/**
 * Resolve agent-scoped host exceptions without weakening the hard blocked-address floor.
 *
 * @param {Object} agent - Agent whose deployment target defines trusted endpoint hosts.
 * @returns {Promise<Set>} Lowercase hostnames or addresses trusted for this agent only.
 */
async function allowedGatewayHostsForAgent(agent) {
  const target = normalizeDeployTargetName(agent?.deploy_target);
  if (remoteHosts.isRemoteDockerAgent(agent)) return allowedRemoteHostsForAgent(agent);
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

async function assertCurrentGatewayAccess(agent) {
  if (!remoteHosts.isRemoteDockerAgent(agent)) return;
  assertRemoteGatewayAccessSupported(agent);
  try {
    return await remoteHosts.assertRemoteHostAgentUse(agent, { includeProfile: false });
  } catch (error) {
    throw remoteHosts.toPublicRemoteHostAuthorizationError(error);
  }
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

/**
 * Resolve a gateway hostname to an allowed IP so callers can pin the eventual connection.
 *
 * @param {string} host - Hostname or IP to validate and resolve.
 * @param {string} [label="agent gateway"] - Endpoint label used in errors.
 * @param {Set} [extraAllowedHosts] - Agent-scoped host exceptions.
 * @param {Object} [options={}] - Resolution constraints such as hosted-mode public-only access.
 * @returns {Promise<string>} Allowed concrete IP address.
 */
async function resolveGatewayHostForProxy(
  host,
  label = "agent gateway",
  extraAllowedHosts,
  { publicOnly = false } = {},
) {
  const normalizedHost = String(host || "").trim();
  if (net.isIP(normalizedHost)) {
    if (publicOnly && PRIVATE_IP_RE.test(normalizedHost)) {
      throw new Error(`${label} host must be public in hosted mode`);
    }
    if (!isAllowedGatewayIP(normalizedHost, normalizedHost, extraAllowedHosts)) {
      throw new Error(`${label} host is not an allowed gateway address`);
    }
    return normalizedHost;
  }

  let addresses;
  try {
    addresses = await dns.lookup(normalizedHost, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`${label} host could not be resolved (${error.code || error.message})`, {
      cause: error,
    });
  }

  const firstAllowed = addresses.find(
    (entry) =>
      (!publicOnly || !PRIVATE_IP_RE.test(entry.address)) &&
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

/**
 * Build an SSRF-safe HTTP target using a validated port, path, query, and DNS-pinned IP.
 * The returned Host header preserves the validated operator-configured hostname for ingress routing.
 *
 * @param {Object} agent - Agent whose gateway should be reached.
 * @param {string} [gatewayPath=""] - Gateway-relative path to proxy.
 * @param {string} [search=""] - Query string to validate, including a leading `?`.
 * @returns {Promise<Object>} Pinned target URL and safe upstream Host header.
 */
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
    {
      publicOnly:
        String(process.env.PLATFORM_MODE || "selfhosted").toLowerCase() === "paas" &&
        remoteHosts.isRemoteDockerAgent(agent),
    },
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
/**
 * Resolve an agent's Hermes dashboard to an SSRF-safe, DNS-pinned target.
 *
 * @param {Object} agent - Hermes agent whose dashboard should be reached.
 * @returns {Promise<Object>} Allowed concrete host and validated dashboard port.
 */
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
    {
      publicOnly:
        String(process.env.PLATFORM_MODE || "selfhosted").toLowerCase() === "paas" &&
        remoteHosts.isRemoteDockerAgent(agent),
    },
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
/**
 * Validate and pin an externally adopted runtime endpoint before it is stored.
 * Hosted mode additionally rejects private-network addresses.
 *
 * @param {Object} address - Operator-supplied runtime host and port.
 * @param {Object} [options={}] - Registration environment options.
 * @returns {Promise<Object>} Resolved IP and validated port safe to persist.
 */
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

function containsWhitespaceOrControl(value) {
  for (const symbol of String(value || "")) {
    const codePoint = symbol.codePointAt(0);
    if (/\s/u.test(symbol) || codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function assertStrongExternalGatewayToken(value) {
  const token = String(value || "").trim();
  if (
    token.length < EXTERNAL_GATEWAY_TOKEN_MIN_LENGTH ||
    token.length > EXTERNAL_GATEWAY_TOKEN_MAX_LENGTH ||
    containsWhitespaceOrControl(token)
  ) {
    const error = new Error(
      "gateway_token must be a cryptographically generated secret of 32-4096 characters with no whitespace",
    );
    error.statusCode = 400;
    throw error;
  }
  return token;
}

function isAdoptedExternalAgent(agent) {
  return [agent?.deploy_target, agent?.backend_type, agent?.execution_target_id].some(
    (value) =>
      String(value || "")
        .trim()
        .toLowerCase() === "external",
  );
}

function gatewayTokenForAgent(agent) {
  const token = decrypt(agent?.gateway_token);
  // Existing adopted rows predate the route-level strength contract. Re-check
  // at every connection boundary so a legacy weak bearer secret cannot be used
  // to derive a publicly observable deterministic device identity.
  return isAdoptedExternalAgent(agent) ? assertStrongExternalGatewayToken(token) : token;
}

// ─── Device Identity (Ed25519 keypair for Gateway auth) ──────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/**
 * Derive a deterministic Ed25519 gateway device identity from an agent's secret token.
 *
 * @param {string} gatewayToken - Decrypted gateway token used as key material.
 * @returns {Object} Device id, public key, and in-memory private key.
 */
function deriveDeviceIdentity(gatewayToken) {
  // This is a protocol identity derivation, not password storage. It must stay
  // byte-for-byte aligned with agent-runtime/lib/runtimeBootstrap.ts and
  // integrationTools.ts so existing paired devices keep working. Nora-created
  // gateway tokens contain at least 128 random bits; adopted external runtimes
  // pass assertStrongExternalGatewayToken before their credential is stored.
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

/**
 * Maintain one authenticated gateway socket with RPC correlation, reconnects, and circuit breaking.
 */
class GatewayConnection {
  constructor(
    host,
    token,
    port,
    { resolveHost = null, sourceHost = null, agentId = null, authorize = null } = {},
  ) {
    this.host = host;
    this.token = token;
    this.port = port || GATEWAY_PORT;
    this.agentId = agentId ? String(agentId) : null;
    // Re-resolution hook: `host` is a concrete IP resolved from the agent's
    // service DNS at pool-creation time. On k8s a pod replacement changes the
    // pod IP, so reconnects must re-resolve the ORIGINAL name or they hammer
    // the dead IP until the circuit opens (~30s of 502s per pod swap).
    this._resolveHost = typeof resolveHost === "function" ? resolveHost : null;
    this._sourceHost = sourceHost || host;
    this.ws = null;
    this.connected = false;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.eventListeners = new Map(); // event -> Set<callback>
    this.sessionMessageSubscriptions = new Set(); // unique ref-counted subscription entries
    this.sessionMessageSubscriptionAliases = new Map(); // requested/canonical key -> entry
    this._sessionMessageSubscriptionOperation = Promise.resolve();
    this._reqId = 0;
    this._connectPromise = null;
    this._identity = deriveDeviceIdentity(token);
    this._retired = false;
    this._authorize = typeof authorize === "function" ? authorize : null;
    this._authorizationTimer = null;
    this._authorizationInFlight = false;
    this._authorizationRecheckMs = REMOTE_HOST_AUTH_RECHECK_MS;
    this._retireListeners = new Set();
    this._retireError = null;

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

  /**
   * Open the gateway WebSocket and complete its authorized challenge-response
   * handshake.
   *
   * @returns {Promise<Object>} This connection after the gateway is ready.
   */
  connect() {
    if (this._retired) {
      return Promise.reject(this._retireError || new Error("Gateway connection retired"));
    }
    if (this._connectPromise) return this._connectPromise;
    const connectPromise = this._connectWithAuthorization();
    this._connectPromise = connectPromise;
    void connectPromise.catch(() => {
      if (this._connectPromise === connectPromise) this._connectPromise = null;
      if (!this.connected) this._clearAuthorizationGuard();
    });
    return connectPromise;
  }

  async _connectWithAuthorization() {
    try {
      // Re-check after host resolution and immediately before opening a socket.
      // A pending pooled connection must not inherit the grant observed by the
      // request that began DNS/allowlist work several awaits earlier.
      await this._assertAuthorized();
    } catch (error) {
      this.retire(error);
      throw error;
    }
    if (this._retired) throw this._retireError || new Error("Gateway connection retired");

    // Keep checking while the socket is CONNECTING and while the authenticated
    // challenge handshake is pending, not only after it reaches ready state.
    this._startAuthorizationGuard();

    return new Promise((resolve, reject) => {
      let settled = false;
      let challengeResponsePending = false;
      let timer = null;
      let retireListener = null;
      const cleanupSettlement = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (retireListener) {
          this.offRetire(retireListener);
          retireListener = null;
        }
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        cleanupSettlement();
        reject(error);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanupSettlement();
        resolve(this);
      };
      retireListener = (error) => settleReject(error);
      this.onRetire(retireListener);
      if (settled) return;

      timer = setTimeout(() => {
        const error = new Error("Gateway connect timeout");
        settleReject(error);
        this.close();
      }, CONNECT_TIMEOUT);

      let socket;
      try {
        socket = new WebSocket(`ws://${this.host}:${this.port}`);
        this.ws = socket;
      } catch (error) {
        settleReject(error);
        this._clearAuthorizationGuard();
        return;
      }

      socket.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Phase 1: Challenge → send connect frame with password + device identity.
        if (msg.type === "event" && msg.event === "connect.challenge") {
          if (challengeResponsePending) return;
          challengeResponsePending = true;
          void (async () => {
            try {
              // The challenge response is the first point where the decrypted
              // gateway credential leaves this process. Re-check the current
              // grant at that exact boundary, even if the pre-dial check passed.
              await this._assertAuthorized();
              if (
                settled ||
                this._retired ||
                this.ws !== socket ||
                socket.readyState !== WebSocket.OPEN
              ) {
                return;
              }

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
              socket.send(
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
            } catch (error) {
              settleReject(error);
              this.retire(error);
            }
          })();
          return;
        }

        // Phase 2: Connect response
        if (msg.id === "__connect__") {
          if (this._retired || this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
            settleReject(this._retireError || new Error("Gateway connection retired"));
            return;
          }
          if (msg.ok) {
            this.connected = true;
            settleResolve();
            this._restoreSessionMessageSubscriptions();
          } else {
            const error = new Error(`Gateway handshake failed: ${msg.error?.message || "unknown"}`);
            settleReject(error);
            this.close();
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

      socket.on("error", (err) => {
        this.connected = false;
        this._connectPromise = null;
        this._clearAuthorizationGuard();
        settleReject(err);
      });

      socket.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._connectPromise = null;
        this._clearAuthorizationGuard();
        for (const entry of this.sessionMessageSubscriptions.values()) {
          entry.subscribed = false;
          entry.subscriptionAttempted = false;
          entry.subscriptionSupported = null;
        }
        const closeError = this._retireError || new Error("Gateway connection closed");
        this._rejectPending(closeError);
        settleReject(closeError);
        // Attempt background reconnect if we were previously connected
        if (wasConnected) {
          this._scheduleBackgroundReconnect();
        }
      });
    });
  }

  /**
   * Send an authorized gateway RPC call and await its response.
   *
   * @param {string} method - Gateway RPC method.
   * @param {Object} [params={}] - RPC request parameters.
   * @param {number} [timeout] - Response timeout in milliseconds.
   * @returns {Promise<Object>} Gateway response envelope.
   */
  async call(method, params = {}, timeout = CALL_TIMEOUT) {
    await this._assertAuthorized();
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
      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async _assertAuthorized() {
    if (this._retired) {
      throw this._retireError || new Error("Gateway connection retired");
    }
    if (!this._authorize) return;

    // Authorization storage can be slow or unavailable. Retirement must still
    // reject a connect/call immediately instead of leaving it pinned to an
    // unresolved authorization promise after the host grant is revoked.
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (handler, value) => {
        if (finished) return;
        finished = true;
        this.offRetire(onRetire);
        handler(value);
      };
      const onRetire = (error) => finish(reject, error);
      this.onRetire(onRetire);
      if (finished) return;

      Promise.resolve()
        .then(() => this._authorize())
        .then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
    });

    if (this._retired) {
      throw this._retireError || new Error("Gateway connection retired");
    }
  }

  _startAuthorizationGuard() {
    if (!this._authorize || this._authorizationTimer || this._retired) return;
    this._authorizationTimer = setInterval(async () => {
      if (this._authorizationInFlight || this._retired) return;
      this._authorizationInFlight = true;
      try {
        await this._assertAuthorized();
      } catch (error) {
        this.retire(error);
      } finally {
        this._authorizationInFlight = false;
      }
    }, this._authorizationRecheckMs);
    this._authorizationTimer.unref?.();
  }

  _clearAuthorizationGuard() {
    if (this._authorizationTimer) {
      clearInterval(this._authorizationTimer);
      this._authorizationTimer = null;
    }
  }

  _rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  /**
   * Subscribe a callback to one gateway event name.
   *
   * @param {string} event - Gateway event name.
   * @param {Function} callback - Event callback to register.
   * @returns {void}
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event).add(callback);
  }

  off(event, callback) {
    this.eventListeners.get(event)?.delete(callback);
  }

  /**
   * Register a callback for this connection's retirement. Fires immediately
   * with the retirement error if the connection is already retired, otherwise
   * queues the callback for when `retire()` runs.
   *
   * @param {Function} callback - Invoked with the retirement error.
   * @returns {void}
   */
  onRetire(callback) {
    if (typeof callback !== "function") return;
    if (this._retired) {
      callback(this._retireError || new Error("Gateway connection retired"));
      return;
    }
    this._retireListeners.add(callback);
  }

  offRetire(callback) {
    this._retireListeners.delete(callback);
  }

  _sessionMessageSubscriptionTarget(key) {
    const requestedKey = String(key || "").trim();
    const scopedGlobal = requestedKey.match(/^agent:([^:]+):global$/);
    if (scopedGlobal) {
      const agentId = scopedGlobal[1];
      return {
        requestedKey,
        subscriptionKey: "global",
        agentId,
        identityKey: `agent:${agentId}:global`,
      };
    }
    if (requestedKey === "global") {
      return {
        requestedKey,
        subscriptionKey: "global",
        agentId: "main",
        identityKey: "agent:main:global",
      };
    }
    return {
      requestedKey,
      subscriptionKey: requestedKey,
      agentId: null,
      identityKey: requestedKey,
    };
  }

  _sessionMessageSubscriptionIdentity(key, agentId) {
    return key === "global" ? `agent:${agentId || "main"}:global` : key;
  }

  _queueSessionMessageSubscriptionOperation(operation) {
    const next = this._sessionMessageSubscriptionOperation.then(operation, operation);
    this._sessionMessageSubscriptionOperation = next.catch(() => {});
    return next;
  }

  async _ensureSessionMessageSubscription(entry, timeout) {
    if (
      entry.refs <= 0 ||
      entry.subscribed ||
      entry.subscriptionSupported === false ||
      !this.connected
    ) {
      return entry;
    }
    try {
      entry.subscriptionAttempted = true;
      const params = {
        key: entry.subscriptionKey,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
      };
      const msg = await this.call("sessions.messages.subscribe", params, timeout);
      if (msg.ok === false) {
        entry.subscriptionSupported = false;
        return entry;
      }
      const result = msg.result ?? msg.payload ?? {};
      entry.subscriptionSupported = true;
      entry.subscribed = result.subscribed !== false;
      if (typeof result.key === "string" && result.key.trim()) {
        const canonicalKey = result.key.trim();
        entry.subscriptionKey = canonicalKey;
        const canonicalIdentity = this._sessionMessageSubscriptionIdentity(
          canonicalKey,
          entry.agentId,
        );
        const canonicalEntry = this.sessionMessageSubscriptionAliases.get(canonicalIdentity);
        if (canonicalEntry && canonicalEntry !== entry) {
          canonicalEntry.refs += entry.refs;
          canonicalEntry.subscribed = canonicalEntry.subscribed || entry.subscribed;
          canonicalEntry.subscriptionAttempted =
            canonicalEntry.subscriptionAttempted || entry.subscriptionAttempted;
          canonicalEntry.subscriptionSupported =
            canonicalEntry.subscriptionSupported === true || entry.subscriptionSupported === true
              ? true
              : canonicalEntry.subscriptionSupported === false &&
                  entry.subscriptionSupported === false
                ? false
                : null;
          for (const alias of entry.aliases) {
            canonicalEntry.aliases.add(alias);
            this.sessionMessageSubscriptionAliases.set(alias, canonicalEntry);
          }
          canonicalEntry.aliases.add(canonicalIdentity);
          this.sessionMessageSubscriptionAliases.set(canonicalIdentity, canonicalEntry);
          this.sessionMessageSubscriptions.delete(entry);
          entry = canonicalEntry;
        } else {
          entry.aliases.add(canonicalIdentity);
          this.sessionMessageSubscriptionAliases.set(canonicalIdentity, entry);
        }
      }
    } catch {
      entry.subscribed = false;
    }
    return entry;
  }

  /**
   * Acquire one pooled session-message subscription reference.
   *
   * @param {string} key - Requested session subscription key.
   * @param {number} [timeout] - Subscription RPC timeout in milliseconds.
   * @returns {Promise<boolean>} Whether the upstream subscription is active.
   */
  acquireSessionMessageSubscription(key, timeout = SESSION_MESSAGE_SUBSCRIBE_TIMEOUT) {
    const target = this._sessionMessageSubscriptionTarget(key);
    const { requestedKey } = target;
    if (!requestedKey) return Promise.resolve(false);
    return this._queueSessionMessageSubscriptionOperation(async () => {
      let entry =
        this.sessionMessageSubscriptionAliases.get(requestedKey) ||
        this.sessionMessageSubscriptionAliases.get(target.identityKey);
      if (!entry) {
        entry = {
          refs: 0,
          subscribed: false,
          subscriptionAttempted: false,
          subscriptionSupported: null,
          subscriptionKey: target.subscriptionKey,
          agentId: target.agentId,
          aliases: new Set([requestedKey, target.identityKey]),
          timeout,
        };
        this.sessionMessageSubscriptions.add(entry);
        for (const alias of entry.aliases) {
          this.sessionMessageSubscriptionAliases.set(alias, entry);
        }
      } else {
        entry.aliases.add(requestedKey);
        entry.aliases.add(target.identityKey);
        this.sessionMessageSubscriptionAliases.set(requestedKey, entry);
        this.sessionMessageSubscriptionAliases.set(target.identityKey, entry);
      }
      entry.refs += 1;
      entry.timeout = timeout;
      const canonicalEntry = await this._ensureSessionMessageSubscription(entry, timeout);
      return canonicalEntry.subscribed;
    });
  }

  /**
   * Release one reference and best-effort unsubscribe after the final stream
   * leaves.
   *
   * @param {string} key - Requested session subscription key.
   * @param {number} [timeout] - Unsubscribe RPC timeout in milliseconds.
   * @returns {Promise<boolean>} Whether the final pooled reference was released.
   */
  releaseSessionMessageSubscription(key, timeout = SESSION_MESSAGE_SUBSCRIBE_TIMEOUT) {
    const requestedKey = String(key || "").trim();
    if (!requestedKey) return Promise.resolve(false);
    return this._queueSessionMessageSubscriptionOperation(async () => {
      const entry = this.sessionMessageSubscriptionAliases.get(requestedKey);
      if (!entry) return false;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0) return false;
      const shouldUnsubscribe =
        entry.subscribed || (entry.subscriptionAttempted && entry.subscriptionSupported !== false);
      if (shouldUnsubscribe && this.connected) {
        try {
          await this.call(
            "sessions.messages.unsubscribe",
            {
              key: entry.subscriptionKey,
              ...(entry.agentId ? { agentId: entry.agentId } : {}),
            },
            timeout,
          );
        } catch {
          // Best-effort cleanup; a closed socket drops its subscriptions too.
        }
      }
      entry.subscribed = false;
      entry.subscriptionAttempted = false;
      if (entry.refs === 0) {
        this.sessionMessageSubscriptions.delete(entry);
        for (const alias of entry.aliases) {
          if (this.sessionMessageSubscriptionAliases.get(alias) === entry) {
            this.sessionMessageSubscriptionAliases.delete(alias);
          }
        }
      }
      return true;
    });
  }

  _restoreSessionMessageSubscriptions() {
    this._queueSessionMessageSubscriptionOperation(async () => {
      for (const entry of [...this.sessionMessageSubscriptions]) {
        if (entry.refs <= 0) continue;
        await this._ensureSessionMessageSubscription(entry, entry.timeout);
      }
    });
  }

  /** Attempt reconnection with exponential backoff, respecting circuit breaker. */
  async reconnect() {
    if (this._retired) throw new Error("Gateway connection retired");
    await this._assertAuthorized();
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
    if (this._retired) throw new Error("Gateway connection retired");
    await this._assertAuthorized();
    this._reconnectAttempts++;

    // The cached IP may belong to a replaced pod — refresh it from the
    // original service name before dialing. Failure keeps the previous
    // address; the connect below will fail and back off as before.
    if (this._resolveHost) {
      try {
        const nextHost = await this._resolveHost();
        if (nextHost && nextHost !== this.host) {
          console.log(
            `[gatewayProxy] Gateway ${this._sourceHost} re-resolved ${this.host} -> ${nextHost}`,
          );
          this.host = nextHost;
        }
      } catch (error) {
        if (
          error?.code === "REMOTE_HOST_ACCESS_REVOKED" ||
          error?.code === "REMOTE_HOST_AUTH_CHECK_FAILED"
        ) {
          this.retire(error);
          throw error;
        }
        // DNS not answering right now — retry with the old address.
      }
    }

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
    if (this._retired || this._backgroundReconnecting) return;
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
    this._clearAuthorizationGuard();
    for (const entry of this.sessionMessageSubscriptions.values()) {
      entry.subscribed = false;
      entry.subscriptionAttempted = false;
      entry.subscriptionSupported = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* socket already closed */
      }
      this.ws = null;
    }
  }

  /**
   * Permanently retire a pooled connection, reject pending work, and suppress
   * reconnects.
   *
   * @param {Error|null} [error=null] - Failure exposed to pending connection consumers.
   * @returns {void}
   */
  retire(error = null) {
    if (this._retired) return;
    this._retired = true;
    this._retireError =
      error instanceof Error
        ? error
        : Object.assign(new Error("Gateway connection retired"), {
            code: "GATEWAY_CONNECTION_RETIRED",
          });
    // A WebSocket close handshake is asynchronous. Remove and reject RPCs
    // before initiating it so a late response cannot resolve work that was
    // already revoked while the socket remains temporarily readable.
    this._rejectPending(this._retireError);
    for (const callback of this._retireListeners) {
      try {
        callback(this._retireError);
      } catch {
        // A response listener must not prevent socket retirement.
      }
    }
    this._retireListeners.clear();
    this.eventListeners.clear();
    this.sessionMessageSubscriptions.clear();
    this.sessionMessageSubscriptionAliases.clear();
    this.close();
  }

  get isAlive() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  get circuitState() {
    return this._circuitState;
  }
}

// Pool connections by non-secret agent + logical endpoint identity, then
// verify the credential before reuse. Docker may reuse an IP/port immediately
// after an agent is deleted; address-only pooling would then hand the
// replacement agent the previous runtime's authenticated socket, device
// identity, and session stream.
const pool = new Map(); // non-secret agent + logical endpoint -> GatewayConnection
const pendingConnections = new Map(); // same key -> pending connection state

function buildConnectionPoolKey(agentId, addr) {
  return JSON.stringify([String(agentId || ""), addr.host, Number(addr.port)]);
}

function gatewayTokensEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function retireConflictingConnections(key, agent, addr) {
  const agentId = agent?.id ? String(agent.id) : null;
  for (const [existingKey, existing] of pool) {
    if (existingKey === key) continue;
    const sameAgent = agentId && existing.agentId === agentId;
    const reusedEndpoint = existing._sourceHost === addr.host && existing.port === addr.port;
    if (!sameAgent && !reusedEndpoint) continue;

    existing.retire();
    pool.delete(existingKey);
  }

  for (const [existingKey, pending] of pendingConnections) {
    if (existingKey === key) continue;
    const sameAgent = agentId && pending.agentId === agentId;
    const reusedEndpoint = pending.sourceHost === addr.host && pending.port === addr.port;
    if (!sameAgent && !reusedEndpoint) continue;

    pending.retired = true;
    pending.connection?.retire();
    pendingConnections.delete(existingKey);
  }
}

/**
 * Get or establish a pooled gateway connection after applying current Remote
 * Docker authorization, port, host, and SSRF checks. Remote grants are checked
 * before pool reuse and while an authorized socket remains open.
 *
 * @param {Object} agent - Agent whose OpenClaw gateway should be connected.
 * @returns {Promise<Object>} Connected gateway RPC transport.
 */
async function getConnection(agent) {
  // Check before a pooled connection can be reused. PLATFORM_MODE is normally
  // process-static, but this keeps the hosted-mode contract fail closed even
  // if a process is reconfigured while an old remote connection is alive.
  assertRemoteGatewayAccessSupported(agent);
  // Re-check before consulting either the pending or warm pool. A workspace
  // unshare/role downgrade must retire the confused-deputy path immediately;
  // the fact that this agent once opened an authenticated socket is not a grant.
  try {
    await assertCurrentGatewayAccess(agent);
  } catch (error) {
    evictConnection(agent, error);
    throw error;
  }
  const rawAddr = resolveGatewayAddress(agent);
  if (!rawAddr) throw new Error("Agent gateway not yet provisioned");
  const addr = assertSafeAgentAddress(rawAddr);
  if (!isAllowedGatewayPort(addr.port)) {
    throw new Error("Agent gateway port is not allowed");
  }
  // gateway_token is encrypted at rest; decrypt() is transparent to legacy
  // plaintext, so it is safe regardless of the token's storage form. Pool keys
  // contain only the agent id and logical endpoint; credential rotation is
  // detected with a constant-time comparison against the in-memory connection.
  const token = gatewayTokenForAgent(agent);
  const key = buildConnectionPoolKey(agent?.id, addr);
  retireConflictingConnections(key, agent, addr);
  const pending = pendingConnections.get(key);
  if (pending && !pending.retired) {
    if (gatewayTokensEqual(pending.token, token)) return pending.promise;
    pending.retired = true;
    pending.connection?.retire();
    pendingConnections.delete(key);
  }

  let conn = pool.get(key);
  if (conn && !gatewayTokensEqual(conn.token, token)) {
    conn.retire();
    pool.delete(key);
    conn = null;
  }
  if (conn?.isAlive) return conn;

  // Check circuit breaker — if cooldown elapsed, reset fully and retry
  if (conn?.circuitState === "open") {
    if (Date.now() - conn._circuitOpenedAt < conn._circuitCooldown) {
      throw new Error("Circuit breaker open — gateway temporarily unavailable");
    }
    // Cooldown expired — clean up and start fresh
    conn.retire();
    pool.delete(key);
    conn = null;
  }

  // Clean up dead connection
  if (conn) {
    conn.retire();
    pool.delete(key);
  }

  const pendingState = {
    agentId: agent?.id ? String(agent.id) : null,
    sourceHost: addr.host,
    port: addr.port,
    token,
    connection: null,
    retired: false,
    promise: null,
  };

  pendingState.promise = (async () => {
    try {
      // Validate + resolve the gateway host before opening a NEW connection
      // (the alive-cache hit above already passed this when it was created).
      const extraAllowedHosts = await allowedGatewayHostsForAgent(agent);
      const connectHost = await resolveGatewayHostForProxy(
        addr.host,
        "agent gateway",
        extraAllowedHosts,
      );
      if (pendingState.retired) throw new Error("Gateway connection retired");

      // A different identity may have reached the pool while DNS/allowlist
      // resolution was in flight. Retire it before this connection becomes
      // visible; newer conflicting requests retire this pending state instead.
      retireConflictingConnections(key, agent, addr);
      if (pendingState.retired) throw new Error("Gateway connection retired");

      conn = new GatewayConnection(connectHost, token, addr.port, {
        resolveHost: async () => {
          await assertCurrentGatewayAccess(agent);
          const currentAllowedHosts = await allowedGatewayHostsForAgent(agent);
          return resolveGatewayHostForProxy(addr.host, "agent gateway", currentAllowedHosts);
        },
        sourceHost: addr.host,
        agentId: agent.id,
        authorize: () => assertCurrentGatewayAccess(agent),
      });
      pendingState.connection = conn;
      if (pendingState.retired) {
        conn.retire();
        throw new Error("Gateway connection retired");
      }
      pool.set(key, conn);

      try {
        await conn.connect();
      } catch (err) {
        // First connect failed — try one reconnect with backoff.
        try {
          await conn.reconnect();
        } catch {
          conn.retire();
          if (pool.get(key) === conn) pool.delete(key);
          throw err;
        }
      }
      if (pendingState.retired) {
        conn.retire();
        if (pool.get(key) === conn) pool.delete(key);
        throw new Error("Gateway connection retired");
      }
      return conn;
    } finally {
      if (pendingConnections.get(key) === pendingState) {
        pendingConnections.delete(key);
      }
    }
  })();
  pendingConnections.set(key, pendingState);
  return pendingState.promise;
}

// ─── Helpers ─────────────────────────────────────────────────────

const GATEWAY_RELAY_AGENT_COLUMNS = [
  "id",
  "name",
  "status",
  "container_id",
  "host",
  "backend_type",
  "gateway_token",
  "gateway_host_port",
  "gateway_host",
  "gateway_port",
  "runtime_host",
  "runtime_port",
  "runtime_family",
  "deploy_target",
  "execution_target_id",
  "user_id",
];

/**
 * Load an agent for the gateway relay and enforce the minimum role.
 *
 * The relay is a live chat/terminal channel onto the runtime, so it takes the
 * same `editor` bar as the rest of the OpenClaw gateway surface: the agent's
 * owner, or a member of a sharing workspace who can operate it. Role is
 * re-resolved per connection because the embed cookie carries none of its own.
 *
 * @param {string} agentId - Requested agent id.
 * @param {string} userId - Authenticated user id.
 * @returns {Promise<Object|null>} Authorized agent or `null` without existence disclosure.
 */
async function resolveAgent(agentId, userId) {
  const result = await db.query(buildAccessibleAgentQuery(GATEWAY_RELAY_AGENT_COLUMNS), [
    agentId,
    userId,
  ]);
  const agent = result.rows[0];
  if (!agent || !roleSatisfies(agent.effective_role, GATEWAY_MIN_WORKSPACE_ROLE)) return null;
  return agent;
}

/**
 * Call an agent's gateway through the validated connection pool and unwrap its result.
 *
 * @param {Object} agent - Agent whose gateway should receive the call.
 * @param {string} method - Gateway RPC method.
 * @param {Object} [params={}] - RPC parameters.
 * @param {number} [timeout] - Optional call timeout in milliseconds.
 * @returns {Promise} Gateway result or payload.
 */
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

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Build authenticated OpenClaw gateway routes with API-key workspace binding,
 * including chat, RPC, and SSRF-safe UI proxying.
 *
 * @param {Object} [options={}] - Optional route timeout overrides.
 * @returns {Object} Express router for gateway control-plane operations.
 */
function createGatewayRouter(options = {}) {
  const router = require("express").Router();
  const chatTimeoutMs = positiveTimeout(options.chatTimeoutMs, CHAT_TIMEOUT);
  const sessionMessageSubscribeTimeoutMs = positiveTimeout(
    options.sessionMessageSubscribeTimeoutMs,
    SESSION_MESSAGE_SUBSCRIBE_TIMEOUT,
  );
  const agentTerminalFallbackGraceMs = positiveTimeout(
    options.agentTerminalFallbackGraceMs,
    AGENT_TERMINAL_FALLBACK_GRACE_MS,
  );
  const agentErrorFallbackGraceMs = positiveTimeout(
    options.agentErrorFallbackGraceMs,
    AGENT_ERROR_FALLBACK_GRACE_MS,
  );

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

  // The gateway router is mounted before routes/agents in server.ts. Keep its
  // scope and workspace boundary local as well as at the server mount so it
  // remains safe if reused independently in tests or another entrypoint.
  router.use(
    "/agents/:agentId/gateway",
    scopeByMethod("agents:read", "agents:write"),
    requireApiKeyAgentScope("agentId"),
  );

  // Middleware: resolve agent + verify ownership
  // Allow both 'running' and 'warning' statuses — 'warning' means the post-deploy
  // health check was inconclusive (e.g. npm install was slow), but the gateway may
  // still be reachable. Blocking 'warning' agents would break all tabs even when the
  // gateway eventually starts successfully.
  router.use("/agents/:agentId/gateway", async (req, res, next) => {
    try {
      const agent = await findAccessibleAgentForRequest(
        req,
        req.params.agentId,
        GATEWAY_MIN_WORKSPACE_ROLE,
      );
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
      res.status(err?.statusCode || 500).json({
        error: err?.message || "Unexpected error",
        ...(err?.code ? { code: err.code } : {}),
      });
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
      // auto-promote to 'running' — the gateway proved itself healthy. Guarded
      // on 'warning' so the write is a no-op if the agent entered the deploy
      // lifecycle (queued/deploying) after the router gate read its status.
      if (health && req.agent.status === "warning") {
        db.query("UPDATE agents SET status = 'running' WHERE id = $1 AND status = 'warning'", [
          req.agent.id,
        ]).catch(() => {});
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

      const sessionKey = session_id || "main";
      const params = {
        sessionKey,
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

        let runId = null;
        let chatAcknowledged = false;
        let streamCompletion = null;
        let resolveStreamCompletion;
        let streamSettled = false;
        let chatTerminalPayload = null;
        let agentTerminalFallback = null;
        let accumulatedAssistantText = "";
        let finalTokenPayload = null;
        let streamTimeout = null;
        let agentTerminalFallbackTimer = null;
        let sessionMessageSubscriptionHeld = false;
        let connectionRetireError = null;
        const pendingEvents = [];

        const completeStream = (reason) => {
          if (streamSettled) return;
          streamSettled = true;
          resolveStreamCompletion(reason);
        };

        const releaseSessionMessageSubscription = () => {
          if (!sessionMessageSubscriptionHeld) return;
          sessionMessageSubscriptionHeld = false;
          conn
            .releaseSessionMessageSubscription(sessionKey, sessionMessageSubscribeTimeoutMs)
            .catch(() => {});
        };

        const extractMessageText = (message) => {
          if (!message) return "";
          if (typeof message === "string") return message;
          const content = message.content;
          if (typeof content === "string") return content;
          if (!Array.isArray(content)) return "";
          return content
            .map((part) => {
              if (typeof part === "string") return part;
              return typeof part?.text === "string" ? part.text : "";
            })
            .join("");
        };

        // OpenClaw 2026.6 added incremental `deltaText`; older gateways mainly
        // exposed accumulated text through message.content. Preserve the raw
        // fields and add the older accumulated message shape only when absent,
        // so existing browser clients keep rendering while newer clients can
        // consume deltaText directly.
        const normalizeChatPayload = (payload) => {
          const messageText = extractMessageText(payload.message);
          const role = payload.message?.role;
          const isUserEcho = role === "user" || role === "human";
          if (!isUserEcho && messageText) accumulatedAssistantText = messageText;

          if (!isUserEcho && payload.state === "delta" && typeof payload.deltaText === "string") {
            accumulatedAssistantText = payload.replace
              ? payload.deltaText
              : messageText
                ? messageText
                : `${accumulatedAssistantText}${payload.deltaText}`;
          }

          if (
            (payload.state === "delta" || payload.state === "final") &&
            !isUserEcho &&
            !messageText &&
            accumulatedAssistantText
          ) {
            const existingMessage =
              payload.message &&
              typeof payload.message === "object" &&
              !Array.isArray(payload.message)
                ? payload.message
                : {};
            return {
              ...payload,
              message: {
                ...existingMessage,
                role: existingMessage.role || "assistant",
                content: [{ type: "text", text: accumulatedAssistantText }],
              },
            };
          }

          return payload;
        };

        const buildAgentTerminalFallback = (payload) => {
          const phase = payload.data?.phase;
          const errorMessage =
            payload.data?.errorMessage ||
            payload.data?.error ||
            payload.errorMessage ||
            payload.error;
          if (phase === "error") {
            return {
              type: "error",
              state: "error",
              code: "AGENT_LIFECYCLE_ERROR",
              runId: payload.runId || runId,
              sessionKey: payload.sessionKey || sessionKey,
              error: errorMessage || "Agent run failed",
              errorMessage: errorMessage || "Agent run failed",
            };
          }
          return {
            state: "final",
            runId: payload.runId || runId,
            sessionKey: payload.sessionKey || sessionKey,
            ...(accumulatedAssistantText
              ? {
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: accumulatedAssistantText }],
                  },
                }
              : {}),
          };
        };

        const cancelAgentTerminalFallback = () => {
          if (agentTerminalFallbackTimer) clearTimeout(agentTerminalFallbackTimer);
          agentTerminalFallbackTimer = null;
          agentTerminalFallback = null;
        };

        const processStreamEvent = (eventName, evt) => {
          const payload = evt.payload || evt;
          const eventRunId =
            typeof payload.runId === "string" && payload.runId.trim() ? payload.runId.trim() : null;

          // Supported protocol-v3/v4 gateways require runId on chat and agent
          // frames. Fail closed on malformed/runless events so pooled-socket
          // traffic can never become a wildcard for this HTTP response.
          if (!eventRunId || eventRunId !== runId) return;

          if (res.writableEnded || res.destroyed) {
            completeStream("client-close");
            return;
          }

          // Any later matching activity means a pending lifecycle fallback is
          // stale. Cancel it now; another terminal lifecycle event below will
          // immediately schedule the appropriate short or retry-aware grace.
          if (agentTerminalFallbackTimer) cancelAgentTerminalFallback();

          if (eventName === "chat") {
            const outboundPayload = normalizeChatPayload(payload);

            // Forward matching events in their gateway-native shape (plus the
            // additive message compatibility projection above).
            res.write(`data: ${JSON.stringify(outboundPayload)}\n\n`);

            const state = outboundPayload.state;
            const role = outboundPayload.message?.role;
            const isUserEcho = role === "user" || role === "human";
            if (!isUserEcho && (state === "final" || state === "error" || state === "aborted")) {
              chatTerminalPayload = outboundPayload;
              if (state === "final") finalTokenPayload = outboundPayload;
              completeStream("chat-terminal");
            }
            return;
          }

          // Preserve agent sub-events for existing clients. A matching
          // lifecycle end/error is also a terminal fallback because some
          // gateway versions do not follow it with a chat terminal frame.
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const lifecyclePhase = payload.stream === "lifecycle" ? payload.data?.phase : null;
          if (lifecyclePhase === "error" || lifecyclePhase === "end") {
            agentTerminalFallback = buildAgentTerminalFallback(payload);
            const fallbackGraceMs =
              lifecyclePhase === "error" && payload.data?.fallbackExhaustedFailure !== true
                ? agentErrorFallbackGraceMs
                : agentTerminalFallbackGraceMs;
            agentTerminalFallbackTimer = setTimeout(
              () => completeStream("agent-terminal"),
              fallbackGraceMs,
            );
          }
        };

        const queueOrProcessStreamEvent = (eventName, evt) => {
          if (!chatAcknowledged) {
            // chat.send acknowledges before dispatching on current gateways;
            // this small buffer also closes the theoretical ack/event race.
            if (pendingEvents.length < 100) pendingEvents.push({ eventName, evt });
            return;
          }
          processStreamEvent(eventName, evt);
        };
        const chatStreamHandler = (evt) => queueOrProcessStreamEvent("chat", evt);
        const agentStreamHandler = (evt) => queueOrProcessStreamEvent("agent", evt);

        streamCompletion = new Promise((resolve) => {
          resolveStreamCompletion = resolve;
        });
        const handleConnectionRetire = (error) => {
          connectionRetireError = error || new Error("Gateway connection retired");
          completeStream("connection-retired");
          if (!res.writableEnded && !res.destroyed) {
            const message = connectionRetireError.message || "Gateway connection retired";
            const code = connectionRetireError.code || "GATEWAY_CONNECTION_RETIRED";
            res.write(
              `data: ${JSON.stringify({
                type: "error",
                state: "error",
                code,
                runId,
                sessionKey,
                error: message,
                errorMessage: message,
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
          metrics
            .recordMetric(req.agent.id, req.user.id, "error", 1, {
              code: connectionRetireError.code || "GATEWAY_CONNECTION_RETIRED",
              error: connectionRetireError.message || "Gateway connection retired",
              runId,
            })
            .catch(() => {});
        };
        conn.onRetire(handleConnectionRetire);
        const handleClientClose = () => completeStream("client-close");
        res.once("close", handleClientClose);
        if (res.writableEnded || res.destroyed) completeStream("client-close");

        // OpenClaw 2026.6 can scope live message events to explicit session
        // subscribers. Older gateways reject this method, so it is deliberately
        // best-effort and does not block chat when unsupported.
        sessionMessageSubscriptionHeld = true;
        const subscriptionAttempt = conn.acquireSessionMessageSubscription(
          sessionKey,
          sessionMessageSubscribeTimeoutMs,
        );
        await Promise.race([subscriptionAttempt, streamCompletion]);

        // The response may have closed while the subscription RPC was in
        // flight. Do not dispatch a new model turn for a client that is gone.
        if (streamSettled) {
          releaseSessionMessageSubscription();
          conn.offRetire(handleConnectionRetire);
          res.off("close", handleClientClose);
          return;
        }

        // Nothing for this request can stream before chat.send, so attach only
        // after the best-effort subscription attempt. This avoids filling the
        // pre-ack buffer with unrelated traffic from other pooled-socket runs.
        conn.on("chat", chatStreamHandler);
        conn.on("agent", agentStreamHandler);

        // Send the message — resolves immediately with { runId, status: "started" }
        try {
          const result = await conn.call("chat.send", params, CALL_TIMEOUT);
          if (result?.ok === false) {
            const rpcError = new Error(result.error?.message || "Gateway chat.send failed");
            rpcError.code = result.error?.code || "GATEWAY_ERROR";
            throw rpcError;
          }
          const acknowledgedRunId = result?.result?.runId ?? result?.payload?.runId;
          if (typeof acknowledgedRunId !== "string" || !acknowledgedRunId.trim()) {
            const acknowledgementError = new Error("Gateway chat.send returned no valid runId");
            acknowledgementError.code = "INVALID_CHAT_ACK";
            throw acknowledgementError;
          }
          runId = acknowledgedRunId.trim();
          chatAcknowledged = true;
        } catch (err) {
          pendingEvents.length = 0;
          conn.off("chat", chatStreamHandler);
          conn.off("agent", agentStreamHandler);
          conn.offRetire(handleConnectionRetire);
          releaseSessionMessageSubscription();
          res.off("close", handleClientClose);
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }
          metrics
            .recordMetric(req.agent.id, req.user.id, "error", 1, { error: err.message })
            .catch(() => {});
          return;
        }

        for (const pendingEvent of pendingEvents.splice(0)) {
          processStreamEvent(pendingEvent.eventName, pendingEvent.evt);
        }

        streamTimeout = setTimeout(() => completeStream("timeout"), chatTimeoutMs);
        // A disconnect can also race with chat.send acknowledgement; checking
        // the state closes the tiny window between listener setup and now.
        if (res.writableEnded || res.destroyed) completeStream("client-close");
        const completionReason = await streamCompletion;
        clearTimeout(streamTimeout);
        if (agentTerminalFallbackTimer) {
          clearTimeout(agentTerminalFallbackTimer);
          agentTerminalFallbackTimer = null;
        }
        res.off("close", handleClientClose);

        conn.off("chat", chatStreamHandler);
        conn.off("agent", agentStreamHandler);
        conn.offRetire(handleConnectionRetire);
        releaseSessionMessageSubscription();

        if (
          completionReason === "agent-terminal" &&
          !chatTerminalPayload &&
          agentTerminalFallback &&
          !res.writableEnded &&
          !res.destroyed
        ) {
          if (agentTerminalFallback.state === "final") {
            finalTokenPayload = agentTerminalFallback;
          }
          res.write(`data: ${JSON.stringify(agentTerminalFallback)}\n\n`);
        }

        if (completionReason === "timeout") {
          const timeoutMessage = `Chat stream timed out after ${chatTimeoutMs}ms`;
          const timeoutPayload = {
            type: "error",
            state: "error",
            code: "CHAT_TIMEOUT",
            runId,
            sessionKey,
            error: timeoutMessage,
            errorMessage: timeoutMessage,
          };
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(timeoutPayload)}\n\n`);
          }
          metrics
            .recordMetric(req.agent.id, req.user.id, "error", 1, {
              code: "CHAT_TIMEOUT",
              error: timeoutMessage,
              runId,
            })
            .catch(() => {});
        }

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

        if (completionReason !== "client-close" && !res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify({ type: "done", runId, sessionKey })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
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
// Clients connect to /ws/gateway/<agentId> with an agent-bound HttpOnly embed
// cookie. The server performs the Gateway handshake, then relays bidirectionally.

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

/**
 * Attach the authenticated gateway WebSocket upgrade and bidirectional relay to an HTTP server.
 * Upgrade requests require an agent-bound embed cookie before owner and endpoint validation.
 *
 * @param {Object} server - HTTP server that owns upgrade handling.
 * @returns {Object} WebSocket server handling accepted gateway relay connections.
 */
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
    let relayClientClosed = typeof ws.readyState === "number" && ws.readyState !== WebSocket.OPEN;
    const relayClientIsOpen = () =>
      !relayClientClosed && (typeof ws.readyState !== "number" || ws.readyState === WebSocket.OPEN);
    const markRelayClientClosed = () => {
      relayClientClosed = true;
    };
    // Install this before the first database await. Otherwise a client that
    // disconnects during authorization/DNS can still cause an authenticated
    // upstream gateway socket to be opened after it is already gone.
    if (typeof ws.once === "function") {
      ws.once("close", markRelayClientClosed);
      ws.once("error", markRelayClientClosed);
    }

    try {
      const agent = await resolveAgent(agentId, user.id);
      if (!relayClientIsOpen()) return;
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

      // Authorize before decrypting the runtime password. Historical rows that
      // only carry backend_type/execution_target_id are still Remote Docker and
      // must not bypass the current-grant check.
      await assertCurrentGatewayAccess(agent);
      if (!relayClientIsOpen()) return;
      const initialRelayAuthorizationCheckedAt = Date.now();

      // Decrypt once; reused for the device identity and the relay connect auth.
      const gatewayToken = gatewayTokenForAgent(agent);
      const identity = deriveDeviceIdentity(gatewayToken);
      let handshakeComplete = false;
      let connectPayload = null; // stored relay handshake payload
      let pendingClientConnect = null; // client's connect msg awaiting relay handshake
      const clientQueue = []; // buffer client messages until handshake is done
      let relayConnectNonce = "";
      let relayConnectSent = false;
      let relayConnectPromise = null;
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
      if (!relayClientIsOpen()) return;
      const gwWs = new WebSocket(`ws://${relayHost}:${addr.port}`);
      const requiresRelayAuthorization = remoteHosts.isRemoteDockerAgent(agent);
      let relayAuthorizationTimer = null;
      let relayAuthorizationPromise = null;
      let relayAuthorizationCheckedAt = initialRelayAuthorizationCheckedAt;
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

      function clearRelayAuthorizationTimer() {
        if (relayAuthorizationTimer) {
          clearInterval(relayAuthorizationTimer);
          relayAuthorizationTimer = null;
        }
      }

      async function ensureRelayAuthorized({ force = false } = {}) {
        if (!requiresRelayAuthorization) return true;
        if (!force && Date.now() - relayAuthorizationCheckedAt < REMOTE_HOST_AUTH_RECHECK_MS) {
          return true;
        }
        if (relayAuthorizationPromise) return relayAuthorizationPromise;
        relayAuthorizationPromise = (async () => {
          try {
            await assertCurrentGatewayAccess(agent);
            relayAuthorizationCheckedAt = Date.now();
            return true;
          } catch (error) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: error.message,
                  code: error.code || "REMOTE_HOST_ACCESS_REVOKED",
                }),
              );
              ws.close();
            }
            if (gwWs.readyState === WebSocket.OPEN || gwWs.readyState === WebSocket.CONNECTING) {
              gwWs.close();
            }
            return false;
          } finally {
            relayAuthorizationPromise = null;
          }
        })();
        return relayAuthorizationPromise;
      }

      if (requiresRelayAuthorization) {
        relayAuthorizationTimer = setInterval(() => {
          ensureRelayAuthorized({ force: true }).catch(() => {});
        }, REMOTE_HOST_AUTH_RECHECK_MS);
        relayAuthorizationTimer.unref?.();
      }

      async function sendRelayConnect() {
        if (relayConnectSent || gwWs.readyState !== WebSocket.OPEN) return;
        if (relayConnectPromise) return relayConnectPromise;

        relayConnectPromise = (async () => {
          // This frame carries the decrypted runtime credential. A cached
          // authorization result is insufficient after DNS and socket setup:
          // re-check the durable host grant at the actual send boundary.
          if (!(await ensureRelayAuthorized({ force: true }))) return;
          if (
            relayConnectSent ||
            gwWs.readyState !== WebSocket.OPEN ||
            ws.readyState !== WebSocket.OPEN
          ) {
            return;
          }

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
        })().finally(() => {
          relayConnectPromise = null;
        });

        return relayConnectPromise;
      }

      async function sendRelayConnectSafely() {
        try {
          await sendRelayConnect();
        } catch (error) {
          console.error(`[gatewayProxy] WS relay connect failed for ${agentId}:`, error.message);
          if (ws.readyState === WebSocket.OPEN) ws.close();
          if (gwWs.readyState === WebSocket.OPEN || gwWs.readyState === WebSocket.CONNECTING) {
            gwWs.close();
          }
        }
      }

      function queueRelayConnect() {
        if (relayConnectSent) return;
        clearRelayConnectTimer();
        relayConnectTimer = setTimeout(() => {
          void sendRelayConnectSafely();
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

      gwWs.on("message", async (raw) => {
        if (!(await ensureRelayAuthorized())) return;
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
              await sendRelayConnectSafely();
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

      ws.on("message", async (data) => {
        if (!(await ensureRelayAuthorized())) return;
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
        clearRelayAuthorizationTimer();
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
        clearRelayAuthorizationTimer();
        console.error(`[gatewayProxy] WS relay error for agent ${agentId}:`, err.message);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      const closeGatewayForClient = () => {
        relayClientClosed = true;
        clearRelayConnectTimer();
        clearRelayAuthorizationTimer();
        if (gwWs.readyState === WebSocket.OPEN || gwWs.readyState === WebSocket.CONNECTING)
          gwWs.close();
      };
      ws.on("close", closeGatewayForClient);
      ws.on("error", closeGatewayForClient);
    } catch (err) {
      console.error(`[gatewayProxy] WS error:`, err.message);
      if (relayClientIsOpen()) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
        ws.close();
      }
    }
  });

  return wss;
}

/**
 * Evict matching cached gateway connections so a restarted runtime is resolved afresh.
 *
 * @param {Object|string} target - Agent-like target or gateway host to evict.
 * @param {Error|null} [error=null] - Optional reason propagated to retired connections.
 * @returns {void}
 */
function evictConnection(target, error = null) {
  const address =
    typeof target === "string" ? { host: target } : resolveGatewayAddress(target || {});
  const targetAgentId = typeof target === "object" && target?.id != null ? String(target.id) : null;
  if (!address?.host && !targetAgentId) return;

  for (const [key, conn] of pool) {
    const matchesAgent = targetAgentId && conn.agentId === targetAgentId;
    const matchesAddress =
      address?.host &&
      conn._sourceHost === address.host &&
      (!address.port || conn.port === Number(address.port));
    if (matchesAgent || matchesAddress) {
      conn.retire(error);
      pool.delete(key);
      console.log(
        `[gatewayProxy] Evicted connection for ${conn._sourceHost}:${conn.port}` +
          (conn.agentId ? ` (agent ${conn.agentId})` : ""),
      );
    }
  }

  for (const [key, pending] of pendingConnections) {
    const matchesAgent = targetAgentId && pending.agentId === targetAgentId;
    const matchesAddress =
      address?.host &&
      pending.sourceHost === address.host &&
      (!address.port || pending.port === Number(address.port));
    if (matchesAgent || matchesAddress) {
      pending.retired = true;
      pending.connection?.retire(error);
      pendingConnections.delete(key);
    }
  }
}

module.exports = {
  GatewayConnection,
  createGatewayRouter,
  attachGatewayWS,
  rpcCall,
  resolveAgent,
  evictConnection,
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
  assertExternalEndpointReachable,
  assertStrongExternalGatewayToken,
  resolveGatewayHostForProxy,
  allowedGatewayHostsForAgent,
};
