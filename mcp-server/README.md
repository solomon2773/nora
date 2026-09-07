# @noraai/mcp-server

MCP server for [Nora](https://github.com/solomon2773/nora), the self-hosted AI agent ops platform. Connect Claude Code, Claude Desktop, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io) client to your Nora control plane and operate your agent fleet in natural language: deploy runtimes, start/stop/restart them, tail fleet status, and pull metrics, events, and per-agent cost.

```bash
claude mcp add nora \
  --env NORA_API_URL=https://nora.example.com \
  --env NORA_API_KEY=nora_xxxxxxxx \
  -- npx -y @noraai/mcp-server
```

The repository also ships a Claude Code plugin manifest under
[`claude-plugin/`](./claude-plugin). Validate and load it from a Nora checkout
with:

```bash
claude plugin validate ./mcp-server/claude-plugin --strict
claude --plugin-dir ./mcp-server/claude-plugin
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

### Docker

Build the same stdio server as a non-root container:

```bash
docker build -t nora-mcp ./mcp-server
docker run --rm -i \
  -e NORA_API_URL=https://nora.example.com \
  -e NORA_API_KEY=nora_xxxxxxxx \
  nora-mcp
```

MCP clients should keep stdin open and pass secrets through environment variables; the image does not persist credentials or other state.

## Auth

Uses Nora workspace API keys (create one under Workspace → API Keys). Scopes apply unchanged:

- `agents:read` + `monitoring:read` → read tools
- `agents:write` → deploy/lifecycle tools

Fallbacks: `NORA_HOST`/`NORA_TOKEN` env vars, then the Nora CLI's `~/.nora/config.json` — so after `nora login`, `nora mcp` (or plain `npx @noraai/mcp-server`) just works.

## Tools

Read: `list_agents`, `get_agent`, `get_agent_stats`, `get_agent_versions`, `get_platform_metrics`, `get_fleet_status`, `list_monitoring_events`, `get_agent_metrics`, `get_agent_metrics_summary`, `get_agent_cost`.

Write: `deploy_agent`, `start_agent`, `stop_agent`, `restart_agent`, `redeploy_agent` — and `delete_agent`, which is only registered when `NORA_MCP_ALLOW_DESTRUCTIVE=true`.

Tool output is the raw Nora REST JSON; the server is a pure API client and stores nothing.

Full guide: [docs.norafleet.ai/guides/mcp-server](https://docs.norafleet.ai/guides/mcp-server)

## Privacy Policy

The Nora MCP connector runs locally and does not collect telemetry or persist credentials, tool inputs, or API responses. It sends each tool request and the configured API key directly to the Nora deployment identified by `NORA_API_URL`; no separate connector service or advertising network receives that data.

The connector retains no data after its process exits. Your Nora operator controls the storage and retention of account, agent, log, metric, and integration data in that deployment, and connected providers may apply their own policies when Nora invokes them. See the full [Nora Privacy Policy](https://norafleet.ai/privacy) or contact [privacy@norafleet.ai](mailto:privacy@norafleet.ai).

## Contributing

From the repository root, run `npm run contributor:setup -- --scope mcp-server` once, then `npm run contributor:check -- mcp-server`. Keep tool schemas, safety annotations, README tool lists, and mocked transport tests synchronized with the public REST endpoints.

If Nora is useful to you, a ⭐ on the [GitHub repo](https://github.com/solomon2773/nora) helps other self-hosters find it.

## License

Apache-2.0
