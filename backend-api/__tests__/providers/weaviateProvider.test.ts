// @ts-nocheck
const { weaviateProvider } = require("../../integrations/providers/weaviate");

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

describe("weaviateProvider", () => {
  it("hits /v1/meta with Bearer token when api_key is set", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.24.1" }),
    });
    const result = await weaviateProvider.test(
      {
        row: {},
        token: "wv_x",
        config: { host: "https://cluster.weaviate.network" },
      },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cluster.weaviate.network/v1/meta",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer wv_x" }),
      }),
    );
    expect(result.message).toContain("1.24.1");
  });

  it("anonymous when no api_key", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.0" }),
    });
    await weaviateProvider.test(
      { row: {}, token: "", config: { host: "https://c.weaviate.network" } },
      deps(fetchImpl),
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("rejects when host missing", async () => {
    const result = await weaviateProvider.test({ row: {}, token: "", config: {} }, deps(jest.fn()));
    expect(result.success).toBe(false);
    expect(result.error).toContain("cluster URL");
  });

  it("emits WEAVIATE_URL + WEAVIATE_API_KEY", () => {
    const env = weaviateProvider.mapToEnv({
      row: {},
      token: null,
      config: { host: "https://c.weaviate.network" },
    });
    expect(env).toEqual({
      primary: "WEAVIATE_API_KEY",
      config: { host: "WEAVIATE_URL" },
    });
  });
});
