// @ts-nocheck
const { googleSheetsProvider } = require("../../integrations/providers/googleSheets");

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

describe("googleSheetsProvider", () => {
  it("identifies as google-sheets / service_account", () => {
    expect(googleSheetsProvider.id).toBe("google-sheets");
    expect(googleSheetsProvider.authType).toBe("service_account");
  });

  it("validates the SA JSON structurally", async () => {
    const result = await googleSheetsProvider.test(
      { row: {}, token: null, config: { service_account_json: validSa } },
      deps,
    );
    expect(result.success).toBe(true);
  });

  it("rejects missing required keys", async () => {
    const result = await googleSheetsProvider.test(
      { row: {}, token: null, config: { service_account_json: "{}" } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing required keys");
  });

  it("emits GOOGLE_APPLICATION_CREDENTIALS_JSON + spreadsheet_id", () => {
    const env = googleSheetsProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_json: validSa, spreadsheet_id: "abc" },
    });
    expect(env.primary).toBeNull();
    expect(env.config.service_account_json).toBe("GOOGLE_APPLICATION_CREDENTIALS_JSON");
    expect(env.config.spreadsheet_id).toBe("GOOGLE_SHEETS_DEFAULT_SPREADSHEET_ID");
  });
});
