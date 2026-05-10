// @ts-nocheck
const { digitaloceanProvider } = require("../../integrations/providers/digitalocean");

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

describe("digitaloceanProvider", () => {
  it("hits /v2/account with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ account: { email: "alice@example.com" } }),
    });
    const result = await digitaloceanProvider.test(
      { row: {}, token: "dop_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.digitalocean.com/v2/account",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer dop_x" }),
      }),
    );
    expect(result.message).toContain("alice@example.com");
  });

  it("emits DIGITALOCEAN_TOKEN as primary", () => {
    expect(digitaloceanProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "DIGITALOCEAN_TOKEN",
      config: {},
    });
  });
});
