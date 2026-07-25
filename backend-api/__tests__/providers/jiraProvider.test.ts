// @ts-nocheck
const { jiraProvider } = require("../../integrations/providers/jira");

function makeDeps(fetchImpl = jest.fn(), assertSafeUrlImpl = async (url) => url) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: assertSafeUrlImpl,
    encrypt: (value) => value,
    decrypt: (value) => value,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("jiraProvider", () => {
  it("identifies as the catalog jira / api_key provider", () => {
    expect(jiraProvider.id).toBe("jira");
    expect(jiraProvider.authType).toBe("api_key");
  });

  it("validates the site URL and verifies credentials with HTTP Basic", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ displayName: "Alice" }),
    });
    const assertSafeUrl = jest.fn(async (url) => url);

    const result = await jiraProvider.test(
      {
        row: {},
        token: "jira-token",
        config: { site_url: "acme.atlassian.net", email: "alice@example.com" },
      },
      makeDeps(fetchImpl, assertSafeUrl),
    );

    expect(assertSafeUrl).toHaveBeenCalledWith("https://acme.atlassian.net", "Jira site URL");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://acme.atlassian.net/rest/api/3/myself",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("alice@example.com:jira-token").toString("base64")}`,
        }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as Alice" });
  });

  it("rejects missing connection fields before making a request", async () => {
    const fetchImpl = jest.fn();

    const missingUrl = await jiraProvider.test(
      { row: {}, token: "jira-token", config: { email: "alice@example.com" } },
      makeDeps(fetchImpl),
    );
    const missingEmail = await jiraProvider.test(
      { row: {}, token: "jira-token", config: { site_url: "https://acme.atlassian.net" } },
      makeDeps(fetchImpl),
    );

    expect(missingUrl).toEqual({ success: false, error: "Jira site URL not configured" });
    expect(missingEmail).toEqual({ success: false, error: "Jira email not configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a sanitized failure for unsafe URLs and rejected credentials", async () => {
    const unsafe = await jiraProvider.test(
      {
        row: {},
        token: "jira-token",
        config: { site_url: "http://127.0.0.1", email: "alice@example.com" },
      },
      makeDeps(jest.fn(), async () => {
        throw new Error("Jira site URL cannot target a private address");
      }),
    );
    expect(unsafe).toEqual({
      success: false,
      error: "Jira site URL cannot target a private address",
    });

    const rejected = await jiraProvider.test(
      {
        row: {},
        token: "bad-token",
        config: { site_url: "https://acme.atlassian.net", email: "alice@example.com" },
      },
      makeDeps(jest.fn().mockResolvedValue({ ok: false, status: 401 })),
    );
    expect(rejected).toEqual({ success: false, error: "Jira API returned 401" });
  });

  it("maps the API token and optional Jira configuration to runtime env vars", () => {
    expect(
      jiraProvider.mapToEnv({
        row: {},
        token: null,
        config: {
          email: "alice@example.com",
          site_url: "https://acme.atlassian.net",
          project_key: "NORA",
        },
      }),
    ).toEqual({
      primary: "JIRA_API_TOKEN",
      config: {
        email: "JIRA_EMAIL",
        site_url: "JIRA_BASE_URL",
        project_key: "JIRA_PROJECT_KEY",
      },
    });
  });
});
