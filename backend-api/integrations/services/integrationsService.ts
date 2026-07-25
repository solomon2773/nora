// @ts-nocheck
// Orchestration layer for the integrations module. Consumes:
//   - repository (data access)
//   - secretEncryption (catalog-aware secret hygiene)
//   - catalogLoader (catalog data + hydration)
//   - providerRegistry (Provider strategy)
//   - integrationTools runtime helpers (tool catalog + sync entry)
//
// All exported functions preserve the contract previously exposed by
// backend-api/integrations.ts; the latter is now a thin re-export shim.

const db = require("../../db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("../../crypto");
const { assertSafeUrlAsync } = require("../../networkSafety");
const llmProviders = require("../../llmProviders");
const { createIntegrationsRepository } = require("../repository/integrationsRepository");
const catalogLoader = require("../catalog/catalogLoader");
const { createSecretEncryption } = require("../crypto/secretEncryption");
const { buildIntegrationToolCatalogEntries } = require("./toolCatalogBuilder");
const { createProviderRegistry } = require("../providers/base/registry");

/**
 * Build a fail-closed fallback that rejects verification and runtime environment mapping.
 * This prevents stale catalog entries from appearing connected without a strategy.
 *
 * @param {string} providerId - Unregistered catalog provider ID.
 * @returns {Object} Provider strategy that reports the missing registration.
 */
function createStubProvider(providerId) {
  const unsupportedMessage = `No integration strategy is registered for provider "${providerId}"`;
  return {
    id: providerId,
    authType: "custom",
    async test() {
      return {
        success: false,
        error: unsupportedMessage,
      };
    },
    mapToEnv() {
      throw new Error(unsupportedMessage);
    },
  };
}

// Provider IDs whose primary credential affects LLM auth (and therefore
// require the agent's auth profile to refresh after connect/disconnect).
const LLM_AUTH_PROVIDER_IDS = new Set(["openai", "anthropic", "huggingface"]);

const LLM_AUTH_ENV_VARS = new Set(
  (Array.isArray(llmProviders.PROVIDERS) ? llmProviders.PROVIDERS : [])
    .map((p) => p.envVar)
    .filter(Boolean),
);

/**
 * Determine whether changing a provider requires regenerating agent LLM auth profiles.
 *
 * Explicit LLM providers are recognized directly; registered future providers are probed through
 * their environment mapping without allowing mapping failures to escape.
 *
 * @param {string} provider - Provider identifier.
 * @returns {boolean} Whether auth-profile refresh is required.
 */
function integrationProviderAffectsLlmAuth(provider) {
  const providerId = String(provider || "").trim();
  if (!providerId) return false;
  if (LLM_AUTH_PROVIDER_IDS.has(providerId)) return true;
  // Defensive: if a future provider's mapToEnv emits an LLM_AUTH env var,
  // this still catches it without forcing every change to update the set.
  const reg = providerRegistry;
  if (reg && typeof reg.has === "function" && reg.has(providerId)) {
    try {
      const provider = reg.resolve(providerId);
      const env = provider.mapToEnv({
        row: { provider: providerId },
        token: null,
        config: {},
      });
      if (env.primary && LLM_AUTH_ENV_VARS.has(env.primary)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}
const { githubProvider } = require("../providers/github");
const { slackProvider } = require("../providers/slack");
const { linearProvider } = require("../providers/linear");
const { jiraProvider } = require("../providers/jira");
const { twitterProvider } = require("../providers/twitter");
const { linkedinProvider } = require("../providers/linkedin");
const { gitlabProvider } = require("../providers/gitlab");
const { bitbucketProvider } = require("../providers/bitbucket");
const { circleciProvider } = require("../providers/circleci");
const { vercelProvider } = require("../providers/vercel");
const { terraformProvider } = require("../providers/terraform");
const { jenkinsProvider } = require("../providers/jenkins");
const { dockerHubProvider } = require("../providers/dockerHub");
const { kubernetesProvider } = require("../providers/kubernetes");
const { discordProvider } = require("../providers/discord");
const { telegramProvider } = require("../providers/telegram");
const { teamsProvider } = require("../providers/teams");
const { emailProvider } = require("../providers/email");
const {
  wecomProvider,
  normalizeWecomConfigInput,
  normalizeWecomDisplayConfig,
} = require("../providers/wecom");
const { twilioProvider } = require("../providers/twilio");
const { sendgridProvider } = require("../providers/sendgrid");
const { postgresqlProvider } = require("../providers/postgresql");
const { mongodbProvider } = require("../providers/mongodb");
const { redisProvider } = require("../providers/redis");
const { supabaseProvider } = require("../providers/supabase");
const { firebaseProvider } = require("../providers/firebase");
const { googleDriveProvider } = require("../providers/googleDrive");
const { dropboxProvider } = require("../providers/dropbox");
const { s3Provider } = require("../providers/s3");
const { elasticsearchProvider } = require("../providers/elasticsearch");
const { pineconeProvider } = require("../providers/pinecone");
const { weaviateProvider } = require("../providers/weaviate");
const { algoliaProvider } = require("../providers/algolia");
const { openaiProvider } = require("../providers/openai");
const { anthropicProvider } = require("../providers/anthropic");
const { huggingfaceProvider } = require("../providers/huggingface");
const { digitaloceanProvider } = require("../providers/digitalocean");
const { awsProvider } = require("../providers/aws");
const { gcpProvider } = require("../providers/gcp");
const { azureProvider } = require("../providers/azure");
const { notionProvider } = require("../providers/notion");
const { airtableProvider } = require("../providers/airtable");
const { asanaProvider } = require("../providers/asana");
const { mondayProvider } = require("../providers/monday");
const { clickupProvider } = require("../providers/clickup");
const { trelloProvider } = require("../providers/trello");
const { confluenceProvider } = require("../providers/confluence");
const { googleSheetsProvider } = require("../providers/googleSheets");
const { googleCalendarProvider } = require("../providers/googleCalendar");
const { salesforceProvider } = require("../providers/salesforce");
const { hubspotProvider } = require("../providers/hubspot");
const { pipedriveProvider } = require("../providers/pipedrive");
const { zendeskProvider } = require("../providers/zendesk");
const { stripeProvider } = require("../providers/stripe");
const { paypalProvider } = require("../providers/paypal");
const { googleAnalyticsProvider } = require("../providers/googleAnalytics");
const { mixpanelProvider } = require("../providers/mixpanel");
const { segmentProvider } = require("../providers/segment");
const { datadogProvider } = require("../providers/datadog");
const { sentryProvider } = require("../providers/sentry");
const { grafanaProvider } = require("../providers/grafana");
const { pagerdutyProvider } = require("../providers/pagerduty");
const { shopifyProvider } = require("../providers/shopify");
const { woocommerceProvider } = require("../providers/woocommerce");
const { facebookProvider } = require("../providers/facebook");
const { instagramProvider } = require("../providers/instagram");
const { zapierProvider } = require("../providers/zapier");
const { makeProvider } = require("../providers/make");
const { n8nProvider } = require("../providers/n8n");
const { normalizeEmailConfigInput, extractEmailPrimarySecret } = require("../providers/email");

const repo = createIntegrationsRepository(db);
const secretCrypto = createSecretEncryption({
  encrypt,
  decrypt,
  getSensitiveConfigKeys: catalogLoader.getSensitiveConfigKeys,
});
const {
  encryptSensitiveConfig,
  decryptSensitiveConfig,
  redactSensitiveConfig,
  stripSensitiveConfig,
} = secretCrypto;

const providerRegistry = createProviderRegistry(createStubProvider);

// Register concrete providers that have moved off the legacy adapter.
// Adding a new provider is a single-line change here once its strategy
// implementation lives in providers/<id>.ts.
[
  githubProvider,
  slackProvider,
  linearProvider,
  jiraProvider,
  twitterProvider,
  linkedinProvider,
  gitlabProvider,
  bitbucketProvider,
  circleciProvider,
  vercelProvider,
  terraformProvider,
  jenkinsProvider,
  dockerHubProvider,
  kubernetesProvider,
  discordProvider,
  telegramProvider,
  teamsProvider,
  emailProvider,
  wecomProvider,
  twilioProvider,
  sendgridProvider,
  postgresqlProvider,
  mongodbProvider,
  redisProvider,
  supabaseProvider,
  firebaseProvider,
  googleDriveProvider,
  dropboxProvider,
  s3Provider,
  elasticsearchProvider,
  pineconeProvider,
  weaviateProvider,
  algoliaProvider,
  openaiProvider,
  anthropicProvider,
  huggingfaceProvider,
  digitaloceanProvider,
  awsProvider,
  gcpProvider,
  azureProvider,
  notionProvider,
  airtableProvider,
  asanaProvider,
  mondayProvider,
  clickupProvider,
  trelloProvider,
  confluenceProvider,
  googleSheetsProvider,
  googleCalendarProvider,
  salesforceProvider,
  hubspotProvider,
  pipedriveProvider,
  zendeskProvider,
  stripeProvider,
  paypalProvider,
  googleAnalyticsProvider,
  mixpanelProvider,
  segmentProvider,
  datadogProvider,
  sentryProvider,
  grafanaProvider,
  pagerdutyProvider,
  shopifyProvider,
  woocommerceProvider,
  facebookProvider,
  instagramProvider,
  zapierProvider,
  makeProvider,
  n8nProvider,
].forEach((p) => providerRegistry.register(p));

// Resolve fetch at call time so test mocks reassigning `global.fetch`
// after module load are honored.
const providerDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  assertSafeUrl: assertSafeUrlAsync,
  encrypt,
  decrypt,
  ensureEncryptionConfigured,
  db,
};

// ── Catalog passthroughs ─────────────────────────────────

const loadCatalog = catalogLoader.loadCatalog;
const hydrateRow = catalogLoader.hydrateRow;

async function seedCatalog() {
  return catalogLoader.seedCatalog(repo);
}

async function getCatalog(category) {
  return catalogLoader.getCatalog(repo, category);
}

async function getCatalogItem(catalogId) {
  return catalogLoader.getCatalogItem(repo, catalogId);
}

// ── OAuth refresh — delegates to provider.refreshCredentials ─────

/**
 * Refresh credentials when supported, leaving transport exceptions retryable
 * and persisting successful token rotation.
 *
 * Provider `failed` outcomes, including non-2xx or missing-token responses, are
 * best-effort marked `needs_reconnect`; retryable outcomes leave the row unchanged.
 *
 * @param {Object} [row={}] - Raw integration row.
 * @returns {Promise<Object>} Original, refreshed, or reconnect-required row.
 */
async function refreshTwitterOAuthRowIfNeeded(row = {}) {
  const provider = row.provider || row.catalog_id;
  if (!provider || !row.id) return row;

  const resolved = providerRegistry.resolve(provider);
  if (typeof resolved.refreshCredentials !== "function") return row;

  // Decrypt the row's config first so the provider sees plaintext.
  const decryptedRow = {
    ...row,
    config: decryptSensitiveConfig(provider, row.config),
  };

  const outcome = await resolved.refreshCredentials(decryptedRow, providerDeps);

  // Any provider-reported failure makes the stored token unusable for this
  // workflow, so surface it instead of leaving the integration silently active.
  if (outcome?.failed) {
    console.warn(
      `[integrations] Marking integration ${row.id} (${provider}) needs_reconnect: ${outcome.error || "OAuth refresh failed"}`,
    );
    try {
      await repo.updateStatus({ id: row.id, status: "needs_reconnect" });
    } catch (statusError) {
      console.warn(
        `[integrations] Could not persist needs_reconnect for ${row.id}: ${statusError.message}`,
      );
    }
    return { ...row, status: "needs_reconnect" };
  }

  if (!outcome?.refreshed) return row;

  const newConfig = outcome.row.config || {};
  const newAccessToken = outcome.row.access_token;

  const { secured: securedConfig } = encryptSensitiveConfig(provider, newConfig);
  const encryptedToken = encrypt(String(newAccessToken));

  await repo.updateAccessTokenAndConfig({
    id: row.id,
    encryptedToken,
    encryptedConfigJson: JSON.stringify(securedConfig),
  });

  return {
    ...row,
    access_token: encryptedToken,
    config: securedConfig,
  };
}

// ── Sync-entry / clone helpers ───────────────────────────

/**
 * Strip integration credentials for cloning and require reconnection when any were removed.
 *
 * @param {Object} [row={}] - Integration row to make portable.
 * @returns {Object} Clone-safe provider config and status.
 */
function buildCloneableIntegration(row = {}) {
  const { config, removedSensitive } = stripSensitiveConfig(row.provider, row.config);
  const hasPrimarySecret = Boolean(row.access_token);

  return {
    provider: row.provider,
    catalog_id: row.catalog_id || row.provider,
    config,
    status: hasPrimarySecret || removedSensitive ? "needs_reconnect" : row.status || "active",
  };
}

function normalizeEmailDisplayConfig(config = {}, cronJobId = null) {
  const normalized = normalizeEmailConfigInput(config || {});
  if (!cronJobId) {
    normalized.cron = {
      ...(normalized.cron && typeof normalized.cron === "object" ? normalized.cron : {}),
      enabled: false,
    };
  }
  return normalized;
}

/**
 * Build a secret-bearing runtime sync entry alongside its separately redacted representation.
 *
 * Provider sanitizers remove control-plane-only secrets before environment and tool metadata are
 * projected. Callers must keep the returned `config` inside trusted runtime sync paths.
 *
 * @param {Object} [row={}] - Active integration row with catalog metadata.
 * @returns {Object} Runtime integration manifest entry.
 */
function buildIntegrationSyncEntry(row = {}) {
  const hydrated = hydrateRow(row);
  const provider = row.provider || row.catalog_id || row.id;
  const decryptedConfigRaw = decryptSensitiveConfig(provider, row.config);
  const decryptedConfig =
    provider === "email"
      ? normalizeEmailConfigInput(decryptedConfigRaw)
      : provider === "wecom"
        ? normalizeWecomConfigInput(decryptedConfigRaw)
        : decryptedConfigRaw;
  const resolved = providerRegistry.resolve(provider);
  const config =
    typeof resolved.sanitizeForSync === "function"
      ? resolved.sanitizeForSync(decryptedConfig)
      : decryptedConfig;

  const envMapping = resolved.mapToEnv({ row, token: null, config });

  return {
    id: row.id,
    provider,
    name: row.catalog_name || hydrated.name || provider,
    category: row.catalog_category || hydrated.category || "unknown",
    authType: hydrated.authType || null,
    activatedAt: row.created_at || row.createdAt || null,
    expiresAt: config.expires_at || config.expiresAt || null,
    config,
    redactedConfig: redactSensitiveConfig(provider, config),
    status: row.status || "active",
    capabilities: Array.isArray(hydrated.capabilities) ? hydrated.capabilities : [],
    toolSpecs: Array.isArray(hydrated.toolSpecs) ? hydrated.toolSpecs : [],
    mcp: hydrated.mcp || null,
    api: hydrated.api || null,
    usageHints: Array.isArray(hydrated.usageHints) ? hydrated.usageHints : [],
    credentialEnv: envMapping,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandDottedConfig(input = {}) {
  const next = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined) continue;
    if (!key.includes(".")) {
      next[key] = value;
      continue;
    }

    const parts = key.split(".");
    let cursor = next;
    while (parts.length > 1) {
      const part = parts.shift();
      if (!isPlainObject(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[0]] = value;
  }
  return next;
}

function mergeConfig(baseValue, patchValue) {
  if (Array.isArray(patchValue)) return patchValue.slice();
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return patchValue === undefined ? baseValue : patchValue;
  }

  const next = { ...baseValue };
  for (const [key, value] of Object.entries(patchValue)) {
    next[key] = mergeConfig(baseValue[key], value);
  }
  return next;
}

// ── Agent integrations (CRUD) ────────────────────────────

/**
 * Normalize Email or WeCom config, encrypt discovered credentials, and persist a redacted response.
 *
 * @param {string} agentId - Agent receiving the integration.
 * @param {string} provider - Catalog provider identifier.
 * @param {string|null} token - Optional primary credential.
 * @param {Object} [config={}] - Provider configuration.
 * @returns {Promise<Object>} Persisted integration without its primary access token.
 */
async function connectIntegration(agentId, provider, token, config = {}) {
  if (provider === "email") {
    config = normalizeEmailConfigInput(config || {});
    if (!token) token = extractEmailPrimarySecret(config);
  } else if (provider === "wecom") {
    config = normalizeWecomConfigInput(config || {});
  }

  // If no explicit token, try to extract from config (first
  // password+required field).
  if (!token) {
    const catalogItem = await getCatalogItem(provider);
    if (catalogItem) {
      const fields = catalogItem.configFields || [];
      const tokenField = fields.find((f) => f.type === "password" && f.required);
      if (tokenField && config[tokenField.key]) {
        token = config[tokenField.key];
      }
    }
  }

  const { secured: securedConfig, hasSensitiveMaterial } = encryptSensitiveConfig(provider, config);
  if (token || hasSensitiveMaterial) {
    ensureEncryptionConfigured("Integration credential storage");
  }

  const encryptedToken = token ? encrypt(token) : null;
  const inserted = await repo.insertIntegration({
    agentId,
    provider,
    catalogId: provider,
    encryptedToken,
    encryptedConfigJson: JSON.stringify(securedConfig),
  });
  const { access_token, ...safeRow } = inserted || {};
  return {
    ...safeRow,
    config: redactSensitiveConfig(provider, securedConfig),
  };
}

/**
 * Create a replacement before deleting sibling rows for the same agent and provider.
 *
 * The two writes are not transactional, so deletion failure can temporarily leave duplicates.
 *
 * @param {string} agentId - Agent receiving the replacement.
 * @param {string} provider - Singleton provider identifier.
 * @param {string|null} token - Optional primary credential.
 * @param {Object} [config={}] - Provider configuration.
 * @returns {Promise<Object>} Newly persisted integration.
 */
async function replaceIntegration(agentId, provider, token, config = {}) {
  const result = await connectIntegration(agentId, provider, token, config);
  if (result?.id) {
    await repo.deleteSiblingIntegrations({
      agentId,
      provider,
      excludeId: result.id,
    });
  }
  return result;
}

/**
 * List an agent's integrations with catalog metadata and redacted display configuration.
 *
 * @param {string} agentId - Agent whose integrations should be listed.
 * @returns {Promise<Object[]>} API-safe integration rows.
 */
async function listIntegrations(agentId) {
  const rows = await repo.listForAgent(agentId);
  return rows.map((row) => {
    const hydrated = hydrateRow(row);
    const displayConfig =
      row.provider === "email"
        ? normalizeEmailDisplayConfig(
            decryptSensitiveConfig(row.provider, row.config),
            row.cron_job_id,
          )
        : row.provider === "wecom"
          ? normalizeWecomDisplayConfig(decryptSensitiveConfig(row.provider, row.config))
          : row.config;
    return {
      ...hydrated,
      config: redactSensitiveConfig(row.provider, displayConfig),
    };
  });
}

async function removeIntegration(integrationId, agentId) {
  const removed = await repo.deleteIntegration({ integrationId, agentId });
  if (!removed) throw new Error("Integration not found");
  return removed;
}

/**
 * Merge a partial owner-scoped config update while preserving an omitted primary credential.
 *
 * Email and WeCom inputs are normalized before all discovered secrets are re-encrypted.
 *
 * @param {string} integrationId - Integration identifier.
 * @param {string} agentId - Owning agent identifier.
 * @param {string|null} token - Replacement primary credential, or null to preserve it.
 * @param {Object} [config={}] - Partial provider config, including dotted keys.
 * @returns {Promise<Object>} Updated integration with sensitive config redacted.
 */
async function updateIntegration(integrationId, agentId, token, config = {}) {
  const current = await repo.findIntegration({ integrationId, agentId });
  if (!current) throw new Error("Integration not found");

  const provider = current.provider;
  const currentConfigRaw = decryptSensitiveConfig(provider, current.config);
  const currentConfig =
    provider === "email"
      ? normalizeEmailConfigInput(currentConfigRaw)
      : provider === "wecom"
        ? normalizeWecomConfigInput(currentConfigRaw)
        : currentConfigRaw;
  const patchConfig = expandDottedConfig(config || {});
  const mergedConfig =
    provider === "email"
      ? normalizeEmailConfigInput(mergeConfig(currentConfig, patchConfig))
      : provider === "wecom"
        ? normalizeWecomConfigInput(mergeConfig(currentConfig, patchConfig))
        : mergeConfig(currentConfig, patchConfig);

  let resolvedToken = token;
  if (provider === "email") {
    resolvedToken = extractEmailPrimarySecret(mergedConfig);
  } else if (!resolvedToken) {
    const catalogItem = await getCatalogItem(provider);
    const tokenField = (catalogItem?.configFields || []).find(
      (field) => field.type === "password" && field.required,
    );
    if (tokenField && typeof config?.[tokenField.key] === "string" && config[tokenField.key]) {
      resolvedToken = config[tokenField.key];
    }
  }

  const { secured: securedConfig, hasSensitiveMaterial } = encryptSensitiveConfig(
    provider,
    mergedConfig,
  );
  if (resolvedToken || hasSensitiveMaterial || current.access_token) {
    ensureEncryptionConfigured("Integration credential storage");
  }

  const encryptedToken = resolvedToken
    ? encrypt(String(resolvedToken))
    : current.access_token || null;

  const updated = await repo.updateIntegration({
    id: integrationId,
    agentId,
    encryptedToken,
    encryptedConfigJson: JSON.stringify(securedConfig),
  });
  if (!updated) throw new Error("Integration not found");

  return {
    ...hydrateRow(updated),
    config: redactSensitiveConfig(
      provider,
      provider === "email"
        ? normalizeEmailDisplayConfig(mergedConfig, updated.cron_job_id)
        : provider === "wecom"
          ? normalizeWecomDisplayConfig(mergedConfig)
          : mergedConfig,
    ),
  };
}

async function updateEmailCronJobId(integrationId, agentId, cronJobId) {
  await repo.updateCronJobId({ id: integrationId, agentId, cronJobId });
}

async function findActiveEmailIntegrations(agentId) {
  return repo.findActiveEmailIntegrations(agentId);
}

async function findActiveIntegrationByCronJobId(agentId, cronJobId) {
  return repo.findActiveIntegrationByCronJobId({ agentId, cronJobId });
}

/**
 * Refresh expiring OAuth credentials, decrypt the row, and run its provider connectivity probe.
 *
 * @param {string} integrationId - Integration identifier.
 * @param {string} agentId - Owning agent identifier.
 * @returns {Promise<Object>} Provider-specific connectivity result.
 */
async function testIntegration(integrationId, agentId) {
  const integration = await repo.findIntegration({ integrationId, agentId });
  if (!integration) throw new Error("Integration not found");

  if (!integration.access_token && !["email", "wecom"].includes(integration.provider)) {
    return { success: false, error: "No access token configured" };
  }

  // Mirror the runtime sync path: refresh any OAuth token within the skew
  // window of expiry before hitting the provider, so clicking "Test" after
  // a token has expired doesn't surface a misleading 401 when we hold a
  // valid refresh_token.
  const refreshedRow = await refreshTwitterOAuthRowIfNeeded(integration);

  const provider = refreshedRow.provider;
  const token = refreshedRow.access_token ? decrypt(refreshedRow.access_token) : null;
  const decryptedConfigRaw = decryptSensitiveConfig(provider, refreshedRow.config);
  const decryptedConfig =
    provider === "email"
      ? normalizeEmailConfigInput(decryptedConfigRaw)
      : provider === "wecom"
        ? normalizeWecomConfigInput(decryptedConfigRaw)
        : decryptedConfigRaw;

  const ctx = {
    row: { ...refreshedRow, config: decryptedConfig },
    token,
    config: decryptedConfig,
  };

  return providerRegistry.resolve(provider).test(ctx, providerDeps);
}

/**
 * Load an owner-scoped integration with its primary token and config fully decrypted.
 *
 * @param {string} integrationId - Integration identifier.
 * @param {string} agentId - Owning agent identifier.
 * @returns {Promise<Object|null>} Trusted plaintext integration or null when absent.
 */
async function getDecryptedIntegration(integrationId, agentId) {
  const row = await repo.findIntegration({ integrationId, agentId });
  if (!row) return null;

  const provider = row.provider || row.catalog_id;
  const decryptedConfigRaw = decryptSensitiveConfig(provider, row.config);
  const decryptedConfig =
    provider === "email"
      ? normalizeEmailConfigInput(decryptedConfigRaw)
      : provider === "wecom"
        ? normalizeWecomConfigInput(decryptedConfigRaw)
        : decryptedConfigRaw;

  return {
    ...hydrateRow(row),
    access_token: row.access_token ? decrypt(row.access_token) : null,
    config: decryptedConfig,
  };
}

// ── Sync + env ──────────────────────────────────────────

/**
 * Refresh active integrations sequentially and build trusted runtime sync manifests.
 *
 * @param {string} agentId - Agent whose integrations should be projected.
 * @returns {Promise<Object[]>} Secret-bearing runtime sync entries.
 */
async function getIntegrationsForSync(agentId) {
  const rows = await repo.listActiveForAgent(agentId);
  const refreshedRows = [];
  for (const row of rows) {
    refreshedRows.push(await refreshTwitterOAuthRowIfNeeded(row));
  }
  return refreshedRows.map(buildIntegrationSyncEntry);
}

/**
 * Refresh and decrypt active integrations, then emit only provider-declared runtime env vars.
 *
 * @param {string} agentId - Agent whose integration environment should be built.
 * @returns {Promise<Object>} Plaintext runtime environment map.
 */
async function getIntegrationEnvVars(agentId) {
  const rows = await repo.listActiveEnvSourcesForAgent(agentId);
  const envVars = {};
  const flattenConfig = (value, prefix = "") => {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, child] of Object.entries(value)) {
      const nextKey = prefix ? `${prefix}_${key}` : key;
      if (child && typeof child === "object" && !Array.isArray(child)) {
        Object.assign(out, flattenConfig(child, nextKey));
      } else {
        out[nextKey] = child;
      }
    }
    return out;
  };
  for (const rawRow of rows) {
    const row = await refreshTwitterOAuthRowIfNeeded(rawRow);
    const decryptedConfigRaw = decryptSensitiveConfig(row.provider, row.config);
    const decryptedConfig =
      row.provider === "email"
        ? normalizeEmailConfigInput(decryptedConfigRaw)
        : row.provider === "wecom"
          ? normalizeWecomConfigInput(decryptedConfigRaw)
          : decryptedConfigRaw;
    const envMapping = providerRegistry
      .resolve(row.provider)
      .mapToEnv({ row, token: null, config: decryptedConfig });

    if (envMapping.primary && row.access_token) {
      envVars[envMapping.primary] = decrypt(row.access_token);
    }
    for (const [cfgKey, cfgValue] of Object.entries(flattenConfig(decryptedConfig))) {
      if (!cfgValue) continue;
      const cfgEnv = envMapping.config[cfgKey];
      if (cfgEnv) envVars[cfgEnv] = String(cfgValue);
    }
  }
  return envVars;
}

module.exports = {
  // Catalog
  loadCatalog,
  hydrateRow,
  seedCatalog,
  getCatalog,
  getCatalogItem,
  // Crypto
  decryptSensitiveConfig,
  redactSensitiveConfig,
  stripSensitiveConfig,
  encryptSensitiveConfig,
  // Email helpers
  normalizeEmailConfigInput,
  extractEmailPrimarySecret,
  normalizeWecomConfigInput,
  // OAuth refresh
  refreshTwitterOAuthRowIfNeeded,
  // Sync entries
  buildCloneableIntegration,
  buildIntegrationSyncEntry,
  buildIntegrationToolCatalogEntries,
  // CRUD
  connectIntegration,
  replaceIntegration,
  listIntegrations,
  removeIntegration,
  updateIntegration,
  testIntegration,
  getDecryptedIntegration,
  updateEmailCronJobId,
  findActiveEmailIntegrations,
  findActiveIntegrationByCronJobId,
  getIntegrationsForSync,
  getIntegrationEnvVars,
  // LLM auth helpers
  integrationProviderAffectsLlmAuth,
  // Internals exposed for tests
  providerRegistry,
};
