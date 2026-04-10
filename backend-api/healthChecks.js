const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  gatewayUrl,
} = require("../agent-runtime/lib/contracts");

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { signal: controller.signal });

      lastStatus = response.status;
      if (acceptStatuses.includes(response.status)) {
        return { ok: true, url, attempt, status: response.status };
      }
      lastError = new Error(`unexpected HTTP ${response.status}`);
    } catch (error) {
      if (controller.signal.aborted) {
        lastError = new Error(`timeout after ${timeoutMs}ms`);
      } else {
        lastError = error;
      }
    } finally {
      clearTimeout(timer);
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

async function waitForAgentReadiness({
  host,
  runtimeHost = null,
  runtimePort = AGENT_RUNTIME_PORT,
  gatewayHostPort = null,
  gatewayHost = null,
  gatewayPort = OPENCLAW_GATEWAY_PORT,
} = {}, options = {}) {
  const resolvedRuntimeHost = runtimeHost || host;
  const resolvedRuntimePort = runtimePort || AGENT_RUNTIME_PORT;

  const runtime = await waitForHttpReady(
    gatewayUrl(resolvedRuntimeHost, resolvedRuntimePort, "/health"),
    {
      attempts: 12,
      intervalMs: 5000,
      timeoutMs: 5000,
      acceptStatuses: [200],
      ...options.runtime,
    }
  );

  const resolvedGatewayHost = gatewayHostPort
    ? (gatewayHost || process.env.GATEWAY_HOST || "host.docker.internal")
    : (gatewayHost || host);
  const resolvedGatewayPort = gatewayHostPort || gatewayPort || OPENCLAW_GATEWAY_PORT;

  const gateway = await waitForHttpReady(
    gatewayUrl(resolvedGatewayHost, resolvedGatewayPort, "/"),
    {
      attempts: 15,
      intervalMs: 10000,
      timeoutMs: 5000,
      acceptStatuses: [200, 401, 403],
      ...options.gateway,
    }
  );

  return {
    ok: runtime.ok && gateway.ok,
    runtime: {
      ...runtime,
      host: resolvedRuntimeHost,
      port: resolvedRuntimePort,
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
