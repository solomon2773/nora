// @ts-nocheck
// Reject common default / weak bootstrap passwords regardless of case. A
// case-sensitive compare against the literal "admin123" would let
// "Admin123XXXX" through the length gate.
const FORBIDDEN_BOOTSTRAP_PASSWORDS = [
  "admin123",
  "administrator",
  "password",
  "password1",
  "changeme",
  "letmein",
  "welcome1",
  "qwerty123",
];

function getBootstrapAdminSeedConfig({ adminEmail, adminPassword }) {
  const normalizedEmail = typeof adminEmail === "string" ? adminEmail.trim() : "";
  const password = typeof adminPassword === "string" ? adminPassword : "";

  if (!normalizedEmail || !password) {
    return {
      shouldSeed: false,
      email: normalizedEmail,
      reason: "missing_credentials",
    };
  }

  const lowered = password.toLowerCase();
  if (FORBIDDEN_BOOTSTRAP_PASSWORDS.includes(lowered)) {
    return {
      shouldSeed: false,
      email: normalizedEmail,
      reason: "default_password_forbidden",
    };
  }

  if (password.length < 12) {
    return {
      shouldSeed: false,
      email: normalizedEmail,
      reason: "password_too_short",
    };
  }

  return {
    shouldSeed: true,
    email: normalizedEmail,
    password,
    reason: "ok",
  };
}

module.exports = {
  getBootstrapAdminSeedConfig,
};
