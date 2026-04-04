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

  if (password === "admin123") {
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
