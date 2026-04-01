const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  agentRuntimeUrl,
  gatewayUrl,
} = require("../../agent-runtime/lib/contracts");

async function waitForHttpReady(url, options = {}) {
  const {
    attempts = 15,
    intervalMs = 10000,
    timeoutMs = 5000,
    acceptStatuses = [200],
    fetchImpl = fetch,
  } = options;

  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(url, { signal: controller.signal });
      clearTimeout(timer);

      lastStatus = response.status;
      if (acceptStatuses.includes(response.status)) {
        return { ok: true, url, attempt, status: response.status };
      }
      lastError = new Error(`unexpected HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    ok: false,
    url,
    attempts,
    status: lastStatus,
    error: lastError?.message || "unreachable",
  };
}

async function waitForAgentReadiness({ host, gatewayHostPort = null, gatewayHost = null }, options = {}) {
  const runtime = await waitForHttpReady(agentRuntimeUrl(host, "/health"), {
    attempts: 12,
    intervalMs: 5000,
    timeoutMs: 5000,
    acceptStatuses: [200],
    ...options.runtime,
  });

  const resolvedGatewayHost = gatewayHostPort
    ? (gatewayHost || process.env.GATEWAY_HOST || "host.docker.internal")
    : host;
  const resolvedGatewayPort = gatewayHostPort || OPENCLAW_GATEWAY_PORT;

  const gateway = await waitForHttpReady(gatewayUrl(resolvedGatewayHost, resolvedGatewayPort, "/"), {
    attempts: 15,
    intervalMs: 10000,
    timeoutMs: 5000,
    acceptStatuses: [200, 401, 403],
    ...options.gateway,
  });

  return {
    ok: runtime.ok && gateway.ok,
    runtime: {
      ...runtime,
      host,
      port: AGENT_RUNTIME_PORT,
    },
    gateway: {
      ...gateway,
      host: resolvedGatewayHost,
      port: resolvedGatewayPort,
    },
  };
}

module.exports = {
  waitForHttpReady,
  waitForAgentReadiness,
};
