# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Nora is the self-hosted AI agent ops platform — an operator-facing control plane that manages, deploys, monitors, and operates agent runtimes across Docker and Kubernetes GA deploy targets. Runtime families are OpenClaw and Hermes; NemoClaw is an experimental sandbox profile layered onto supported deploy targets. Proxmox LXC placement is experimental for OpenClaw and prepared Hermes templates; NemoClaw on Proxmox remains blocked. Node 24 LTS across all services.

## Development Commands

### Docker Compose (primary path)

```bash
docker compose up -d                          # Start full stack (nginx on port 8080)
docker compose up -d --build <service>        # Rebuild a single service
docker compose logs -f backend-api            # Stream logs
docker compose exec postgres psql -U nora -d nora  # Access database
```

The base `docker-compose.yml` runs dev mode (hot-reload, volume mounts). Overlays:

- `docker-compose.override.yml` — auto-loaded; switches to `Dockerfile.prod` and `npm start` for production-like runs
- `docker-compose.e2e.yml` — E2E test stack
- `docker-compose.kubernetes.yml` — generic Kubernetes kubeconfig mounts for Admin-registered clusters
- `docker-compose.kind.yml` — Kind network helper layered with `docker-compose.kubernetes.yml` for local K8s smoke testing

One-liner installer: `./setup.sh` (macOS/Linux/WSL2) or `./setup.ps1` (Windows). Verifies Docker/OpenSSL, generates secrets, creates admin account, starts stack.

### Per-service dev (without Docker)

```bash
# Backend API (listens on 4000 inside container; host-exposed on 127.0.0.1:4100 via compose)
cd backend-api && npm install && npm start

# Worker provisioner (health on 4001)
cd workers/provisioner && npm install && npm start

# Any frontend (port 3000)
cd frontend-dashboard && npm install && npm run dev
# same pattern for admin-dashboard, frontend-marketing
```

### Testing

```bash
# Backend unit tests (Jest, in backend-api/__tests__)
cd backend-api && npm test              # jest --forceExit --detectOpenHandles
cd backend-api && npx jest path/to/file # single test file

# E2E (Playwright) — requires running stack
cd e2e && npm ci && npx playwright install --with-deps chromium && npm test

# Additional E2E smoke scripts
cd e2e && npm run smoke:k8s-kind            # Kubernetes Kind end-to-end
cd e2e && npm run smoke:dashboard-runtime   # Dashboard + runtime integration
cd e2e && npm run smoke:runtime-path        # Runtime resolution
cd e2e && npm run capture:operator-readme   # Regenerate README screenshots
```

CI is split across `.github/workflows/ci-quality.yml`, `.github/workflows/ci-security.yml`, `.github/workflows/ci-compose.yml`, and `.github/workflows/ci-codeql.yml` on pull requests and pushes to `master` under Node 24. npm advisory auditing is deliberately **not** a per-PR blocking check — `npm audit` queries the live advisory DB, so an unchanged lockfile would flip red whenever an unrelated advisory is published. It runs instead on a schedule in `.github/workflows/dependency-audit.yml` (daily + `workflow_dispatch`), with Dependabot security updates handling remediation; the blocking `Security gate` in `ci-security.yml` covers only the deterministic checks (secret scan, license policy, infra validation).

## Architecture

```
Browsers
  ↓
nginx (8080 local / 80|443 public)
  ├── /           frontend-marketing   (Next.js 16, public site + auth)
  ├── /app        frontend-dashboard   (Next.js 16, operator workspace)
  ├── /admin      admin-dashboard      (Next.js 16, platform admin)
  └── /api        backend-api          (Express, container port 4000, host 127.0.0.1:4100)
                    ├── PostgreSQL 15      (state: users, agents, deployments, Agent Hub, audit)
                    ├── Redis 7 + BullMQ   (async job queue)
                    └── worker-provisioner (health on 4001)
                          ├── Docker adapter
                          ├── Kubernetes adapter
                          └── Proxmox LXC adapter (experimental)
```

