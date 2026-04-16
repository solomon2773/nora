const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  HERMES_DASHBOARD_PORT,
} = require("./contracts");

function normalizePath(path = "/") {
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runtimeExposesGateway(agent) {
  const runtimeFamily = String(
    agent?.runtime_family ?? agent?.runtimeFamily ?? ""
  )
    .trim()
    .toLowerCase();
  if (runtimeFamily) return runtimeFamily !== "hermes";

  const backendType = String(agent?.backend_type ?? agent?.backendType ?? "")
    .trim()
    .toLowerCase();
  return backendType !== "hermes";
}

function runtimeUsesHermesDashboard(agent) {
  const runtimeFamily = String(
    agent?.runtime_family ?? agent?.runtimeFamily ?? ""
  )
    .trim()
    .toLowerCase();
  if (runtimeFamily) return runtimeFamily === "hermes";

  const backendType = String(agent?.backend_type ?? agent?.backendType ?? "")
    .trim()
    .toLowerCase();
  return backendType === "hermes";
}

function joinHttpUrl(host, port, path = "/") {
  return `http://${host}:${port}${normalizePath(path)}`;
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
  { publishedHost = process.env.GATEWAY_HOST || "host.docker.internal" } = {}
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

module.exports = {
  resolveRuntimeAddress,
  resolveGatewayAddress,
  resolveHermesDashboardAddress,
  runtimeUrlForAgent,
  gatewayUrlForAgent,
  dashboardUrlForAgent,
  hasRuntimeEndpoint,
  hasGatewayEndpoint,
  hasHermesDashboardEndpoint,
};
