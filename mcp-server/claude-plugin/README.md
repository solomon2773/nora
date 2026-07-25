# Nora for Claude Code

This plugin connects Claude Code to a Nora control plane through the published
`@noraai/mcp-server` package. It can inspect agents, fleet health, metrics,
monitoring events, and cost. Lifecycle tools are available only when the Nora
API key has `agents:write`; permanent deletion remains disabled.

## Prerequisites

- Claude Code 2.1.143 or newer
- Node.js 24 or newer (required by the Nora CLI used for login)
- Access to a Nora deployment

## Configure Nora credentials

For a read-only setup, open **Workspace → API Keys** in Nora and create a
dedicated key with only these scopes:

- `agents:read`
- `monitoring:read`

Install the Nora CLI and save the deployment URL and key locally:

```bash
npm install -g @noraai/cli
nora login --host https://nora.example.com --token nora_xxxxxxxx
```

`nora login` stores the credentials in `~/.nora/config.json` with mode `0600`.
The plugin does not contain or copy the key; its local MCP process reads the
same Nora CLI configuration at runtime. You may instead set `NORA_API_URL` and
`NORA_API_KEY` in the environment that starts Claude Code.

## Install from the community directory

After the plugin is listed in Claude's community directory:

```text
/plugin install nora@claude-community
```

Restart Claude Code after installation, then ask Claude to list your Nora
agents or inspect fleet health.

## Validate from a Nora checkout

```bash
claude plugin validate ./mcp-server/claude-plugin --strict
claude --plugin-dir ./mcp-server/claude-plugin
```

## Permissions and safety

The Nora API enforces workspace membership and API-key scopes server-side.
Use `agents:read` plus `monitoring:read` unless you intentionally want Claude
to perform lifecycle actions, in which case add `agents:write` to the dedicated
key. The plugin sets `NORA_MCP_ALLOW_DESTRUCTIVE=false`, so `delete_agent` is
not registered even with a write-capable key.

## Privacy

The MCP server runs locally and sends authenticated requests directly to the
Nora deployment you configure. It does not persist tool inputs or API
responses. Never commit or paste a Nora API key into plugin files, issues,
logs, or screenshots.
