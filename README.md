<p align="center">
  <h1 align="center">Nora</h1>
  <p align="center"><strong>The open-source control plane for autonomous AI agents.</strong></p>
  <p align="center">Deploy agents in 60 seconds. Connect 18 LLMs and 60+ tools. Monitor everything from one dashboard.</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/docker-compose-2496ED.svg" alt="Docker" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <img src="https://img.shields.io/github/stars/solomon2773/nora?style=social" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/solomon2773/nora" alt="Contributors" />
  <img src="https://img.shields.io/github/last-commit/solomon2773/nora" alt="Last Commit" />
</p>

<!-- <p align="center">
  <img src="docs/assets/nora-dashboard.gif" alt="Nora Dashboard" width="720" />
</p> -->

---

## What is Nora?

Nora is an open-source control plane for [OpenClaw](https://github.com/openclaw/openclaw) agents. It handles the full lifecycle — provisioning, deploying, monitoring, and managing autonomous AI agents at scale — so you can focus on what your agents do, not on the infrastructure running them.

Each OpenClaw agent is deployed into its own sandboxed container. Nora connects them to any LLM, wires up your tools and communication channels, and gives you a single dashboard to manage everything.

### Why Nora?

- **60-second deployment** — name your agent, pick an LLM, click deploy. Done.
- **Real agent control** — interactive terminal, streaming chat, session management, cron scheduling, and tool inventory per agent.
- **60+ integrations** — GitHub, Slack, Jira, Notion, Stripe, AWS, and more. Connect from the UI, no code needed.
- **18 LLM providers** — Anthropic, OpenAI, Google, Groq, Mistral, DeepSeek, OpenRouter, and more. Keys encrypted at rest.
- **9 communication channels** — Slack, Discord, WhatsApp, Telegram, LINE, Email, Webhook, Teams, SMS.
- **Pluggable infrastructure** — Docker, Proxmox LXC, Kubernetes, or NemoClaw (NVIDIA Nemotron sandbox).
- **Self-hosted or PaaS** — run on your own infra or deploy as a SaaS with Stripe billing.
- **Security first** — AES-256-GCM encryption, Ed25519 device identity, JWT + RBAC, rate limiting.

---

## How It Works

```
  You                    Nora                         Your Infrastructure
  ───                    ────                         ────────────────────

  Click "Deploy"  ──►  Queue job  ──►  Provision container
                                        ├── Inject LLM keys
                                        ├── Setup Ed25519 identity
                                        └── Start OpenClaw Gateway

  Chat / Terminal ──►  WS-RPC Proxy  ──►  Agent Container (:18789)
  Cron / Tools                             └── OpenClaw Gateway

  Monitor         ──►  Metrics API  ──►  Token usage, costs, errors
```

Nora sits between you and your agent fleet. It provisions containers, injects credentials, proxies all communication through secure WebSocket-RPC, and tracks everything.

---

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/) v2+
- Git

### Option A: Guided Setup (Recommended)

The interactive setup script generates secrets, configures your platform mode, provisioner backend, OAuth, and NemoClaw — then optionally starts everything for you.

```bash
git clone https://github.com/solomon2773/nora.git
cd nora
bash setup.sh
```

The script will:
1. Verify Docker, Docker Compose, and openssl are installed
2. Auto-generate cryptographic secrets (JWT, AES-256-GCM, NextAuth)
3. Ask you to choose platform mode (self-hosted or PaaS)
4. Ask you to choose provisioner backend (Docker, Proxmox, or Kubernetes)
5. Set up a default admin account (email + password for first login)
6. Optionally configure NemoClaw (NVIDIA sandbox) and OAuth (Google/GitHub)
7. Write `.env` and offer to start the platform

### Option B: Manual Setup

```bash
git clone https://github.com/solomon2773/nora.git
cd nora
cp .env.example .env
```

Edit `.env` with your secrets:

```bash
# Required — generate with: openssl rand -hex 32
JWT_SECRET=your-64-char-hex-key
ENCRYPTION_KEY=your-64-char-hex-key

# Default admin account (created on first boot)
DEFAULT_ADMIN_EMAIL=admin@nora.local
DEFAULT_ADMIN_PASSWORD=changeme           # change this!

# Optional — OAuth (leave blank to disable)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
NEXTAUTH_SECRET=your-64-char-hex-key

# Optional — Stripe billing (only for PaaS mode)
STRIPE_SECRET_KEY=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
```

Then start:

```bash
docker compose up -d
```

Eight services come up automatically: Nginx, two frontends, backend API, worker, admin panel, PostgreSQL, and Redis. Database schema is applied on first boot.

### Open the dashboard

