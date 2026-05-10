// @ts-nocheck
const { instagramProvider } = require("../../integrations/providers/instagram");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("instagramProvider", () => {
  it("hits the business_account_id endpoint when configured", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "acme" }),
    });
    await instagramProvider.test(
      { row: {}, token: "tok", config: { business_account_id: "17841400" } },
      deps(fetchImpl),
    );
    expect(fetchImpl.mock.calls[0][0]).toContain("17841400?fields=id,username");
  });

  it("falls back to /me when business account is missing", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "Acme" }),
    });
    await instagramProvider.test({ row: {}, token: "tok", config: {} }, deps(fetchImpl));
    expect(fetchImpl.mock.calls[0][0]).toContain("me?fields=id,name");
  });

  it("emits INSTAGRAM_ACCESS_TOKEN + business + page", () => {
    const env = instagramProvider.mapToEnv({
      row: {},
      token: null,
      config: { business_account_id: "1", page_id: "p1" },
    });
    expect(env.primary).toBe("INSTAGRAM_ACCESS_TOKEN");
    expect(env.config.business_account_id).toBe("INSTAGRAM_BUSINESS_ACCOUNT_ID");
    expect(env.config.page_id).toBe("INSTAGRAM_PAGE_ID");
  });
});
