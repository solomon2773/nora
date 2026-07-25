// @ts-nocheck
// Resolves the bearer headers for calling an agent's runtime sidecar (:9090),
// which authenticates every route except /health with the per-agent gateway
// token. Most agent objects passed around the backend already carry
// gateway_token, but some loading queries omit it (e.g. the auth-sync query);
// fall back to a cheap indexed lookup. A missing token or failed lookup produces
// empty headers and lets the runtime reject the request.

const db = require("./db");
const { decrypt } = require("./crypto");
const { assertRemoteHostAgentUse, isRemoteDockerAgent } = require("./remoteHosts");
const { buildRuntimeAuthHeaders } = require("../agent-runtime/lib/agentEndpoints");

/**
 * Resolve decrypted bearer headers from an agent row or an id-scoped database
 * fallback, returning empty headers when no token is available.
 *
 * @param {Object|null} agent - Agent carrying a gateway token or id for fallback lookup.
 * @returns {Promise<Object>} Runtime authorization headers, or an empty object.
 */
async function runtimeAuthHeaders(agent) {
  // gateway_token is encrypted at rest (AES-256-GCM). decrypt() is transparent
  // to legacy plaintext tokens (colon-free hex), so it is safe to call here
  // whether the value came from an encrypted column or an in-memory plaintext
  // token. This is the central choke point for backend → runtime auth headers
  // (channels, integration sync, Hermes API, etc.).
  let effectiveAgent = agent || {};
  const targetKnown = Boolean(effectiveAgent.deploy_target || effectiveAgent.backend_type);
  const remoteIdentityComplete =
    !isRemoteDockerAgent(effectiveAgent) ||
    Boolean(effectiveAgent.user_id && effectiveAgent.execution_target_id);
  const needsLookup =
    effectiveAgent.id && (!effectiveAgent.gateway_token || !targetKnown || !remoteIdentityComplete);

  if (needsLookup) {
    const suppliedToken = effectiveAgent.gateway_token;
    try {
      const result = await db.query(
        `SELECT gateway_token, user_id, backend_type, deploy_target, execution_target_id
           FROM agents
          WHERE id = $1`,
        [effectiveAgent.id],
      );
      effectiveAgent = { ...effectiveAgent, ...(result?.rows?.[0] || {}) };
      if (suppliedToken) effectiveAgent.gateway_token = suppliedToken;
    } catch (error) {
      // Preserve the legacy best-effort behavior for an explicitly known local
      // or cluster target. Unknown/Remote Docker targets fail closed because a
      // DB outage must never bypass the current host-grant check.
      if (!targetKnown || isRemoteDockerAgent(effectiveAgent)) throw error;
    }
  }

  // Runtime bearer credentials are as privileged as Docker-over-SSH access.
  // Re-check the current host grant before returning them so direct runtime
  // paths cannot bypass share revocation.
  await assertRemoteHostAgentUse(effectiveAgent, { includeProfile: false });

  const token = effectiveAgent.gateway_token ? decrypt(effectiveAgent.gateway_token) : null;
  return buildRuntimeAuthHeaders(token);
}

module.exports = { runtimeAuthHeaders };
