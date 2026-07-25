// @ts-nocheck
const { allowsFirstAdminSignupClaim, getBootstrapAdminSeedConfig } = require("../bootstrapAdmin");

describe("bootstrap admin policy", () => {
  it("allows first-account admin claim only outside hosted PaaS mode", () => {
    expect(allowsFirstAdminSignupClaim("selfhosted")).toBe(true);
    expect(allowsFirstAdminSignupClaim("local")).toBe(true);
    expect(allowsFirstAdminSignupClaim("PAAS")).toBe(false);
  });

  it("rejects missing bootstrap credentials", () => {
    expect(getBootstrapAdminSeedConfig({ adminEmail: "", adminPassword: "" })).toMatchObject({
      shouldSeed: false,
      reason: "missing_credentials",
    });
  });

  it("rejects short bootstrap passwords", () => {
    expect(
      getBootstrapAdminSeedConfig({ adminEmail: "admin@example.com", adminPassword: "shortpass" }),
    ).toMatchObject({
      shouldSeed: false,
      reason: "password_too_short",
      email: "admin@example.com",
    });
  });

  it("rejects the legacy default bootstrap password", () => {
    expect(
      getBootstrapAdminSeedConfig({ adminEmail: "admin@example.com", adminPassword: "admin123" }),
    ).toMatchObject({
      shouldSeed: false,
      reason: "default_password_forbidden",
      email: "admin@example.com",
    });
  });

  it.each([
    ["<REPLACE_WITH_BOOTSTRAP_ADMIN_EMAIL>", "StrongRandomPassword-2026!", "invalid_email"],
    ["not-an-email", "StrongRandomPassword-2026!", "invalid_email"],
    ["admin@example.com", "<REPLACE_WITH_STRONG_BOOTSTRAP_PASSWORD>", "default_password_forbidden"],
  ])(
    "rejects placeholder or malformed bootstrap credentials",
    (adminEmail, adminPassword, reason) => {
      expect(getBootstrapAdminSeedConfig({ adminEmail, adminPassword })).toMatchObject({
        shouldSeed: false,
        reason,
      });
    },
  );

  it.each(["Admin123XXXX", "password1234", "Qwerty123456", "admin123-secure", "🔥Admin123-secure"])(
    "rejects a password derived from a known default: %s",
    (adminPassword) => {
      expect(
        getBootstrapAdminSeedConfig({ adminEmail: "admin@example.com", adminPassword }),
      ).toMatchObject({
        shouldSeed: false,
        reason: "default_password_forbidden",
        email: "admin@example.com",
      });
    },
  );

  it("accepts explicit secure bootstrap credentials and trims the email", () => {
    expect(
      getBootstrapAdminSeedConfig({
        adminEmail: "  admin@example.com ",
        adminPassword: "supersecure12",
      }),
    ).toEqual({
      shouldSeed: true,
      email: "admin@example.com",
      password: "supersecure12",
      reason: "ok",
    });
  });
});
