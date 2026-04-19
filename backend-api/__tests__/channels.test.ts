// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockEncrypt = jest.fn((value) => `enc(${value})`);
const mockDecrypt = jest.fn((value) => value.startsWith("enc(") ? value.slice(4, -1) : value);
const mockEnsureEncryptionConfigured = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  ensureEncryptionConfigured: mockEnsureEncryptionConfigured,
}));
jest.mock("../../agent-runtime/lib/contracts", () => ({
  agentRuntimeUrl: jest.fn(() => "http://runtime.test"),
}));

const channels = require("../channels");

describe("channel secret redaction", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockEncrypt.mockClear();
    mockDecrypt.mockClear();
    mockEnsureEncryptionConfigured.mockClear();
  });

  it("redacts password and secret-like fields when creating a channel", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "ch-1",
        agent_id: "agent-1",
        type: "telegram",
        name: "Ops Telegram",
        config: { bot_token: "123:secret", chat_id: "42" },
        enabled: true,
      }],
    });

    const result = await channels.createChannel("agent-1", "telegram", "Ops Telegram", {
      bot_token: "123:secret",
      chat_id: "42",
    });

    expect(result.config).toEqual({
      bot_token: "[REDACTED]",
      chat_id: "42",
    });
  });

  it("redacts webhook and token fields when listing channels", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "ch-2",
        agent_id: "agent-1",
        type: "whatsapp",
        name: "Ops WhatsApp",
        config: {
          phone_number_id: "pn_123",
          access_token: "wa-secret",
          verify_token: "verify-me",
        },
        enabled: true,
      }],
    });

    const result = await channels.listChannels("agent-1");

    expect(result).toHaveLength(1);
    expect(result[0].config).toEqual({
      phone_number_id: "pn_123",
      access_token: "[REDACTED]",
      verify_token: "[REDACTED]",
    });
  });

  it("redacts webhook URLs and password fields when updating a channel", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "ch-3",
          agent_id: "agent-1",
          type: "slack",
          name: "Ops Slack",
          config: {
            webhook_url: "enc(https://hooks.slack.test/secret)",
            bot_token: "enc(xoxb-secret)",
            channel: "#ops",
          },
          enabled: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "ch-3",
          agent_id: "agent-1",
          type: "slack",
          name: "Ops Slack",
          config: {
            webhook_url: "enc(https://hooks.slack.test/secret)",
            bot_token: "enc(xoxb-secret)",
            channel: "#ops",
          },
          enabled: true,
        }],
      });

    const result = await channels.updateChannel("ch-3", "agent-1", {
      config: {
        webhook_url: "https://hooks.slack.test/secret",
        bot_token: "xoxb-secret",
        channel: "#ops",
      },
    });

    expect(result.config).toEqual({
      webhook_url: "[REDACTED]",
      bot_token: "[REDACTED]",
      channel: "#ops",
    });
  });
});
