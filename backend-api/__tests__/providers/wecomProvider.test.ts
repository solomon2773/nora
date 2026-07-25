// @ts-nocheck
const { normalizeWecomConfigInput, wecomProvider } = require("../../integrations/providers/wecom");

const deps = {
  fetch: jest.fn(),
  assertSafeUrl: async (url) => url,
  encrypt: (value) => value,
  decrypt: (value) => value,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
};

describe("wecomProvider", () => {
  beforeEach(() => {
    deps.fetch.mockClear();
  });

  it("identifies as wecom / custom", () => {
    expect(wecomProvider.id).toBe("wecom");
    expect(wecomProvider.authType).toBe("custom");
  });

  it("normalizes dotted fields, allowlists, and safe defaults", () => {
    expect(
      normalizeWecomConfigInput({
        mode: "bot",
        "defaultAccount.bot.botId": " bot-1 ",
        "defaultAccount.bot.secret": " bot-secret ",
        "policies.allowFrom": "alice, bob\nalice",
        "defaultAccount.agent.callbackPath": "/api/wecom/callback",
      }),
    ).toMatchObject({
      mode: "bot",
      defaultAccount: {
        bot: {
          botId: "bot-1",
          secret: "bot-secret",
          connectionMode: "websocket",
          websocketUrl: "wss://openws.work.weixin.qq.com",
          sendThinkingMessage: true,
        },
        agent: { callbackPath: "/plugins/wecom/agent/default" },
      },
      policies: { allowFrom: ["alice", "bob"] },
    });
  });

  it("accepts complete bot configuration without making a network request", async () => {
    const result = await wecomProvider.test(
      {
        row: {},
        token: null,
        config: {
          mode: "bot",
          "defaultAccount.bot.botId": "bot-1",
          "defaultAccount.bot.secret": "bot-secret",
        },
      },
      deps,
    );

    expect(result).toEqual({
      success: true,
      message: "WeCom configuration saved and ready for activation wiring.",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("reports the first missing field for each enabled connection mode", async () => {
    const missingBot = await wecomProvider.test(
      { row: {}, token: null, config: { mode: "bot" } },
      deps,
    );
    expect(missingBot).toEqual({
      success: false,
      error: "Default Bot ID is required.",
      message: "Default Bot ID is required.",
    });

    const missingAgent = await wecomProvider.test(
      { row: {}, token: null, config: { mode: "agent" } },
      deps,
    );
    expect(missingAgent).toEqual({
      success: false,
      error: "Default Corp ID is required.",
      message: "Default Corp ID is required.",
    });
  });

  it("converts malformed advanced JSON into a connectivity failure", async () => {
    const result = await wecomProvider.test(
      {
        row: {},
        token: null,
        config: {
          mode: "bot",
          "defaultAccount.bot.botId": "bot-1",
          "defaultAccount.bot.secret": "bot-secret",
          accountsJson: "not-json",
        },
      },
      deps,
    );
    expect(result).toEqual({
      success: false,
      error: "Additional Accounts JSON must be valid JSON.",
      message: "Additional Accounts JSON must be valid JSON.",
    });
  });

  it("sanitizes sync metadata so bot and agent secrets cannot escape", () => {
    const sanitized = wecomProvider.sanitizeForSync({
      mode: "both",
      defaultAccount: {
        label: "Primary",
        bot: { botId: "bot-1", secret: "bot-secret", name: "Nora" },
        agent: {
          corpId: "corp-1",
          corpSecret: "corp-secret",
          agentId: 42,
          token: "callback-token",
          encodingAESKey: "aes-secret",
        },
      },
      accounts: [
        {
          id: "sales",
          bot: { botId: "bot-2", secret: "second-secret" },
          agent: { agentId: 84, corpSecret: "second-corp-secret" },
        },
      ],
    });

    expect(sanitized).toMatchObject({
      mode: "both",
      defaultAccount: {
        label: "Primary",
        bot: { name: "Nora", connectionMode: "websocket" },
        agent: { callbackPath: "/plugins/wecom/agent/default" },
      },
      accounts: [{ id: "sales", hasBot: true, hasAgent: true }],
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /bot-secret|corp-secret|callback-token|aes-secret|second-secret/,
    );
  });

  it("does not expose WeCom credentials as process environment variables", () => {
    expect(wecomProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: null,
      config: {},
    });
  });
});
