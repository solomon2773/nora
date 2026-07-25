// @ts-nocheck
const crypto = require("crypto");
const db = require("./db");

const KEY_PREFIX = "nora_hub_";
const KEY_STATUS_ACTIVE = "active";
const KEY_STATUS_REVOKED = "revoked";
const HASH_SECRET_ENV_NAME = "NORA_AGENT_HUB_API_KEY_HASH_SECRET";
const LEGACY_HASH_SECRET_ENV_NAMES = ["ENCRYPTION_KEY", "JWT_SECRET"];

function normalizeLabel(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (normalized || "Nora installation").slice(0, 120);
}

function generateRawKey() {
  return `${KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function buildMissingSecretError(message) {
  const error = new Error(
    message ||
      "Agent Hub API key hashing requires NORA_AGENT_HUB_API_KEY_HASH_SECRET, ENCRYPTION_KEY, or JWT_SECRET",
  );
  error.statusCode = 503;
  return error;
}

function normalizeSecret(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= 32 ? normalized : "";
}

function explicitHashSecret() {
  const rawSecret = process.env[HASH_SECRET_ENV_NAME];
  const trimmed = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (trimmed && trimmed.length < 32) {
    throw buildMissingSecretError(
      "Agent Hub API key hashing requires NORA_AGENT_HUB_API_KEY_HASH_SECRET to be at least 32 characters",
    );
  }
  return normalizeSecret(rawSecret);
}

function testHashSecret() {
  if (process.env.NODE_ENV === "test") return "nora-agent-hub-api-key-test-hash-secret";
  return "";
}

function addUniqueSecret(secrets, secret) {
  if (secret && !secrets.includes(secret)) secrets.push(secret);
}

/**
 * Resolve the primary HMAC secret and, during verification, legacy secrets used
 * before key rotation; production fails closed when no strong secret exists.
 *
 * @param {Object} [options={}] - Whether legacy secret candidates are included.
 * @returns {Array} Ordered unique hashing secrets.
 */
function apiKeyHashSecrets({ includeLegacy = false } = {}) {
  const secrets = [];
  addUniqueSecret(secrets, explicitHashSecret());

  if (includeLegacy || secrets.length === 0) {
    for (const envName of LEGACY_HASH_SECRET_ENV_NAMES) {
      addUniqueSecret(secrets, normalizeSecret(process.env[envName]));
    }
  }

  if (secrets.length === 0) addUniqueSecret(secrets, testHashSecret());
  if (secrets.length > 0) return secrets;
  throw buildMissingSecretError();
}

function apiKeyHashSecret() {
  return apiKeyHashSecrets()[0];
}

// HMAC-SHA256 is correct for high-entropy random tokens (see lib/apiTokens.ts
// for the full rationale). CodeQL flags this as `js/insufficient-password-hash`
// but the input is a 256-bit random token, not a password — there is no
// offline brute-force surface.
function hmacHashApiKey(rawKey, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(String(rawKey || ""), "utf8")
    .digest("hex");
}

// Plain SHA-256, kept only to verify hashes written before the HMAC migration.
// Any legacy hit triggers a rehash to the HMAC scheme on the next login.
function legacySha256HashApiKey(rawKey) {
  return crypto
    .createHash("sha256")
    .update(String(rawKey || ""), "utf8")
    .digest("hex");
}

function hashApiKey(rawKey) {
  return hmacHashApiKey(rawKey, apiKeyHashSecret());
}

function apiKeyHashCandidates(rawKey) {
  const hashes = [];
  const addUniqueHash = (hash) => {
    if (hash && !hashes.includes(hash)) hashes.push(hash);
  };

  for (const secret of apiKeyHashSecrets({ includeLegacy: true })) {
    addUniqueHash(hmacHashApiKey(rawKey, secret));
  }
  addUniqueHash(legacySha256HashApiKey(rawKey));
  return hashes;
}

function keyPrefix(rawKey) {
  return String(rawKey || "").slice(0, 18);
}

function maskKeyPrefix(prefix) {
  const normalized = String(prefix || "").trim();
  return normalized ? `${normalized}...` : "";
}

function serializeApiKey(row = {}) {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    maskedKey: maskKeyPrefix(row.key_prefix),
    status: row.status || KEY_STATUS_ACTIVE,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function extractApiKey(req) {
  const explicitHeader =
    req.headers["x-agent-hub-api-key"] || req.headers["x-api-key"] || req.headers["api-key"];
  if (explicitHeader) return String(explicitHeader).trim();

  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const [scheme, token] = String(authHeader).split(" ");
  if (scheme === "Bearer" && token) return token.trim();
  return "";
}

/**
 * Create a high-entropy Agent Hub API key, storing only its HMAC hash and
 * returning the raw key once in the creation response.
 *
 * @param {string} userId - User who owns the key.
 * @param {string} label - Human-readable key label.
 * @returns {Promise<Object>} Serialized key plus its one-time raw value.
 */
async function createApiKey(userId, label) {
  if (!userId) {
    const error = new Error("userId is required");
    error.statusCode = 400;
    throw error;
  }

  const rawKey = generateRawKey();
  const result = await db.query(
    `INSERT INTO agent_hub_api_keys(user_id, label, key_hash, key_prefix, status)
     VALUES($1, $2, $3, $4, $5)
     RETURNING id, label, key_prefix, status, created_at, last_used_at, revoked_at`,
    [userId, normalizeLabel(label), hashApiKey(rawKey), keyPrefix(rawKey), KEY_STATUS_ACTIVE],
  );

  return {
    ...serializeApiKey(result.rows[0]),
    apiKey: rawKey,
  };
}

async function listApiKeys(userId) {
  const result = await db.query(
    `SELECT id, label, key_prefix, status, created_at, last_used_at, revoked_at
       FROM agent_hub_api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(serializeApiKey);
}

