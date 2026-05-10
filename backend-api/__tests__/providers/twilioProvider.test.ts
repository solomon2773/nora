// @ts-nocheck
const { twilioProvider } = require("../../integrations/providers/twilio");

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

describe("twilioProvider", () => {
  it("identifies as twilio / credentials", () => {
    expect(twilioProvider.id).toBe("twilio");
    expect(twilioProvider.authType).toBe("credentials");
  });

  it("calls /Accounts/<sid>.json with HTTP Basic auth", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const result = await twilioProvider.test(
      { row: {}, token: "tok", config: { account_sid: "AC123" } },
      deps(fetchImpl),
    );
    const expected = "Basic " + Buffer.from("AC123:tok").toString("base64");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/AC123.json",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expected }),
      }),
    );
    expect(result).toEqual({ success: true, message: "Connected to Twilio" });
  });

  it("rejects missing SID", async () => {
    const fetchImpl = jest.fn();
    const result = await twilioProvider.test(
      { row: {}, token: "tok", config: {} },
      deps(fetchImpl),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Account SID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("emits TWILIO_AUTH_TOKEN + sid + phone_number when configured", () => {
    const env = twilioProvider.mapToEnv({
      row: {},
      token: null,
      config: { account_sid: "AC123", phone_number: "+15555550123" },
    });
    expect(env).toEqual({
      primary: "TWILIO_AUTH_TOKEN",
      config: { account_sid: "TWILIO_ACCOUNT_SID", phone_number: "TWILIO_PHONE_NUMBER" },
    });
  });
});
