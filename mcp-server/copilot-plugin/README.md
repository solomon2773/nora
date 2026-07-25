# Nora for GitHub Copilot CLI

This plugin connects GitHub Copilot CLI to a Nora control plane through the published `@noraai/mcp-server` package. Its MCP configuration is deliberately read-only: Copilot can inspect agents, fleet health, metrics, monitoring events, and cost, but it cannot deploy, start, stop, restart, redeploy, or delete agents.

## Prerequisites

- GitHub Copilot CLI with plugin support
- Node.js 24 or newer (required by the Nora CLI used for login)
- Access to a Nora deployment

## Configure Nora credentials

In Nora, open **Workspace → API Keys** and create a dedicated key with only these scopes:

- `agents:read`
- `monitoring:read`

Install the Nora CLI and save the deployment URL and key locally:

```bash
npm install -g @noraai/cli
nora login --host https://nora.example.com --token nora_xxxxxxxx
```

`nora login` stores the credentials in `~/.nora/config.json` with mode `0600`. The plugin does not contain or copy the key; the local MCP process reads the same Nora CLI configuration at runtime.

## Install the plugin

Install directly from the Nora repository:

```bash
copilot plugin install solomon2773/nora:mcp-server/copilot-plugin
```

For development from a Nora checkout:

```bash
copilot plugin install ./mcp-server/copilot-plugin
```

Confirm the plugin and MCP server are available:

```bash
copilot plugin list
copilot mcp get nora
```

## Available tools

The plugin exposes only the following tools:

| Tool                        | Required scope    |
| --------------------------- | ----------------- |
| `list_agents`               | `agents:read`     |
| `get_agent`                 | `agents:read`     |
| `get_agent_stats`           | `agents:read`     |
| `get_agent_versions`        | `agents:read`     |
| `get_platform_metrics`      | `monitoring:read` |
| `get_fleet_status`          | `monitoring:read` |
| `list_monitoring_events`    | `monitoring:read` |
| `get_agent_metrics`         | `monitoring:read` |
| `get_agent_metrics_summary` | `monitoring:read` |
| `get_agent_cost`            | `monitoring:read` |

The configuration pins `@noraai/mcp-server@0.1.4`, sets `NORA_MCP_ALLOW_DESTRUCTIVE=false`, and applies an explicit Copilot MCP tool allowlist. The scoped Nora key provides an additional server-side permission boundary.

## Updating

Update the installed plugin after this directory changes:

```bash
copilot plugin update nora
```

If the MCP package version changes, update `plugin.json`, `.mcp.json`, this README, and the parent `mcp-server/AGENTS.md` together, then repeat the local install and tool-discovery checks.

## Privacy

The MCP server runs locally. It sends authenticated requests directly to the Nora deployment configured by `nora login` and does not persist tool inputs or API responses. Never commit or paste a Nora API key into plugin files, issues, logs, or screenshots.
