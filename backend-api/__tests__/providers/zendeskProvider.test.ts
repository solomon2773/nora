// @ts-nocheck
const { zendeskProvider } = require("../../integrations/providers/zendesk");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("zendeskProvider", () => {
  it("uses Zendesk's email/token Basic-auth shape", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { name: "Alice" } }),
    });
    await zendeskProvider.test(
      {
        row: {},
        token: "tok",
        config: { subdomain: "acme", email: "alice@example.com" },
      },
      deps(fetchImpl),
    );
    const expected = "Basic " + Buffer.from("alice@example.com/token:tok").toString("base64");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://acme.zendesk.com/api/v2/users/me.json");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(expected);
  });

  it("rejects missing subdomain or email", async () => {
    const fetchImpl = jest.fn();
    let result = await zendeskProvider.test(
      { row: {}, token: "t", config: { email: "a@b.c" } },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    result = await zendeskProvider.test(
      { row: {}, token: "t", config: { subdomain: "x" } },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
  });

  it("emits ZENDESK_API_TOKEN + subdomain + email", () => {
    const env = zendeskProvider.mapToEnv({
      row: {},
      token: null,
      config: { subdomain: "acme", email: "a@b.c" },
    });
    expect(env).toEqual({
      primary: "ZENDESK_API_TOKEN",
      config: { subdomain: "ZENDESK_SUBDOMAIN", email: "ZENDESK_EMAIL" },
    });
  });
});
