# Phase 13 — Traces Lens And Cross-Lens Correlation

**Plan doc:** "Phase 13: Traces Lens And Cross-Lens Correlation" (line 1617).

**Objective:** serve `GET /traces` (trace list with aggregated duration,
span count, cost) and `GET /traces/:traceId` (span tree plus correlated
log lines — both traced gateway lines and untraced runtime lines from the
same agent/window), scoped by accessible agent rather than `workspace_id`
alone so an unassigned agent's spans stay visible to its owner.

**Code:** `backend-api/routes/observability.ts`, `backend-api/traceQuery.ts`,
`frontend-dashboard/components/logs/TraceList.tsx`,
`frontend-dashboard/components/logs/TraceWaterfall.tsx`.

**Unit tests:** `backend-api/__tests__/traceQuery.test.ts` is thorough
and covers essentially every item on the plan doc's Tests list against
fake segment/DB data: `listTraces` aggregation (duration, span count,
cost, grouped correctly across multiple distinct traces), the
tracing-disabled-vs-enabled-but-empty distinction (the enable-CTA case),
workspace scoping on both endpoints including the platform-admin case,
the unassigned-agent-visible-to-its-owner case, `buildSpanTree` parent/child
nesting (including an orphaned-parent-id-treated-as-root edge case), and
`correlatedLogsForTrace` returning both traced (`inTrace: true`) and
untraced (`inTrace: false`) lines distinctly flagged, excluding
out-of-window runtime lines, and pruning candidate segments by agent and
time rather than by trace. What it can't cover: real concurrency and
latency in the underlying segment fetch.

**Category note:** `correlatedLogsForTrace` reuses Phase 6's
`selectCandidateSegments`/`fetchSegmentLines` machinery to pull the
in-window log lines, so it inherits the exact same "local driver hides
latency/concurrency bugs that only appear against real object storage"
concern documented in Phase 6's README (`infra-tests/search/README.md`
in the `logging-integration` worktree) — this isn't a new root cause,
it's the same one surfacing through a second call site.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | The cross-lens correlation query behaves correctly against a real mix of traced and untraced segments fetched concurrently from real object storage at real time-range boundaries | Store a real agent's gateway (traced) and runtime (untraced) log segments in real MinIO, spanning a trace's actual start/end boundary, and confirm `correlatedLogsForTrace` returns the right in-trace/in-window split without a connection-pool limit silently serializing the concurrent segment fetch | **[x] verified passing** — `01-concurrent-correlation-real-minio.sh`, run against a live stack on 2026-09-11 | Builds 8 real segments directly (4 gateway matching the synthetic trace, 1 gateway carrying a *different* trace_id to prove exact-match exclusion, 2 runtime in-window, 1 runtime well outside the window to prove SQL-level pruning), via the real `segmentWriter` encrypt/compress primitives and a real upload to MinIO — not a shortcut. Runs inside the **backend-api** container (not worker-provisioner, unlike every other node_call user in this suite) because `logSearch.ts`'s own requires of `workers/provisioner/logs/*` only resolve inside backend-api's container, which alone mounts `./workers` at `/workers:ro` — worker-provisioner does not; see the script's header for the full mount-asymmetry explanation. Concurrency is checked the same timing-based way Phase 6's own row 1 describes (wall time of the real `Promise.all` fetch vs. a measured single-segment baseline latency) — flagged in the script's own pass/fail message as inherently noisy against a fast local MinIO instance, not a hard proof. **Two real bugs found and fixed on first run:** (1) the script's own `node_call_backend_api` helper used the worker-provisioner-style `docker cp ... /app/...` pattern, but THIS stack's backend-api container runs with a read-only root filesystem (confirmed via `docker inspect` — `HostConfig.ReadonlyRootfs=true`), so every invocation failed outright with "container rootfs is marked read-only" / `MODULE_NOT_FOUND`; `lib/auth.sh`'s `mint_jwt` had already discovered and solved this exact problem for this exact container (pipe the script over stdin into `/tmp` instead of `docker cp` into `/app`) but this script's own inline helper didn't reuse that fix — now it does. (2) Moving the scratch script to `/tmp` broke its five relative `require()` calls (`./db.ts`, `../agent-runtime/lib/objectStorage.ts`, etc.) — a relative `require()` resolves against the *requiring file's own directory*, not the process cwd, so once the file lived in `/tmp` those paths no longer pointed at backend-api's real modules; fixed by converting them to the equivalent absolute paths (`/app/db.ts`, `/agent-runtime/lib/objectStorage.ts`, `/workers/provisioner/logs/segmentWriter.ts`, etc.) that the original relative paths resolved to when the script still lived under `/app`. After both fixes, the run passed cleanly: `in_trace=8/8, window=4/4`, no other-trace leak, no outside-window leak, and the 7-segment fetch (15ms wall vs. ~6ms single-segment baseline) looked genuinely concurrent. |
| 2 | Trace list aggregates duration, span count, and cost correctly | Aggregation math over multiple spans/traces | Belongs in `backend-api/__tests__/` instead | Already fully covered by `traceQuery.test.ts`'s `listTraces` describe block against fake data — no infra condition changes this outcome. |
| 3 | Span tree reconstructs parent/child nesting | Tree-building from `parent_span_id` | Belongs in `backend-api/__tests__/` instead | Already covered by `buildSpanTree` tests, including the orphaned-parent edge case. |
| 4 | Untraced lines are flagged distinctly in the response | `inTrace`/`category` flags on correlated lines | Belongs in `backend-api/__tests__/` instead | Already covered — fake segment data is sufficient to assert the flag shape; no real-infra condition affects it. |
| 5 | Workspace scoping holds on both endpoints, including for a platform admin | Cross-workspace isolation, admin bypass boundaries | Belongs in `backend-api/__tests__/` instead | Already covered for both `listTraces` and `getTraceDetail`, including the not-owner-gets-404 case. |
| 6 | An unassigned agent's spans are returned to its owner, not filtered out | `workspace_id = NULL` visibility via accessible-agent scoping | Belongs in `backend-api/__tests__/` instead | Already covered for both endpoints. |
| 7 | A workspace with tracing disabled gets the enable CTA, not an empty list | `tracesEnabled` flag distinguishing "off" from "on but empty" | Belongs in `backend-api/__tests__/` instead | Already covered by the dedicated describe block contrasting the two states. |

## Blocked on

Nothing further for row 1 — it builds its own mixed traced/untraced
segment fixture directly (via `lib/storage_dest.sh` pointed at real MinIO)
rather than depending on Phase 6's suite existing first. Run for real
against a live stack on 2026-09-11 and passes — see row 1's Notes for the
two real script bugs (read-only-rootfs `docker cp`, and relative requires
broken by the resulting relocation to `/tmp`) found and fixed along the way.
