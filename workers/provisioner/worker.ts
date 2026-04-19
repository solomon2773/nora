// @ts-nocheck
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { Pool } = require('pg');
const { getDefaultAgentImage } = require('../../agent-runtime/lib/agentImages');
const { runtimeUrlForAgent } = require('../../agent-runtime/lib/agentEndpoints');
const {
  getDefaultBackend,
  getEnabledBackends,
  isKnownBackend,
  normalizeBackendName,
  sandboxForBackend,
} = require('../../agent-runtime/lib/backendCatalog');
const { buildAgentRuntimeFields } = require('../../agent-runtime/lib/agentRuntimeFields');
const {
  getAgentSecretEnvVars,
} = require('../../backend-api/agentSecretOverrides');
const {
  buildHermesSeedArchive,
  getMigrationManifestForAgent,
} = require('../../backend-api/agentMigrations');
const {
  applyPersistedHermesState,
  getPersistedHermesState,
} = require('../../backend-api/hermesUi');
const { waitForAgentReadiness } = require('./healthChecks');
const { buildReadinessWarningDetail, persistReadinessWarning } = require('./readinessWarning');

// ── Connections ──────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null
});

const db = new Pool({
  user: process.env.DB_USER || 'nora',
  password: process.env.DB_PASSWORD || 'nora',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'nora',
  port: parseInt(process.env.DB_PORT || '5432'),
});

function parseTimeoutMs(rawValue, fallbackMs) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 60000 ? parsed : fallbackMs;
}

function parsePositiveInteger(rawValue, fallbackValue, { min = 1, max = 32 } = {}) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallbackValue;
  return Math.min(max, Math.max(min, parsed));
}

const PROVIDER_ENV_MAP = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  cohere: 'COHERE_API_KEY',
  xai: 'XAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
  huggingface: 'HF_TOKEN',
  cerebras: 'CEREBRAS_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
});

const PROVIDER_ENV_ENDPOINT_MAP = Object.freeze({
  GEMINI_API_KEY: 'https://generativelanguage.googleapis.com/v1beta',
  NVIDIA_API_KEY: 'https://integrate.api.nvidia.com/v1',
});

const PROVIDER_MODEL_DEFAULTS = Object.freeze({
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.4',
  google: 'gemini-3.1-pro-preview',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
  deepseek: 'deepseek-chat',
  openrouter: 'openrouter/auto',
  together: 'together/moonshotai/Kimi-K2.5',
  cohere: 'command-r-plus',
  xai: 'grok-4',
  nvidia: 'nvidia/nvidia/nemotron-3-super-120b-a12b',
  moonshot: 'kimi-k2.5',
  zai: 'glm-5',
  minimax: 'MiniMax-M2.7',
});

const HERMES_NATIVE_PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({ provider: 'anthropic' }),
  deepseek: Object.freeze({ provider: 'deepseek' }),
  google: Object.freeze({ provider: 'gemini' }),
  huggingface: Object.freeze({ provider: 'huggingface' }),
  minimax: Object.freeze({ provider: 'minimax' }),
  moonshot: Object.freeze({ provider: 'kimi-coding' }),
  openrouter: Object.freeze({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  }),
  xai: Object.freeze({ provider: 'xai' }),
  zai: Object.freeze({ provider: 'zai' }),
});

const HERMES_CUSTOM_PROVIDER_BASE_URLS = Object.freeze({
  cerebras: 'https://api.cerebras.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openai: 'https://api.openai.com/v1',
  together: 'https://api.together.xyz/v1',
});

const DOCKER_EXEC_FALLBACK_BACKENDS = new Set(['docker', 'nemoclaw']);

function normalizeEnvValueMap(envVars = {}) {
  return Object.fromEntries(
    Object.entries(envVars || {})
      .filter(([key, value]) => key && value != null && String(value) !== '')
      .map(([key, value]) => [key, String(value)])
  );
}

function buildAuthProfiles(providerKeys = {}) {
  const envToProvider = Object.fromEntries(
    Object.entries(PROVIDER_ENV_MAP).map(([provider, envVar]) => [envVar, provider])
  );
  const profiles = {};
  const order = {};
  const lastGood = {};
  for (const [envVar, key] of Object.entries(normalizeEnvValueMap(providerKeys))) {
    const provider = envToProvider[envVar];
    if (!provider) continue;
    const profileId = `${provider}:default`;
    profiles[profileId] = {
      type: 'api_key',
      provider,
      key,
      ...(PROVIDER_ENV_ENDPOINT_MAP[envVar]
        ? { endpoint: PROVIDER_ENV_ENDPOINT_MAP[envVar] }
        : {}),
    };
    order[provider] = [profileId];
    lastGood[provider] = profileId;
  }
  return {
    version: 1,
    profiles,
    ...(Object.keys(order).length > 0 ? { order } : {}),
    ...(Object.keys(lastGood).length > 0 ? { lastGood } : {}),
  };
}

