// @ts-nocheck
const { vercelProvider } = require("../../integrations/providers/vercel");

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

describe("vercelProvider", () => {
  it("calls /v2/user with a Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { username: "alice" } }),
    });
    const result = await vercelProvider.test(
      { row: { provider: "vercel" }, token: "v_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.vercel.com/v2/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer v_x" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as alice" });
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await vercelProvider.test(
      { row: { provider: "vercel" }, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Vercel API returned 401");
  });

  it("includes VERCEL_TEAM_ID when team_id is configured", () => {
    const env = vercelProvider.mapToEnv({
      row: {},
      token: null,
      config: { team_id: "team_xyz" },
    });
    expect(env).toEqual({
      primary: "VERCEL_TOKEN",
      config: { team_id: "VERCEL_TEAM_ID" },
    });
  });
});
