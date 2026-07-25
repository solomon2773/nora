# Changelog

All notable changes to Nora are documented here. Each entry summarizes the
corresponding [GitHub release](https://github.com/solomon2773/nora/releases),
which carries the full notes and verification details.

## [v1.16.6](https://github.com/solomon2773/nora/releases/tag/v1.16.6) — 2026-07-24

Terminal/Logs connectivity, Hermes dashboard access, and CI/dependency hardening patch: agent
terminal and log streaming reach the runtime again for every agent, the Hermes Web UI authenticates
on the hardened image, and advisory auditing moves off the per-pull-request gate so a newly published
upstream advisory no longer blocks unrelated changes.

### Added

- The Hermes dashboard now authenticates via HTTP basic-auth, so its Web UI works on the hardened
  image instead of being unreachable.
- Local Docker Hermes agents can now be reached through an external connect flow.
- `nora workspaces list --json` emits machine-readable output for operator automation and scripting.

### Changed

- Agent gateway global and mutation rate-limit caps are now environment-configurable
  (`GLOBAL_RATE_LIMIT_MAX` / `GLOBAL_RATE_LIMIT_WINDOW_MS`, `MUTATION_RATE_LIMIT_MAX` /
  `MUTATION_RATE_LIMIT_WINDOW_MS`), so single-source-IP deployments — CI and browser E2E behind one
  localhost address, or a shared reverse proxy — no longer self-throttle into HTTP 429 cascades.
  Production defaults are unchanged at 1000 requests per 15 minutes and 60 mutations per minute per
  IP.
- npm advisory auditing now runs as a daily scheduled sweep with Dependabot remediation instead of a
  per-pull-request blocking check. Because `npm audit` resolves against the live advisory database,
  an unrelated newly published advisory no longer fails every open pull request; the blocking
  Security gate retains the deterministic sensitive-config scan, license-policy, and infra-validation
  checks.
- Backend unit-test coverage expands to the audit-source and API-token helpers, and the integrations
  documentation index now links the existing per-provider guides.
- Release metadata advances the Gemini extension manifest to `1.16.6` and the Helm chart to `0.7.6`
  with application version `1.16.6`.

### Fixed

- Agent Terminal and Logs now connect to the runtime. The nginx `/api/ws/` location used a variable
  `proxy_pass` that does not append the matched location remainder, so `/api/ws/exec/{id}` and
  `/api/ws/logs/{id}` reached the backend as a bare `/ws/` and matched no upgrade handler; the
  WebSocket upgrade hung and surfaced as `--- Session ended ---` in the Terminal and
  `Waiting for logs...` in Logs. The full `/ws/...` path is now reconstructed with a regex capture
  and applied to both the local and E2E nginx configurations. This affected every agent, not only
  Hermes.
- The provisioner worker now resolves backend adapters from `/app/backends` in the production image
  instead of failing to locate them.
- Hermes Docker deployment no longer fails after its readiness probe times out, and the fix is
  ported to the Kubernetes backend.
- High-severity npm advisories are cleared across services, including the `postcss` path-traversal
  advisories reached transitively through `sanitize-html` in `agent-runtime` and through the build
  toolchain in the dashboards.

## [v1.16.5](https://github.com/solomon2773/nora/releases/tag/v1.16.5) — 2026-07-19

Activation, Remote Docker administration, extension safety, and operator-readiness patch: the
first-run path is browser-proven, configured bootstrap credentials fail closed, deployment targets
cannot silently fall back to local Docker, and release/deploy automation preserves exact commit
provenance.

### Added

- Self-hosted platform admins can now register and manage control-plane-owned Remote Docker hosts
  from Admin, including connection testing, configuration and masked credential updates, enablement,
  guarded SSH host-key reset, and confirmation-gated deletion. Personal/operator hosts remain masked
  and read-only in the Admin fleet, while platform hosts survive deletion of the admin who created
  them.
- Platform hosts start restricted and can grant access to all accounts, direct users, reusable
  admin-managed user groups, or workspaces. Admin now includes user-group create, rename, delete, and
  versioned membership management; workspace viewers can see granted hosts while editors and above
  can deploy, and version checks prevent concurrent access edits from silently overwriting one
  another.
- Browser E2E coverage now proves signup, HttpOnly cookie handoff, Getting Started demo activation,
  worker-backed deployment, running state, and the first rendered OpenClaw chat response in one
  operator journey.
- External Issues, ready-for-review pull requests, and Discussions receive a least-privilege queue
  acknowledgement; drafts enter the queue only when marked ready, and a scheduled audit reminds the
  maintainer at day twelve and fails visibly when an open thread exceeds the fourteen-day
  human-response target.
- A task-oriented Remote Docker guide now provides the shortest path from private-network and SSH
  prerequisites through registration, host-key pinning, deployment, lifecycle validation, and
  troubleshooting, while linking to the complete backend security and recovery reference.

### Changed

- Bootstrap-admin validation is aligned across the backend, Bash installer, and PowerShell
  installer. Password input is hidden, malformed/placeholder email and placeholder/default-derived
  passwords are rejected, Compose-sensitive password characters round-trip literally, and an
  invalid configured account on an empty database stops startup before the API listener binds.
  Hosted PaaS now also requires explicit bootstrap credentials and cannot expose public first-admin
  claim; self-hosted operators may still leave both values blank for the local claim flow.
- Hosted PaaS signup now fails closed unless Turnstile or reCAPTCHA is fully configured; self-hosted
  operators retain the explicit `none` option alongside burst and daily signup limits.
- Production deploys now skip automatic publication for untagged commits, require version overrides
  to point at the exact target commit, revalidate release/default-branch provenance after environment
  approval and on the remote host, check out the immutable CI-validated commit rather than a branch
  that can advance during approval, and base64-transport remote configuration instead of embedding
  repository/environment values in a shell command.
- PaaS production deploys now refuse to rebuild the stack unless the selected Turnstile or reCAPTCHA
  provider has both its public site key and server secret. The public homepage keeps strict browser
  revalidation while publishing a separate five-minute, homepage-only Cloudflare edge-cache policy;
  authenticated, signup, dashboard, and API routes remain dynamic.
- Docker image publication now runs the CI gate from the immutable workflow commit, builds only the
  resolved target SHA, and derives the `sha-*` image tag plus OCI revision label from that same
  commit instead of a moving ref or workflow-event SHA. `latest` moves only in a non-cancelable,
  globally serialized promotion job that rechecks the current default-branch head after immutable
  publication completes. Registry write permission is limited to the publish/promotion jobs and the
  target must remain on protected default-branch history.
- Trusted CodeQL runs now evaluate the exact commit analysis artifact and fail on every
  non-dismissed high or critical result, even if the default branch advances and later fixes the
  finding before the gate finishes.
- The root Apache-2.0 license text is restored to the canonical form so repository hosts and
  compliance tooling can identify it reliably; project attribution now lives in `NOTICE`.
- npm, Helm, and MCP Registry publication now resolve one stable published product tag, require its
  immutable commit on protected default-branch history, wait for exact-SHA CI, and revalidate after
  protected-environment approval. Privileged jobs consume validated artifacts instead of executing
  release-target code; downloaded kubeconform and MCP publisher assets are verified against pinned
  checksum manifests before execution.
- The protected Proxmox hardware gate now requires an exact OpenClaw package version, verifies
  template SHA256 values before and after the lifecycle smoke, and emits a nonsecret qualification
  artifact containing the candidate, PVE/target tuple, cell results, and cleanup evidence.
- Backend adapter scaffolds fail explicitly for lifecycle, telemetry, logs, and exec operations;
  extension validation and CI now cover provider strategy registration, tests, docs navigation, and
  the complete nine-method adapter contract.
- The platform-host Admin flow is self-hosted-only and fails closed until `/api/config/platform`
  verifies `selfhosted`. PaaS or unverified Admin pages hide credential and mutation controls, while
  hosted-mode APIs reject Remote Docker registration and management. Durable lifecycle work resolves
  credentials from the persisted agent owner rather than the admin or collaborator initiating an
  operation.
- Worker images cache bounded backend dependency installs before source copies, Cloudflare launch
  guidance now documents the exact cache/security rollout checks, and Mintlify metadata, exclusions,
  and SEO configuration are aligned with the current public docs surface.
- The quickstart reflects the current runtime/target/sandbox and optional OpenClaw skills flow.
- Release metadata advances the Gemini extension manifest to `1.16.5` and the Helm chart to `0.7.5`
  with application version `1.16.5`.

### Fixed

- External runtime adoption now rejects short, oversized, whitespace-bearing, or control-bearing
  gateway credentials before storage and rechecks legacy adopted rows before gateway use. In-memory
  connection-pool keys contain only the agent and logical endpoint, while credential rotation is
  detected with constant-time comparison instead of hashing the credential into the key.
  Paired-device derivation remains protocol-compatible with existing managed runtimes.
- Nonempty unknown runtime families, deploy targets, execution-target ids, and sandbox profiles now
  fail with a stable client error across shared runtime fields, deploy/redeploy paths, Agent Hub
  templates, and the provisioner instead of being normalized to OpenClaw, local Docker, or the
  standard sandbox. Contradictory target/id tuples and unsupported runtime/sandbox combinations are
  terminal worker errors; legacy Hermes and NemoClaw metadata remains on its explicit compatibility
  path.
- Workspace API keys now remain inside their exact workspace across agent lists and mutations,
  gateway, NemoClaw, ClawHub, monitoring, event, and cost surfaces. New non-Remote agents are
  atomically assigned to the key workspace; agent export/live-filesystem access, Remote Docker
  operations, migration drafts, demo activation, user-global LLM-provider credentials, and platform
  performance records are session-only. Explicit API credentials take precedence over ambient
  cookies, and conflicting explicit headers fail before authentication instead of inheriting a
  broader session. Keys also fail authentication once their issuer is deleted or no longer belongs
  to the bound workspace.
- Demo activation now reuses only a durably marked agent on the exact OpenClaw/local-Docker/standard
  tuple. Duplicate, migration, backup, and Agent Hub portability paths strip the internal activation
  marker so a copied agent cannot be destroyed or requeued as the user's built-in demo.
- Unregistered integration strategies no longer report successful credential verification or
  silently omit runtime environment variables; stale catalog/deployment mismatches fail closed.
- Proxmox host commands now validate executable and sudo tokens and quote every SSH argument, closing
  command-injection paths through `PROXMOX_PCT_COMMAND` and `PROXMOX_SUDO`. Proxmox remains
  experimental until the protected real-hardware lifecycle gate passes with trusted TLS/SSH and a
  verified template.
- Non-root Proxmox targets now remain unavailable unless an absolute operator-installed offline
  staging helper is configured. Both installers preserve that setting, the protected hardware gate
  forwards and validates it, and the public reference documents the helper input contract, prepared
  Hermes template checks, and the explicit lack of Proxmox Hermes backup/live-migration capture.
- Community response audits ignore closed Discussions and draft pull requests, start a pull
  request's response clock at its latest ready-for-review event, and paginate top-level comments,
  nested replies, issue comments, and pull-request reviews before deciding that a maintainer has not
  responded.
- Admin account deletion now stops before cascading a Remote Docker registration that still has
  referenced agents, including workloads owned by workspace members. Docker and Remote Docker
  deletion also treats missing managed volumes as idempotent but retains the agent record and reports
  `DOCKER_VOLUME_CLEANUP_FAILED` when durable state cannot actually be removed.
- Remote-host deletion now serializes against new placements, permanently retires deleted host ids,
  and preserves the pinned SSH identity through credential rotation so queued work cannot be
  redirected to a different machine or race a replacement registration.

## [v1.16.4](https://github.com/solomon2773/nora/releases/tag/v1.16.4) — 2026-07-13

Remote Docker security and lifecycle patch: a current workspace grant now remains authoritative
through long-running operations, revocation tears down Nora-mediated access instead of only blocking
the next request, and recovery paths retain enough authority to remove orphaned workloads safely.

### Added

- Remote host owners can explicitly reset an SSH host-key pin after independently verifying an
  expected rebuild or key rotation. The confirmation-gated API and operator UI audit the reset,
  clear the previous successful test, and require **Test** to pin the replacement key before reuse.
- The real-deploy matrix can exercise the standard OpenClaw Remote Docker lifecycle with reusable
  operator credentials and an explicit registered-host target.

### Changed

- Remote Docker queueing, lifecycle, runtime, gateway, log, metric, terminal, backup, scheduled-run,
  and ClawHub paths re-check the agent owner's current positive host grant; active streams also poll
  authorization so unsharing takes effect without waiting for a reconnect.
- Remote-host create, edit, Test, SSH-pin reset, delete, share, and unshare operations now serialize
  per host id across backend replicas. Owner-only mutations re-check the expected owner inside that
  fence, and Test holds it through one overall-bounded SSH/Docker probe and the trust-state write,
  preventing stale requests or concurrent first-use checks from retargeting a recreated host or
  publishing different host keys.
- Redeploy, rollback, scheduled redeploy, destructive restore, and provisioning now use one
  per-agent advisory-lock namespace so stale-job cancellation, runtime replacement, and queue
  publication cannot race each other. Replacement jobs always reconcile credentials from the
  durable agent owner rather than a requesting collaborator.
- Operator, admin, and scheduled start/stop/restart actions now re-load lifecycle state while that
  same provision lock is held, reject queued or deploying agents with a conflict, and keep the lock
  through runtime mutation plus status persistence. Start and restart reconcile the durable
  owner's complete current provider state before reporting success.
- PaaS mode continues to reject Remote Docker registration and normal use, but can perform
  cleanup-only stop/delete actions for already-persisted remote agents so a mode change cannot strand
  workloads that Nora still owns.
- The Remote Docker guide now documents the control and runtime network boundaries, host testing,
  sharing and revocation semantics, backup/restore behavior, capacity limits, recovery, and an
  operator promotion checklist. Docker disk sizing and Proxmox maturity claims are now explicit.
- Password and OAuth login rate-limit windows and attempt budgets are now operator-configurable;
  invalid overrides fall back to the existing secure 20-attempt, 15-minute defaults.
- Release metadata advances the Gemini extension manifest to `1.16.4` and the Helm chart to `0.7.4`
  for exact-tag publication.

### Fixed

- Tested Remote Docker hosts now become genuinely selectable in the OpenClaw Deploy flow: concrete
  host targets derive Standard and optional NemoClaw availability from the runtime family's enabled
  sandbox profiles instead of inheriting the intentionally disabled global placeholder state.
- Revoking Remote Docker access now cancels in-flight HTTP and WebSocket work, retires gateway RPCs,
  and terminates tracked remote command process groups instead of leaving work running after the
  caller loses authorization or disconnects. When a direct Remote Hermes command cannot be canceled
  independently, Nora fail-safe stops that container and records the agent as stopped.
- Remote backup capture fails closed when a host grant changes, installation backups report omitted
  live state honestly, and restore compensates for queue/create races while preserving cleanup
  identity until destruction is confirmed.
- Remote migration and backup capture reject truncated Docker streams, unconfirmed exec completion,
  non-integer exit status, and unexpected archive failures instead of storing empty or stale state.
  Only an explicitly missing optional runtime path becomes an empty archive.
- Hermes restore seeding now sanitizes archive paths, repairs ownership, and restores the durable
  manifest without allowing crafted entries to escape the managed runtime directory.
- Backup restores use the durable agent owner's Remote Docker credentials and grant rather than the
  admin or editor who initiated the restore, preventing cross-workspace credential confusion.
- Proxmox API tasks and SSH operations now require confirmed completion with an integer zero exit
  status; missing task ids, missing final task state, timeout, abort, transport close, or missing
  exit confirmation fail closed instead of being treated as successful lifecycle actions. Runtime
  description labels also strip line separators before Nora ownership markers are written.
- Migration routes are session-only, and live Docker inspection is limited to platform admins on a
  self-hosted control plane so workspace API keys and hosted users cannot read arbitrary containers
  through the backend Docker socket. Live SSH pull is disabled until pinned host verification is
  available; bundle upload remains the safe cross-host import path. Non-empty malformed imported
  `auth-profiles.json` now rejects the draft instead of silently dropping provider credentials.
- Browser deployment drafts recursively scrub password, key, credential, and token fields, discard
  legacy SSH migration metadata, and persist only the supported Docker Live Pull source fields.
  Deploy navigation also remains usable when browser session storage is disabled or unavailable.
- Runtime replacement now compares the previous host as part of the complete optimistic tuple,
  cleans Kubernetes resources through their deterministic name fallback when persisted container
  ids are absent, and re-reads rollback state after locking. Failed rollback materialization or
  queue publication restores the prior payload and wiring before releasing the lock.
- Admin start and restart use the persisted agent owner's provider credentials; reconciliation
  failure stops the runtime, persists a stopped state when cleanup is confirmed, and suppresses the
  success audit instead of leaving stale authentication active.
- Provider rotation and deletion now reconcile the exact Nora-managed environment, OpenClaw JSON
  and SQLite auth profiles, custom providers, and default model, including an empty provider set.
  Provider mutations, lifecycle resume, and deployment finalization share one per-user lock; failed
  reconciliation stops and quarantines the runtime, while unconfirmed containment returns a
  committed `502` instead of a false success.
- New deployments start without provider or integration credentials and receive the current durable
  state only while the shared mutation fence is held. Non-demo readiness failures no longer publish
  a gateway-accessible warning before reconciliation, and start/restart stays non-runnable until
  exact staging plus readiness succeeds.
- Docker, Remote Docker, Kubernetes, NemoClaw, and Proxmox bootstrap artifacts no longer retain
  provider, integration, gateway, pairing, or MCP secrets in immutable container metadata,
  world-readable startup scripts, or ConfigMaps. Mutable credentials live in owner-only managed
  state or Kubernetes Secrets and are replaced exactly without erasing invariant runtime metadata.
- Stopped Proxmox LXCs now receive exact managed state through ownership-checked `pct mount` staging
  before start. Secret-free OpenClaw/Hermes systemd prestart hooks rebuild auth and model state on
  every launch, while mount, unmount, residual-lock, path, privilege, or SSH uncertainty fails closed.
- Runtime sidecar APIs now disable sensitive routes when their gateway token is absent while keeping
  health public, cap `/exec` request bodies at 64 KiB, and treat indeterminate child completion as a
  failure. Gateway retirement rejects unresolved authorization/connect work immediately, cleans up
  synchronous RPC send failures, and prevents an upstream authenticated socket from opening after
  the relay client disconnects during authorization or DNS resolution.
- Real-credential deploy-matrix cells now have unconditional verified teardown, so a failed serial
  lifecycle step cannot skip cleanup or prevent independent later cells from running.
- Failure cleanup remains available after revocation, while all ordinary Remote Docker actions stay
  blocked, reducing the risk of orphaned containers without weakening the authorization boundary.

## [v1.16.3](https://github.com/solomon2773/nora/releases/tag/v1.16.3) — 2026-07-13

Activation and Cloudflare Access compatibility patch: demo agents now prove a real warmed Gateway
reply before becoming runnable, while the bare Admin entrypoint normalizes to the protected
trailing-slash route instead of serving a shell whose JavaScript may be intercepted separately.

### Changed

- Public nginx templates redirect exact `/admin` requests to `/admin/` before proxying the Admin
  dashboard without dropping query parameters, preserving a consistent path boundary for
  Cloudflare Access policies.
- OpenClaw installs default to Nora's validated `2026.6.11` release across standard Docker,
  Kubernetes, NemoClaw, and Proxmox paths; production rebuilds the standard image, mutable
  NemoClaw images refresh before use, and writable bootstrap paths replace stale exact versions.
- The Cloudflare launch runbook now requires cache-bypass and Access coverage for both exact
  `/admin` and descendant routes, with an explicit pre-launch regression check.
- Release metadata advances the Gemini extension manifest to `1.16.3` and the Helm chart to
  `0.7.3` for exact-tag publication.

### Fixed

- Built-in demo activation no longer publishes `running` before OpenClaw has completed a real
  Gateway-backed model turn, removing the cold first-chat timeout window.
- Streaming chat no longer converts pre-token failures or a real timeout into a success-looking
  empty response; terminal events are correlated to their run and current OpenClaw delta payloads
  are accepted.
- Anonymous visits to `/admin` no longer receive an unprotected HTML shell while `/admin/_next/*`
  assets are redirected to Cloudflare Access, which previously left the page stuck on its loading
  state under split exact-versus-wildcard Access rules.

## [v1.16.2](https://github.com/solomon2773/nora/releases/tag/v1.16.2) — 2026-07-12

Edge-activation patch: generated public nginx policy is now applied immediately during every
supported update path instead of remaining pinned to an older bind-mounted file inode.

### Changed

- Production deploys, Bash/PowerShell setup updates, and direct release upgrades pre-validate
  the generated nginx configuration without attaching stdin, refresh it, recreate only the edge
  container to remount it, and then validate the active configuration.
- Infrastructure validation now executes the nginx/secret/release regression suite in CI, and
  TLS renewal validates then gracefully reloads nginx so renewed certificates take effect.
- Release metadata advances the Gemini extension manifest to `1.16.2` and the Helm chart to
  `0.7.2` for exact-tag publication.

### Fixed

- Atomically replacing `nginx.public.conf` no longer leaves the running edge container bound to
  the previous file inode, so marketing CSP, frame denial, host-only HSTS, homepage cache
  eligibility, and backend-owned API framing headers take effect in the same deployment.
- Installer and direct-upgrade paths now refresh generated public nginx policy before recreating
  the edge instead of reactivating an old generated file.
- SSH-driven deploys no longer let the one-off nginx validator consume the remaining remote
  heredoc before the rebuild, health checks, and Docker-socket verification execute.
- Active nginx checks and container probes also read from `/dev/null`, so streamed Bash installs
  and SSH deploys cannot stop after recreation while silently skipping readiness verification.
- Public edges now emit one host-only HSTS field while preserving backend-owned API browser
  policy, and every Next.js surface disables framework disclosure through `X-Powered-By`.
- Public nginx now restores visitor addresses only from Cloudflare's published proxy networks,
  keeping launch-day per-IP limits accurate without trusting spoofed direct-client headers.

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
