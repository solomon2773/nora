// @ts-nocheck
const { telegramProvider } = require("../../integrations/providers/telegram");

function deps(fetchImpl) {
  return {
    fetch: fetchImpl,
    assertSafeUrl: async (u) => u,
    encrypt: (s) => s,
    decrypt: (s) => s,
    ensureEncryptionConfigured: jest.fn(),
    db: { query: jest.fn() },
  };
}

describe("telegramProvider", () => {
  it("validates the token format before calling the API", async () => {
    const fetchImpl = jest.fn();
    const result = await telegramProvider.test(
      { row: {}, token: "not-a-valid-token", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid Telegram bot token format");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls /getMe with the bot token in the URL path", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { username: "norabot" } }),
    });
    const result = await telegramProvider.test(
      { row: {}, token: "123456789:ABCdef-XYZ_abc", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456789:ABCdef-XYZ_abc/getMe",
    );
    expect(result).toEqual({ success: true, message: "Connected as @norabot" });
  });

  it("surfaces Telegram's own description when ok=false", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    });
    const result = await telegramProvider.test(
      { row: {}, token: "123:abc", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unauthorized");
  });

  it("emits TELEGRAM_BOT_TOKEN as primary and operator id when configured", () => {
    const env = telegramProvider.mapToEnv({
      row: {},
      token: null,
      config: { operator_user_id: "987654" },
    });
    expect(env).toEqual({
      primary: "TELEGRAM_BOT_TOKEN",
      config: { operator_user_id: "OPERATOR_TELEGRAM_ID" },
    });
  });
});
