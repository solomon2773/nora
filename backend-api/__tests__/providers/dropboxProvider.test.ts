// @ts-nocheck
const { dropboxProvider } = require("../../integrations/providers/dropbox");

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

describe("dropboxProvider", () => {
  it("POSTs /users/get_current_account with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: { display_name: "Alice" } }),
    });
    const result = await dropboxProvider.test(
      { row: {}, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.dropboxapi.com/2/users/get_current_account",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as Alice" });
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await dropboxProvider.test(
      { row: {}, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Dropbox API returned 401");
  });

  it("emits DROPBOX_ACCESS_TOKEN as primary", () => {
    expect(dropboxProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "DROPBOX_ACCESS_TOKEN",
      config: {},
    });
  });
});
