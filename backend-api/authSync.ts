// @ts-nocheck
// Syncs OpenClaw auth to running agents via the runtime sidecar.
// Writes the legacy auth-profiles.json file, imports API-key profiles into
// OpenClaw's per-agent SQLite auth store, then restarts the backend so the
// gateway process re-reads auth on startup (it does not hot-reload from disk).
// Called whenever LLM provider keys or LLM-relevant integrations change.

const db = require("./db");
const containerManager = require("./containerManager");
const llmProviders = require("./llmProviders");
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const { runtimeAuthHeaders } = require("./runtimeAuth");
const { waitForAgentReadiness } = require("./healthChecks");
const { resolveAgentRuntimeFamily } = require("./agentRuntimeFields");
const { shellSingleQuote } = require("../agent-runtime/lib/containerCommand");
const {
  buildOpenClawAuthProfilesWriteCommand,
  buildOpenClawConfigMergeCommand,
  buildOpenClawCustomProviders,
  buildOpenClawModelForProvider,
} = require("../agent-runtime/lib/runtimeBootstrap");
const { buildHermesRuntimeBootstrapEnv } = require("../agent-runtime/lib/hermesRuntimeBootstrap");
const { NEMOCLAW_DEFAULT_MODEL } = require("../agent-runtime/lib/nemoclawDefaults");

const providerCatalog = Array.isArray(llmProviders.PROVIDERS)
  ? llmProviders.PROVIDERS
  : typeof llmProviders.getAvailableProviders === "function"
    ? llmProviders.getAvailableProviders()
    : [];
const providerCatalogById = new Map(providerCatalog.map((provider) => [provider.id, provider]));
const LLM_ENV_VARS = new Set(providerCatalog.map((provider) => provider.envVar).filter(Boolean));

const PROVIDER_MODEL_DEFAULTS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.5",
  google: "gemini-3.1-pro-preview",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  deepseek: "deepseek-chat",
  openrouter: "openrouter/auto",
  together: "together/moonshotai/Kimi-K2.5",
  cohere: "command-r-plus",
  xai: "grok-4",
  nvidia: NEMOCLAW_DEFAULT_MODEL,
  moonshot: "kimi-k2.5",
  zai: "glm-5",
  minimax: "MiniMax-M2.7",
  // Bare deployment name — buildDefaultModelCommand prefixes it with the
  // OpenClaw provider id (azure-openai-responses) via buildOpenClawModelForProvider.
  "microsoft-foundry": "gpt-5.5-1",
};

const HERMES_NATIVE_PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({ provider: "anthropic" }),
  deepseek: Object.freeze({ provider: "deepseek" }),
  google: Object.freeze({ provider: "gemini" }),
  huggingface: Object.freeze({ provider: "huggingface" }),
  minimax: Object.freeze({ provider: "minimax" }),
  moonshot: Object.freeze({ provider: "kimi-coding" }),
  openrouter: Object.freeze({
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  }),
  xai: Object.freeze({ provider: "xai" }),
  zai: Object.freeze({ provider: "zai" }),
});

const HERMES_CUSTOM_PROVIDER_BASE_URLS = Object.freeze({
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openai: "https://api.openai.com/v1",
  together: "https://api.together.xyz/v1",
});

const CONTAINER_EXEC_AUTH_FALLBACK_BACKENDS = new Set(["docker", "proxmox"]);

function normalizeProviderConfig(config) {
  if (!config) return {};
  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === "object" && !Array.isArray(config) ? config : {};
}

