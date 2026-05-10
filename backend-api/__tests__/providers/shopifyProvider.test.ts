// @ts-nocheck
const { shopifyProvider } = require("../../integrations/providers/shopify");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("shopifyProvider", () => {
  it("appends .myshopify.com when shop_domain is bare", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ shop: { name: "Acme" } }),
    });
    await shopifyProvider.test(
      { row: {}, token: "shpat_x", config: { shop_domain: "acme" } },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://acme.myshopify.com/admin/api/2024-01/shop.json",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Shopify-Access-Token": "shpat_x" }),
      }),
    );
  });

  it("uses the full domain when configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ shop: { name: "Acme" } }),
    });
    await shopifyProvider.test(
      { row: {}, token: "x", config: { shop_domain: "shop.acme.com" } },
      deps(fetchImpl),
    );
    expect(fetchImpl.mock.calls[0][0]).toContain("shop.acme.com");
  });

  it("rejects missing shop_domain", async () => {
    const result = await shopifyProvider.test({ row: {}, token: "x", config: {} }, deps(jest.fn()));
    expect(result.success).toBe(false);
  });

  it("emits SHOPIFY_ACCESS_TOKEN + SHOPIFY_SHOP_DOMAIN", () => {
    const env = shopifyProvider.mapToEnv({
      row: {},
      token: null,
      config: { shop_domain: "acme" },
    });
    expect(env).toEqual({
      primary: "SHOPIFY_ACCESS_TOKEN",
      config: { shop_domain: "SHOPIFY_SHOP_DOMAIN" },
    });
  });
});
