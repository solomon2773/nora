# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Nora is a self-hosted control plane for AI agent runtimes. It manages, deploys, monitors, and operates agent runtimes across multiple backends (Docker, Kubernetes, Proxmox, NemoClaw, Hermes). Node 24 LTS across all services.

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
- `docker-compose.kind.yml` — Kubernetes Kind smoke testing (`ENABLED_BACKENDS=k8s`, `K8S_EXPOSURE_MODE=node-port`)

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

CI (`.github/workflows/ci.yml`) runs backend tests + E2E smoke on every PR and push to master under Node 24.

## Architecture

```
Browsers
  ↓
nginx (8080 local / 80|443 public)
  ├── /           frontend-marketing   (Next.js 16, public site + auth)
  ├── /app        frontend-dashboard   (Next.js 16, operator workspace)
  ├── /admin      admin-dashboard      (Next.js 16, platform admin)
  └── /api        backend-api          (Express, container port 4000, host 127.0.0.1:4100)
                    ├── PostgreSQL 15      (state: users, agents, deployments, marketplace, audit)
                    ├── Redis 7 + BullMQ   (async job queue)
                    └── worker-provisioner (health on 4001)
                          ├── Docker adapter
                          ├── Kubernetes adapter
                          ├── Proxmox adapter
                          ├── NemoClaw adapter
                          └── Hermes adapter
```

**Key ports:** nginx 8080 (local), backend-api container 4000 → host 4100, worker-provisioner health 4001, agent runtime contract 9090, OpenClaw gateway 18789, Hermes dashboard 9119.

**Request path:** Browser → nginx → frontend or backend-api → PostgreSQL (sync state) + BullMQ (async work) → worker-provisioner → backend adapter → runtime.

### Runtime selection (three-dimensional)

Resolved in `agent-runtime/lib/backendCatalog.ts`:

1. **Runtime family** (`ENABLED_RUNTIME_FAMILIES`): `openclaw` (default) or `hermes`
2. **Deploy target** (`ENABLED_BACKENDS`): `docker`, `k8s`, `proxmox`
3. **Sandbox profile**: `standard` or `nemoclaw`

### Shared runtime contracts

`agent-runtime/` is **not deployed alone** — it is mounted read-only at `/agent-runtime` into both backend-api and worker-provisioner. Control-plane and workers import from it rather than embedding backend assumptions. Key files:

- `lib/backendCatalog.ts` — backend selection, maturity status, metadata
- `lib/agentEndpoints.ts` — gateway/dashboard URL helpers, endpoint checks
- `runtimeBootstrap.ts` — bootstrap file/env injection shared across adapters
- `integrationTools.ts` — LLM provider + integration tool CLI definitions

### Backend adapter code sharing

Compose mounts `./workers/provisioner/backends` into `backend-api` at `/app/backends`. This means adapter code is **physically shared** between the API and the worker. When editing adapters, verify both consumers still work.

### Key backend modules

`backend-api/server.ts` wires: helmet, rate limiting, CORS, auth middleware (`middleware/auth.ts`), correlation IDs (`middleware/errorHandler.ts`), route modules under `routes/` (auth, agents, billing, channels, integrations, llmProviders, marketplace, monitoring, nemoclaw, workspaces, admin), gateway proxy (`gatewayProxy.ts` — exposes `createGatewayRouter` + `attachGatewayWS` for WebSocket upgrade), and background telemetry (`backgroundTasks.ts`, `scheduler.ts`).

**API keys** are stored AES-256-GCM encrypted (`crypto.ts`) in PostgreSQL; JWT handles session auth.

## Subtree Ownership

Each folder has its own `AGENTS.md` that narrows ownership, data-flow rules, and architecture. Read the relevant subtree doc before implementing in that area. Cross-cutting changes should be split across affected subtrees.

- `backend-api/` — primary integration hub: control-plane APIs, persistence, queue, auth, monitoring, marketplace, gateway proxy, runtime coordination
- `workers/provisioner/` — async provisioning worker; `workers/provisioner/backends/` holds adapter implementations (shared with backend-api via volume mount)
- `agent-runtime/` — shared runtime contracts (mounted read-only into backend-api and worker)
- `frontend-dashboard/` — operator UI at `/app`; coordinates with backend-api for API + WebSocket contracts
- `admin-dashboard/` — platform admin UI at `/admin`
- `frontend-marketing/` — public site + auth entrypoints at `/`
- `e2e/` — Playwright smoke coverage and local stack bootstrapping
- `infra/` — public-domain nginx template (`nginx_public.conf.template`), TLS setup (`setup-tls.sh`), Kind config, backup image, public/prod compose overlays
- `.github/` — CI and deploy workflows

Note: the **active** nginx configs (`nginx.conf`, `nginx.e2e.conf`, `nginx.public.conf`) live at the **repo root** — that's what compose mounts. `infra/nginx_public.conf.template` is a template used by `setup-tls.sh`.

## Public / Private Split

This repo (`/home/projects/nora`) is the public OSS tree. Private material (internal docs, proofs, customer content) lives in the paired private repo at `/home/projects/nora-private`. If a task references missing context, check the private repo before recreating docs.

## Environment

Copy `.env.example` to `.env`. Required: `JWT_SECRET`, `ENCRYPTION_KEY`, `NEXTAUTH_URL`.

Commonly toggled: `PLATFORM_MODE` (`selfhosted` or `paas`), `ENABLED_RUNTIME_FAMILIES`, `ENABLED_BACKENDS`, `NGINX_CONFIG_FILE`, `NGINX_HTTP_PORT`, `BACKEND_API_PORT`, `K8S_EXPOSURE_MODE`, `NVIDIA_API_KEY` (required when `nemoclaw` is enabled), `CORS_ORIGINS`.

`.env.test` exists for test-mode overrides; `NORA_ENV_FILE` can point compose at an alternate env file.

## nginx Routing Notes

- WebSocket upgrade is handled at the nginx layer; the Express app attaches WS handlers via `attachGatewayWS` — do not add duplicate upgrade headers.
- SSE chat endpoints (`/api/agents/*/gateway/chat`) have chunked transfer encoding disabled for real-time streaming.
- NextAuth callbacks are proxied through nginx before reaching the frontend; large header buffers are configured for cookie/auth tokens.
- Gateway UI/assets and logs/terminal WebSocket paths (`/api/ws/`) are routed explicitly.

## Maintenance Rule

When code changes affect a documented folder's behavior, responsibilities, architecture, or data flow, update the nearest `AGENTS.md` and any affected ancestor/child docs in the same change. New meaningful source folders should receive an `AGENTS.md`; removed/renamed folders should clean up stale `Child Docs` entries.
