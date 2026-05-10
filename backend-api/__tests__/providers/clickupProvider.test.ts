// @ts-nocheck
const { clickupProvider } = require("../../integrations/providers/clickup");

const deps = (fetchImpl) => ({
  fetch: fetchImpl,
  assertSafeUrl: async (u) => u,
  encrypt: (s) => s,
  decrypt: (s) => s,
  ensureEncryptionConfigured: jest.fn(),
  db: { query: jest.fn() },
});

describe("clickupProvider", () => {
  it("calls /v2/user with raw token in Authorization header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { username: "alice" } }),
    });
    const result = await clickupProvider.test(
      { row: {}, token: "pk_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/user",
      expect.objectContaining({ headers: { Authorization: "pk_x" } }),
    );
    expect(result.message).toContain("alice");
  });

  it("emits CLICKUP_API_KEY + team_id", () => {
    const env = clickupProvider.mapToEnv({ row: {}, token: null, config: { team_id: "t1" } });
    expect(env).toEqual({
      primary: "CLICKUP_API_KEY",
      config: { team_id: "CLICKUP_TEAM_ID" },
    });
  });
});
