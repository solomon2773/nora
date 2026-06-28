// @ts-nocheck
// LLM Provider key management — encrypted storage of user API keys

const db = require("./db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("./crypto");
const { DEMO_PROVIDER_ID, DEMO_MODEL_ID, deriveDemoToken, demoLlmBaseUrl } = require("./demoLlm");
const { NEMOCLAW_DEFAULT_MODEL } = require("../agent-runtime/lib/nemoclawDefaults");

// Approved LLM providers and their env var names
// Models updated per https://docs.openclaw.ai/providers (April 2026)
const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    models: ["claude-opus-4-6", "claude-sonnet-4-5"],
  },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", models: ["gpt-5.5", "gpt-5.5-pro"] },
  {
    id: "google",
    name: "Google (Gemini)",
    envVar: "GEMINI_API_KEY",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"],
  },
  {
    id: "groq",
    name: "Groq",
    envVar: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  },
  { id: "mistral", name: "Mistral", envVar: "MISTRAL_API_KEY", models: ["mistral-large-latest"] },
  {
    id: "deepseek",
    name: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", models: [] },
  { id: "together", name: "Together AI", envVar: "TOGETHER_API_KEY", models: [] },
  {
    id: "cohere",
    name: "Cohere",
    envVar: "COHERE_API_KEY",
    models: ["command-r-plus", "command-r"],
  },
  {
    id: "xai",
    name: "xAI",
    envVar: "XAI_API_KEY",
    models: ["grok-4", "grok-4-0709", "grok-3", "grok-3-fast"],
  },
  { id: "moonshot", name: "Moonshot AI", envVar: "MOONSHOT_API_KEY", models: ["kimi-k2.5"] },
  { id: "zai", name: "Z.AI", envVar: "ZAI_API_KEY", models: ["glm-5"] },
  { id: "ollama", name: "Ollama", envVar: "OLLAMA_API_KEY", models: [] },
  { id: "minimax", name: "MiniMax", envVar: "MINIMAX_API_KEY", models: ["MiniMax-M2.7"] },
  { id: "github-copilot", name: "GitHub Copilot", envVar: "COPILOT_GITHUB_TOKEN", models: [] },
  { id: "huggingface", name: "Hugging Face (Inference)", envVar: "HF_TOKEN", models: [] },
  { id: "cerebras", name: "Cerebras", envVar: "CEREBRAS_API_KEY", models: [] },
  {
    id: "nvidia",
    name: "NVIDIA",
    envVar: "NVIDIA_API_KEY",
    endpoint: "https://integrate.api.nvidia.com/v1",
    models: [
      NEMOCLAW_DEFAULT_MODEL,
      "nvidia/moonshotai/kimi-k2.5",
      "nvidia/minimaxai/minimax-m2.5",
      "nvidia/z-ai/glm5",
    ],
  },
  // Microsoft Foundry hosts models from OpenAI, Microsoft (Phi), Meta (Llama), Mistral, DeepSeek, Cohere, and AI21
  // behind an OpenAI-compatible inference endpoint. The `model` value at request time is the user's *deployment
  // name* in their Foundry resource — the list below is a curated set of common deployment ids users can pick
  // as a starting point. Foundry endpoints are per-resource (e.g., https://<resource>.services.ai.azure.com/openai/v1/),
  // so users MUST provide their base URL via the saved provider config (`config.base_url`). The shared
  // https://models.inference.ai.azure.com URL is GitHub Models (GitHub PAT auth, free tier) — not a generic
  // Foundry URL — so the catalog ships no default `endpoint` here. See:
  //   https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/endpoints
  {
    id: "microsoft-foundry",
    name: "Microsoft Foundry",
    envVar: "MICROSOFT_FOUNDRY_API_KEY",
    requiresBaseUrl: true,
    baseUrlPlaceholder: "https://<resource>.services.ai.azure.com/openai/v1/",
    supportsApiVersion: true,
    apiVersionPlaceholder: "2024-10-21",
    models: [
      "gpt-5.5-1",
      "gpt5.5-1",
      "gpt-5.5",
      "gpt-5.5-mini",
      "o3",
      "Phi-4",
      "Phi-4-mini",
      "Meta-Llama-3.1-405B-Instruct",
      "Meta-Llama-3.1-70B-Instruct",
      "Mistral-Large-2411",
      "Codestral-2501",
      "DeepSeek-V3",
      "DeepSeek-R1",
      "Cohere-command-r-plus-08-2024",
      "AI21-Jamba-1.5-Large",
    ],
  },
  {
    // Zero-key demo: a deterministic stub served by this control plane. No
    // user key — addProvider derives the token + in-network base URL itself.
    // Deliberately LAST so key-based providers stay first in pickers.
    id: DEMO_PROVIDER_ID,
    name: "Demo (built-in, no key required)",
    envVar: "NORA_DEMO_LLM_TOKEN",
    requiresApiKey: false,
    models: [DEMO_MODEL_ID],
  },
];