function pickProviderBaseUrl(config = {}) {
  for (const key of ["base_url", "baseUrl", "endpoint", "url"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function getProviderEnvVar(providerId) {
  return providerCatalogById.get(providerId)?.envVar || "";
}

function normalizeUrlForCompare(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function resolveHermesModelApiKey(defaultProvider = null, envVars = {}) {
  const providerId = String(defaultProvider?.provider || "").trim();
  const envVar = getProviderEnvVar(providerId);
  return envVar && envVars?.[envVar] ? String(envVars[envVar]) : "";
}

function attachHermesCustomApiKey(modelConfig = null, defaultProvider = null, envVars = {}) {
  if (!modelConfig || String(modelConfig.provider || "").trim() !== "custom") return modelConfig;

  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  if (!apiKey) return modelConfig;

  const defaultBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);
  const modelBaseUrl = String(modelConfig.baseUrl || "").trim();
  if (
    modelBaseUrl &&
    defaultBaseUrl &&
    normalizeUrlForCompare(modelBaseUrl) !== normalizeUrlForCompare(defaultBaseUrl)
  ) {
    return modelConfig;
  }

  return { ...modelConfig, apiKey };
}

function resolveHermesProviderBaseUrl(defaultProvider = null) {
  if (!defaultProvider) return "";
  const providerId = String(defaultProvider.provider || "").trim();
  if (!providerId) return "";

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  const catalogBaseUrl =
    typeof providerCatalogById.get(providerId)?.endpoint === "string"
      ? providerCatalogById.get(providerId).endpoint.trim()
      : "";

  return savedBaseUrl || catalogBaseUrl || HERMES_CUSTOM_PROVIDER_BASE_URLS[providerId] || "";
}

function buildHermesModelConfig(defaultProvider = null, envVars = {}) {
  if (!defaultProvider) return null;

  const providerId = String(defaultProvider.provider || "").trim();
  if (!providerId) {
    throw new Error("Default LLM provider is missing a provider id");
  }

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  const modelId =
    typeof defaultProvider.model === "string" && defaultProvider.model.trim()
      ? defaultProvider.model.trim()
      : PROVIDER_MODEL_DEFAULTS[providerId];

  if (!modelId) {
    throw new Error(`Default provider ${providerId} needs a saved model before Hermes can use it`);
  }

  const nativeProvider = HERMES_NATIVE_PROVIDER_MAP[providerId];
  if (nativeProvider) {
    return {
      provider: nativeProvider.provider,
      defaultModel: modelId,
      baseUrl: nativeProvider.baseUrl || savedBaseUrl || null,
    };
  }

  const resolvedBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);

  if (!resolvedBaseUrl) {
    throw new Error(`Provider ${providerId} needs a base URL before Hermes can use it`);
  }

  const modelConfig = {
    provider: "custom",
    defaultModel: modelId,
    baseUrl: resolvedBaseUrl,
  };
  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  return apiKey ? { ...modelConfig, apiKey } : modelConfig;
}

function hasMeaningfulHermesModelConfig(modelConfig = {}) {
  return Boolean(
    String(modelConfig?.defaultModel || "").trim() ||
    String(modelConfig?.provider || "").trim() ||
    String(modelConfig?.baseUrl || "").trim(),
  );
}

/**
 * Build auth-profiles.json content for a specific agent.
 * Merges per-user LLM provider keys with per-agent integration tokens
 * that overlap with LLM auth env vars (e.g., HF_TOKEN, OPENAI_API_KEY).
 * Explicit LLM provider keys always take precedence over integration tokens.
 */
async function buildAuthProfilesForAgent(userId, agentId) {
  const llmKeys = await llmProviders.getProviderKeys(userId);
  const overrides =
    typeof llmProviders.getProviderEndpoints === "function"
      ? await llmProviders.getProviderEndpoints(userId)
      : { byEnvVar: {}, byProvider: {}, apiVersionByEnvVar: {}, apiVersionByProvider: {} };

  try {
    const { getIntegrationEnvVars } = require("./integrations");
    const integrationEnvVars = await getIntegrationEnvVars(agentId);
    const integrationLlmKeys = {};
    for (const [envVar, value] of Object.entries(integrationEnvVars)) {
      if (LLM_ENV_VARS.has(envVar)) {
        integrationLlmKeys[envVar] = value;
      }
    }
    // LLM provider keys win over integration-sourced tokens for the same env var
    return llmProviders.buildAuthProfiles(
      { ...integrationLlmKeys, ...llmKeys },
      overrides.byProvider || {},
      overrides.apiVersionByProvider || {},
    );
  } catch {
    return llmProviders.buildAuthProfiles(
      llmKeys,
      overrides.byProvider || {},
      overrides.apiVersionByProvider || {},
    );
  }
}

async function buildHermesManagedEnvForAgent(userId, agentId) {
  const llmKeys = await llmProviders.getProviderKeys(userId);
  const overrides =
    typeof llmProviders.getProviderEndpoints === "function"
      ? await llmProviders.getProviderEndpoints(userId)
      : { byEnvVar: {}, byProvider: {}, apiVersionByEnvVar: {}, apiVersionByProvider: {} };
  const baseUrlEnvVars =
    typeof llmProviders.buildBaseUrlEnvVars === "function"
      ? llmProviders.buildBaseUrlEnvVars(overrides.byEnvVar || {})
      : {};
  const apiVersionEnvVars =
    typeof llmProviders.buildApiVersionEnvVars === "function"
      ? llmProviders.buildApiVersionEnvVars(overrides.apiVersionByEnvVar || {})
      : {};

  try {
    const { getIntegrationEnvVars } = require("./integrations");
    const integrationEnvVars = await getIntegrationEnvVars(agentId);
    return Object.fromEntries(
      Object.entries({
        ...integrationEnvVars,
        ...llmKeys,
        ...baseUrlEnvVars,
        ...apiVersionEnvVars,
      }).filter(([key, value]) => key && value != null && String(value) !== ""),
    );
  } catch {
    return Object.fromEntries(
      Object.entries({ ...llmKeys, ...baseUrlEnvVars, ...apiVersionEnvVars }).filter(
        ([key, value]) => key && value != null && String(value) !== "",
      ),
    );
  }
}

function buildAuthProfilesWriteCommand(authProfiles) {
  return buildOpenClawAuthProfilesWriteCommand(authProfiles);
}

function buildDefaultModelCommand(defaultProvider = null) {
  const fullModel = buildDefaultOpenClawModel(defaultProvider);
  if (!fullModel) return null;

  return (
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"; ' +
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi; ' +
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] || exit 127; ' +
    `exec "$OPENCLAW_BIN" ${["models", "set", fullModel]
      .map((arg) => JSON.stringify(String(arg)))
      .join(" ")}`
  );
}

function buildDefaultOpenClawModel(defaultProvider = null) {
  if (!defaultProvider) return null;

  const modelId = defaultProvider.model || PROVIDER_MODEL_DEFAULTS[defaultProvider.provider];
  if (!modelId) return null;

  return buildOpenClawModelForProvider(defaultProvider.provider, modelId);
}

function buildCustomProviderEnv(baseEnv = {}, defaultProvider = null) {
  const providerId = String(defaultProvider?.provider || "").trim();
  if (providerId !== "microsoft-foundry") return baseEnv;

  const fullModel = buildDefaultOpenClawModel(defaultProvider);
  const deployment = String(defaultProvider?.model || "").trim();
  return {
    ...baseEnv,
    ...(deployment ? { MICROSOFT_FOUNDRY_DEPLOYMENT: deployment } : {}),
    ...(fullModel ? { NORA_DEFAULT_OPENCLAW_MODEL: fullModel } : {}),
  };
}

function escapeDotenvValue(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"')}"`;
}

function buildHermesEnvWriteCommand(envVars = {}) {
  const managedBlock = Object.entries(envVars)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeDotenvValue(value)}`)
    .join("\n");
  const blockB64 = Buffer.from(managedBlock).toString("base64");

  return [
    "set -eu",
    'start_marker="# >>> NORA MANAGED ENV >>>"',
    'end_marker="# <<< NORA MANAGED ENV <<<"',
    'tmp_file="$(mktemp)"',
    "if [ -f /opt/data/.env ]; then",
    '  awk -v start="$start_marker" -v end="$end_marker" \'BEGIN{skip=0} $0==start {skip=1; next} $0==end {skip=0; next} !skip {print}\' /opt/data/.env > "$tmp_file"',
    "else",
    '  : > "$tmp_file"',
    "fi",
    'if [ -s "$tmp_file" ]; then printf \'\\n\' >> "$tmp_file"; fi',
    'printf \'%s\\n\' "$start_marker" >> "$tmp_file"',
    `printf '%s' ${shellSingleQuote(blockB64)} | base64 -d >> "$tmp_file"`,
    "printf '\\n' >> \"$tmp_file\"",
    'printf \'%s\\n\' "$end_marker" >> "$tmp_file"',
    'chown hermes:hermes "$tmp_file" 2>/dev/null || true',
    'chmod 0600 "$tmp_file"',
    'mv "$tmp_file" /opt/data/.env',
    "chown hermes:hermes /opt/data/.env 2>/dev/null || true",
    "chmod 0600 /opt/data/.env",
  ].join("\n");
}

