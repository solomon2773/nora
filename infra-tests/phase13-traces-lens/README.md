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
concern documented in Phase 6's README (`infra-tests/phase6-search/README.md`
in the `logging-integration` worktree) — this isn't a new root cause,
it's the same one surfacing through a second call site.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | The cross-lens correlation query behaves correctly against a real mix of traced and untraced segments fetched concurrently from real object storage at real time-range boundaries | Store a real agent's gateway (traced) and runtime (untraced) log segments in real MinIO, spanning a trace's actual start/end boundary, and confirm `correlatedLogsForTrace` returns the right in-trace/in-window split without a connection-pool limit silently serializing the concurrent segment fetch | **[x] implemented** — `01-concurrent-correlation-real-minio.sh` | Builds 8 real segments directly (4 gateway matching the synthetic trace, 1 gateway carrying a *different* trace_id to prove exact-match exclusion, 2 runtime in-window, 1 runtime well outside the window to prove SQL-level pruning), via the real `segmentWriter` encrypt/compress primitives and a real upload to MinIO — not a shortcut. Runs inside the **backend-api** container (not worker-provisioner, unlike every other node_call user in this suite) because `logSearch.ts`'s own requires of `workers/provisioner/logs/*` only resolve inside backend-api's container, which alone mounts `./workers` at `/workers:ro` — worker-provisioner does not; see the script's header for the full mount-asymmetry explanation. Concurrency is checked the same timing-based way Phase 6's own row 1 describes (wall time of the real `Promise.all` fetch vs. a measured single-segment baseline latency) — flagged in the script's own pass/fail message as inherently noisy against a fast local MinIO instance, not a hard proof. |
| 2 | Trace list aggregates duration, span count, and cost correctly | Aggregation math over multiple spans/traces | Belongs in `backend-api/__tests__/` instead | Already fully covered by `traceQuery.test.ts`'s `listTraces` describe block against fake data — no infra condition changes this outcome. |
| 3 | Span tree reconstructs parent/child nesting | Tree-building from `parent_span_id` | Belongs in `backend-api/__tests__/` instead | Already covered by `buildSpanTree` tests, including the orphaned-parent edge case. |
| 4 | Untraced lines are flagged distinctly in the response | `inTrace`/`category` flags on correlated lines | Belongs in `backend-api/__tests__/` instead | Already covered — fake segment data is sufficient to assert the flag shape; no real-infra condition affects it. |
| 5 | Workspace scoping holds on both endpoints, including for a platform admin | Cross-workspace isolation, admin bypass boundaries | Belongs in `backend-api/__tests__/` instead | Already covered for both `listTraces` and `getTraceDetail`, including the not-owner-gets-404 case. |
| 6 | An unassigned agent's spans are returned to its owner, not filtered out | `workspace_id = NULL` visibility via accessible-agent scoping | Belongs in `backend-api/__tests__/` instead | Already covered for both endpoints. |
| 7 | A workspace with tracing disabled gets the enable CTA, not an empty list | `tracesEnabled` flag distinguishing "off" from "on but empty" | Belongs in `backend-api/__tests__/` instead | Already covered by the dedicated describe block contrasting the two states. |

## Blocked on

Nothing further for row 1 — it builds its own mixed traced/untraced
segment fixture directly (via `lib/storage_dest.sh` pointed at real MinIO)
rather than depending on Phase 6's suite existing first. Not independently
re-verified against a live stack in this session (no `.env`/running stack
existed in this worktree at the time this was written); run it for real
before trusting a pass.
