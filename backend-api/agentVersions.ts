// @ts-nocheck
// Per-agent configuration version history. Each row captures a snapshot of
// the agent's template_payload at a point in time; rollback restores a prior
// row and triggers the existing redeploy path.
//
// Version numbers are selected per agent inside a transaction. The database's
// UNIQUE(agent_id, version_number) constraint remains the final guard against
// concurrent writers choosing the same next number.

const db = require("./db");

const VALID_SOURCES = new Set([
  "edit",
  "deploy",
  "redeploy",
  "duplicate",
  "hub-install",
  "restore",
  "rollback",
]);

function serializeVersion(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    versionNumber: row.version_number,
    config: row.config || {},
    createdBy: row.created_by,
    message: row.message || null,
    source: row.source,
    createdAt: row.created_at,
  };
}

// Version persistence

/**
 * Persist the next numbered configuration snapshot for an agent in a transaction.
 *
 * @param {string} agentId - Agent whose configuration is being versioned.
 * @param {Object} config - Template payload snapshot to preserve.
 * @param {Object} [options={}] - Creator, message, and source metadata.
 * @returns {Promise<Object>} Persisted version record.
 */
async function recordVersion(
  agentId,
  config,
  { createdBy = null, message = null, source = "edit" } = {},
) {
  if (!agentId) throw new Error("agentId is required");
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Unknown agent version source: ${source}`);
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const next = await client.query(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM agent_versions WHERE agent_id = $1",
      [agentId],
    );
    const versionNumber = next.rows[0].n;
    const insert = await client.query(
      `INSERT INTO agent_versions (agent_id, version_number, config, created_by, message, source)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       RETURNING id, agent_id, version_number, config, created_by, message, source, created_at`,
      [agentId, versionNumber, JSON.stringify(config || {}), createdBy, message, source],
    );
    await client.query("COMMIT");
    return serializeVersion(insert.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a version without allowing persistence failure to reject the caller.
 *
 * @param {string} agentId - Agent whose configuration is being versioned.
 * @param {Object} config - Template payload snapshot to preserve.
 * @param {Object} [options={}] - Creator, message, and source metadata.
 * @returns {Promise<Object|null>} Persisted version, or `null` when recording fails.
 */
function recordVersionBestEffort(agentId, config, options = {}) {
  return Promise.resolve(recordVersion(agentId, config, options)).catch((err) => {
    console.error(`Failed to record agent version for ${agentId}:`, err.message);
    return null;
  });
}

// Version queries

/**
 * List an agent's newest versions first, clamping the requested limit to 1–200.
 *
 * @param {string} agentId - Agent whose version history should be returned.
 * @param {Object} [options={}] - Optional result limit.
 * @returns {Promise<Array>} Serialized version records.
 */
async function listVersions(agentId, { limit = 50 } = {}) {
  const result = await db.query(
    `SELECT id, agent_id, version_number, config, created_by, message, source, created_at
       FROM agent_versions
      WHERE agent_id = $1
      ORDER BY version_number DESC
      LIMIT $2`,
    [agentId, Math.max(1, Math.min(200, limit))],
  );
  return result.rows.map(serializeVersion);
}

/**
 * Load a version only when it belongs to the requested agent.
 *
 * @param {string} agentId - Agent expected to own the version.
 * @param {string} versionId - Version to retrieve.
 * @returns {Promise<Object|null>} Serialized version, or `null` when absent or out of scope.
 */
async function getVersion(agentId, versionId) {
  const result = await db.query(
    `SELECT id, agent_id, version_number, config, created_by, message, source, created_at
       FROM agent_versions
      WHERE agent_id = $1 AND id = $2`,
    [agentId, versionId],
  );
  return result.rows[0] ? serializeVersion(result.rows[0]) : null;
}

async function getLatestVersion(agentId) {
  const result = await db.query(
    `SELECT id, agent_id, version_number, config, created_by, message, source, created_at
       FROM agent_versions
      WHERE agent_id = $1
      ORDER BY version_number DESC
      LIMIT 1`,
    [agentId],
  );
  return result.rows[0] ? serializeVersion(result.rows[0]) : null;
}

module.exports = {
  VALID_SOURCES,
  getLatestVersion,
  getVersion,
  listVersions,
  recordVersion,
  recordVersionBestEffort,
  serializeVersion,
};
