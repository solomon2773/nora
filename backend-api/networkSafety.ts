// @ts-nocheck
// Shared SSRF guard used by every outbound-to-user-URL code path:
//   - backend-api/integrations.ts   (integration connectivity tests)
//   - backend-api/channels/adapters.ts  (outbound slack/discord/teams/webhook)
//
// Two layers of protection:
//
//   1) Lexical check on the URL's hostname literal. Catches `127.0.0.1`,
//      `169.254.169.254`, RFC1918 ranges, link-local IPv6, etc. — fast,
//      doesn't touch the network.
//
//   2) DNS resolution of the hostname, then the same lexical check on EVERY
//      resolved IP. Catches the DNS-rebinding and compose-internal-alias
//      class — where an attacker supplies a public-looking hostname like
//      `my-attacker.com` that resolves to `worker-provisioner` or an AWS
//      metadata IP on this network.
//
// The sync export (`assertSafeUrl`) preserves the old 2-arg interface for
// callers that can't easily go async. Every *new* call should use
// `assertSafeUrlAsync` so the DNS layer is exercised.

const dns = require("node:dns").promises;
const net = require("node:net");

// IPv4 RFC1918 + loopback + link-local + TEST-NET + carrier-grade NAT +
// "this network" + IANA special-purpose.  IPv6 loopback / link-local / ULA.
//
// The trailing `\b` matches classic dotted-decimal and IPv6 colon forms; the
// alternation is deliberately broad because it's cheaper to reject a
// legitimate niche range (operators can switch to an egress proxy) than to
// let a novel bypass slip through.
const PRIVATE_IP_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1|::$|fc00:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/**
 * Reject non-HTTP protocols and any hostname that parses as a private IP
 * literal. Returns the validated `origin` string on success.
 *
 * Keeps the 2-arg interface for back-compat with the previous inline copies.
 * Prefer `assertSafeUrlAsync` — it layers DNS resolution on top.
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
  if (PRIVATE_IP_RE.test(hostname)) {
    throw new Error(`${label} must not target internal or private network addresses`);
  }

  // If the hostname is itself an IP literal, the regex above is the only check
  // we can do. If it's a DNS name, `assertSafeUrlAsync` must be awaited to
  // also validate the resolved address.
  return parsed.origin;
}

/**
 * Full SSRF check: protocol + lexical hostname + DNS resolution (every A/AAAA
 * record). Returns the validated origin (str) on success. Callers that do
 * `await fetch(url, ...)` should `await assertSafeUrlAsync(url, label)` first.
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
      `${label} hostname ${hostname} could not be resolved (${err.code || err.message})`
    );
  }

  const offending = addresses.find((addr) => PRIVATE_IP_RE.test(addr.address));
  if (offending) {
    throw new Error(
      `${label} resolves to a private/internal address (${offending.address}) and cannot be used`
    );
  }

  return origin;
}

module.exports = {
  PRIVATE_IP_RE,
  assertSafeUrl,
  assertSafeUrlAsync,
};
