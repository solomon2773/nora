# Frontend Dashboard

The main application dashboard for Nora. Built with Next.js 16, React 19, and Tailwind CSS.

## Overview

Runs on `/app/*` behind nginx. Users manage their AI agents, configure LLM providers, connect channels, and browse the integration catalog from this dashboard.

## Pages

| Route                       | Description                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `/app`                      | Redirects to `/app/agents`                                                            |
| `/app/dashboard`            | Dashboard home: fleet roll-up, quick stats, and activation checklist                  |
| `/app/getting-started`      | First-run activation checklist; zero-key demo when local Docker is enabled            |
| `/app/agents`               | Agent fleet list with status indicators                                               |
| `/app/agents/[id]`          | Agent detail with runtime-filtered tab interface (up to 10 tabs)                      |
| `/app/agents/[id]/versions` | Agent deploy-draft version history                                                    |
| `/app/deploy`               | Deploy a new agent (Docker or K8s/Kubernetes GA; Proxmox LXC opt-in and experimental) |
| `/app/agent-hub`            | Browse, share, and install agent templates                                            |
| `/app/workspaces`           | Manage isolated workspaces                                                            |
| `/app/monitoring`           | Real-time metrics via SSE                                                             |
| `/app/logs`                 | Standalone cross-agent log browser                                                    |
| `/app/cost`                 | All-workspaces cost dashboard (grouped by workspace)                                  |
| `/app/clawhub`              | ClawHub skill catalog browser used when building a deploy draft                       |
| `/app/settings`             | User profile, LLM provider keys, connected accounts                                   |

## Agent Detail Tabs

Each agent's `/app/agents/[id]` page exposes a runtime-filtered tab set (up to 10 base tabs, filtered by runtime family and sandbox profile):

- **Overview** — status, actions (start/stop/restart/redeploy), resource info
- **Metrics** — agent resource and runtime metrics
- **Terminal** — interactive xterm.js terminal via WebSocket
- **Logs** — real-time log streaming
- **OpenClaw** (gateway runtimes only) — 7 sub-panels: Official Dashboard, Status, Chat, Integrations, ClawHub, Cron, Channels
- **Hermes WebUI** (Hermes only) — embedded Hermes dashboard
- **NemoClaw** (nemoclaw sandbox only) — sandbox profile controls
- **Files** — agent workspace file browser
- **Backups** — agent backup management
- **Settings** — agent config, per-agent LLM budget hard caps (auto-pause when spend crosses 100%), danger zone

Channels and Integrations are not top-level tabs — they are sub-panels inside the OpenClaw tab. The Integrations sub-panel browses 60+ integrations with config modals and adds per-agent MCP server management (expose a connected integration to the agent's OpenClaw runtime as an MCP server).

## Key Components

| Component                                   | Purpose                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `AgentTerminal.tsx`                         | xterm.js terminal with FitAddon, WebSocket           |
| `TabBar.tsx`                                | Runtime-filtered tab navigation bar (up to 10 tabs)  |
| `OpenClawTab.tsx`                           | 7-panel OpenClaw interface                           |
| `ChannelsTab.tsx`                           | Channel CRUD with dynamic config forms               |
| `IntegrationsTab.tsx`                       | Catalog browser with 17-category filter              |
| `IntegrationCard.tsx`                       | Card with config modal for connecting                |
| `BudgetSection.tsx`                         | Per-agent LLM budget hard caps (Settings tab)        |
| `McpServersSection.tsx`                     | Per-agent MCP server management (Integrations panel) |
| `LLMSetupWizard.tsx`                        | 3-step provider setup (select → configure → done)    |
| `Layout.tsx` / `Sidebar.tsx` / `Topbar.tsx` | App shell layout                                     |

## Development

```bash
# Runs automatically in Docker Compose with hot reload
docker compose logs -f frontend-dashboard

# Local development (outside Docker)
cd frontend-dashboard
npm install
npm run dev   # Starts on http://localhost:3000 (honors $PORT; default 3000)
```

## Configuration

| Variable   | Default | Description                                |
| ---------- | ------- | ------------------------------------------ |
| `basePath` | `/app`  | Next.js base path, set in `next.config.ts` |
