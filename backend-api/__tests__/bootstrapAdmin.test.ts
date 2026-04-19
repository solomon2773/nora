// @ts-nocheck
const { getBootstrapAdminSeedConfig } = require("../bootstrapAdmin");

describe("bootstrap admin policy", () => {
  it("rejects missing bootstrap credentials", () => {
    expect(getBootstrapAdminSeedConfig({ adminEmail: "", adminPassword: "" })).toMatchObject({
      shouldSeed: false,
      reason: "missing_credentials",
    });
  });

  it("rejects short bootstrap passwords", () => {
    expect(getBootstrapAdminSeedConfig({ adminEmail: "admin@example.com", adminPassword: "shortpass" })).toMatchObject({
      shouldSeed: false,
      reason: "password_too_short",
      email: "admin@example.com",
    });
  });

  it("rejects the legacy default bootstrap password", () => {
    expect(getBootstrapAdminSeedConfig({ adminEmail: "admin@example.com", adminPassword: "admin123" })).toMatchObject({
      shouldSeed: false,
      reason: "default_password_forbidden",
      email: "admin@example.com",
    });
  });

  it("accepts explicit secure bootstrap credentials and trims the email", () => {
    expect(getBootstrapAdminSeedConfig({ adminEmail: "  admin@example.com ", adminPassword: "supersecure12" })).toEqual({
      shouldSeed: true,
      email: "admin@example.com",
      password: "supersecure12",
      reason: "ok",
    });
  });
});
