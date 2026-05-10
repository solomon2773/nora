// @ts-nocheck
const { salesforceProvider } = require("../../integrations/providers/salesforce");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("salesforceProvider", () => {
  it("calls /services/data/v59.0/ with Bearer at the customer's instance URL", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await salesforceProvider.test(
      {
        row: {},
        token: "00D!x",
        config: { instance_url: "https://my.salesforce.com" },
      },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://my.salesforce.com/services/data/v59.0/",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer 00D!x" }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects when instance_url missing", async () => {
    const result = await salesforceProvider.test(
      { row: {}, token: "x", config: {} },
      deps(jest.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("instance URL");
  });

  it("emits SALESFORCE_ACCESS_TOKEN + SALESFORCE_INSTANCE_URL", () => {
    const env = salesforceProvider.mapToEnv({
      row: {},
      token: null,
      config: { instance_url: "u" },
    });
    expect(env).toEqual({
      primary: "SALESFORCE_ACCESS_TOKEN",
      config: { instance_url: "SALESFORCE_INSTANCE_URL" },
    });
  });
});
