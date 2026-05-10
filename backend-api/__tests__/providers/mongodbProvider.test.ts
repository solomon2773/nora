// @ts-nocheck
const { mongodbProvider } = require("../../integrations/providers/mongodb");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("mongodbProvider", () => {
  it("accepts mongodb:// URIs", async () => {
    const result = await mongodbProvider.test(
      { row: {}, token: "mongodb://user:pass@db.example.com:27017/mydb", config: {} },
      deps,
    );
    expect(result.success).toBe(true);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts mongodb+srv:// URIs", async () => {
    const result = await mongodbProvider.test(
      { row: {}, token: "mongodb+srv://user:pass@cluster0.example.mongodb.net/mydb", config: {} },
      deps,
    );
    expect(result.success).toBe(true);
  });

  it("rejects empty connection strings", async () => {
    const result = await mongodbProvider.test({ row: {}, token: "", config: {} }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects non-mongodb schemes", async () => {
    const result = await mongodbProvider.test(
      { row: {}, token: "https://example.com", config: {} },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("mongodb://");
  });

  it("emits MONGODB_URI as primary", () => {
    expect(mongodbProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "MONGODB_URI",
      config: {},
    });
  });
});
