# Building a provisioner backend

Provisioner backends are shared execution-target adapters used by both the worker and backend API. They are not dynamically loaded plugins: adding a target changes runtime selection, validation, lifecycle routing, configuration, UI, documentation, and end-to-end coverage.

> **Shared code warning:** this directory is bind-mounted into `backend-api` at `/app/backends`. A change here affects at least two services and shadows the host `backend-api/backends/` directory in Compose.

## Create the fail-closed starter

From the repository root:

```bash
npm run contributor:setup -- --scope backend-adapters
npm run scaffold:backend -- --id acme-cloud --name "Acme Cloud"
```

Use `--dry-run` to validate and list outputs without writing. The command creates:

- `workers/provisioner/backends/acme-cloud.ts`: an unregistered adapter extending `ProvisionerBackend`
- `backend-api/__tests__/acme-cloudBackend.test.ts`: contract shape, fail-closed coverage for every required operation, and lifecycle test TODOs

The generated adapter intentionally throws for every required lifecycle, telemetry, log, and exec operation. It cannot become reachable merely because the file exists. This prevents a half-implemented deploy target from appearing in production or accepting jobs.

## Required contract

Implement these methods from `interface.ts`:

- `create(config)` returns stable `{ containerId, host }` metadata only after the runtime is provisioned.
- `destroy(containerId, options)` is idempotent and removes target resources without crossing tenant boundaries. An adapter that owns durable per-agent state must honor `options.preserveState` and keep that state: redeploy destroys the previous runtime and recreates it against the same volume/claim, which is keyed by agent id, not container id.
- `status(containerId)` reports accurate run state and uptime when available.
- `stats(containerId, agent)` returns normalized telemetry or an explicit unavailable-capability map.
- `stop`, `start`, and `restart` preserve runtime identity and persisted state.
- `logs` and `exec` are required interface methods. An adapter without those capabilities must fail closed with a clear unsupported-operation error and advertise the capability as unavailable to the UI/API.

Treat every identifier and endpoint as untrusted input. Validate ownership and target scope before lifecycle actions, keep credentials out of logs/errors, use timeouts and abort signals for remote work, make retries safe, and clean up partial resources after failures.

## Cross-repository wiring checklist

Do not register the adapter until all affected owners agree on the contract:

1. Add the deploy target and maturity/capability metadata to `agent-runtime/lib/backendCatalog.ts`.
2. Add create-job resolution in `workers/provisioner/worker.ts` and keep queue payloads backwards compatible.
3. Add lifecycle resolution in `backend-api/containerManager.ts` plus route/selection validation.
4. Add secrets and connection tests to the admin configuration surface without exposing credentials to operators.
5. Add operator deploy selection only at the intended maturity: GA targets need complete release evidence; experimental targets must be explicit opt-ins, visibly labeled, and blocked from unsupported runtime/sandbox combinations.
6. Update `.env.example`, setup/Compose or cluster configuration, public docs, and upgrade behavior.
7. Add mocked unit coverage, failure/cleanup tests, and a real opt-in smoke path in `e2e/`.
8. Verify OpenClaw and Hermes separately; verify sandbox profiles only when the target explicitly supports them.

Keep a new target unreachable by default until create/destroy/status, stop/start/restart, readiness, persistence, logs/telemetry capability reporting, credential handling, partial-failure cleanup, and upgrade compatibility have automated evidence. Keep it experimental until the documented real-environment smoke gate passes.

## Validate

```bash
npm run contributor:check -- backend-adapters
```

The local check validates the shared interface and scaffold generator, then type-checks both worker and backend consumers. Run the target's focused tests and live smoke separately; cloud or hypervisor credentials are never required by the default contributor check.
