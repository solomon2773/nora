// @ts-nocheck
const { redisProvider } = require("../../integrations/providers/redis");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("redisProvider", () => {
  it("accepts host + port without password (no-auth dev cluster)", async () => {
    const result = await redisProvider.test(
      { row: {}, token: "", config: { host: "redis.example.com", port: 6379 } },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("redis.example.com:6379");
  });

  it("rejects missing host or port", async () => {
    let result = await redisProvider.test({ row: {}, token: "", config: { port: 6379 } }, deps);
    expect(result.success).toBe(false);
    result = await redisProvider.test({ row: {}, token: "", config: { host: "h" } }, deps);
    expect(result.success).toBe(false);
  });

  it("emits REDIS_HOST/PORT/PASSWORD", () => {
    const env = redisProvider.mapToEnv({
      row: {},
      token: null,
      config: { host: "h", port: 6379 },
    });
    expect(env).toEqual({
      primary: "REDIS_PASSWORD",
      config: { host: "REDIS_HOST", port: "REDIS_PORT" },
    });
  });
});
