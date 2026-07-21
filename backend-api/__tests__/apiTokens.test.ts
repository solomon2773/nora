// @ts-nocheck

const {
  PRIMARY_HASH_ENV,
  LEGACY_HASH_ENVS,
  apiKeyHashCandidates,
  apiKeyHashSecrets,
  extractBearerToken,
  generateRawKey,
  hashApiKey,
  hmac,
  keyPrefix,
  maskKeyPrefix,
} = require("../lib/apiTokens");

const VALID_32_CHAR_SECRET = "12345678901234567890123456789012";
const LEGACY_32_CHAR_SECRET = "abcdefghijklmnopqrstuvwxyz123456";

describe("apiTokens helpers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("extractBearerToken", () => {
    it("extracts token from Authorization: Bearer <token> header", () => {
      const req = {
        headers: {
          authorization: "Bearer nora_testtoken123",
        },
      };
      expect(extractBearerToken(req)).toBe("nora_testtoken123");
    });

    it("extracts token from capital Authorization header", () => {
      const req = {
        headers: {
          Authorization: "Bearer nora_testtoken456",
        },
      };
      expect(extractBearerToken(req)).toBe("nora_testtoken456");
    });

    it("falls back to x-api-key header when Bearer auth is not set", () => {
      const req = {
        headers: {
          "x-api-key": "nora_x_key_789",
        },
      };
      expect(extractBearerToken(req)).toBe("nora_x_key_789");
    });

    it("falls back to x-nora-api-key header when Bearer and x-api-key are absent", () => {
      const req = {
        headers: {
          "x-nora-api-key": "nora_explicit_key_000",
        },
      };
      expect(extractBearerToken(req)).toBe("nora_explicit_key_000");
    });

    it("returns empty string if no valid token headers are present", () => {
      expect(extractBearerToken({})).toBe("");
      expect(extractBearerToken({ headers: {} })).toBe("");
      expect(extractBearerToken({ headers: { authorization: "Basic dXNlcjpwYXNz" } })).toBe("");
      expect(extractBearerToken({ query: { api_key: "leaked_in_query" } })).toBe("");
    });
  });

  describe("keyPrefix & maskKeyPrefix", () => {
    it("slice keyPrefix to requested length (default 18)", () => {
      const key = "nora_1234567890abcdefghijklmnopqrstuvwxyz";
      expect(keyPrefix(key)).toBe("nora_1234567890abc");
      expect(keyPrefix(key, 8)).toBe("nora_123");
      expect(keyPrefix(null)).toBe("");
    });

    it("formats maskKeyPrefix with trailing ellipsis", () => {
      expect(maskKeyPrefix("nora_1234567890abc")).toBe("nora_1234567890abc...");
      expect(maskKeyPrefix("")).toBe("");
      expect(maskKeyPrefix(null)).toBe("");
    });
  });

  describe("generateRawKey", () => {
    it("generates random key with default nora_ prefix", () => {
      const key = generateRawKey();
      expect(key.startsWith("nora_")).toBe(true);
      expect(key.length).toBeGreaterThan(35);
    });

    it("supports custom prefix", () => {
      const key = generateRawKey("custom_");
      expect(key.startsWith("custom_")).toBe(true);
    });
  });

  describe("apiKeyHashSecrets & secret validation", () => {
    it("returns test fallback secret when no env vars are set and NODE_ENV=test", () => {
      delete process.env[PRIMARY_HASH_ENV];
      LEGACY_HASH_ENVS.forEach((key) => delete process.env[key]);
      process.env.NODE_ENV = "test";

      const secrets = apiKeyHashSecrets();
      expect(secrets).toEqual(["nora-api-key-test-hash-secret"]);
    });

    it("throws error if primary hash secret is less than 32 characters", () => {
      process.env[PRIMARY_HASH_ENV] = "too-short-secret";
      expect(() => apiKeyHashSecrets()).toThrow("NORA_API_KEY_HASH_SECRET must be at least 32 characters");
    });

    it("includes legacy hash secrets when requested", () => {
      process.env[PRIMARY_HASH_ENV] = VALID_32_CHAR_SECRET;
      process.env["ENCRYPTION_KEY"] = LEGACY_32_CHAR_SECRET;

      const secrets = apiKeyHashSecrets({ includeLegacy: true });
      expect(secrets).toContain(VALID_32_CHAR_SECRET);
      expect(secrets).toContain(LEGACY_32_CHAR_SECRET);
    });
  });

  describe("apiKeyHashCandidates & hashApiKey", () => {
    it("hashApiKey produces deterministic HMAC-SHA256 hex string", () => {
      process.env[PRIMARY_HASH_ENV] = VALID_32_CHAR_SECRET;
      const key = "nora_test_sample_key";
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("apiKeyHashCandidates returns candidates in canonical-first order without duplicates", () => {
      process.env[PRIMARY_HASH_ENV] = VALID_32_CHAR_SECRET;
      process.env["JWT_SECRET"] = LEGACY_32_CHAR_SECRET;

      const candidates = apiKeyHashCandidates("nora_test_sample_key");
      expect(candidates.length).toBe(2);
      expect(candidates[0]).toBe(hmac("nora_test_sample_key", VALID_32_CHAR_SECRET));
      expect(candidates[1]).toBe(hmac("nora_test_sample_key", LEGACY_32_CHAR_SECRET));
    });
  });
});
