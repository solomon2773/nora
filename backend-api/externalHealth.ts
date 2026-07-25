// @ts-nocheck
// Health probe for ADOPTED external runtimes (BYOC Phase C2). Nora does not
// provision these, so there is no container to inspect — liveness is whether the
// operator-declared endpoint answers. The probe goes through the SAME SSRF-safe
// resolvers the proxy uses (resolveSafeGatewayHttpTarget / resolveSafeHermesDashboard
// Target), so it can only ever hit the agent's own allowlisted, IP-pinned endpoint.
// Any HTTP response (any status — even 4xx/5xx) means the endpoint is alive;
// a connection error / timeout means it is down. Redirects are NOT followed
// (redirect: "manual") so a 3xx can't bounce the probe to a non-allowlisted host.

const {
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
} = require("./gatewayProxy");
const { joinHttpUrl } = require("../agent-runtime/lib/agentEndpoints");

/**
 * Probe an adopted runtime through its SSRF-safe, agent-allowlisted endpoint.
 * Any completed HTTP response indicates liveness; resolution, timeout, and
 * transport failures return `{ running: false }` rather than throwing.
 *
 * @param {Object} agent - External agent endpoint configuration.
 * @param {Object} options - Fetch implementation and timeout overrides.
 * @returns {Promise<Object>} External runtime liveness result.
 */
async function probeExternalAgentHealth(agent, { fetchImpl, timeoutMs = 5000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  let url;
  const headers = {};
  try {
    if (String(agent?.runtime_family || "").toLowerCase() === "hermes") {
      const { host, port } = await resolveSafeHermesDashboardTarget(agent);
      url = joinHttpUrl(host, port, "/");
    } else {
      const target = await resolveSafeGatewayHttpTarget(agent, "");
      url = target.url;
      if (target.hostHeader) headers.Host = target.hostHeader;
    }
  } catch {
    // Endpoint can't be resolved or isn't allowlisted → treat as not reachable.
    return { running: false };
  }

  try {
    await doFetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { running: true };
  } catch {
    return { running: false };
  }
}

module.exports = { probeExternalAgentHealth };
