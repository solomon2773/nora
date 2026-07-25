// @ts-nocheck
const { slackProvider } = require("../../integrations/providers/slack");

function makeDeps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (url) => url,
    encrypt: (value) => value,
    decrypt: (value) => value,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("slackProvider", () => {
  it("identifies as the catalog slack / oauth2 provider", () => {
    expect(slackProvider.id).toBe("slack");
    expect(slackProvider.authType).toBe("oauth2");
  });

  it("verifies the bearer token with Slack auth.test", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, team: "Nora HQ" }),
    });

    const result = await slackProvider.test(
      { row: {}, token: "xoxb-token", config: {} },
      makeDeps(fetchImpl),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer xoxb-token",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected to Nora HQ" });
  });

  it("returns Slack's logical authentication error without treating it as success", async () => {
    const result = await slackProvider.test(
      { row: {}, token: "bad", config: {} },
      makeDeps(
        jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ ok: false, error: "invalid_auth" }),
        }),
      ),
    );
    expect(result).toEqual({ success: false, error: "Slack: invalid_auth" });
  });

  it("rejects a non-2xx response before trusting its body", async () => {
    const result = await slackProvider.test(
      { row: {}, token: "xoxb-token", config: {} },
      makeDeps(jest.fn().mockResolvedValue({ ok: false, status: 503 })),
    );
    expect(result).toEqual({ success: false, error: "Slack API returned 503" });
  });

  it("maps the token and optional default channel to runtime env vars", () => {
    expect(
      slackProvider.mapToEnv({
        row: {},
        token: null,
        config: { default_channel: "C012345" },
      }),
    ).toEqual({
      primary: "SLACK_TOKEN",
      config: { default_channel: "SLACK_DEFAULT_CHANNEL" },
    });
    expect(slackProvider.mapToEnv({ row: {}, token: null, config: {} }).config).toEqual({});
  });
});
