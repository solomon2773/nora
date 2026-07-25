// @ts-nocheck
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { allowsFirstAdminSignupClaim } = require("../bootstrapAdmin");
const { authenticateToken, requireSession } = require("../middleware/auth");
const { setAuthCookie, clearAuthCookie } = require("../authCookie");
const { normalizeEmail, normalizeProvider, verifyOAuthIdentity } = require("../oauthProviders");
const {
  getLanguageSettings,
  parseRequiredLocale,
  resolvePreferredLocale,
} = require("../platformSettings");

const router = express.Router();
const FIRST_USER_ADMIN_LOCK_KEY = 20260408;
const DUPLICATE_SIGNUP_MESSAGE = "Account already exists for this email";
const SIGNUP_CHALLENGE_MESSAGE = "Complete the verification challenge and try again";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RECAPTCHA_SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

function isOAuthLoginEnabled() {
  return process.env.OAUTH_LOGIN_ENABLED === "true";
}

function getPublicPlatformMode() {
  return String(process.env.PLATFORM_MODE || "selfhosted")
    .trim()
    .toLowerCase() === "paas"
    ? "paas"
    : "selfhosted";
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function getAuthRateLimitConfig() {
  return {
    windowMs: parsePositiveIntegerEnv("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    max: parsePositiveIntegerEnv("AUTH_RATE_LIMIT_MAX", 20),
  };
}

const authLimiter = rateLimit({
  ...getAuthRateLimitConfig(),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});

const signupBurstLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_BURST_WINDOW_MS", 10 * 60 * 1000),
  max: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_BURST_MAX", 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts, please try again later" },
});

