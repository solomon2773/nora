# Frontend Dashboard

The main application dashboard for Nora. Built with Next.js 16, React 19, and Tailwind CSS.

## Overview

Runs on `/app/*` behind nginx. Users manage their AI agents, configure LLM providers, connect channels, and browse the integration catalog from this dashboard.

## Pages

| Route | Description |
|---|---|
| `/app` | Dashboard home — agent overview and quick stats |
| `/app/agents` | Agent fleet list with status indicators |
| `/app/agents/[id]` | Agent detail with 7-tab interface |
| `/app/deploy` | Deploy a new agent (Docker, Proxmox, K8s) |
| `/app/marketplace` | Browse and install agent templates |
| `/app/workspaces` | Manage isolated workspaces |
| `/app/monitoring` | Real-time metrics via SSE |
| `/app/settings` | User profile, LLM provider keys, connected accounts |

## Agent Detail Tabs

Each agent's `/app/agents/[id]` page has 7 tabs:

- **Overview** — status, actions (start/stop/restart/redeploy), resource info
- **Terminal** — interactive xterm.js terminal via WebSocket
- **Logs** — real-time log streaming
- **OpenClaw** — 5 sub-panels: Chat, Files, Extensions, Gate (WS-RPC), Identity (Ed25519)
- **Channels** — manage 9 channel types with dynamic config forms
- **Integrations** — browse 60+ integrations with config modals
- **Settings** — agent config, danger zone

## Key Components

| Component | Purpose |
|---|---|
| `AgentTerminal.tsx` | xterm.js terminal with FitAddon, WebSocket |
| `TabBar.tsx` | 7-tab navigation bar |
| `OpenClawTab.tsx` | 5-panel OpenClaw interface |
| `ChannelsTab.tsx` | Channel CRUD with dynamic config forms |
| `IntegrationsTab.tsx` | Catalog browser with 17-category filter |
| `IntegrationCard.tsx` | Card with config modal for connecting |
| `LLMSetupWizard.tsx` | 3-step provider setup (select → configure → done) |
| `Layout.tsx` / `Sidebar.tsx` / `Topbar.tsx` | App shell layout |

## Development

```bash
# Runs automatically in Docker Compose with hot reload
docker compose logs -f frontend-dashboard

# Local development (outside Docker)
cd frontend-dashboard
npm install
npm run dev   # Starts on port 3001
```

## Configuration

| Variable | Default | Description |
|---|---|
| `basePath` | `/app` | Next.js base path, set in `next.config.ts` |