async function revokeApiKey(keyId, userId) {
  const result = await db.query(
    `UPDATE agent_hub_api_keys
        SET status = $1,
            revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $2
        AND user_id = $3
      RETURNING id, label, key_prefix, status, created_at, last_used_at, revoked_at`,
    [KEY_STATUS_REVOKED, keyId, userId],
  );
  return result.rows[0] ? serializeApiKey(result.rows[0]) : null;
}

/**
 * Verify an active key against current and legacy hashes, transparently
 * rehashing legacy matches and updating last-used time.
 *
 * @param {string} rawKey - Presented Agent Hub API key.
 * @returns {Promise<Object|null>} Authenticated key and publisher, or `null`.
 */
async function verifyApiKey(rawKey) {
  const normalized = String(rawKey || "").trim();
  if (!normalized) return null;

  const candidateHashes = apiKeyHashCandidates(normalized);
  const primaryHash = hashApiKey(normalized);
  const result = await db.query(
    `SELECT k.id,
            k.user_id,
            k.label,
            k.key_hash,
            k.key_prefix,
            k.status,
            k.created_at,
            k.last_used_at,
            k.revoked_at,
            u.email,
            u.name,
            u.avatar,
            u.role
       FROM agent_hub_api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ANY($1::text[])
        AND k.status = $2
        AND k.revoked_at IS NULL
      ORDER BY CASE WHEN k.key_hash = $3 THEN 0 ELSE 1 END
      LIMIT 1`,
    [candidateHashes, KEY_STATUS_ACTIVE, primaryHash],
  );

  const row = result.rows[0];
  if (!row) return null;

  if (row.key_hash && row.key_hash !== primaryHash) {
    await db.query(
      "UPDATE agent_hub_api_keys SET key_hash = $1, last_used_at = NOW() WHERE id = $2",
      [primaryHash, row.id],
    );
  } else {
    await db.query("UPDATE agent_hub_api_keys SET last_used_at = NOW() WHERE id = $1", [row.id]);
  }

  return {
    key: serializeApiKey(row),
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      avatar: row.avatar,
      role: row.role,
    },
  };
}

/**
 * Authenticate an Agent Hub API request and attach its key and publisher context.
 *
 * @param {Object} req - Express request containing a supported API-key header.
 * @param {Object} res - Express response used for authentication failures.
 * @param {Function} next - Express continuation.
 * @returns {Promise<void>} Resolves after authentication or error forwarding.
 */
async function requireAgentHubApiKey(req, res, next) {
  try {
    const rawKey = extractApiKey(req);
    if (!rawKey) {
      return res.status(401).json({
        error: "Agent Hub API key required",
        code: "agent_hub_api_key_required",
      });
    }

    const verified = await verifyApiKey(rawKey);
    if (!verified) {
      return res.status(401).json({
        error: "Invalid Agent Hub API key",
        code: "agent_hub_api_key_invalid",
      });
    }

    req.agentHubApiKey = verified.key;
    req.agentHubPublisher = verified.user;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  KEY_PREFIX,
  KEY_STATUS_ACTIVE,
  KEY_STATUS_REVOKED,
  createApiKey,
  extractApiKey,
  hashApiKey,
  listApiKeys,
  maskKeyPrefix,
  requireAgentHubApiKey,
  revokeApiKey,
  verifyApiKey,
};
