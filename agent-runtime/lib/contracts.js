const AGENT_RUNTIME_PORT = 9090;
const OPENCLAW_GATEWAY_PORT = 18789;
const HERMES_DASHBOARD_PORT = 9119;

function joinHttpUrl(host, port, path = "/") {
  const normalizedPath = !path ? "" : (path.startsWith("/") ? path : `/${path}`);
  return `http://${host}:${port}${normalizedPath}`;
}

function agentRuntimeUrl(host, path = "/") {
  return joinHttpUrl(host, AGENT_RUNTIME_PORT, path);
}

function gatewayUrl(host, port = OPENCLAW_GATEWAY_PORT, path = "/") {
  return joinHttpUrl(host, port, path);
}

module.exports = {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  HERMES_DASHBOARD_PORT,
  agentRuntimeUrl,
  gatewayUrl,
};
