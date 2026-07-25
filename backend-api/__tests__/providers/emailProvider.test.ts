// @ts-nocheck
jest.mock("../../integrations/providers/email/testConnection", () => ({
  testEmailConnection: jest.fn(async (config) => ({
    success: true,
    ok: true,
    message: `verified ${config.imap.host} / ${config.smtp.host}`,
  })),
}));

const { emailProvider, normalizeEmailConfigInput } = require("../../integrations/providers/email");
const { testEmailConnection } = require("../../integrations/providers/email/testConnection");

describe("emailProvider", () => {
  beforeEach(() => {
    testEmailConnection.mockClear();
  });

  it("identifies as email / custom", () => {
    expect(emailProvider.id).toBe("email");
    expect(emailProvider.authType).toBe("custom");
  });

  it("normalizes dotted config keys into the current nested email shape", () => {
    expect(
      normalizeEmailConfigInput({
        providerPreset: "gmail",
        "auth.username": "alice@example.com",
        "auth.password": "secret",
        "smtp.fromAddress": "alice@example.com",
        "cron.enabled": true,
        "cron.intervalMinutes": 15,
      }),
    ).toMatchObject({
      providerPreset: "gmail",
      auth: {
        mode: "basic",
        username: "alice@example.com",
        password: "secret",
      },
      imap: {
        host: "imap.gmail.com",
        port: 993,
        secure: true,
      },
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        fromAddress: "alice@example.com",
      },
      cron: {
        enabled: true,
        intervalMinutes: 15,
      },
    });
  });

  it("delegates connection testing to the current IMAP/SMTP verifier with normalized config", async () => {
    const assertSafeUrl = jest.fn(async (url) => url);
    const result = await emailProvider.test(
      {
        row: {},
        token: "secret",
        config: {
          providerPreset: "gmail",
          "auth.username": "alice@example.com",
          "smtp.fromAddress": "alice@example.com",
        },
      },
      { assertSafeUrl },
    );

    expect(assertSafeUrl).toHaveBeenNthCalledWith(
      1,
      "https://imap.gmail.com:993",
      "Email IMAP endpoint",
    );
    expect(assertSafeUrl).toHaveBeenNthCalledWith(
      2,
      "https://smtp.gmail.com:465",
      "Email SMTP endpoint",
    );

    expect(testEmailConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPreset: "gmail",
        auth: expect.objectContaining({
          username: "alice@example.com",
          password: "secret",
        }),
        imap: expect.objectContaining({
          host: "imap.gmail.com",
        }),
        smtp: expect.objectContaining({
          host: "smtp.gmail.com",
          fromAddress: "alice@example.com",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("fails before opening mail sockets when an endpoint is not network-safe", async () => {
    const assertSafeUrl = jest.fn().mockRejectedValue(new Error("private address"));

    await expect(
      emailProvider.test(
        {
          row: {},
          token: "secret",
          config: {
            providerPreset: "custom",
            "auth.username": "alice@example.com",
            "imap.host": "127.0.0.1",
            "smtp.host": "smtp.example.com",
            "smtp.fromAddress": "alice@example.com",
          },
        },
        { assertSafeUrl },
      ),
    ).rejects.toThrow("private address");

    expect(testEmailConnection).not.toHaveBeenCalled();
  });

  it("emits EMAIL_PASSWORD as primary and the current IMAP/SMTP env mapping", () => {
    const env = emailProvider.mapToEnv({
      row: {},
      token: null,
      config: {
        providerPreset: "gmail",
        "auth.username": "alice@example.com",
        "smtp.fromAddress": "alice@example.com",
      },
    });

    expect(env.primary).toBe("EMAIL_PASSWORD");
    expect(env.config).toEqual({
      providerPreset: "EMAIL_PROVIDER_PRESET",
      auth_username: "EMAIL_USERNAME",
      imap_host: "EMAIL_IMAP_HOST",
      imap_port: "EMAIL_IMAP_PORT",
      imap_secure: "EMAIL_IMAP_SECURE",
      smtp_host: "EMAIL_SMTP_HOST",
      smtp_port: "EMAIL_SMTP_PORT",
      smtp_secure: "EMAIL_SMTP_SECURE",
      smtp_fromAddress: "EMAIL_FROM_ADDRESS",
      smtp_fromName: "EMAIL_FROM_NAME",
    });
  });
});
