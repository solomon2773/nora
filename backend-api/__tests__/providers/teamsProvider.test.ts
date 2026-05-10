// @ts-nocheck
const { teamsProvider } = require("../../integrations/providers/teams");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("teamsProvider", () => {
  it("identifies as teams / webhook", () => {
    expect(teamsProvider.id).toBe("teams");
    expect(teamsProvider.authType).toBe("webhook");
  });

  it("accepts a valid Microsoft webhook URL without sending a message", async () => {
    const result = await teamsProvider.test(
      {
        row: {},
        token: null,
        config: {
          webhook_url: "https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/xyz",
        },
      },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("not verified");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects empty URL", async () => {
    const result = await teamsProvider.test({ row: {}, token: null, config: {} }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("rejects non-https URLs", async () => {
    const result = await teamsProvider.test(
      { row: {}, token: null, config: { webhook_url: "http://acme.webhook.office.com/x" } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("https");
  });

  it("rejects URLs that don't look like Microsoft webhook hosts", async () => {
    const result = await teamsProvider.test(
      { row: {}, token: null, config: { webhook_url: "https://evil.com/x" } },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Microsoft webhook");
  });

  it("emits TEAMS_WEBHOOK_URL with no primary token", () => {
    const env = teamsProvider.mapToEnv({
      row: {},
      token: null,
      config: { webhook_url: "https://x.webhook.office.com/x" },
    });
    expect(env).toEqual({
      primary: null,
      config: { webhook_url: "TEAMS_WEBHOOK_URL" },
    });
  });
});
