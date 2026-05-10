// @ts-nocheck
const { stripeProvider } = require("../../integrations/providers/stripe");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("stripeProvider", () => {
  it("hits /v1/balance with Bearer secret key", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await stripeProvider.test({ row: {}, token: "sk_x", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk_x" }),
      }),
    );
  });

  it("emits STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET when configured", () => {
    const env = stripeProvider.mapToEnv({
      row: {},
      token: null,
      config: { webhook_secret: "whsec_x" },
    });
    expect(env).toEqual({
      primary: "STRIPE_SECRET_KEY",
      config: { webhook_secret: "STRIPE_WEBHOOK_SECRET" },
    });
  });
});
