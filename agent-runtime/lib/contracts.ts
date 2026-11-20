const AGENT_RUNTIME_PORT = 9090;
const OPENCLAW_GATEWAY_PORT = 18789;
// Hermes container ports: the runtime API (readiness probes hit
// {host}:{published port}/health; API_SERVER_PORT inside the container) and
// the dashboard UI. Single source of truth for every Hermes backend — the
// local adapter, the remote adapter, and backend-api's connect/embed paths
// (#450: remote-hermes once imported a copy that was never exported here and
// built its port binding under the literal key "undefined/tcp").
const HERMES_RUNTIME_PORT = 8642;
const HERMES_DASHBOARD_PORT = 9119;

function joinHttpUrl(host, port, path = "/") {
  const normalizedPath = !path ? "" : path.startsWith("/") ? path : `/${path}`;
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
  HERMES_RUNTIME_PORT,
  HERMES_DASHBOARD_PORT,
  agentRuntimeUrl,
  gatewayUrl,
};
