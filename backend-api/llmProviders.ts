// @ts-nocheck
// LLM Provider key management — encrypted storage of user API keys

const db = require("./db");
const { Client } = require("pg");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("./crypto");
const { buildPostgresConfig } = require("./lib/connectionConfig");
const {
  advisoryLockBusyError,
  advisoryLockClientOptions,
  isAdvisoryLockTimeout,
  startAdvisoryLockHoldWatchdog,
} = require("./lib/advisoryLocks");
const { DEMO_PROVIDER_ID, DEMO_MODEL_ID, deriveDemoToken, demoLlmBaseUrl } = require("./demoLlm");
const { NEMOCLAW_DEFAULT_MODEL } = require("../agent-runtime/lib/nemoclawDefaults");
const {
  HERMES_MANAGED_ENV_ENV,
  HERMES_MODEL_CONFIG_ENV,
} = require("../agent-runtime/lib/hermesRuntimeBootstrap");

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
    // mixtral-8x7b-32768 was decommissioned by Groq — do not resurface it.
    models: ["llama-3.3-70b-versatile"],
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
  {
    // Ollama endpoints are per-host (the operator's own server) — without a
    // base URL the agent container has nothing to connect to.
    id: "ollama",
    name: "Ollama",
    envVar: "OLLAMA_API_KEY",
    requiresBaseUrl: true,
    baseUrlPlaceholder: "http://<ollama-host>:11434/v1",
    models: [],
  },
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

function getManagedProviderEnvNames({ runtimeFamily = "openclaw" } = {}) {
  const names = new Set();
  for (const provider of PROVIDERS) {
    const envVar = String(provider.envVar || "").trim();
    if (!envVar) continue;
    names.add(envVar);
    const baseUrlEnv = envVar.replace(/_API_KEY$|_TOKEN$/, "_BASE_URL");
    const apiVersionEnv = envVar.replace(/_API_KEY$|_TOKEN$/, "_API_VERSION");
    if (baseUrlEnv !== envVar) names.add(baseUrlEnv);
    if (apiVersionEnv !== envVar) names.add(apiVersionEnv);
  }
  names.add("MICROSOFT_FOUNDRY_DEPLOYMENT");
  if (
    String(runtimeFamily || "")
      .trim()
      .toLowerCase() === "hermes"
  ) {
    names.add(HERMES_MANAGED_ENV_ENV);
    names.add(HERMES_MODEL_CONFIG_ENV);
  } else {
    names.add("NORA_DEFAULT_OPENCLAW_MODEL");
  }
  return [...names].sort();
}

/** Mask an API key for safe display: keep first 4 and last 4 chars */
function maskKey(key) {
  if (!key || key.length < 12) return "••••••••";
  return key.slice(0, 4) + "••••••••" + key.slice(-4);
}

// ── CRUD ─────────────────────────────────────────────────

/**
 * List a user's providers with masked credentials, never returning raw keys;
 * unreadable encrypted values are surfaced as a display warning.
 *
 * @param {string} userId - User whose providers should be listed.
 * @returns {Promise<Array>} Provider rows safe for API responses.
 */
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

function providerMutationLockKey(userId) {
  return `nora:llm-providers:${String(userId || "")}`;
}

// Well above any legitimate provider mutation, so the watchdog only fires on
// work that is genuinely stuck rather than merely slow.
const PROVIDER_MUTATION_MAX_HOLD_MS = 120000;

function providerMutationMaxHoldMs() {
  const parsed = Number.parseInt(process.env.PROVIDER_MUTATION_LOCK_MAX_HOLD_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PROVIDER_MUTATION_MAX_HOLD_MS;
}

function createProviderMutationClient() {
  const {
    max: _max,
    idleTimeoutMillis: _idleTimeoutMillis,
    ...clientConfig
  } = buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: "nora-backend-provider-mutation",
  });
  return new Client({
    ...clientConfig,
    options: advisoryLockClientOptions(
      process.env.PROVIDER_MUTATION_LOCK_TIMEOUT_MS,
      clientConfig.options,
    ),
  });
}

