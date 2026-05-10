// @ts-nocheck
const { paypalProvider } = require("../../integrations/providers/paypal");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("paypalProvider", () => {
  it("identifies as paypal / credentials", () => {
    expect(paypalProvider.id).toBe("paypal");
    expect(paypalProvider.authType).toBe("credentials");
  });

  it("POSTs client_credentials to /v1/oauth2/token (production)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await paypalProvider.test(
      { row: {}, token: "secret", config: { client_id: "AYx" } },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api-m.paypal.com/v1/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials",
      }),
    );
    expect(result.message).toContain("production");
  });

  it("uses sandbox host when configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await paypalProvider.test(
      { row: {}, token: "secret", config: { client_id: "AYx", sandbox: true } },
      deps(fetchImpl),
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(result.message).toContain("sandbox");
  });

  it("rejects missing client_id", async () => {
    const result = await paypalProvider.test({ row: {}, token: "x", config: {} }, deps(jest.fn()));
    expect(result.success).toBe(false);
  });

  it("emits PAYPAL_CLIENT_SECRET + client_id + sandbox", () => {
    const env = paypalProvider.mapToEnv({
      row: {},
      token: null,
      config: { client_id: "AYx", sandbox: true },
    });
    expect(env.primary).toBe("PAYPAL_CLIENT_SECRET");
    expect(env.config.client_id).toBe("PAYPAL_CLIENT_ID");
    expect(env.config.sandbox).toBe("PAYPAL_SANDBOX");
  });
});
