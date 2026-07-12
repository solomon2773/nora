# Changelog

All notable changes to Nora are documented here. Each entry summarizes the
corresponding [GitHub release](https://github.com/solomon2773/nora/releases),
which carries the full notes and verification details.

## [v1.16.1](https://github.com/solomon2773/nora/releases/tag/v1.16.1) — 2026-07-12

Activation-reliability patch: the zero-key first proof now stays behind a final readiness
barrier, production deploys carry the hardened edge configuration forward, and Remote Docker
has a complete operator guide.

### Added

- Provisioner lifecycle regression coverage for guarded runtime metadata persistence,
  provider-state drift, restart ordering, readiness failure, and atomic deployment finalization.
- A Remote Docker backend guide covering registered SSH hosts, pinned host keys, runtime support,
  workspace sharing, networking, validation, and troubleshooting.

### Changed

- Provisioning persists runtime endpoints while the agent remains `deploying`, reconciles any
  in-flight provider changes, and publishes `running` / `completed` in one guarded transaction
  only after final readiness. Unchanged demo state skips the redundant restart entirely.
- Live OpenClaw auth sync applies auth, custom-provider, and default-model writes before one
  restart, with readiness as the final runtime operation.
- Production deploys refresh the host Docker socket GID, regenerate the ignored public nginx
  config from the tracked template, verify Docker API access from every socket-using service,
  and serve hardened browser headers plus short shared caching for the public homepage only.
- Release metadata advances the Gemini extension manifest to `1.16.1` and the Helm chart to
  `0.7.1` for exact-tag publication.

### Fixed

- The first chat after zero-key activation no longer races a post-deploy OpenClaw restart and
  returns a transient `502` after Nora has already advertised the agent as running.
- Built-in demo readiness failures now fail closed and retry instead of exposing an unreachable
  runtime through the recoverable-warning path.
- Proxmox now carries the worker-resolved per-agent MCP selection into OpenClaw bootstrap instead
  of silently dropping it, and rejects malformed template, storage, or bridge values during
  catalog preflight before a deployment can be queued.

## [v1.16.0](https://github.com/solomon2773/nora/releases/tag/v1.16.0) — 2026-07-12

Launch-readiness release: a deterministic first-run demo, safer production defaults,
clearer contributor paths, extension scaffolding, broader MCP discovery, and an
experimental Proxmox LXC backend with a protected real-hardware promotion gate.

### Added

- Contributor activation tooling: a Node 24 dev container, CODEOWNERS, structured issue
  and pull-request templates, support guidance, a single contributor check command, and
  tested scaffolds for new backend adapters and integration providers.
- MCP distribution and discovery for Claude Code, Gemini CLI, GitHub Copilot CLI, Glama,
  container users, and installable MCP bundles, alongside clearer CLI version and support
  metadata.
- Experimental Proxmox unprivileged-LXC lifecycle support for OpenClaw and prepared Hermes
  images, including create/start/stop/restart/delete, exec, logs, environment rotation,
  ownership markers, retry-safe VMID allocation, and a protected destructive hardware-smoke
  workflow. NemoClaw on Proxmox remains blocked.
- Transactional, checksummed database migrations; shared PostgreSQL/Redis connection
  normalization; expanded OpenAPI coverage; and stronger Helm availability and pod-security
  defaults.

### Changed

- The public site, auth entrypoints, docs, installer, and Getting Started flow now lead with
  a zero-key demo, real product proof, current release links, contribution paths, localized
  metadata, and an explicit post-install invitation to star the project.
- Proxmox is visible only as an Experimental target and fails closed unless API TLS, pinned
  SSH trust, templates, storage, and runtime prerequisites pass validation.
- Production Compose services use non-root/read-only defaults and file-backed secrets, while
  release upgrades and deploy automation validate exact product tags and materialize secrets
  before rebuilding.

### Fixed

- OpenClaw auth bootstrap normalizes custom-provider IDs in `auth-profiles.json` for pinned
  2026.4.x images and imports the same profiles into newer runtime auth stores, so the
  deterministic demo produces a real assistant response after activation.
- Gateway pooling coalesces concurrent cold connects and retires established or pending sockets
  when an endpoint is reused or a token rotates, preventing stale authenticated sessions.
- Session-upgrade tokens are verified before cookie migration; admin, workspace, API-key,
  WebSocket, integration, and backup paths apply stricter authorization and safer failure
  behavior.
- OpenClaw channel IDs reject prototype-sensitive object keys before gateway/config access,
  and development-tool lockfiles were refreshed to clear the repository's dependency alerts.
- Provisioning retries occupied Docker ports, cancels or cleans stale jobs safely, preserves
  runtime addresses across lifecycle operations, and fails closed when stop/delete cleanup
  cannot be proven. Ambiguous Proxmox create outcomes preserve the VMID and stop retries until an
  operator reconciles ownership instead of assuming a temporarily invisible LXC is absent.
- Integration connection checks, email transport, backup handling, migration startup,
  release metadata, and public navigation/activation E2E coverage were hardened against the
  failure cases found during the launch audit.

## [v1.15.0](https://github.com/solomon2773/nora/releases/tag/v1.15.0) — 2026-07-06

Reliability release: durability and honesty hardening across Kubernetes, Docker,
integrations, channels, the gateway, and the cost dashboard, plus durable OpenClaw
channel state.

### Added

- Durable OpenClaw channel configuration: token- and configuration-backed settings are
  persisted and reseeded on provision; QR-linked device sessions still need to be
  re-paired after a rebuild. (#263)

### Fixed

- Newly deployed or redeployed agents receive durable Docker and Kubernetes runtime
  storage; existing agents pick it up on their next redeploy. MCP now works on
  Kubernetes, and sensitive environment values use Secrets. (#261)
- Integration credential trust: definitive Twitter and LinkedIn OAuth rejections surface
  `needs_reconnect`, integration environment variables are projected into Kubernetes
  Deployments, and runtime-forward webhook failures return 503 so providers can retry.
  (#262)
- Kubernetes boot hardening: pinnable OpenClaw package, startup/readiness/liveness
  probes, and status recovery once a runtime is demonstrably live. (#265)
- Gateway reconnects re-resolve service DNS, new or replaced integrations receive
  non-blocking connectivity tests, and load-balancer waits produce actionable warnings.
  (#266)
- Cost dashboard honesty: budget alerts use each budget period, totals round once, and
  Anthropic cache tokens count toward usage. (#266)

### Changed

- Repository-wide Prettier/ESLint drift cleanup so the changed-files CI stays green.
  (#264, #267)

## [v1.14.2](https://github.com/solomon2773/nora/releases/tag/v1.14.2) — 2026-07-04

Patch release: OpenClaw ≥2026.6 auth fix for custom providers (Microsoft Foundry).

### Fixed

- OpenClaw ≥2026.6 agents using custom providers (Microsoft Foundry) no longer fail
  every turn with `missing-provider-auth`: API-key profiles now import into the
  per-agent SQLite auth store (previously skipped for Foundry), auth sync no longer
  uses `openclaw models set` (which canonicalized `azure-openai-responses/<deployment>`
  to an uncredentialed `openai/<deployment>` ref), and auth now survives Kubernetes
  pod rollouts instead of evaporating with exec-written files. (#260)

## [v1.14.1](https://github.com/solomon2773/nora/releases/tag/v1.14.1) — 2026-07-04

Docs-only patch: promo-ready README refresh.

### Changed

- README reordered for first-time visitors (What Is Nora → Features → Screenshots →
  Quick Start, with Standards & isolation moved below the API/CLI/MCP section), a
  scannable feature list covering scheduled runs, budget auto-pause, the fleet
  needs-attention roll-up, alert rules, Kubernetes NetworkPolicy isolation, and SSH
  host-key pinning, a screenshot grid, live release/CI/npm badges, a Quick Start
  requirements callout, and a tightened roadmap.

### Fixed

- Removed a broken README link to the untracked `AGENTS.md`; `CONTRIBUTING.md` is the
  contributor entry point.

## [v1.14.0](https://github.com/solomon2773/nora/releases/tag/v1.14.0) — 2026-07-02

Kubernetes network isolation, BYOC SSH hardening, new MCP fleet tools, and
approval-gated Echo social publishing.

### Added

- **Kubernetes NetworkPolicy isolation**: Nora-managed runtimes on Kubernetes now get
  baseline pod-level ingress isolation at provisioning time, with admin tooling to
  inspect and manage custom ingress CIDR allow rules on registered clusters. (#240)
- **SSH host-key pinning for BYOC remote backends**: trust-on-first-use pinning with
  enforcement on every connect across the remote Docker, Hermes, and NemoClaw paths;
  a key mismatch surfaces a clear possible-MITM connection-test failure. (#241)
- **MCP fleet tools**: new read-only `get_fleet_status` and `get_agent_stats` tools
  expose the fleet needs-attention roll-up and per-agent resource/execution stats to
  MCP clients. (#242, #236)
- **Approval-gated Echo social publishing**: the Echo template moves from draft-only
  to approval-gated publishing for original X/LinkedIn posts, including LinkedIn share
  posting through the integration tool. (#243)

### Changed

- The supply-chain workflow no longer uploads container CVE reports to GitHub code
  scanning; Trivy/Syft evidence stays available as workflow artifacts.

### Fixed

- Gateway port reservation no longer fails with an ambiguous `generate_series`
  overload during Echo deploys; placeholders are cast before the query. (#244)
- OpenClaw API-key auth profiles now import into the per-agent SQLite auth store (and
  the legacy JSON file) across live auth sync plus Docker, Kubernetes, NemoClaw, and
  Proxmox startup paths. (#245)
- Microsoft Foundry saved model values normalize to OpenClaw's
  `azure-openai-responses` provider id, including legacy `openai/<deployment>`
  values, in both auth sync and post-deploy reconciliation. (#246)

## [v1.13.0](https://github.com/solomon2773/nora/releases/tag/v1.13.0) — 2026-06-23

Scheduled agent operations, production-ready NemoClaw placement, GenAI observability,
and stronger release supply-chain evidence.

### Added

- **Scheduled agent runs**: operators can create recurring cron schedules for agents,
  trigger them through the control plane, and manage schedules from the agent detail
  page. The scheduler includes queue retries, paused-agent skipping, sweep guards, and
  OpenAPI/docs coverage. (#239)
- **OpenTelemetry GenAI export**: backend spans and metrics now emit `gen_ai.*`
  telemetry with bounded attributes, fail-open startup behavior, and documentation for
  collector setup. (#233)
- **Supply-chain image evidence**: CI now publishes per-image Trivy reports and Syft
  SBOMs in a non-blocking supply-chain workflow. (#234)

### Changed

- **NemoClaw production readiness**: NemoClaw now ships as a GHCR image and can be used
  through remote NemoClaw and Kubernetes placement paths with CVE-patched bases, updated
  backend catalog handling, setup/docs coverage, and real deploy-matrix smoke support.
  (#238)
- Launch and security docs now surface the MCP/A2A/OTel story and the current isolation
  model on the first-screen adoption path. (#232)

### Fixed

- Shortened MCP Registry metadata so registry validation stays within the current
  description-length limit.
- Hardened scheduled Hermes runs against SSRF-relevant URL handling and improved retry
  and sweep behavior for scheduled enqueue paths. (#239)

## [v1.12.0](https://github.com/solomon2773/nora/releases/tag/v1.12.0) — 2026-06-21

Remote-host/BYOC expansion, adopted runtime operations, stronger runtime/gateway security,
and release/discovery automation across npm and the MCP Registry.

### Added

- **BYOC Remote Hosts**: operator and admin surfaces, owner-scoped backend routes, remote-Docker target registration, SSH-backed Docker adapter, remote deploy picker, and deploy/rollback/restore validation for registered remote targets. (#193–#203)
- **Remote Hermes and gateway port management**: Hermes can deploy to remote hosts; gateway ports are allocated per host, released on delete, and published/persisted for dashboard/runtime reachability. (#204–#206, #209)
- **Adopt existing runtimes**: operators can adopt OpenClaw/Hermes runtimes by URL and token, reconcile health, and operate adopted external runtimes from the dashboard and deploy flow. (#214, #223, #224, #226)
- **Workspace sharing for remote hosts**: remote hosts can be shared into workspaces through fail-closed backend grants and a dashboard UI. (#227, #228)
- **MCP Registry and npm release automation**: package scope moved to `@noraai`, npm release publishing is wired to GitHub releases, and the MCP server can be listed through the official MCP Registry workflow. (#187, #192, #211)

### Changed

- Agent Hub/OpenClaw channel docs and templates now reflect the live channel surface, with refreshed channel screenshot proof and real-channel smoke coverage.
- Public README, support, contribution, CLI, API, and operator docs were reconciled with the current v1.12 codebase and launch contributor flow. (#189, #190, #213)
- CLI table rendering now uses a shared helper covered by unit tests. (#225)

### Fixed

- Agent runtime sidecar routes now require bearer-token authentication when a gateway token is provisioned. (#191)
- Embed, asset, RPC-pool, and WebSocket relay gateway paths now enforce SSRF-relevant host allowlists for local and remote runtime surfaces. (#199, #202, #207, #208)
- Agent gateway tokens are encrypted at rest with AES-256-GCM. (#229)
- Patched high/moderate advisories in esbuild, form-data, protobufjs, and nodemailer. (#188, #210, #212, #231)
- Stabilized the recurring signup-heading E2E flake. (#230)

## [v1.11.0](https://github.com/solomon2773/nora/releases/tag/v1.11.0) — 2026-06-12

The pre-launch feature release: nine capabilities identified by the 2026-06 competitive research, shipped as PRs #177–#186.

### Added

- **Control-plane MCP server** (`@noraai/mcp-server` + `nora mcp` CLI alias): operate Nora from Claude Code or any MCP client — 13 tools covering agent lifecycle, metrics, events, and cost, authenticated with existing scoped `nora_` API keys; `delete_agent` gated behind `NORA_MCP_ALLOW_DESTRUCTIVE=true`. (#177)
- **Official Helm chart** (`infra/helm/nora`): full control plane on Kubernetes with optional in-chart PostgreSQL/Redis (external toggles), fail-fast secrets, Ingress support, DB-readiness init containers, and a CI-drift-guarded vendored schema. (#178)
- **Per-agent LLM budget hard caps with auto-pause**: soft thresholds emit alert events; crossing 100% stops the runtime (`status=stopped` + `paused_reason=budget_exceeded`) with sweep re-enforcement against the status reconciler; budget editor and paused-banner in the dashboard. (#180)
- **Fleet needs-attention roll-up**: `GET /monitoring/fleet-status` returns only the agents needing operator action with reasons (errored, budget-paused, stuck deploying, approaching budget, stalled telemetry); triage strip on the dashboard. (#181)
- **`nora doctor` + admin Health panel**: one-shot control-plane self-check (database, queue + DLQ, Kubernetes targets, secret posture, fleet health, gateway exposure) via CLI (`--json`, non-zero exit on failure), `GET /admin/doctor`, and an admin dashboard page. The `cli` package joined the CI quality/security matrices. (#182)
- **Per-agent MCP server management**: expose a connected integration (GitLab, Notion, Stripe, Supabase) to an agent as a stdio MCP server spawned by the OpenClaw runtime with the integration's own credentials; toggles in the agent Integrations tab. (#183)
- **First-admin claim flow**: public `GET /auth/bootstrap-status` and a "Claim this server" signup mode while the instance has zero users. (#184)
- **Zero-key demo agent**: one click on Getting Started deploys a chattable agent against a built-in deterministic OpenAI-compatible stub served by the control plane — no provider key required. (#185)
- **OpenAPI 3.1 spec + interactive reference**: every instance serves `GET /api/api.json` and `/api/api-docs` (Scalar); tier-1 coverage (agents, budgets, monitoring, LLM providers, auth) is drift-tested in CI against the actual routers. (#186)

### Changed

- Dev-mode generated JWT secrets are persisted in the database so sessions survive restarts. (#184)
- The docker adapter honors the user's explicit default LLM provider when setting the runtime's default model, instead of env-map order. (#185)
- `npm audit` advisories patched in `@grpc/grpc-js` (backend-api, workers/provisioner). (#179)

### Fixed

- Agent runtime sidecar no longer crashes with `MODULE_NOT_FOUND` on newly deployed agents (runtime bundle now ships every relatively-required module, with a CI closure test). (#185)

### Breaking

- **Production now refuses to boot with weak secrets**: a missing/placeholder `JWT_SECRET` or a missing/invalid `ENCRYPTION_KEY` is fatal when `NODE_ENV=production`. Installs that ran without a valid `ENCRYPTION_KEY` must set one (64-char hex) or explicitly opt out with `NORA_ALLOW_PLAINTEXT_SECRETS=true`. (#184)

## [v1.10.1](https://github.com/solomon2773/nora/releases/tag/v1.10.1) — 2026-06-11

- Clarified the supported runtime and deploy-target matrix across README, docs, dashboard, marketing copy, and setup prompts.
- Marked Proxmox as release-blocked/planned rather than currently supported; NemoClaw repositioned as an experimental sandbox profile.
- Backend support tests now enforce the documented Proxmox release gate.

## [v1.10.0](https://github.com/solomon2773/nora/releases/tag/v1.10.0) — 2026-06-08

- Hardened public signup: signup-specific burst and daily rate limits, duplicate-email short-circuiting before bcrypt, and safe duplicate responses.
- Optional Cloudflare Turnstile and Google reCAPTCHA bot protection on signup with server-side challenge verification.
- Documented the new signup abuse-protection settings in `.env.example` and the docs.

## [v1.9.2](https://github.com/solomon2773/nora/releases/tag/v1.9.2) — 2026-06-08

- Backend 5xx responses route through the central error handler instead of leaking raw exception text.
- Patched moderate dependency advisories (`ws`, `qs`); affected package audits back to zero vulnerabilities.
- Public-edge nginx hardening: auth/API rate-limit zones, worker tuning, Cloudflare real-IP guidance, and a launch-day runbook.
- Corrected NemoClaw setup docs (`ENABLED_SANDBOX_PROFILES=nemoclaw` + `NVIDIA_API_KEY`).

## [v1.9.1](https://github.com/solomon2773/nora/releases/tag/v1.9.1) — 2026-06-07

- Public-launch polish: homepage release badge, README tech-stack metadata, agent-runtime email polling init/reset logging fixes.

## [v1.9.0](https://github.com/solomon2773/nora/releases/tag/v1.9.0) — 2026-06-06

- Hermes runtime bootstrap support for managed environment variables and model configuration.
- Improved OpenClaw, Hermes, and Microsoft Foundry provider handling, including custom provider keys and deployment-specific Foundry models.
- Kubernetes runtime updates apply environment patches during provisioning; Docker runtime recovery improved.
- Refreshed documentation proof assets across operator, admin, and provisioning experiences.

## [v1.8.0](https://github.com/solomon2773/nora/releases/tag/v1.8.0) — 2026-06-04

- ClawHub skill deletion and drift reconciliation: view installed skills, delete from the dashboard, and surface runtime-only skills as orphaned drift.
- Actionable Kubernetes kubeconfig failure guidance.
- OpenClaw chat and tab UI polish.

## [v1.7.0](https://github.com/solomon2773/nora/releases/tag/v1.7.0) — 2026-05-26

- Kubernetes provisioning support across backend workers, admin UI, compose config, and smoke scripts for k3s, Kind, AKS, EKS, and GKE.
- WeCom integration with backend activation flow, catalog entries, and setup docs.
- Workspace cost visibility improvements and broader Agent Hub templates.

## [v1.6.1](https://github.com/solomon2773/nora/releases/tag/v1.6.1) — 2026-05-17

- Microsoft Foundry (Azure OpenAI) as a first-class LLM provider, wired from the setup wizard through OpenClaw custom-provider resolution.

## [v1.6.0](https://github.com/solomon2773/nora/releases/tag/v1.6.0) — 2026-05-16

- Email IMAP/SMTP integration with provider presets, live connection testing, optional reminder cron, and two-way sync.
- K3s as a first-class Kubernetes provisioner backend.
- Operator-runnable smoke harness covering K3s, AKS, EKS, and GKE.

## [v1.5.1](https://github.com/solomon2773/nora/releases/tag/v1.5.1) — 2026-05-10

- AKS/EKS/GKE Docker Compose overlays for managed Kubernetes provisioning.
- Hardened WebSocket access control on live exec/log/metrics streams.
- Provisioner-backend docs reorganized into per-backend pages.

## [v1.5.0](https://github.com/solomon2773/nora/releases/tag/v1.5.0) — 2026-05-10

- Integrations module reshaped around a Provider strategy pattern: 69 providers as discrete strategy files with unit tests, replacing the legacy 1,435-line adapter.
- Full set of per-provider operator docs.

## [v1.4.1](https://github.com/solomon2773/nora/releases/tag/v1.4.1) — 2026-05-08

- LinkedIn integration; Twitter/X (and any OAuth2) tokens auto-refresh on demand.
- Integrations subsystem restructured as a feature module behind a thin re-export shim.

## [v1.4.0](https://github.com/solomon2773/nora/releases/tag/v1.4.0) — 2026-05-07

- Public documentation site at [noradocs.solomontsao.com](https://noradocs.solomontsao.com).
- Workspace operator console: API keys, cost, members.
- Webhook alert delivery with retries; scheduled encrypted backups; internationalization; Twitter OAuth.

## [v1.3.1](https://github.com/solomon2773/nora/releases/tag/v1.3.1) — 2026-05-01

- Self-healing Hermes embed proxy for surrogate-corrupted runtime configs (fixes a production 500 on the embed config endpoint).

## [v1.3.0](https://github.com/solomon2773/nora/releases/tag/v1.3.0) — 2026-05-01

- First-class K3s flow in the provisioner backend with expanded installer paths.
- Agent Hub API keys: issue, rotate, and revoke per-tenant keys with scoped middleware.
- Control-plane-minted Hermes embed sessions.

## [v1.2.0](https://github.com/solomon2773/nora/releases/tag/v1.2.0) — 2026-04-27

- Admin one-click release upgrade with a Docker-based job runner, persistent job state, and live logs.
- Token-validated access control for proxied agent assets.
- Worker provisioner image self-containment (no brittle bind mounts on fresh hosts).

## [v1.1.0](https://github.com/solomon2773/nora/releases/tag/v1.1.0) — 2026-04-26

- Agent Hub: Platform Presets, Community listings, My Listings, and centralized sharing flows.
- ClawHub skill browsing and deployment; richer OpenClaw channel/runtime controls; Hermes dashboard integration.
- Imported agent files, migration tooling, secret overrides, and stronger session/security protections.

## [v1.0.0](https://github.com/solomon2773/nora/releases/tag/v1.0.0) — 2026-04-12

- Full operator surface for OpenClaw: deploy agents, validate gateway health, chat with the runtime, inspect logs and terminal output, manage integrations, schedule cron jobs, and open the embedded OpenClaw UI from the dashboard.
