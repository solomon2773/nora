// Syncs auth-profiles.json to running agent containers via Docker exec.
// After writing, restarts the container so the openclaw gateway process
// re-reads the file on startup (it does not hot-reload from disk).
// Called whenever LLM provider keys or LLM-relevant integrations change.

const db = require('./db');
const llmProviders = require('./llmProviders');

const LLM_ENV_VARS = new Set(llmProviders.PROVIDERS.map(p => p.envVar));

/**
 * Poll the agent's gateway health endpoint until it returns 200 OK
 * or the maximum retries are reached.
 */
async function waitForGateway(container, maxRetries = 15, intervalMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const healthExec = await container.exec({
        Cmd: ['curl', '-sf', 'http://localhost:18789/health'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await healthExec.start({});
      const exitCode = await new Promise((resolve) => {
        stream.on('end', async () => {
          const { ExitCode } = await healthExec.inspect();
          resolve(ExitCode);
        });
      });
      if (exitCode === 0) return true;
    } catch (e) {
      // ignore and retry
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

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
 * then restart the container so the gateway process re-reads the file.
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

  // 2. Gracefully restart just the openclaw gateway process so it re-reads
  //    auth-profiles.json — without restarting the entire container (which
  //    would re-run apt-get + npm install and risk a crash loop if the
  //    npm registry is unreachable).
  //    `pkill -f "openclaw gateway"` kills the gateway; the parent shell
  //    sees the child exit, exits itself, and Docker's "unless-stopped"
  //    restart policy brings the container back up. The `which openclaw`
  //    guard in the startup CMD skips reinstallation since it's already present.
  try {
    const restartExec = await container.exec({
      Cmd: ['sh', '-c', 'pkill -f "openclaw gateway" || true'],
      AttachStdout: true,
      AttachStderr: true,
    });
    await restartExec.start({});
  } catch { /* container may already be restarting */ }

  // 3. After restart, set the default model (runs in the fresh gateway).
  //    Wait for the gateway to re-initialize before issuing CLI commands.
  if (defaultProvider) {
    const modelId = defaultProvider.model || llmProviders.MODEL_DEFAULTS[defaultProvider.provider];
    if (modelId) {
      const fullModel = modelId.includes('/') ? modelId : `${defaultProvider.provider}/${modelId}`;
      const isUp = await waitForGateway(container);
      if (isUp) {
        try {
          const modelExec = await container.exec({
            Cmd: ['openclaw', 'models', 'set', fullModel],
            AttachStdout: true,
            AttachStderr: true,
          });
          await modelExec.start({});
        } catch { /* non-critical */ }
      } else {
        console.warn(`[authSync] Gateway did not come up in time for agent ${containerId} - skipped model set`);
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
    ? "SELECT id, container_id FROM agents WHERE id = $1 AND user_id = $2 AND status IN ('running', 'warning') AND container_id IS NOT NULL"
    : "SELECT id, container_id FROM agents WHERE user_id = $1 AND status IN ('running', 'warning') AND container_id IS NOT NULL";
  const agentParams = agentId ? [agentId, userId] : [userId];
  const agents = await db.query(agentQuery, agentParams);

  const results = [];
  for (const agent of agents.rows) {
    try {
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
