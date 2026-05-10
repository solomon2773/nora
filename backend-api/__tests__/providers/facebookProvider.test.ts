// @ts-nocheck
const { facebookProvider } = require("../../integrations/providers/facebook");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("facebookProvider", () => {
  it("calls /me with access_token query param", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "Acme Page" }),
    });
    await facebookProvider.test({ row: {}, token: "tok", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith("https://graph.facebook.com/v18.0/me?access_token=tok");
  });

  it("emits FACEBOOK_ACCESS_TOKEN + page_id", () => {
    const env = facebookProvider.mapToEnv({
      row: {},
      token: null,
      config: { page_id: "1234" },
    });
    expect(env).toEqual({
      primary: "FACEBOOK_ACCESS_TOKEN",
      config: { page_id: "FACEBOOK_PAGE_ID" },
    });
  });
});
