// @ts-nocheck
const { joinHttpUrl } = require("../agent-runtime/lib/agentEndpoints");
const { deriveHermesDashboardBasicAuth } = require("../agent-runtime/lib/hermesDashboardAuth");

// VERIFIED against nousresearch/hermes-agent:latest: the basic-auth provider
// logs in via a JSON POST to /auth/password-login; the `provider` field is
// required (omitting it → HTTP 422). The /login HTML page's form submits this
// same JSON via fetch.
const HERMES_DASHBOARD_LOGIN_PATH = "auth/password-login";
const HERMES_DASHBOARD_LOGIN_PROVIDER = "basic";

// True when an upstream dashboard response indicates the session is missing or
// expired and we should (re)establish one. Unauthenticated GET / → 302 to
// /login?next=... ; expired/invalid session → 401.
function needsHermesLogin(resp) {
  if (resp.status === 401 || resp.status === 403) return true;
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("location") || "";
    return /(^|\/)login(\?|$|\/)/.test(location);
  }
  return false;
}

// Log in to the Hermes dashboard with the per-agent derived basic-auth
// credential and return the concatenated cookie string to replay upstream
// (Hermes sets hermes_session_at / _rt / _provider), or null if login failed
// or set no cookie.
async function establishHermesDashboardSession(target, seed, { fetchImpl = fetch } = {}) {
  const creds = deriveHermesDashboardBasicAuth(seed);
  const loginUrl = joinHttpUrl(target.host, target.port, HERMES_DASHBOARD_LOGIN_PATH);
  const resp = await fetchImpl(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      provider: HERMES_DASHBOARD_LOGIN_PROVIDER,
      username: creds.username,
      password: creds.password,
      next: "/",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return null;
  const setCookies =
    typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  const pairs = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join("; ") : null;
}

module.exports = {
  HERMES_DASHBOARD_LOGIN_PATH,
  HERMES_DASHBOARD_LOGIN_PROVIDER,
  needsHermesLogin,
  establishHermesDashboardSession,
};
