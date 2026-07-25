<div align="center">
  <img src=".github/readme-assets/nora-logo.png" alt="Nora" width="112" height="112" />
  <h1>Nora</h1>
  <p><strong>Run OpenClaw and Hermes fleets on your own infrastructure — from one control plane.</strong></p>
</div>

<p align="center">
  <strong>OpenClaw + Hermes</strong>&nbsp;&nbsp;·&nbsp;&nbsp;
  <strong>Docker + Kubernetes GA</strong>&nbsp;&nbsp;·&nbsp;&nbsp;
  <strong>69 provider connections</strong>&nbsp;&nbsp;·&nbsp;&nbsp;
  <strong>Apache-2.0</strong>
</p>

<p align="center">
  <a href="https://github.com/solomon2773/nora"><img src="https://img.shields.io/badge/%E2%98%85-Star_Nora-f2d7a1?style=for-the-badge&amp;labelColor=071018" alt="Star Nora on GitHub" /></a>
  <a href="https://noradocs.solomontsao.com/quickstart"><img src="https://img.shields.io/badge/%E2%86%92-Quick_Start-8ae6ff?style=for-the-badge&amp;labelColor=071018" alt="Quick Start" /></a>
</p>

<p align="center">
  <a href="https://github.com/solomon2773/nora/releases"><img src="https://img.shields.io/github/v/release/solomon2773/nora?color=6d28d9&label=release" alt="Latest release" /></a>
  <a href="https://github.com/solomon2773/nora/actions/workflows/ci-quality.yml"><img src="https://img.shields.io/github/actions/workflow/status/solomon2773/nora/ci-quality.yml?branch=master&label=CI" alt="CI status" /></a>
  <a href="https://www.npmjs.com/package/@noraai/cli"><img src="https://img.shields.io/npm/v/%40noraai%2Fcli?label=%40noraai%2Fcli&color=cb3837" alt="@noraai/cli on npm" /></a>
  <a href="https://www.npmjs.com/package/@noraai/mcp-server"><img src="https://img.shields.io/npm/v/%40noraai%2Fmcp-server?label=%40noraai%2Fmcp-server&color=cb3837" alt="@noraai/mcp-server on npm" /></a>
</p>

<p align="center">
  <a href="https://noradocs.solomontsao.com">📚 Documentation</a> ·
  <a href="https://noradocs.solomontsao.com/self-hosting">Self-Hosting</a> ·
  <a href="https://noradocs.solomontsao.com/concepts/architecture">Architecture</a> ·
  <a href="https://noradocs.solomontsao.com/compare">How Nora Compares</a> ·
  <a href=".github/press-kit/README.md">Press Kit</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

<p align="center">
  <a href="https://nora.solomontsao.com/walkthrough.mp4">
    <img src=".github/readme-assets/walkthrough.gif" alt="Watch the Nora walkthrough" width="900" />
  </a>
</p>
<p align="center">
  <sub>▶ <b><a href="https://nora.solomontsao.com/walkthrough.mp4">Watch the walkthrough</a></b></sub>
</p>

## What Is Nora?

Nora is the self-hosted AI agent ops platform for running autonomous agent fleets on infrastructure you control — whether you standardize on OpenClaw, Hermes, or keep both available in the same operator surface.

Most teams running agents in production eventually rebuild the same layer around the runtime itself: deploy workflows, secrets, monitoring, logs, terminal, templates, and a separate admin surface. Nora exists so that layer doesn't have to be rewritten every time the runtime conversation changes. Operator workflows live under `/app`; platform-wide admin lives under `/admin`.

