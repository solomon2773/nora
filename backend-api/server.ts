// @ts-nocheck
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const db = require("./db");
const billing = require("./billing");
const channels = require("./channels");
const marketplace = require("./marketplace");
const integrations = require("./integrations");
const snapshots = require("./snapshots");
const { getDeploymentDefaults, getSystemBanner } = require("./platformSettings");
const { buildReleaseInfo } = require("./releaseInfo");
const { collectAgentTelemetrySample } = require("./agentTelemetry");
const {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
} = require("./backgroundTasks");
const { STARTER_TEMPLATES } = require("./starterTemplates");
const { getBootstrapAdminSeedConfig } = require("./bootstrapAdmin");
const { ensureFirstRegisteredUserIsAdmin } = require("./ensureAdminUser");
const { authenticateToken } = require("./middleware/auth");
const { correlationId, errorHandler } = require("./middleware/errorHandler");
const { createGatewayRouter, attachGatewayWS } = require("./gatewayProxy");
const { isGatewayAvailableStatus } = require("./agentStatus");
const {
  gatewayUrlForAgent,
  dashboardUrlForAgent,
  hasGatewayEndpoint,
  hasHermesDashboardEndpoint,
} = require("../agent-runtime/lib/agentEndpoints");
const {
  getBackendCatalog,
  getBackendStatus,
  getDefaultBackend,
  getDefaultDeployTarget,
  getDefaultRuntimeFamily,
  getDefaultSandboxProfile,
  getEnabledBackends,
  getEnabledDeployTargets,
  getEnabledSandboxProfiles,
  getExecutionTargetCatalog,
  getRuntimeCatalog,
  getSandboxProfileCatalog,
} = require("../agent-runtime/lib/backendCatalog");

// ─── JWT Secret ───────────────────────────────────────────────────
const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;
if (!process.env.JWT_SECRET) {
  if (IS_TEST_ENV) {
    process.env.JWT_SECRET = "secret";
  } else if (process.env.NODE_ENV === "production") {
    console.error(
      "FATAL: JWT_SECRET must be set in production. Refusing to start with an ephemeral secret.",
    );
    process.exit(1);
  } else {
    console.warn(
      "SECURITY WARNING: JWT_SECRET not configured. Using ephemeral secret — all tokens will invalidate on restart. Set JWT_SECRET in .env.",
    );
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  }
}

// ─── App Setup ────────────────────────────────────────────────────
const app = express();
const EMBED_SESSION_TTL_MS = 15 * 60 * 1000;
const EMBED_SESSION_COOKIE_PREFIX = "__nora_gateway_embed_";
const HERMES_EMBED_SESSION_COOKIE_PREFIX = "__nora_hermes_embed_";
const EMBED_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob: https:",
  "base-uri 'self'",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https:",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

app.set("trust proxy", 1);
app.use(helmet());

function requestProtocol(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0 && forwarded[0].trim()) {
    return forwarded[0].split(",")[0].trim();
  }
  return req.protocol;
}

function getEmbedSessionCookieName(agentId, prefix = EMBED_SESSION_COOKIE_PREFIX) {
  return `${prefix}${agentId}`;
}

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

function buildForwardedSearch(req) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === "token" || value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

function buildEmbedBootstrapScript({ agentId, requestHost, requestScheme, gatewayToken }) {
  const wsProto = requestScheme === "https" ? "wss" : "ws";
  // Intentionally no `?token=` — the WebSocket upgrade is authenticated via
  // the HttpOnly embed session cookie (`__nora_gateway_embed_<agentId>`) that
  // the browser sends automatically on same-origin upgrade requests. Keeping
  // the JWT out of the URL prevents it from surfacing in nginx/access logs,
  // browser history, and DevTools network panels.
  const wsRelayUrl = `${wsProto}://${requestHost}/api/ws/gateway/${agentId}`;
  return `(function(){
  var R=${JSON.stringify(wsRelayUrl)};
  var P=${JSON.stringify(gatewayToken)};
  window.__NORA_EMBED_AUTO_LOGIN__ = true;
  var _WS=window.WebSocket;
  window.WebSocket=function(u,p){return p?new _WS(R,p):new _WS(R)};
  window.WebSocket.prototype=_WS.prototype;
  window.WebSocket.CONNECTING=_WS.CONNECTING;
  window.WebSocket.OPEN=_WS.OPEN;
  window.WebSocket.CLOSING=_WS.CLOSING;
  window.WebSocket.CLOSED=_WS.CLOSED;

  function setPasswordHash() {
    try {
      var nextHash = "password=" + encodeURIComponent(P);
      if (window.location.hash !== "#" + nextHash) {
        window.location.hash = nextHash;
      }
    } catch {}
  }

  function visible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findLoginButton() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll("button, input[type='submit']"));
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!visible(b) || b.disabled) continue;
      var txt = String((b.innerText || b.textContent || b.value || "")).toLowerCase().trim();
      if (/^login$|^log in$|^sign in$|connect|unlock/.test(txt)) return b;
    }
    return null;
  }

  function tryAutoLogin() {
    if (window.__NORA_EMBED_AUTO_LOGIN_DONE__) return true;
    setPasswordHash();

    var pw = document.querySelector("input[type='password'], input[name='password'], input[id*='password']");
    if (pw && visible(pw) && pw.value !== P) {
      pw.focus();
      pw.value = P;
      pw.dispatchEvent(new Event("input", { bubbles: true }));
      pw.dispatchEvent(new Event("change", { bubbles: true }));
    }

    var form = pw && (pw.form || pw.closest("form"));
    if (form && visible(form)) {
      window.__NORA_EMBED_AUTO_LOGIN_DONE__ = true;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    }

    var loginBtn = findLoginButton();
    if (loginBtn) {
      window.__NORA_EMBED_AUTO_LOGIN_DONE__ = true;
      loginBtn.click();
      return true;
    }
    return false;
  }

  function startAutoLogin() {
    if (window.__NORA_EMBED_AUTO_LOGIN_STARTED__) return;
    window.__NORA_EMBED_AUTO_LOGIN_STARTED__ = true;
    setPasswordHash();

    var attempts = 0;
    var maxAttempts = 80;
    var interval = setInterval(function() {
      attempts++;
      if (tryAutoLogin() || attempts >= maxAttempts) {
        clearInterval(interval);
        if (observer) observer.disconnect();
      }
    }, 200);

    var observer = new MutationObserver(function() {
      if (window.__NORA_EMBED_AUTO_LOGIN_DONE__) {
        observer.disconnect();
        clearInterval(interval);
        return;
      }
      tryAutoLogin();
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAutoLogin, { once: true });
  } else {
    startAutoLogin();
  }
})();`;
}

