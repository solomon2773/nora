<p align="center">
  <h1 align="center">Nora</h1>
  <p align="center"><strong>The open-source control plane for agent operations.</strong></p>
  <p align="center">Deploy, observe, and operate agent runtimes from one dashboard. Nora is self-hostable, commercially usable, and enterprise-capable. OpenClaw is the strongest supported runtime today, while Nora stays aimed at broader runtime integration over time.</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/docker-compose-2496ED.svg" alt="Docker" />
  <img src="https://img.shields.io/badge/self--hosted-first-0ea5e9.svg" alt="Self-Hosted First" />
  <img src="https://img.shields.io/badge/commercial%20use-Apache%202.0%20allowed-6d28d9.svg" alt="Commercial use allowed" />
</p>

<p align="center">
  <a href="https://github.com/solomon2773/nora#quick-start">Self-host Quick Start</a>
  ·
  <a href="https://nora.solomontsao.com">Hosted eval / managed PaaS</a>
  ·
  <a href="https://nora.solomontsao.com/pricing">Deployment / support / enterprise paths</a>
  ·
  <a href="https://github.com/solomon2773/nora/discussions">Rollout help / paid support</a>
  ·
  <a href="https://storage.solomontsao.com/setup.sh">Install script (bash)</a>
  ·
  <a href="https://storage.solomontsao.com/setup.ps1">Install script (PowerShell)</a>
  ·
  <a href="SUPPORT.md">Support Paths</a>
  ·
  <a href="#runtime-direction">Runtime direction</a>
  ·
  <a href="#deployment-footprint">Deployment footprint</a>
</p>

---

## What is Nora?

Nora is an open-source control plane for self-hosted agent operations.

