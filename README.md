<p align="center">
  <h1 align="center">Nora</h1>
  <p align="center"><strong>Deploy intelligence anywhere.</strong></p>
  <p align="center">Nora is the open-source control plane for deploying, observing, and operating agent runtimes. Self-host it, run it commercially, and manage providers, marketplace templates, runtimes, logs, terminals, integrations, monitoring, and admin workflows from one product surface.</p>
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
  <a href="https://nora.solomontsao.com">Public Site</a>
  ·
  <a href="https://nora.solomontsao.com/login">Log In</a>
  ·
  <a href="https://nora.solomontsao.com/signup">Create Account</a>
  ·
  <a href="https://nora.solomontsao.com/pricing">Open Source / License / PaaS Mode</a>
  ·
  <a href="https://github.com/solomon2773/nora">GitHub Repo</a>
  ·
  <a href="https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh">Install script (bash)</a>
  ·
  <a href="https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1">Install script (PowerShell)</a>
  ·
  <a href="SUPPORT.md">Start Paths</a>
  ·
  <a href="#runtime-direction">Runtime direction</a>
  ·
  <a href="#deployment-footprint">Deployment footprint</a>
</p>

---

## What is Nora?

Nora is an open-source agent operations platform for self-hosted and operator-run deployments.

The default runtime path is [OpenClaw](https://github.com/openclaw/openclaw), with deployment backends for Docker, Proxmox, Kubernetes, and NemoClaw. Nora keeps account access, provider keys, deployment workflows, marketplace templates, logs, terminals, metrics, channels, integrations, and admin workflows in one product surface.

It is built for serious operator use: individual builders can run it, internal platform teams can standardize on it, and larger enterprise environments can keep infrastructure control without giving up the open-source trust model.

Nora gives technical teams a single place to:

- deploy agent runtimes into isolated environments
- manage provider keys and sync them to running runtimes
- access chat, logs, and terminal workflows
- install free platform presets or publish community templates
- review account-scoped event history and user-scoped monitoring
- connect channels and integrations
- review platform operations from a separate admin surface

The core value proposition is simple: **if you care about infrastructure, observability, repeatable operations, and a trustworthy operator surface, Nora helps you get to a usable control plane faster.**

## Why teams choose Nora

Nora is easy to describe in one pass:

- **Security built in** — the product is designed for real operator environments, not as a thin wrapper around secrets and infrastructure.
- **Operational out of the box** — teams can install Nora, create an operator account, add one provider, deploy one runtime or install one preset, and work from the product immediately.
- **Runtime- and template-ready** — Nora ships with a working OpenClaw deployment path and marketplace templates that carry the OpenClaw core markdown files needed for install.
- **Clear operator/admin split** — user-scoped monitoring and account logs live under `/app`, while platform-wide audit, moderation, and queue workflows live under `/admin`.
- **Self-hostable** — the repo, install scripts, and Docker Compose flow are a credible trust path.
- **Enterprise-capable** — Nora fits single-host installs, Proxmox, private cloud / on-prem, and AWS/Azure/GCP rollout footprints.

That combination is the durable positioning: not a toy dashboard, not a vague AI shell, and not a permanently single-runtime wrapper.

## Open source means open source

Nora is licensed under **Apache 2.0**.

That means you can:

- self-host Nora on your own infrastructure
- modify the codebase for your own needs
- use Nora commercially inside your company
- host Nora for clients or customers on infrastructure you control
- build services, packaging, or integrations on top of Nora

The product is not centered on a maintainer-commercial relationship. The center is the **fully open-source repo and self-hosted operator workflow**.

That OSS-first story should still feel enterprise-capable: teams can read the repo, inspect the install path, and conclude that Nora can support serious internal operations without a trust gap.

## Runtime model

### OpenClaw as the default runtime path

OpenClaw is the default runtime path in Nora. It is the fastest way to launch Nora and bring a live agent online.

### Runtime-friendly architecture

Nora keeps runtime abstractions clean so teams can extend the platform without rewriting the operator workflow.

That means:

- keep the product story centered on the full operator platform, not a single runtime brand
- use OpenClaw as the default path in docs and UI where it improves deployment speed and clarity
- keep runtime abstractions clean enough for additional adapters and enterprise deployment requirements

## Deployment footprint

Nora is built as an operator platform that can grow with infrastructure requirements.

It makes sense across this deployment range:

- **single-host self-hosted installs** for lean teams and smaller environments
- **Proxmox-backed environments** for stronger isolation and private fleet control
- **private cloud / on-prem environments** for security-conscious internal platforms
- **AWS, Azure, and GCP deployments** for larger cloud-native or enterprise rollouts

That footprint matters because Nora is not just a one-box dashboard. It stays credible as an operator surface that starts small and expands into more serious infrastructure.

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

## Fastest path to first deployment

Use this path to bring Nora online quickly:

1. **Install Nora** with the setup script or Docker Compose flow
2. **Create your operator account** and save one LLM provider key
3. **Deploy one agent runtime or install one marketplace preset** and bring chat, logs, and terminal online from the same surface

OpenClaw is the default runtime path for that flow, and the operator model stays extensible.

## Product tour

The screenshots below were captured from the current local Nora stack and reflect the shipped operator and admin surfaces in this repository.

### Operator workspace

#### System overview

![Nora system overview dashboard](.github/readme-assets/proof-operator-dashboard.png)

#### Fleet management

![Nora fleet management page](.github/readme-assets/proof-operator-fleet.png)

#### Deploy flow

![Nora deploy new agent flow](.github/readme-assets/proof-operator-deploy-flow.png)

#### Agent detail

![Nora agent detail page showing runtime status and operator controls](.github/readme-assets/proof-operator-agent-detail.png)

#### Provider setup

![Nora settings page for LLM provider keys](.github/readme-assets/proof-operator-settings-provider-setup.png)

#### Marketplace browse

![Nora marketplace page showing platform presets and community template browsing](.github/readme-assets/proof-operator-marketplace.png)

#### Marketplace template detail

![Nora marketplace template detail page showing OpenClaw core files and install-ready template content](.github/readme-assets/proof-operator-marketplace-detail.png)

#### Account event log

![Nora account event log page showing user-scoped marketplace and agent activity](.github/readme-assets/proof-operator-account-event-log.png)

### Admin workspace

#### Marketplace moderation

![Nora admin marketplace moderation page showing listing review and report triage](.github/readme-assets/proof-admin-marketplace.png)

#### Admin template editor

![Nora admin marketplace detail page showing editable core files and template metadata](.github/readme-assets/proof-admin-marketplace-detail.png)

## Open-source usage paths

The public story should stay simple: Nora is open source first, and teams should understand how to run it themselves before anything else.

### 1. Self-hosted open source

Start with the repo, raw install scripts, and Docker Compose path if you want the cleanest self-hosted launch path and full infrastructure control.

### 2. PaaS mode you run

Use `PLATFORM_MODE=paas` when you want to run Nora as your own hosted product or internal platform. Billing, plans, customer onboarding, infrastructure, and go-to-market stay under your control.

### 3. Public browser entry

Use [nora.solomontsao.com](https://nora.solomontsao.com), [login](https://nora.solomontsao.com/login), and [signup](https://nora.solomontsao.com/signup) when you want a quick browser entry or a default public reference deployment.

### 4. Build on top of Nora

Apache 2.0 lets you package Nora, host it for clients or customers, and extend it with your own integrations, workflows, and operational model.

Public entry points stay in [Start Paths](SUPPORT.md) and on [nora.solomontsao.com/pricing](https://nora.solomontsao.com/pricing), where the route now explains OSS licensing, self-hosting, and PaaS mode.

## Public repo scope

This public repository keeps the product code, quick start, account-entry pages, and deployment helpers available in the open.

Internal-only docs, proof packs, and unreleased work may be maintained separately from the public repo. The public repo remains the open-source product and self-host trust path.

## Runtime direction

Nora should be described as:

- **OpenClaw-first today**
- **runtime-friendly by direction**
- **self-hosted and commercially usable by anyone under Apache 2.0**
- **credible from single-host through Proxmox, private cloud, and AWS/Azure/GCP deployment footprints**

That framing is more durable than treating Nora as a permanently single-runtime dashboard or centering the repo around service packaging.

## Quick Start

### Prerequisites

> The setup script can install Docker, Docker Compose, and Git if they are missing.

- macOS 12+, Linux (Ubuntu 20.04+, Debian 11+, Fedora 38+), or Windows 10+ with WSL2
- Admin/sudo access for initial setup

### Recommended install

**macOS / Linux / WSL2**

```bash
curl -fsSL https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh | bash
```

**Windows (PowerShell)**

```powershell
iwr -useb https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1 | iex
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
9. take you to the dashboard so you can deploy the first agent or install the first preset

The public install links intentionally point straight at the raw files in the public GitHub repository so the README, installer path, and source of truth stay aligned.

`PLATFORM_MODE=paas` is still a user-run deployment mode. Use it when you want to operate Nora as your own hosted business or internal platform; it is not a maintainer-only deployment path.

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

# Optional — Stripe billing (for your own PaaS deployment)
STRIPE_SECRET_KEY=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
```

If you are not hosting locally, the default public Nora URL is `https://nora.solomontsao.com`.
Replace it with your own hostname if you are self-hosting on a different domain:

```bash
NGINX_CONFIG_FILE=nginx.public.conf
NGINX_HTTP_PORT=80
NEXTAUTH_URL=https://nora.solomontsao.com
CORS_ORIGINS=https://nora.solomontsao.com
```

Then create `nginx.public.conf` from [`infra/nginx_public.conf.template`](infra/nginx_public.conf.template) for plain HTTP public-domain mode. If nginx should terminate TLS itself on the host, run:

```bash
DOMAIN=<your-domain> EMAIL=admin@example.com ./infra/setup-tls.sh
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

Public-domain mode uses the same paths on your configured origin. The hosted default is `https://nora.solomontsao.com/app/dashboard`; self-hosted installs should use their own domain.

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

If those steps work cleanly, your Nora deployment is ready for broader operator use.

### 5) Browse the marketplace

Once one agent is working, you can also:

1. open **Marketplace**
2. inspect a platform preset or community listing
3. review the core files that will be installed
4. install a free template as a new agent when you want a faster starting point

Community owners can edit and resubmit their own published listings, and admins can review or update listings from `/admin/marketplace`.

---

## What you can do in Nora

### Deploy & Manage Agents

Create agents, choose the runtime backend, define resource limits, and manage their lifecycle from the dashboard.

### Chat, Logs & Terminal

Use OpenClaw chat workflows directly from the UI, inspect runtime logs, and open persistent terminal sessions connected to agent runtimes.

### Install Platform Presets & Share Community Templates

Browse platform presets, download template exports, install them as new agents, or publish your own community templates from agent detail pages. Marketplace listings are free for now, and installs package the OpenClaw core files `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `MEMORY.md`, with optional `BOOTSTRAP.md` and any extra template files included by the listing.

### Review Account Activity & Monitoring

Users see only their own agents, marketplace installs, submissions, reports, and related runtime events in the account event log and monitoring views.

### Manage Provider Keys, Channels & Integrations

Save provider credentials centrally, sync them to running agents when needed, configure communication channels, and browse integration options from the same control plane.

### Run Admin Operations

Admins get platform-wide fleet, user, queue, audit, and marketplace moderation views, including listing detail pages with editable core files and template metadata.

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
                        └── OpenClaw Gateway runtime path
```

### Core components

- `frontend-marketing/` — landing, login, signup, and open-source / licensing / PaaS-mode page
- `frontend-dashboard/` — operator dashboard for agents, marketplace, logs, monitoring, and settings
- `backend-api/` — APIs, auth, key management, provisioning, marketplace, and monitoring
- `admin-dashboard/` — admin surfaces for fleet, queue, audit, users, and marketplace moderation
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
| Agent Runtime | OpenClaw Gateway runtime path |
| Encryption | AES-256-GCM |
| Provisioning | Docker, Proxmox, Kubernetes, NemoClaw |

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `ENCRYPTION_KEY` | Yes | 32-byte hex key (`openssl rand -hex 32`) |
| `NEXTAUTH_URL` | Yes | Base browser URL, for example `http://localhost:8080` or `https://nora.solomontsao.com` |
| `NGINX_CONFIG_FILE` | No | `nginx.conf` for local mode or `nginx.public.conf` for public-domain mode |
| `NGINX_HTTP_PORT` | No | Host port for nginx HTTP (`8080` local, `80` public) |
| `PLATFORM_MODE` | No | `selfhosted` (default) or `paas` |
| `ENABLED_BACKENDS` | No | Comma-separated enabled backends. Valid values: `docker`, `k8s`, `proxmox`, `nemoclaw`. The first entry becomes the default when a flow does not pick one explicitly. |
| `K8S_EXPOSURE_MODE` | No | `cluster-ip` (default) or `node-port` for local kind verification |
| `NVIDIA_API_KEY` | No | Required when `ENABLED_BACKENDS` includes `nemoclaw` |
| `CORS_ORIGINS` | No | Comma-separated allowed origins; include `https://nora.solomontsao.com` for the hosted default or your own public origin when self-hosting on a domain |

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

`NemoClaw` in this repo is a Docker-hosted sandbox backend with OpenShell policy controls, not Docker-in-Docker. For local Kubernetes verification, use `kind` plus [`docker-compose.kind.yml`](docker-compose.kind.yml); the overlay sets `ENABLED_BACKENDS=k8s` and switches to `K8S_EXPOSURE_MODE=node-port` so the Compose-hosted control plane can reach the runtime and gateway through Docker-mapped host ports.

For public-domain setup, use [`infra/nginx_public.conf.template`](infra/nginx_public.conf.template) for plain HTTP or [`infra/setup-tls.sh`](infra/setup-tls.sh) for Let's Encrypt-backed TLS.

---

## Roadmap

### Current focus

- improve activation UX and first-run operator flow
- tighten self-hosted positioning and documentation
- deepen marketplace publishing, inspection, and moderation flows
- improve account-scoped monitoring and onboarding clarity
- continue hardening auth, key sync, and operator workflows

### Planned

- public REST API and API keys
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
