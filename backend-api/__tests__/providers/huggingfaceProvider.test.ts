// @ts-nocheck
const { huggingfaceProvider } = require("../../integrations/providers/huggingface");

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

describe("huggingfaceProvider", () => {
  it("hits /api/whoami-v2 with Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: "alice" }),
    });
    const result = await huggingfaceProvider.test(
      { row: {}, token: "hf_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://huggingface.co/api/whoami-v2",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer hf_x" }),
      }),
    );
    expect(result.message).toContain("alice");
  });

  it("emits HF_TOKEN as primary", () => {
    expect(huggingfaceProvider.mapToEnv({ row: {}, token: null, config: {} })).toEqual({
      primary: "HF_TOKEN",
      config: {},
    });
  });
});
