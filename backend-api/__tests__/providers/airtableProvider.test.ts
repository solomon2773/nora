// @ts-nocheck
const { airtableProvider } = require("../../integrations/providers/airtable");

function deps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (u) => u,
    encrypt: (s) => s,
    decrypt: (s) => s,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("airtableProvider", () => {
  it("calls /v0/meta/whoami with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: "alice@example.com" }),
    });
    const result = await airtableProvider.test(
      { row: {}, token: "pat_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.airtable.com/v0/meta/whoami",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer pat_x" }),
      }),
    );
    expect(result.message).toContain("alice@example.com");
  });

  it("emits AIRTABLE_API_KEY + base_id when set", () => {
    const env = airtableProvider.mapToEnv({ row: {}, token: null, config: { base_id: "appXYZ" } });
    expect(env).toEqual({
      primary: "AIRTABLE_API_KEY",
      config: { base_id: "AIRTABLE_BASE_ID" },
    });
  });
});
