# Phase 11 — OTLP Receiver And Span Ingest

**Plan doc:** "Phase 11: OTLP Receiver And Span Ingest" (line 1464).

**Objective:** accept OTLP/HTTP protobuf trace exports from agents at
`POST /otlp/v1/traces`, authenticate by a recomputed HMAC ingest key
(agent ID travels in its own header, never trusted from span data),
derive `workspace_id` from the resolved agent (the entire tenant-isolation
mechanism — never from a span resource attribute), and enqueue to a
BullMQ `span-ingest` queue that worker-provisioner drains into
`agent_spans`.

**Code:** `backend-api/routes/otlp.ts`, `backend-api/otlpDecode.ts`,
`backend-api/proto/trace_service.proto`, `workers/provisioner/spanDrain.ts`.

**Unit tests:** `backend-api/__tests__/otlpIngest.test.ts` is thorough —
it already covers every item on the plan doc's Tests list: protobuf/JSON
decode parity, malformed-protobuf and malformed-JSON rejection without
throwing, unsupported content-type rejection, HMAC/header validation
(missing agent-id, missing ingest-key, invalid key → 401, all before
decode), the workspace-spoofing case (resource attribute claiming a
different workspace is ignored in favor of the agent's real workspace),
the null-workspace agent case, oversized-body rejection before decode,
and parent/child + token/cost attribute mapping in `mapSpanToRow`. All of
that is exercised against a mocked queue/DB, so what it can't cover is
the route's behavior against a *real* BullMQ/Redis and a *real*
worker-provisioner process.

**Category note:** like Phase 6, this is less "chaos" than
"integration tests requiring real infra" for most rows — the queue and
worker are real services with real crash/restart semantics that a mock
enqueue call can't exercise.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | A `worker-provisioner` crash/restart mid-batch loses no span-ingest jobs and double-processes none | Kill worker-provisioner while it's mid-drain on a batch of enqueued `span-ingest` jobs, restart it, and check every job's spans land in `agent_spans` exactly once (not zero, not twice) | **[x] implemented** — `01-worker-crash-midbatch.sh` | Also exercises row 3's real end-to-end round trip (real POST → real HMAC auth → real enqueue → real drain → real `agent_spans` rows) as part of the same setup, per row 3's note. Timing honesty, mirroring `phase4-log-collector/01-worker-kill-midwindow.sh`: this script cannot force the SIGKILL to land while a specific BullMQ job is provably ACTIVE (locked) rather than still WAITING — there's no test-only hook into BullMQ's internal state. It gives the worker a brief real window, kills it, then waits out BullMQ's default lock+stalled-check cycle (~30s+30s, no override in `worker.ts`'s `new Worker("span-ingest", ...)`) before asserting. **Potential real bug flagged, not confirmed on every run:** `spanDrain.ts`'s `batchInsertSpans` is a bare INSERT with no `ON CONFLICT`, and `agent_spans` has no `UNIQUE(trace_id, span_id)` constraint (see `db_schema.sql`) — if a stalled-job redelivery ever does land, the same batch would be inserted a second time with nothing to stop it. The script asserts on this directly (distinct `span_id` count vs. total row count) rather than assuming either outcome; run it and check its own result/details for whether this was observed. |
| 2 | A burst of concurrent OTLP POSTs is actually rate-limited under real load, not just in a unit test asserting the middleware is wired in | Fire many real concurrent `POST /otlp/v1/traces` requests against a running backend-api and confirm the tighter unauthenticated-endpoint rate limit engages (429s appear) without dropping/miscounting requests under real concurrency | **[x] implemented** — `02-concurrent-burst-rate-limited.sh` | Reads the real configured `NORA_OTLP_RATE_LIMIT_MAX`/`NORA_OTLP_RATE_LIMIT_WINDOW_MS` from the running container rather than hard-coding the code defaults (240/60000ms), and explicitly checks `NODE_ENV` isn't `test` first (the route's own `skip: () => IS_TEST_ENV` would otherwise silently produce a false pass with zero 429s for the wrong reason). Fires `max + 40` real concurrent backgrounded curls. |
| 3 | A valid protobuf payload decodes and persists the expected spans end-to-end through a real Redis queue and a real worker-provisioner drain | Full round trip: real POST → real enqueue → real drain → real row in `agent_spans` | Folded into row 1 | `otlpIngest.test.ts` already covers decode-and-enqueue with a mocked queue; the only genuinely-missing piece is the real drain leg, exercised as `01-worker-crash-midbatch.sh`'s own setup path (it has to get real spans into `agent_spans` before it can assert on crash-recovery correctness) rather than duplicated as a separate scenario. Uses OTLP/JSON (not raw protobuf) per the plan's item 1 allowance — decode parity between the two content types is already covered by `otlpIngest.test.ts`. |

## Blocked on

Nothing further for rows 1-3 above — both scripts run standalone against a
real dev stack (`docker compose up -d`). Not independently re-verified
against a live stack in this session (no `.env`/running stack existed in
this worktree at the time these were written — see the session notes this
change was produced under); run them for real before trusting a pass.