async function runRuntimeCommand(agent, command, { timeout = 30000 } = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("Agent runtime endpoint unavailable");
  }

  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
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
    throw new Error(
      payload.stderr || payload.stdout || `Runtime command exited with code ${payload.exitCode}`,
    );
  }

  return payload;
}

async function runContainerCommand(agent, command, { timeout = 30000 } = {}) {
  const execResult = await containerManager.exec(agent, {
    cmd: ["/bin/sh", "-lc", command],
    tty: true,
    env: [],
  });
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error("Container exec unavailable");
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
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    execResult.stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    execResult.stream.on("end", finish);
    execResult.stream.on("close", finish);
    execResult.stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  const inspectResult = await execResult.exec.inspect();
  const exitCode = inspectResult?.ExitCode ?? 0;
  if (exitCode !== 0) {
    const error = new Error(output.trim() || `Container command exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.output = output;
    throw error;
  }

  return { exitCode, output };
}

async function writeAuthToContainer(agent, authProfiles) {
  const command = buildAuthProfilesWriteCommand(authProfiles);
  try {
    return await runRuntimeCommand(agent, command);
  } catch (error) {
    const backendType = String(agent?.backend_type || "")
      .trim()
      .toLowerCase();
    if (!CONTAINER_EXEC_AUTH_FALLBACK_BACKENDS.has(backendType)) {
      throw error;
    }
    return runContainerCommand(agent, command);
  }
}

async function writeHermesEnvToContainer(agent, envVars) {
  if (
    typeof containerManager.isKubernetesAgent === "function" &&
    containerManager.isKubernetesAgent(agent)
  ) {
    return containerManager.updateEnv(agent, {
      ...envVars,
      ...buildHermesRuntimeBootstrapEnv({ envVars }),
    });
  }
  return runContainerCommand(agent, buildHermesEnvWriteCommand(envVars));
}

function pickDockerComposeNetworkAddress(info = {}) {
  const networks = info?.NetworkSettings?.Networks || {};
  for (const [name, network] of Object.entries(networks)) {
    if (name.endsWith("_default") && network?.IPAddress) {
      return network.IPAddress;
    }
  }
  for (const [name, network] of Object.entries(networks)) {
    if (name !== "bridge" && network?.IPAddress) {
      return network.IPAddress;
    }
  }
  return info?.NetworkSettings?.IPAddress || "";
}

async function refreshDockerRuntimeAddress(agent) {
  const backendType = String(agent?.backend_type || "")
    .trim()
    .toLowerCase();
  if (backendType !== "docker" || !agent?.container_id || !agent?.id) return null;

  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const info = await docker.getContainer(agent.container_id).inspect();
    const host = pickDockerComposeNetworkAddress(info);
    if (!host) return null;

    agent.host = host;
    agent.runtime_host = host;
    await db.query("UPDATE agents SET host = $2, runtime_host = $2 WHERE id = $1", [
      agent.id,
      host,
    ]);
    return host;
  } catch (error) {
    console.warn(
      `[authSync] Failed to refresh Docker runtime host for agent ${agent.id}:`,
      error.message,
    );
    return null;
  }
}

async function restartAgentAndRefreshAddress(agent) {
  const result = await containerManager.restart(agent);
  await refreshDockerRuntimeAddress(agent);
  return result;
}

/**
 * Sync OpenClaw auth to all running agents of a user.
 * If agentId is provided, syncs only that agent.
 *
 * Returns an array of { agentId, status, error? } results.
 * Non-blocking safe: failures per-agent are logged but do not throw.
 */
async function syncAuthToUserAgents(userId, agentId = null, options = {}) {
  const onlyIfAuthPresent = Boolean(options?.onlyIfAuthPresent);
  const defaultRow = await db.query(
    "SELECT id, provider, model, config FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1",
    [userId],
  );
  const defaultProvider = defaultRow.rows[0] || null;
  const modelCommand = buildDefaultModelCommand(defaultProvider);
  let hermesModelConfig = null;
  let hasHermesModelConfig = false;

  const agentQuery = agentId
    ? `SELECT id, container_id, backend_type, runtime_family, deploy_target,
              execution_target_id,
              sandbox_profile, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE id = $1 AND user_id = $2 AND status IN ('running', 'warning') AND container_id IS NOT NULL`
    : `SELECT id, container_id, backend_type, runtime_family, deploy_target,
              execution_target_id,
              sandbox_profile, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE user_id = $1 AND status IN ('running', 'warning') AND container_id IS NOT NULL`;
  const agentParams = agentId ? [agentId, userId] : [userId];
  const agents = await db.query(agentQuery, agentParams);

  // Evict stale gateway connections — the restart will invalidate them
  let evictConnection;
  try {
    evictConnection = require("./gatewayProxy").evictConnection;
  } catch {
    /* gatewayProxy not available in worker context */
  }

  const results = [];
  for (const agent of agents.rows) {
    try {
      const runtimeFamily = resolveAgentRuntimeFamily(agent);
      // Evict the cached WS connection before restarting so the proxy
      // creates a fresh one on the next request instead of hitting the circuit breaker
      if (evictConnection) {
        evictConnection(agent);
      }
      if (runtimeFamily === "hermes") {
        let persistedModelConfig = null;
        try {
          const { getPersistedHermesState } = require("./hermesUi");
          const persistedState = await getPersistedHermesState(agent.id);
          if (hasMeaningfulHermesModelConfig(persistedState?.modelConfig)) {
            persistedModelConfig = persistedState.modelConfig;
          }
        } catch {
          persistedModelConfig = null;
        }

        const envVars = await buildHermesManagedEnvForAgent(userId, agent.id);
        if (!persistedModelConfig && !hasHermesModelConfig) {
          hermesModelConfig = buildHermesModelConfig(defaultProvider, envVars);
          hasHermesModelConfig = true;
        }
        const selectedHermesModelConfig = persistedModelConfig
          ? attachHermesCustomApiKey(persistedModelConfig, defaultProvider, envVars)
          : hermesModelConfig;
        if (
          onlyIfAuthPresent &&
          Object.keys(envVars).length === 0 &&
          !persistedModelConfig &&
          !hermesModelConfig
        ) {
          results.push({ agentId: agent.id, status: "skipped" });
          continue;
        }
        if (selectedHermesModelConfig) {
          const { persistHermesModelConfig } = require("./hermesUi");
          await persistHermesModelConfig(agent, selectedHermesModelConfig);
        }
        await writeHermesEnvToContainer(agent, envVars);
        await restartAgentAndRefreshAddress(agent);
        const readiness = await waitForAgentReadiness({
          host: agent.host,
          runtimeHost: agent.runtime_host,
          runtimePort: agent.runtime_port,
          gatewayHostPort: agent.gateway_host_port,
          gatewayHost: agent.gateway_host,
          gatewayPort: agent.gateway_port,
          checkGateway: false,
        });
        if (!readiness.ok) {
          throw new Error(
            `Agent runtime did not recover after env sync restart (${readiness.runtime?.error || "unreachable"})`,
          );
        }

        console.log(
          `[authSync] Synced Hermes env + model config to agent ${agent.id} (backend restarted)`,
        );
        results.push({ agentId: agent.id, status: "synced" });
        continue;
      }

      const authProfiles = await buildAuthProfilesForAgent(userId, agent.id);
      if (onlyIfAuthPresent && Object.keys(authProfiles).length === 0 && !modelCommand) {
        results.push({ agentId: agent.id, status: "skipped" });
        continue;
      }
      await writeAuthToContainer(agent, authProfiles);

      // Merge custom-provider registrations (Foundry → azure-openai-responses)
      // into openclaw.json before restart so `<provider>/<deployment>` model
      // strings resolve instead of throwing "Unknown model".
      const llmKeysForCustom = await llmProviders.getProviderKeys(userId);
      const endpointOverrides =
        typeof llmProviders.getProviderEndpoints === "function"
          ? await llmProviders.getProviderEndpoints(userId)
          : { byEnvVar: {} };
      // byEnvVar is keyed by API_KEY env var; transform to {PROVIDER}_BASE_URL.
      const baseUrlEnvVars =
        typeof llmProviders.buildBaseUrlEnvVars === "function"
          ? llmProviders.buildBaseUrlEnvVars(endpointOverrides.byEnvVar || {})
          : {};
      // Carry the deployment too so the re-merged Foundry model registry keeps
      // the configured deployment (e.g. gpt-5.5-1) and doesn't revert to the
      // hardcoded fallback, which would resurface "Unknown model".
      const deploymentEnvVars =
        typeof llmProviders.buildDeploymentEnvVars === "function"
          ? llmProviders.buildDeploymentEnvVars(endpointOverrides.deploymentByEnvVar || {})
          : {};
      const customProviderEnv = buildCustomProviderEnv(
        { ...llmKeysForCustom, ...baseUrlEnvVars, ...deploymentEnvVars },
        defaultProvider,
      );
      const customProviders = buildOpenClawCustomProviders(customProviderEnv);
      if (Object.keys(customProviders).length > 0) {
        const providerMergeCommand = buildOpenClawConfigMergeCommand({
          models: { providers: customProviders },
        });
        try {
          await runRuntimeCommand(agent, providerMergeCommand);
        } catch (error) {
          if (
            !CONTAINER_EXEC_AUTH_FALLBACK_BACKENDS.has(
              String(agent?.backend_type || "")
                .trim()
                .toLowerCase(),
            )
          ) {
            throw error;
          }
          await runContainerCommand(agent, providerMergeCommand);
        }
      }

      await restartAgentAndRefreshAddress(agent);

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
          `Agent runtime did not recover after auth sync restart (${readiness.runtime?.error || readiness.gateway?.error || "unreachable"})`,
        );
      }

      if (modelCommand) {
        await runRuntimeCommand(agent, modelCommand, { timeout: 60000 });
      }

      console.log(`[authSync] Synced OpenClaw auth to agent ${agent.id} (backend restarted)`);
      results.push({ agentId: agent.id, status: "synced" });
    } catch (e) {
      console.warn(`[authSync] Failed for agent ${agent.id}:`, e.message);
      results.push({ agentId: agent.id, status: "failed", error: e.message });
    }
  }
  return results;
}

module.exports = {
  syncAuthToUserAgents,
  buildAuthProfilesForAgent,
  buildAuthProfilesWriteCommand,
  buildDefaultModelCommand,
  buildHermesModelConfig,
  buildHermesEnvWriteCommand,
  buildHermesManagedEnvForAgent,
  runRuntimeCommand,
  runContainerCommand,
  writeAuthToContainer,
  writeHermesEnvToContainer,
};
