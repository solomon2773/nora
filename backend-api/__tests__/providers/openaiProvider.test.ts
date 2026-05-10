// @ts-nocheck
const { openaiProvider } = require("../../integrations/providers/openai");

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

describe("openaiProvider", () => {
  it("hits /v1/models with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{}, {}, {}] }),
    });
    const result = await openaiProvider.test(
      { row: {}, token: "sk-x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-x" }),
      }),
    );
    expect(result.message).toContain("3 models available");
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await openaiProvider.test(
      { row: {}, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("OpenAI API returned 401");
  });

  it("emits OPENAI_API_KEY + ORG_ID + MODEL when set", () => {
    const env = openaiProvider.mapToEnv({
      row: {},
      token: null,
      config: { org_id: "org_abc", model: "gpt-4o-mini" },
    });
    expect(env).toEqual({
      primary: "OPENAI_API_KEY",
      config: { org_id: "OPENAI_ORG_ID", model: "OPENAI_MODEL" },
    });
  });
});
