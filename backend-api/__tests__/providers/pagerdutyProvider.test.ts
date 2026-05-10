// @ts-nocheck
const { pagerdutyProvider } = require("../../integrations/providers/pagerduty");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("pagerdutyProvider", () => {
  it("uses Token token=<key> header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { name: "Alice" } }),
    });
    await pagerdutyProvider.test({ row: {}, token: "tok", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.pagerduty.com/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Token token=tok" }),
      }),
    );
  });

  it("emits PAGERDUTY_TOKEN + routing_key", () => {
    const env = pagerdutyProvider.mapToEnv({
      row: {},
      token: null,
      config: { routing_key: "rk_x" },
    });
    expect(env).toEqual({
      primary: "PAGERDUTY_TOKEN",
      config: { routing_key: "PAGERDUTY_ROUTING_KEY" },
    });
  });
});
