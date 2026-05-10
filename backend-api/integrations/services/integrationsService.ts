// @ts-nocheck
// Orchestration layer for the integrations module. Consumes:
//   - repository (data access)
//   - secretEncryption (catalog-aware secret hygiene)
//   - catalogLoader (catalog data + hydration)
//   - providerRegistry (Provider strategy + legacy fallback)
//   - integrationTools runtime helpers (tool catalog + sync entry)
//
// All exported functions preserve the contract previously exposed by
// backend-api/integrations.ts; the latter is now a thin re-export shim.

const db = require("../../db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("../../crypto");
const { assertSafeUrlAsync } = require("../../networkSafety");
const { createIntegrationsRepository } = require("../repository/integrationsRepository");
const catalogLoader = require("../catalog/catalogLoader");
const { createSecretEncryption } = require("../crypto/secretEncryption");
const { buildIntegrationToolCatalogEntries } = require("./toolCatalogBuilder");
const { createProviderRegistry } = require("../providers/base/registry");
const { createLegacyProviderAdapter } = require("../providers/legacy");
const {
  INTEGRATION_ENV_MAP,
  INTEGRATION_CONFIG_ENV_MAP,
  integrationProviderAffectsLlmAuth,
} = require("../providers/legacy/envMaps");
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

const legacyEnvMaps = {
  envMap: INTEGRATION_ENV_MAP,
  configEnvMap: INTEGRATION_CONFIG_ENV_MAP,
};

const providerRegistry = createProviderRegistry((providerId) =>
  createLegacyProviderAdapter(providerId, legacyEnvMaps),
);

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

function buildIntegrationSyncEntry(row = {}) {
  const hydrated = hydrateRow(row);
  const provider = row.provider || row.catalog_id || row.id;
  const decryptedConfig = decryptSensitiveConfig(provider, row.config);
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

// ── Agent integrations (CRUD) ────────────────────────────

async function connectIntegration(agentId, provider, token, config = {}) {
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

async function listIntegrations(agentId) {
  const rows = await repo.listForAgent(agentId);
  return rows.map((row) => ({
    ...row,
    config: redactSensitiveConfig(row.provider, row.config),
  }));
}

async function removeIntegration(integrationId, agentId) {
  const removed = await repo.deleteIntegration({ integrationId, agentId });
  if (!removed) throw new Error("Integration not found");
  return removed;
}

async function testIntegration(integrationId, agentId) {
  const integration = await repo.findIntegration({ integrationId, agentId });
  if (!integration) throw new Error("Integration not found");

  if (!integration.access_token) {
    return { success: false, error: "No access token configured" };
  }

  // Mirror the runtime sync path: refresh any OAuth token within the skew
  // window of expiry before hitting the provider, so clicking "Test" after
  // a token has expired doesn't surface a misleading 401 when we hold a
  // valid refresh_token.
  const refreshedRow = await refreshTwitterOAuthRowIfNeeded(integration);

  const provider = refreshedRow.provider;
  const token = decrypt(refreshedRow.access_token);
  const decryptedConfig = decryptSensitiveConfig(provider, refreshedRow.config);

  const ctx = {
    row: { ...refreshedRow, config: decryptedConfig },
    token,
    config: decryptedConfig,
  };

  return providerRegistry.resolve(provider).test(ctx, providerDeps);
}

// ── Sync + env ──────────────────────────────────────────

async function getIntegrationsForSync(agentId) {
  const rows = await repo.listActiveForAgent(agentId);
  const refreshedRows = [];
  for (const row of rows) {
    refreshedRows.push(await refreshTwitterOAuthRowIfNeeded(row));
  }
  return refreshedRows.map(buildIntegrationSyncEntry);
}

async function getIntegrationEnvVars(agentId) {
  const rows = await repo.listActiveEnvSourcesForAgent(agentId);
  const envVars = {};
  for (const rawRow of rows) {
    const row = await refreshTwitterOAuthRowIfNeeded(rawRow);
    const decryptedConfig = decryptSensitiveConfig(row.provider, row.config);
    const envMapping = providerRegistry
      .resolve(row.provider)
      .mapToEnv({ row, token: null, config: decryptedConfig });

    if (envMapping.primary && row.access_token) {
      envVars[envMapping.primary] = decrypt(row.access_token);
    }
    for (const [cfgKey, cfgValue] of Object.entries(decryptedConfig)) {
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
  testIntegration,
  getIntegrationsForSync,
  getIntegrationEnvVars,
  // LLM auth + env maps
  integrationProviderAffectsLlmAuth,
  INTEGRATION_ENV_MAP,
  INTEGRATION_CONFIG_ENV_MAP,
  // Internals exposed for tests
  providerRegistry,
};
