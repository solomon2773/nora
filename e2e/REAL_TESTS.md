# Real-credential E2E suite

These specs run the real lifecycle — deploy, chat against a real LLM, connect
real integrations, send real messages through real channels — and verify the
security fixes shipped in integrations.ts / channels/adapters.ts.

## Files

- `specs/real-deploy-matrix.spec.ts` — §3 test-plan L1-L10 across the
  OpenClaw/Hermes × Docker/K8s/remote-Docker/NemoClaw matrix.
- `specs/real-integrations.spec.ts` — §4 GitHub + Slack + URL-based integration
  with real-cred success and SSRF-guard refusal.
- `specs/real-channels.spec.ts` — §5 OpenClaw channel catalog, type metadata,
  and setup-save coverage with real creds where supplied. Discord runs only
  with `REAL_OPENCLAW_DISCORD_CONFIG_JSON`; webhook URLs belong to the legacy
  adapter and are not accepted by OpenClaw's Discord Bot API schema.
- `specs/support/realConfig.ts` — `.env.real` loader and skip gates.
- `specs/support/agents.ts` — API helpers.
- `specs/support/app.ts` — session/auth + API request helpers
  (`createUserSession`, `DEFAULT_PASSWORD`, `uniqueEmail`, `uniqueName`, plus
  `apiJson`/`getCurrentUser`) imported by the real specs.
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
   # edit — at minimum REAL_LLM_PROVIDER_ID and its matching API key
   # (REAL_ANTHROPIC_API_KEY, REAL_OPENAI_API_KEY, REAL_GOOGLE_API_KEY,
   #  REAL_NVIDIA_API_KEY for NemoClaw, or REAL_LLM_API_KEY as a generic fallback).
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
````

Setting `BASE_URL` disables the auto-managed `docker-compose.e2e.yml` stack in
`playwright.config.ts`, so the specs talk to whichever stack you already have
up.

## What each cell expects

| Cell                                | Enabled by                                      | Extra host requirements                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw + Docker                   | `REAL_ENABLE_OPENCLAW_DOCKER=1` (default)       | Docker socket reachable from `backend-api` / `worker-provisioner` (already wired in the default compose)                                                          |
| OpenClaw + K8s                      | `REAL_ENABLE_OPENCLAW_K8S=1`                    | Control plane started with `docker-compose.kubernetes.yml`; set `REAL_K8S_EXECUTION_TARGET_ID=k8s:<id>` or let the spec pick the first available K8s target       |
| OpenClaw + NemoClaw + Docker        | `REAL_ENABLE_OPENCLAW_NEMOCLAW=1`               | `REAL_NVIDIA_API_KEY` or `NVIDIA_API_KEY`; stack must enable `ENABLED_SANDBOX_PROFILES=standard,nemoclaw`                                                         |
| OpenClaw + NemoClaw + Remote Docker | `REAL_ENABLE_OPENCLAW_NEMOCLAW_REMOTE_DOCKER=1` | A connected remote host target; set `REAL_REMOTE_DOCKER_EXECUTION_TARGET_ID=remote:<id>` and provide `REAL_NVIDIA_API_KEY` or `NVIDIA_API_KEY`                    |
| OpenClaw + NemoClaw + K8s           | `REAL_ENABLE_OPENCLAW_NEMOCLAW_K8S=1`           | A connected K8s/k3s/cloud cluster target; set `REAL_K8S_EXECUTION_TARGET_ID=k8s:<id>` when multiple targets exist, plus `REAL_NVIDIA_API_KEY` or `NVIDIA_API_KEY` |
| Hermes + Docker                     | `REAL_ENABLE_HERMES_DOCKER=1`                   | First run pulls a large Hermes image — warm the cache or raise `REAL_PROVISION_TIMEOUT_MS`                                                                        |
| Hermes + K8s                        | `REAL_ENABLE_HERMES_K8S=1`                      | Control plane started with `docker-compose.kubernetes.yml`; first run pulls a large Hermes image — warm the cache or raise `REAL_PROVISION_TIMEOUT_MS`            |

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
- `[C3]` — OpenClaw channel agents must reject Nora's legacy channel
  test-message and delete routes with `409`, so legacy adapter behaviors do not
  accidentally run against runtime-managed OpenClaw channels.

If either behavior regresses, the assertion will flip red.

## Troubleshooting

- **Cells skip immediately.** Check `/api/config/platform.executionTargets` and
  `/api/config/platform.enabledBackends` — only cells matching what your stack
  exposes will run. If you want all current execution targets and runtime choices, boot with
  `ENABLED_BACKENDS=docker,proxmox`, register Kubernetes clusters in
  **Admin -> Kubernetes**,
  `ENABLED_RUNTIME_FAMILIES=openclaw,hermes`, and
  `ENABLED_SANDBOX_PROFILES=standard,nemoclaw`.
- **NemoClaw cells skip.** Set `REAL_NVIDIA_API_KEY` in `e2e/.env.real`, or
  export `NVIDIA_API_KEY`. The suite saves it as the user's NVIDIA provider key
  and makes that provider default before each NemoClaw deploy.
- **`[L2] reach running` times out.** `docker compose logs worker-provisioner`
  and `docker compose logs backend-api` are the primary signal. For k8s, also
  `kubectl -n openclaw-agents get pods`.
- **`[L4] chat roundtrip` times out on Hermes.** First-run image pull can
  exceed 2 minutes; raise `REAL_CHAT_TIMEOUT_MS`.
- **Telegram/Discord setup saves but provider messages do not arrive.** The
  OpenClaw channel spec verifies Nora's catalog and setup API, not provider
  delivery. Confirm the bot was invited or messaged in the provider, then test
  end-to-end through the running OpenClaw agent.
