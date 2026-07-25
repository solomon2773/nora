// @ts-nocheck
// Shared SSRF guard used by every outbound-to-user-URL code path:
//   - backend-api/integrations.ts   (integration connectivity tests)
//   - backend-api/alertRules.ts     (alert webhooks)
//   - backend-api/channels/adapters.ts  (outbound slack/discord/teams/webhook)
//
// Two layers of protection:
//
//   1) Lexical check on the URL's hostname literal. Catches `127.0.0.1`,
//      `169.254.169.254`, RFC1918 ranges, link-local IPv6, etc. — fast,
//      doesn't touch the network.
//
//   2) DNS resolution of the hostname, then the same lexical check on EVERY
//      resolved IP. This rejects a public-looking hostname that currently
//      resolves to private space. It does not pin a later request to those
//      validated addresses, so callers needing DNS-rebinding resistance must
//      use a resolver that connects to the validated address.
//
// The sync export (`assertSafeUrl`) preserves the old 2-arg interface for
// callers that can't easily go async. Every *new* call should use
// `assertSafeUrlAsync` so the DNS layer is exercised.

const dns = require("node:dns").promises;
const net = require("node:net");

// IPv4 RFC1918 + loopback + link-local + carrier-grade NAT + unspecified;
// IPv6 loopback / unspecified, link-local, and common ULA literal forms. This
// explicit denylist does not replace connection pinning or network egress policy.
const PRIVATE_IP_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1|::$|fc00:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/**
 * Reject non-HTTP protocols and any hostname that parses as a private IP
 * literal. Returns the validated `origin` string on success.
 *
 * Keeps the 2-arg interface for back-compat with the previous inline copies.
 * Prefer `assertSafeUrlAsync` — it layers DNS resolution on top.
 *
 * @param {string} rawUrl - User-controlled URL to validate.
 * @param {string} label - Field label used in validation errors.
 * @returns {string} Validated URL origin.
 */
function assertSafeUrl(rawUrl, label = "URL") {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http or https`);
  }

  const hostname = parsed.hostname;
  const cleanHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (PRIVATE_IP_RE.test(cleanHostname)) {
    throw new Error(`${label} must not target internal or private network addresses`);
  }

  // If the hostname is itself an IP literal, the regex above is the only check
  // we can do. If it's a DNS name, `assertSafeUrlAsync` must be awaited to
  // also validate the resolved address.
  return parsed.origin;
}

/**
 * Check protocol, hostname literals, and every currently resolved A/AAAA record.
 * Returns the validated origin, but does not pin a subsequent request to the
 * checked addresses; use a pinned resolver when DNS-rebinding resistance is
 * required.
 *
 * @param {string} rawUrl - User-controlled URL to validate.
 * @param {string} label - Field label used in validation errors.
 * @returns {Promise<string>} Validated URL origin.
 */
async function assertSafeUrlAsync(rawUrl, label = "URL") {
  const origin = assertSafeUrl(rawUrl, label);
  const parsed = new URL(origin);
  const hostname = parsed.hostname;

  // If it's already an IP literal, the sync check already covered it.
  if (net.isIP(hostname)) return origin;

  let addresses;
  try {
    // `verbatim: true` keeps IPv6 at the front per getaddrinfo rules; we
    // don't care about ordering — we check every record either way.
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    // Host can't be resolved. Either transient DNS failure or the attacker
    // is pointing at a made-up name. Refuse — a later `fetch` would fail
    // anyway, and refusing here gives a cleaner error.
    throw new Error(
      `${label} hostname ${hostname} could not be resolved (${err.code || err.message})`,
    );
  }

  const offending = addresses.find((addr) => PRIVATE_IP_RE.test(addr.address));
  if (offending) {
    throw new Error(
      `${label} resolves to a private/internal address (${offending.address}) and cannot be used`,
    );
  }

  return origin;
}

module.exports = {
  PRIVATE_IP_RE,
  assertSafeUrl,
  assertSafeUrlAsync,
};
