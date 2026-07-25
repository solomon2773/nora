// @ts-nocheck
const crypto = require("crypto");

// Fixed dashboard login username for Nora-managed Hermes agents. The password
// and token-signing secret are derived per-agent so both the worker (which
// injects them into the container env) and the backend-api embed proxy (which
// logs in on the operator's behalf) compute identical values from the same
// seed with no shared persisted state.
const HERMES_DASHBOARD_USERNAME = "nora";

function hmacHex(seed, label) {
  return crypto.createHmac("sha256", String(seed)).update(String(label)).digest("hex");
}

// Derive the Hermes dashboard basic-auth credential from a per-agent seed (the
// agent's API_SERVER_KEY / gatewayToken). Deterministic: the injected credential
// and the proxy's login credential always match, including across supervised
// restarts, because both sides re-derive from the same seed.
function deriveHermesDashboardBasicAuth(seed) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("deriveHermesDashboardBasicAuth requires a non-empty string seed");
  }
  return {
    username: HERMES_DASHBOARD_USERNAME,
    password: hmacHex(seed, "hermes-dashboard-password"),
    secret: hmacHex(seed, "hermes-dashboard-secret"),
  };
}

module.exports = {
  HERMES_DASHBOARD_USERNAME,
  deriveHermesDashboardBasicAuth,
};
