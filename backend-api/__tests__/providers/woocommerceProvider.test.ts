// @ts-nocheck
const { woocommerceProvider } = require("../../integrations/providers/woocommerce");

const deps = (fetchImpl, assertSafeUrlImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: assertSafeUrlImpl || (async (u) => u),
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("woocommerceProvider", () => {
  it("uses Basic auth with consumer key + secret", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const assertSafeUrl = jest.fn(async (u) => u);
    await woocommerceProvider.test(
      {
        row: {},
        token: "cs_secret",
        config: { site_url: "https://shop.example.com", consumer_key: "ck_xyz" },
      },
      deps(fetchImpl, assertSafeUrl),
    );
    const expectedAuth = "Basic " + Buffer.from("ck_xyz:cs_secret").toString("base64");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://shop.example.com/wp-json/wc/v3/system_status");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(expectedAuth);
  });

  it("rejects missing site_url or consumer_key", async () => {
    const fetchImpl = jest.fn();
    let result = await woocommerceProvider.test(
      { row: {}, token: "x", config: { consumer_key: "ck" } },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    result = await woocommerceProvider.test(
      { row: {}, token: "x", config: { site_url: "https://x.com" } },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
  });

  it("emits WOOCOMMERCE_CONSUMER_SECRET + site/key", () => {
    const env = woocommerceProvider.mapToEnv({
      row: {},
      token: null,
      config: { site_url: "u", consumer_key: "ck" },
    });
    expect(env).toEqual({
      primary: "WOOCOMMERCE_CONSUMER_SECRET",
      config: { site_url: "WOOCOMMERCE_STORE_URL", consumer_key: "WOOCOMMERCE_CONSUMER_KEY" },
    });
  });
});