async function withProviderStateLock(userId, operation) {
  if (!userId || typeof operation !== "function") {
    throw new Error("userId and operation are required for the provider state lock");
  }

  // This must not borrow from the main backend pool: afterCommit performs
  // provider/runtime reads through that pool, and holding its last available
  // connection here would deadlock installations configured with DB_POOL_MAX=1.
  const client = createProviderMutationClient();
  const lockKey = providerMutationLockKey(userId);
  let connected = false;
  let lockHeld = false;
  let cancelHoldWatchdog = () => {};
  try {
    await client.connect();
    connected = true;
    // The wait is bounded by lock_timeout on the connection itself (see
    // createProviderMutationClient). A bare pg_advisory_lock blocks
    // indefinitely, so a holder whose work never returns turned this call into a
    // request that hung past the reverse proxy's timeout and 504'd — sometimes
    // after the INSERT had committed, so the operator's retry created duplicate
    // provider rows (#406). Failing fast keeps the outcome unambiguous.
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    } catch (error) {
      if (isAdvisoryLockTimeout(error)) {
        throw advisoryLockBusyError(
          "Another provider change is in progress for this account. Retry in a moment.",
          { code: "PROVIDER_MUTATION_LOCK_BUSY" },
        );
      }
      throw error;
    }
    lockHeld = true;
    // If the guarded work never settles, the unlock below never runs and every
    // later caller queues behind this session. Ending the connection releases
    // the lock the same way a crashed process would.
    cancelHoldWatchdog = startAdvisoryLockHoldWatchdog(client, {
      maxHoldMs: providerMutationMaxHoldMs(),
      onTimeout: (budgetMs) =>
        console.error(
          `[llmProviders] Provider mutation lock for user ${userId} exceeded ${budgetMs}ms; releasing it by closing the session. The guarded operation did not finish.`,
        ),
    });
    return await operation(client);
  } finally {
    cancelHoldWatchdog();
    if (lockHeld) {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch((error) =>
          console.warn(
            `[llmProviders] Provider advisory unlock failed for user ${userId}: ${error.message}`,
          ),
        );
    }
    if (connected) {
      await client
        .end()
        .catch((error) =>
          console.warn(
            `[llmProviders] Provider mutation connection close failed for user ${userId}: ${error.message}`,
          ),
        );
    }
  }
}

async function withProviderMutationLock(userId, operation, { afterCommit } = {}) {
  return withProviderStateLock(userId, async (client) => {
    let transactionOpen = false;
    try {
      // Use a session lock rather than an xact lock so the post-commit runtime
      // synchronization remains serialized with deployment finalization and
      // lifecycle resume reconciliation. The database mutation is committed
      // before afterCommit runs, allowing auth sync to read durable provider
      // state while the same lock is still held.
      await client.query("BEGIN");
      transactionOpen = true;
      const result = await operation(client);
      await client.query("COMMIT");
      transactionOpen = false;
      if (typeof afterCommit === "function") {
        await afterCommit(result);
      }
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw error;
    }
  });
}

async function ensureUserDefaultProvider(userId, queryable) {
  const result = await queryable.query(
    `WITH candidate AS (
       SELECT id
         FROM llm_providers
        WHERE user_id = $1
        ORDER BY CASE WHEN provider = $2 THEN 1 ELSE 0 END, created_at, id
        LIMIT 1
     )
     UPDATE llm_providers
        SET is_default = true
      WHERE id = (SELECT id FROM candidate)
        AND NOT EXISTS (
          SELECT 1 FROM llm_providers WHERE user_id = $1 AND is_default = true
        )
     RETURNING id`,
    [userId, DEMO_PROVIDER_ID],
  );
  return result.rows[0]?.id || null;
}

/**
 * Ensure the user's built-in demo provider exists and is configured for this
 * control-plane instance. Callers must serialize this mutation with
 * providerMutationLockKey(userId); addProvider does so transactionally, while
 * demo activation holds the same key as a session lock across DB + queue work.
 */