const signupDailyLimiter = rateLimit({
  windowMs: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS", 24 * 60 * 60 * 1000),
  max: parsePositiveIntegerEnv("SIGNUP_RATE_LIMIT_DAILY_MAX", 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts, please try again later" },
});

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSignupBotProtectionProvider(value) {
  const provider = String(value || "")
    .trim()
    .toLowerCase();
  if (!provider) return "";
  if (["none", "turnstile", "recaptcha"].includes(provider)) return provider;
  return "invalid";
}

function readFirstSignupEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function getSignupBotProtectionSiteKey(provider) {
  return provider === "turnstile"
    ? readFirstSignupEnv("SIGNUP_TURNSTILE_SITE_KEY", "NEXT_PUBLIC_SIGNUP_TURNSTILE_SITE_KEY")
    : readFirstSignupEnv("SIGNUP_RECAPTCHA_SITE_KEY", "NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY");
}

function getNoSignupBotProtectionConfig() {
  if (getPublicPlatformMode() === "paas") {
    return {
      enabled: true,
      provider: "none",
      configured: false,
      siteKey: "",
      error:
        "Public PaaS signup requires SIGNUP_BOT_PROTECTION_PROVIDER=turnstile or recaptcha with matching site and secret keys",
      publicError:
        "Signup verification is required for this hosted service, but no challenge provider is configured. Contact the administrator.",
    };
  }
  return { enabled: false, provider: "none", configured: true, siteKey: "" };
}

function getSignupBotProtectionConfig() {
  const explicitProvider = normalizeSignupBotProtectionProvider(
    readFirstSignupEnv(
      "SIGNUP_BOT_PROTECTION_PROVIDER",
      "NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER",
    ),
  );

  if (explicitProvider === "none") {
    return getNoSignupBotProtectionConfig();
  }
  if (explicitProvider === "invalid") {
    return {
      enabled: true,
      provider: "invalid",
      configured: false,
      siteKey: "",
      error: "Invalid SIGNUP_BOT_PROTECTION_PROVIDER",
      publicError:
        "Signup verification is enabled, but its provider configuration is invalid. Contact the administrator.",
    };
  }

  const turnstileSecret = readFirstSignupEnv("SIGNUP_TURNSTILE_SECRET");
  const recaptchaSecret = readFirstSignupEnv("SIGNUP_RECAPTCHA_SECRET");
  const turnstileSiteKey = getSignupBotProtectionSiteKey("turnstile");
  const recaptchaSiteKey = getSignupBotProtectionSiteKey("recaptcha");
  const hasTurnstileConfig = Boolean(turnstileSecret || turnstileSiteKey);
  const hasRecaptchaConfig = Boolean(recaptchaSecret || recaptchaSiteKey);
  let provider = explicitProvider;

  if (!provider) {
    if (hasTurnstileConfig && hasRecaptchaConfig) {
      return {
        enabled: true,
        provider: "invalid",
        configured: false,
        siteKey: "",
        error:
          "Both signup bot protection providers are configured; set SIGNUP_BOT_PROTECTION_PROVIDER",
        publicError:
          "Signup verification is enabled for multiple providers. Select one provider in the server configuration.",
      };
    }
    if (hasTurnstileConfig) provider = "turnstile";
    if (hasRecaptchaConfig) provider = "recaptcha";
  }

  if (!provider) {
    return getNoSignupBotProtectionConfig();
  }

  const secret = provider === "turnstile" ? turnstileSecret : recaptchaSecret;
  const siteKey = provider === "turnstile" ? turnstileSiteKey : recaptchaSiteKey;

  if (!secret) {
    return {
      enabled: true,
      provider,
      configured: false,
      siteKey,
      error: `Missing secret for signup ${provider} bot protection`,
      publicError:
        "Signup verification is enabled, but server verification is incomplete. Contact the administrator.",
    };
  }

  if (!siteKey) {
    return {
      enabled: true,
      provider,
      configured: false,
      siteKey: "",
      secret,
      error: `Missing public site key for signup ${provider} bot protection`,
      publicError:
        "Signup verification is enabled, but its public site key is missing. Contact the administrator.",
    };
  }

  return { enabled: true, provider, configured: true, siteKey, secret };
}

function getPublicSignupBotProtectionConfig() {
  const config = getSignupBotProtectionConfig();
  const provider = ["turnstile", "recaptcha"].includes(config.provider)
    ? config.provider
    : config.provider === "none" && config.enabled !== true
      ? "none"
      : null;

  return {
    enabled: config.enabled === true,
    provider,
    siteKey: provider && provider !== "none" ? config.siteKey || null : null,
    configured: config.configured === true,
    configurationError:
      config.configured === true
        ? null
        : config.publicError ||
          "Signup verification is enabled, but its runtime configuration is incomplete.",
  };
}

function getSignupBotProtectionToken(body = {}) {
  return String(body.botProtectionToken || body.turnstileToken || body.recaptchaToken || "").trim();
}

/**
 * Verify the configured signup challenge server-side, failing closed for
 * missing tokens, provider errors, and unreachable verification services.
 *
 * @param {Object} req - Signup request containing the challenge token and client IP.
 * @returns {Promise<void>}
 */
async function verifySignupBotProtection(req) {
  const config = getSignupBotProtectionConfig();
  if (!config.enabled) return;
  if (!config.configured || config.provider === "invalid") {
    throw createHttpError(config.error || "Signup bot protection is misconfigured", 500);
  }

  const token = getSignupBotProtectionToken(req.body);
  if (!token) throw createHttpError(SIGNUP_CHALLENGE_MESSAGE, 403);

  const body = new URLSearchParams({
    secret: config.secret,
    response: token,
  });
  if (req.ip) body.set("remoteip", req.ip);

  const endpoint =
    config.provider === "turnstile" ? TURNSTILE_SITEVERIFY_URL : RECAPTCHA_SITEVERIFY_URL;
  let verifyRes;
  let verifyData;
  try {
    verifyRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    verifyData = await verifyRes.json().catch(() => ({}));
  } catch {
    throw createHttpError(SIGNUP_CHALLENGE_MESSAGE, 403);
  }

  if (!verifyRes.ok || !verifyData?.success) {
    throw createHttpError(SIGNUP_CHALLENGE_MESSAGE, 403);
  }
}

// Precomputed bcrypt hash of a random high-entropy string. Used as a constant-
// time dummy comparison target when a login attempt references a non-existent
// user, so that timing does not reveal user existence. The plaintext is not
// stored and is not recoverable from this hash.
const DUMMY_BCRYPT_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8hV7FNHZi8jN2xq9YhU7C2c4SaB2Vu";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (!email || typeof email !== "string") return "Email is required";
  // Length check BEFORE regex so unbounded inputs can't drive backtracking cost.
  if (email.length > 255) return "Email too long";
  if (!EMAIL_RE.test(email)) return "Invalid email format";
  return null;
}
function validatePassword(pw) {
  if (!pw || typeof pw !== "string") return "Password is required";
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password too long";
  return null;
}

