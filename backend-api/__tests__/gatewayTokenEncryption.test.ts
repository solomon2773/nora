// @ts-nocheck
// Verifies agents.gateway_token is encrypted at rest (AES-256-GCM) and
// transparently decrypted on read. The repo's jest env sets no ENCRYPTION_KEY,
// so crypto is a no-op by default; these tests set a key explicitly (and reset
// modules) because crypto.ts reads the key once at module-load time.

const VALID_KEY = "a".repeat(64); // 64 hex chars → AES-256-GCM

describe("gateway_token encryption at rest", () => {
  let originalKey;
  beforeAll(() => {
    originalKey = process.env.ENCRYPTION_KEY;
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    jest.resetModules();
  });

  describe("with ENCRYPTION_KEY configured", () => {
    let crypto;
    beforeEach(() => {
      jest.resetModules();
      jest.dontMock("../db");
      process.env.ENCRYPTION_KEY = VALID_KEY;
      crypto = require("../crypto");
    });

    it("encrypt() produces a 3-part iv:tag:ciphertext blob distinct from the token", () => {
      const token = "0123456789abcdef0123456789abcdef"; // 32-hex gateway token
      const enc = crypto.encrypt(token);
      expect(enc).not.toBe(token);
      expect(enc.split(":")).toHaveLength(3);
    });

    it("decrypt(encrypt(token)) round-trips for both 32- and 64-char hex tokens", () => {
      const short = "deadbeef".repeat(4); // 32 hex chars (NemoClaw)
      const long = "deadbeef".repeat(8); // 64 hex chars (Docker/Hermes/Proxmox/k8s)
      expect(crypto.decrypt(crypto.encrypt(short))).toBe(short);
      expect(crypto.decrypt(crypto.encrypt(long))).toBe(long);
    });

    it("decrypt() passes a legacy plaintext (colon-free hex) token through unchanged", () => {
      // Existing rows are plaintext hex; the lazy (no-migration) design relies on
      // decrypt() being a safe no-op for them until the next redeploy re-encrypts.
      const legacy = "0123456789abcdef0123456789abcdef";
      expect(crypto.decrypt(legacy)).toBe(legacy);
    });

    it("runtimeAuthHeaders decrypts an encrypted gateway_token into the Bearer header", async () => {
      jest.doMock("../db", () => ({ query: jest.fn() }));
      const { runtimeAuthHeaders } = require("../runtimeAuth");
      const token = "feedface".repeat(8);
      const headers = await runtimeAuthHeaders({
        id: "a1",
        gateway_token: crypto.encrypt(token),
        deploy_target: "docker",
      });
      expect(headers.Authorization).toBe(`Bearer ${token}`);
    });

    it("runtimeAuthHeaders passes a legacy plaintext token through (no regression)", async () => {
      jest.doMock("../db", () => ({ query: jest.fn() }));
      const { runtimeAuthHeaders } = require("../runtimeAuth");
      const legacy = "abc123".repeat(6);
      const headers = await runtimeAuthHeaders({
        id: "a1",
        gateway_token: legacy,
        deploy_target: "docker",
      });
      expect(headers.Authorization).toBe(`Bearer ${legacy}`);
    });

    it("runtimeAuthHeaders falls back to the DB and decrypts when the agent omits the token", async () => {
      const token = "0a1b2c3d".repeat(8);
      const encrypted = crypto.encrypt(token);
      jest.doMock("../db", () => ({
        query: jest
          .fn()
          .mockResolvedValue({ rows: [{ gateway_token: encrypted, deploy_target: "docker" }] }),
      }));
      const { runtimeAuthHeaders } = require("../runtimeAuth");
      const headers = await runtimeAuthHeaders({ id: "a1" });
      expect(headers.Authorization).toBe(`Bearer ${token}`);
    });
  });

  describe("without ENCRYPTION_KEY (keyless dev/test — lazy, no migration)", () => {
    let crypto;
    beforeEach(() => {
      jest.resetModules();
      delete process.env.ENCRYPTION_KEY;
      crypto = require("../crypto");
    });

    it("encrypt()/decrypt() are no-ops so existing plaintext rows are unaffected", () => {
      const token = "0123456789abcdef0123456789abcdef";
      expect(crypto.encrypt(token)).toBe(token);
      expect(crypto.decrypt(token)).toBe(token);
    });
  });
});
