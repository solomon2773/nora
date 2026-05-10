// @ts-nocheck
const { trelloProvider } = require("../../integrations/providers/trello");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("trelloProvider", () => {
  it("passes key + token as query params", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "alice" }),
    });
    const result = await trelloProvider.test(
      { row: {}, token: "tok", config: { api_key: "key123" } },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.trello.com/1/members/me?key=key123&token=tok",
    );
    expect(result.message).toContain("alice");
  });

  it("rejects when API key missing", async () => {
    const result = await trelloProvider.test(
      { row: {}, token: "tok", config: {} },
      deps(jest.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("API key");
  });

  it("emits TRELLO_TOKEN + TRELLO_API_KEY", () => {
    const env = trelloProvider.mapToEnv({ row: {}, token: null, config: { api_key: "k" } });
    expect(env).toEqual({
      primary: "TRELLO_TOKEN",
      config: { api_key: "TRELLO_API_KEY" },
    });
  });
});
