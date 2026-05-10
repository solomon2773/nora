// @ts-nocheck
const { firebaseProvider } = require("../../integrations/providers/firebase");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

const validSa = JSON.stringify({
  client_email: "agent@my-proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----\n",
  project_id: "my-proj",
});

describe("firebaseProvider", () => {
  it("identifies as firebase / service_account", () => {
    expect(firebaseProvider.id).toBe("firebase");
    expect(firebaseProvider.authType).toBe("service_account");
  });

  it("accepts a valid service account JSON without making network calls", async () => {
    const result = await firebaseProvider.test(
      { row: {}, token: null, config: { service_account_json: validSa } },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("my-proj");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const result = await firebaseProvider.test(
      { row: {}, token: null, config: { service_account_json: "not json" } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });

  it("rejects JSON missing required keys", async () => {
    const result = await firebaseProvider.test(
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

  it("emits GOOGLE_APPLICATION_CREDENTIALS_JSON with no primary", () => {
    const env = firebaseProvider.mapToEnv({
      row: {},
      token: null,
      config: { service_account_json: validSa },
    });
    expect(env.primary).toBeNull();
    expect(env.config).toEqual({ service_account_json: "GOOGLE_APPLICATION_CREDENTIALS_JSON" });
  });
});
