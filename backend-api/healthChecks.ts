// @ts-nocheck
const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  gatewayUrl,
} = require("../agent-runtime/lib/contracts");

/**
 * Retry an HTTP probe until an accepted status is returned or attempts run out.
 * Timeouts, transport errors, and rejected statuses are reported in the result
 * instead of being thrown.
 *
 * @param {string} url - Endpoint to probe.
 * @param {Object} options - Retry, timeout, accepted-status, and fetch overrides.
 * @returns {Promise<Object>} Structured readiness result with the last failure.
 */
// Readiness budgets are env-tunable so slow environments can widen them without
// changing the defaults everyone else gets. A cold first boot on a small CI
// runner can take longer than the default ~210s combined budget, and when the
// budget expires the provisioning job fails, tears the deployment down, and the
// retry restarts the cold start from zero — so the agent never converges.
// Defaults below are unchanged.
function readinessEnvInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitForHttpReady(url, options = {}) {
  const {
    attempts = 15,
    intervalMs = 10000,
    timeoutMs = 5000,
    acceptStatuses = [200],
    fetchImpl = fetch,
    beforeAttempt = null,
  } = options;

  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Authorization hooks run outside the network-error catch so revocation or
    // an authorization-store failure stops polling instead of being flattened
    // into a retryable runtime reachability error.
    if (typeof beforeAttempt === "function") {
      await beforeAttempt({ attempt, url });
    }

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

/**
 * Probe an agent runtime and, optionally, its published gateway endpoint.
 * Gateway 401/403 responses count as ready because they prove the service is
 * listening; published ports default to GATEWAY_HOST or host.docker.internal.
 *
 * @param {Object} target - Runtime and gateway host/port configuration.
 * @param {Object} options - Per-probe overrides passed to waitForHttpReady.
 * @returns {Promise<Object>} Combined runtime and gateway readiness result.
 */
async function waitForAgentReadiness(
  {
    host,
    runtimeHost = null,
    runtimePort = AGENT_RUNTIME_PORT,
    gatewayHostPort = null,
    gatewayHost = null,
    gatewayPort = null,
    checkGateway = true,
  } = {},
  options = {},
) {
  const resolvedRuntimeHost = runtimeHost || host;
  const resolvedRuntimePort = runtimePort || AGENT_RUNTIME_PORT;

  const runtime = await waitForHttpReady(
    gatewayUrl(resolvedRuntimeHost, resolvedRuntimePort, "/health"),
    {
      attempts: readinessEnvInt("NORA_RUNTIME_READY_ATTEMPTS", 12),
      intervalMs: readinessEnvInt("NORA_RUNTIME_READY_INTERVAL_MS", 5000),
      timeoutMs: readinessEnvInt("NORA_RUNTIME_READY_TIMEOUT_MS", 5000),
      acceptStatuses: [200],
      ...(typeof options.beforeAttempt === "function"
        ? { beforeAttempt: options.beforeAttempt }
        : {}),
      ...options.runtime,
    },
  );

  let gateway = null;
  if (checkGateway) {
    // Prefer an explicit runtime-internal endpoint when the backend supplies
    // one. Local Docker can then bind its optional host-published port to
    // loopback without breaking readiness from the provisioner container.
    const hasExplicitGatewayEndpoint = Boolean(gatewayHost && gatewayPort);
    const resolvedGatewayHost = hasExplicitGatewayEndpoint
      ? gatewayHost
      : gatewayHostPort
        ? gatewayHost || process.env.GATEWAY_HOST || "host.docker.internal"
        : gatewayHost || host;
    const resolvedGatewayPort = hasExplicitGatewayEndpoint
      ? gatewayPort
      : gatewayHostPort || gatewayPort || OPENCLAW_GATEWAY_PORT;

    gateway = await waitForHttpReady(gatewayUrl(resolvedGatewayHost, resolvedGatewayPort, "/"), {
      attempts: readinessEnvInt("NORA_GATEWAY_READY_ATTEMPTS", 15),
      intervalMs: readinessEnvInt("NORA_GATEWAY_READY_INTERVAL_MS", 10000),
      timeoutMs: readinessEnvInt("NORA_GATEWAY_READY_TIMEOUT_MS", 5000),
      acceptStatuses: [200, 401, 403],
      ...(typeof options.beforeAttempt === "function"
        ? { beforeAttempt: options.beforeAttempt }
        : {}),
      ...options.gateway,
    });
    gateway = {
      ...gateway,
      host: resolvedGatewayHost,
      port: resolvedGatewayPort,
    };
  }

  return {
    ok: runtime.ok && (checkGateway ? gateway?.ok : true),
    runtime: {
      ...runtime,
      host: resolvedRuntimeHost,
      port: resolvedRuntimePort,
    },
    gateway,
  };
}

module.exports = {
  waitForHttpReady,
  waitForAgentReadiness,
};
