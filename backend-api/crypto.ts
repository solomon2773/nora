// @ts-nocheck
// AES-256-GCM encryption for sensitive data at rest (integration tokens, etc.)

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
// Extract just the 64-char hex key — strip inline comments and whitespace
const RAW_KEY = (process.env.ENCRYPTION_KEY || "").split("#")[0].trim();
const ENCRYPTION_KEY = /^[0-9a-fA-F]{64}$/.test(RAW_KEY) ? RAW_KEY : null;

if (!ENCRYPTION_KEY) {
  console.error(
    "SECURITY WARNING: ENCRYPTION_KEY is not set or invalid. " +
    "Sensitive credential writes are blocked until encryption at rest is configured. " +
    "Set a 64-char hex key in .env to enable secure storage."
  );
}

function isEncryptionConfigured() {
  return Boolean(ENCRYPTION_KEY);
}

function ensureEncryptionConfigured(context = "Sensitive credential storage") {
  if (ENCRYPTION_KEY) return;
  const err = new Error(`${context} requires ENCRYPTION_KEY to be configured with a valid 64-char hex key`);
  err.statusCode = 503;
  throw err;
}

/**
 * Encrypt plaintext. Returns "iv:authTag:ciphertext" hex string.
 * If ENCRYPTION_KEY is not set, returns plaintext unchanged (callers should use
 * ensureEncryptionConfigured() before accepting new secret material).
 */
function encrypt(text) {
  if (!ENCRYPTION_KEY || !text) return text;
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt "iv:authTag:ciphertext" string back to plaintext.
 * If ENCRYPTION_KEY is not set or data doesn't look encrypted, returns as-is.
 */
function decrypt(data) {
  if (!ENCRYPTION_KEY || !data) return data;
  const parts = data.split(":");
  if (parts.length !== 3) return data; // not encrypted
  const [ivHex, authTagHex, encrypted] = parts;
  try {
    const key = Buffer.from(ENCRYPTION_KEY, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("Decryption failed (key mismatch or corrupted data):", err.message);
    return data; // return raw value so callers don't crash
  }
}

module.exports = { encrypt, decrypt, isEncryptionConfigured, ensureEncryptionConfigured };
