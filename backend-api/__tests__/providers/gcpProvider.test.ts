// @ts-nocheck
const { gcpProvider } = require("../../integrations/providers/gcp");

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
  project_id: "my-proj",
});

describe("gcpProvider", () => {
  it("identifies as gcp / service_account", () => {
    expect(gcpProvider.id).toBe("gcp");
    expect(gcpProvider.authType).toBe("service_account");
  });

  it("validates service account JSON structurally", async () => {
    const result = await gcpProvider.test(
      { row: {}, token: null, config: { service_account_json: validSa } },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("my-proj");
  });

  it("rejects missing required keys", async () => {
    const result = await gcpProvider.test(
      {
        row: {},
        token: null,
        config: { service_account_json: JSON.stringify({ client_email: "x" }) },
      },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing required keys");
  });

  it("emits GOOGLE_APPLICATION_CREDENTIALS_JSON + GCP_PROJECT_ID", () => {
    const env = gcpProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_json: validSa, project_id: "my-proj" },
    });
    expect(env.primary).toBeNull();
    expect(env.config).toEqual({
      service_account_json: "GOOGLE_APPLICATION_CREDENTIALS_JSON",
      project_id: "GCP_PROJECT_ID",
    });
  });
});
