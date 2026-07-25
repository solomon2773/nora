// @ts-nocheck
// Per-agent MCP server management. Lets an operator turn a *connected*
// integration into a Model Context Protocol server that the agent's OpenClaw
// runtime spawns over stdio. The runtime support is verified: OpenClaw
// (>= 2026.4.x) reads an `mcpServers` block from openclaw.json and launches
// each entry with StdioClientTransport.
//
// The npm package + transport come from the integration catalog (the source of
// truth, `mcp.available === true`). This module adds the one thing the catalog
// can't: the mapping from a provider's stored credential to the specific env
// var its MCP server reads — which is NOT the generic name the worker injects
// for tools (e.g. the GitLab MCP server wants GITLAB_PERSONAL_ACCESS_TOKEN, not
// the GITLAB_TOKEN the tool layer uses).
//
// Scope: the four single-token (api_key) providers whose credential maps
// cleanly to one env var. postgresql (needs a POSTGRES_URL assembled from a
// multi-field credential) and the file-credential providers (google-drive,
// kubernetes) are deliberately deferred.

const db = require("./db");
const { loadCatalog } = require("./integrations/catalog/catalogLoader");
const {
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServersConfig,
} = require("../agent-runtime/lib/mcpServersConfig");

// provider id -> how to turn its decrypted credential into MCP server env.
//   primaryEnv: the env var the MCP server reads the access token from.
//   configEnv:  optional map of decrypted-config key -> env var (e.g. self-hosted URL).
const SUPPORTED_MCP_PROVIDERS = {
  gitlab: {
    primaryEnv: "GITLAB_PERSONAL_ACCESS_TOKEN",
    configEnv: { api_url: "GITLAB_API_URL", base_url: "GITLAB_API_URL" },
  },
  notion: { primaryEnv: "NOTION_TOKEN" },
  stripe: { primaryEnv: "STRIPE_SECRET_KEY" },
  supabase: { primaryEnv: "SUPABASE_ACCESS_TOKEN" },
};

function isSupportedProvider(provider) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_MCP_PROVIDERS, provider);
}

/**
 * Select supported catalog providers that declare a usable stdio MCP package.
 *
 * @param {Array} [catalog=loadCatalog()] - Integration catalog entries.
 * @returns {Array} Supported MCP server descriptors.
 */
function loadMcpCatalog(catalog = loadCatalog()) {
  const items = Array.isArray(catalog) ? catalog : [];
  const out = [];
  for (const item of items) {
    const provider = item?.id || item?.provider;
    if (!provider || !isSupportedProvider(provider)) continue;
    const mcp = item.mcp;
    if (!mcp || mcp.available !== true || mcp.transport !== "stdio" || !mcp.npmPackage) continue;
    out.push({
      provider,
      name: item.name || provider,
      npmPackage: mcp.npmPackage,
      docsUrl: mcp.docsUrl || null,
      notes: mcp.notes || null,
    });
  }
  return out;
}

function normalizeEnabledIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = typeof entry === "string" ? entry : entry?.provider;
    if (id && isSupportedProvider(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function getManagedMcpEnvNames() {
  const placeholders = [];
  for (const [provider, mapping] of Object.entries(SUPPORTED_MCP_PROVIDERS)) {
    const env = {};
    if (mapping.primaryEnv) env[mapping.primaryEnv] = "managed";
    for (const envName of Object.values(mapping.configEnv || {}))
      if (envName) env[envName] = "managed";
    placeholders.push({ name: provider, npmPackage: "managed", env });
  }
  return buildMcpManagedEnvNames(placeholders);
}

async function getAgentMcpServerIds(agentId, { dbClient = db } = {}) {
  const result = await dbClient.query("SELECT mcp_servers FROM agents WHERE id = $1", [agentId]);
  if (result.rows.length === 0) return null; // agent not found
  return normalizeEnabledIds(result.rows[0].mcp_servers);
}

/**
 * Submit a normalized, deduplicated set of supported MCP provider identifiers.
 *
 * @param {string} agentId - Agent whose MCP selection should be replaced.
 * @param {Array} providerIds - Requested provider identifiers or descriptors.
 * @param {Object} [options={}] - Optional database dependency override.
 * @returns {Promise<Array>} Normalized identifiers submitted; a zero-row update is not detected.
 */
async function setAgentMcpServerIds(agentId, providerIds, { dbClient = db } = {}) {
  const ids = normalizeEnabledIds(providerIds);
  await dbClient.query("UPDATE agents SET mcp_servers = $1::jsonb WHERE id = $2", [
    JSON.stringify(ids),
    agentId,
  ]);
  return ids;
}

/**
 * List supported MCP servers with their connected-integration and enabled state.
 *
 * @param {string} agentId - Agent whose MCP availability should be summarized.
 * @param {Object} [options={}] - Optional database and catalog overrides.
 * @returns {Promise<Array>} Management-facing MCP server descriptors.
 */
async function getAvailableMcpServers(agentId, { dbClient = db, catalog } = {}) {
  const enabledIds = (await getAgentMcpServerIds(agentId, { dbClient })) || [];
  const connectedResult = await dbClient.query(
    "SELECT DISTINCT provider FROM integrations WHERE agent_id = $1 AND status = 'active'",
    [agentId],
  );
  const connected = new Set(connectedResult.rows.map((r) => r.provider));
  return loadMcpCatalog(catalog).map((entry) => ({
    provider: entry.provider,
    name: entry.name,
    npmPackage: entry.npmPackage,
    docsUrl: entry.docsUrl,
    notes: entry.notes,
    connected: connected.has(entry.provider),
    enabled: enabledIds.includes(entry.provider),
  }));
}

/**
 * Convert enabled providers and already-decrypted integration credentials into
 * runtime MCP entries, skipping providers without a usable catalog or token.
 *
 * @param {Object} [options={}] - Enabled ids, decrypted integrations, and catalog.
 * @returns {Array} Runtime MCP package and environment entries.
 */
function resolveMcpEntries({ enabledIds = [], integrationsByProvider = {}, catalog } = {}) {
  const byProvider = Object.fromEntries(loadMcpCatalog(catalog).map((e) => [e.provider, e]));
  const entries = [];
  for (const provider of normalizeEnabledIds(enabledIds)) {
    const cat = byProvider[provider];
    const mapping = SUPPORTED_MCP_PROVIDERS[provider];
    const integration = integrationsByProvider[provider];
    if (!cat || !mapping || !integration || !integration.token) continue;
    const env = { [mapping.primaryEnv]: integration.token };
    const config = integration.config || {};
    for (const [cfgKey, envVar] of Object.entries(mapping.configEnv || {})) {
      if (config[cfgKey]) env[envVar] = String(config[cfgKey]);
    }
    entries.push({ name: provider, npmPackage: cat.npmPackage, env });
  }
  return entries;
}

async function getEnabledMcpRuntimeState(
  agentId,
  { dbClient = db, integrationsModule = null, catalog } = {},
) {
  const enabledIds = (await getAgentMcpServerIds(agentId, { dbClient })) || [];
  // Always return the complete supported alias universe. Once an MCP server is
  // disabled its id disappears from enabledIds, but its previous managed alias
  // still has to be explicitly removed from an existing runtime.
  const managedEnvNames = getManagedMcpEnvNames();
  if (enabledIds.length === 0) {
    return { enabledIds, entries: [], desiredServers: {}, env: {}, managedEnvNames };
  }

  const active = await dbClient.query(
    "SELECT id, provider FROM integrations WHERE agent_id = $1 AND status = 'active'",
    [agentId],
  );
  const enabled = new Set(enabledIds);
  const integrationApi = integrationsModule || require("./integrations");
  const integrationsByProvider = {};
  for (const row of active.rows || []) {
    if (!enabled.has(row.provider) || integrationsByProvider[row.provider]) continue;
    const decrypted = await integrationApi.getDecryptedIntegration(row.id, agentId);
    if (!decrypted) continue;
    integrationsByProvider[row.provider] = {
      token: decrypted.access_token || "",
      config: decrypted.config || {},
    };
  }

  const entries = resolveMcpEntries({ enabledIds, integrationsByProvider, catalog });
  return {
    enabledIds,
    entries,
    desiredServers: buildMcpServersConfig(entries),
    env: buildMcpManagedEnv(entries),
    managedEnvNames,
  };
}

module.exports = {
  SUPPORTED_MCP_PROVIDERS,
  isSupportedProvider,
  loadMcpCatalog,
  normalizeEnabledIds,
  getManagedMcpEnvNames,
  getAgentMcpServerIds,
  setAgentMcpServerIds,
  getAvailableMcpServers,
  resolveMcpEntries,
  getEnabledMcpRuntimeState,
};
