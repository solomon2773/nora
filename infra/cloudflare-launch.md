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
**Cloudflare → Caching → Cache Rules**, create two rules (top-down; first is evaluated
first):

**Rule 1 — "Bypass dynamic + authenticated" (priority 1):**

- If **any** of:
  - URI Path starts with `/api/`
  - URI Path starts with `/app/`
  - URI Path starts with `/admin/`
  - URI Path is in `/signup`, `/login`
  - Cookie contains your Nora session cookie name
- Then: **Bypass cache.**

This keeps the API (including the `/api/ws/` log/terminal sockets and the
`/api/agents/*/gateway/chat` SSE stream), the operator app, the admin app, and every
authenticated or cookie-setting response **off** the edge cache. Never cache a response
that carries `Set-Cookie`.

**Rule 2 — "Cache marketing" (priority 2):**

- If: Request Method is `GET` (everything not already bypassed by Rule 1)
- Then: **Eligible for cache**, **Edge TTL: Override → 5 minutes** (raise once you trust
  it), **Browser TTL: Respect origin**.

`/_next/static/*`, `/og-image.png`, favicons, `/sitemap.xml`, `/robots.txt` are immutable
or public and cache cleanly. The landing page now serves from the edge, so the spike no
longer reaches the Node process.

> Verify with `curl -sI https://nora.solomontsao.com/ | grep -i cf-cache-status` →
> should become `HIT` after the first request. The same header on `/api/...` must read
> `BYPASS` or `DYNAMIC`.

## Step 5 — Edge rate limiting (defense in depth)

**Cloudflare → Security → WAF → Rate limiting rules.** Add at least:

- **Login protection:** path `/api/auth/login` (and `/api/auth/signup`, `/api/auth/oauth-login`)
  and method `POST` → use the strongest threshold and mitigation your plan exposes. On the
  Free plan the counting period is 10 seconds, so a practical edge burst rule is more than
  10 requests in 10 seconds per IP. Longer signup windows remain enforced by Nora itself.
  This sits in front of nginx and the Express auth/signup limiters.

The Free plan includes one rate-limiting rule; use it on the auth surface, the most abused
path. For a public promotion, also enable Nora's Turnstile integration so distributed,
low-rate signup bots cannot simply rotate IPs.

## Step 6 — Streaming caveat (read before launch)

Nora streams in two places that pass through `/api/` and are therefore **bypassed** by
Rule 1 (correct — never cache these):

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
- [ ] Open an agent chat and confirm SSE streaming works (note the ~100s caveat).
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