function getAvailableProviders() {
  return PROVIDERS.map(
    ({
      id,
      name,
      models,
      requiresApiKey,
      requiresBaseUrl,
      baseUrlPlaceholder,
      supportsApiVersion,
      apiVersionPlaceholder,
    }) => ({
      id,
      name,
      models,
      ...(requiresApiKey === false ? { requiresApiKey: false } : {}),
      ...(requiresBaseUrl ? { requiresBaseUrl: true } : {}),
      ...(baseUrlPlaceholder ? { baseUrlPlaceholder } : {}),
      ...(supportsApiVersion ? { supportsApiVersion: true } : {}),
      ...(apiVersionPlaceholder ? { apiVersionPlaceholder } : {}),
    }),
  );
}

function getProviderEnvVar(providerId) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  return p ? p.envVar : null;
}

/** Mask an API key for safe display: keep first 4 and last 4 chars */
function maskKey(key) {
  if (!key || key.length < 12) return "••••••••";
  return key.slice(0, 4) + "••••••••" + key.slice(-4);
}

// ── CRUD ─────────────────────────────────────────────────

async function listProviders(userId) {
  const result = await db.query(
    "SELECT id, user_id, provider, api_key, model, config, is_default, created_at FROM llm_providers WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  return result.rows.map((row) => {
    let masked;
    try {
      masked = maskKey(decrypt(row.api_key));
    } catch (err) {
      console.warn(
        `[llmProviders] Cannot decrypt key for provider ${row.provider} (user ${row.user_id}): ${err.message}`,
      );
      masked = "⚠ unreadable";
    }
    return {
      ...row,
      api_key_masked: masked,
      api_key: undefined, // never return raw key
    };
  });
}