const LEGACY_SESSION_CLAIMS = new Set(["id", "email", "role", "iat", "exp"]);

/**
 * Confirm a signed token matches the narrow historical browser-session claim
 * set before allowing it to be promoted into an HttpOnly cookie.
 *
 * @param {Object} payload - Verified JWT payload candidate.
 * @returns {boolean} Whether the payload is a legacy Nora browser session.
 */
function isLegacySessionPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  // Backend-issued browser sessions have always contained exactly these
  // custom claims plus jsonwebtoken's iat/exp timestamps. Other JWTs share the
  // signing secret (for example short-lived gateway embed tokens), so a valid
  // signature alone is not enough to promote a token into the primary cookie.
  if (Object.keys(payload).some((claim) => !LEGACY_SESSION_CLAIMS.has(claim))) return false;

  return (
    typeof payload.id === "string" &&
    Boolean(payload.id.trim()) &&
    typeof payload.email === "string" &&
    !validateEmail(payload.email) &&
    (payload.role === "user" || payload.role === "admin") &&
    Number.isInteger(payload.iat) &&
    Number.isInteger(payload.exp) &&
    payload.exp > payload.iat
  );
}

/**
 * Serialize user creation behind a transaction-scoped advisory lock so only
 * one concurrent signup can claim the first-user administrator role.
 *
 * @param {Function} work - User-creation callback receiving the locked client.
 * @returns {Promise} Callback result after commit.
 */
async function withUserCreationLock(work) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [FIRST_USER_ADMIN_LOCK_KEY]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback only.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function nextRegisteredUserRole(client) {
  const result = await client.query("SELECT EXISTS(SELECT 1 FROM users) AS has_users");
  if (result.rows[0]?.has_users) return "user";
  if (!allowsFirstAdminSignupClaim()) {
    const error = createHttpError(
      "Hosted PaaS requires an operator-provisioned bootstrap administrator before public signup can create accounts",
      503,
    );
    error.code = "PAAS_BOOTSTRAP_ADMIN_REQUIRED";
    throw error;
  }
  return "admin";
}

async function findExistingUserByEmail(email) {
  const result = await db.query("SELECT id FROM users WHERE email=$1 LIMIT 1", [email]);
  return result.rows[0] || null;
}

function isDuplicateUserError(error) {
  return (
    error?.code === "23505" ||
    /duplicate key value/i.test(String(error?.message || "")) ||
    /unique constraint/i.test(String(error?.message || ""))
  );
}

// ─── Public routes ────────────────────────────────────────────────

