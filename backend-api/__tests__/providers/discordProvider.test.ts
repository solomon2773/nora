// @ts-nocheck
const { discordProvider } = require("../../integrations/providers/discord");

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

describe("discordProvider", () => {
  it("uses the `Bot <token>` Authorization header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "norabot" }),
    });
    const result = await discordProvider.test(
      { row: { provider: "discord" }, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bot tok" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as norabot" });
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await discordProvider.test(
      { row: {}, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Discord API returned 401");
  });

  it("emits DISCORD_GUILD_ID when guild_id is configured", () => {
    const env = discordProvider.mapToEnv({
      row: {},
      token: null,
      config: { guild_id: "123456789" },
    });
    expect(env).toEqual({
      primary: "DISCORD_TOKEN",
      config: { guild_id: "DISCORD_GUILD_ID" },
    });
  });
});
