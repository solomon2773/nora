<p align="center">
  <h1 align="center">Nora</h1>
  <p align="center"><strong>The open-source control plane for self-hosted OpenClaw agents.</strong></p>
  <p align="center">Deploy, observe, and operate OpenClaw agents from one dashboard — without stitching together provisioning scripts, key sync, chat access, and fleet ops by hand.</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/docker-compose-2496ED.svg" alt="Docker" />
  <img src="https://img.shields.io/badge/openclaw-native-yes-6d28d9.svg" alt="OpenClaw Native" />
  <img src="https://img.shields.io/badge/self--hosted-first-0ea5e9.svg" alt="Self-Hosted First" />
</p>

---

## What is Nora?

Nora is an open-source control plane built specifically for [OpenClaw](https://github.com/openclaw/openclaw) agents.

It gives technical teams a single place to:

- deploy agents into isolated runtimes
- manage provider keys and sync them to running agents
- access chat, logs, and terminal workflows
- connect channels and integrations
- monitor agent activity and operator workflows

The core value proposition is simple: **if you are already serious enough about OpenClaw to care about infrastructure, observability, and repeatable operations, Nora helps you get to a usable control plane faster.**

## Product positioning

### Nora is best for

- **internal AI platform teams** running multiple OpenClaw agents
- **AI product builders** who need a credible operator UX around OpenClaw
- **ops-minded founders and technical teams** who want to self-host from day one

### Nora is not trying to be

- a vague “AI workforce” marketing shell
- a generic low-code automation product
- an all-things-to-all-buyers enterprise platform on day one

### Current MVP focus

The MVP is **self-hosted first** and optimized around the fastest trustworthy path to value:

1. install Nora
2. create an operator account
3. add an LLM provider key
4. deploy an OpenClaw agent
5. validate it via chat, logs, and terminal

That positioning is intentionally narrower and more credible than broad hosted-platform claims.

---

## Why Nora?

- **OpenClaw-native** — purpose-built around OpenClaw agent operations
- **Self-hosted first** — run Nora on your own infrastructure
- **One control plane** — deploy, inspect, and manage agents from a single surface
- **Bring your own keys** — save provider credentials once and sync them to agents
- **Operator visibility** — chat, logs, terminal, channels, integrations, and monitoring
- **Flexible runtime backends** — Docker today, with Proxmox and Kubernetes paths available
- **Security-minded defaults** — encrypted secrets, JWT auth, RBAC, rate limiting, per-agent isolation

---

## Proof points

Nora currently supports:

- **18 LLM providers**
- **60+ tools and integrations**
- **9 communication channel types**
- **3 provisioning backends** (Docker, Proxmox, Kubernetes)

These are better signals for the current product than inflated usage claims.

## MVP evaluation checklist

A successful Nora evaluation should prove four things quickly:

1. you can create an operator account without onboarding confusion
2. you can save one LLM provider key in Settings
3. you can deploy the first OpenClaw agent through the default Docker path
4. you can validate chat, logs, and terminal from the same control plane

If those four steps work cleanly, Nora has already demonstrated the core self-hosted control-plane value proposition.

---

## Quick Start

### Prerequisites

> The setup script can install Docker, Docker Compose, and Git if they are missing.

- macOS 12+, Linux (Ubuntu 20.04+, Debian 11+, Fedora 38+), or Windows 10+ with WSL2
- Admin/sudo access for initial setup

### Recommended install

**macOS / Linux / WSL2**

```bash
curl -fsSL https://nora.solomontsao.com/setup.sh | bash
```

**Windows (PowerShell)**

```powershell
iwr -useb https://nora.solomontsao.com/setup.ps1 | iex
```

The installer will:

1. clone the repository
2. verify Docker, Docker Compose, and OpenSSL
3. generate platform secrets
4. configure self-hosted or PaaS mode
5. create the initial admin account
6. collect an LLM provider key (optional but recommended)
7. start the Nora stack
8. take you to the dashboard so you can deploy the first agent

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
# Required — generate with: openssl rand -hex 32
JWT_SECRET=your-64-char-hex-key
ENCRYPTION_KEY=your-64-char-hex-key

# Default admin account (created on first boot)
DEFAULT_ADMIN_EMAIL=admin@nora.local
DEFAULT_ADMIN_PASSWORD=changeme

# Optional — OAuth (leave blank to disable)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
NEXTAUTH_SECRET=your-64-char-hex-key

# Optional — Stripe billing (PaaS mode)
STRIPE_SECRET_KEY=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
```

Start the stack:

```bash
docker compose up -d
```

---

## First 15 minutes with Nora

### 1) Open the dashboard

| URL | What |
|---|---|
| [localhost:8080](http://localhost:8080) | Marketing / entry page |
| [localhost:8080/login](http://localhost:8080/login) | Login |
| [localhost:8080/signup](http://localhost:8080/signup) | Create operator account |
| [localhost:8080/app/dashboard](http://localhost:8080/app/dashboard) | System overview |
| [localhost:8080/app/deploy](http://localhost:8080/app/deploy) | Deploy your first agent |

### 2) Add an LLM provider

Go to **Settings** and save an API key for a supported provider such as Anthropic, OpenAI, Google, or another available provider.

### 3) Deploy your first OpenClaw agent

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
                        └── OpenClaw Gateway proxy / agent runtime workflows
```

### Core components

- `frontend-marketing/` — landing, login, signup, pricing
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
| Agent Runtime | OpenClaw Gateway |
| Encryption | AES-256-GCM |
| Provisioning | Docker, Proxmox, Kubernetes, NemoClaw |

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `ENCRYPTION_KEY` | Yes | 32-byte hex key (`openssl rand -hex 32`) |
| `PLATFORM_MODE` | No | `selfhosted` (default) or `paas` |
| `PROVISIONER_BACKEND` | No | `docker` (default), `proxmox`, `k8s` |
| `NEMOCLAW_ENABLED` | No | `true` to enable NemoClaw sandbox |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |

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
```

For HTTPS/TLS setup, see [docs/HTTPS_SETUP.md](docs/HTTPS_SETUP.md).

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