function buildAuthProfilesWriteCommand(authProfiles) {
  const authJsonB64 = Buffer.from(JSON.stringify(authProfiles)).toString('base64');
  return (
    `mkdir -p /root/.openclaw/agents/main/agent && ` +
    `printf '%s' '${authJsonB64}' | base64 -d > /root/.openclaw/agents/main/agent/auth-profiles.json && ` +
    `chmod 0600 /root/.openclaw/agents/main/agent/auth-profiles.json`
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

function normalizeProviderConfig(config) {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function pickProviderBaseUrl(config = {}) {
  for (const key of ['base_url', 'baseUrl', 'endpoint', 'url']) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function buildHermesModelConfig(defaultProvider = null) {
  if (!defaultProvider) return null;

  const providerId = String(defaultProvider.provider || '').trim();
  if (!providerId) {
    throw new Error('Default LLM provider is missing a provider id');
  }

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  const modelId =
    typeof defaultProvider.model === 'string' && defaultProvider.model.trim()
      ? defaultProvider.model.trim()
      : PROVIDER_MODEL_DEFAULTS[providerId];

  if (!modelId) {
    throw new Error(
      `Default provider ${providerId} needs a saved model before Hermes can use it`
    );
  }

  const nativeProvider = HERMES_NATIVE_PROVIDER_MAP[providerId];
  if (nativeProvider) {
    return {
      provider: nativeProvider.provider,
      defaultModel: modelId,
      baseUrl: nativeProvider.baseUrl || savedBaseUrl || null,
    };
  }

  const resolvedBaseUrl =
    savedBaseUrl ||
    HERMES_CUSTOM_PROVIDER_BASE_URLS[providerId] ||
    '';

  if (!resolvedBaseUrl) {
    throw new Error(
      `Provider ${providerId} needs a base URL before Hermes can use it`
    );
  }

  return {
    provider: 'custom',
    defaultModel: modelId,
    baseUrl: resolvedBaseUrl,
  };
}

function hasMeaningfulHermesModelConfig(modelConfig = {}) {
  return Boolean(
    String(modelConfig?.defaultModel || '').trim() ||
    String(modelConfig?.provider || '').trim() ||
    String(modelConfig?.baseUrl || '').trim()
  );
}

function escapeDotenvValue(value) {
  return `"${String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"')}"`;
}

function buildHermesEnvWriteCommand(envVars = {}) {
  const managedBlock = Object.entries(normalizeEnvValueMap(envVars))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeDotenvValue(value)}`)
    .join('\n');
  const blockB64 = Buffer.from(managedBlock).toString('base64');

  return [
    'set -eu',
    'start_marker="# >>> NORA MANAGED ENV >>>"',
    'end_marker="# <<< NORA MANAGED ENV <<<"',
    'tmp_file="$(mktemp)"',
    'if [ -f /opt/data/.env ]; then',
    "  awk -v start=\"$start_marker\" -v end=\"$end_marker\" 'BEGIN{skip=0} $0==start {skip=1; next} $0==end {skip=0; next} !skip {print}' /opt/data/.env > \"$tmp_file\"",
    'else',
    '  : > "$tmp_file"',
    'fi',
    'if [ -s "$tmp_file" ]; then printf \'\\n\' >> "$tmp_file"; fi',
    'printf \'%s\\n\' "$start_marker" >> "$tmp_file"',
    `printf '%s' '${blockB64}' | base64 -d >> "$tmp_file"`,
    'printf \'\\n\' >> "$tmp_file"',
    'printf \'%s\\n\' "$end_marker" >> "$tmp_file"',
    'chown hermes:hermes "$tmp_file" 2>/dev/null || true',
    'chmod 0600 "$tmp_file"',
    'mv "$tmp_file" /opt/data/.env',
    'chown hermes:hermes /opt/data/.env 2>/dev/null || true',
    'chmod 0600 /opt/data/.env',
  ].join('\n');
}

function buildHermesModelConfigWriteCommand(modelConfig = {}) {
  const payloadJson = JSON.stringify(modelConfig || {});
  return `
python3 - <<'PY'
import json
from pathlib import Path

import yaml

from hermes_cli.config import get_config_path, load_config

payload = json.loads(${JSON.stringify(payloadJson)})
config = load_config() or {}
model = dict(config.get("model") or {})

default_model = str(payload.get("defaultModel") or "").strip()
provider = str(payload.get("provider") or "").strip()
base_url = str(payload.get("baseUrl") or "").strip()

if default_model:
    model["default"] = default_model
else:
    model.pop("default", None)

if provider:
    model["provider"] = provider
else:
    model.pop("provider", None)

if base_url:
    model["base_url"] = base_url
else:
    model.pop("base_url", None)

if model:
    config["model"] = model
else:
    config.pop("model", None)

config_path = Path(get_config_path())
config_path.parent.mkdir(parents=True, exist_ok=True)

with config_path.open("w", encoding="utf-8") as handle:
    yaml.safe_dump(config, handle, sort_keys=False)

print(json.dumps({"ok": True}))
PY`.trim();
}

async function fetchUserLlmEnvVars(userId) {
  if (!userId || (process.env.KEY_STORAGE || 'database') !== 'database') {
    return {};
  }

  try {
    const keysResult = await db.query(
      'SELECT provider, api_key FROM llm_providers WHERE user_id = $1',
      [userId]
    );
    const { decrypt } = require('./crypto');
    const llmEnvVars = {};
    for (const row of keysResult.rows) {
      const envName = PROVIDER_ENV_MAP[row.provider];
      if (!envName || !row.api_key) continue;
      try {
        llmEnvVars[envName] = decrypt(row.api_key);
      } catch {
        llmEnvVars[envName] = row.api_key;
      }
    }
    return normalizeEnvValueMap(llmEnvVars);
  } catch (error) {
    console.warn(`[provisioner] Failed to fetch LLM keys for user ${userId}:`, error.message);
    return {};
  }
}

async function fetchDefaultProvider(userId) {
  if (!userId || (process.env.KEY_STORAGE || 'database') !== 'database') {
    return null;
  }

  try {
    const result = await db.query(
      'SELECT id, provider, model, config FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1',
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.warn(`[provisioner] Failed to fetch default LLM provider for user ${userId}:`, error.message);
    return null;
  }
}

async function runRuntimeCommand(agent, command, { timeout = 30000 } = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, '/exec');
  if (!runtimeUrl) {
    throw new Error('Agent runtime endpoint unavailable');
  }

  const response = await fetch(runtimeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function runProvisionerExecCommand(provisioner, containerId, command, { timeout = 30000 } = {}) {
  const execResult = await provisioner.exec(containerId, {
    cmd: ['/bin/sh', '-lc', command],
    tty: true,
    env: [],
  });
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error('Container exec unavailable');
  }

  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        execResult.stream.destroy();
      } catch {
        // Ignore stream teardown failures.
      }
      reject(new Error(`Container command timed out after ${timeout}ms`));
    }, timeout);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    execResult.stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    execResult.stream.on('end', finish);
    execResult.stream.on('close', finish);
    execResult.stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  const inspectResult = await execResult.exec.inspect();
  const exitCode = inspectResult?.ExitCode ?? 0;
  if (exitCode !== 0) {
    throw new Error(output.trim() || `Container command exited with code ${exitCode}`);
  }

  return { exitCode, output };
}

async function reconcileRuntimeLlmAuth({
  agentId,
  userId,
  runtimeFamily,
  resolvedBackend,
  containerId,
  provisioner,
  host,
  runtimeHost,
  runtimePort,
  gatewayHostPort,
  gatewayHost,
  gatewayPort,
} = {}) {
  const llmEnvVars = await fetchUserLlmEnvVars(userId);
  const defaultProvider = await fetchDefaultProvider(userId);
  const hasLlmKeys = Object.keys(llmEnvVars).length > 0;
  if (!hasLlmKeys && !defaultProvider) {
    return { status: 'skipped' };
  }

  const agentRef = {
    backend_type: resolvedBackend,
    host,
    runtime_host: runtimeHost,
    runtime_port: runtimePort,
    gateway_host_port: gatewayHostPort,
    gateway_host: gatewayHost,
    gateway_port: gatewayPort,
  };

  if (runtimeFamily === 'hermes') {
    let persistedModelConfig = null;
    if (agentId) {
      try {
        const persistedState = await getPersistedHermesState(agentId);
        if (hasMeaningfulHermesModelConfig(persistedState?.modelConfig)) {
          persistedModelConfig = persistedState.modelConfig;
        }
      } catch {
        persistedModelConfig = null;
      }
    }

    const modelConfig = persistedModelConfig || buildHermesModelConfig(defaultProvider);
    if (modelConfig) {
      await runProvisionerExecCommand(
        provisioner,
        containerId,
        buildHermesModelConfigWriteCommand(modelConfig)
      );
    }
    await runProvisionerExecCommand(
      provisioner,
      containerId,
      buildHermesEnvWriteCommand(llmEnvVars)
    );
    await provisioner.restart(containerId);
    const readiness = await waitForAgentReadiness(
      {
        host,
        runtimeHost,
        runtimePort,
        gatewayHostPort,
        gatewayHost,
        gatewayPort,
        checkGateway: false,
      },
      {
        runtime: {
          attempts: 8,
          intervalMs: 5000,
          timeoutMs: 5000,
        },
      }
    );
    if (!readiness.ok) {
      throw new Error(
        `Hermes runtime did not recover after auth reconcile (${readiness.runtime?.error || 'unreachable'})`
      );
    }
    return { status: 'synced' };
  }

  const authProfiles = buildAuthProfiles(llmEnvVars);
  const modelCommand = buildDefaultModelCommand(defaultProvider);
  if (Object.keys(authProfiles).length === 0 && !modelCommand) {
    return { status: 'skipped' };
  }

  const authWriteCommand = buildAuthProfilesWriteCommand(authProfiles);
  try {
    await runRuntimeCommand(agentRef, authWriteCommand);
  } catch (error) {
    if (!DOCKER_EXEC_FALLBACK_BACKENDS.has(resolvedBackend)) {
      throw error;
    }
    await runProvisionerExecCommand(provisioner, containerId, authWriteCommand);
  }

  await provisioner.restart(containerId);
  const readiness = await waitForAgentReadiness({
    host,
    runtimeHost,
    runtimePort,
    gatewayHostPort,
    gatewayHost,
    gatewayPort,
  });
  if (!readiness.ok) {
    throw new Error(
      `Agent runtime did not recover after auth reconcile (${readiness.runtime?.error || readiness.gateway?.error || 'unreachable'})`
    );
  }

  if (modelCommand) {
    await runRuntimeCommand(agentRef, modelCommand, { timeout: 60000 });
  }

  return { status: 'synced' };
}

function buildIntegrationSyncEntry(row = {}) {
  let config = row.config || {};
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch {
      config = {};
    }
  }

  return {
    id: row.id,
    provider: row.provider || row.catalog_id || row.id,
    name: row.catalog_name || row.provider || row.catalog_id || row.id,
    category: row.catalog_category || 'unknown',
    config,
    status: row.status || 'active',
  };
}

async function markDeploymentLifecycle(db, agentId, status) {
  await db.query("UPDATE agents SET status = $2 WHERE id = $1", [agentId, status]);
  await db.query("UPDATE deployments SET status = $2 WHERE agent_id = $1", [agentId, status]);
}

// ── Pluggable Backend ────────────────────────────────────
const backendInstances = new Map();

function loadBackend(backendId) {
  const backend = normalizeBackendName(backendId || 'docker');
  if (backendInstances.has(backend)) return backendInstances.get(backend);

  let instance;
  switch (backend) {
    case 'docker':
      instance = new (require('./backends/docker'))();
      break;
    case 'hermes':
      instance = new (require('./backends/hermes'))();
      break;
    case 'nemoclaw':
      instance = new (require('./backends/nemoclaw'))();
      break;
    case 'proxmox':
      instance = new (require('./backends/proxmox'))();
      break;
    case 'k8s':
    case 'kubernetes':
      instance = new (require('./backends/k8s'))();
      break;
    default:
      console.warn(`Unknown backend "${backend}", falling back to docker`);
      instance = new (require('./backends/docker'))();
      break;
  }

  backendInstances.set(backend, instance);
  return instance;
}

const enabledBackends = getEnabledBackends();
const DEPLOYMENT_WORKER_CONCURRENCY = parsePositiveInteger(
  process.env.DEPLOYMENT_WORKER_CONCURRENCY,
  3
);
console.log(
  `Provisioner worker started [enabled backends=${enabledBackends.join(', ') || 'docker'} default backend=${getDefaultBackend()} concurrency=${DEPLOYMENT_WORKER_CONCURRENCY}]`
);

// ── Worker ───────────────────────────────────────────────
const worker = new Worker('deployments', async (job) => {
  const { id, name, image, specs, userId, sandbox, backend, container_name, model } = job.data;
  const vcpu = specs?.vcpu || 1;
  const ram_mb = specs?.ram_mb || 1024;
  const disk_gb = specs?.disk_gb || 10;

  const agentRowResult = await db.query(
    `SELECT image, template_payload, sandbox_type, backend_type, runtime_family,
            deploy_target, sandbox_profile
       FROM agents
      WHERE id = $1`,
    [id]
  );
  const agentRow = agentRowResult.rows[0] || {};
  const storedRuntimeFields = buildAgentRuntimeFields(agentRow);
  const resolvedBackend = isKnownBackend(backend)
    ? normalizeBackendName(backend)
    : isKnownBackend(storedRuntimeFields.backend_type)
      ? normalizeBackendName(storedRuntimeFields.backend_type)
      : getDefaultBackend(process.env, {
          sandbox: sandbox || storedRuntimeFields.sandbox_profile || 'standard',
        });
  const resolvedRuntimeFields = buildAgentRuntimeFields({
    runtime_family: storedRuntimeFields.runtime_family,
    backend_type: resolvedBackend,
    sandbox_type: sandbox || storedRuntimeFields.sandbox_profile,
  });
  const resolvedSandbox = resolvedRuntimeFields.sandbox_profile;
  const provisioner = loadBackend(resolvedBackend);
  const resolvedImage = image || agentRow.image || getDefaultAgentImage({
    sandbox: resolvedSandbox,
    backend: resolvedBackend,
  });
  let templatePayload = agentRow.template_payload || {};
  if (typeof templatePayload === 'string') {
    try {
      templatePayload = JSON.parse(templatePayload);
    } catch {
      templatePayload = {};
    }
  }

  console.log(`Processing deployment job ${job.id}: agent=${id} name=${name} backend=${resolvedBackend} (${vcpu}vCPU/${ram_mb}MB/${disk_gb}GB)`);
  await markDeploymentLifecycle(db, id, "deploying");

  // Fetch user's LLM provider keys from DB for injection into container
  const llmEnvVars = await fetchUserLlmEnvVars(userId);
  if (Object.keys(llmEnvVars).length > 0) {
    console.log(`[provisioner] Injecting ${Object.keys(llmEnvVars).length} LLM provider key(s) for user ${userId}`);
  }

  // Fetch integration credentials for this agent and inject as env vars into the container
  let integrationEnvVars = {};
  try {
    const INTEGRATION_ENV_MAP = {
      huggingface:          'HF_TOKEN',
      github:               'GITHUB_TOKEN',
      gitlab:               'GITLAB_TOKEN',
      slack:                'SLACK_TOKEN',
      discord:              'DISCORD_TOKEN',
      notion:               'NOTION_TOKEN',
      linear:               'LINEAR_API_KEY',
      datadog:              'DD_API_KEY',
      sentry:               'SENTRY_AUTH_TOKEN',
      sendgrid:             'SENDGRID_API_KEY',
      openai:               'OPENAI_API_KEY',
      anthropic:            'ANTHROPIC_API_KEY',
      airtable:             'AIRTABLE_API_KEY',
      asana:                'ASANA_TOKEN',
      stripe:               'STRIPE_SECRET_KEY',
      hubspot:              'HUBSPOT_ACCESS_TOKEN',
      pipedrive:            'PIPEDRIVE_API_KEY',
      pinecone:             'PINECONE_API_KEY',
      vercel:               'VERCEL_TOKEN',
      circleci:             'CIRCLE_TOKEN',
      terraform:            'TFE_TOKEN',
      pagerduty:            'PAGERDUTY_TOKEN',
      dropbox:              'DROPBOX_ACCESS_TOKEN',
      twilio:               'TWILIO_AUTH_TOKEN',
      shopify:              'SHOPIFY_ACCESS_TOKEN',
      linkedin:             'LINKEDIN_ACCESS_TOKEN',
      salesforce:           'SALESFORCE_ACCESS_TOKEN',
      twitter:              'TWITTER_BEARER_TOKEN',
      digitalocean:         'DIGITALOCEAN_TOKEN',
      algolia:              'ALGOLIA_API_KEY',
      clickup:              'CLICKUP_API_KEY',
      monday:               'MONDAY_API_KEY',
      zendesk:              'ZENDESK_API_TOKEN',
      'docker-hub':         'DOCKER_HUB_TOKEN',
      bitbucket:            'BITBUCKET_TOKEN',
      confluence:           'CONFLUENCE_TOKEN',
      jira:                 'JIRA_API_TOKEN',
      jenkins:              'JENKINS_TOKEN',
      grafana:              'GRAFANA_TOKEN',
      woocommerce:          'WOOCOMMERCE_SECRET_KEY',
      trello:               'TRELLO_TOKEN',
      elasticsearch:        'ELASTICSEARCH_PASSWORD',
      supabase:             'SUPABASE_SERVICE_ROLE_KEY',
      facebook:             'FACEBOOK_ACCESS_TOKEN',
      aws:                  'AWS_SECRET_ACCESS_KEY',
      azure:                'AZURE_CLIENT_SECRET',
      s3:                   'S3_SECRET_ACCESS_KEY',
      mongodb:              'MONGODB_URI',
      redis:                'REDIS_PASSWORD',
      postgresql:           'PGPASSWORD',
      paypal:               'PAYPAL_CLIENT_SECRET',
      segment:              'SEGMENT_WRITE_KEY',
      mixpanel:             'MIXPANEL_API_SECRET',
      weaviate:             'WEAVIATE_API_KEY',
      email:                'SMTP_PASS',
    };
    const INTEGRATION_CONFIG_ENV_MAP = {
      'github.org':                       'GITHUB_ORG',
      'gitlab.base_url':                  'GITLAB_BASE_URL',
      'bitbucket.username':               'BITBUCKET_USERNAME',
      'bitbucket.workspace':              'BITBUCKET_WORKSPACE',
      'jira.email':                       'JIRA_EMAIL',
      'jira.site_url':                    'JIRA_BASE_URL',
      'jira.project_key':                 'JIRA_PROJECT_KEY',
      'linear.team_id':                   'LINEAR_TEAM_ID',
      'slack.default_channel':            'SLACK_DEFAULT_CHANNEL',
      'discord.guild_id':                 'DISCORD_GUILD_ID',
      'teams.webhook_url':                'TEAMS_WEBHOOK_URL',
      'email.smtp_host':                  'SMTP_HOST',
      'email.smtp_port':                  'SMTP_PORT',
      'email.smtp_user':                  'SMTP_USER',
      'email.from_address':               'SMTP_FROM_ADDRESS',
      'twilio.account_sid':               'TWILIO_ACCOUNT_SID',
      'twilio.phone_number':              'TWILIO_PHONE_NUMBER',
      'sendgrid.from_email':              'SENDGRID_FROM_EMAIL',
      'openai.org_id':                    'OPENAI_ORG_ID',
      'huggingface.model_id':             'HF_DEFAULT_MODEL',
      'aws.access_key_id':                'AWS_ACCESS_KEY_ID',
      'aws.region':                       'AWS_DEFAULT_REGION',
      'gcp.service_account_json':         'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      'gcp.project_id':                   'GCP_PROJECT_ID',
      'azure.tenant_id':                  'AZURE_TENANT_ID',
      'azure.client_id':                  'AZURE_CLIENT_ID',
      's3.access_key_id':                 'S3_ACCESS_KEY_ID',
      's3.region':                        'S3_REGION',
      's3.bucket':                        'S3_BUCKET',
      'google-drive.service_account_json':'GOOGLE_DRIVE_SA_JSON',
      'google-drive.folder_id':           'GOOGLE_DRIVE_FOLDER_ID',
      'postgresql.host':                  'PGHOST',
      'postgresql.port':                  'PGPORT',
      'postgresql.database':              'PGDATABASE',
      'postgresql.user':                  'PGUSER',
      'mongodb.database':                 'MONGODB_DATABASE',
      'redis.host':                       'REDIS_HOST',
      'redis.port':                       'REDIS_PORT',
      'redis.password':                   'REDIS_PASSWORD',
      'supabase.url':                     'SUPABASE_URL',
      'firebase.service_account_json':    'FIREBASE_SA_JSON',
      'firebase.database_url':            'FIREBASE_DATABASE_URL',
      'elasticsearch.node_url':           'ELASTICSEARCH_URL',
      'elasticsearch.username':           'ELASTICSEARCH_USERNAME',
      'elasticsearch.password':           'ELASTICSEARCH_PASSWORD',
      'elasticsearch.index':              'ELASTICSEARCH_INDEX',
      'weaviate.host':                    'WEAVIATE_HOST',
      'weaviate.api_key':                 'WEAVIATE_API_KEY',
      'pinecone.environment':             'PINECONE_ENVIRONMENT',
      'pinecone.index_name':              'PINECONE_INDEX',
      'algolia.app_id':                   'ALGOLIA_APP_ID',
      'algolia.index_name':               'ALGOLIA_INDEX',
      'datadog.app_key':                  'DD_APP_KEY',
      'datadog.site':                     'DD_SITE',
      'pagerduty.routing_key':            'PAGERDUTY_ROUTING_KEY',
      'sentry.organization':              'SENTRY_ORG',
      'sentry.project':                   'SENTRY_PROJECT',
      'grafana.url':                      'GRAFANA_URL',
      'jenkins.url':                      'JENKINS_URL',
      'jenkins.username':                 'JENKINS_USERNAME',
      'vercel.team_id':                   'VERCEL_TEAM_ID',
      'terraform.organization':           'TF_ORGANIZATION',
      'kubernetes.kubeconfig':            'KUBECONFIG_CONTENT',
      'kubernetes.context':               'KUBE_CONTEXT',
      'notion.workspace_id':              'NOTION_WORKSPACE_ID',
      'airtable.base_id':                 'AIRTABLE_BASE_ID',
      'trello.api_key':                   'TRELLO_API_KEY',
      'trello.board_id':                  'TRELLO_BOARD_ID',
      'clickup.workspace_id':             'CLICKUP_WORKSPACE_ID',
      'confluence.base_url':              'CONFLUENCE_BASE_URL',
      'confluence.email':                 'CONFLUENCE_EMAIL',
      'google-sheets.service_account_json': 'GOOGLE_SHEETS_SA_JSON',
      'google-sheets.spreadsheet_id':     'GOOGLE_SHEETS_SPREADSHEET_ID',
      'google-calendar.service_account_json': 'GOOGLE_CALENDAR_SA_JSON',
      'google-calendar.calendar_id':      'GOOGLE_CALENDAR_ID',
      'salesforce.instance_url':          'SALESFORCE_INSTANCE_URL',
      'zendesk.subdomain':                'ZENDESK_SUBDOMAIN',
      'zendesk.email':                    'ZENDESK_EMAIL',
      'pipedrive.company_domain':         'PIPEDRIVE_DOMAIN',
      'paypal.client_id':                 'PAYPAL_CLIENT_ID',
      'stripe.webhook_secret':            'STRIPE_WEBHOOK_SECRET',
      'twitter.api_key':                  'TWITTER_API_KEY',
      'twitter.api_secret':               'TWITTER_API_SECRET',
      'facebook.page_id':                 'FACEBOOK_PAGE_ID',
      'mixpanel.project_token':           'MIXPANEL_PROJECT_TOKEN',
      'google-analytics.service_account_json': 'GOOGLE_ANALYTICS_SA_JSON',
      'google-analytics.property_id':     'GA4_PROPERTY_ID',
      'shopify.shop_domain':              'SHOPIFY_SHOP_DOMAIN',
      'woocommerce.site_url':             'WOOCOMMERCE_STORE_URL',
      'woocommerce.consumer_key':         'WOOCOMMERCE_CONSUMER_KEY',
      'zapier.webhook_url':               'ZAPIER_WEBHOOK_URL',
      'make.webhook_url':                 'MAKE_WEBHOOK_URL',
      'n8n.webhook_url':                  'N8N_WEBHOOK_URL',
      'n8n.api_key':                      'N8N_API_KEY',
      'docker-hub.username':              'DOCKER_HUB_USERNAME',
    };
    const intResult = await db.query(
      "SELECT provider, access_token, config FROM integrations WHERE agent_id = $1 AND status = 'active'",
      [id]
    );
    const { decrypt } = require('./crypto');
    for (const row of intResult.rows) {
      // Primary token
      const envName = INTEGRATION_ENV_MAP[row.provider];
      if (envName && row.access_token) {
        try {
          integrationEnvVars[envName] = decrypt(row.access_token);
        } catch {
          integrationEnvVars[envName] = row.access_token;
        }
      }
      // Config fields (URLs, usernames, IDs, secondary secrets)
      const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {});
      for (const [cfgKey, cfgValue] of Object.entries(cfg)) {
        if (!cfgValue) continue;
        const cfgEnvName = INTEGRATION_CONFIG_ENV_MAP[`${row.provider}.${cfgKey}`];
        if (cfgEnvName) {
          integrationEnvVars[cfgEnvName] = String(cfgValue);
        }
      }
    }
    if (Object.keys(integrationEnvVars).length > 0) {
      console.log(`[provisioner] Injecting ${Object.keys(integrationEnvVars).length} integration credential(s) for agent ${id}`);
    }
  } catch (e) {
    console.warn(`[provisioner] Failed to fetch integration credentials for agent ${id}:`, e.message);
  }
  let agentSecretEnvVars = {};
  try {
    agentSecretEnvVars = normalizeEnvValueMap(await getAgentSecretEnvVars(id));
    if (Object.keys(agentSecretEnvVars).length > 0) {
      console.log(
        `[provisioner] Injecting ${Object.keys(agentSecretEnvVars).length} imported env override(s) for agent ${id}`
      );
    }
  } catch (e) {
    console.warn(
      `[provisioner] Failed to fetch agent secret overrides for agent ${id}:`,
      e.message
    );
  }

  const configuredProvisionTimeout = parseTimeoutMs(
    process.env.PROVISION_TIMEOUT_MS,
    840000
  );
  const jobTimeout = parseTimeoutMs(job?.opts?.timeout, 900000);
  const PROVISION_TIMEOUT = Math.min(
    configuredProvisionTimeout,
    Math.max(60000, jobTimeout - 60000)
  );

  let containerId, host, gatewayToken, containerName, gatewayHostPort, runtimeHost, runtimePort, gatewayHost, gatewayPort;
  try {
    const abortController = new AbortController();
    let provisionTimeoutHandle = null;
    const createPromise = provisioner.create({
        id,
        name,
        image: resolvedImage,
        vcpu,
        ram_mb,
        disk_gb,
        container_name,
        templatePayload,
        abortSignal: abortController.signal,
        env: {
          AGENT_ID: String(id),
          AGENT_NAME: name || '',
          ...(resolvedBackend === 'nemoclaw' && model ? { NEMOCLAW_MODEL: model } : {}),
          ...agentSecretEnvVars,
          ...integrationEnvVars,
          ...llmEnvVars,
        },
      });
    const timeoutPromise = new Promise((_, reject) => {
      provisionTimeoutHandle = setTimeout(() => {
        const timeoutError = new Error(
          `Provisioner create() timed out after ${PROVISION_TIMEOUT / 1000}s`
        );
        abortController.abort(timeoutError);
        reject(timeoutError);
      }, PROVISION_TIMEOUT);
    });
    const result = await Promise.race([
      createPromise,
      timeoutPromise,
    ]).finally(() => {
      if (provisionTimeoutHandle) {
        clearTimeout(provisionTimeoutHandle);
      }
    });
    containerId = result.containerId;
    host = result.host;
    gatewayToken = result.gatewayToken;
    containerName = result.containerName || container_name;
    gatewayHostPort = result.gatewayHostPort || null;
    runtimeHost = result.runtimeHost || null;
    runtimePort = result.runtimePort || null;
    gatewayHost = result.gatewayHost || null;
    gatewayPort = result.gatewayPort || null;

    // If network discovery failed, host may be "localhost" which is unreachable
    // from backend-api. Attempt to resolve the correct Compose network IP.
    if (host === "localhost" && containerId) {
      try {
        const Docker = require('dockerode');
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        const info = await docker.getContainer(containerId).inspect();
        const nets = info.NetworkSettings?.Networks || {};
        for (const [netName, netInfo] of Object.entries(nets)) {
          if (netName.endsWith('_default') && netInfo.IPAddress) {
            host = netInfo.IPAddress;
            console.log(`[provisioner] Resolved host via container inspect: ${host} (${netName})`);
            break;
          }
        }
      } catch (e) {
        console.warn(`[provisioner] Failed to resolve host from container networks: ${e.message}`);
      }
      // Last resort: use container name (Docker DNS resolves it on the compose network)
      if (host === "localhost" && containerName) {
        host = containerName;
        console.log(`[provisioner] Falling back to container name as host: ${host}`);
      }
    }
    if (!runtimeHost || runtimeHost === "localhost") {
      runtimeHost = host;
    }

    if (resolvedRuntimeFields.runtime_family === 'hermes') {
      const [migrationManifest, persistedHermesState] = await Promise.all([
        getMigrationManifestForAgent(id).catch(() => null),
        getPersistedHermesState(id).catch(() => ({ modelConfig: {}, channels: [] })),
      ]);

      const seedArchive = migrationManifest
        ? await buildHermesSeedArchive(migrationManifest).catch(() => null)
        : null;
      if (seedArchive && provisioner?.docker) {
        await provisioner.docker.getContainer(containerId).putArchive(seedArchive, {
          path: '/',
        });
      }

      if (
        hasMeaningfulHermesModelConfig(persistedHermesState?.modelConfig) ||
        (persistedHermesState?.channels || []).length > 0
      ) {
        await applyPersistedHermesState(
          {
            id,
            container_id: containerId,
            backend_type: resolvedBackend,
            runtime_family: 'hermes',
            deploy_target: 'docker',
            sandbox_profile: 'standard',
            host,
            runtime_host: runtimeHost,
            runtime_port: runtimePort,
            gateway_host_port: gatewayHostPort,
            gateway_host: gatewayHost,
            gateway_port: gatewayPort,
          },
          persistedHermesState,
          { restart: true }
        );
      }
    }
  } catch (err) {
    console.error(`[${resolvedBackend}] Provisioning failed for agent ${id} (attempt ${job.attemptsMade + 1}/${job.opts?.attempts || 1}):`, err.message);
    if (containerId) {
      try {
        await provisioner.destroy(containerId);
      } catch {
        // Best-effort cleanup only.
      }
    }
    // Mark as failed in DB
    await db.query("UPDATE agents SET status = 'error' WHERE id = $1", [id]);
    await db.query("UPDATE deployments SET status = 'failed' WHERE agent_id = $1", [id]);
    await db.query(
      "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
      ['agent_deploy_failed', `Agent "${name}" failed to deploy: ${err.message}`, JSON.stringify({ agentId: id, attempt: job.attemptsMade + 1 })]
    );
    throw err;
  }

  // Update agent with real container info
  try {
    await db.query(
      `UPDATE agents
          SET status = 'running',
              container_id = $2,
              host = $3,
              backend_type = $4,
              gateway_token = $5,
              container_name = COALESCE($6, container_name),
              gateway_host_port = $7,
              runtime_host = $8,
              runtime_port = $9,
              gateway_host = $10,
              gateway_port = $11,
              image = COALESCE($12, image),
              runtime_family = $13,
              deploy_target = $14,
              sandbox_profile = $15,
              sandbox_type = $16
        WHERE id = $1`,
      [
        id,
        containerId,
        host,
        resolvedRuntimeFields.backend_type,
        gatewayToken,
        containerName || null,
        gatewayHostPort ? parseInt(gatewayHostPort, 10) : null,
        runtimeHost || null,
        runtimePort ? parseInt(runtimePort, 10) : null,
        gatewayHost || null,
        gatewayPort ? parseInt(gatewayPort, 10) : null,
        resolvedImage || null,
        resolvedRuntimeFields.runtime_family,
        resolvedRuntimeFields.deploy_target,
        resolvedRuntimeFields.sandbox_profile,
        resolvedRuntimeFields.sandbox_type,
      ]
    );
    await db.query("UPDATE deployments SET status = 'completed' WHERE agent_id = $1", [id]);
    await db.query(
      "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
      ['agent_deployed', `Agent "${name}" is now running on ${resolvedBackend}`, JSON.stringify({ agentId: id, containerId, host })]
    );
    console.log(`Agent ${id} deployed: containerId=${containerId} host=${host}`);

    // Post-deploy readiness check: verify both the runtime sidecar and the gateway.
    // First boot may need time for npm installation and initial startup, so we allow
    // generous bounded retries and emit a warning state with explicit component detail.
    const readiness = await waitForAgentReadiness({
      host,
      runtimeHost,
      runtimePort,
      gatewayHost,
      gatewayHostPort,
      gatewayPort,
      checkGateway: resolvedRuntimeFields.runtime_family !== "hermes",
    });
    if (!readiness.ok) {
      const detail = buildReadinessWarningDetail(readiness);
      console.warn(`[provisioner] Readiness check failed for agent ${id}: ${detail}`);
      await persistReadinessWarning(db, { agentId: id, name, host, readiness });
    }

    // Fresh deploys should land with the current control-plane LLM credentials
    // and runtime model selection, not only the startup env captured earlier.
    if (userId && readiness.ok) {
      try {
        const authSyncResult = await reconcileRuntimeLlmAuth({
          agentId: id,
          userId,
          runtimeFamily: resolvedRuntimeFields.runtime_family,
          resolvedBackend,
          containerId,
          provisioner,
          host,
          runtimeHost,
          runtimePort,
          gatewayHostPort,
          gatewayHost,
          gatewayPort,
        });
        if (authSyncResult.status === 'synced') {
          console.log(`[provisioner] Post-deploy LLM auth sync completed for agent ${id}`);
        }
      } catch (e) {
        console.warn(`[provisioner] Failed to reconcile runtime LLM auth for agent ${id}:`, e.message);
      }
    }

    // Sync integrations to newly deployed agent container
    try {
      const intResult = await db.query(
        `SELECT i.id, i.provider, i.catalog_id, i.config, i.status,
                ic.name as catalog_name, ic.category as catalog_category,
                ic.auth_type, ic.config_schema
         FROM integrations i
         LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
         WHERE i.agent_id = $1 AND i.status = 'active'`,
        [id]
      );
      if (
        intResult.rows.length > 0 &&
        resolvedRuntimeFields.runtime_family === "openclaw"
      ) {
        const syncData = intResult.rows.map(buildIntegrationSyncEntry);
        const runtimeUrl = runtimeUrlForAgent({
          host,
          runtime_host: runtimeHost,
          runtime_port: runtimePort,
        }, "/integrations/sync");
        await fetch(runtimeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ integrations: syncData }),
        });
        console.log(`[provisioner] Synced ${syncData.length} integration(s) to agent ${id}`);
      }
    } catch (e) {
      console.warn(`[provisioner] Failed to sync integrations for agent ${id}:`, e.message);
    }
  } catch (err) {
    console.error('Failed to update agent status:', err.message);
    throw err;
  }
}, { connection, concurrency: DEPLOYMENT_WORKER_CONCURRENCY });

worker.on('failed', async (job, err) => {
  const attempts = job?.attemptsMade || 0;
  const maxAttempts = job?.opts?.attempts || 1;
  console.error(`Job ${job?.id} failed (attempt ${attempts}/${maxAttempts}): ${err.message}`);

  if (job && attempts >= maxAttempts) {
    // Final failure — job exhausted all retries, now in dead letter queue
    console.error(`[DLQ] Agent "${job.data.name}" (${job.data.id}) exhausted all ${maxAttempts} retry attempts`);
    try {
      await db.query(
        "INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)",
        ['agent_deploy_dlq', `Agent "${job.data.name}" exhausted all ${maxAttempts} retry attempts`, JSON.stringify({ agentId: job.data.id, error: err.message, jobId: job.id })]
      );
    } catch (dbErr) {
      console.error('[DLQ] Failed to log DLQ event:', dbErr.message);
    }
  }
});

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

// ── Health Check Server ──────────────────────────────────────────
const http = require('http');
const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || '4001');
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const isReady = worker.isRunning();
    res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isReady ? 'ok' : 'not_ready', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(HEALTH_PORT, () => {
  console.log(`Worker health check listening on port ${HEALTH_PORT}`);
});
