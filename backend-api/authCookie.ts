// @ts-nocheck
// HttpOnly cookie for the primary user session token.
//
// Keeping the JWT out of localStorage closes the XSS-to-full-takeover path: a
// script injection can steal whatever's in localStorage, but it cannot read an
// HttpOnly cookie. SameSite=Lax permits the cookie on top-level navigations
// (OAuth callback redirects work) while blocking it on cross-origin
// subresource requests. Secure is on whenever the request came over HTTPS; in
// local dev over plain HTTP we fall back to non-Secure so the cookie still
// flows — Express sets this automatically via `req.secure` unless we force it.

const AUTH_COOKIE_NAME = "nora_auth";
// 7 days in ms — must match the JWT expiresIn to avoid premature cookie loss.
const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const sep = entry.indexOf("=");
      if (sep === -1) return cookies;
      const key = entry.slice(0, sep).trim();
      const value = entry.slice(sep + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});
}

function readAuthCookie(req) {
  const cookies = parseCookieHeader(req.headers?.cookie || "");
  return cookies[AUTH_COOKIE_NAME] || null;
}

/**
 * Extract a WebSocket session token, preferring the HttpOnly cookie over the
 * legacy query parameter that can appear in logs and browser history.
 *
 * @param {Object} request - WebSocket upgrade request.
 * @param {Object|null} searchParams - Parsed upgrade URL search parameters.
 * @returns {string|null} Session token when present.
 */
function extractSessionTokenFromUpgrade(request, searchParams) {
  const cookieToken = readAuthCookie(request);
  if (cookieToken) return cookieToken;
  const queryToken = searchParams?.get?.("token");
  return queryToken || null;
}

/**
 * Set the primary seven-day HttpOnly session cookie, enabling `Secure` for
 * HTTPS requests or when explicitly forced by configuration.
 *
 * @param {Object} res - Express response.
 * @param {string} token - Signed session JWT.
 * @param {Object} req - Express request used to determine transport security.
 * @returns {void}
 */
function setAuthCookie(res, token, req) {
  // NORA_FORCE_SECURE_COOKIES=1 forces Secure regardless of inbound scheme,
  // for operators behind always-on TLS who don't want to rely on
  // X-Forwarded-Proto being correct on every proxy hop.
  const isSecure =
    process.env.NORA_FORCE_SECURE_COOKIES === "1" ||
    Boolean(req?.secure) ||
    req?.headers?.["x-forwarded-proto"] === "https";
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  });
}

/**
 * Clear the session cookie with the same transport attributes used when setting it.
 *
 * @param {Object} res - Express response.
 * @param {Object} req - Express request used to determine transport security.
 * @returns {void}
 */
function clearAuthCookie(res, req) {
  // NORA_FORCE_SECURE_COOKIES=1 forces Secure regardless of inbound scheme,
  // for operators behind always-on TLS who don't want to rely on
  // X-Forwarded-Proto being correct on every proxy hop.
  const isSecure =
    process.env.NORA_FORCE_SECURE_COOKIES === "1" ||
    Boolean(req?.secure) ||
    req?.headers?.["x-forwarded-proto"] === "https";
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
  });
}

module.exports = {
  AUTH_COOKIE_NAME,
  readAuthCookie,
  setAuthCookie,
  clearAuthCookie,
  parseCookieHeader,
  extractSessionTokenFromUpgrade,
};
