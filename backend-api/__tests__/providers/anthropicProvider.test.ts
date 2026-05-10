// @ts-nocheck
const { anthropicProvider } = require("../../integrations/providers/anthropic");

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

describe("anthropicProvider", () => {
  it("uses x-api-key + anthropic-version headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await anthropicProvider.test({ row: {}, token: "sk-ant-x", config: {} }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-ant-x",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await anthropicProvider.test(
      { row: {}, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Anthropic API returned 401");
  });

  it("emits ANTHROPIC_API_KEY + MODEL when set", () => {
    const env = anthropicProvider.mapToEnv({
      row: {},
      token: null,
      config: { model: "claude-opus-4-7" },
    });
    expect(env).toEqual({
      primary: "ANTHROPIC_API_KEY",
      config: { model: "ANTHROPIC_MODEL" },
    });
  });
});
