// @ts-nocheck

const { scanTemplatePayloadForSecrets } = require("../agentHubSafety");

function toBase64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

describe("agentHubSafety - scanTemplatePayloadForSecrets", () => {
  describe("basic & empty payload handling", () => {
    it("returns empty array when called with no arguments or empty payload", () => {
      expect(scanTemplatePayloadForSecrets()).toEqual([]);
      expect(scanTemplatePayloadForSecrets({})).toEqual([]);
      expect(scanTemplatePayloadForSecrets({ files: [], memoryFiles: [] })).toEqual([]);
    });

    it("returns empty array for safe, non-sensitive template files", () => {
      const payload = {
        files: [
          { path: "README.md", contentBase64: toBase64("# My Agent\nSafe content") },
          { path: "config.json", contentBase64: toBase64('{"appName": "nora-agent"}') },
          { path: "src/index.js", contentBase64: toBase64("console.log('Hello world');") },
        ],
        memoryFiles: [
          { path: "MEMORY.md", contentBase64: toBase64("Agent long term memory notes.") },
        ],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toEqual([]);
    });

    it("handles invalid or non-base64 content without throwing", () => {
      const payload = {
        files: [
          { path: "corrupt.txt", contentBase64: null },
          { path: "empty.txt", contentBase64: "" },
          { path: "invalid.txt", contentBase64: undefined },
        ],
      };

      expect(() => scanTemplatePayloadForSecrets(payload)).not.toThrow();
      expect(scanTemplatePayloadForSecrets(payload)).toEqual([]);
    });
  });

  describe("sensitive file path detection", () => {
    const sensitivePathCases = [
      { path: ".env", label: "root .env file" },
      { path: "backend/.env", label: "nested .env file" },
      { path: ".env.production", label: ".env with extension suffix" },
      { path: ".env.local", label: ".env.local file" },
      { path: "auth-profiles.json", label: "auth-profiles.json" },
      { path: "secrets/auth-profiles.json", label: "nested auth-profiles.json" },
      { path: "server.pem", label: ".pem certificate" },
      { path: "id_rsa.key", label: ".key private key file" },
      { path: "cert.p12", label: ".p12 PKCS#12 file" },
      { path: "bundle.pfx", label: ".pfx bundle file" },
      { path: "my_credential_data.json", label: "credential keyword with json" },
      { path: "app_secret.yaml", label: "secret keyword with yaml" },
      { path: "api_token.txt", label: "token keyword with txt" },
      { path: "prod-credentials.env", label: "credential keyword with env" },
    ];

    test.each(sensitivePathCases)("flags sensitive path for $label ($path)", ({ path }) => {
      const payload = {
        files: [{ path, contentBase64: toBase64("some content") }],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toContainEqual({
        path,
        type: "sensitive_path",
        message:
          "Remove secret-bearing files such as .env, key, or credential files before publishing.",
      });
    });

    it("does not flag ordinary file paths containing partial substrings safely", () => {
      const payload = {
        files: [
          { path: "environment.js", contentBase64: toBase64("module.exports = {};") },
          { path: "src/keypad.ts", contentBase64: toBase64("export const keypad = 1;") },
          { path: "tokenizer.js", contentBase64: toBase64("function tokenize() {}") },
          { path: "secretary.png", contentBase64: toBase64("fake_image_data") },
        ],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toEqual([]);
    });
  });

  describe("private key detection", () => {
    const privateKeyHeaders = [
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ];

    test.each(privateKeyHeaders)("flags private key content starting with %s", (header) => {
      const keyContent = `${header}\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----`;
      const payload = {
        files: [{ path: "config.txt", contentBase64: toBase64(keyContent) }],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toContainEqual({
        path: "config.txt",
        type: "private_key",
        message: "Private key material was detected in this template.",
      });
    });
  });

  describe("high-confidence API token patterns", () => {
    const tokenCases = [
      { name: "OpenAI API Key", sample: "sk-abcdef1234567890" },
      { name: "GitHub Personal Access Token (classic)", sample: "ghp_abcdef1234567890" },
      { name: "GitHub OAuth Access Token", sample: "gho_abcdef1234567890" },
      {
        name: "GitHub Fine-Grained Token",
        sample: "github_pat_11AAAAAAA01234567890abcdefABCDEF123456",
      },
      { name: "Slack Bot Token", sample: "xoxb-1234567890-abcdefghij" },
      { name: "Slack User Token", sample: "xoxp-1234567890-abcdefghij" },
      { name: "AWS Access Key ID", sample: "AKIAIOSFODNN7EXAMPLE" },
    ];

    test.each(tokenCases)("flags high-confidence token: $name", ({ sample }) => {
      const payload = {
        files: [
          {
            path: "agent-config.json",
            contentBase64: toBase64(`const client = new Client({ token: "${sample}" });`),
          },
        ],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toContainEqual({
        path: "agent-config.json",
        type: "access_token",
        message: "A high-confidence API token or access key was detected in this template.",
      });
    });
  });

  describe("JWT token detection", () => {
    it("flags JWT-like tokens", () => {
      const sampleJwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const payload = {
        files: [
          {
            path: "session.json",
            contentBase64: toBase64(`{"token": "${sampleJwt}"}`),
          },
        ],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toContainEqual({
        path: "session.json",
        type: "jwt",
        message: "A JWT-like token was detected in this template.",
      });
    });
  });

  describe("secret-like assignments and placeholder suppression", () => {
    const realSecretAssignments = [
      { line: 'api_key: "live_production_secret_key_8888"', label: "api_key colon string" },
      { line: "apiKey = 'live_production_secret_key_8888'", label: "apiKey equals string" },
      { line: 'access_token: "live_access_token_value_9999"', label: "access_token" },
      { line: 'password: "superSecretPassword123!"', label: "password" },
      { line: 'private_key: "secretKeyDataRaw12345"', label: "private_key" },
    ];

    test.each(realSecretAssignments)("flags real assignment: $label", ({ line }) => {
      const payload = {
        files: [{ path: "app.config", contentBase64: toBase64(line) }],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toContainEqual({
        path: "app.config",
        type: "secret_assignment",
        message: "A secret-like key assignment was detected in this template.",
      });
    });

    const placeholderAssignments = [
      { line: 'api_key: "your_api_key_here"', label: "your_ prefix" },
      { line: 'apiKey = "example_secret_token"', label: "example prefix" },
      { line: 'token: "sample_token_value"', label: "sample prefix" },
      { line: 'password: "placeholder_password"', label: "placeholder prefix" },
      { line: 'secret: "changeme_value"', label: "changeme prefix" },
      { line: 'api_key: "replace-me-12345"', label: "replace-me prefix" },
      { line: 'api_key: "test-token-value"', label: "test- prefix" },
      { line: 'api_key: "demo-token-value"', label: "demo- prefix" },
      { line: 'api_key: "<YOUR_API_KEY>"', label: "angle brackets template tag" },
      { line: 'api_key: "{{ENV_SECRET}}"', label: "mustache template tag" },
    ];

    test.each(placeholderAssignments)("suppresses placeholder assignment: $label", ({ line }) => {
      const payload = {
        files: [{ path: "app.config", contentBase64: toBase64(line) }],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toEqual([]);
    });
  });

  describe("issue cap behavior (max 10 issues)", () => {
    it("caps reported issues at a maximum of 10", () => {
      const files = [];
      for (let i = 1; i <= 15; i++) {
        files.push({
          path: `secrets/file_${i}.env`,
          contentBase64: toBase64(`api_key: "real_secret_value_${i}_12345"`),
        });
      }

      const payload = { files };
      const issues = scanTemplatePayloadForSecrets(payload);

      expect(issues.length).toBe(10);
    });
  });

  describe("memoryFiles scanning", () => {
    it("scans memoryFiles alongside regular files", () => {
      const payload = {
        files: [{ path: "README.md", contentBase64: toBase64("# Safe readme") }],
        memoryFiles: [
          {
            path: "sensitive_memory.key",
            contentBase64: toBase64("-----BEGIN RSA PRIVATE KEY-----\nMIIE..."),
          },
        ],
      };

      const issues = scanTemplatePayloadForSecrets(payload);
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "sensitive_memory.key", type: "sensitive_path" }),
          expect.objectContaining({ path: "sensitive_memory.key", type: "private_key" }),
        ]),
      );
    });
  });
});