// First-run claim check: true until the first user registers (who becomes the
// platform admin). Login/signup also consume runtime OAuth and platform-mode
// metadata from this endpoint so reusable frontend images do not bake deploy-time
// auth behavior. Only the public portion of signup-challenge configuration is
// exposed; secret verification keys stay server-side.
router.get("/bootstrap-status", async (req, res) => {
  try {
    const { rows } = await db.query("SELECT 1 FROM users LIMIT 1");
    const firstAdminClaimAllowed = allowsFirstAdminSignupClaim();
    res.json({
      needsFirstAdmin: rows.length === 0 && firstAdminClaimAllowed,
      oauthLoginEnabled: isOAuthLoginEnabled(),
      platformMode: getPublicPlatformMode(),
      signupBotProtection: getPublicSignupBotProtectionConfig(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/signup", signupBurstLimiter, signupDailyLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const emailErr = validateEmail(normalizedEmail);
  if (emailErr) return res.status(400).json({ error: emailErr });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    await verifySignupBotProtection(req);
    const existingUser = await findExistingUserByEmail(normalizedEmail);
    if (existingUser) return res.status(409).json({ error: DUPLICATE_SIGNUP_MESSAGE });

    const hash = await bcrypt.hash(password, 10);
    const user = await withUserCreationLock(async (client) => {
      const role = await nextRegisteredUserRole(client);
      const result = await client.query(
        "INSERT INTO users(email, password_hash, role) VALUES($1, $2, $3) RETURNING id, email, role",
        [normalizedEmail, hash, role],
      );
      return result.rows[0];
    });
    res.json(user);
  } catch (e) {
    if (isDuplicateUserError(e)) {
      return res.status(409).json({ error: DUPLICATE_SIGNUP_MESSAGE });
    }
    const statusCode = e.statusCode || 500;
    if (e.code === "PAAS_BOOTSTRAP_ADMIN_REQUIRED") {
      return res.status(statusCode).json({ error: e.message, code: e.code });
    }
    if (statusCode >= 500) {
      console.error("Signup failed:", e.message);
      return res.status(500).json({ error: "Could not create account" });
    }
    res.status(statusCode).json({ error: e.message });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password)
    return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await db.query("SELECT * FROM users WHERE email=$1", [normalizedEmail]);
    const user = result.rows[0];
    // Always run bcrypt.compare to keep response timing independent of whether
    // the email exists. Without this, a missing user returns ~100ms faster than
    // a wrong password, which lets attackers enumerate registered accounts.
    const hashToCompare = user && user.password_hash ? user.password_hash : DUMMY_BCRYPT_HASH;
    const passwordOk = await bcrypt.compare(password, hashToCompare);
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    if (!user.password_hash) {
      return res.status(401).json({
        error: `This account uses ${user.provider || "OAuth"} login. Please sign in with ${user.provider || "your OAuth provider"} instead.`,
      });
    }
    if (!passwordOk) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256" },
    );
    setAuthCookie(res, token, req);
    res.json({ token });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/oauth-login", authLimiter, async (req, res, next) => {
  if (!isOAuthLoginEnabled()) {
    return res.status(403).json({
      error: "OAuth login is disabled until server-side provider verification is implemented",
    });
  }

  const { email, name, provider, providerId, oauthAccessToken, oauthIdToken } = req.body || {};

  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return res.status(400).json({ error: "provider required" });
  if (!oauthAccessToken && !oauthIdToken) {
    return res.status(400).json({ error: "oauthAccessToken or oauthIdToken required" });
  }

  try {
    const verified = await verifyOAuthIdentity({
      provider: normalizedProvider,
      accessToken: oauthAccessToken,
      idToken: oauthIdToken,
      email,
      providerId,
    });
    const normalizedVerifiedEmail = normalizeEmail(verified.email);

    const user = await withUserCreationLock(async (client) => {
      const linkedResult = await client.query(
        "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE provider = $1 AND provider_id = $2",
        [normalizedProvider, verified.providerId],
      );
      const linkedUser = linkedResult.rows[0];
      if (linkedUser && normalizeEmail(linkedUser.email) !== normalizedVerifiedEmail) {
        const error = new Error(
          `This ${normalizedProvider} account is already linked to another Nora user email.`,
        );
        error.statusCode = 409;
        throw error;
      }

      const existingResult = await client.query(
        "SELECT id, email, role, name, provider, provider_id, password_hash FROM users WHERE email = $1",
        [normalizedVerifiedEmail],
      );
      const existingUser = existingResult.rows[0];

      if (existingUser?.password_hash && !existingUser.provider) {
        const error = new Error(
          "This email already uses password login. Sign in with password until account linking exists.",
        );
        error.statusCode = 409;
        throw error;
      }
      if (existingUser?.provider && existingUser.provider !== normalizedProvider) {
        const error = new Error(
          `This account is already linked to ${existingUser.provider} login.`,
        );
        error.statusCode = 409;
        throw error;
      }
      if (
        existingUser?.provider_id &&
        String(existingUser.provider_id) !== String(verified.providerId)
      ) {
        const error = new Error(
          `This ${normalizedProvider} account is linked to a different Nora user.`,
        );
        error.statusCode = 409;
        throw error;
      }

      const role = existingUser?.role || (await nextRegisteredUserRole(client));
      const result = await client.query(
        `INSERT INTO users(email, name, provider, provider_id, role)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, users.name),
           provider = COALESCE(EXCLUDED.provider, users.provider),
           provider_id = COALESCE(EXCLUDED.provider_id, users.provider_id)
         RETURNING id, email, role, name`,
        [
          normalizedVerifiedEmail,
          verified.name || name || null,
          normalizedProvider,
          verified.providerId,
          role,
        ],
      );
      return result.rows[0];
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256" },
    );
    setAuthCookie(res, token, req);
    res.json({ token, user });
  } catch (e) {
    if (/Unsupported OAuth provider/i.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    if (e.statusCode === 409) {
      return res.status(409).json({ error: e.message });
    }
    if (
      /verification failed|audience mismatch|email is not verified|email is missing or unverified|did not match|required/i.test(
        e.message,
      )
    ) {
      return res.status(401).json({ error: e.message });
    }
    next(e);
  }
});

// ─── Protected routes (require a user session) ────────────────────

router.patch("/password", authenticateToken, requireSession, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: "Both passwords required" });
    const pwErr = validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const user = (await db.query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password_hash)
      return res.status(400).json({ error: "OAuth user — no password to change" });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.get("/me", authenticateToken, requireSession, async (req, res, next) => {
  try {
    const [result, languageSettings] = await Promise.all([
      db.query(
        "SELECT id, email, name, role, provider, avatar, preferred_locale, created_at FROM users WHERE id = $1",
        [req.user.id],
      ),
      getLanguageSettings(),
    ]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    const preferredLocale = user.preferred_locale || null;
    const defaultLocale = languageSettings.defaultLocale;
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      provider: user.provider,
      avatar: user.avatar,
      preferredLocale,
      defaultLocale,
      effectiveLocale: resolvePreferredLocale(preferredLocale, defaultLocale),
      created_at: user.created_at,
    });
  } catch (e) {
    next(e);
  }
});

router.patch("/profile", authenticateToken, requireSession, async (req, res) => {
  try {
    const body = req.body || {};
    const { name, avatar } = body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100) {
        return res.status(400).json({ error: "Name must be 1-100 characters" });
      }
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }

    if (avatar !== undefined) {
      if (avatar === null) {
        // Allow removing avatar
        updates.push(`avatar = $${idx++}`);
        values.push(null);
      } else if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
        // Max ~500KB base64 (roughly 375KB image)
        if (avatar.length > 500000) {
          return res.status(400).json({ error: "Image too large. Max 500KB." });
        }
        updates.push(`avatar = $${idx++}`);
        values.push(avatar);
      } else {
        return res.status(400).json({ error: "Invalid avatar format" });
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "preferredLocale")) {
      if (body.preferredLocale === null) {
        updates.push(`preferred_locale = $${idx++}`);
        values.push(null);
      } else {
        updates.push(`preferred_locale = $${idx++}`);
        values.push(parseRequiredLocale(body.preferredLocale, "preferredLocale"));
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING name, avatar, preferred_locale`,
      values,
    );
    const updated = result.rows[0] || {};
    const languageSettings = await getLanguageSettings();
    const preferredLocale = updated.preferred_locale || null;
    res.json({
      name: updated.name,
      avatar: updated.avatar,
      preferredLocale,
      defaultLocale: languageSettings.defaultLocale,
      effectiveLocale: resolvePreferredLocale(preferredLocale, languageSettings.defaultLocale),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// POST /auth/session-upgrade — upgrade a Bearer token into an HttpOnly cookie.
//
// Legacy bridge endpoint for older marketing auth flows that produced a
// backend-issued JWT server-side, then needed to upgrade it into the browser's
// HttpOnly session cookie. The token is re-verified here — a forged Bearer gets
// rejected.
//
// Path avoids /auth/session to remain compatible with older deployments that
// routed that path through the marketing app.
router.post("/session-upgrade", (req, res) => {
  const authHeader = req.headers["authorization"];
  const bearerMatch = typeof authHeader === "string" ? /^Bearer ([^\s]+)$/i.exec(authHeader) : null;
  if (!bearerMatch) return res.status(400).json({ error: "Bearer token required" });

  const token = bearerMatch[1];
  if (token.startsWith("nora_")) {
    return res.status(401).json({ error: "Invalid or expired Bearer token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!isLegacySessionPayload(decoded)) {
      return res.status(401).json({ error: "Invalid or expired Bearer token" });
    }
  } catch {
    return res.status(401).json({ error: "Invalid or expired Bearer token" });
  }

  setAuthCookie(res, token, req);
  res.json({ success: true });
});

// POST /auth/logout — clear the session cookie. No auth required so that a
// page holding a stale/invalid cookie can still clean itself up.
router.post("/logout", (req, res) => {
  clearAuthCookie(res, req);
  res.json({ success: true });
});

module.exports = router;
module.exports.__test = Object.freeze({ getAuthRateLimitConfig, parsePositiveIntegerEnv });
