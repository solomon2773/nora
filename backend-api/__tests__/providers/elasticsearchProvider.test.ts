// @ts-nocheck
const { elasticsearchProvider } = require("../../integrations/providers/elasticsearch");

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

describe("elasticsearchProvider", () => {
  it("hits the node URL anonymously when no username configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cluster_name: "prod" }),
    });
    const result = await elasticsearchProvider.test(
      { row: {}, token: "", config: { node_url: "https://es.example.com" } },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://es.example.com",
      expect.objectContaining({ headers: {} }),
    );
    expect(result.message).toContain('"prod"');
  });

  it("uses HTTP Basic when username is configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cluster_name: "prod" }),
    });
    await elasticsearchProvider.test(
      {
        row: {},
        token: "pw",
        config: { node_url: "https://es.example.com", username: "elastic" },
      },
      deps(fetchImpl),
    );
    const expected = "Basic " + Buffer.from("elastic:pw").toString("base64");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(expected);
  });

  it("rejects empty node_url", async () => {
    const result = await elasticsearchProvider.test(
      { row: {}, token: "", config: {} },
      deps(jest.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("node URL");
  });

  it("emits ELASTICSEARCH_* env vars", () => {
    const env = elasticsearchProvider.mapToEnv({
      row: {},
      token: null,
      config: { node_url: "u", username: "elastic", index: "logs" },
    });
    expect(env.primary).toBe("ELASTICSEARCH_PASSWORD");
    expect(env.config).toEqual({
      node_url: "ELASTICSEARCH_URL",
      username: "ELASTICSEARCH_USERNAME",
      index: "ELASTICSEARCH_INDEX",
    });
  });
});
