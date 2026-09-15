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
| 1 | Candidates are fetched concurrently against MinIO, not effectively serialized by undici's per-origin connection limit | When searching logs stored in the cloud (S3), does Nora fetch multiple files in parallel (fast) — or does a connection-pool limit force it to fetch them one at a time (slow)? | [x] implemented — `01-concurrent-fetch-real-minio.sh` | Builds 24 real encrypted segments in MinIO and runs the real `searchLogs` three times. Two signals, since each can mislead alone: a spy on `getStorageObject` records peak simultaneous fetches (proves application fan-out, deterministically), and median wall time against a single-fetch baseline (catches the undici socket-level serialization the plan warns about, which a spy cannot see). Each run gets a fresh decode cache so repeats aren't cache hits. Live result: peak 24/24, median 37ms against a 9ms baseline and a ~223ms serial estimate. |
| 2 | The recency gap is closed — a line written seconds ago (still in-buffer, not yet flushed) is returned by search | Can you search and immediately see a log line written moments ago, before it has been saved to storage? | [x] implemented — `02-recency-gap-closed.sh` | Captures the exact newest line from `docker logs`, then requires it in a real HTTP search while `log_segments` is empty both before and after the query — which is what proves it came from the buffer. Tighter than the plan's "30 seconds ago." |
| 3 | A flush landing exactly between the buffer read and the storage read produces no duplicate and no gap | If logs get saved to storage at the exact moment you search, do you see each line exactly once? | [x] implemented — `03-flush-between-buffer-and-storage-read.sh` | Previously judged flaky by nature. It isn't: the race has a fixed order even without fixed timing, so each step is performed for real in sequence — a genuine buffer snapshot, a genuine forced flush, then the real `searchLogs` with its buffer read answered by the pre-flush snapshot. Only the interleaving is pinned; no data is simulated. Guards against a hollow pass by requiring the snapshot and segment to actually overlap, and measures duplication relative to storage so pre-existing replay duplicates don't count. Live result: 45/45 snapshotted lines overlapped the flushed segment, 0 duplicates added, 0 gaps. |
| 4 | An unreachable worker degrades search to storage-only with an explicit "recent lines unavailable" marker, rather than failing the query | If the background worker is down, does search still work from saved data, with a note that recent logs are unavailable? | [x] implemented — `04-unreachable-worker-degrades.sh` | Flushes a segment first (so a degraded 200 must carry real rows, not be empty), genuinely stops `worker-provisioner`, and asserts HTTP 200 + marker + rows + a bounded response time. Then restores the worker and re-queries to confirm the marker disappears, so it can't be set unconditionally. |
| 5 | Access to search, export, and traces follows the product's actor rules — including for a platform admin, an owner, and a workspace-bound API key | Can anyone read logs from an agent they shouldn't — and can admins see everything they're meant to? | [x] implemented — `05-workspace-isolation.sh` | This row originally suggested it belonged in `backend-api/__tests__/`. It's here because the unit test uses a fake db, and two real bypasses (admin returns any agent; the owner fast path skips workspace lookup) leave `enforceWorkspaceScope` as the only barrier — worth proving against real rows, a real second user, and a real `createApiKey` key through nginx. **Product decision, overriding the plan's Decision 14:** in Logging, a platform admin sees every agent across every workspace, including unassigned ones, with no workspace named. Non-admins see agents they own plus agents in workspaces they belong to; another user's unassigned agent stays hidden; owners keep access to their agent after leaving its workspace. Two limits hold for admins too: naming the *wrong* workspace is still rejected (malformed request, not access denial), and an API key issued by an admin stays confined to its bound workspace, since key requests carry the issuer's role. 19 checks: 4 positive controls, cross-actor requests asserted on `code` not just status (a key missing `logs:read` also 403s), and 3 checks that `GET /logs/agents` — the Logging agent picker — offers each actor exactly the right agents with no secrets. Fixture note: `verifyApiKey` only accepts a key whose issuer is still a member of its workspace, so the owner must be a member. |

## Blocked on

Nothing. The auth helper these were waiting on exists (`lib/auth.sh`); row 5 adds `mint_jwt_for_user` for a non-owner actor, and rows 1, 3, and 5 share `lib/node_call_backend_api.sh`.