→ [Why Nora](https://noradocs.solomontsao.com/introduction#positioning-pillars) · [Runtime model](https://noradocs.solomontsao.com/concepts/runtimes) · [Deployment footprint](https://noradocs.solomontsao.com/concepts/architecture#deployment-topologies)

## Features

- **Deploy & operate runtimes** — provision OpenClaw and Hermes agents to Docker or Kubernetes (both GA, official Helm chart) with full lifecycle controls: deploy, start/stop, restart, redeploy, and version history.
- **Migrate existing runtimes** — recreate agents from uploaded bundles, with privileged local-Docker Live Pull available to self-hosted platform admins.
- **Live operator access** — streaming logs, an interactive terminal into running containers, a file browser/editor, and the OpenClaw gateway &amp; Hermes dashboard embedded in the operator UI.
- **Monitoring & alerting** — per-agent metrics and cost, a fleet needs-attention roll-up (errored, stuck, over-budget, stalled telemetry), and user-defined alert rules delivered to your channels.
- **Budgets & scheduled runs** — per-agent LLM budget hard caps with auto-pause, plus recurring cron schedules for agent runs with queue retries and sweep guards.
- **Secrets that fail closed by default** — provider keys are AES-256-GCM encrypted at rest and synced to running runtimes; production refuses to boot without a valid encryption key unless an operator deliberately enables the insecure plaintext override; SSH host-key pinning protects remote (BYOC) Docker hosts.
- **Network isolation** — baseline Kubernetes NetworkPolicy ingress isolation with admin-managed CIDR allow rules, and an experimental NemoClaw hardened sandbox for untrusted code.
- **Agent Hub** — installable, versioned starter templates to go from zero to a working agent fast.
- **Integrations** — a 69-entry credential/connectivity catalog (source control, chat, cloud, observability, vector DBs, automation) plus 17+ LLM providers. Executable behavior comes from runtime skills or MCP adapters; supported per-agent MCP servers are enabled explicitly.
- **Experimental Proxmox LXC** — deploy standard OpenClaw or a prepared Hermes image into unprivileged LXC with verified API TLS and pinned SSH. It is not VM-grade isolation and still requires the real-hardware smoke gate before production use.
- **Automate everything** — a public REST API (OpenAPI 3.1), the `@noraai/cli`, and the `@noraai/mcp-server` for Claude Code, Gemini CLI, Claude Desktop, and Cursor.
- **Workspaces & RBAC** — multi-tenant workspaces with ranked roles, a platform admin surface, account event history, and encrypted managed backups.

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src=".github/readme-assets/proof-operator-dashboard.png" alt="Operator dashboard" /><br />
      <sub><b>Operator dashboard</b></sub>
    </td>
    <td align="center" width="50%">
      <img src=".github/readme-assets/proof-operator-fleet.png" alt="Fleet monitoring" /><br />
      <sub><b>Fleet monitoring &amp; needs-attention triage</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src=".github/readme-assets/proof-operator-agent-detail.png" alt="Nora agent detail and operations view" /><br />
      <sub><b>Agent detail &amp; lifecycle operations</b></sub>
    </td>
    <td align="center" width="50%">
      <img src=".github/readme-assets/proof-operator-hermes-webui-tab.png" alt="Embedded Hermes WebUI" /><br />
      <sub><b>Hermes WebUI embedded in Nora</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src=".github/readme-assets/proof-operator-deploy-flow.png" alt="Agent deploy flow" /><br />
      <sub><b>Agent deploy flow</b></sub>
    </td>
  </tr>
</table>

## Quick Start

> **Requirements:** macOS 12+, Linux, or Windows 10+ (WSL2), with Docker Engine + Compose v2. The installer checks for Docker, Git, and OpenSSL and installs anything missing.

**macOS / Linux / WSL2:**

```bash
curl -fsSL https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh | bash
```

<details>
<summary><strong>Prefer to inspect the installer first?</strong></summary>

```bash
git clone https://github.com/solomon2773/nora.git
cd nora
less setup.sh
bash setup.sh
```

</details>

**Windows (PowerShell):**

```powershell
iwr -useb https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1 | iex
```

> **Windows requires [PowerShell 7+](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows).** The default Windows PowerShell 5.1 is not supported — run the command above from a `pwsh` 7 session.

**Kubernetes (Helm):**

```bash
helm show chart oci://ghcr.io/solomon2773/nora
```

The command resolves the latest published chart; pin the reported version for reproducible production installs. The public OCI chart installs the full Nora control plane. See the [Helm instructions](https://noradocs.solomontsao.com/self-hosting#kubernetes-helm) for the required secrets and Ingress options.

The installer verifies prerequisites, generates or preserves secrets, optionally creates a bootstrap admin, picks free local ports when the defaults are busy, and starts the stack. Once it finishes, open the URL printed by setup. Local mode defaults to `http://localhost:8080`, but setup may select another port such as `8081` on a busy workstation. Then follow the [first-15-minutes walkthrough](https://noradocs.solomontsao.com/quickstart).

> **No API key yet?** On installations with the local Docker target enabled, choose **Launch local Docker demo** on the Getting Started page. Nora deploys a working agent against its built-in deterministic demo provider, so you can validate chat and the operator workflow with zero keys and zero model-usage cost. Kubernetes-only installations start by adding a model provider and deploying to an enabled cluster target.

For manual setup, environment variables, public-domain mode, TLS, Remote Docker, Kubernetes, NemoClaw, and experimental Proxmox LXC configuration, see the docs:

- [Self-hosting guide](https://noradocs.solomontsao.com/self-hosting)
- [Environment variables reference](https://noradocs.solomontsao.com/configuration/environment-variables)
- [Provisioner backends](https://noradocs.solomontsao.com/configuration/provisioner-backends) (Docker and k3s/Kubernetes are GA; Remote Docker, NemoClaw, and Proxmox LXC are experimental)
- [Remote Docker BYOC setup](https://noradocs.solomontsao.com/guides/remote-docker) — SSH registration, private networking, validation, sharing, and recovery
- [TLS and public domains](https://noradocs.solomontsao.com/configuration/tls-domains)
- [Fronting a launch with Cloudflare](infra/cloudflare-launch.md) — edge caching, rate limiting, and spike absorption for the single-host deploy

## Documentation

Full docs live at **[noradocs.solomontsao.com](https://noradocs.solomontsao.com)**. The MDX source is in [`docs/`](./docs).

| Section                                                                        | What's there                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [Quick Start](https://noradocs.solomontsao.com/quickstart)                     | Install and validate your first agent in 15 minutes                                                    |
| [Concepts](https://noradocs.solomontsao.com/concepts/architecture)             | Architecture, agents, runtimes, workspaces, LLM providers, Agent Hub                                   |
| [Configuration](https://noradocs.solomontsao.com/configuration/platform-modes) | Platform modes, env vars, provisioner backends, TLS / public domains                                   |
| [Guides](https://noradocs.solomontsao.com/guides/deploy-agent)                 | Deploy agent, providers, integrations, channels, monitoring, alert rules, backups, Agent Hub, NemoClaw |
| [API Reference](https://noradocs.solomontsao.com/api/overview)                 | Auth, workspaces, agents, channels, integrations, providers, monitoring, alert rules                   |
| [Support](https://noradocs.solomontsao.com/support/faq)                        | FAQ, troubleshooting                                                                                   |

## Architecture

```text
Nginx
├── /           → frontend-marketing  (Next.js)
├── /app/*      → frontend-dashboard  (Next.js)
├── /admin/*    → admin-dashboard     (Next.js)
└── /api/*      → backend-api         (Express.js)
                       ├── PostgreSQL
                       ├── Redis + BullMQ  (deployments, clawhub-jobs, backups, alert-deliveries)
                       ├── worker-provisioner
                       ├── worker-backup
                       ├── deploy-target adapters  (Docker + k3s/k8s GA · Remote Docker + Proxmox experimental)
                       └── sandbox profiles        (standard · NemoClaw experimental)
```

Full architecture write-up — system map, queue/worker boundaries, RBAC, migration contract, deployment topologies — is in [docs/concepts/architecture](https://noradocs.solomontsao.com/concepts/architecture).

## Tech Stack

| Layer              | Technology                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Reverse proxy      | Nginx                                                                                          |
| Frontends          | Next.js 16, React 19, Tailwind CSS                                                             |
| Backend API        | Express.js 5, Node.js 24 LTS                                                                   |
| Auth               | JWT, HttpOnly cookies, bcryptjs, provider OAuth bridge                                         |
| Database           | PostgreSQL 15                                                                                  |
| Queue              | BullMQ + Redis 7                                                                               |
| Runtime families   | OpenClaw, Hermes                                                                               |
| Deployment targets | Docker and k3s/Kubernetes (GA); Remote Docker BYOC and Proxmox unprivileged LXC (experimental) |
| Sandbox profiles   | Standard; NemoClaw (experimental, not available on Proxmox)                                    |
| Secrets at rest    | AES-256-GCM (provider keys, integrations, backups)                                             |

## Public REST API, CLI, and MCP

Workspace-scoped API keys (bearer-only, prefixed `nora_`, HMAC-hashed at rest, scope-based) drive a stable subset of the REST surface. Issue keys at `/app/workspaces/<id>/api-keys`.

```bash
export NORA_TOKEN="nora_..."
curl -H "Authorization: Bearer $NORA_TOKEN" https://your-nora.example.com/api/agents
```

A small CLI lives in [`cli/`](./cli) (`@noraai/cli`): run `nora login` once to save your host and API token, then `nora workspaces`, `nora agents`, and `nora monitoring` wrap the same REST surface. `nora doctor` runs an admin-only control-plane health check, and `nora mcp` launches the MCP stdio server. See the [API reference](https://noradocs.solomontsao.com/api/overview) for the supported endpoints and scopes.

**Operate Nora from Claude Code, Gemini CLI, Claude Desktop, or Cursor:** the [`mcp-server/`](./mcp-server) package (`@noraai/mcp-server`) exposes the same API as [Model Context Protocol](https://modelcontextprotocol.io) tools — deploy agents, control their lifecycle, and read fleet metrics, events, and per-agent cost from any MCP client. Destructive deletion stays disabled unless explicitly opted in.

```bash
claude mcp add nora \
  --env NORA_API_URL=https://your-nora.example.com \
  --env NORA_API_KEY=nora_... \
  -- npx -y @noraai/mcp-server
```

Gemini CLI users can install the repository extension directly. The installer prompts for the Nora API URL and stores the workspace API key as a sensitive extension setting:

```bash
gemini extensions install https://github.com/solomon2773/nora
```

See the [MCP guide](https://noradocs.solomontsao.com/guides/mcp-server) for Gemini CLI, Claude Desktop, and Cursor configuration, the tool list, and security notes.

## Standards & isolation

- **MCP — shipped.** A control-plane [MCP](https://modelcontextprotocol.io) server (`@noraai/mcp-server`, published to the official [MCP Registry](https://github.com/modelcontextprotocol/registry)) plus per-agent MCP server management — operate the fleet from Claude Code, Gemini CLI, Claude Desktop, or Cursor, and wire MCP tools into individual agents.
- **OpenTelemetry GenAI — available.** [OTLP + Prometheus export](https://noradocs.solomontsao.com/guides/opentelemetry) of runtime telemetry under the `gen_ai.*` semantic conventions — per-exchange chat spans plus token/cost/resource metrics flow into the Grafana / Datadog / Langfuse stack you already run. (Per-tool-call sub-spans depend on runtime event streams and remain on the roadmap.)
- **A2A — on the roadmap.** Agent Cards / Agent-to-Agent discovery for managed OpenClaw and Hermes agents.
- **Isolation, per deploy target.** Standard Docker runs use container namespaces plus operator-set CPU and RAM limits; `disk_gb` is metadata and operators must monitor Docker storage. Kubernetes adds workload resource limits and provisioned storage requests. The experimental **NemoClaw** profile hardens untrusted code with a non-root user, all Linux capabilities dropped, `no-new-privileges`, Landlock + seccomp, and default-deny egress. Experimental Proxmox placement uses unprivileged LXC, which remains a shared-kernel boundary and is not presented as VM-grade isolation. See the [isolation model](https://noradocs.solomontsao.com/concepts/security#runtime-isolation).

## Roadmap

- **NemoClaw hardening** _(high priority)_ — mature the experimental secure-sandbox profile end to end: enablement, policy controls, approvals, telemetry, and validation.
- **Proxmox hardware qualification** — run the protected OpenClaw and prepared-Hermes lifecycle matrix on the exact node, storage, bridge, templates, and network before considering any beta label; until then the target remains Experimental.
- **Hermes/OpenClaw parity** — close runtime gaps across validation, logs, terminal access, monitoring, and failure reporting.
- **First-run operator UX** — a tighter path from install to the first deployed, validated agent.
- **Account-scoped monitoring** — account-level health roll-ups across workspaces, agents, cost, and alerts, with drill-downs.
- **Auth & key-sync hardening** — key rotation, audit trails, and recovery from partial sync failures.
- **Agent Hub ergonomics** — better template discovery, install/configure flows, and post-install validation.
- **A2A support** — Agent Cards / agent-to-agent discovery for managed runtimes.

## Development

```bash
# Docker (recommended)
docker compose up -d
docker compose logs -f backend-api

# Tests
cd backend-api && npx jest --no-watchman
cd e2e && npm test
```

Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) for contributor guidance. [`CLAUDE.md`](./CLAUDE.md) documents the repo layout, development commands, and subtree ownership for humans and AI coding agents alike.

## Contributing

New here? Browse [**good first issues**](https://github.com/solomon2773/nora/labels/good%20first%20issue) for small, self-contained starting points, then skim [CONTRIBUTING.md](./CONTRIBUTING.md).

Strong contribution areas: runtime adapter work · operator and admin UX · provisioning and lifecycle orchestration · integrations and channels · test and CI hardening · self-hosted deployment ergonomics.

Typical workflow: fork → branch (`feature/...`) → commit → pull request.

## Community

- [Issues](https://github.com/solomon2773/nora/issues)
- [Discussions](https://github.com/solomon2773/nora/discussions)
- [Hermes Agent](https://github.com/NousResearch/Hermes-Agent)
- [OpenClaw](https://github.com/openclaw/openclaw)

If Nora is useful to you, a ⭐ on the repo helps other self-hosters find it.

## License

This project is open source under the [Apache License 2.0](./LICENSE).
