// LLM Provider key management — encrypted storage of user API keys

const db = require("./db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("./crypto");

// Approved LLM providers and their env var names
// Models updated per https://docs.openclaw.ai/providers (April 2026)
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", models: ["claude-opus-4-6", "claude-sonnet-4-5"] },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", models: ["gpt-5.4", "gpt-5.4-pro"] },
  { id: "google", name: "Google (Gemini)", envVar: "GEMINI_API_KEY", endpoint: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"] },
  { id: "groq", name: "Groq", envVar: "GROQ_API_KEY", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
  { id: "mistral", name: "Mistral", envVar: "MISTRAL_API_KEY", models: ["mistral-large-latest"] },
  { id: "deepseek", name: "DeepSeek", envVar: "DEEPSEEK_API_KEY", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", models: [] },
  { id: "together", name: "Together AI", envVar: "TOGETHER_API_KEY", models: [] },
  { id: "cohere", name: "Cohere", envVar: "COHERE_API_KEY", models: ["command-r-plus", "command-r"] },
  { id: "xai", name: "xAI", envVar: "XAI_API_KEY", models: ["grok-4", "grok-4-0709", "grok-3", "grok-3-fast"] },
  { id: "moonshot", name: "Moonshot AI", envVar: "MOONSHOT_API_KEY", models: ["kimi-k2.5"] },
  { id: "zai", name: "Z.AI", envVar: "ZAI_API_KEY", models: ["glm-5"] },
  { id: "ollama", name: "Ollama", envVar: "OLLAMA_API_KEY", models: [] },
  { id: "minimax", name: "MiniMax", envVar: "MINIMAX_API_KEY", models: ["MiniMax-M2.7"] },
  { id: "github-copilot", name: "GitHub Copilot", envVar: "COPILOT_GITHUB_TOKEN", models: [] },
  { id: "huggingface", name: "Hugging Face (Inference)", envVar: "HF_TOKEN", models: [] },
  { id: "cerebras", name: "Cerebras", envVar: "CEREBRAS_API_KEY", models: [] },
  { id: "nvidia", name: "NVIDIA", envVar: "NVIDIA_API_KEY", endpoint: "https://integrate.api.nvidia.com/v1", models: ["nvidia/nvidia/nemotron-3-super-120b-a12b", "nvidia/moonshotai/kimi-k2.5", "nvidia/minimaxai/minimax-m2.5", "nvidia/z-ai/glm5"] },
];

function getAvailableProviders() {
  return PROVIDERS.map(({ id, name, models }) => ({ id, name, models }));
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
    [userId]
  );
  return result.rows.map((row) => ({
    ...row,
    api_key_masked: maskKey(decrypt(row.api_key)),
    api_key: undefined, // never return raw key
  }));
}

async function addProvider(userId, provider, apiKey, model, config = {}) {
  if (!PROVIDERS.find((p) => p.id === provider)) {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  if (!apiKey) throw new Error("API key is required");

  ensureEncryptionConfigured("LLM provider credential storage");
  const encryptedKey = encrypt(apiKey);

  // If no other providers exist for this user, make it default
  const existing = await db.query("SELECT COUNT(*) FROM llm_providers WHERE user_id = $1", [userId]);
  const isDefault = parseInt(existing.rows[0].count) === 0;

  const result = await db.query(
    `INSERT INTO llm_providers(user_id, provider, api_key, model, config, is_default)
     VALUES($1, $2, $3, $4, $5, $6) RETURNING id, provider, model, is_default, created_at`,
    [userId, provider, encryptedKey, model || null, JSON.stringify(config), isDefault]
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
    params
  );
  if (result.rows.length === 0) throw new Error("Provider not found");
  return result.rows[0];
}

async function deleteProvider(id, userId) {
  const result = await db.query(
    "DELETE FROM llm_providers WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw new Error("Provider not found");
  return { success: true };
}

/**
 * Get decrypted keys for all providers of a user — internal use only.
 * Returns a map of { envVarName: decryptedKey } for container injection.
 */
async function getProviderKeys(userId) {
  const result = await db.query(
    "SELECT provider, api_key FROM llm_providers WHERE user_id = $1",
    [userId]
  );
  const keys = {};
  for (const row of result.rows) {
    const envVar = getProviderEnvVar(row.provider);
    if (envVar && row.api_key) {
      keys[envVar] = decrypt(row.api_key);
    }
  }
  return keys;
}

/**
 * Build the auth-profiles.json content that openclaw expects.
 * Maps provider keys to the openclaw auth store format.
 */
function buildAuthProfiles(providerKeys) {
  const profiles = {};
  const envToProvider = {};
  for (const p of PROVIDERS) {
    envToProvider[p.envVar] = p.id;
  }
  const envToEndpoint = {};
  for (const p of PROVIDERS) {
    if (p.endpoint) envToEndpoint[p.envVar] = p.endpoint;
  }
  for (const [envVar, key] of Object.entries(providerKeys)) {
    const provider = envToProvider[envVar];
    if (provider && key) {
      const profile = { apiKey: key };
      if (envToEndpoint[envVar]) profile.endpoint = envToEndpoint[envVar];
      profiles[provider] = profile;
    }
  }
  return profiles;
}

module.exports = {
  getAvailableProviders,
  getProviderEnvVar,
  listProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getProviderKeys,
  buildAuthProfiles,
  PROVIDERS,
};
