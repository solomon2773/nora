// @ts-nocheck
const { confluenceProvider } = require("../../integrations/providers/confluence");

const deps = (fetchImpl, assertSafeUrlImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: assertSafeUrlImpl || (async (u) => u),
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("confluenceProvider", () => {
  it("calls /wiki/rest/api/user/current with HTTP Basic", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ displayName: "Alice" }),
    });
    const assertSafeUrl = jest.fn(async (u) => u);
    const result = await confluenceProvider.test(
      {
        row: {},
        token: "atoken",
        config: { base_url: "https://acme.atlassian.net", email: "alice@example.com" },
      },
      deps(fetchImpl, assertSafeUrl),
    );
    expect(assertSafeUrl).toHaveBeenCalledWith("https://acme.atlassian.net", "Confluence base URL");
    const expectedAuth = "Basic " + Buffer.from("alice@example.com:atoken").toString("base64");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://acme.atlassian.net/wiki/rest/api/user/current",
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(expectedAuth);
    expect(result.message).toContain("Alice");
  });

  it("rejects missing base_url or email", async () => {
    const fetchImpl = jest.fn();
    let result = await confluenceProvider.test(
      { row: {}, token: "t", config: { email: "x@y.com" } },
      deps(fetchImpl),
    );
    expect(result.error).toContain("URL");
    result = await confluenceProvider.test(
      { row: {}, token: "t", config: { base_url: "https://x.atlassian.net" } },
      deps(fetchImpl),
    );
    expect(result.error).toContain("email");
  });

  it("emits CONFLUENCE_TOKEN + email + base_url", () => {
    const env = confluenceProvider.mapToEnv({
      row: {},
      token: null,
      config: { base_url: "u", email: "e" },
    });
    expect(env).toEqual({
      primary: "CONFLUENCE_TOKEN",
      config: { email: "CONFLUENCE_EMAIL", base_url: "CONFLUENCE_BASE_URL" },
    });
  });
});
