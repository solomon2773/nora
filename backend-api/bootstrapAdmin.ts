// @ts-nocheck
const { looksLikePlaceholderSecret } = require("./lib/secretValidation");

// Reject common default / weak bootstrap passwords regardless of case. A
// case-sensitive compare against the literal "admin123" would let
// "Admin123XXXX" through the length gate.
const FORBIDDEN_BOOTSTRAP_PASSWORD_PREFIXES = [
  "admin123",
  "administrator",
  "password",
  "password1",
  "changeme",
  "letmein",
  "welcome1",
  "qwerty123",
];

function isValidBootstrapAdminEmail(email) {
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) return false;
  const lowered = email.toLowerCase();
  return !email.includes("{{") && !/^(?:your_|replace[-_]with|placeholder)/.test(lowered);
}

function isForbiddenBootstrapPassword(password) {
  // Ignore case and separators so adding a suffix to a shipped/default value
  // (for example, "Admin123-XXXX") cannot turn it into an acceptable secret.
  const comparablePassword = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FORBIDDEN_BOOTSTRAP_PASSWORD_PREFIXES.some((prefix) =>
    comparablePassword.startsWith(prefix),
  );
}

function allowsFirstAdminSignupClaim(platformMode = process.env.PLATFORM_MODE) {
  return (
    String(platformMode || "selfhosted")
      .trim()
      .toLowerCase() !== "paas"
  );
}

/**
 * Validate optional bootstrap-admin credentials without mutating persistence,
 * declining to seed missing, invalid, short, placeholder, or default credentials.
 *
 * @param {Object} input - Bootstrap email and password from configuration.
 * @returns {Object} Seed decision, normalized email, and reason.
 */
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

  if (!isValidBootstrapAdminEmail(normalizedEmail)) {
    return {
      shouldSeed: false,
      email: normalizedEmail,
      reason: "invalid_email",
    };
  }

  if (looksLikePlaceholderSecret(password) || isForbiddenBootstrapPassword(password)) {
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
  allowsFirstAdminSignupClaim,
  getBootstrapAdminSeedConfig,
};
