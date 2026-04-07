const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
} = require("./contracts");

function normalizePath(path = "/") {
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  if (agent.gateway_host && agent.gateway_port) {
    return {
      host: agent.gateway_host,
      port: normalizePort(agent.gateway_port, OPENCLAW_GATEWAY_PORT),
    };
  }

  if (agent.gateway_host_port) {
    return {
      host: publishedHost,
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

function hasRuntimeEndpoint(agent) {
  return Boolean(resolveRuntimeAddress(agent));
}

function hasGatewayEndpoint(agent, options = {}) {
  return Boolean(resolveGatewayAddress(agent, options));
}

module.exports = {
  resolveRuntimeAddress,
  resolveGatewayAddress,
  runtimeUrlForAgent,
  gatewayUrlForAgent,
  hasRuntimeEndpoint,
  hasGatewayEndpoint,
};
