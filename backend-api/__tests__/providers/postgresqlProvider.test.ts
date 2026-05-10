// @ts-nocheck
const { postgresqlProvider } = require("../../integrations/providers/postgresql");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("postgresqlProvider", () => {
  it("identifies as postgresql / credentials", () => {
    expect(postgresqlProvider.id).toBe("postgresql");
    expect(postgresqlProvider.authType).toBe("credentials");
  });

  it("accepts a complete config without making any network calls", async () => {
    const result = await postgresqlProvider.test(
      {
        row: {},
        token: "secret",
        config: { host: "db.example.com", port: 5432, database: "mydb", user: "alice" },
      },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("db.example.com:5432/mydb");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["host", { port: 5432, database: "d", user: "u" }],
    ["port", { host: "h", port: 0, database: "d", user: "u" }],
    ["database", { host: "h", port: 5432, user: "u" }],
    ["user", { host: "h", port: 5432, database: "d" }],
  ])("rejects when %s is missing", async (_, cfg) => {
    const result = await postgresqlProvider.test({ row: {}, token: "secret", config: cfg }, deps);
    expect(result.success).toBe(false);
  });

  it("emits PG* env vars from config", () => {
    const env = postgresqlProvider.mapToEnv({
      row: {},
      token: null,
      config: { host: "h", port: 5432, database: "d", user: "u" },
    });
    expect(env.primary).toBe("PGPASSWORD");
    expect(env.config).toEqual({
      host: "PGHOST",
      port: "PGPORT",
      database: "PGDATABASE",
      user: "PGUSER",
    });
  });
});