async function addProvider(userId, provider, apiKey, model, config = {}) {
  if (!PROVIDERS.find((p) => p.id === provider)) {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  if (provider === DEMO_PROVIDER_ID) {
    // Zero-key path: the token is derived (not user secret material) and the
    // base URL points at this control plane's stub as reachable from agent
    // containers. Deliberately no ensureEncryptionConfigured — the demo must
    // work on a fresh install before any secrets are set up.
    apiKey = deriveDemoToken();
    model = model || DEMO_MODEL_ID;
    config = { ...config, baseUrl: demoLlmBaseUrl() };
  } else {
    if (!apiKey) throw new Error("API key is required");
    ensureEncryptionConfigured("LLM provider credential storage");
  }
  const encryptedKey = encrypt(apiKey);

  // If no other providers exist for this user, make it default
  const existing = await db.query("SELECT COUNT(*) FROM llm_providers WHERE user_id = $1", [
    userId,
  ]);
  const isDefault = parseInt(existing.rows[0].count) === 0;

  const result = await db.query(
    `INSERT INTO llm_providers(user_id, provider, api_key, model, config, is_default)
     VALUES($1, $2, $3, $4, $5, $6) RETURNING id, provider, model, is_default, created_at`,
    [userId, provider, encryptedKey, model || null, JSON.stringify(config), isDefault],
  );
  return result.rows[0];
}

async function updateProvider(id, userId, updates) {
  const sets = [];
  const params = [];
  let idx = 1;

  if (updates.apiKey) {
    ensureEncryptionConfigured("LLM provider credential storage");
    sets.push(`api_key = $${idx++}`);
    params.push(encrypt(updates.apiKey));
  }
  if (updates.model !== undefined) {
    sets.push(`model = $${idx++}`);
    params.push(updates.model);
  }
  if (updates.config !== undefined) {
    sets.push(`config = $${idx++}`);
    params.push(JSON.stringify(updates.config));
  }
  if (updates.is_default !== undefined) {
    // If setting as default, unset all others first
    if (updates.is_default) {
      await db.query("UPDATE llm_providers SET is_default = false WHERE user_id = $1", [userId]);
    }
    sets.push(`is_default = $${idx++}`);
    params.push(updates.is_default);
  }

  if (sets.length === 0) throw new Error("No fields to update");

  params.push(id, userId);
  const result = await db.query(
    `UPDATE llm_providers SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING id, provider, model, is_default`,
    params,
  );
  if (result.rows.length === 0) throw new Error("Provider not found");
  return result.rows[0];
}

async function deleteProvider(id, userId) {
  const result = await db.query(
    "DELETE FROM llm_providers WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, userId],
  );
  if (result.rows.length === 0) throw new Error("Provider not found");
  return { success: true };
}

/**
 * Get decrypted keys for all providers of a user — internal use only.
 * Returns a map of { envVarName: decryptedKey } for container injection.
 */
async function getProviderKeys(userId) {
  const result = await db.query("SELECT provider, api_key FROM llm_providers WHERE user_id = $1", [
    userId,
  ]);
  const keys = {};
  for (const row of result.rows) {
    const envVar = getProviderEnvVar(row.provider);
    if (envVar && row.api_key) {
      keys[envVar] = decrypt(row.api_key);
    }
  }
  return keys;
}

function parseProviderConfig(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function pickConfigBaseUrl(config) {
  if (!config) return "";
  for (const key of ["base_url", "baseUrl", "endpoint", "url"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickConfigApiVersion(config) {
  if (!config) return "";
  for (const key of ["api_version", "apiVersion"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// Azure deployment name (arbitrary per resource). Prefer an explicit config
// field; fall back to the provider row's `model` column.
function pickConfigDeployment(config, model) {
  if (config) {
    for (const key of ["deployment", "deployment_name", "deploymentName"]) {
      const value = config[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return typeof model === "string" ? model.trim() : "";
}

/**
 * Return per-user provider config overrides keyed by env var and provider id.
 * Used to inject {PROVIDER}_BASE_URL / {PROVIDER}_API_VERSION into containers
 * and to write `endpoint` / `api_version` fields into OpenClaw's auth-profiles.json.
 */
async function getProviderEndpoints(userId) {
  const result = await db.query(
    "SELECT provider, model, config FROM llm_providers WHERE user_id = $1",
    [userId],
  );
  const byEnvVar = {};
  const byProvider = {};
  const apiVersionByEnvVar = {};
  const apiVersionByProvider = {};
  const deploymentByEnvVar = {};
  const deploymentByProvider = {};
  for (const row of result.rows) {
    const envVar = getProviderEnvVar(row.provider);
    if (!envVar) continue;
    const config = parseProviderConfig(row.config);
    const baseUrl = pickConfigBaseUrl(config);
    const apiVersion = pickConfigApiVersion(config);
    if (baseUrl) {
      byEnvVar[envVar] = baseUrl;
      byProvider[row.provider] = baseUrl;
    }
    if (apiVersion) {
      apiVersionByEnvVar[envVar] = apiVersion;
      apiVersionByProvider[row.provider] = apiVersion;
    }
    // Foundry deployment names are arbitrary per Azure resource — surface the
    // saved deployment so the runtime registers + defaults to the right one.
    if (row.provider === "microsoft-foundry") {
      const deployment = pickConfigDeployment(config, row.model);
      if (deployment) {
        deploymentByEnvVar[envVar] = deployment;
        deploymentByProvider[row.provider] = deployment;
      }
    }
  }
  return {
    byEnvVar,
    byProvider,
    apiVersionByEnvVar,
    apiVersionByProvider,
    deploymentByEnvVar,
    deploymentByProvider,
  };
}

/**
 * Derive {PROVIDER}_BASE_URL env vars from per-user endpoint overrides.
 * Mirrors how the API key flows in as {PROVIDER}_API_KEY.
 */
function buildBaseUrlEnvVars(endpointsByEnvVar = {}) {
  const out = {};
  for (const [keyEnvVar, baseUrl] of Object.entries(endpointsByEnvVar)) {
    if (!baseUrl) continue;
    const baseUrlEnvVar = keyEnvVar.replace(/_API_KEY$|_TOKEN$/, "_BASE_URL");
    if (baseUrlEnvVar && baseUrlEnvVar !== keyEnvVar) {
      out[baseUrlEnvVar] = baseUrl;
    }
  }
  return out;
}

/**
 * Derive {PROVIDER}_API_VERSION env vars from per-user api-version overrides.
 */
function buildApiVersionEnvVars(apiVersionsByEnvVar = {}) {
  const out = {};
  for (const [keyEnvVar, apiVersion] of Object.entries(apiVersionsByEnvVar)) {
    if (!apiVersion) continue;
    const apiVersionEnvVar = keyEnvVar.replace(/_API_KEY$|_TOKEN$/, "_API_VERSION");
    if (apiVersionEnvVar && apiVersionEnvVar !== keyEnvVar) {
      out[apiVersionEnvVar] = apiVersion;
    }
  }
  return out;
}

/**
 * Derive {PROVIDER}_DEPLOYMENT env vars from per-user deployment overrides.
 * Today only Microsoft Foundry uses this (Azure deployment names are arbitrary
 * per resource); buildOpenClawCustomProviders reads MICROSOFT_FOUNDRY_DEPLOYMENT.
 */
function buildDeploymentEnvVars(deploymentsByEnvVar = {}) {
  const out = {};
  for (const [keyEnvVar, deployment] of Object.entries(deploymentsByEnvVar)) {
    if (!deployment) continue;
    const deploymentEnvVar = keyEnvVar.replace(/_API_KEY$|_TOKEN$/, "_DEPLOYMENT");
    if (deploymentEnvVar && deploymentEnvVar !== keyEnvVar) {
      out[deploymentEnvVar] = deployment;
    }
  }
  return out;
}

/**
 * Build the auth-profiles.json content that openclaw expects.
 * Maps provider keys to the persisted OpenClaw auth profile store format.
 */
function buildAuthProfiles(
  providerKeys,
  endpointOverridesByProvider = {},
  apiVersionOverridesByProvider = {},
) {
  const profiles = {};
  const order = {};
  const lastGood = {};
  const envToProvider = {};
  const catalogEndpoint = {};
  for (const p of PROVIDERS) {
    envToProvider[p.envVar] = p.id;
    if (typeof p.endpoint === "string" && p.endpoint.trim()) {
      catalogEndpoint[p.id] = p.endpoint.trim();
    }
  }
  for (const [envVar, key] of Object.entries(providerKeys)) {
    const provider = envToProvider[envVar];
    if (provider && key) {
      const profileId = `${provider}:default`;
      // Per-user saved base URL wins over the catalog default. For providers like
      // Microsoft Foundry there is no catalog default — the override is the only source.
      const endpoint = endpointOverridesByProvider[provider] || catalogEndpoint[provider] || "";
      const apiVersion = apiVersionOverridesByProvider[provider] || "";
      profiles[profileId] = {
        type: "api_key",
        provider,
        key,
        ...(endpoint ? { endpoint } : {}),
        ...(apiVersion ? { api_version: apiVersion } : {}),
      };
      order[provider] = [profileId];
      lastGood[provider] = profileId;
    }
  }
  return {
    version: 1,
    profiles,
    ...(Object.keys(order).length > 0 ? { order } : {}),
    ...(Object.keys(lastGood).length > 0 ? { lastGood } : {}),
  };
}

module.exports = {
  getAvailableProviders,
  getProviderEnvVar,
  listProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getProviderKeys,
  getProviderEndpoints,
  buildBaseUrlEnvVars,
  buildApiVersionEnvVars,
  buildDeploymentEnvVars,
  buildAuthProfiles,
  PROVIDERS,
};
