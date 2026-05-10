// @ts-nocheck
const { algoliaProvider } = require("../../integrations/providers/algolia");

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

describe("algoliaProvider", () => {
  it("hits /1/keys on the app's DSN endpoint with both auth headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await algoliaProvider.test(
      { row: {}, token: "admin_x", config: { app_id: "APP123" } },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://APP123-dsn.algolia.net/1/keys",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Algolia-Application-Id": "APP123",
          "X-Algolia-API-Key": "admin_x",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects when app_id missing", async () => {
    const result = await algoliaProvider.test(
      { row: {}, token: "admin_x", config: {} },
      deps(jest.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Application ID");
  });

  it("emits ALGOLIA_* env vars", () => {
    const env = algoliaProvider.mapToEnv({
      row: {},
      token: null,
      config: { app_id: "APP123", index_name: "products" },
    });
    expect(env).toEqual({
      primary: "ALGOLIA_API_KEY",
      config: { app_id: "ALGOLIA_APP_ID", index_name: "ALGOLIA_INDEX" },
    });
  });
});
