# @noraai/mcp-server

MCP server for [Nora](https://github.com/solomon2773/nora), the self-hosted AI agent ops platform. Connect Claude Code, Claude Desktop, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io) client to your Nora control plane and operate your agent fleet in natural language: deploy runtimes, start/stop/restart them, tail fleet status, and pull metrics, events, and per-agent cost.

```bash
claude mcp add nora \
  --env NORA_API_URL=https://nora.example.com \
  --env NORA_API_KEY=nora_xxxxxxxx \
  -- npx -y @noraai/mcp-server
```

Or in any MCP client's JSON config:

```json
{
  "mcpServers": {
    "nora": {
      "command": "npx",
      "args": ["-y", "@noraai/mcp-server"],
      "env": {
        "NORA_API_URL": "https://nora.example.com",
        "NORA_API_KEY": "nora_xxxxxxxx"
      }
    }
  }
}
```

## Auth

Uses Nora workspace API keys (create one under Workspace → API Keys). Scopes apply unchanged:

- `agents:read` + `monitoring:read` → read tools
- `agents:write` → deploy/lifecycle tools

Fallbacks: `NORA_HOST`/`NORA_TOKEN` env vars, then the Nora CLI's `~/.nora/config.json` — so after `nora login`, `nora mcp` (or plain `npx @noraai/mcp-server`) just works.

## Tools

Read: `list_agents`, `get_agent`, `get_agent_versions`, `get_platform_metrics`, `get_fleet_status`, `list_monitoring_events`, `get_agent_metrics`, `get_agent_metrics_summary`, `get_agent_cost`.

Write: `deploy_agent`, `start_agent`, `stop_agent`, `restart_agent`, `redeploy_agent` — and `delete_agent`, which is only registered when `NORA_MCP_ALLOW_DESTRUCTIVE=true`.

Tool output is the raw Nora REST JSON; the server is a pure API client and stores nothing.

Full guide: [noradocs.solomontsao.com/guides/mcp-server](https://noradocs.solomontsao.com/guides/mcp-server)

## License

Apache-2.0
