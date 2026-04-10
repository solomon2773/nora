// Syncs auth-profiles.json to running agents via the runtime sidecar.
// After writing, restarts the backend so the OpenClaw gateway process
// re-reads the file on startup (it does not hot-reload from disk).
// Called whenever LLM provider keys or LLM-relevant integrations change.

const db = require('./db');
const containerManager = require("./containerManager");
const llmProviders = require('./llmProviders');
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const { waitForAgentReadiness } = require("./healthChecks");

const providerCatalog = Array.isArray(llmProviders.PROVIDERS)
  ? llmProviders.PROVIDERS
  : (typeof llmProviders.getAvailableProviders === 'function' ? llmProviders.getAvailableProviders() : []);
const LLM_ENV_VARS = new Set(providerCatalog.map((provider) => provider.envVar).filter(Boolean));

const PROVIDER_MODEL_DEFAULTS = {
  anthropic: 'claude-sonnet-4-5',
  openai:    'gpt-5.4',
  google:    'gemini-3.1-pro-preview',
  groq:      'llama-3.3-70b-versatile',
  mistral:   'mistral-large-latest',
  deepseek:  'deepseek-chat',
  openrouter:'openrouter/auto',
  together:  'together/moonshotai/Kimi-K2.5',
  cohere:    'command-r-plus',
  xai:       'grok-4',
  nvidia:    'nvidia/nvidia/nemotron-3-super-120b-a12b',
  moonshot:  'kimi-k2.5',
  zai:       'glm-5',
  minimax:   'MiniMax-M2.7',
};

/**
 * Build auth-profiles.json content for a specific agent.
 * Merges per-user LLM provider keys with per-agent integration tokens
 * that overlap with LLM auth env vars (e.g., HF_TOKEN, OPENAI_API_KEY).
 * Explicit LLM provider keys always take precedence over integration tokens.
 */
async function buildAuthProfilesForAgent(userId, agentId) {
  const llmKeys = await llmProviders.getProviderKeys(userId);

  try {
    const { getIntegrationEnvVars } = require('./integrations');
    const integrationEnvVars = await getIntegrationEnvVars(agentId);
    const integrationLlmKeys = {};
    for (const [envVar, value] of Object.entries(integrationEnvVars)) {
      if (LLM_ENV_VARS.has(envVar)) {
        integrationLlmKeys[envVar] = value;
      }
    }
    // LLM provider keys win over integration-sourced tokens for the same env var
    return llmProviders.buildAuthProfiles({ ...integrationLlmKeys, ...llmKeys });
  } catch {
    return llmProviders.buildAuthProfiles(llmKeys);
  }
}

function buildAuthProfilesWriteCommand(authProfiles) {
  const authJsonB64 = Buffer.from(JSON.stringify(authProfiles)).toString('base64');
  return (
    `mkdir -p /root/.openclaw/agents/main/agent && ` +
    `printf '%s' '${authJsonB64}' | base64 -d > /root/.openclaw/agents/main/agent/auth-profiles.json`
  );
}

function buildDefaultModelCommand(defaultProvider = null) {
  if (!defaultProvider) return null;

  const modelId =
    defaultProvider.model || PROVIDER_MODEL_DEFAULTS[defaultProvider.provider];
  if (!modelId) return null;

  const fullModel = modelId.includes('/')
    ? modelId
    : `${defaultProvider.provider}/${modelId}`;

  return (
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"; ' +
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi; ' +
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] || exit 127; ' +
    `exec "$OPENCLAW_BIN" ${["models", "set", fullModel]
      .map((arg) => JSON.stringify(String(arg)))
      .join(" ")}`
  );
}

async function runRuntimeCommand(agent, command, { timeout = 30000 } = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("Agent runtime endpoint unavailable");
  }

  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command,
      timeout,
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `Runtime command failed with HTTP ${response.status}`);
  }

  if ((payload.exitCode || 0) !== 0) {
    throw new Error(payload.stderr || payload.stdout || `Runtime command exited with code ${payload.exitCode}`);
  }

  return payload;
}

async function writeAuthToContainer(agent, authProfiles) {
  return runRuntimeCommand(agent, buildAuthProfilesWriteCommand(authProfiles));
}

/**
 * Sync auth-profiles.json to all running agents of a user.
 * If agentId is provided, syncs only that agent.
 *
 * Returns an array of { agentId, status, error? } results.
 * Non-blocking safe: failures per-agent are logged but do not throw.
 */
async function syncAuthToUserAgents(userId, agentId = null) {
  const defaultRow = await db.query(
    'SELECT provider, model FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1',
    [userId]
  );
  const defaultProvider = defaultRow.rows[0] || null;
  const modelCommand = buildDefaultModelCommand(defaultProvider);

  const agentQuery = agentId
    ? `SELECT id, container_id, backend_type, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE id = $1 AND user_id = $2 AND status IN ('running', 'warning') AND container_id IS NOT NULL`
    : `SELECT id, container_id, backend_type, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE user_id = $1 AND status IN ('running', 'warning') AND container_id IS NOT NULL`;
  const agentParams = agentId ? [agentId, userId] : [userId];
  const agents = await db.query(agentQuery, agentParams);

  // Evict stale gateway connections — the restart will invalidate them
  let evictConnection;
  try {
    evictConnection = require('./gatewayProxy').evictConnection;
  } catch { /* gatewayProxy not available in worker context */ }

  const results = [];
  for (const agent of agents.rows) {
    try {
      // Evict the cached WS connection before restarting so the proxy
      // creates a fresh one on the next request instead of hitting the circuit breaker
      if (evictConnection) {
        evictConnection(agent);
      }
      const authProfiles = await buildAuthProfilesForAgent(userId, agent.id);
      await writeAuthToContainer(agent, authProfiles);
      await containerManager.restart(agent);

      if (modelCommand) {
        const readiness = await waitForAgentReadiness({
          host: agent.host,
          runtimeHost: agent.runtime_host,
          runtimePort: agent.runtime_port,
          gatewayHostPort: agent.gateway_host_port,
          gatewayHost: agent.gateway_host,
          gatewayPort: agent.gateway_port,
        });
        if (!readiness.ok) {
          throw new Error(
            `Agent runtime did not recover after auth sync restart (${readiness.runtime?.error || readiness.gateway?.error || "unreachable"})`
          );
        }
        await runRuntimeCommand(agent, modelCommand, { timeout: 60000 });
      }

      console.log(`[authSync] Synced auth-profiles.json to agent ${agent.id} (backend restarted)`);
      results.push({ agentId: agent.id, status: 'synced' });
    } catch (e) {
      console.warn(`[authSync] Failed for agent ${agent.id}:`, e.message);
      results.push({ agentId: agent.id, status: 'failed', error: e.message });
    }
  }
  return results;
}

module.exports = {
  syncAuthToUserAgents,
  buildAuthProfilesForAgent,
  buildAuthProfilesWriteCommand,
  buildDefaultModelCommand,
  runRuntimeCommand,
  writeAuthToContainer,
};
