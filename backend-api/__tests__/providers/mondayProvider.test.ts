// @ts-nocheck
const { mondayProvider } = require("../../integrations/providers/monday");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("mondayProvider", () => {
  it("POSTs GraphQL with token in raw Authorization header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { me: { name: "Alice" } } }),
    });
    const result = await mondayProvider.test(
      { row: {}, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.monday.com/v2",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "tok" }),
        body: JSON.stringify({ query: "{ me { name } }" }),
      }),
    );
    expect(result.message).toContain("Alice");
  });

  it("emits MONDAY_API_KEY", () => {
    expect(mondayProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "MONDAY_API_KEY",
      config: {},
    });
  });
});
