// @ts-nocheck
const { sendgridProvider } = require("../../integrations/providers/sendgrid");

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

describe("sendgridProvider", () => {
  it("calls /v3/user/profile with a Bearer token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await sendgridProvider.test(
      { row: {}, token: "SG.x", config: {} },
      deps(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.sendgrid.com/v3/user/profile",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer SG.x" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "API key validated" });
  });

  it("returns success=false on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await sendgridProvider.test(
      { row: {}, token: "bad", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("SendGrid API returned 401");
  });

  it("emits SENDGRID_API_KEY + from_email when configured", () => {
    const env = sendgridProvider.mapToEnv({
      row: {},
      token: null,
      config: { from_email: "alice@example.com" },
    });
    expect(env).toEqual({
      primary: "SENDGRID_API_KEY",
      config: { from_email: "SENDGRID_FROM_EMAIL" },
    });
  });
});
