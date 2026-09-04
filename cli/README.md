# `@noraai/cli`

Command-line interface for [Nora](https://github.com/solomon2773/nora). Talks to the public REST API exposed by every Nora installation.

## Install

```bash
npm install -g @noraai/cli
# or run without installing
npx @noraai/cli --help
```

Requires Node.js 24 or newer.

## First run

```bash
# 1. Mint an API key in the dashboard at /app/workspaces/<id>/api-keys
# 2. Tell the CLI where Nora lives and which token to use:
nora login --host https://nora.example.com --token nora_xxxxxxxx

# 3. Optionally pin a default workspace:
nora workspaces list
nora workspaces use <workspace-id>
```

Credentials are stored at `~/.nora/config.json` (mode 0600). `NORA_HOST`, `NORA_TOKEN`, and `NORA_WORKSPACE_ID` env vars override the on-disk config — use them in CI.

## Commands

```text
nora workspaces list             # workspaces you can access (with role)
nora workspaces list --json      # machine-readable workspace list
nora workspaces use <id>         # set active workspace
nora workspaces show             # print active workspace id

nora agents list                 # agents in the workspace
nora agents list --json          # machine-readable agent list
nora agents get <id>             # full JSON for one agent
nora agents start  <id>
nora agents stop   <id>
nora agents restart <id>
nora agents redeploy <id>
nora agents versions <id>        # configuration history
nora agents rollback <id> <vid>  # restore a prior version

nora monitoring metrics          # current metrics
nora monitoring metrics --json   # machine-readable metrics
nora monitoring events --limit 50
nora monitoring events --type agent_deleted --search backup --from 2026-08-01 --to 2026-08-20
nora monitoring events --json    # machine-readable events
nora monitoring tail --interval 5000

nora doctor                      # control-plane health check (needs an admin API key)
nora doctor --json               # machine-readable report; exit 2 when overall=fail
nora doctor --fresh              # force a recompute (bypass any cached report)

nora mcp                         # run the Nora MCP server on stdio for Claude Code/Desktop/Cursor
nora mcp --allow-destructive     # enable the MCP server's destructive tools
nora --version                   # print the installed CLI version
```

## Scopes

The token must carry the matching scope for the operation:

| Operation                                     | Required scope    |
| --------------------------------------------- | ----------------- |
| `agents list/get`                             | `agents:read`     |
| `agents start/stop/restart/redeploy/rollback` | `agents:write`    |
| `workspaces list/show/use`                    | `workspaces:read` |
| `monitoring *`                                | `monitoring:read` |

`nora doctor` needs an API key whose issuing user is a platform admin — it calls `GET /api/admin/doctor` behind `requireAdmin`, and on HTTP 403 it prints an admin-key error and exits 1.

`nora mcp` forwards the host/token from `nora login` (`~/.nora/config.json`) to the `@noraai/mcp-server` child as `NORA_API_URL` / `NORA_API_KEY`; `--allow-destructive` sets `NORA_MCP_ALLOW_DESTRUCTIVE=true`, so the MCP server's own scope/tool requirements apply.

Issuing API keys, mutating workspace membership, and other privileged flows require session authentication and are not available through the CLI.

## Contributing

From the repository root, run `npm run contributor:setup -- --scope cli` once, then `npm run contributor:check -- cli` before opening a pull request. CLI changes should keep command help, token-scope documentation, and mocked Node tests aligned with the public REST API.

## Support Nora

If Nora is useful to you, consider starring the [GitHub repository](https://github.com/solomon2773/nora). It helps other operators discover the project.

## License

Apache-2.0.
