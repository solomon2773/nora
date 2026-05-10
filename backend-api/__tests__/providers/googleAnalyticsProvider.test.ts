// @ts-nocheck
const { googleAnalyticsProvider } = require("../../integrations/providers/googleAnalytics");

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

describe("googleAnalyticsProvider", () => {
  it("identifies as google-analytics / service_account", () => {
    expect(googleAnalyticsProvider.id).toBe("google-analytics");
    expect(googleAnalyticsProvider.authType).toBe("service_account");
  });

  it("validates SA JSON", async () => {
    const result = await googleAnalyticsProvider.test(
      { row: {}, token: null, config: { service_account_json: validSa } },
      deps,
    );
    expect(result.success).toBe(true);
  });

  it("emits GOOGLE_APPLICATION_CREDENTIALS_JSON + GA4_PROPERTY_ID", () => {
    const env = googleAnalyticsProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_json: validSa, property_id: "123456" },
    });
    expect(env.primary).toBeNull();
    expect(env.config.property_id).toBe("GA4_PROPERTY_ID");
  });
});
