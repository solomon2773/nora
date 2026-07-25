// Pure functions for encrypting / decrypting / redacting / stripping
// sensitive fields inside an integration's `config` blob. The caller
// supplies the crypto primitives and a function that resolves which
// catalog keys are sensitive — keeping this module decoupled from the
// catalog JSON and from `backend-api/crypto.ts` directly.

import type { ConfigBlob } from "../types/integration";

const SECRET_CONFIG_KEY_RE =
  /(token|secret|password|api[_-]?key|private[_-]?key|service[_-]?account|credentials?)/i;
const REDACTED_SECRET = "[REDACTED]";

export interface SecretEncryptionDeps {
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  getSensitiveConfigKeys: (provider: string) => Set<string>;
}

export interface SecretEncryption {
  encryptSensitiveConfig(
    provider: string,
    config?: ConfigBlob,
  ): { secured: Record<string, unknown>; hasSensitiveMaterial: boolean };
  decryptSensitiveConfig(provider: string, config?: ConfigBlob): Record<string, unknown>;
  redactSensitiveConfig(provider: string, config?: ConfigBlob): Record<string, unknown>;
  stripSensitiveConfig(
    provider: string,
    config?: ConfigBlob,
  ): { config: Record<string, unknown>; removedSensitive: boolean };
}

function parseConfig(config: ConfigBlob): Record<string, any> {
  if (typeof config === "string") {
    try {
      return JSON.parse(config);
    } catch {
      return {};
    }
  }
  return (config as Record<string, any>) || {};
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string, path: string, sensitiveKeys: Set<string>): boolean {
  return (
    sensitiveKeys.has(key) ||
    sensitiveKeys.has(path) ||
    SECRET_CONFIG_KEY_RE.test(key) ||
    SECRET_CONFIG_KEY_RE.test(path)
  );
}

function transformObject(
  value: unknown,
  sensitiveKeys: Set<string>,
  onSensitive: (rawValue: unknown, key: string, path: string) => unknown,
  onTouched?: () => void,
  currentPath = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      transformObject(entry, sensitiveKeys, onSensitive, onTouched, `${currentPath}.${index}`),
    );
  }
  if (!isPlainObject(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = currentPath ? `${currentPath}.${key}` : key;
    if (isPlainObject(child) || Array.isArray(child)) {
      next[key] = transformObject(child, sensitiveKeys, onSensitive, onTouched, path);
      continue;
    }
    if (child && isSensitiveKey(key, path, sensitiveKeys)) {
      onTouched?.();
      next[key] = onSensitive(child, key, path);
      continue;
    }
    next[key] = child;
  }
  return next;
}

/**
 * Create recursive config encryption, decryption, redaction, and stripping helpers.
 *
 * Sensitivity combines catalog paths with secret-name heuristics; malformed JSON config becomes
 * an empty object rather than exposing or transforming raw text.
 *
 * @param {Object} deps - Crypto primitives and catalog sensitivity resolver.
 * @returns {Object} Provider-aware secret transformations.
 */
export function createSecretEncryption(deps: SecretEncryptionDeps): SecretEncryption {
  const { encrypt, decrypt, getSensitiveConfigKeys } = deps;

  return {
    encryptSensitiveConfig(provider, config = {}) {
      const plain = parseConfig(config);
      const sensitiveKeys = getSensitiveConfigKeys(provider);
      let hasSensitiveMaterial = false;
      const secured = transformObject(
        plain,
        sensitiveKeys,
        (rawValue) => encrypt(String(rawValue)),
        () => {
          hasSensitiveMaterial = true;
        },
      ) as Record<string, unknown>;

      return { secured, hasSensitiveMaterial };
    },

    decryptSensitiveConfig(provider, config = {}) {
      const parsed = parseConfig(config);
      const sensitiveKeys = getSensitiveConfigKeys(provider);
      return transformObject(parsed, sensitiveKeys, (rawValue) =>
        decrypt(String(rawValue)),
      ) as Record<string, unknown>;
    },

    redactSensitiveConfig(provider, config = {}) {
      const parsed = parseConfig(config);
      const sensitiveKeys = getSensitiveConfigKeys(provider);
      return transformObject(parsed, sensitiveKeys, (rawValue) =>
        rawValue ? REDACTED_SECRET : rawValue,
      ) as Record<string, unknown>;
    },

    stripSensitiveConfig(provider, config = {}) {
      const parsed = parseConfig(config);
      const sensitiveKeys = getSensitiveConfigKeys(provider);
      let removedSensitive = false;
      const stripped = transformObject(
        parsed,
        sensitiveKeys,
        (rawValue) => (rawValue ? null : rawValue),
        () => {
          removedSensitive = true;
        },
      ) as Record<string, unknown>;

      return { config: stripped, removedSensitive };
    },
  };
}

export { SECRET_CONFIG_KEY_RE, REDACTED_SECRET };
