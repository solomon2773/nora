const net = require("net");
const { AGENT_RUNTIME_PORT, OPENCLAW_GATEWAY_PORT, HERMES_DASHBOARD_PORT } = require("./contracts.ts");

function normalizePath(path = "/") {
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runtimeExposesGateway(agent) {
  const runtimeFamily = String(agent?.runtime_family ?? agent?.runtimeFamily ?? "")
    .trim()
    .toLowerCase();
  if (runtimeFamily) return runtimeFamily !== "hermes";

  return true;
}

function runtimeUsesHermesDashboard(agent) {
  const runtimeFamily = String(agent?.runtime_family ?? agent?.runtimeFamily ?? "")
    .trim()
    .toLowerCase();
  if (runtimeFamily) return runtimeFamily === "hermes";

  return false;
}

function joinHttpUrl(host, port, path = "/") {
  // Bracket IPv6 literals so the colons in the address don't collide with the
  // port separator (e.g. ::1 → http://[::1]:9119/…). Hostnames/IPv4 pass through.
  const hostForUrl = net.isIP(host) === 6 ? `[${host}]` : host;
  return `http://${hostForUrl}:${port}${normalizePath(path)}`;
}

function resolveRuntimeAddress(agent) {
  if (!agent) return null;

  const host = agent.runtime_host || agent.host || null;
  if (!host) return null;

  return {
    host,
    port: normalizePort(agent.runtime_port, AGENT_RUNTIME_PORT),
  };
}

function resolveGatewayAddress(
  agent,
  { publishedHost = process.env.GATEWAY_HOST || "host.docker.internal" } = {},
) {
  if (!agent) return null;
  if (!runtimeExposesGateway(agent)) return null;

  if (agent.gateway_host && agent.gateway_port) {
    return {
      host: agent.gateway_host,
      port: normalizePort(agent.gateway_port, OPENCLAW_GATEWAY_PORT),
    };
  }

  if (agent.gateway_host_port) {
    return {
      host: agent.gateway_host || publishedHost,
      port: normalizePort(agent.gateway_host_port, OPENCLAW_GATEWAY_PORT),
    };
  }

  if (agent.gateway_host) {
    return {
      host: agent.gateway_host,
      port: normalizePort(agent.gateway_port, OPENCLAW_GATEWAY_PORT),
    };
  }

  if (!agent.host) return null;

  return {
    host: agent.host,
    port: normalizePort(agent.gateway_port, OPENCLAW_GATEWAY_PORT),
  };
}

function runtimeUrlForAgent(agent, path = "/") {
  const address = resolveRuntimeAddress(agent);
  if (!address) return null;
  return joinHttpUrl(address.host, address.port, path);
}

function gatewayUrlForAgent(agent, path = "/", options = {}) {
  const address = resolveGatewayAddress(agent, options);
  if (!address) return null;
  return joinHttpUrl(address.host, address.port, path);
}

function resolveHermesDashboardAddress(agent) {
  if (!agent) return null;
  if (!runtimeUsesHermesDashboard(agent)) return null;

  if (agent.gateway_host && agent.gateway_port) {
    return {
      host: agent.gateway_host,
      port: normalizePort(agent.gateway_port, HERMES_DASHBOARD_PORT),
    };
  }

  const host = agent.runtime_host || agent.host || null;
  if (!host) return null;

  return {
    host,
    port: normalizePort(agent.dashboard_port, HERMES_DASHBOARD_PORT),
  };
}

function dashboardUrlForAgent(agent, path = "/") {
  const address = resolveHermesDashboardAddress(agent);
  if (!address) return null;
  return joinHttpUrl(address.host, address.port, path);
}

function hasRuntimeEndpoint(agent) {
  return Boolean(resolveRuntimeAddress(agent));
}

function hasGatewayEndpoint(agent, options = {}) {
  return Boolean(resolveGatewayAddress(agent, options));
}

function hasHermesDashboardEndpoint(agent) {
  return Boolean(resolveHermesDashboardAddress(agent));
}

// Bearer headers for calling the runtime sidecar (:9090). The sidecar
// authenticates every route except /health with the per-agent gateway token
// (injected as OPENCLAW_GATEWAY_TOKEN). Returns an empty object when no token
// is known, so a caller against a tokenless/legacy runtime still works.
function buildRuntimeAuthHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

module.exports = {
  joinHttpUrl,
  resolveRuntimeAddress,
  resolveGatewayAddress,
  resolveHermesDashboardAddress,
  runtimeUrlForAgent,
  gatewayUrlForAgent,
  dashboardUrlForAgent,
  hasRuntimeEndpoint,
  hasGatewayEndpoint,
  hasHermesDashboardEndpoint,
  buildRuntimeAuthHeaders,
};
