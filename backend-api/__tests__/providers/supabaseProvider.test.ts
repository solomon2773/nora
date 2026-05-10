// @ts-nocheck
const { supabaseProvider } = require("../../integrations/providers/supabase");

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

describe("supabaseProvider", () => {
  it("hits /rest/v1/ with apikey + Bearer headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await supabaseProvider.test(
      {
        row: {},
        token: "key",
        config: { url: "https://abc.supabase.co" },
      },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://abc.supabase.co/rest/v1/",
      expect.objectContaining({
        headers: expect.objectContaining({
          apikey: "key",
          Authorization: "Bearer key",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects when project URL missing", async () => {
    const result = await supabaseProvider.test(
      { row: {}, token: "k", config: {} },
      deps(jest.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("URL");
  });

  it("emits SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY", () => {
    const env = supabaseProvider.mapToEnv({
      row: {},
      token: null,
      config: { url: "https://abc.supabase.co" },
    });
    expect(env).toEqual({
      primary: "SUPABASE_SERVICE_ROLE_KEY",
      config: { url: "SUPABASE_URL" },
    });
  });
});
