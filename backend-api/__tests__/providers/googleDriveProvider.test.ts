// @ts-nocheck
const { googleDriveProvider } = require("../../integrations/providers/googleDrive");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

const validSa = JSON.stringify({
  client_email: "agent@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  project_id: "p",
});

describe("googleDriveProvider", () => {
  it("identifies as google-drive / service_account", () => {
    expect(googleDriveProvider.id).toBe("google-drive");
    expect(googleDriveProvider.authType).toBe("service_account");
  });

  it("validates service account JSON structurally", async () => {
    const result = await googleDriveProvider.test(
      { row: {}, token: null, config: { service_account_json: validSa } },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("agent@p.iam.gserviceaccount.com");
  });

  it("rejects bad JSON", async () => {
    const result = await googleDriveProvider.test(
      { row: {}, token: null, config: { service_account_json: "{}" } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing required keys");
  });

  it("emits GOOGLE_APPLICATION_CREDENTIALS_JSON", () => {
    const env = googleDriveProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_json: validSa },
    });
    expect(env.primary).toBeNull();
    expect(env.config.service_account_json).toBe("GOOGLE_APPLICATION_CREDENTIALS_JSON");
  });
});
