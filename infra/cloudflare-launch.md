# Putting Cloudflare in front of Nora for a launch

The reference production deploy (`/.github/workflows/deploy-production.yml`) runs the
whole stack on a **single host** behind the host's own nginx + Let's Encrypt. That is
fine for steady-state operator traffic, but a Product Hunt / Reddit / LinkedIn front-page
spike points thousands of first-time visitors at the **marketing site** all at once, and
one Docker host is a single point of failure.

Putting **Cloudflare in front** is the fastest, cheapest launch mitigation:

- The marketing landing page (what the spike actually hits) is served from Cloudflare's
  **edge cache**, so the origin barely sees the surge.
- Cloudflare absorbs **DDoS / bot** traffic and gives you a one-click **"Under Attack"**
  switch.
- It does **not** remove the origin SPOF — for real HA you still want a second origin
  behind a load balancer later (see [Beyond launch](#beyond-launch)) — but it removes the
  most likely launch-day failure mode.

> Time to set up: ~30 minutes. Everything below is on Cloudflare's **free** plan.

---

## Prerequisites

- The apex/subdomain (`nora.solomontsao.com`) is managed on Cloudflare nameservers.
- The origin already serves a **valid Let's Encrypt cert** (it does — `infra/setup-tls.sh`),
  which lets us use the strict TLS mode below.
- You know the origin's public IP (the `DEPLOY_HOST`).

`noradocs.solomontsao.com` is hosted by Mintlify and needs none of this.

---

## Step 1 — DNS (proxy the origin)

In **Cloudflare → DNS**, the record for `nora.solomontsao.com` (A → origin IPv4, and
AAAA if you have IPv6) must be **Proxied** (orange cloud), not "DNS only" (grey).

Grey cloud = traffic bypasses Cloudflare entirely. Orange cloud = caching, WAF, and DDoS
protection are active. The grey cloud is also your instant rollback (Step 8).

## Step 2 — TLS mode

**Cloudflare → SSL/TLS → Overview → Full (strict).**

Because the origin has a real Let's Encrypt cert, Full (strict) validates it end-to-end.
Do **not** use "Flexible" (it sends plaintext to the origin and breaks secure cookies).

Also enable **SSL/TLS → Edge Certificates → Always Use HTTPS** and **Automatic HTTPS
Rewrites**. Nora's public nginx emits one host-only HSTS policy. Leave Cloudflare HSTS off
unless you intentionally want a broader policy such as `includeSubDomains`; do not publish
two conflicting HSTS fields.

## Step 3 — Restore the real client IP at the origin (required)

Behind Cloudflare, nginx sees **Cloudflare's** edge IPs as the client. That silently
breaks the per-IP rate limiting added in `nginx_tls.conf` / `nginx_public.conf.template`
(`auth_limit` / `api_limit`): every visitor would share a handful of Cloudflare IPs, so a
single edge IP could trip the limit for everyone.

Both public nginx templates enable Cloudflare real-IP restoration by default. The
`CF-Connecting-IP` header is trusted only when the connection itself comes from one of
Cloudflare's published IPv4/IPv6 networks, so direct clients cannot spoof it. Confirm the
tracked ranges against <https://www.cloudflare.com/ips/> during release maintenance, then
regenerate + recreate nginx:

```bash
# regenerate nginx.public.conf from the template and reload
DOMAIN=nora.solomontsao.com ./infra/setup-tls.sh    # or re-run your deploy
docker compose --env-file .env -f docker-compose.yml \
  -f infra/docker-compose.public-prod.yml -f infra/docker-compose.public-tls.yml \
  up -d --force-recreate --no-deps nginx
```

Verify: after enabling, `docker compose ... logs nginx` should show **real visitor IPs**,
not `104.16.x.x` / `172.64.x.x`.

> Hardening (recommended): once all traffic is via Cloudflare, lock the origin firewall so
> `:443` only accepts Cloudflare's IP ranges (or enable **Authenticated Origin Pulls**).
> That stops attackers from bypassing the edge by hitting the origin IP directly.

## Step 4 — Cache the marketing site at the edge

Cloudflare does **not** cache HTML by default — you must make it eligible. In
**Cloudflare → Caching → Cache Rules**, create the two narrow rules below.

Cloudflare Cache Rules are stackable. If multiple matching rules change the same cache
setting, the **last matching rule wins**. Do not put a broad "cache every GET" rule after a
dynamic-route bypass: it can make an API, dashboard, auth callback, or authenticated response
cache-eligible again. See Cloudflare's [Cache Rules order guidance](https://developers.cloudflare.com/cache/how-to/cache-rules/order/).

**Rule 1 — "Nora homepage HTML":**

```text
lower(http.host) eq "nora.solomontsao.com" and
http.request.uri.path eq "/" and
http.request.method in {"GET" "HEAD"} and
not (http.cookie contains "nora_auth=")
```

- Then: **Eligible for cache**.
- Edge TTL: **Use cache-control header if present, bypass cache if not**.
- Browser TTL: **Respect origin**.

Nora returns browser-revalidation-oriented `Cache-Control` plus a homepage-only
`Cloudflare-CDN-Cache-Control: public, max-age=300, stale-while-revalidate=60` directive, so the
origin supplies the initial five-minute edge TTL without making login, signup, dashboards, or APIs
cacheable. Keep this rule limited to the exact homepage. Cloudflare's normal static-asset behavior
still handles `/_next/static/*`, `/og-image.png`, favicons, and `/robots.txt` without a broad HTML
rule.

**Rule 2 — "Nora dynamic and authenticated bypass" (place last):**

```text
lower(http.host) eq "nora.solomontsao.com" and (
  http.request.uri.path eq "/api" or starts_with(http.request.uri.path, "/api/") or
  http.request.uri.path eq "/app" or starts_with(http.request.uri.path, "/app/") or
  http.request.uri.path eq "/admin" or starts_with(http.request.uri.path, "/admin/") or
  http.request.uri.path eq "/auth" or starts_with(http.request.uri.path, "/auth/") or
  http.request.uri.path in {
    "/login" "/signup"
    "/en/login" "/en/signup"
    "/es/login" "/es/signup"
    "/fr/login" "/fr/signup"
    "/zh-Hans/login" "/zh-Hans/signup"
    "/zh-Hant/login" "/zh-Hant/signup"
  } or
  http.request.uri.path eq "/en/auth" or starts_with(http.request.uri.path, "/en/auth/") or
  http.request.uri.path eq "/es/auth" or starts_with(http.request.uri.path, "/es/auth/") or
  http.request.uri.path eq "/fr/auth" or starts_with(http.request.uri.path, "/fr/auth/") or
  http.request.uri.path eq "/zh-Hans/auth" or starts_with(http.request.uri.path, "/zh-Hans/auth/") or
  http.request.uri.path eq "/zh-Hant/auth" or starts_with(http.request.uri.path, "/zh-Hant/auth/") or
  http.cookie contains "nora_auth="
)
```

- Then: **Bypass cache**.

This keeps the API (including `/api/ws/` log/terminal sockets and
`/api/agents/*/gateway/chat` SSE), operator and admin apps, localized and unlocalized OAuth
callbacks, login/signup, and authenticated requests off the edge cache. The two rules are
intentionally disjoint today; keeping the complete bypass last is defense in depth if a future
cache rule expands. Never cache a response that carries `Set-Cookie`.

If you protect the Admin dashboard with **Cloudflare Access**, cover both the exact
`/admin` path and `/admin/*`. The public nginx templates redirect `/admin` to `/admin/` as
defense in depth, but the Access application should still include both paths so policy remains
correct if routing changes or another origin serves the hostname.

> Verify with `curl -sI https://nora.solomontsao.com/ | grep -i cf-cache-status` →
> should become `HIT` after the first request. The same header on `/api/...` must read
> `BYPASS` or `DYNAMIC`.

## Step 5 — Edge rate limiting (defense in depth)

**Cloudflare → Security → WAF → Rate limiting rules.** Add at least:

- **Login protection:** path `/api/auth/login` (and `/api/auth/signup`, `/api/auth/oauth-login`)
  → use the strongest threshold and mitigation your plan exposes. On the Free plan, match these
  paths regardless of method because method filtering is not available there; the counting period
  is 10 seconds, so a practical edge burst rule is more than 10 requests in 10 seconds per IP.
  Business and higher plans can additionally constrain the rule to `POST`. Longer signup windows
  remain enforced by Nora itself. This sits in front of nginx and the Express auth/signup limiters.

The Free plan includes one rate-limiting rule; use it on the auth surface, the most abused
path. For a public promotion, also enable Nora's Turnstile integration so distributed,
low-rate signup bots cannot simply rotate IPs:

1. In **Cloudflare → Turnstile**, create a **Managed** widget and add the specific hostname
   `nora.solomontsao.com` (hostname only, with no scheme, path, or port).
2. Put the returned values directly in the production env or secret manager; never commit them:

   ```dotenv
   SIGNUP_BOT_PROTECTION_PROVIDER=turnstile
   SIGNUP_TURNSTILE_SITE_KEY=<public-site-key>
   SIGNUP_TURNSTILE_SECRET=<server-only-secret>
   ```

3. Redeploy Nora so `backend-api` receives the values, then confirm
   `/api/auth/bootstrap-status` reports `signupBotProtection.enabled: true`,
   `configured: true`, `provider: "turnstile"`, and no `configurationError`. Complete one real
   signup to verify the server-side challenge.

## Step 6 — Streaming caveat (read before launch)

Nora streams in two places that pass through `/api/` and are therefore **bypassed** by
the final dynamic/auth rule (correct — never cache these):

- **WebSocket** (`/api/ws/` logs & terminal): Cloudflare proxies WebSockets fine on
  proxied records. No action needed.
- **SSE** (`/api/agents/*/gateway/chat`): Cloudflare passes Server-Sent Events through,
  but the **free plan can drop a connection after ~100s** of an idle stream. The origin
  sets `proxy_read_timeout 300` for this path; behind Cloudflare a long, quiet chat stream
  may be cut early and the client will reconnect. This affects only **logged-in operators**
  (a small fraction of launch-day traffic, which is dominated by the cached marketing
  page), so it is acceptable for launch — just **test it** (Step 7) and know the behavior.

## Step 7 — Pre-launch verification checklist

Run these against the live site **before** you post anywhere:

- [ ] `curl -sI https://nora.solomontsao.com/ | grep -i cf-cache-status` → `HIT` on a
      second request.
- [ ] `curl -sI https://nora.solomontsao.com/api/health | grep -i cf-cache-status` →
      `BYPASS`/`DYNAMIC` (never `HIT`).
- [ ] Sign up for a fresh account end-to-end (no cached/stale auth page; cookie sets).
- [ ] `/api/auth/bootstrap-status` reports signup bot protection enabled and configured.
- [ ] Log into `/app` and confirm the dashboard + a WebSocket log stream work.
- [ ] When Cloudflare Access protects Admin, both `/admin` and `/admin/settings` enter the
      Access login flow; `/admin` must not return a public shell whose `/_next` assets are blocked.
- [ ] Open a freshly activated demo agent chat and confirm the first reply streams promptly over
      SSE without an empty response, timeout, or loading stall.
- [ ] OAuth login (Google/GitHub) round-trips (callbacks go through the marketing app).
- [ ] `docker compose ... logs nginx` shows **real client IPs**, not Cloudflare IPs.
- [ ] Trip the login rate limit intentionally and confirm a `429`/Block.

## Step 8 — During the spike & rollback

- If you see a bot/DDoS surge: **Security → Settings → Under Attack Mode: On** (challenges
  every visitor). Turn it off once the surge subsides — it adds friction for real users.
- **Instant rollback:** set the DNS record back to **DNS only** (grey cloud). Traffic goes
  straight to the origin again within DNS TTL. Keep the TTL low (e.g., 5 min / "Auto")
  around launch so you can flip quickly.

---

## Beyond launch

Cloudflare absorbs the spike but the **origin is still a single host**. When you want real
high availability:

1. Bump the host first (vertical scale: more vCPU/RAM, ensure swap, raise file-descriptor
   limits). The nginx templates now use `worker_processes auto` + `worker_connections 4096`,
   so nginx will use every core.
2. Stand up a **second origin** and put both behind a load balancer (Cloudflare Load
   Balancing, or an external LB), with PostgreSQL/Redis moved to managed or replicated
   instances rather than per-host containers.
3. Health-check both origins so a dead host is pulled from rotation automatically.

That removes the SPOF entirely; Cloudflare-in-front is the launch-day stopgap that buys you
the time to do it.
