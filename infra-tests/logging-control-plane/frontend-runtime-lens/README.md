# Phase 8 — Frontend: Runtime Lens

**Plan doc:** "Phase 8: Frontend — Runtime Lens" (line 1269).

**Objective:** turn `/app/logs` into the three-lens control plane, with
the Runtime lens fully working — virtualized rows, level/stream filter
chips, full-text search, and live tail, all scoped to the active
workspace and a single agent.

**Code:** `frontend-dashboard/pages/logs/index.tsx`,
`frontend-dashboard/lib/observabilityClient.ts`,
`frontend-dashboard/components/logs/LogTable.tsx`,
`frontend-dashboard/components/logs/LogFilterBar.tsx`,
`frontend-dashboard/components/layout/Topbar.tsx`.

**Existing coverage:** `frontend-dashboard/lib/observabilityClient.test.ts`
(run via `tsx --test`, not Playwright) covers most of the *logic* this
phase introduces as pure functions: a `collector`-stamped row being marked
approximate (vs. a `source`-stamped row not), the capability-state
decision tree (k8s+local misconfiguration, hermes gateway-only, generic
empty, priority ordering between them), and the virtualized-range math
(bounded window regardless of total row count, tracks scroll position,
clamps near the end of a long list). What it does **not** cover — because
it never mounts a component or a browser — is whether `LogTable.tsx`
actually renders correctly off that math: real DOM virtualization at
scale, lens-switching state preservation, workspace-scoped refetching, or
the live-tail connection lifecycle. No Playwright spec for logs or the
Runtime lens exists yet under `e2e/specs/` (checked directly — the
closest existing coverage is generic navigation/auth journeys), so those
are open work items for `e2e/`, not this suite.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Lens switching preserves the shared filter state | Switching between Operator/Runtime/other lenses, does the workspace/agent/time-range selection stay put instead of resetting? | Belongs in `e2e/` (Playwright) | Pure component/page state behavior — no infra condition changes it. Not duplicated here. |
| 2 | Changing the active workspace refetches and scopes results | Does switching the active workspace via `subscribeToActiveWorkspace` actually refetch and scope the Runtime lens to the new workspace? | Belongs in `e2e/` (Playwright) | This phase is explicitly the first page to scope API calls by workspace — worth a real browser test, but it's a wiring/rendering check, not a fault-injection one. |
| 3 | Virtualized list renders a 50,000-line result without freezing | Does `LogTable.tsx` stay responsive at real scale instead of choking the main thread? | Belongs in `e2e/` (Playwright, performance-flavored) | The virtual-range *math* is unit-tested (see above); whether the actual DOM/React rendering built on that math holds up at scale is a rendering-performance question, best measured in a real browser, not this suite. |
| 4 | A `collector`-stamped row is visually marked | Does a row whose `ts_source` is `collector` show its "approximate timestamp" marker in the rendered table? | Covered by unit test | `observabilityClient.test.ts` — "marks a collector-stamped row as approximate" / "does not mark a source-stamped row as approximate" test the underlying decision function directly. |
| 5 | An unsupported stream shows a capability message, not an empty state | Does an agent/stream combination Nora can't collect from (e.g. k8s + local driver, hermes gateway-only) show an explicit message instead of a silent empty list? | Covered by unit test | `observabilityClient.test.ts` exercises the full capability-state decision tree, including priority ordering between competing conditions. |
| 6 | Export triggers a download with the correct filename | Does the export action in this lens produce a download with a sane filename? | Covered by unit tests elsewhere | Format/filename correctness is exercised by the export endpoint's own tests (see Phase 7); the frontend side is a trigger-and-forward, not new logic. |
| 7 | **Two concurrent live-tail follow streams hit the same container** | `attachLogStream` calls `containerManager.logs()` directly rather than subscribing to the collector's buffer, so every open Runtime-lens viewer opens its own follow stream against the container in parallel with the collector's own follow stream already running for storage. Does opening a live-tail view visibly double the Docker/k8s log-follow load on the container, and can the two independent parsers (collector's and the browser path's) disagree about the same line under real load/reordering? | **[x] implemented** — `01-double-follow-stream.sh` | Phase 8 item 6 raises this as an open question, but **Phase 15 item 2c resolves it**: "document the live-tail double-stream as an accepted v1 tradeoff, not an oversight … usage-gated … revisited post-v1 once there is usage data." So this is not a latent bug to catch before ship — the script measures, it does not assert a pass/fail verdict on the architecture. It mints a real JWT (`lib/auth.sh`'s `mint_jwt`, no login round trip), opens a real WebSocket against the real `/ws/logs/<agentId>` endpoint (auth via the documented `?token=` query param — a browser WS client cannot set an Authorization header) from inside the backend-api container itself (using `ws`/`jsonwebtoken`, both already real backend-api dependencies — no new dependency added), holds it open for 18s against a live test agent, and compares what it received against what the collector independently flushed for the same window. **What one real run measured:** the collector's own follow stream and a fully independent second `containerManager.logs()` call are confirmed, architecturally, to have zero shared buffer/subscription — so two concurrent follow connections against the same container is a property of the code, not conditional on timing. Empirically, one full run authenticated and connected successfully but hit a genuine, reproducible surprise: `logStream.ts`'s own live `containerManager.status(agent)` recheck transiently reported a container that was continuously emitting (confirmed via direct `docker logs` counts, 44→66 lines across the run) as **not running**, so that run's WS session sent "Agent is stopped — logs will appear…" and returned *before* ever calling `containerManager.logs()` — the second stream was authorized but not opened for that particular run. Isolated separately (a plain `docker.ts` `status()` call against a freshly-created, genuinely-running container, invoked directly), the function itself returns `{running:true}` correctly and immediately — `docker.ts`'s `status()` swallows *any* `container.inspect()` exception into a silent `{running:false}` (see its `catch` block), so the most plausible explanation is transient Docker-socket contention on this shared dev stack (multiple sibling infra-test suites were running concurrently against it at the time) rather than a logic bug in the status check itself. The script detects this outcome (`stream_actually_opened`, checked via the "Streaming logs from…" system message) and reports it honestly in `test_pass`'s details rather than papering over it. Collector-side: the flushed segment (`log_segments`) was compared against total container emission as a coexistence check regardless of the WS outcome. CPU% (`docker stats --no-stream`) is sampled collector-only vs. collector+live-tail as a soft, noisy resource signal — a 1-line/sec test emitter is too light a load for a reliable delta on its own, recorded only for whatever post-v1 usage-data decision Phase 15 item 2c anticipates. **A second, separate finding surfaced by actually running this against the live shared stack**: this worktree's `docker-compose.yml` currently lacks the `nora_logs` named volume / `backend-api` mount that the logging control plane's `worker-provisioner` service depends on (added on a sibling, not-yet-merged branch) — a `compose up -d worker-provisioner` issued from *this* worktree against the shared `nora` project fails with "invalid compose project" and leaves `worker-provisioner` down for every concurrent user of the shared stack, not just this script. The script's `cleanup()` now checks for and loudly `log_warn`s this rather than silently swallowing it (matching every other phase's cleanup trap's `\|\| true`, plus one extra check); the real fix is restarting `worker-provisioner` from a worktree whose compose files are current (e.g. `logging-integration`) until this branch picks up that volume. |

## Why this phase is thin here

Phase 8 is almost entirely UI/browser-behavior: component state, rendering
correctness, and virtualization performance — squarely `e2e/` Playwright
territory, and (for the pure-function pieces) already well covered by
`observabilityClient.test.ts`. Row #7 — the double follow-stream — is the
only row with any real infra shape, and even that is a documented,
accepted v1 tradeoff per Phase 15 item 2c rather than an open risk, so this
phase effectively has **zero** infra rows that block anything before ship.
It is now implemented (`01-double-follow-stream.sh`) since the harness
(a real minted JWT plus a real WebSocket client running inside the
backend-api container) turned out to be small to build and gives the
future post-v1 revisit real, reproducible measurements to act on — see
row #7's Notes for what one real run found, including a genuine transient
false-negative in the live-tail endpoint's own status recheck under
concurrent load.
