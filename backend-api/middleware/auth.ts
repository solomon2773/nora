// @ts-nocheck
const jwt = require("jsonwebtoken");
const { readAuthCookie } = require("../authCookie");

// Session and API-key authentication

function headerValues(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * Parse explicit Bearer and API-key headers, rejecting malformed or conflicting credentials.
 * Cookie fallback is intentionally handled only after this result is accepted.
 *
 * @param {Object} req - Express request.
 * @returns {Object} Parsed token and source, or a fail-closed error code.
 */
function extractExplicitAuth(req) {
  const hasAuthorization = Object.prototype.hasOwnProperty.call(req.headers || {}, "authorization");
  const authorizationValues = headerValues(req.headers?.authorization);
  if (hasAuthorization && authorizationValues.length !== 1) {
    return { error: "invalid_auth_header" };
  }

  let authorizationToken = null;
  if (authorizationValues.length === 1) {
    const match = authorizationValues[0].match(/^Bearer\s+(\S+)$/i);
    if (!match) return { error: "invalid_auth_header" };
    authorizationToken = match[1];
  }

  const apiKeyValues = [
    ...headerValues(req.headers?.["x-api-key"]),
    ...headerValues(req.headers?.["x-nora-api-key"]),
  ];
  const hasApiKeyHeader = ["x-api-key", "x-nora-api-key"].some((name) =>
    Object.prototype.hasOwnProperty.call(req.headers || {}, name),
  );
  if (hasApiKeyHeader && apiKeyValues.length === 0) {
    return { error: "invalid_auth_header" };
  }
  const uniqueApiKeys = [...new Set(apiKeyValues)];
  if (uniqueApiKeys.length > 1) {
    return { error: "conflicting_auth" };
  }

  const apiKeyToken = uniqueApiKeys[0] || null;
  if (authorizationToken && apiKeyToken && authorizationToken !== apiKeyToken) {
    return { error: "conflicting_auth" };
  }

  if (authorizationToken) {
    return { token: authorizationToken, source: "authorization" };
  }
  if (apiKeyToken) {
    return { token: apiKeyToken, source: "api_key_header" };
  }
  return { token: null, source: null };
}

function tryDecodeSession(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

/**
 * Authenticate an HS256 session or workspace API key and attach its actor,
 * key metadata, scopes, and workspace binding for downstream authorization.
 *
 * @param {Object} req - Express request to authenticate.
 * @param {Object} res - Express response used for authentication failures.
 * @param {Function} next - Continuation invoked for valid credentials.
 * @returns {Promise} Resolves after authentication or an error response.
 */
async function authenticateToken(req, res, next) {
  const explicit = extractExplicitAuth(req);
  if (explicit.error === "conflicting_auth") {
    return res.status(400).json({
      error: "Conflicting authentication headers",
      code: "conflicting_auth",
    });
  }
  if (explicit.error === "invalid_auth_header") {
    return res.status(400).json({
      error: "Invalid authentication header",
      code: "invalid_auth_header",
    });
  }

  // Explicit Authorization/API-key headers always win over the browser cookie.
  // Otherwise a caller could attach a restricted API key to an authenticated
  // browser request and silently inherit the cookie's broader session powers.
  const token = explicit.token || readAuthCookie(req);
  const tokenSource = explicit.source || (token ? "cookie" : null);
  if (token && tokenSource !== "api_key_header" && !token.startsWith("nora_")) {
    const decoded = tryDecodeSession(token);
    if (decoded) {
      req.user = decoded;
      return next();
    }
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  // Bearer tokens with the nora_ prefix and explicit API-key headers use the
  // workspace API-key verifier. Cookies are never allowed to override them.
  const rawKey = tokenSource === "api_key_header" || token?.startsWith("nora_") ? token : null;
  if (rawKey) {
    try {
      const { verifyApiKey } = require("../apiKeys");
      const verified = await verifyApiKey(rawKey);
      if (verified) {
        req.user = verified.user
          ? {
              id: verified.user.id,
              email: verified.user.email,
              role: verified.user.role || "user",
              name: verified.user.name,
              authMethod: "api_key",
            }
          : { id: null, email: null, role: "user", authMethod: "api_key" };
        req.apiKey = verified.key;
        req.apiKeyWorkspace = verified.workspace;
        return next();
      }
    } catch (error) {
      console.error("API key verification failed:", error.message);
    }
    return res.status(401).json({ error: "Invalid or expired API key" });
  }

  return res.status(401).json({ error: "Authentication required" });
}

// Authorization guards

/**
 * Require the authenticated actor's platform role to be `admin`. This does not
 * exclude API keys; combine it with `requireSession` for session-only surfaces.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Continuation invoked for platform admins.
 * @returns {void}
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * Build a route guard that enforces one scope for API keys while allowing
 * session-authenticated requests to continue to their role guards.
 *
 * @param {string} requiredScope - Scope required from API-key callers.
 * @returns {Function} Express authorization middleware.
 */
function requireScope(requiredScope) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
    if (!scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: `API key is missing the "${requiredScope}" scope`,
        code: "missing_scope",
      });
    }
    next();
  };
}

/**
 * Build a method-aware API-key guard; a null read or write scope makes that
 * method class session-only while session callers continue normally.
 *
 * @param {string|null} readScope - Scope for GET, HEAD, and OPTIONS requests.
 * @param {string|null} writeScope - Scope for all mutating methods.
 * @returns {Function} Express authorization middleware.
 */
function scopeByMethod(readScope, writeScope) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const isRead = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    const required = isRead ? readScope : writeScope;
    if (!required) {
      return res.status(403).json({
        error: "This endpoint requires session authentication",
        code: "session_required",
      });
    }
    const scopes = Array.isArray(req.apiKey.scopes) ? req.apiKey.scopes : [];
    if (!scopes.includes(required)) {
      return res.status(403).json({
        error: `API key is missing the "${required}" scope`,
        code: "missing_scope",
      });
    }
    next();
  };
}

/**
 * Reject API-key-authenticated requests from a session-only route.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Continuation invoked for session callers.
 * @returns {void}
 */
function requireSession(req, res, next) {
  if (req.apiKey) {
    return res.status(403).json({
      error: "This endpoint requires session authentication",
      code: "session_required",
    });
  }
  next();
}

module.exports = {
  authenticateToken,
  extractExplicitAuth,
  requireAdmin,
  requireScope,
  requireSession,
  scopeByMethod,
};
