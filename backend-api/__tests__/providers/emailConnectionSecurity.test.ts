const {
  buildSmtpTransportOptions,
  classifyMailError,
} = require("../../integrations/providers/email/testConnection");

describe("email connection TLS defaults", () => {
  it("verifies SMTP certificates and the configured hostname by default", () => {
    expect(
      buildSmtpTransportOptions({
        auth: { username: "operator@example.com", password: "secret" },
        smtp: { host: "smtp.example.com", port: 465, secure: true },
      }),
    ).toEqual(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        requireTLS: false,
        tls: {
          rejectUnauthorized: true,
          servername: "smtp.example.com",
        },
      }),
    );
  });

  it("requires STARTTLS when SMTP does not use implicit TLS", () => {
    expect(
      buildSmtpTransportOptions({
        auth: { username: "operator@example.com", password: "secret" },
        smtp: { host: "smtp.example.com", port: 587, secure: false },
      }),
    ).toEqual(expect.objectContaining({ secure: false, requireTLS: true }));
  });

  it.each([
    "self-signed certificate",
    "unable to verify the first certificate",
    "TLS handshake failed",
  ])("classifies certificate failures as TLS mismatches: %s", (message) => {
    expect(classifyMailError(new Error(message), "smtp")).toBe("tls_mismatch");
  });
});
