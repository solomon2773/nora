// @ts-nocheck
const { pineconeProvider } = require("../../integrations/providers/pinecone");

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

describe("pineconeProvider", () => {
  it("hits /indexes with Api-Key header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await pineconeProvider.test(
      { row: {}, token: "pc_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.pinecone.io/indexes",
      expect.objectContaining({ headers: { "Api-Key": "pc_x" } }),
    );
    expect(result.success).toBe(true);
  });

  it("emits PINECONE_API_KEY + environment + index_name", () => {
    const env = pineconeProvider.mapToEnv({
      row: {},
      token: null,
      config: { environment: "us-east-1-aws", index_name: "vectors" },
    });
    expect(env).toEqual({
      primary: "PINECONE_API_KEY",
      config: { environment: "PINECONE_ENVIRONMENT", index_name: "PINECONE_INDEX" },
    });
  });
});