| URL | What |
|---|---|
| [localhost:8080](http://localhost:8080) | Landing page |
| [localhost:8080/login](http://localhost:8080/login) | Login / Sign up |
| [localhost:8080/app/agents](http://localhost:8080/app/agents) | Agent fleet |
| [localhost:8080/app/deploy](http://localhost:8080/app/deploy) | Deploy new agent |

### Deploy your first agent

1. Log in with your admin account (default: `admin@nora.local` / `admin123`)
2. Go to [Deploy](http://localhost:8080/app/deploy)
3. Enter an agent name and click **Deploy**
4. Go to **Settings** > add your LLM API key (e.g., Google AI, OpenAI, Anthropic)
5. Click **Sync to Agent**
6. Open the **Chat** tab and start talking to your agent

> **Note:** Change the default admin password after first login. You can also create additional accounts from the signup page.

---

## What You Can Do

### Deploy & Manage Agents

Create agents with a name, pick a backend (Docker or NemoClaw), and set resource limits. Start, stop, restart, or redeploy from the dashboard.

### Chat with Agents

Streaming chat with real-time token-by-token responses, tool call visualization, thinking traces, and full session history with infinite scroll.

### Interactive Terminal

Web terminal connected directly to the agent container. Persistent history, keyboard shortcuts, and export for audit.

### Connect LLM Providers

18 providers supported. Add your API key from Settings, then sync to any running agent. Per-agent model selection.

**Providers:** Anthropic, OpenAI, Google AI, Groq, Mistral, DeepSeek, OpenRouter, Together AI, Cohere, xAI, Moonshot, Z.AI, Ollama, MiniMax, GitHub Copilot, Hugging Face, Cerebras, NVIDIA

### Communication Channels

Connect agents to Discord, Slack, WhatsApp, Telegram, LINE, Email, Webhook, Teams, or SMS.

### Integrations

60+ pre-built integrations across 17 categories — developer tools, communication, AI/ML, cloud, data, monitoring, CRM, and more. Connect from the UI.

### Schedule Recurring Tasks
Use the Cron sub-panel to schedule recurring prompts with standard cron syntax. Agents execute tasks on schedule in new sessions.

---

## Architecture

```
  Nginx (:8080)
  ├── /           → frontend-marketing  (Next.js)
  ├── /app/*      → frontend-dashboard  (Next.js)
  ├── /admin/*    → admin-dashboard     (Next.js)
  └── /api/*      → backend-api         (Express.js)
                        ├── PostgreSQL 15
                        ├── Redis 7 + BullMQ  →  worker-provisioner
                        │                          └── Docker / Proxmox / K8s / NemoClaw
                        └── OpenClaw Gateway (WS-RPC :18789 per agent)
```


---

## Tech Stack

| Layer | Technology |
|---|---|
| Reverse Proxy | Nginx |
| Frontend | Next.js 14, React 18, Tailwind CSS 3.4, Lucide React |
| Terminal | xterm.js |
| Backend | Express.js 4, Node.js 20 |
| Auth | NextAuth.js (Google/GitHub), bcryptjs, JWT |
| Database | PostgreSQL 15 |
| Queue | BullMQ + Redis 7 |
| Agent Gateway | OpenClaw WS-RPC, Ed25519 device identity |
| Encryption | AES-256-GCM |
| Billing | Stripe |
| Provisioner | dockerode, Proxmox API, Kubernetes API, NemoClaw |

---

## Project Structure

```
├── backend-api/            Express.js API + OpenClaw Gateway proxy
├── frontend-marketing/     Landing page, login, signup
├── frontend-dashboard/     Agent management dashboard
├── admin-dashboard/        Operator admin panel
├── workers/provisioner/    BullMQ worker (Docker/Proxmox/K8s/NemoClaw)
├── agent-runtime/          OpenClaw CLI agent runtime (reference)
├── e2e/                    Playwright E2E tests
├── infra/                  Backup & TLS configs
├── docs/                   Additional docs (HTTPS, etc.)
├── docker-compose.yml      Service orchestration
└── nginx.conf              Reverse proxy config
```

---

## Configuration

### Environment Variables

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
docker compose logs -f backend-api       # Watch logs
docker compose up -d --build backend-api  # Rebuild a service

# Local (requires PostgreSQL + Redis)
cd backend-api && npm install && npm run dev
cd frontend-dashboard && npm install && npm run dev

# Tests
cd backend-api && npx jest --no-watchman

# Database
docker compose exec postgres psql -U platform -d platform
```

For HTTPS/TLS setup, see [docs/HTTPS_SETUP.md](docs/HTTPS_SETUP.md).

---

## Roadmap

### In Progress

- [ ] Per-agent LLM key sync
- [ ] Terminal session history persistence
- [ ] Log export for audit compliance
- [ ] Mobile-responsive layouts

### Planned

- [ ] MCP (Model Context Protocol) tool server support
- [ ] Agent cloning and templates
- [ ] Alerting rules (error rate, cost thresholds)
- [ ] Public REST API with API keys for CI/CD
- [ ] Multi-tenant teams with RBAC
- [ ] Agent versioning and rollback
- [ ] CLI tool (`nora deploy`, `nora sync`)

Have an idea? [Open a discussion](https://github.com/solomon2773/nora/discussions).

---

## Contributing

Nora is in active development. We're looking for developers who want to shape the future of AI agent infrastructure.

**Areas we need help with:** Frontend (React, UX), Backend (API, workers), Integrations (connectors), Testing (unit, E2E, load), DevOps (K8s, CI/CD).

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Open a Pull Request

PRs reviewed within 48 hours. Issues tagged `good first issue` for newcomers.

---

## Community

- [Discussions](https://github.com/solomon2773/nora/discussions) — ideas, questions, and RFC proposals
- [Issues](https://github.com/solomon2773/nora/issues) — bug reports and feature requests

---

## License

This project is open source under the [MIT License](LICENSE).
