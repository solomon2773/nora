// @ts-nocheck
/**
 * embedAgentColumns.ts — the agent-row columns the embed proxies must load.
 *
 * Both embed proxies resolve their upstream target through the gateway SSRF
 * allowlist (gatewayProxy.resolveSafe*Target → allowedGatewayHostsForAgent →
 * resolveHermesDashboardAddress). That allowlist authorizes the target by
 * reading several agent fields off the row the embed lookup returns:
 *
 *   - deploy_target        routes the docker vs k8s vs remote-docker policy
 *   - execution_target_id  looks up the agent's registered remote host
 *   - user_id              owner-scopes that remote host (cross-tenant guard)
 *   - gateway_host/_port   k8s/remote exposure address (LoadBalancer/NodePort)
 *   - runtime_host/_port   the Hermes dashboard host (local container)
 *
 * A lookup that omits any of these silently mis-authorizes the target — e.g. a
 * remote-docker agent gets normalized to "docker" and its registered host is
 * rejected, or (worse) the owner check short-circuits because user_id is
 * undefined. Keep these lists in sync with what allowedGatewayHostsForAgent /
 * resolveHermesDashboardAddress actually consume.
 */

// Hermes dashboard embed proxy (server.ts proxyEmbeddedHermes →
// resolveSafeHermesDashboardTarget).
const HERMES_EMBED_AGENT_COLUMNS = [
  "host",
  "runtime_host",
  "runtime_port",
  "status",
  "runtime_family",
  "backend_type",
  "deploy_target",
  "execution_target_id",
  "user_id",
  "gateway_host",
  "gateway_port",
  // The remote Hermes dashboard is published on its own host port, persisted here;
  // resolveHermesDashboardAddress reads it (falls back to 9119 for local). Without
  // it the embed proxy would target the in-container 9119 on the remote address.
  "dashboard_port",
  // Seed for deriveHermesDashboardBasicAuth — proxyEmbeddedHermes decrypts this
  // and logs in server-side when the dashboard session is missing/expired.
  // Without it the seed is undefined and the proxy silently skips login.
  "gateway_token",
];

// OpenClaw gateway embed proxies (server.ts proxyEmbeddedGateway +
// proxyGatewayAsset). These route through resolveSafeGatewayHttpTarget, so they
// need the same SSRF-authorizing fields as the Hermes path (deploy_target /
// execution_target_id / user_id for owner-scoped remote-docker, runtime_host for
// the k8s exposure set), plus gateway_token for the embed bootstrap script.
const GATEWAY_EMBED_AGENT_COLUMNS = [
  "host",
  "gateway_token",
  "gateway_host_port",
  "gateway_host",
  "gateway_port",
  "status",
  "runtime_host",
  "runtime_family",
  "deploy_target",
  "execution_target_id",
  "user_id",
];

module.exports = { HERMES_EMBED_AGENT_COLUMNS, GATEWAY_EMBED_AGENT_COLUMNS };
