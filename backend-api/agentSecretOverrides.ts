// @ts-nocheck
// Stores per-agent environment overrides encrypted at rest. Decryption is
// opt-in for callers that explicitly request it.

const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");

function normalizeOverrideKey(rawKey) {
  const normalized = String(rawKey || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

function normalizeOverrideValue(rawValue) {
  if (rawValue == null) return null;
  const value = String(rawValue);
  return value ? value : null;
}

/**
 * Normalize an override map into non-empty environment keys and string values,
 * dropping invalid entries before persistence or migration export.
 *
 * @param {Object} [rawEntries={}] - Candidate environment override map.
 * @returns {Object} Normalized key/value map.
 */
function normalizeOverrideEntries(rawEntries = {}) {
  const entries = Object.entries(rawEntries || {})
    .map(([key, value]) => [normalizeOverrideKey(key), normalizeOverrideValue(value)])
    .filter(([key, value]) => key && value != null);

  return Object.fromEntries(entries);
}

/**
 * List encrypted overrides for an agent, decrypting values only when explicitly requested.
 *
 * @param {string} agentId - Agent whose overrides should be loaded.
 * @param {Object} [options={}] - Whether stored values should be decrypted.
 * @returns {Promise<Object>} Environment override map.
 */
async function listAgentSecretOverrides(agentId, { decryptValues = false } = {}) {
  const result = await db.query(
    `SELECT env_key, env_value
       FROM agent_secret_overrides
      WHERE agent_id = $1
      ORDER BY env_key ASC`,
    [agentId],
  );

  return result.rows.reduce((acc, row) => {
    acc[row.env_key] = decryptValues ? decrypt(row.env_value) : row.env_value;
    return acc;
  }, {});
}

async function getAgentSecretEnvVars(agentId) {
  return listAgentSecretOverrides(agentId, { decryptValues: true });
}

/**
 * Replace all overrides by deleting stored rows and sequentially inserting
 * normalized encrypted values; a failure can leave a partial replacement.
 *
 * @param {string} agentId - Agent whose overrides should be replaced.
 * @param {Object} [rawEntries={}] - Plaintext overrides to normalize and encrypt.
 * @returns {Promise<Object>} Normalized plaintext map supplied by the caller.
 */
async function replaceAgentSecretOverrides(agentId, rawEntries = {}) {
  const normalized = normalizeOverrideEntries(rawEntries);

  if (Object.keys(normalized).length === 0) {
    await db.query("DELETE FROM agent_secret_overrides WHERE agent_id = $1", [agentId]);
    return {};
  }

  ensureEncryptionConfigured("Agent secret override storage");
  const keys = Object.keys(normalized);

  await db.query("DELETE FROM agent_secret_overrides WHERE agent_id = $1", [agentId]);

  for (const [envKey, envValue] of Object.entries(normalized)) {
    await db.query(
      `INSERT INTO agent_secret_overrides(agent_id, env_key, env_value)
       VALUES($1, $2, $3)`,
      [agentId, envKey, encrypt(envValue)],
    );
  }

  return Object.fromEntries(keys.map((key) => [key, normalized[key]]));
}

module.exports = {
  getAgentSecretEnvVars,
  listAgentSecretOverrides,
  normalizeOverrideEntries,
  replaceAgentSecretOverrides,
};
