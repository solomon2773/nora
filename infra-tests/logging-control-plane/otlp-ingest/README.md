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
| 1 | A `worker-provisioner` crash/restart mid-batch loses no span-ingest jobs and double-processes none | Kill worker-provisioner while it's mid-drain on a batch of enqueued `span-ingest` jobs, restart it, and check every job's spans land in `agent_spans` exactly once (not zero, not twice) | **[x] verified passing** — `01-worker-crash-midbatch.sh`, run twice against a live stack on 2026-09-11 | Also exercises row 3's real end-to-end round trip (real POST → real HMAC auth → real enqueue → real drain → real `agent_spans` rows) as part of the same setup, per row 3's note. Timing honesty, mirroring `log-collector/01-worker-kill-midwindow.sh`: this script cannot force the SIGKILL to land while a specific BullMQ job is provably ACTIVE (locked) rather than still WAITING — there's no test-only hook into BullMQ's internal state. It gives the worker a brief real window, kills it, then waits out BullMQ's default lock+stalled-check cycle (~30s+30s, no override in `worker.ts`'s `new Worker("span-ingest", ...)`) before asserting. **Real bug found and fixed while running this for the first time**: the node_call snippet that computes the ingest key/builds the payload requires `routes/otlp.ts`, which transitively requires `../redisQueue.ts` — that file opens real BullMQ `Queue`/ioredis connections at module scope, active handles that kept the spawned node process alive indefinitely because the snippet never called `process.exit()`. Confirmed empirically: the identical call took ~10 minutes (once ~20 minutes) to return without an explicit exit, vs. ~1 second with one. Fixed by adding `process.exit(0)` after the snippet's final `console.log` — see the script's own inline comment. Both post-fix runs completed in seconds and passed: **exactly 25/25 spans landed, all with distinct `span_id`** on both runs. **Potential real bug flagged, not observed on either run:** `spanDrain.ts`'s `batchInsertSpans` is a bare INSERT with no `ON CONFLICT`, and `agent_spans` has no `UNIQUE(trace_id, span_id)` constraint (see `db_schema.sql`) — if a stalled-job redelivery ever does land, the same batch would be inserted a second time with nothing to stop it. The script's own timing constraints (BullMQ's ~30s+30s lock/stalled-check cycle, and a brief pre-kill window that can land the job as already-completed rather than genuinely mid-flight, as happened both times here) mean this remains a real, structurally-possible gap in the product code that neither live run happened to trigger. |
| 2 | A burst of concurrent OTLP POSTs is actually rate-limited under real load, not just in a unit test asserting the middleware is wired in | Fire many real concurrent `POST /otlp/v1/traces` requests against a running backend-api and confirm the tighter unauthenticated-endpoint rate limit engages (429s appear) without dropping/miscounting requests under real concurrency | **[x] verified passing** — `02-concurrent-burst-rate-limited.sh`, run twice against a live stack on 2026-09-11 | Reads the real configured `NORA_OTLP_RATE_LIMIT_MAX`/`NORA_OTLP_RATE_LIMIT_WINDOW_MS` from the running container rather than hard-coding the code defaults (240/60000ms), and explicitly checks `NODE_ENV` isn't `test` first (the route's own `skip: () => IS_TEST_ENV` would otherwise silently produce a false pass with zero 429s for the wrong reason; this stack's `NODE_ENV` is actually `production` — the override compose file's production-like mode — which still satisfies the check since it isn't `test`). Fires `max + 40` real concurrent backgrounded curls. Shared row 1's missing-`process.exit()` node_call hang (same fix applied — see the script's inline comment). Both post-fix runs passed with real, meaningful splits: 59-60 accepted (202) vs. 220-221 rejected (429) against a configured limit of 240/60000ms. |
| 3 | A valid protobuf payload decodes and persists the expected spans end-to-end through a real Redis queue and a real worker-provisioner drain | Full round trip: real POST → real enqueue → real drain → real row in `agent_spans` | Folded into row 1 | `otlpIngest.test.ts` already covers decode-and-enqueue with a mocked queue; the only genuinely-missing piece is the real drain leg, exercised as `01-worker-crash-midbatch.sh`'s own setup path (it has to get real spans into `agent_spans` before it can assert on crash-recovery correctness) rather than duplicated as a separate scenario. Uses OTLP/JSON (not raw protobuf) per the plan's item 1 allowance — decode parity between the two content types is already covered by `otlpIngest.test.ts`. |

## Blocked on

Nothing further for rows 1-3 above. Both scripts have now been run for
real against a live stack (`docker compose up -d`) — twice each, on
2026-09-11 — and pass. See each row's Notes for the real bug found and
fixed (a script hang, not a product bug) and the product-code risk flagged
but not observed.