async function ensureDemoProvider(userId, queryable = db) {
  const apiKey = deriveDemoToken();
  const model = DEMO_MODEL_ID;
  const config = { baseUrl: demoLlmBaseUrl() };
  const encryptedKey = encrypt(apiKey);
  const existing = await queryable.query(
    `SELECT id, provider, model, config, is_default, created_at
      FROM llm_providers
      WHERE user_id = $1 AND provider = $2
      ORDER BY is_default DESC, created_at, id`,
    [userId, DEMO_PROVIDER_ID],
  );

  if (existing.rows[0]) {
    const canonical = existing.rows[0];
    const refreshed = await queryable.query(
      `UPDATE llm_providers
          SET api_key = $3, model = $4, config = $5
        WHERE id = $1 AND user_id = $2
        RETURNING id, provider, model, is_default, created_at`,
      [canonical.id, userId, encryptedKey, model, JSON.stringify(config)],
    );
    if (existing.rows.length > 1) {
      await queryable.query(
        "DELETE FROM llm_providers WHERE user_id = $1 AND provider = $2 AND id <> $3",
        [userId, DEMO_PROVIDER_ID, canonical.id],
      );
    }
    return refreshed.rows[0];
  }

  const providerState = await queryable.query(
    "SELECT COUNT(*)::int AS provider_count FROM llm_providers WHERE user_id = $1",
    [userId],
  );
  const isDefault = Number(providerState.rows[0]?.provider_count || 0) === 0;
  const inserted = await queryable.query(
    `INSERT INTO llm_providers(user_id, provider, api_key, model, config, is_default)
     VALUES($1, $2, $3, $4, $5, $6)
     RETURNING id, provider, model, is_default, created_at`,
    [userId, DEMO_PROVIDER_ID, encryptedKey, model, JSON.stringify(config), isDefault],
  );
  return inserted.rows[0];
}

/**
 * Add an encrypted provider under the per-user mutation lock, promoting it
 * when no real default exists. The demo provider derives its own credentials.
 *
 * @param {string} userId - User who owns the provider.
 * @param {string} provider - Approved provider identifier.
 * @param {string} apiKey - Provider credential; optional only for the demo provider.
 * @param {string} model - Optional default model or deployment name.
 * @param {Object} [config={}] - Provider-specific endpoint configuration.
 * @param {Object} [mutationOptions={}] - Optional post-commit synchronization hook.
 * @returns {Promise<Object>} Persisted provider summary.
 */