**Key ports:** nginx 8080 (local), backend-api container 4000 → host 4100, worker-provisioner health 4001, agent runtime contract 9090, OpenClaw gateway 18789, Hermes dashboard 9119.

**Request path:** Browser → nginx → frontend or backend-api → PostgreSQL (sync state) + BullMQ (async work) → worker-provisioner → backend adapter → runtime.

### Runtime selection (three-dimensional)

Resolved in `agent-runtime/lib/backendCatalog.ts`:

1. **Runtime family** (`ENABLED_RUNTIME_FAMILIES`): `openclaw` (default) or `hermes`
2. **Deploy target** (`ENABLED_BACKENDS`): `docker`, `k8s`, `proxmox` (`proxmox` is experimental)
3. **Sandbox profile**: `standard` or `nemoclaw` (`nemoclaw` is experimental)

### Shared runtime contracts

`agent-runtime/` is **not deployed alone** — it is mounted read-only at `/agent-runtime` into both backend-api and worker-provisioner. Control-plane and workers import from it rather than embedding backend assumptions. Key files:

- `lib/backendCatalog.ts` — backend selection, maturity status, metadata
- `lib/agentEndpoints.ts` — gateway/dashboard URL helpers, endpoint checks
- `runtimeBootstrap.ts` — bootstrap file/env injection shared across adapters
- `integrationTools.ts` — LLM provider + integration tool CLI definitions

### Backend adapter code sharing

⚠️ **SHARED/MOUNTED — blast radius spans two services.** Compose mounts `./workers/provisioner/backends` into `backend-api` at `/app/backends`. This means adapter code is **physically shared** between the API and the worker. When editing adapters, verify both consumers still work.

Two consequences that routinely confuse agents:

- **The mount shadows the host `backend-api/backends/` directory at runtime.** Inside the backend-api container, `/app/backends/*` resolves to the worker's copy, _not_ the host files under `backend-api/backends/`. A change to a host file that the mount shadows has **no runtime effect** in the container.
- **`backend-api/backends/hermes.ts` and `nemoclaw.ts` are re-export shims** (`module.exports = require("../../workers/provisioner/backends/<name>")`) — edit the worker source, never the shim. The one genuinely backend-owned file there is `telemetry.ts` (backend telemetry normalization), which is distinct from the worker's `telemetry.ts`.
- **`containerManager.resolveBackendPath` loads adapters from `/app/backends` first.** That directory holds the worker's real adapters in every layout (backend-api prod `COPY`, worker-provisioner prod image, and the dev bind mount), so lifecycle/destroy calls resolve correctly even in the worker-provisioner prod image, where `containerManager` runs from `/backend-api` and the shims' `../../workers/...` path is dead (there is no `/workers` dir). Don't reintroduce reliance on the shim path for prod resolution.

Treat `workers/provisioner/backends/` and `agent-runtime/` as **shared-blast-radius zones**: an edit there changes both backend-api and the worker, so verify both consumers.

### Key backend modules

`backend-api/server.ts` wires: helmet, rate limiting, CORS, auth middleware (`middleware/auth.ts`), correlation IDs (`middleware/errorHandler.ts`), route modules under `routes/` (auth, agents, billing, channels, integrations, llmProviders, Agent Hub, monitoring, nemoclaw, workspaces, admin), gateway proxy (`gatewayProxy.ts` — exposes `createGatewayRouter` + `attachGatewayWS` for WebSocket upgrade), and background telemetry (`backgroundTasks.ts`, `scheduler.ts`).

**API keys** are stored AES-256-GCM encrypted (`crypto.ts`) in PostgreSQL; JWT handles session auth.

## Subtree Ownership

Use the ownership map below before implementing in a subtree. Cross-cutting changes should be split across affected areas and verified at every changed contract boundary.

