# Phase 6 — Search API With Cross-Stream Merge

**Plan doc:** "Phase 6: Search API With Cross-Stream Merge" (line 1107).

**Objective:** serve `GET /logs/search` — prune segments in SQL, fetch
candidates in parallel, k-way merge into one chronological timeline,
closing the "recency gap" (segments flush every 15 minutes, so search
alone can't see the last few minutes without also querying the worker's
live in-memory buffer).

**Code:** `backend-api/logSearch.ts`, `backend-api/routes/observability.ts`.

**Unit tests:** `backend-api/__tests__/logSearch.test.ts` covers the merge
algorithm, cursor encoding, and workspace-isolation logic with fake
segment data. What it cannot cover: real concurrency behavior against real
network latency (the plan calls this out explicitly — "a serial
implementation will pass tests [with the local driver] and then fail in
production on s3"), and the real cross-service call to worker-provisioner
for the recency-gap buffer merge.

**Category note:** these are less "chaos tests" than Phases 3-5b and more
"integration tests requiring real infra" — nothing here involves killing a
process. They're grouped in this suite anyway (not moved to a
Jest/Playwright integration layer) because they share the same root cause
for needing real infra: the `local` storage driver hides latency/
concurrency bugs that only appear against a real object-storage backend,
exactly the "passes tests, fails in production" gap the plan doc names by
title.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Candidates are fetched concurrently against MinIO, not effectively serialized by undici's per-origin connection limit | When searching logs stored in the cloud (S3), does Nora fetch multiple files in parallel (fast) — or does a technical connection-pool limit accidentally force it to fetch them one at a time (slow)? | [ ] planned | The plan explicitly flags this as a real risk: "undici's default will silently serialize requests back down to a much smaller effective concurrency." Needs a real wide-time-range query against MinIO with many real segments and a way to observe actual request concurrency (timing-based: total wall time should be closer to `max(request latencies)` than `sum(request latencies)`, or instrument the configured `dispatcher`). |
| 2 | The recency gap is closed — a line written 30 seconds ago (still in-buffer, not yet flushed) is returned by search | Can you search and immediately see a log line that was written only 30 seconds ago, even though it hasn't been permanently saved to storage yet? | [ ] planned | Real cross-service call: `backend-api` → an internal `worker-provisioner` endpoint for the current buffer. Query search for a live agent immediately after it logs something, before any flush could have happened. |
| 3 | A flush landing exactly between the buffer read and the storage read produces no duplicate and no gap | If a batch of logs gets permanently saved to storage at the exact same moment you're searching, do you see each log line exactly once — not duplicated, and not missing? | [ ] planned | The hardest test in this phase to engineer deliberately — needs to win a real race between a search request and a real flush. Might need a test-only hook to pause the search handler at that exact point, or many repeated attempts hoping to hit the window (flaky by nature; consider whether this is worth chasing manually vs. trusting the unit-tested ordering logic (`storage wins on overlap`) plus this suite's other real-flush tests as indirect coverage). |
| 4 | An unreachable worker degrades search to storage-only with an explicit "recent lines unavailable" marker, rather than failing the query | If the background worker is down, does search still work using slightly older saved data (with a note that recent logs are unavailable) — instead of the whole search just failing? | [ ] planned | `docker compose stop worker-provisioner`, run a search query against `backend-api` directly, confirm a 200 with the marker rather than a 5xx. Cheapest test in this file to build — no timing races, no concurrency assertions. |
| 5 | Workspace-A actor receives zero workspace-B rows, including for a platform admin (the per-agent admin bypass must not leak across the workspace filter) | Can a user from one workspace ever see log search results from a completely different workspace — even if they're a platform admin? (Should always be no.) | Probably belongs in `backend-api/__tests__/` instead | Primarily a request-scoping/auth concern, well-suited to a normal `backend-api` Jest integration test (real Express app, real DB, mocked nothing but the JWT) rather than this suite — no chaos/infra condition changes this outcome. |

## Blocked on

The auth helper (see Phase 5's README) — every test above needs a real
`GET /logs/search` request with a valid JWT.
