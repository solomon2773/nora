// @ts-nocheck
// Workspace-scoped API keys (Phase 1 of public REST API). Tokens are issued
// against a workspace and carry a scope list; verification yields the workspace
// row plus the issuing user. Scopes are cumulative — if a key has "agents:read"
// it cannot mutate, even if the issuing user is an owner.

const db = require("./db");
const {
  apiKeyHashCandidates,
  generateRawKey,
  hashApiKey,
  keyPrefix,
  maskKeyPrefix,
} = require("./lib/apiTokens");

const KEY_TOKEN_PREFIX = "nora_";
const KEY_STATUS_ACTIVE = "active";
const KEY_STATUS_REVOKED = "revoked";

// Recognized v1 scopes. Listing them centrally keeps the public docs and
// runtime validation in sync.
const SCOPE_DEFINITIONS = [
  { value: "agents:read", description: "Read agents in the workspace" },
  { value: "agents:write", description: "Create, update, and operate agents" },
  { value: "workspaces:read", description: "Read workspace metadata and members" },
  { value: "monitoring:read", description: "Read monitoring metrics and events" },
  { value: "integrations:read", description: "Read integration configurations" },
  { value: "integrations:write", description: "Create and remove integrations" },
  {
    value: "admin:read",
    description: "Run read-only platform diagnostics as an issuing platform admin",
  },
];

const KNOWN_SCOPES = new Set(SCOPE_DEFINITIONS.map((entry) => entry.value));

// Input normalization and serialization

function normalizeLabel(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (normalized || "API key").slice(0, 120);
}

function normalizeScopes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!KNOWN_SCOPES.has(trimmed)) {
      const error = new Error(`Unknown API scope: ${trimmed}`);
      error.statusCode = 400;
      throw error;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function serializeApiKey(row = {}) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    label: row.label,
    keyPrefix: row.key_prefix,
    maskedKey: maskKeyPrefix(row.key_prefix),
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    status: row.status || KEY_STATUS_ACTIVE,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

// Key lifecycle and verification

/**
 * Issue a workspace-scoped key with validated scopes, storing only its hash
 * and returning the raw token once in the creation response.
 *
 * @param {string} workspaceId - Workspace that permanently binds the key.
 * @param {string|null} createdBy - User issuing the key.
 * @param {Object} [input={}] - Label, scopes, and optional expiration.
 * @returns {Promise<Object>} Serialized key metadata plus the one-time raw key.
 */
async function createApiKey(workspaceId, createdBy, { label, scopes, expiresAt } = {}) {
  if (!workspaceId) {
    const error = new Error("workspaceId is required");
    error.statusCode = 400;
    throw error;
  }
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.length === 0) {
    const error = new Error("At least one scope is required");
    error.statusCode = 400;
    throw error;
  }
  const rawKey = generateRawKey(KEY_TOKEN_PREFIX);
  const result = await db.query(
    `INSERT INTO api_keys (workspace_id, created_by, label, key_hash, key_prefix, scopes, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, workspace_id, created_by, label, key_prefix, scopes, status,
               created_at, last_used_at, revoked_at, expires_at`,
    [
      workspaceId,
      createdBy || null,
      normalizeLabel(label),
      hashApiKey(rawKey),
      keyPrefix(rawKey),
      JSON.stringify(normalizedScopes),
      KEY_STATUS_ACTIVE,
      expiresAt || null,
    ],
  );
  return { ...serializeApiKey(result.rows[0]), apiKey: rawKey };
}

async function listApiKeys(workspaceId) {
  const result = await db.query(
    `SELECT id, workspace_id, created_by, label, key_prefix, scopes, status,
            created_at, last_used_at, revoked_at, expires_at
       FROM api_keys
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(serializeApiKey);
}

/**
 * Revoke a key only within its bound workspace, preserving the first revocation time.
 *
 * @param {string} keyId - Key to revoke.
 * @param {string} workspaceId - Workspace that must own the key.
 * @returns {Promise<Object|null>} Revoked key, or `null` when not found in the workspace.
 */
async function revokeApiKey(keyId, workspaceId) {
  const result = await db.query(
    `UPDATE api_keys
        SET status = $1,
            revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $2 AND workspace_id = $3
      RETURNING id, workspace_id, created_by, label, key_prefix, scopes, status,
                created_at, last_used_at, revoked_at, expires_at`,
    [KEY_STATUS_REVOKED, keyId, workspaceId],
  );
  return result.rows[0] ? serializeApiKey(result.rows[0]) : null;
}

/**
 * Verify an active, unexpired raw key and return its key, workspace, and issuing
 * user context. Successful verification updates usage time and rotates legacy hashes.
 *
 * @param {string} rawKey - Presented Nora API key.
 * @returns {Promise<Object|null>} Authentication context, or `null` when invalid.
 */
async function verifyApiKey(rawKey) {
  const normalized = String(rawKey || "").trim();
  if (!normalized) return null;
  const candidates = apiKeyHashCandidates(normalized);
  const primaryHash = hashApiKey(normalized);
  const result = await db.query(
    `SELECT k.id, k.workspace_id, k.created_by, k.label, k.key_hash, k.key_prefix,
            k.scopes, k.status, k.created_at, k.last_used_at, k.revoked_at, k.expires_at,
            w.name AS workspace_name,
            u.email AS user_email,
            u.role AS user_role,
            u.name AS user_name
       FROM api_keys k
       JOIN workspaces w ON w.id = k.workspace_id
       JOIN users u ON u.id = k.created_by
       JOIN workspace_members issuer_membership
         ON issuer_membership.workspace_id = k.workspace_id
        AND issuer_membership.user_id = k.created_by
      WHERE k.key_hash = ANY($1::text[])
        AND k.status = $2
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > NOW())
      ORDER BY CASE WHEN k.key_hash = $3 THEN 0 ELSE 1 END
      LIMIT 1`,
    [candidates, KEY_STATUS_ACTIVE, primaryHash],
  );
  const row = result.rows[0];
  if (!row?.created_by) return null;

  if (row.key_hash && row.key_hash !== primaryHash) {
    await db.query("UPDATE api_keys SET key_hash = $1, last_used_at = NOW() WHERE id = $2", [
      primaryHash,
      row.id,
    ]);
  } else {
    await db.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [row.id]);
  }

  return {
    key: serializeApiKey(row),
    workspace: { id: row.workspace_id, name: row.workspace_name || null },
    user: row.created_by
      ? {
          id: row.created_by,
          email: row.user_email || null,
          name: row.user_name || null,
          role: row.user_role || null,
        }
      : null,
  };
}

function keyHasScope(key, requiredScope) {
  if (!key || !Array.isArray(key.scopes)) return false;
  return key.scopes.includes(requiredScope);
}

module.exports = {
  KEY_TOKEN_PREFIX,
  KEY_STATUS_ACTIVE,
  KEY_STATUS_REVOKED,
  KNOWN_SCOPES,
  SCOPE_DEFINITIONS,
  createApiKey,
  keyHasScope,
  listApiKeys,
  normalizeScopes,
  revokeApiKey,
  serializeApiKey,
  verifyApiKey,
};
