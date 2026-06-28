// @ts-nocheck
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const db = require("./db");
const billing = require("./billing");
const channels = require("./channels");
const agentHubStore = require("./agentHubStore");
const integrations = require("./integrations");
const snapshots = require("./snapshots");
const {
  getDeploymentDefaults,
  getLanguageSettings,
  getSystemBanner,
} = require("./platformSettings");
const { buildReleaseInfo } = require("./releaseInfo");
const { collectAgentTelemetrySample } = require("./agentTelemetry");
const {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
  reconcileExternalAgentStatuses,
} = require("./backgroundTasks");
const agentBudgets = require("./agentBudgets");
const agentSchedules = require("./agentSchedules");
const { addScheduleRunJob } = require("./redisQueue");
// OpenTelemetry GenAI exporter — self-initializes on require (no-op unless
// NORA_OTEL_ENABLED=true; fail-open). Wrapped so even a module load/parse error
// (e.g. a corrupted dependency) disables OTel rather than crashing boot — the
// init() try/catch only covers runtime errors, not require-time failures.
let otel;
try {
  otel = require("./otel");
} catch (otelErr) {
  console.warn(`[otel] module load failed — telemetry disabled: ${otelErr?.message || otelErr}`);
  otel = { isEnabled: () => false, shutdown: async () => {} };
}
const { listKubernetesExecutionTargets } = require("./kubernetesClusters");
const { STARTER_TEMPLATES } = require("./starterTemplates");
const { getBootstrapAdminSeedConfig } = require("./bootstrapAdmin");
const { ensureFirstRegisteredUserIsAdmin } = require("./ensureAdminUser");
const { authenticateToken } = require("./middleware/auth");
const { correlationId, errorHandler } = require("./middleware/errorHandler");
const {
  createGatewayRouter,
  attachGatewayWS,
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
} = require("./gatewayProxy");
const { isGatewayAvailableStatus } = require("./agentStatus");
const { repairHermesAgentConfig } = require("./hermesUi");
const { HERMES_EMBED_AGENT_COLUMNS, GATEWAY_EMBED_AGENT_COLUMNS } = require("./embedAgentColumns");
const {
  joinHttpUrl,
  hasGatewayEndpoint,
  hasHermesDashboardEndpoint,
} = require("../agent-runtime/lib/agentEndpoints");
const {
  getBackendCatalog,
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
const { looksLikePlaceholderSecret } = require("./lib/secretValidation");
const MIN_JWT_SECRET_LENGTH = 32;
// When a dev boot generated an ephemeral JWT secret, we persist/restore it via
// platform_settings after the DB is up so sessions survive restarts (dev only;
// production refuses to boot without an explicit secret).
let usedEphemeralJwtSecret = false;
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
      "SECURITY WARNING: JWT_SECRET not configured. Using a generated dev secret (persisted in the database so sessions survive restarts). Set JWT_SECRET in .env for real deployments.",
    );
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    usedEphemeralJwtSecret = true;
  }
} else if (!IS_TEST_ENV && process.env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  // A short JWT_SECRET is brute-forceable offline given any signed token. Fail
  // closed rather than silently accept a weak production secret. We
  // deliberately do NOT log the observed length — even a length is a useful
  // bit for an attacker reading process logs, and CodeQL flags the dataflow.
  console.error(
    `FATAL: JWT_SECRET is shorter than the minimum of ${MIN_JWT_SECRET_LENGTH} characters. Generate a stronger one (e.g. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") and restart.`,
  );
  process.exit(1);
} else if (!IS_TEST_ENV && looksLikePlaceholderSecret(process.env.JWT_SECRET)) {
  // Placeholder-looking secrets (your_*, changeme, <REPLACE_...>, "test-...")
  // mean the operator never edited .env.example. Tokens signed with a guessable
  // secret are forgeable, so refuse in production; warn loudly in dev.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "FATAL: JWT_SECRET looks like a placeholder value. Generate a real secret and restart.",
    );
    process.exit(1);
  }
  console.warn("SECURITY WARNING: JWT_SECRET looks like a placeholder value — replace it in .env.");
}

// ─── Encryption key (credentials at rest) ─────────────────────────
// crypto.ts already warns when ENCRYPTION_KEY is missing/invalid and blocks new
// secret writes. In production that soft failure becomes a refusal to boot:
// running a control plane that cannot encrypt integration credentials is a
// footgun. NORA_ALLOW_PLAINTEXT_SECRETS=true is the explicit operator override
// (e.g. air-gapped throwaway demos).
{
  const { isEncryptionConfigured } = require("./crypto");
  if (
    !IS_TEST_ENV &&
    process.env.NODE_ENV === "production" &&
    !isEncryptionConfigured() &&
    process.env.NORA_ALLOW_PLAINTEXT_SECRETS !== "true"
  ) {
    console.error(
      "FATAL: ENCRYPTION_KEY is not set (or is not a 64-char hex key) in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "and set it in .env. To intentionally run without encryption at rest, set NORA_ALLOW_PLAINTEXT_SECRETS=true.",
    );
    process.exit(1);
  }
}

// ─── App Setup ────────────────────────────────────────────────────
const app = express();
const EMBED_SESSION_TTL_MS = 15 * 60 * 1000;
const EMBED_SESSION_COOKIE_PREFIX = "__nora_gateway_embed_";
const HERMES_EMBED_SESSION_COOKIE_PREFIX = "__nora_hermes_embed_";
const HERMES_DASHBOARD_TOKEN_COOKIE_PREFIX = "__nora_hermes_dashboard_token_";
const HERMES_DASHBOARD_SESSION_HEADER = "X-Hermes-Session-Token";
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

// Whether to set the Secure flag on session cookies. Defaults to "only when
// the inbound request was HTTPS" so local-dev over plain HTTP keeps working.
// Operators running always-on TLS (PaaS, public-domain deployments) should set
// NORA_FORCE_SECURE_COOKIES=1 so cookies are never emitted over cleartext even
// if a proxy regression strips `X-Forwarded-Proto`.
function cookieSecureFlag(req) {
  if (process.env.NORA_FORCE_SECURE_COOKIES === "1") return true;
  return requestProtocol(req) === "https";
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

  function findConfirmGatewayUrlButton() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll("button, input[type='submit']"));
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!visible(b) || b.disabled) continue;
      var txt = String((b.innerText || b.textContent || b.value || "")).toLowerCase().trim();
      if (/^confirm$|^continue$|^ok$|^yes$/.test(txt)) return b;
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