async function addProvider(userId, provider, apiKey, model, config = {}, mutationOptions = {}) {
  if (!PROVIDERS.find((p) => p.id === provider)) {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  if (provider === DEMO_PROVIDER_ID) {
    // Deliberately no ensureEncryptionConfigured: the derived demo token is
    // not user secret material and must work on a fresh installation.
    return withProviderMutationLock(
      userId,
      (client) => ensureDemoProvider(userId, client),
      mutationOptions,
    );
  }
  if (!apiKey) throw new Error("API key is required");
  ensureEncryptionConfigured("LLM provider credential storage");
  const encryptedKey = encrypt(apiKey);

  return withProviderMutationLock(
    userId,
    async (client) => {
      const providerState = await client.query(
        `SELECT COUNT(*)::int AS provider_count,
                COALESCE(bool_or(is_default), false) AS has_default,
                COALESCE(bool_or(is_default AND provider = $2), false) AS demo_is_default
           FROM llm_providers
          WHERE user_id = $1`,
        [userId, DEMO_PROVIDER_ID],
      );
      const state = providerState.rows[0] || {};
      const isDefault =
        Number(state.provider_count || 0) === 0 ||
        state.has_default === false ||
        state.demo_is_default === true;

      // The built-in demo is a temporary onboarding default. The first real
      // provider replaces it atomically; an existing real default is preserved.
      if (state.demo_is_default === true) {
        await client.query("UPDATE llm_providers SET is_default = false WHERE user_id = $1", [
          userId,
        ]);
      }

      const result = await client.query(
        `INSERT INTO llm_providers(user_id, provider, api_key, model, config, is_default)
         VALUES($1, $2, $3, $4, $5, $6)
         RETURNING id, provider, model, is_default, created_at`,
        [userId, provider, encryptedKey, model || null, JSON.stringify(config), isDefault],
      );
      return result.rows[0];
    },
    mutationOptions,
  );
}

async function getDeploymentProvider(userId, providerId = null, queryable = db) {
  if (!userId) return null;

  if (providerId) {
    const explicit = await queryable.query(
      `SELECT id, provider, model, config
         FROM llm_providers
        WHERE user_id = $1 AND id = $2
        LIMIT 1`,
      [userId, providerId],
    );
    if (!explicit.rows[0]) {
      const error = new Error("Deployment LLM provider was not found for this user");
      error.code = "DEPLOYMENT_LLM_PROVIDER_NOT_FOUND";
      throw error;
    }
    return explicit.rows[0];
  }

  const fallback = await queryable.query(
    `SELECT id, provider, model, config
       FROM llm_providers
      WHERE user_id = $1 AND is_default = true
      LIMIT 1`,
    [userId],
  );
  return fallback.rows[0] || null;
}

/**
 * Update an owner-scoped provider under the per-user mutation lock, encrypting
 * replacement credentials and atomically ensuring a default when possible.
 *
 * @param {string} id - Provider row to update.
 * @param {string} userId - User expected to own the provider.
 * @param {Object} updates - Credential, model, config, or default-state changes.
 * @param {Object} [mutationOptions={}] - Optional post-commit synchronization hook.
 * @returns {Promise<Object>} Updated provider summary.
 */
async function updateProvider(id, userId, updates, mutationOptions = {}) {
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
    if (typeof updates.is_default !== "boolean") {
      throw new Error("is_default must be a boolean");
    }
    sets.push(`is_default = $${idx++}`);
    params.push(updates.is_default);
  }

  if (sets.length === 0) throw new Error("No fields to update");

  return withProviderMutationLock(
    userId,
    async (client) => {
      // Default selection and the target-row update must be one locked
      // transaction so a deployment finalizer cannot observe the half-state.
      if (updates.is_default) {
        await client.query("UPDATE llm_providers SET is_default = false WHERE user_id = $1", [
          userId,
        ]);
      }

      const queryParams = [...params, id, userId];
      const result = await client.query(
        `UPDATE llm_providers SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING id, provider, model, is_default`,
        queryParams,
      );
      if (result.rows.length === 0) throw new Error("Provider not found");
      const row = result.rows[0];
      if (updates.is_default !== true) {
        const promotedId = await ensureUserDefaultProvider(userId, client);
        if (promotedId === row.id) row.is_default = true;
      }
      return row;
    },
    mutationOptions,
  );
}

async function deleteProvider(id, userId, mutationOptions = {}) {
  return withProviderMutationLock(
    userId,
    async (client) => {
      const result = await client.query(
        "DELETE FROM llm_providers WHERE id = $1 AND user_id = $2 RETURNING id",
        [id, userId],
      );
      if (result.rows.length === 0) throw new Error("Provider not found");
      await ensureUserDefaultProvider(userId, client);
      return { success: true };
    },
    mutationOptions,
  );
}

/**
 * Get decrypted keys for all providers of a user — internal use only.
 * Returns a map of { envVarName: decryptedKey } for container injection.
 *
 * @param {string} userId - User whose runtime credentials should be loaded.
 * @returns {Promise<Object>} Decrypted keys indexed by runtime environment variable.
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
 *
 * @param {string} userId - User whose provider overrides should be loaded.
 * @returns {Promise<Object>} Endpoint, API-version, and deployment maps.
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
 *
 * @param {Object} providerKeys - Decrypted keys indexed by environment variable.
 * @param {Object} [endpointOverridesByProvider={}] - Saved provider endpoints.
 * @param {Object} [apiVersionOverridesByProvider={}] - Saved API versions.
 * @returns {Object} OpenClaw auth profile document.
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
  getManagedProviderEnvNames,
  listProviders,
  addProvider,
  ensureDemoProvider,
  providerMutationLockKey,
  withProviderStateLock,
  getDeploymentProvider,
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
