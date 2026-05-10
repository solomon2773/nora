// @ts-nocheck
const { terraformProvider } = require("../../integrations/providers/terraform");

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

describe("terraformProvider", () => {
  it("calls /api/v2/account/details with the JSON:API content type", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { username: "alice" } } }),
    });
    const result = await terraformProvider.test(
      { row: { provider: "terraform" }, token: "tfe_x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.terraform.io/api/v2/account/details",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tfe_x",
          "Content-Type": "application/vnd.api+json",
        }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected as alice" });
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await terraformProvider.test(
      { row: { provider: "terraform" }, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Terraform Cloud API returned 401");
  });

  it("emits TFE_ORGANIZATION when organization is configured", () => {
    const env = terraformProvider.mapToEnv({
      row: {},
      token: null,
      config: { organization: "acme" },
    });
    expect(env).toEqual({
      primary: "TFE_TOKEN",
      config: { organization: "TFE_ORGANIZATION" },
    });
  });
});
