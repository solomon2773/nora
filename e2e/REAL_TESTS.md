# Real-credential E2E suite

These specs run the real lifecycle — deploy, chat against a real LLM, connect
real integrations, send real messages through real channels — and verify the
security fixes shipped in integrations.ts / channels/adapters.ts.

## Files

- `specs/real-deploy-matrix.spec.ts` — §3 test-plan L1-L10 across the
  OpenClaw/Hermes × Docker/K8s/NemoClaw matrix.
- `specs/real-integrations.spec.ts` — §4 GitHub + Slack + URL-based integration
  with real-cred success and SSRF-guard refusal.
- `specs/real-channels.spec.ts` — §5 Telegram + Discord delivery with real
  creds and SSRF-guard refusal.
- `specs/support/realConfig.ts` — `.env.real` loader and skip gates.
- `specs/support/agents.ts` — API helpers.
- `.env.real.example` — fill in and copy to `.env.real`.

## Prerequisites

1. **Nora stack running** somewhere reachable. The simplest is the main
   compose stack on `http://localhost:8080`:
   ```bash
   docker compose up -d
   until curl -fsS http://localhost:8080/api/health; do sleep 2; done
   ```
2. **Playwright deps installed** inside `e2e/`:
   ```bash
   cd e2e
   npm ci
   npx playwright install --with-deps chromium
   ```
3. **`.env.real` filled in**:
   ```bash
   cp .env.real.example .env.real
   # edit — at minimum REAL_ANTHROPIC_API_KEY (or REAL_OPENAI_API_KEY).
   ```

## Running

```bash
cd e2e

# All three specs against the main compose stack on :8080
BASE_URL=http://localhost:8080 npx playwright test \
  specs/real-deploy-matrix.spec.ts \
  specs/real-integrations.spec.ts \
  specs/real-channels.spec.ts

# Just the deploy matrix
BASE_URL=http://localhost:8080 npx playwright test specs/real-deploy-matrix.spec.ts

# Headed (watch the browser during L3 embed checks)
BASE_URL=http://localhost:8080 npx playwright test --headed specs/real-deploy-matrix.spec.ts

# One cell only — set the other REAL_ENABLE_* flags to 0 in .env.real, or
# override inline:
REAL_ENABLE_HERMES_DOCKER=1 REAL_ENABLE_OPENCLAW_DOCKER=0 \
  BASE_URL=http://localhost:8080 \
  npx playwright test specs/real-deploy-matrix.spec.ts
```

Setting `BASE_URL` disables the auto-managed `docker-compose.e2e.yml` stack in
`playwright.config.ts`, so the specs talk to whichever stack you already have
up.

## What each cell expects

| Cell | Enabled by | Extra host requirements |
| --- | --- | --- |
| OpenClaw + Docker | `REAL_ENABLE_OPENCLAW_DOCKER=1` (default) | Docker socket reachable from `backend-api` / `worker-provisioner` (already wired in the default compose) |
| OpenClaw + K8s | `REAL_ENABLE_OPENCLAW_K8S=1` | Control plane started via `docker compose -f docker-compose.yml -f docker-compose.kind.yml up -d`, with `kind` + `kubectl` on the host |
| OpenClaw + NemoClaw | `REAL_ENABLE_OPENCLAW_NEMOCLAW=1` | `NVIDIA_API_KEY` set in `.env` for the stack |
| Hermes + Docker | `REAL_ENABLE_HERMES_DOCKER=1` | First run pulls a large Hermes image — warm the cache or raise `REAL_PROVISION_TIMEOUT_MS` |

Each cell runs in order: `[L1] deploy → [L2] reach running → [L3] gateway
reachable → [L4] chat roundtrip → [L5] logs/events → [L7] metrics populate →
[L8] stop+start → [L10] destroy`. If any step fails, later steps in that cell
still run (Playwright serial mode with `test.skip` fallbacks), but subsequent
cells are unaffected.

Lifecycle steps L6 (terminal `printenv`) and L9 (provider-key rotation sync)
from the original checklist are not in the automated suite — verify those
manually once via the operator UI per test-plan §9.

## Security regression signals

Two specs specifically assert that the recent security fixes still hold:

- `[I4]` — integration with `url=http://169.254.169.254/...` must return
  `success: false` with an "internal/private network" error.
- `[C3]` — Discord channel with `webhook_url=http://worker-provisioner:4001/...`
  must refuse delivery with the same error.

If either passes the SSRF guard, the assertion will flip red.

## Troubleshooting

- **Cells skip immediately.** Check `/api/config/platform.enabledBackends` —
  only cells matching what your stack was booted with will run. If you want
  all four, boot with `ENABLED_BACKENDS=docker,k8s,nemoclaw` and
  `ENABLED_RUNTIME_FAMILIES=openclaw,hermes`.
- **`[L2] reach running` times out.** `docker compose logs worker-provisioner`
  and `docker compose logs backend-api` are the primary signal. For k8s, also
  `kubectl -n default get pods`.
- **`[L4] chat roundtrip` times out on Hermes.** First-run image pull can
  exceed 2 minutes; raise `REAL_CHAT_TIMEOUT_MS`.
- **Discord/Telegram test says delivered: true but you see nothing.** Confirm
  the bot has DM'd your chat (Telegram requires `/start` from your account
  first) and the Discord webhook channel still exists.