function injectEmbedBootstrapScript(html, agentId) {
  const embedBaseHref = `/api/agents/${encodeURIComponent(agentId)}/gateway/embed/`;
  const bootstrapSrc = `/api/agents/${encodeURIComponent(agentId)}/gateway/embed/bootstrap.js`;
  return html.replace(
    /<head[^>]*>/i,
    (match) => `${match}<base href="${embedBaseHref}"><script src="${bootstrapSrc}"></script>`,
  );
}

function setEmbedHtmlHeaders(res) {
  // OpenClaw's control UI ships an inline theme bootstrap and may load
  // same-origin WebSockets via the injected relay script, so the global
  // Helmet defaults are too strict for the proxied embed document.
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("Content-Security-Policy-Report-Only");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", EMBED_CONTENT_SECURITY_POLICY);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Vary", "Cookie");
}

function hermesEmbedBasePath(agentId) {
  return `/api/agents/${encodeURIComponent(agentId)}/hermes-ui/embed`;
}

function rewriteHermesEmbedHtml(html, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  return html
    .replace(/(["'])\/assets\//g, `$1${embedBase}/assets/`)
    .replace(/(["'])\/fonts\//g, `$1${embedBase}/fonts/`)
    .replace(/(["'])\/favicon\.ico(["'])/g, `$1${embedBase}/favicon.ico$2`);
}

function rewriteHermesEmbedCss(css, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  return css.replace(/url\((['"]?)\/fonts\//g, `url($1${embedBase}/fonts/`);
}

function rewriteHermesEmbedJavascript(source, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  let rewritten = source.replace(/(["'`])\/api\//g, `$1${embedBase}/api/`);
  const routerMarker = "jsx($y,{children:";
  if (rewritten.includes(routerMarker)) {
    rewritten = rewritten.replace(
      routerMarker,
      `jsx($y,{basename:${JSON.stringify(embedBase)},children:`,
    );
  }
  return rewritten;
}

function setProxyResponseHeaders(res, resp, { cachePolicy = "asset" } = {}) {
  const contentType = resp.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);

  const cacheControl = resp.headers.get("cache-control");
  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  } else if (cachePolicy === "no-store") {
    res.setHeader("Cache-Control", "no-store");
  } else {
    res.setHeader("Cache-Control", "public, max-age=3600");
  }

  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

async function lookupEmbedAgent(agentId, userId) {
  const result = await db.query(
    `SELECT host, gateway_token, gateway_host_port, gateway_host, gateway_port, status
       FROM agents
      WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  if (
    !result.rows[0] ||
    !isGatewayAvailableStatus(result.rows[0].status) ||
    !hasGatewayEndpoint(result.rows[0])
  ) {
    return null;
  }
  return result.rows[0];
}

async function lookupHermesEmbedAgent(agentId, userId) {
  const result = await db.query(
    `SELECT host, runtime_host, runtime_port, status, runtime_family, backend_type
       FROM agents
      WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  if (
    !result.rows[0] ||
    !isGatewayAvailableStatus(result.rows[0].status) ||
    !hasHermesDashboardEndpoint(result.rows[0])
  ) {
    return null;
  }
  return result.rows[0];
}

async function resolveEmbedAccess(
  req,
  res,
  {
    allowQueryToken = true,
    lookupAgent = lookupEmbedAgent,
    cookiePrefix = EMBED_SESSION_COOKIE_PREFIX,
    scope = "gateway-embed",
  } = {},
) {
  const jwt = require("jsonwebtoken");
  const agentId = req.params.agentId;
  const embedCookieName = getEmbedSessionCookieName(agentId, cookiePrefix);
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const cookieToken = cookies[embedCookieName];
  const queryToken = allowQueryToken && typeof req.query.token === "string" ? req.query.token : "";

  let userId;
  let relayToken;

  if (queryToken) {
    let payload;
    try {
      payload = jwt.verify(queryToken, process.env.JWT_SECRET);
    } catch {
      res.status(401).send("invalid token");
      return null;
    }
    // Only full user bearer JWTs (no `scope`) may be used here to mint a new
    // embed session. Embed-scoped JWTs must flow through the cookie path,
    // where scope + agentId are validated; accepting them here would let a
    // leaked embed-scoped token mint fresh sessions for sibling agents.
    if (payload.scope && (payload.scope !== scope || payload.agentId !== agentId)) {
      res.status(401).send("invalid token for this embed");
      return null;
    }
    userId = payload.id;
  } else if (cookieToken) {
    let payload;
    try {
      payload = jwt.verify(cookieToken, process.env.JWT_SECRET);
    } catch {
      res.status(401).send("invalid embed session");
      return null;
    }
    if (payload.scope !== scope || payload.agentId !== agentId) {
      res.status(401).send("invalid embed session");
      return null;
    }
    userId = payload.id;
    relayToken = cookieToken;
  } else {
    res.status(401).send("embed session required");
    return null;
  }

  const agent = await lookupAgent(agentId, userId);
  if (!agent) {
    res.status(404).send("agent not found or not running");
    return null;
  }

  if (!relayToken) {
    relayToken = jwt.sign({ id: userId, agentId, scope }, process.env.JWT_SECRET, {
      expiresIn: Math.floor(EMBED_SESSION_TTL_MS / 1000),
    });
    res.cookie(embedCookieName, relayToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: requestProtocol(req) === "https",
      maxAge: EMBED_SESSION_TTL_MS,
      path: "/",
    });
  }

  return { agent, agentId, userId, relayToken };
}

function getEmbeddedGatewayPath(req) {
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
  const prefix = `${req.baseUrl || `/agents/${req.params.agentId}/gateway`}/embed`;
  const suffix = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : "";
  return suffix.replace(/^\/+/, "");
}

function getEmbeddedHermesPath(req) {
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
  const prefix = `${req.baseUrl || `/agents/${req.params.agentId}/hermes-ui`}/embed`;
  const suffix = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : "";
  return suffix.replace(/^\/+/, "");
}

const corsOrigins = (
  process.env.CORS_ORIGINS ||
  process.env.NEXTAUTH_URL ||
  "http://localhost:8080"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// Stripe webhook needs raw body — must come before express.json()
if (billing.BILLING_ENABLED) {
  app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(500).json({ error: "Webhook secret not configured" });
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      await billing.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (e) {
      console.error("Webhook error:", e.message);
      res.status(400).json({ error: e.message });
    }
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(correlationId);
app.use(require("./middleware/requestMetrics"));

// ─── Public Routes ────────────────────────────────────────────────

let _startupComplete = IS_TEST_ENV;
app.get("/health", (req, res) => {
  if (!_startupComplete) return res.status(503).json({ status: "starting" });
  res.json({ status: "ok" });
});

app.get("/config/platform", async (_req, res) => {
  try {
    const defaultRuntimeFamily = getDefaultRuntimeFamily();
    const runtimeFamilies = getRuntimeCatalog();
    const executionTargets = getExecutionTargetCatalog(process.env, {
      runtimeFamily: defaultRuntimeFamily,
    });
    const sandboxProfiles = getSandboxProfileCatalog(process.env, {
      runtimeFamily: defaultRuntimeFamily,
    });
    res.json({
      mode: billing.PLATFORM_MODE,
      selfhosted: billing.PLATFORM_MODE !== "paas" ? billing.SELFHOSTED_LIMITS : null,
      billingEnabled: billing.BILLING_ENABLED,
      enabledBackends: getEnabledBackends(),
      defaultBackend: getDefaultBackend(),
      enabledDeployTargets: getEnabledDeployTargets(),
      defaultDeployTarget: getDefaultDeployTarget(),
      enabledSandboxProfiles: getEnabledSandboxProfiles(),
      defaultSandboxProfile: getDefaultSandboxProfile(),
      runtimeFamilies,
      executionTargets,
      sandboxProfiles,
      defaultRuntimeFamily,
      deploymentDefaults: await getDeploymentDefaults(),
      systemBanner: await getSystemBanner(),
      release: await buildReleaseInfo(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/config/backends", (_req, res) => {
  const defaultRuntimeFamily = getDefaultRuntimeFamily();
  const runtimeFamilies = getRuntimeCatalog();
  const executionTargets = getExecutionTargetCatalog(process.env, {
    runtimeFamily: defaultRuntimeFamily,
  });
  const sandboxProfiles = getSandboxProfileCatalog(process.env, {
    runtimeFamily: defaultRuntimeFamily,
  });
  const activeRuntimeFamily =
    runtimeFamilies.find((runtimeFamily) => runtimeFamily.id === defaultRuntimeFamily) ||
    runtimeFamilies[0] ||
    null;
  res.json({
    runtimeFamily: activeRuntimeFamily,
    runtimeFamilies,
    defaultRuntimeFamily,
    enabledDeployTargets: getEnabledDeployTargets(),
    defaultDeployTarget: getDefaultDeployTarget(),
    enabledSandboxProfiles: getEnabledSandboxProfiles(),
    defaultSandboxProfile: getDefaultSandboxProfile(),
    executionTargets,
    sandboxProfiles,
    enabledBackends: getEnabledBackends(),
    defaultBackend: getDefaultBackend(),
    backends: getBackendCatalog(),
    legacyBackends: getBackendCatalog(),
  });
});

app.get("/config/nemoclaw", (req, res) => {
  const nemoclaw = getBackendStatus("nemoclaw");
  res.json({
    enabled: nemoclaw.enabled,
    configured: nemoclaw.configured,
    available: nemoclaw.available,
    issue: nemoclaw.issue,
    defaultModel: nemoclaw.defaultModel,
    sandboxImage: nemoclaw.sandboxImage,
    models: nemoclaw.models,
  });
});

// Inbound webhook receiver (public — external services POST here)
app.post("/webhooks/:channelId", async (req, res) => {
  try {
    await channels.handleInboundWebhook(req.params.channelId, req.body, req.headers);
    res.json({ received: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use("/auth", require("./routes/auth"));

// ─── Gateway UI static assets (before auth wall — JS/CSS/icons contain no user data) ──
// These are served pre-auth because iframes can't set Authorization headers on sub-resource loads.
// Only opaque static files (JS bundles, CSS, favicons) are exempted — not HTML or
// internal gateway API/config endpoints.
const gatewayUIAssetProxy = require("express").Router();
const PREAUTH_ASSET_METHODS = new Set(["GET", "HEAD"]);
const EMBED_PROXY_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

gatewayUIAssetProxy.use("/agents/:agentId/gateway", (req, res, next) => {
  if (!PREAUTH_ASSET_METHODS.has(req.method)) return next();
  if (
    req.path === "/assets" ||
    req.path.startsWith("/assets/") ||
    req.path.startsWith("/favicon")
  ) {
    return proxyGatewayAsset(req, res);
  }
  return next();
});

// ─── Gateway UI Embed (pre-auth) ────────────────────────────────────────────────
// The first HTML request authenticates via ?token= and mints a short-lived
// HttpOnly embed-session cookie. Subsequent iframe navigations and relative
// asset/config requests stay within /gateway/embed/* and authenticate via that
// cookie so the control UI can keep using its own relative paths.
gatewayUIAssetProxy.get("/agents/:agentId/gateway/embed/bootstrap.js", async (req, res) => {
  try {
    const access = await resolveEmbedAccess(req, res);
    if (!access) return;

    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Cookie");
    res.send(
      buildEmbedBootstrapScript({
        agentId: access.agentId,
        requestHost: req.headers.host,
        requestScheme: requestProtocol(req),
        gatewayToken: access.agent.gateway_token,
      }),
    );
  } catch (err) {
    console.error("[gateway-embed-bootstrap] error:", err);
    if (!res.headersSent) {
      res.status(502).type("text/plain").send("embed bootstrap error");
    }
  }
});

async function proxyEmbeddedGateway(req, res) {
  try {
    const access = await resolveEmbedAccess(req, res);
    if (!access) return;

    const gatewayPath = getEmbeddedGatewayPath(req);
    const targetUrl = `${gatewayUrlForAgent(access.agent, gatewayPath)}${buildForwardedSearch(req)}`;
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
    };

    const method = req.method.toUpperCase();
    let body;
    if (method !== "GET" && method !== "HEAD" && req.body != null) {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        body = req.body;
      } else if (Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
        if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      }
    }

    const resp = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });

    const contentType = resp.headers.get("content-type") || "";
    res.status(resp.status);

    if (/text\/html/i.test(contentType)) {
      const html = injectEmbedBootstrapScript(await resp.text(), access.agentId);
      setEmbedHtmlHeaders(res);
      res.send(html);
      return;
    }

    if (contentType) res.setHeader("Content-Type", contentType);
    const cacheControl = resp.headers.get("cache-control");
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);
    else res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Vary", "Cookie");

    const bodyBuffer = await resp.arrayBuffer();
    res.send(Buffer.from(bodyBuffer));
  } catch (err) {
    console.error("[gateway-embed-proxy] error:", err);
    if (!res.headersSent) res.status(502).send(`embed proxy error: ${err.message}`);
  }
}

gatewayUIAssetProxy.use("/agents/:agentId/gateway", (req, res, next) => {
  if (!EMBED_PROXY_METHODS.has(req.method)) return next();
  if (req.path === "/embed" || req.path.startsWith("/embed/")) {
    return proxyEmbeddedGateway(req, res);
  }
  return next();
});

async function proxyEmbeddedHermes(req, res) {
  try {
    const access = await resolveEmbedAccess(req, res, {
      lookupAgent: lookupHermesEmbedAgent,
      cookiePrefix: HERMES_EMBED_SESSION_COOKIE_PREFIX,
      scope: "hermes-embed",
    });
    if (!access) return;

    const hermesPath = getEmbeddedHermesPath(req);
    const targetUrl = `${dashboardUrlForAgent(access.agent, hermesPath)}${buildForwardedSearch(req)}`;
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
    };
    // Intentionally do NOT forward the client's Authorization header to the
    // tenant-owned Hermes container. The embed session cookie already
    // authenticates this request at the proxy boundary; forwarding the
    // platform JWT upstream would expose it to a process whose image may be
    // operator-supplied and should be treated as untrusted.

    const method = req.method.toUpperCase();
    let body;
    if (method !== "GET" && method !== "HEAD" && req.body != null) {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        body = req.body;
      } else if (Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
      }
      if (req.headers["content-type"]) {
        headers["Content-Type"] = req.headers["content-type"];
      }
    }

    const resp = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });

    const contentType = resp.headers.get("content-type") || "";
    const isApiRequest = hermesPath.startsWith("api/");
    res.status(resp.status);

    if (/text\/html/i.test(contentType)) {
      const html = rewriteHermesEmbedHtml(await resp.text(), access.agentId);
      setEmbedHtmlHeaders(res);
      res.send(html);
      return;
    }

    if (/(?:javascript|ecmascript)/i.test(contentType) || /\.js(?:$|\?)/i.test(hermesPath)) {
      const javascript = rewriteHermesEmbedJavascript(await resp.text(), access.agentId);
      setProxyResponseHeaders(res, resp, {
        cachePolicy: isApiRequest ? "no-store" : "asset",
      });
      res.send(javascript);
      return;
    }

    if (/text\/css/i.test(contentType) || /\.css(?:$|\?)/i.test(hermesPath)) {
      const css = rewriteHermesEmbedCss(await resp.text(), access.agentId);
      setProxyResponseHeaders(res, resp, {
        cachePolicy: isApiRequest ? "no-store" : "asset",
      });
      res.send(css);
      return;
    }

    setProxyResponseHeaders(res, resp, {
      cachePolicy: isApiRequest ? "no-store" : "asset",
    });
    const bodyBuffer = await resp.arrayBuffer();
    res.send(Buffer.from(bodyBuffer));
  } catch (err) {
    console.error("[hermes-embed-proxy] error:", err);
    if (!res.headersSent) res.status(502).send(`embed proxy error: ${err.message}`);
  }
}

gatewayUIAssetProxy.use("/agents/:agentId/hermes-ui", (req, res, next) => {
  if (!EMBED_PROXY_METHODS.has(req.method)) return next();
  if (req.path === "/embed" || req.path.startsWith("/embed/")) {
    return proxyEmbeddedHermes(req, res);
  }
  return next();
});

async function proxyGatewayAsset(req, res) {
  try {
    const db = require("./db");
    const agentId = req.params.agentId;
    const result = await db.query(
      `SELECT host, gateway_host_port, gateway_host, gateway_port, status
         FROM agents
        WHERE id = $1`,
      [agentId],
    );
    if (
      !result.rows[0] ||
      !isGatewayAvailableStatus(result.rows[0].status) ||
      !hasGatewayEndpoint(result.rows[0])
    ) {
      return res.status(404).end();
    }
    const gatewayPath = req.path || "/";
    const targetUrl = `${gatewayUrlForAgent(result.rows[0], gatewayPath)}${req._parsedUrl?.search || ""}`;
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers: { Accept: req.headers.accept || "*/*", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(10000),
    });
    res.status(resp.status);
    setProxyResponseHeaders(res, resp);
    const body = await resp.arrayBuffer();
    res.send(Buffer.from(body));
  } catch {
    res.status(502).end();
  }
}
app.use(gatewayUIAssetProxy);

// ─── Auth Wall ────────────────────────────────────────────────────
app.use(authenticateToken);

// ─── Gateway Proxy ────────────────────────────────────────────────
app.use(createGatewayRouter());

// ─── Protected Routes ─────────────────────────────────────────────
app.use("/agents", require("./routes/agents"));
app.use("/agents", require("./routes/agentFiles"));
app.use("/agents", require("./routes/channels"));
app.use("/agents", require("./routes/nemoclaw"));
app.use("/agent-migrations", require("./routes/agentMigrations"));
app.use("/", require("./routes/integrations")); // handles /agents/:id/integrations + /integrations/catalog
app.use("/", require("./routes/monitoring")); // handles /monitoring/* + /agents/:id/metrics
app.use("/llm-providers", require("./routes/llmProviders"));
app.use("/clawhub", require("./routes/clawhub"));
app.use("/marketplace", require("./routes/marketplace"));
app.use("/workspaces", require("./routes/workspaces"));
app.use("/billing", require("./routes/billing"));
app.use("/admin", require("./routes/admin"));

// ─── Central Error Handler ────────────────────────────────────────
app.use(errorHandler);

// ─── DB Migration ─────────────────────────────────────────────────
async function migrateDB() {
  const migrations = [
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN backend_type VARCHAR(20) NOT NULL DEFAULT 'docker';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS integration_catalog (
       id VARCHAR(50) PRIMARY KEY,
       name VARCHAR(100) NOT NULL,
       icon VARCHAR(50),
       category VARCHAR(50) NOT NULL,
       description TEXT,
       auth_type VARCHAR(20),
       config_schema JSONB NOT NULL DEFAULT '{}',
       enabled BOOLEAN DEFAULT true
     )`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN catalog_id VARCHAR(50) REFERENCES integration_catalog(id);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN config JSONB DEFAULT '{}';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN status VARCHAR(20) DEFAULT 'active';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS channels (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       type VARCHAR(30) NOT NULL,
       name VARCHAR(100) NOT NULL,
       config JSONB NOT NULL DEFAULT '{}',
       enabled BOOLEAN DEFAULT true,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS channel_messages (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
       direction VARCHAR(10) NOT NULL,
       content TEXT NOT NULL,
       metadata JSONB DEFAULT '{}',
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN gateway_token TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS llm_providers (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       provider VARCHAR(30) NOT NULL,
       api_key TEXT,
       model VARCHAR(100),
       config JSONB DEFAULT '{}',
       is_default BOOLEAN DEFAULT false,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN sandbox_type VARCHAR(20) DEFAULT 'standard';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN runtime_family VARCHAR(20);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN deploy_target VARCHAR(20);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN sandbox_profile VARCHAR(20);
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `UPDATE agents
        SET runtime_family = CASE
          WHEN backend_type = 'hermes' THEN 'hermes'
          ELSE 'openclaw'
        END
      WHERE runtime_family IS NULL OR BTRIM(runtime_family) = ''`,
    `UPDATE agents
        SET deploy_target = CASE
          WHEN backend_type = 'kubernetes' THEN 'k8s'
          WHEN backend_type = 'hermes' THEN 'docker'
          WHEN backend_type = 'nemoclaw' THEN 'docker'
          WHEN backend_type IN ('docker', 'k8s', 'proxmox') THEN backend_type
          ELSE 'docker'
        END
      WHERE deploy_target IS NULL OR BTRIM(deploy_target) = ''`,
    `UPDATE agents
        SET sandbox_profile = CASE
          WHEN sandbox_type = 'nemoclaw' THEN 'nemoclaw'
          WHEN backend_type = 'nemoclaw' THEN 'nemoclaw'
          ELSE 'standard'
        END
      WHERE sandbox_profile IS NULL OR BTRIM(sandbox_profile) = ''`,
    `ALTER TABLE agents ALTER COLUMN runtime_family SET DEFAULT 'openclaw'`,
    `ALTER TABLE agents ALTER COLUMN deploy_target SET DEFAULT 'docker'`,
    `ALTER TABLE agents ALTER COLUMN sandbox_profile SET DEFAULT 'standard'`,
    `UPDATE agents
        SET backend_type = CASE
          WHEN runtime_family = 'hermes' THEN 'hermes'
          WHEN sandbox_profile = 'nemoclaw' THEN 'nemoclaw'
          WHEN deploy_target = 'kubernetes' THEN 'k8s'
          WHEN deploy_target IN ('docker', 'k8s', 'proxmox') THEN deploy_target
          ELSE 'docker'
        END
      WHERE runtime_family IS NOT NULL
        AND deploy_target IS NOT NULL
        AND sandbox_profile IS NOT NULL
        AND backend_type IS DISTINCT FROM CASE
          WHEN runtime_family = 'hermes' THEN 'hermes'
          WHEN sandbox_profile = 'nemoclaw' THEN 'nemoclaw'
          WHEN deploy_target = 'kubernetes' THEN 'k8s'
          WHEN deploy_target IN ('docker', 'k8s', 'proxmox') THEN deploy_target
          ELSE 'docker'
        END`,
    `UPDATE agents
        SET sandbox_type = CASE
          WHEN sandbox_profile = 'nemoclaw' THEN 'nemoclaw'
          ELSE 'standard'
        END
      WHERE runtime_family IS NOT NULL
        AND sandbox_profile IS NOT NULL
        AND sandbox_type IS DISTINCT FROM CASE
          WHEN sandbox_profile = 'nemoclaw' THEN 'nemoclaw'
          ELSE 'standard'
        END`,
    `ALTER TABLE agents ALTER COLUMN runtime_family SET NOT NULL`,
    `ALTER TABLE agents ALTER COLUMN deploy_target SET NOT NULL`,
    `ALTER TABLE agents ALTER COLUMN sandbox_profile SET NOT NULL`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN vcpu INTEGER DEFAULT 1; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN ram_mb INTEGER DEFAULT 1024; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN disk_gb INTEGER DEFAULT 10; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS platform_settings (
       singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
       default_vcpu INTEGER NOT NULL DEFAULT 1,
       default_ram_mb INTEGER NOT NULL DEFAULT 1024,
       default_disk_gb INTEGER NOT NULL DEFAULT 10,
       system_banner_enabled BOOLEAN NOT NULL DEFAULT false,
       system_banner_severity TEXT NOT NULL DEFAULT 'warning',
       system_banner_title TEXT NOT NULL DEFAULT '',
       system_banner_message TEXT NOT NULL DEFAULT '',
       created_at TIMESTAMP DEFAULT NOW(),
       updated_at TIMESTAMP DEFAULT NOW()
     )`,
    `INSERT INTO platform_settings(singleton, default_vcpu, default_ram_mb, default_disk_gb)
       VALUES(TRUE, 1, 1024, 10)
       ON CONFLICT (singleton) DO NOTHING`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_enabled BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_severity TEXT NOT NULL DEFAULT 'warning'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_title TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_message TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS usage_metrics (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       metric_type VARCHAR(50) NOT NULL,
       value NUMERIC NOT NULL DEFAULT 0,
       metadata JSONB DEFAULT '{}',
       recorded_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_agent ON usage_metrics(agent_id, recorded_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_user ON usage_metrics(user_id, recorded_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_type ON usage_metrics(metric_type, recorded_at)`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN avatar TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS container_stats (
       id BIGSERIAL PRIMARY KEY,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       cpu_percent NUMERIC NOT NULL DEFAULT 0,
       memory_usage_mb INTEGER NOT NULL DEFAULT 0,
       memory_limit_mb INTEGER NOT NULL DEFAULT 0,
       memory_percent NUMERIC NOT NULL DEFAULT 0,
       network_rx_mb NUMERIC NOT NULL DEFAULT 0,
       network_tx_mb NUMERIC NOT NULL DEFAULT 0,
       disk_read_mb NUMERIC NOT NULL DEFAULT 0,
       disk_write_mb NUMERIC NOT NULL DEFAULT 0,
       pids INTEGER NOT NULL DEFAULT 0,
       recorded_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN ALTER TABLE container_stats ADD COLUMN network_rx_rate_mbps NUMERIC NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE container_stats ADD COLUMN network_tx_rate_mbps NUMERIC NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE container_stats ADD COLUMN disk_read_rate_mbps NUMERIC NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE container_stats ADD COLUMN disk_write_rate_mbps NUMERIC NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE INDEX IF NOT EXISTS idx_container_stats_agent_time ON container_stats(agent_id, recorded_at DESC)`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN gateway_host_port INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN runtime_host TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN runtime_port INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN gateway_host TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN gateway_port INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN image TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN template_payload JSONB DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `UPDATE agents SET template_payload = '{}'::jsonb WHERE template_payload IS NULL`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN clawhub_skills JSONB DEFAULT '[]'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `UPDATE agents SET clawhub_skills = '[]'::jsonb WHERE clawhub_skills IS NULL`,
    `CREATE TABLE IF NOT EXISTS agent_migrations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       deployed_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       runtime_family VARCHAR(20) NOT NULL DEFAULT 'openclaw',
       source_kind TEXT NOT NULL DEFAULT 'upload',
       source_transport TEXT,
       status TEXT NOT NULL DEFAULT 'ready',
       summary JSONB DEFAULT '{}',
       warnings JSONB DEFAULT '[]',
       encrypted_manifest TEXT NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       expires_at TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_migrations_user_created
       ON agent_migrations(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_migrations_agent
       ON agent_migrations(deployed_agent_id)`,
    `CREATE TABLE IF NOT EXISTS agent_secret_overrides (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       env_key TEXT NOT NULL,
       env_value TEXT NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(agent_id, env_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_secret_overrides_agent
       ON agent_secret_overrides(agent_id, env_key)`,
    `CREATE TABLE IF NOT EXISTS hermes_runtime_state (
       agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
       model_config JSONB DEFAULT '{}',
       channel_configs JSONB DEFAULT '{}',
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN ALTER TABLE snapshots ADD COLUMN kind TEXT DEFAULT 'snapshot'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE snapshots ADD COLUMN template_key TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE snapshots ADD COLUMN built_in BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN built_in BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN downloads INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN source_type TEXT DEFAULT 'platform'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN status TEXT DEFAULT 'published'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN visibility TEXT DEFAULT 'public'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN slug TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN current_version INTEGER DEFAULT 1; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN published_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN updated_at TIMESTAMP DEFAULT NOW(); EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN reviewed_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE marketplace_listings ADD COLUMN review_notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `UPDATE marketplace_listings
        SET source_type = CASE WHEN COALESCE(built_in, false) THEN 'platform' ELSE 'community' END
      WHERE source_type IS NULL`,
    `UPDATE marketplace_listings
        SET status = CASE WHEN COALESCE(built_in, false) THEN 'published' ELSE 'pending_review' END
      WHERE status IS NULL`,
    `UPDATE marketplace_listings SET visibility = 'public' WHERE visibility IS NULL`,
    `UPDATE marketplace_listings SET price = 'Free' WHERE price IS DISTINCT FROM 'Free'`,
    `UPDATE marketplace_listings SET downloads = 0 WHERE downloads IS NULL`,
    `UPDATE marketplace_listings SET current_version = 1 WHERE current_version IS NULL`,
    `UPDATE marketplace_listings SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL`,
    `UPDATE marketplace_listings
        SET published_at = COALESCE(published_at, created_at, NOW())
      WHERE status = 'published' AND published_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_listings_slug_unique ON marketplace_listings(slug) WHERE slug IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_marketplace_listings_owner ON marketplace_listings(owner_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_marketplace_listings_source_status ON marketplace_listings(source_type, status, published_at DESC)`,
    `CREATE TABLE IF NOT EXISTS marketplace_listing_versions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
       snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
       version_number INTEGER NOT NULL,
       clone_mode TEXT DEFAULT 'files_only',
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(listing_id, version_number),
       UNIQUE(listing_id, snapshot_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_marketplace_listing_versions_listing ON marketplace_listing_versions(listing_id, version_number DESC)`,
    `CREATE TABLE IF NOT EXISTS marketplace_reports (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
       reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       reason TEXT NOT NULL,
       details TEXT,
       status TEXT DEFAULT 'open',
       reviewed_at TIMESTAMP,
       reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_marketplace_reports_listing_status ON marketplace_reports(listing_id, status, created_at DESC)`,
    `INSERT INTO marketplace_listing_versions(listing_id, snapshot_id, version_number, clone_mode)
       SELECT ml.id, ml.snapshot_id, COALESCE(ml.current_version, 1), 'files_only'
         FROM marketplace_listings ml
         LEFT JOIN marketplace_listing_versions v
           ON v.listing_id = ml.id AND v.snapshot_id = ml.snapshot_id
        WHERE ml.snapshot_id IS NOT NULL
          AND v.id IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_template_key ON snapshots(template_key)`,
    `CREATE INDEX IF NOT EXISTS idx_marketplace_listings_snapshot_id ON marketplace_listings(snapshot_id)`,
  ];

  for (const sql of migrations) {
    try {
      await db.query(sql);
    } catch (e) {
      console.error("Migration step failed:", e.message);
    }
  }
  console.log("DB migrations applied");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function seedStarterMarketplace() {
  for (const template of STARTER_TEMPLATES) {
    const existingListing = await marketplace.getPlatformListingByTemplateKey(template.templateKey);

    let snapshotId = existingListing?.snapshot_id || null;
    let shouldCreateSnapshot = !snapshotId;

    if (snapshotId) {
      const currentSnapshot = await snapshots.getSnapshot(snapshotId);
      const currentConfig =
        currentSnapshot?.config && typeof currentSnapshot.config === "object"
          ? currentSnapshot.config
          : {};
      shouldCreateSnapshot =
        !currentSnapshot ||
        currentSnapshot.name !== template.name ||
        currentSnapshot.description !== template.description ||
        stableStringify(currentConfig) !== stableStringify(template.snapshotConfig);
    }

    if (shouldCreateSnapshot) {
      const snapshot = await snapshots.createSnapshot(
        null,
        template.name,
        template.description,
        template.snapshotConfig,
        {
          kind: template.snapshotConfig.kind || "starter-template",
          templateKey: template.templateKey,
          builtIn: true,
        },
      );
      snapshotId = snapshot.id;
    }

    await marketplace.upsertListing({
      listingId: existingListing?.id || null,
      snapshotId,
      name: template.name,
      description: template.description,
      price: template.price,
      category: template.category,
      builtIn: true,
      sourceType: marketplace.LISTING_SOURCE_PLATFORM,
      status: marketplace.LISTING_STATUS_PUBLISHED,
      visibility: marketplace.LISTING_VISIBILITY_PUBLIC,
      slug: template.templateKey,
    });
  }

  console.log(`Marketplace seeded with ${STARTER_TEMPLATES.length} built-in starter templates`);
}

// ─── Startup ──────────────────────────────────────────────────────
if (require.main === module) {
  const { attachLogStream } = require("./logStream");
  const { attachExecStream } = require("./execStream");
  const { attachMetricsStream } = require("./metricsStream");

  const PORT = parseInt(process.env.PORT || "4000");
  const server = app.listen(PORT, async () => {
    console.log(`api running on ${PORT}`);

    try {
      await migrateDB();
    } catch (e) {
      console.error("DB migration error:", e.message);
    }

    // Seed bootstrap admin account on first boot only when explicit secure credentials are provided.
    try {
      const { rows } = await db.query("SELECT id FROM users LIMIT 1");
      if (rows.length === 0) {
        const bootstrapAdmin = getBootstrapAdminSeedConfig({
          adminEmail: process.env.DEFAULT_ADMIN_EMAIL,
          adminPassword: process.env.DEFAULT_ADMIN_PASSWORD,
        });

        if (!bootstrapAdmin.shouldSeed) {
          console.warn(
            "Skipping bootstrap admin seed: set explicit DEFAULT_ADMIN_EMAIL and a non-default DEFAULT_ADMIN_PASSWORD with at least 12 characters.",
          );
        } else {
          const bcrypt = require("bcryptjs");
          const hash = await bcrypt.hash(bootstrapAdmin.password, 10);
          await db.query(
            "INSERT INTO users(email, password_hash, role, name) VALUES($1, $2, 'admin', 'Admin') ON CONFLICT DO NOTHING",
            [bootstrapAdmin.email, hash],
          );
          console.log(`Bootstrap admin account created: ${bootstrapAdmin.email}`);
        }
      }
    } catch (e) {
      console.error("Failed to seed admin account:", e.message);
    }

    try {
      const promotedUser = await ensureFirstRegisteredUserIsAdmin(db);
      if (promotedUser) {
        console.log(`Promoted first registered user to admin: ${promotedUser.email}`);
      }
    } catch (e) {
      console.error("Failed to ensure an admin user exists:", e.message);
    }

    try {
      await integrations.seedCatalog();
    } catch (e) {
      console.error("Failed to seed integration catalog:", e.message);
    }

    try {
      await seedStarterMarketplace();
    } catch (e) {
      console.error("Failed to seed marketplace:", e.message);
    }

    _startupComplete = true;
    console.log("Startup complete — health check now returning ok");

    // ── Background stats collector: sample supported backends every 5s ──
    const STATS_INTERVAL = 5000;
    setInterval(async () => {
      await collectBackgroundTelemetry({
        dbClient: db,
        telemetryCollector: collectAgentTelemetrySample,
      });
    }, STATS_INTERVAL);

    // ── Background status reconciler: sync DB status with real container state every 30s ──
    const RECONCILE_INTERVAL = 30000;
    setInterval(async () => {
      await reconcileBackgroundAgentStatuses({ dbClient: db });
    }, RECONCILE_INTERVAL);
  });

  attachLogStream(server);
  attachExecStream(server);
  attachMetricsStream(server);
  attachGatewayWS(server);
}

module.exports = app;