function extractHermesDashboardSessionToken(html) {
  const match = String(html || "").match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*(["'])([^"']+)\1/);
  return match?.[2] || "";
}

function rewriteHermesEmbedCss(css, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  return css.replace(/url\((['"]?)\/fonts\//g, `url($1${embedBase}/fonts/`);
}

function rewriteHermesEmbedJavascript(source, agentId) {
  const embedBase = hermesEmbedBasePath(agentId);
  let rewritten = source
    .replace(/(["'`])\/api\//g, `$1${embedBase}/api/`)
    .replace(/(["'`])\/dashboard-plugins\//g, `$1${embedBase}/dashboard-plugins/`);
  const routerMarker = "jsx($y,{children:";
  if (rewritten.includes(routerMarker)) {
    rewritten = rewritten.replace(
      routerMarker,
      `jsx($y,{basename:${JSON.stringify(embedBase)},children:`,
    );
  }
  const browserRouterName = rewritten.match(
    /function\s+([A-Za-z_$][\w$]*)\(\{basename:[^}]*children:[^}]*window:/,
  )?.[1];
  if (browserRouterName) {
    const routerRenderPattern = new RegExp(
      `(\\.jsx\\(${browserRouterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},\\{)(children:)`,
      "g",
    );
    rewritten = rewritten.replace(
      routerRenderPattern,
      `$1basename:${JSON.stringify(embedBase)},$2`,
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
    `SELECT ${GATEWAY_EMBED_AGENT_COLUMNS.join(", ")}
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
  // Selects the SSRF-relevant fields (deploy_target / execution_target_id /
  // user_id / gateway_host) the embed proxy's allowlist authorizes against — see
  // embedAgentColumns.ts. Omitting them would mis-route a remote-docker/k8s agent
  // or short-circuit the owner-scoping check.
  const result = await db.query(
    `SELECT ${HERMES_EMBED_AGENT_COLUMNS.join(", ")}
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

async function fetchAgentForHermesRepair(agentId) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
  const row = result.rows[0];
  if (!row || !row.container_id) return null;
  return row;
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
  const { AUTH_COOKIE_NAME } = require("./authCookie");
  const agentId = req.params.agentId;
  const embedCookieName = getEmbedSessionCookieName(agentId, cookiePrefix);
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const cookieToken = cookies[embedCookieName];
  const mainAuthCookie = cookies[AUTH_COOKIE_NAME];
  const queryToken = allowQueryToken && typeof req.query.token === "string" ? req.query.token : "";
  // A full user JWT may arrive either as a ?token= query parameter (legacy,
  // from the iframe src) or as the main HttpOnly nora_auth cookie that
  // same-origin iframe navigations carry automatically. Either minting path
  // yields the same embed-scoped cookie on success.
  const mintingToken = queryToken || mainAuthCookie || "";

  let userId;
  let relayToken;

  if (mintingToken) {
    let payload;
    try {
      payload = jwt.verify(mintingToken, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
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
      payload = jwt.verify(cookieToken, process.env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
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
      algorithm: "HS256",
    });
    res.cookie(embedCookieName, relayToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecureFlag(req),
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

// State-changing operations (POST/PUT/PATCH/DELETE) get a tighter per-IP cap
// on top of the global limit. The global limiter is generous so that chatty
// read traffic doesn't get throttled; the mutation limiter is where the real
// abuse protection lives — a leaked JWT cannot be used to spam destructive
// calls (delete/restart/stop, admin writes, billing changes, channel mutations)
// at more than 60 per minute from a single IP. Safe methods are skipped so
// normal browsing is unaffected.
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
  // Skip in tests: the unit suites fire far more than 60 mutations/min from a
  // single IP, and the global limiter is not what they exercise (the signup
  // limiter has its own dedicated test). Fully active outside test environments.
  skip: (req) =>
    IS_TEST_ENV || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use(mutationLimiter);

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

function enabledDeployTargetsFromExecutionTargets(executionTargets = []) {
  const enabled = new Set(getEnabledDeployTargets().filter((target) => target !== "k8s"));
  for (const target of executionTargets) {
    if (target?.enabled) {
      enabled.add(target.deployTarget || String(target.id || "").split(":")[0]);
    }
  }
  return Array.from(enabled).filter(Boolean);
}

function defaultExecutionTargetFromCatalog(executionTargets = []) {
  return (
    executionTargets.find(
      (target) =>
        target.isDefault && target.available && String(target.id || "").startsWith("k8s:"),
    )?.id ||
    executionTargets.find((target) => target.isDefault && target.available)?.id ||
    executionTargets.find((target) => target.available)?.id ||
    executionTargets[0]?.id ||
    getDefaultDeployTarget()
  );
}

app.get("/config/platform", async (_req, res) => {
  try {
    const kubernetesClusters = await listKubernetesExecutionTargets();
    const defaultRuntimeFamily = getDefaultRuntimeFamily();
    const runtimeFamilies = getRuntimeCatalog(process.env, { kubernetesClusters });
    const executionTargets = getExecutionTargetCatalog(process.env, {
      runtimeFamily: defaultRuntimeFamily,
      kubernetesClusters,
    });
    const sandboxProfiles = getSandboxProfileCatalog(process.env, {
      runtimeFamily: defaultRuntimeFamily,
      kubernetesClusters,
    });
    const [deploymentDefaults, systemBanner, language, release] = await Promise.all([
      getDeploymentDefaults(),
      getSystemBanner(),
      getLanguageSettings(),
      buildReleaseInfo(),
    ]);
    res.json({
      mode: billing.PLATFORM_MODE,
      selfhosted: billing.PLATFORM_MODE !== "paas" ? billing.SELFHOSTED_LIMITS : null,
      billingEnabled: billing.BILLING_ENABLED,
      enabledBackends: getEnabledBackends(),
      defaultBackend: getDefaultBackend(),
      enabledDeployTargets: enabledDeployTargetsFromExecutionTargets(executionTargets),
      defaultDeployTarget: getDefaultDeployTarget(),
      defaultExecutionTarget: defaultExecutionTargetFromCatalog(executionTargets),
      enabledSandboxProfiles: getEnabledSandboxProfiles(),
      defaultSandboxProfile: getDefaultSandboxProfile(),
      runtimeFamilies,
      executionTargets,
      sandboxProfiles,
      defaultRuntimeFamily,
      deploymentDefaults,
      systemBanner,
      language,
      release,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/config/backends", async (_req, res) => {
  const kubernetesClusters = await listKubernetesExecutionTargets();
  const defaultRuntimeFamily = getDefaultRuntimeFamily();
  const runtimeFamilies = getRuntimeCatalog(process.env, { kubernetesClusters });
  const executionTargets = getExecutionTargetCatalog(process.env, {
    runtimeFamily: defaultRuntimeFamily,
    kubernetesClusters,
  });
  const sandboxProfiles = getSandboxProfileCatalog(process.env, {
    runtimeFamily: defaultRuntimeFamily,
    kubernetesClusters,
  });
  const activeRuntimeFamily =
    runtimeFamilies.find((runtimeFamily) => runtimeFamily.id === defaultRuntimeFamily) ||
    runtimeFamilies[0] ||
    null;
  res.json({
    runtimeFamily: activeRuntimeFamily,
    runtimeFamilies,
    defaultRuntimeFamily,
    enabledDeployTargets: enabledDeployTargetsFromExecutionTargets(executionTargets),
    defaultDeployTarget: getDefaultDeployTarget(),
    defaultExecutionTarget: defaultExecutionTargetFromCatalog(executionTargets),
    enabledSandboxProfiles: getEnabledSandboxProfiles(),
    defaultSandboxProfile: getDefaultSandboxProfile(),
    executionTargets,
    sandboxProfiles,
    enabledBackends: getEnabledBackends(),
    defaultBackend: getDefaultBackend(),
    backends: getBackendCatalog(process.env, { kubernetesClusters }),
    legacyBackends: getBackendCatalog(process.env, { kubernetesClusters }),
  });
});

app.get("/config/nemoclaw", (req, res) => {
  const nemoclaw =
    getSandboxProfileCatalog(process.env, { runtimeFamily: "openclaw" }).find(
      (profile) => profile.id === "nemoclaw",
    ) || {};
  res.json({
    enabled: Boolean(nemoclaw.enabled),
    configured: Boolean(nemoclaw.configured),
    available: Boolean(nemoclaw.available),
    issue: nemoclaw.issue || null,
    defaultModel: nemoclaw.defaultModel || null,
    sandboxImage: nemoclaw.sandboxImage || null,
    models: nemoclaw.models || [],
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

// Zero-key demo LLM stub (OpenAI-compatible). Pre-auth: agent runtimes call it
// over the container network with the derived demo bearer token, not a JWT.
app.use("/demo-llm", require("./routes/demoLlm"));

// ─── OpenAPI spec + interactive reference (pre-auth: the spec documents the
// public surface and contains no secrets; publicly /api/api.json + /api/api-docs).
app.get("/api.json", (req, res) => {
  const { buildOpenApiDocument } = require("./openapi");
  res.json(buildOpenApiDocument());
});
app.get("/api-docs", (req, res) => {
  // Scalar's standalone bundle renders the reference client-side from the spec
  // URL; loading it from the CDN keeps the backend dependency-free.
  res
    .type("html")
    .send(
      [
        "<!doctype html>",
        "<html><head><title>Nora API Reference</title>",
        '<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>',
        "</head><body>",
        '<script id="api-reference" data-url="api.json"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>',
        "</body></html>",
      ].join("\n"),
    );
});

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
    // gateway_token is encrypted at rest; decrypt before inlining it into the
    // embed bootstrap JS that the browser uses for the gateway WS handshake.
    // decrypt() is transparent to legacy plaintext tokens.
    const { decrypt } = require("./crypto");
    res.send(
      buildEmbedBootstrapScript({
        agentId: access.agentId,
        requestHost: req.headers.host,
        requestScheme: requestProtocol(req),
        gatewayToken: decrypt(access.agent.gateway_token),
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
    // Validate + resolve the gateway host against the SSRF allowlist before
    // connecting (mirrors the HTTP gateway proxy; closes the embed-proxy SSRF
    // gap where gatewayUrlForAgent reached the agent host unchecked).
    const safeTarget = await resolveSafeGatewayHttpTarget(
      access.agent,
      gatewayPath,
      buildForwardedSearch(req),
    );
    const targetUrl = safeTarget.url;
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
      Host: safeTarget.hostHeader,
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
    // Validate + resolve the dashboard host against the gateway allowlist before
    // connecting (closes the SSRF gap where runtime_host was reached unchecked).
    const safeTarget = await resolveSafeHermesDashboardTarget(access.agent);
    const targetUrl = `${joinHttpUrl(safeTarget.host, safeTarget.port, hermesPath)}${buildForwardedSearch(req)}`;
    const cookies = parseCookieHeader(req.headers.cookie || "");
    const dashboardTokenCookieName = getEmbedSessionCookieName(
      access.agentId,
      HERMES_DASHBOARD_TOKEN_COOKIE_PREFIX,
    );
    const dashboardSessionToken = cookies[dashboardTokenCookieName];
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
    };
    if (dashboardSessionToken) {
      headers[HERMES_DASHBOARD_SESSION_HEADER] = dashboardSessionToken;
    }
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

    const fetchUpstream = () =>
      fetch(targetUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });

    let resp = await fetchUpstream();

    const isApiRequest = hermesPath.startsWith("api/");
    // Self-heal: Hermes's response serializer (UTF-8) crashes on lone UTF-16
    // surrogates that can land in its on-disk config (emoji-bearing usernames,
    // channel labels). When we see 500 on an api/* request, attempt one
    // surrogate repair against the agent's config; only retry the upstream
    // request if the repair actually mutated something — otherwise the 500 is
    // unrelated and we let it propagate.
    if (resp.status === 500 && isApiRequest && method === "GET") {
      try {
        const fullAgent = await fetchAgentForHermesRepair(access.agentId);
        if (fullAgent) {
          const repair = await repairHermesAgentConfig(fullAgent);
          if (repair?.mutated) {
            console.warn(
              `[hermes-embed-proxy] surrogate repair applied for agent ${access.agentId}, retrying upstream`,
            );
            resp = await fetchUpstream();
          }
        }
      } catch (repairErr) {
        console.error("[hermes-embed-proxy] surrogate repair failed:", repairErr);
      }
    }

    const contentType = resp.headers.get("content-type") || "";
    res.status(resp.status);

    if (/text\/html/i.test(contentType)) {
      const rawHtml = await resp.text();
      const hermesSessionToken = extractHermesDashboardSessionToken(rawHtml);
      if (hermesSessionToken) {
        res.cookie(dashboardTokenCookieName, hermesSessionToken, {
          httpOnly: true,
          sameSite: "lax",
          secure: cookieSecureFlag(req),
          maxAge: EMBED_SESSION_TTL_MS,
          path: "/",
        });
      }
      const html = rewriteHermesEmbedHtml(rawHtml, access.agentId);
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
    const access = await resolveEmbedAccess(req, res);
    if (!access) return;

    const gatewayPath = req.path || "/";
    // Same SSRF allowlist as the embed proxy — gateway asset/favicon fetches must
    // not reach an unvalidated agent host either.
    const safeTarget = await resolveSafeGatewayHttpTarget(
      access.agent,
      gatewayPath,
      buildForwardedSearch(req),
    );
    const resp = await fetch(safeTarget.url, {
      method: req.method,
      headers: {
        Accept: req.headers.accept || "*/*",
        "Accept-Encoding": "identity",
        Host: safeTarget.hostHeader,
      },
      signal: AbortSignal.timeout(10000),
    });
    res.status(resp.status);
    setProxyResponseHeaders(res, resp);
    const body = await resp.arrayBuffer();
    res.send(Buffer.from(body));
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
}
app.use(gatewayUIAssetProxy);

// ─── Public Agent Hub Catalog ─────────────────────────────────────
app.use("/agent-hub", require("./routes/agentHubPublic"));

// ─── Auth Wall ────────────────────────────────────────────────────
app.use(authenticateToken);

// ─── Gateway Proxy ────────────────────────────────────────────────
app.use(createGatewayRouter());

// ─── Protected Routes ─────────────────────────────────────────────
app.use("/agents", require("./routes/agents"));
app.use("/agents", require("./routes/backups"));
app.use("/agents", require("./routes/agentFiles"));
app.use("/agents", require("./routes/channels"));
app.use("/agents", require("./routes/nemoclaw"));
app.use("/agent-migrations", require("./routes/agentMigrations"));
app.use("/", require("./routes/integrations")); // handles /agents/:id/integrations + /integrations/catalog
app.use("/", require("./routes/monitoring")); // handles /monitoring/* + /agents/:id/metrics
app.use("/llm-providers", require("./routes/llmProviders"));
app.use("/clawhub", require("./routes/clawhub"));
app.use("/agent-hub", require("./routes/agentHub"));
app.use("/workspaces", require("./routes/workspaces"));
app.use("/remote-hosts", require("./routes/remoteHosts"));
app.use("/billing", require("./routes/billing"));
// Fleet routes mount before /admin so the explicit prefix wins; both still go
// through requireAdmin (the fleet router applies it itself, and /admin's own
// guard is redundant but harmless). Same pattern for the platform-admin RBAC
// god view.
app.use("/admin/fleet/migrations", require("./routes/fleetMigrations"));
app.use("/admin", require("./routes/adminMembers"));
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
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN cron_job_id TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integrations ADD COLUMN mailbox_state JSONB DEFAULT NULL;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS integration_oauth_states (
       state TEXT PRIMARY KEY,
       provider VARCHAR(50) NOT NULL,
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       code_verifier TEXT NOT NULL,
       client_id TEXT,
       client_secret TEXT,
       config JSONB NOT NULL DEFAULT '{}',
       redirect_path TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       expires_at TIMESTAMPTZ NOT NULL
     )`,
    `DO $$ BEGIN
       ALTER TABLE integration_oauth_states ADD COLUMN client_id TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integration_oauth_states ADD COLUMN client_secret TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE integration_oauth_states ADD COLUMN config JSONB NOT NULL DEFAULT '{}';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expires
       ON integration_oauth_states(expires_at)`,
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
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN execution_target_id TEXT;
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
          WHEN backend_type IN ('kubernetes', 'k3s') THEN 'k8s'
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
    `UPDATE agents
        SET deploy_target = 'k8s'
      WHERE deploy_target IN ('kubernetes', 'k3s')`,
    `UPDATE agents
        SET execution_target_id = CASE
          WHEN deploy_target = 'k8s' THEN 'k8s'
          WHEN deploy_target IN ('docker', 'proxmox') THEN deploy_target
          ELSE COALESCE(NULLIF(deploy_target, ''), 'docker')
        END
      WHERE execution_target_id IS NULL OR BTRIM(execution_target_id) = ''`,
    `ALTER TABLE agents ALTER COLUMN runtime_family SET DEFAULT 'openclaw'`,
    `ALTER TABLE agents ALTER COLUMN deploy_target SET DEFAULT 'docker'`,
    `ALTER TABLE agents ALTER COLUMN execution_target_id SET DEFAULT 'docker'`,
    `ALTER TABLE agents ALTER COLUMN sandbox_profile SET DEFAULT 'standard'`,
    `UPDATE agents
        SET backend_type = CASE
          WHEN deploy_target IN ('kubernetes', 'k3s') THEN 'k8s'
          WHEN deploy_target IN ('docker', 'k8s', 'proxmox') THEN deploy_target
          ELSE 'docker'
        END
      WHERE runtime_family IS NOT NULL
        AND deploy_target IS NOT NULL
        AND sandbox_profile IS NOT NULL
        AND backend_type IS DISTINCT FROM CASE
          WHEN deploy_target IN ('kubernetes', 'k3s') THEN 'k8s'
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
    `ALTER TABLE agents ALTER COLUMN execution_target_id SET NOT NULL`,
    `ALTER TABLE agents ALTER COLUMN sandbox_profile SET NOT NULL`,
    `CREATE TABLE IF NOT EXISTS kubernetes_clusters (
       id TEXT PRIMARY KEY,
       label TEXT NOT NULL,
       provider TEXT NOT NULL DEFAULT 'kubernetes',
       cluster_name TEXT NOT NULL DEFAULT '',
       enabled BOOLEAN NOT NULL DEFAULT true,
       is_default BOOLEAN NOT NULL DEFAULT false,
       credential_mode TEXT NOT NULL DEFAULT 'mounted_path',
       kubeconfig_path TEXT NOT NULL DEFAULT '',
       kubeconfig_encrypted TEXT,
       kube_context TEXT NOT NULL DEFAULT '',
       namespace TEXT NOT NULL DEFAULT 'openclaw-agents',
       openclaw_namespace TEXT NOT NULL DEFAULT '',
       hermes_namespace TEXT NOT NULL DEFAULT '',
       exposure_mode TEXT NOT NULL DEFAULT 'cluster-ip',
       runtime_host TEXT NOT NULL DEFAULT '',
       runtime_node_port INTEGER,
       gateway_node_port INTEGER,
       service_annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
       load_balancer_source_ranges TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
       load_balancer_class TEXT NOT NULL DEFAULT '',
       load_balancer_ready_timeout_ms INTEGER NOT NULL DEFAULT 600000,
       load_balancer_ready_interval_ms INTEGER NOT NULL DEFAULT 5000,
       last_test_status TEXT,
       last_test_message TEXT,
       last_tested_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_kubernetes_clusters_enabled
       ON kubernetes_clusters(enabled, is_default, label)`,
    `CREATE TABLE IF NOT EXISTS remote_hosts (
       id TEXT PRIMARY KEY,
       owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       label TEXT NOT NULL,
       enabled BOOLEAN NOT NULL DEFAULT true,
       is_default BOOLEAN NOT NULL DEFAULT false,
       ssh_host TEXT NOT NULL DEFAULT '',
       ssh_port INTEGER NOT NULL DEFAULT 22,
       ssh_user TEXT NOT NULL DEFAULT '',
       ssh_auth_mode TEXT NOT NULL DEFAULT 'key',
       ssh_private_key_encrypted TEXT,
       ssh_password_encrypted TEXT,
       ssh_passphrase_encrypted TEXT,
       gateway_host TEXT NOT NULL DEFAULT '',
       docker_host TEXT NOT NULL DEFAULT '',
       last_test_status TEXT,
       last_test_message TEXT,
       last_tested_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_remote_hosts_owner
       ON remote_hosts(owner_user_id, enabled, is_default, label)`,
    `DO $$ BEGIN
       ALTER TABLE remote_hosts ADD COLUMN ssh_host_key TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `CREATE TABLE IF NOT EXISTS gateway_port_allocations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       host_key TEXT NOT NULL,
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       port INTEGER NOT NULL,
       purpose TEXT NOT NULL DEFAULT 'gateway',
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(host_key, port)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_gateway_port_allocations_agent
       ON gateway_port_allocations(agent_id)`,
    `DO $$ BEGIN
       ALTER TABLE gateway_port_allocations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'gateway';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN vcpu INTEGER DEFAULT 1; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN ram_mb INTEGER DEFAULT 1024; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agents ADD COLUMN disk_gb INTEGER DEFAULT 10; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS platform_settings (
       singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
       default_vcpu INTEGER NOT NULL DEFAULT 1,
       default_ram_mb INTEGER NOT NULL DEFAULT 1024,
       default_disk_gb INTEGER NOT NULL DEFAULT 10,
       default_locale TEXT NOT NULL DEFAULT 'en',
       system_banner_enabled BOOLEAN NOT NULL DEFAULT false,
       system_banner_severity TEXT NOT NULL DEFAULT 'warning',
       system_banner_title TEXT NOT NULL DEFAULT '',
       system_banner_message TEXT NOT NULL DEFAULT '',
       agent_hub_default_share_target TEXT NOT NULL DEFAULT 'both',
       agent_hub_url TEXT NOT NULL DEFAULT 'https://nora.solomontsao.com',
       agent_hub_api_key_encrypted TEXT,
       created_at TIMESTAMP DEFAULT NOW(),
       updated_at TIMESTAMP DEFAULT NOW()
     )`,
    `INSERT INTO platform_settings(singleton, default_vcpu, default_ram_mb, default_disk_gb)
       VALUES(TRUE, 1, 1024, 10)
       ON CONFLICT (singleton) DO NOTHING`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN default_locale TEXT NOT NULL DEFAULT 'en'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_enabled BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_severity TEXT NOT NULL DEFAULT 'warning'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_title TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN system_banner_message TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN agent_hub_default_share_target TEXT NOT NULL DEFAULT 'both'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN agent_hub_url TEXT NOT NULL DEFAULT 'https://nora.solomontsao.com'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN agent_hub_api_key_encrypted TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_storage_backend TEXT NOT NULL DEFAULT 'local'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_local_path TEXT NOT NULL DEFAULT '/var/lib/nora-backups'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_s3_bucket TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_s3_region TEXT NOT NULL DEFAULT 'us-east-1'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_s3_endpoint TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_s3_access_key_id_encrypted TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_s3_secret_access_key_encrypted TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_ssh_host TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_ssh_port INTEGER NOT NULL DEFAULT 22; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_ssh_username TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_ssh_remote_path TEXT NOT NULL DEFAULT '/backups/nora'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_ssh_private_key_encrypted TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_ssh_password_encrypted TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_installation_schedule_enabled BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_installation_schedule_frequency TEXT NOT NULL DEFAULT 'daily'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_installation_schedule_hour_utc INTEGER NOT NULL DEFAULT 2; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_installation_schedule_day_of_week INTEGER NOT NULL DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    // Per-tier defaults live in platformSettings.ts and are applied per-key
    // by normalizeBackupPlanLimits on read; the column default is empty.
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN backup_plan_limits JSONB NOT NULL DEFAULT '{}'::jsonb; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS snapshots (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID,
       name TEXT NOT NULL,
       description TEXT,
       kind TEXT DEFAULT 'snapshot',
       template_key TEXT,
       built_in BOOLEAN DEFAULT false,
       config JSONB DEFAULT '{}',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS agent_hub_listings (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
       owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       description TEXT,
       price TEXT DEFAULT 'Free',
       category TEXT DEFAULT 'General',
       rating NUMERIC DEFAULT 0,
       installs INTEGER DEFAULT 0,
       downloads INTEGER DEFAULT 0,
       built_in BOOLEAN DEFAULT false,
       source_type TEXT DEFAULT 'platform',
       status TEXT DEFAULT 'published',
       visibility TEXT DEFAULT 'public',
       share_target TEXT DEFAULT 'internal',
       local_visibility TEXT DEFAULT 'internal',
       central_share_status TEXT DEFAULT 'not_shared',
       central_listing_id TEXT,
       central_last_synced_at TIMESTAMP,
       central_error TEXT,
       slug TEXT,
       current_version INTEGER DEFAULT 1,
       published_at TIMESTAMP,
       updated_at TIMESTAMP DEFAULT NOW(),
       reviewed_at TIMESTAMP,
       reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
       review_notes TEXT,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
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
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_token_model ON usage_metrics(metric_type, (metadata->>'model'), recorded_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_metrics_token_source ON usage_metrics(metric_type, (metadata->>'source'), recorded_at)`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN avatar TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN preferred_locale TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN agent_limit_override INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN managed_backups_enabled_override BOOLEAN; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN backup_limit_per_agent_override INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN backup_storage_mb_override INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE users ADD COLUMN backup_retention_days_override INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
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
    `CREATE TABLE IF NOT EXISTS backups (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
       kind TEXT NOT NULL DEFAULT 'agent',
       status TEXT NOT NULL DEFAULT 'queued',
       name TEXT NOT NULL,
       storage_backend TEXT NOT NULL DEFAULT 'local',
       storage_key TEXT,
       storage_config JSONB DEFAULT '{}',
       content_type TEXT NOT NULL DEFAULT 'application/gzip',
       format TEXT NOT NULL DEFAULT 'nora-backup-archive/v1',
       size_bytes BIGINT NOT NULL DEFAULT 0,
       checksum_sha256 TEXT,
       scope JSONB DEFAULT '{}',
       summary JSONB DEFAULT '{}',
       warnings JSONB DEFAULT '[]',
       error TEXT,
       restore_metadata JSONB DEFAULT '{}',
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       expires_at TIMESTAMPTZ,
       completed_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `DO $$ BEGIN ALTER TABLE backups ADD COLUMN storage_config JSONB DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `CREATE INDEX IF NOT EXISTS idx_backups_user_agent_created ON backups(user_id, agent_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_backups_kind_created ON backups(kind, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_backups_expires ON backups(expires_at) WHERE expires_at IS NOT NULL AND status <> 'deleted'`,
    `CREATE TABLE IF NOT EXISTS backup_schedules (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       schedule_key TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL DEFAULT 'agent',
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       enabled BOOLEAN NOT NULL DEFAULT false,
       name TEXT,
       frequency TEXT NOT NULL DEFAULT 'daily',
       hour_utc INTEGER NOT NULL DEFAULT 2,
       day_of_week INTEGER NOT NULL DEFAULT 0,
       next_run_at TIMESTAMPTZ,
       last_run_at TIMESTAMPTZ,
       last_backup_id UUID REFERENCES backups(id) ON DELETE SET NULL,
       last_error TEXT,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_backup_schedules_due ON backup_schedules(enabled, next_run_at) WHERE enabled = true AND next_run_at IS NOT NULL`,
    // Catching `check_violation` would silently leave the constraint off if
    // existing rows had stale `kind` values — fail loudly so an operator
    // notices and cleans up. Only `duplicate_object` (re-running migration)
    // is safe to swallow.
    `DO $$ BEGIN ALTER TABLE backups ADD CONSTRAINT backups_kind_check CHECK (kind IN ('agent','installation')); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE backup_schedules ADD CONSTRAINT backup_schedules_kind_check CHECK (kind IN ('agent','installation')); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
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
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN built_in BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN downloads INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN source_type TEXT DEFAULT 'platform'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN status TEXT DEFAULT 'published'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN visibility TEXT DEFAULT 'public'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN share_target TEXT DEFAULT 'internal'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN local_visibility TEXT DEFAULT 'internal'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN central_share_status TEXT DEFAULT 'not_shared'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN central_listing_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN central_last_synced_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN central_error TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN slug TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN current_version INTEGER DEFAULT 1; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN published_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN updated_at TIMESTAMP DEFAULT NOW(); EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN reviewed_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE agent_hub_listings ADD COLUMN review_notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `UPDATE agent_hub_listings
        SET source_type = CASE WHEN COALESCE(built_in, false) THEN 'platform' ELSE 'community' END
      WHERE source_type IS NULL`,
    `UPDATE agent_hub_listings
        SET status = CASE WHEN COALESCE(built_in, false) THEN 'published' ELSE 'pending_review' END
      WHERE status IS NULL`,
    `UPDATE agent_hub_listings SET visibility = 'public' WHERE visibility IS NULL`,
    `UPDATE agent_hub_listings
        SET share_target = CASE
          WHEN source_type = 'platform' THEN 'internal'
          ELSE 'internal'
        END
      WHERE share_target IS NULL`,
    `UPDATE agent_hub_listings
        SET local_visibility = CASE
          WHEN source_type = 'platform' OR status = 'published' THEN 'internal'
          ELSE 'owner'
        END
      WHERE local_visibility IS NULL`,
    `UPDATE agent_hub_listings
        SET central_share_status = 'not_shared'
      WHERE central_share_status IS NULL`,
    `UPDATE agent_hub_listings SET price = 'Free' WHERE price IS DISTINCT FROM 'Free'`,
    `UPDATE agent_hub_listings SET downloads = 0 WHERE downloads IS NULL`,
    `UPDATE agent_hub_listings SET current_version = 1 WHERE current_version IS NULL`,
    `UPDATE agent_hub_listings SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL`,
    `UPDATE agent_hub_listings
        SET published_at = COALESCE(published_at, created_at, NOW())
      WHERE status = 'published' AND published_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_hub_listings_slug_unique ON agent_hub_listings(slug) WHERE slug IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_listings_owner ON agent_hub_listings(owner_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_listings_source_status ON agent_hub_listings(source_type, status, published_at DESC)`,
    `CREATE TABLE IF NOT EXISTS agent_hub_api_keys (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       label TEXT NOT NULL,
       key_hash TEXT NOT NULL UNIQUE,
       key_prefix TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'active',
       last_used_at TIMESTAMP,
       revoked_at TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_api_keys_user ON agent_hub_api_keys(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_api_keys_hash_active ON agent_hub_api_keys(key_hash) WHERE status = 'active' AND revoked_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS agent_hub_listing_versions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       listing_id UUID REFERENCES agent_hub_listings(id) ON DELETE CASCADE,
       snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
       version_number INTEGER NOT NULL,
       clone_mode TEXT DEFAULT 'files_only',
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(listing_id, version_number),
       UNIQUE(listing_id, snapshot_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_listing_versions_listing ON agent_hub_listing_versions(listing_id, version_number DESC)`,
    `CREATE TABLE IF NOT EXISTS agent_hub_reports (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       listing_id UUID REFERENCES agent_hub_listings(id) ON DELETE CASCADE,
       reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
       reason TEXT NOT NULL,
       details TEXT,
       status TEXT DEFAULT 'open',
       reviewed_at TIMESTAMP,
       reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_reports_listing_status ON agent_hub_reports(listing_id, status, created_at DESC)`,
    `INSERT INTO agent_hub_listing_versions(listing_id, snapshot_id, version_number, clone_mode)
       SELECT ml.id, ml.snapshot_id, COALESCE(ml.current_version, 1), 'files_only'
         FROM agent_hub_listings ml
         LEFT JOIN agent_hub_listing_versions v
           ON v.listing_id = ml.id AND v.snapshot_id = ml.snapshot_id
        WHERE ml.snapshot_id IS NOT NULL
          AND v.id IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_template_key ON snapshots(template_key)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_hub_listings_snapshot_id ON agent_hub_listings(snapshot_id)`,
    // ─── Phase 0: multi-tenant workspace foundation ─────────────────────
    `CREATE TABLE IF NOT EXISTS workspaces (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS workspace_agents (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
       agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
       role TEXT DEFAULT 'member',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    `DELETE FROM workspace_agents a
       USING workspace_agents b
      WHERE a.ctid < b.ctid
        AND a.workspace_id = b.workspace_id
        AND a.agent_id = b.agent_id`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_agents_unique
       ON workspace_agents(workspace_id, agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_agents_agent
       ON workspace_agents(agent_id)`,
    `CREATE TABLE IF NOT EXISTS workspace_remote_hosts (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
       remote_host_id TEXT REFERENCES remote_hosts(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(workspace_id, remote_host_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_remote_hosts_host
       ON workspace_remote_hosts(remote_host_id)`,
    `CREATE TABLE IF NOT EXISTS workspace_members (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       role TEXT NOT NULL DEFAULT 'viewer'
         CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
       invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(workspace_id, user_id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_role ON workspace_members(workspace_id, role)`,
    // Backfill: every existing workspace creator becomes the 'owner' member.
    // Safe to re-run because of the UNIQUE(workspace_id, user_id) constraint.
    `INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT id, user_id, 'owner' FROM workspaces WHERE user_id IS NOT NULL
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS workspace_invitations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       email TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'viewer'
         CHECK (role IN ('admin', 'editor', 'viewer')),
       token_hash TEXT NOT NULL UNIQUE,
       invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
       accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
       accepted_at TIMESTAMPTZ,
       expires_at TIMESTAMPTZ NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email_pending ON workspace_invitations(email) WHERE status = 'pending'`,
    // ─── Phase 1: workspace-scoped API keys ─────────────────────────────
    `CREATE TABLE IF NOT EXISTS api_keys (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       label TEXT NOT NULL,
       key_hash TEXT NOT NULL UNIQUE,
       key_prefix TEXT NOT NULL,
       scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
       status TEXT NOT NULL DEFAULT 'active'
         CHECK (status IN ('active', 'revoked')),
       expires_at TIMESTAMPTZ,
       last_used_at TIMESTAMPTZ,
       revoked_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active ON api_keys(key_hash) WHERE status = 'active' AND revoked_at IS NULL`,
    // ─── Phase 2: alert rules + per-workspace budgets ───────────────────
    `CREATE TABLE IF NOT EXISTS alert_rules (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       event_pattern TEXT NOT NULL,
       channels JSONB NOT NULL DEFAULT '[]'::jsonb,
       enabled BOOLEAN NOT NULL DEFAULT true,
       last_fired_at TIMESTAMPTZ,
       last_error TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_alert_rules_workspace_enabled ON alert_rules(workspace_id, enabled)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_rules_pattern_enabled ON alert_rules(event_pattern) WHERE enabled = true`,
    `CREATE TABLE IF NOT EXISTS workspace_budgets (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       period TEXT NOT NULL DEFAULT 'monthly'
         CHECK (period IN ('daily', 'weekly', 'monthly')),
       limit_usd NUMERIC(12, 2) NOT NULL,
       soft_threshold_pct INTEGER NOT NULL DEFAULT 80
         CHECK (soft_threshold_pct BETWEEN 0 AND 100),
       last_alerted_at TIMESTAMPTZ,
       last_alerted_pct INTEGER,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(workspace_id, period)
     )`,
    // ─── Per-agent budgets with hard-cap auto-pause ─────────────────────
    `CREATE TABLE IF NOT EXISTS agent_budgets (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       period TEXT NOT NULL DEFAULT 'monthly'
         CHECK (period IN ('daily', 'weekly', 'monthly')),
       limit_usd NUMERIC(12, 2) NOT NULL,
       soft_threshold_pct INTEGER NOT NULL DEFAULT 80
         CHECK (soft_threshold_pct BETWEEN 0 AND 100),
       last_alerted_at TIMESTAMPTZ,
       last_alerted_pct INTEGER,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(agent_id, period)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_budgets_agent ON agent_budgets(agent_id)`,
    // ─── Control-plane scheduled agent runs (recurring cron triggers) ───
    `CREATE TABLE IF NOT EXISTS agent_schedules (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       name TEXT NOT NULL,
       cron TEXT NOT NULL,
       timezone TEXT NOT NULL DEFAULT 'UTC',
       action_type TEXT NOT NULL DEFAULT 'prompt'
         CHECK (action_type IN ('prompt', 'restart', 'stop', 'start', 'redeploy')),
       prompt TEXT,
       enabled BOOLEAN NOT NULL DEFAULT TRUE,
       last_run_at TIMESTAMPTZ,
       last_status TEXT,
       next_run_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       updated_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
       ON agent_schedules(next_run_at) WHERE enabled`,
    `CREATE INDEX IF NOT EXISTS idx_agent_schedules_agent ON agent_schedules(agent_id)`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN paused_reason TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN mcp_servers JSONB DEFAULT '[]';
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE agents ADD COLUMN dashboard_port INTEGER;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE platform_settings ADD COLUMN dev_jwt_secret TEXT;
     EXCEPTION WHEN duplicate_column THEN NULL;
     END $$`,
    // ─── Phase 3: agent configuration history ───────────────────────────
    `CREATE TABLE IF NOT EXISTS agent_versions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       version_number INTEGER NOT NULL,
       config JSONB NOT NULL DEFAULT '{}',
       created_by UUID REFERENCES users(id) ON DELETE SET NULL,
       message TEXT,
       source TEXT NOT NULL DEFAULT 'edit'
         CHECK (source IN ('edit', 'deploy', 'redeploy', 'duplicate', 'hub-install', 'restore', 'rollback')),
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(agent_id, version_number)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_recent ON agent_versions(agent_id, version_number DESC)`,
    // ─── Phase 5: fleet runtime migrations ──────────────────────────────
    `CREATE TABLE IF NOT EXISTS fleet_migrations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending', 'queued', 'in_progress', 'completed', 'partial_failure', 'rolled_back')),
       source_selection JSONB NOT NULL DEFAULT '{}',
       target_selection JSONB NOT NULL DEFAULT '{}',
       agent_ids JSONB NOT NULL DEFAULT '[]',
       before_state JSONB NOT NULL DEFAULT '{}',
       after_state JSONB NOT NULL DEFAULT '{}',
       errors JSONB NOT NULL DEFAULT '[]',
       dry_run BOOLEAN NOT NULL DEFAULT false,
       notes TEXT,
       started_at TIMESTAMPTZ,
       completed_at TIMESTAMPTZ,
       rolled_back_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_fleet_migrations_status_created ON fleet_migrations(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_fleet_migrations_initiator ON fleet_migrations(initiated_by, created_at DESC)`,
    // ─── Phase 6: platform-wide SMTP (mailer) ───────────────────────────
    // Stored as additional columns on platform_settings; read/written by
    // mailer.ts via platformSettings.getSmtpSettings/updateSmtpSettings.
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_host TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_port INTEGER NOT NULL DEFAULT 587; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_secure BOOLEAN NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_username TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_password_encrypted TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_from_address TEXT NOT NULL DEFAULT ''; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
    `DO $$ BEGIN ALTER TABLE platform_settings ADD COLUMN smtp_from_name TEXT NOT NULL DEFAULT 'Nora'; EXCEPTION WHEN duplicate_column THEN NULL; END $$`,
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

async function seedStarterAgentHub() {
  for (const template of STARTER_TEMPLATES) {
    const existingListing = await agentHubStore.getPlatformListingByTemplateKey(
      template.templateKey,
    );

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

    await agentHubStore.upsertListing({
      listingId: existingListing?.id || null,
      snapshotId,
      name: template.name,
      description: template.description,
      price: template.price,
      category: template.category,
      builtIn: true,
      sourceType: agentHubStore.LISTING_SOURCE_PLATFORM,
      status: agentHubStore.LISTING_STATUS_PUBLISHED,
      visibility: agentHubStore.LISTING_VISIBILITY_PUBLIC,
      slug: template.templateKey,
    });
  }

  console.log(`Agent Hub seeded with ${STARTER_TEMPLATES.length} built-in starter templates`);
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

    // Dev-mode only: persist the generated JWT secret in platform_settings so
    // sessions survive restarts; on later boots restore the stored one. The
    // restore happens before real traffic in practice, and the worst case of a
    // racing request is one invalidated token — the prior behavior for ALL
    // tokens on every restart. Production never reaches this branch (boot
    // fails without an explicit JWT_SECRET).
    if (usedEphemeralJwtSecret) {
      try {
        const existing = await db.query("SELECT dev_jwt_secret FROM platform_settings LIMIT 1");
        const stored = existing.rows[0]?.dev_jwt_secret;
        if (stored && stored.length >= MIN_JWT_SECRET_LENGTH) {
          process.env.JWT_SECRET = stored;
          console.log("Restored persisted dev JWT secret — existing sessions remain valid.");
        } else {
          await db.query(
            `INSERT INTO platform_settings(singleton, dev_jwt_secret) VALUES (TRUE, $1)
             ON CONFLICT (singleton) DO UPDATE SET dev_jwt_secret = EXCLUDED.dev_jwt_secret`,
            [process.env.JWT_SECRET],
          );
          console.log("Persisted generated dev JWT secret — sessions will survive restarts.");
        }
      } catch (e) {
        console.warn("Could not persist/restore dev JWT secret:", e.message);
      }
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
      await seedStarterAgentHub();
    } catch (e) {
      console.error("Failed to seed Agent Hub:", e.message);
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

    // ── External runtime reconciler: adopted runtimes have no container, so probe
    // their endpoint over HTTP (SSRF-safe) and reconcile status every 30s. ──
    setInterval(async () => {
      await reconcileExternalAgentStatuses({ dbClient: db });
    }, RECONCILE_INTERVAL);

    // ── Budget sweep: re-enforce per-agent hard caps every 60s. The status
    // reconciler above flips stopped->running whenever a container is live,
    // so re-enforcement is what keeps a budget pause stuck. ──
    const BUDGET_SWEEP_INTERVAL = 60000;
    setInterval(async () => {
      await agentBudgets.sweepAgentBudgets({ dbClient: db });
    }, BUDGET_SWEEP_INTERVAL);

    // ── Schedule sweep: claim due agent_schedules and enqueue each run for the
    // worker to execute. Replica-safe (FOR UPDATE SKIP LOCKED in the module).
    // The re-entrancy guard prevents a slow sweep from overlapping the next
    // tick (setInterval doesn't await), bounding concurrent enqueue load. ──
    const SCHEDULE_SWEEP_INTERVAL = 30000;
    let scheduleSweepRunning = false;
    setInterval(async () => {
      if (scheduleSweepRunning) return;
      scheduleSweepRunning = true;
      try {
        await agentSchedules.sweepDueSchedules({
          dbClient: db,
          enqueue: addScheduleRunJob,
        });
      } catch (err) {
        console.error("[schedules] sweep failed:", err?.message || err);
      } finally {
        scheduleSweepRunning = false;
      }
    }, SCHEDULE_SWEEP_INTERVAL);
  });

  attachLogStream(server);
  attachExecStream(server);
  attachMetricsStream(server);
  attachGatewayWS(server);

  // Flush batched OpenTelemetry spans/metrics on shutdown — only when OTel is
  // actually enabled, so the default/disabled path (and tests) keep Node's
  // stock signal behavior. Bounded so a stuck exporter can't block exit.
  if (otel.isEnabled()) {
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.once(sig, () => {
        Promise.race([
          otel.shutdown(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]).finally(() => process.exit(0));
      });
    }
  }
}

module.exports = app;
