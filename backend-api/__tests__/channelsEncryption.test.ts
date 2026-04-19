// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockEncrypt = jest.fn((value) => `enc(${value})`);
const mockDecrypt = jest.fn((value) => value.startsWith("enc(") ? value.slice(4, -1) : value);
const mockEnsureEncryptionConfigured = jest.fn();
const mockSend = jest.fn().mockResolvedValue({ delivered: true });

jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  ensureEncryptionConfigured: mockEnsureEncryptionConfigured,
}));
jest.mock("../../agent-runtime/lib/contracts", () => ({
  agentRuntimeUrl: jest.fn(() => "http://runtime.test"),
}));
jest.mock("../channels/adapters", () => ({
  getAdapter: jest.fn((type) => ({
    type,
    configFields: [
      { key: "bot_token", type: "password" },
      { key: "access_token", type: "password" },
      { key: "channel_access_token", type: "password" },
      { key: "channel_secret", type: "password" },
      { key: "verify_token", type: "text" },
      { key: "webhook_url", type: "url" },
    ],
    send: mockSend,
    verify: jest.fn().mockResolvedValue({ valid: true }),
    formatInbound: jest.fn((payload) => ({ content: payload.text || "ok", sender: "tester", metadata: {} })),
  })),
  listAdapterTypes: jest.fn(() => []),
}));

const channels = require("../channels");

describe("channel config encryption", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockEncrypt.mockClear();
    mockDecrypt.mockClear();
    mockEnsureEncryptionConfigured.mockClear();
    mockSend.mockClear();
  });

  it("encrypts sensitive config keys before storing a channel", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: "ch-1",
        agent_id: "agent-1",
        type: "telegram",
        name: "Ops Telegram",
        config: { bot_token: "enc(secret-token)", chat_id: "42" },
        enabled: true,
      }],
    });

    const result = await channels.createChannel("agent-1", "telegram", "Ops Telegram", {
      bot_token: "secret-token",
      chat_id: "42",
    });

    expect(mockEnsureEncryptionConfigured).toHaveBeenCalledWith("Channel credential storage");
    expect(mockEncrypt).toHaveBeenCalledWith("secret-token");
    expect(JSON.parse(mockDb.query.mock.calls[0][1][3])).toEqual({
      bot_token: "enc(secret-token)",
      chat_id: "42",
    });
    expect(result.config).toEqual({ bot_token: "[REDACTED]", chat_id: "42" });
  });

  it("decrypts stored secrets before adapter send", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "ch-2",
          agent_id: "agent-1",
          type: "telegram",
          enabled: true,
          config: { bot_token: "enc(secret-token)", chat_id: "42" },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await channels.sendMessage("ch-2", "hello", { to: "42" });

    expect(mockDecrypt).toHaveBeenCalledWith("enc(secret-token)");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { bot_token: "secret-token", chat_id: "42" },
      }),
      "hello",
      { to: "42" }
    );
  });

  it("encrypts secret-like non-password keys such as verify_token on update", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: "ch-3",
          agent_id: "agent-1",
          type: "whatsapp",
          enabled: true,
          config: { phone_number_id: "pn_123" },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "ch-3",
          agent_id: "agent-1",
          type: "whatsapp",
          enabled: true,
          config: { phone_number_id: "pn_123", access_token: "enc(wa-secret)", verify_token: "enc(verify-me)" },
        }],
      });

    const result = await channels.updateChannel("ch-3", "agent-1", {
      config: { phone_number_id: "pn_123", access_token: "wa-secret", verify_token: "verify-me" },
    });

    expect(mockEnsureEncryptionConfigured).toHaveBeenCalledWith("Channel credential storage");
    expect(mockEncrypt).toHaveBeenCalledWith("wa-secret");
    expect(mockEncrypt).toHaveBeenCalledWith("verify-me");
    expect(JSON.parse(mockDb.query.mock.calls[1][1][0])).toEqual({
      phone_number_id: "pn_123",
      access_token: "enc(wa-secret)",
      verify_token: "enc(verify-me)",
    });
    expect(result.config).toEqual({
      phone_number_id: "pn_123",
      access_token: "[REDACTED]",
      verify_token: "[REDACTED]",
    });
  });
});