- `backend-api/` — primary integration hub: control-plane APIs, persistence, queue, auth, monitoring, Agent Hub, gateway proxy, runtime coordination
- `cli/` — packaged command-line client for Nora's public REST APIs, workspace config, token auth, and operator automation commands
- `mcp-server/` — `@noraai/mcp-server`, standalone MCP (Model Context Protocol) stdio server exposing the public REST API as tools for Claude Code/Desktop/Cursor; pure API client authenticated by workspace API keys, no backend coupling
- `workers/provisioner/` — async provisioning worker; `workers/provisioner/backends/` holds adapter implementations (shared with backend-api via volume mount)
- `agent-runtime/` — shared runtime contracts (mounted read-only into backend-api and worker)
- `frontend-dashboard/` — operator UI at `/app`; coordinates with backend-api for API + WebSocket contracts
- `admin-dashboard/` — platform admin UI at `/admin`
- `frontend-marketing/` — public site + auth entrypoints at `/`
- `e2e/` — Playwright smoke coverage and local stack bootstrapping
- `infra/` — public-domain nginx template (`nginx_public.conf.template`), TLS setup (`setup-tls.sh`), Kind config, backup image, public/prod compose overlays, and the official Helm chart for installing Nora on Kubernetes (`helm/nora`, with `helm/scripts/kind-smoke.sh`)
- `docs/` — Mintlify source for the public docs site at `noradocs.solomontsao.com`
- `.github/` — CI and deploy workflows

Note: the **active** nginx configs (`nginx.conf`, `nginx.e2e.conf`, `nginx.public.conf`) live at the **repo root** — that's what compose mounts. `infra/nginx_public.conf.template` is a template used by `setup-tls.sh`.

Root-owned operational files also live at the repo root: `docker-compose*.yml`, `setup.sh`, `setup.ps1`, `package.json`, and `tsconfig.base.json`. Coordinate changes to those through the root owner plus the affected service, `infra/`, `.github/`, or `e2e/` owner.

### Parallel / multi-agent work

When multiple agents work the repo at once:

- **Divide by subtree owner**, using the routing table above. Keep each agent's writes inside its assigned subtree unless the task explicitly spans a shared contract.
- **Use a git worktree per agent** for any file-mutating task, so concurrent edits can't collide in a single working tree.
- **Treat `agent-runtime/` and `workers/provisioner/backends/` as shared-blast-radius zones.** An edit there changes two services — coordinate it rather than assuming it is local to one subtree.
- **Inspect compose mounts and import paths** before fanning out work so every cross-consumer zone has an explicit owner.

## Environment

Copy `.env.example` to `.env`. Required (boot fails closed in production): `JWT_SECRET`, `ENCRYPTION_KEY`. Also required for managed backups: `NORA_BACKUP_ENCRYPTION_KEY`. `NORA_AGENT_HUB_API_KEY_HASH_SECRET` is in the Required block but auto-generates on setup/update when missing. `NEXTAUTH_URL` has a working localhost default and is kept only for deploy-env compatibility (not validated).

Commonly toggled: `PLATFORM_MODE` (`selfhosted` or `paas`), `ENABLED_RUNTIME_FAMILIES`, `ENABLED_BACKENDS`, `NGINX_CONFIG_FILE`, `NGINX_HTTP_PORT`, `BACKEND_API_PORT`, `NORA_KUBECONFIGS_DIR`, `NVIDIA_API_KEY` (required when `nemoclaw` is enabled), `CORS_ORIGINS`.

`.env.test` exists for test-mode overrides; `NORA_ENV_FILE` can point compose at an alternate env file.

## nginx Routing Notes

- WebSocket upgrade is handled at the nginx layer; the Express app attaches WS handlers via `attachGatewayWS` — do not add duplicate upgrade headers.
- SSE chat endpoints (`/api/agents/*/gateway/chat`) have chunked transfer encoding disabled for real-time streaming.
- OAuth callbacks are handled by the marketing app before redirecting into backend-issued HttpOnly session cookies; large header buffers are configured for cookie/auth tokens.
- Gateway UI/assets and logs/terminal WebSocket paths (`/api/ws/`) are routed explicitly.

## Maintenance Rule

When code changes affect documented behavior, responsibilities, architecture, or data flow, update the nearest public contributor or architecture documentation in the same change. New meaningful source folders should include a public README when their extension or operating contract is not obvious from code.