Today, the best-supported path is [OpenClaw](https://github.com/openclaw/openclaw). That is the clearest way to evaluate Nora right now. But the product direction should stay broader than a single runtime: Nora should become easier to integrate with additional agent runtimes over time.

It is designed to be credible for serious operator use: individual builders can run it, internal platform teams can standardize on it, and larger enterprise-capable environments can keep infrastructure control without giving up the open-source trust model.

Nora gives technical teams a single place to:

- deploy agent runtimes into isolated environments
- manage provider keys and sync them to running runtimes
- access chat, logs, and terminal workflows
- connect channels and integrations
- monitor operator activity and runtime workflows

The core value proposition is simple: **if you care about infrastructure, observability, repeatable operations, and a trustworthy operator surface, Nora helps you get to a usable control plane faster.**

## Positioning pillars

Nora should be easy to describe in one pass:

- **Security built in** — the product should feel trustworthy for real operator environments, not like an afterthought wrapper around secrets and infrastructure.
- **Easy to use** — teams should be able to reach first proof quickly: install, create an operator account, add one provider, deploy one runtime, and validate the workflow.
- **Expandable** — the product should support a clean path from today's best-supported runtime to broader runtime adapters over time.
- **Self-hostable** — the repo, install scripts, and Docker Compose flow should remain a credible trust path.
- **Enterprise-capable** — Nora should make sense from single-host evaluation through Proxmox, private cloud / on-prem, and AWS/Azure/GCP rollout footprints.

That combination is the durable positioning: not a toy dashboard, not a vague AI shell, and not a permanently single-runtime wrapper.

## Open source means open source

Nora is licensed under **Apache 2.0**.

That means you can:

- self-host Nora on your own infrastructure
- modify the codebase for your own needs
- use Nora commercially inside your company
- host Nora for clients or customers on infrastructure you control
- build services, packaging, or integrations on top of Nora

The repo should not market a maintainer-commercial relationship as the center of the product. The center of the product is the **fully open-source repo and self-hosted control-plane workflow**.

That OSS-first story should still feel enterprise-capable: teams should be able to read the repo, inspect the install path, and conclude that Nora can support serious internal operations without a sales-led trust gap.

## Current product direction

### OpenClaw-first today

OpenClaw is the most mature and best-supported runtime path in Nora today. If you want the fastest proof of value, start there.

### Not OpenClaw-only forever

Nora should not be permanently framed as useful only for OpenClaw. The product, docs, and interface should stay friendly to future integration with other agent runtimes.

That means:

- avoid branding the whole product as permanently single-runtime
- describe OpenClaw as the strongest supported path **today**
- keep runtime abstractions clean enough that future adapters are realistic
- show examples with OpenClaw now without turning the platform story into “OpenClaw only, forever”

## Deployment footprint

Nora should also be framed as a control plane that can grow with operator requirements.

It should make sense across this deployment range:

- **single-host self-hosted installs** for first proof and lean teams
- **Proxmox-backed environments** for stronger isolation and private fleet control
- **private cloud / on-prem environments** for security-conscious internal platforms
- **AWS, Azure, and GCP deployments** for larger cloud-native or enterprise rollouts

That footprint matters because Nora is not just trying to be a one-box dashboard. It should stay credible as an operator surface that starts small and expands into more serious infrastructure.

## Who Nora is for

Nora is best for:

- internal AI platform teams
- technical product teams
- ops-minded operators running agent infrastructure
- service providers who want to host and operate agent control planes for others

Nora is not trying to be:

- a vague “AI workforce” shell
- a generic low-code automation toy
- a closed wrapper around an otherwise-open repo

## Fastest path to proof

Use this path to reach first proof of value quickly:

1. **Install Nora** with the setup script or Docker Compose flow
2. **Create your operator account** and save one LLM provider key
3. **Deploy one agent runtime** and validate chat, logs, and terminal from the same surface

That path is still easiest with OpenClaw today, but the operator model should remain extensible.

## Commercial paths today

The paid path should be clear without making unsupported claims.

### 1. Self-hosted open source

Start with the repo, raw install scripts, and Docker Compose path if you want the cleanest proof and full infrastructure control.

### 2. Rollout help / paid support

Use [GitHub Discussions](https://github.com/solomon2773/nora/discussions) if you want the same OSS product but a faster path to first value on infrastructure you control.

### 3. Hosted evaluation / managed PaaS

Use [nora.solomontsao.com](https://nora.solomontsao.com) and [signup](https://nora.solomontsao.com/signup) when you want a less DIY first step or want to evaluate Nora through a hosted path.

### 4. Enterprise / custom deployment

Use [deployment paths](https://nora.solomontsao.com/pricing) when you need scoped help around deployment footprint, infrastructure ownership, rollout depth, or larger-team requirements.

Public entry points stay in [Support Paths](SUPPORT.md) and on [nora.solomontsao.com/pricing](https://nora.solomontsao.com/pricing).

## Public repo scope

This public repository keeps the product code, quick start, support entry points, and deployment helpers available in the open.

Long-form rollout notes, proof packs, screenshots, and other internal documentation are maintained separately from the public repo.

## Runtime direction

Nora should be described as:

- **OpenClaw-first today**
- **runtime-friendly by direction**
- **self-hosted and commercially usable by anyone under Apache 2.0**
- **credible from single-host through Proxmox, private cloud, and AWS/Azure/GCP deployment footprints**

That framing is more durable than treating Nora as a permanently single-runtime dashboard or centering the repo around sales packaging.

## Quick Start

### Prerequisites

> The setup script can install Docker, Docker Compose, and Git if they are missing.

- macOS 12+, Linux (Ubuntu 20.04+, Debian 11+, Fedora 38+), or Windows 10+ with WSL2
- Admin/sudo access for initial setup

### Recommended install

**macOS / Linux / WSL2**

```bash
curl -fsSL https://storage.solomontsao.com/setup.sh | bash
```

**Windows (PowerShell)**

```powershell
iwr -useb https://storage.solomontsao.com/setup.ps1 | iex
```

The installer will:

1. clone the repository
2. verify Docker, Docker Compose, and OpenSSL
3. generate platform secrets
4. choose local-only or public-domain access mode
5. configure self-hosted or PaaS mode
6. create the initial admin account
7. collect an LLM provider key (optional but recommended)
8. generate the matching nginx config and start the Nora stack
9. take you to the dashboard so you can deploy the first agent

The public install links intentionally use `storage.solomontsao.com` as the canonical installer host while keeping the open-source repo and README quick start as the primary trust anchor.

### Manual setup

```bash
git clone https://github.com/solomon2773/nora.git
cd nora
bash setup.sh
```

Or configure by hand:

```bash
cp .env.example .env
```

Then edit `.env` with your secrets:

```bash
# Access / URL
NGINX_CONFIG_FILE=nginx.conf
NGINX_HTTP_PORT=8080

# Required — generate with: openssl rand -hex 32
JWT_SECRET=your-64-char-hex-key
ENCRYPTION_KEY=your-64-char-hex-key

# Optional bootstrap admin (seeded only when both are set securely)
DEFAULT_ADMIN_EMAIL=<REPLACE_WITH_BOOTSTRAP_ADMIN_EMAIL>
DEFAULT_ADMIN_PASSWORD=<REPLACE_WITH_STRONG_BOOTSTRAP_PASSWORD>

# Optional — OAuth (leave blank to disable)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
NEXTAUTH_SECRET=your-64-char-hex-key
NEXTAUTH_URL=http://localhost:8080
CORS_ORIGINS=http://localhost:8080

# Optional — Stripe billing (PaaS mode)
STRIPE_SECRET_KEY=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
```

To make Nora public on a domain, change the access values to your public origin:

```bash
NGINX_CONFIG_FILE=nginx.public.conf
NGINX_HTTP_PORT=80
NEXTAUTH_URL=https://app.example.com
CORS_ORIGINS=https://app.example.com
```

Then create `nginx.public.conf` from [`infra/nginx_public.conf.template`](infra/nginx_public.conf.template) for plain HTTP public-domain mode. If nginx should terminate TLS itself on the host, run:

```bash
DOMAIN=app.example.com EMAIL=admin@example.com ./infra/setup-tls.sh
```

That command writes the TLS-ready `nginx.public.conf` and `docker-compose.override.yml` files for you.

Start the stack:

```bash
docker compose up -d
```

---

## First 15 minutes with Nora

### 1) Open the dashboard

The installer prints the base URL it configured.

Local mode uses these defaults:

| URL | What |
|---|---|
| [localhost:8080](http://localhost:8080) | Marketing / entry page |
| [localhost:8080/login](http://localhost:8080/login) | Login |
| [localhost:8080/signup](http://localhost:8080/signup) | Create operator account |
| [localhost:8080/app/dashboard](http://localhost:8080/app/dashboard) | System overview |
| [localhost:8080/app/deploy](http://localhost:8080/app/deploy) | Deploy your first agent |

Public-domain mode uses the same paths on your configured origin, for example `https://stage.orionconnect.io/app/dashboard`.

### 2) Add an LLM provider

Go to **Settings** and save an API key for a supported provider such as Anthropic, OpenAI, Google, or another available provider.

### 3) Deploy your first agent runtime (OpenClaw is the default path today)

1. Go to **Deploy**
2. enter an agent name
3. choose a runtime mode
4. size CPU, RAM, and disk
5. click **Confirm & Deploy Agent**

### 4) Validate the runtime

After deployment:

1. open the agent detail page
2. verify the agent is running
3. sync provider keys if needed
4. test **Chat**
5. inspect **Logs**
6. open **Terminal**

If those steps work cleanly, Nora has already demonstrated its core value.

---

## What you can do in Nora

### Deploy & Manage Agents

Create agents, choose the runtime backend, define resource limits, and manage their lifecycle from the dashboard.

### Chat with Agents

Use OpenClaw chat workflows directly from the UI with streaming responses and session visibility.

### Open Interactive Terminals

Access persistent terminal sessions connected to agent runtimes.

### Manage Provider Keys

Save provider credentials centrally and sync them to running agents when needed.

### Connect Channels & Integrations

Configure communication channels and browse integration options from the same control plane.

### Monitor Operations

Track agent health, queue state, logs, metrics, and runtime activity.

---

## Architecture

```text
  Nginx (:8080)
  ├── /           → frontend-marketing  (Next.js)
  ├── /app/*      → frontend-dashboard  (Next.js)
  ├── /admin/*    → admin-dashboard     (Next.js)
  └── /api/*      → backend-api         (Express.js)
                        ├── PostgreSQL 15
                        ├── Redis 7 + BullMQ
                        └── OpenClaw Gateway today / broader runtime adapters later
```

### Core components

- `frontend-marketing/` — landing, login, signup, and deployment/support-path page
- `frontend-dashboard/` — operator dashboard for agents and settings
- `backend-api/` — APIs, auth, key management, provisioning, monitoring
- `admin-dashboard/` — admin/operator surfaces
- `e2e/` — Playwright end-to-end tests
- `infra/` — backup and TLS helpers

---

## Tech Stack

| Layer | Technology |
|---|---|
| Reverse Proxy | Nginx |
| Frontend | Next.js 14, React 18, Tailwind CSS |
| Backend | Express.js 4, Node.js 20 |
| Auth | NextAuth.js, JWT, bcryptjs |
| Database | PostgreSQL 15 |
| Queue | BullMQ + Redis 7 |
| Agent Runtime | OpenClaw Gateway today; broader runtime integrations remain in scope |
| Encryption | AES-256-GCM |
| Provisioning | Docker, Proxmox, Kubernetes, NemoClaw |

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `ENCRYPTION_KEY` | Yes | 32-byte hex key (`openssl rand -hex 32`) |
| `NEXTAUTH_URL` | Yes | Base browser URL, for example `http://localhost:8080` or `https://app.example.com` |
| `NGINX_CONFIG_FILE` | No | `nginx.conf` for local mode or `nginx.public.conf` for public-domain mode |
| `NGINX_HTTP_PORT` | No | Host port for nginx HTTP (`8080` local, `80` public) |
| `PLATFORM_MODE` | No | `selfhosted` (default) or `paas` |
| `PROVISIONER_BACKEND` | No | `docker` (default), `proxmox`, `k8s` |
| `K8S_EXPOSURE_MODE` | No | `cluster-ip` (default) or `node-port` for local kind verification |
| `NEMOCLAW_ENABLED` | No | `true` to enable NemoClaw sandbox |
| `CORS_ORIGINS` | No | Comma-separated allowed origins; include your public origin when exposed on a domain |

---

## Development

```bash
# Docker (recommended)
docker compose up -d
docker compose logs -f backend-api
docker compose up -d --build backend-api

# Local dev
cd backend-api && npm install && npm run dev
cd frontend-dashboard && npm install && npm run dev
cd frontend-marketing && npm install && npm run dev

# Tests
cd backend-api && npx jest --no-watchman

# Database
docker compose exec postgres psql -U platform -d platform

# Docker-hosted Kubernetes smoke (requires docker, kind, kubectl)
cd e2e && npm run smoke:k8s-kind
```

`NemoClaw` in this repo is a Docker-hosted sandbox backend with OpenShell policy controls, not Docker-in-Docker. For local Kubernetes verification, use `kind` plus [`docker-compose.kind.yml`](docker-compose.kind.yml); the K8s backend switches to `K8S_EXPOSURE_MODE=node-port` so the Compose-hosted control plane can reach the runtime and gateway through Docker-mapped host ports.

For public-domain setup, use [`infra/nginx_public.conf.template`](infra/nginx_public.conf.template) for plain HTTP or [`infra/setup-tls.sh`](infra/setup-tls.sh) for Let's Encrypt-backed TLS.

---

## Roadmap

### Current focus

- improve activation UX and first-run operator flow
- tighten self-hosted positioning and documentation
- improve dashboard proof density and onboarding clarity
- continue hardening auth, key sync, and operator workflows

### Planned

- public REST API and API keys
- agent templates and cloning
- richer alerting and cost controls
- multi-tenant teams with stronger RBAC
- agent versioning and rollback
- CLI workflows for deployment and sync

---

## Contributing

Nora is in active development.

Good contribution areas include:

- frontend UX for operator workflows
- backend provisioning and lifecycle management
- testing and CI hardening
- integrations and channel support
- self-hosted deployment ergonomics

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Open a Pull Request

---

## Community

- [Issues](https://github.com/solomon2773/nora/issues)
- [Discussions](https://github.com/solomon2773/nora/discussions)
- [OpenClaw](https://github.com/openclaw/openclaw)

---

## License

This project is open source under the [Apache License 2.0](LICENSE).
