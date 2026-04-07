// Syncs auth-profiles.json to running agent containers via Docker exec.
// After writing, restarts the container so the openclaw gateway process
// re-reads the file on startup (it does not hot-reload from disk).
// Called whenever LLM provider keys or LLM-relevant integrations change.

const db = require('./db');
const llmProviders = require('./llmProviders');
const { OPENCLAW_GATEWAY_PORT } = require('../agent-runtime/lib/contracts');

const providerCatalog = Array.isArray(llmProviders.PROVIDERS)
  ? llmProviders.PROVIDERS
  : (typeof llmProviders.getAvailableProviders === 'function' ? llmProviders.getAvailableProviders() : []);
const LLM_ENV_VARS = new Set(providerCatalog.map((provider) => provider.envVar).filter(Boolean));

const PROVIDER_MODEL_DEFAULTS = {
  anthropic: 'claude-sonnet-4-5',
  openai:    'gpt-5.4',
  google:    'gemini-3-flash-preview',
  groq:      'llama-3.3-70b-versatile',
  mistral:   'mistral-large-latest',
  deepseek:  'deepseek-chat',
  cohere:    'command-r-plus',
  xai:       'grok-2',
  nvidia:    'nvidia/nemotron-3-super-120b-a12b',
  moonshot:  'kimi-k2.5',
  zai:       'glm-5',
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

/**
 * Write auth-profiles.json to a running container via Docker exec,
 * then gracefully restart the container so the gateway re-reads the file.
 * The startup CMD (docker.js) skips overwriting auth-profiles.json when
 * the file already exists, so the exec-written version is preserved.
 */
async function writeAuthToContainer(docker, containerId, authProfiles, defaultProvider = null) {
  const authJsonB64 = Buffer.from(JSON.stringify(authProfiles)).toString('base64');
  const container = docker.getContainer(containerId);

  // 1. Write the updated auth-profiles.json into the container filesystem
  const writeExec = await container.exec({
    Cmd: ['sh', '-c',
      `mkdir -p /root/.openclaw/agents/main/agent && ` +
      `printf '%s' '${authJsonB64}' | base64 -d > /root/.openclaw/agents/main/agent/auth-profiles.json`
    ],
    AttachStdout: true,
    AttachStderr: true,
  });
  await writeExec.start({});

  // 2. Gracefully restart the container so the gateway re-reads auth-profiles.json.
  //    Using container.restart() instead of pkill gives a clean Docker lifecycle —
  //    SIGTERM → wait → SIGKILL → restart. The `which openclaw` guard in the startup
  //    CMD skips reinstallation since it's already present.
  try {
    await container.restart({ t: 5 });
  } catch { /* container may already be restarting */ }

  // 3. Wait for the gateway to be ready before setting the model.
  //    Poll the gateway's HTTP endpoint inside the container instead of a blind sleep.
  if (defaultProvider) {
    const modelId = defaultProvider.model || PROVIDER_MODEL_DEFAULTS[defaultProvider.provider];
    if (modelId) {
      const fullModel = modelId.includes('/') ? modelId : `${defaultProvider.provider}/${modelId}`;

      // Poll until gateway is listening (up to 60s)
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const checkExec = await container.exec({
            Cmd: ['sh', '-c', `curl -sf http://localhost:${OPENCLAW_GATEWAY_PORT} >/dev/null 2>&1 || wget -q -O /dev/null http://localhost:${OPENCLAW_GATEWAY_PORT} 2>/dev/null`],
            AttachStdout: true,
            AttachStderr: true,
          });
          const stream = await checkExec.start({});
          // Consume stream to completion
          await new Promise((resolve) => {
            stream.on('data', () => {});
            stream.on('end', resolve);
            stream.on('error', resolve);
          });
          const result = await checkExec.inspect();
          if (result.ExitCode === 0) { ready = true; break; }
        } catch { /* container may still be restarting */ }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (ready) {
        try {
          const modelExec = await container.exec({
            Cmd: ['openclaw', 'models', 'set', fullModel],
            AttachStdout: true,
            AttachStderr: true,
          });
          await modelExec.start({});
        } catch { /* non-critical */ }
      }
    }
  }
}

/**
 * Sync auth-profiles.json to all running agents of a user.
 * If agentId is provided, syncs only that agent.
 *
 * Returns an array of { agentId, status, error? } results.
 * Non-blocking safe: failures per-agent are logged but do not throw.
 */
async function syncAuthToUserAgents(userId, agentId = null) {
  let docker;
  try {
    const Docker = require('dockerode');
    docker = new Docker({ socketPath: '/var/run/docker.sock' });
  } catch {
    console.warn('[authSync] Docker not available — skipping auth sync');
    return [];
  }

  const defaultRow = await db.query(
    'SELECT provider, model FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1',
    [userId]
  );
  const defaultProvider = defaultRow.rows[0] || null;

  const agentQuery = agentId
    ? `SELECT id, container_id, host, gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE id = $1 AND user_id = $2 AND status IN ('running', 'warning') AND container_id IS NOT NULL`
    : `SELECT id, container_id, host, gateway_host_port, gateway_host, gateway_port
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
      await writeAuthToContainer(docker, agent.container_id, authProfiles, defaultProvider);
      console.log(`[authSync] Synced auth-profiles.json to agent ${agent.id} (container restarted)`);
      results.push({ agentId: agent.id, status: 'synced' });
    } catch (e) {
      console.warn(`[authSync] Failed for agent ${agent.id}:`, e.message);
      results.push({ agentId: agent.id, status: 'failed', error: e.message });
    }
  }
  return results;
}

module.exports = { syncAuthToUserAgents, buildAuthProfilesForAgent, writeAuthToContainer };
