# Phase 3 — Segment Writer

**Plan doc:** `plans/logging_control_plane/logging-control-plane-implementation-plan-v2.md`,
"Phase 3: Segment Writer" (line 425).

**Objective:** buffer normalized lines per `(agent, stream)`, flush them as
compressed, encrypted, immutable segments on a 15-minute timer, a size
threshold, or `SIGTERM` — and never on stream end.

**Code:** `workers/provisioner/logs/segmentWriter.ts`,
`workers/provisioner/logs/logStorageConfig.ts`.

**Unit tests:** `workers/provisioner/segmentWriter.test.js` — already covers
flush-trigger logic, `ord` determinism, encryption round-trips, and
buffer-overflow accounting with mocked time and a fake object store. What
it structurally *cannot* cover: whether a real `SIGTERM` sent to the real
process actually reaches the shutdown coordinator in time, whether a real
Docker container restart really reattaches to the same buffer, and whether
a real network failure to S3 really parks-and-retries instead of losing
data. That gap is this directory.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | `SIGTERM` flushes all open buffers before exit | If you gracefully restart the worker (a normal `docker compose restart`), does it save its in-memory logs first — or does it just throw them away? | **[x] implemented** — `01-sigterm-flush.sh` | The single most important test in this phase — without the shutdown coordinator, every graceful `docker compose restart` silently drops up to 15 minutes of logs. |
| 2 | Shutdown proceeds and exits even when a flush exceeds the bounded deadline (~10s), logging a warning rather than hanging | If saving the logs takes too long during shutdown, does the process still exit (with a warning) instead of hanging forever? | [ ] planned | Needs a way to make a flush hang on demand — e.g. block the MinIO port with `iptables`/`docker network disconnect` at the exact moment shutdown begins. Timing-sensitive; lower priority than #1 since the "does the deadline exist at all" half is already unit-tested with fake timers. |
| 3 | Buffer reattachment across an **agent** container restart (not a worker restart) yields one segment spanning the restart, not two | If an agent's container restarts in the middle of a log window, do its logs end up as one continuous piece — or does it get split into two separate, harder-to-search fragments? | **[x] implemented** — `02-reattach-across-agent-restart.sh` | Restarts the test agent's own container mid-window; asserts exactly one `log_segments` row brackets the restart timestamp. |
| 4 | Flush timer is not reset by a reattach, so a crash loop stays bounded at one segment/interval | If an agent is stuck crash-looping, does Nora keep creating a brand-new log segment on every single restart (spam) — or does it stay bounded to one per interval? | [ ] planned | Requires either waiting a real 15 minutes or a test-only timer override — neither is cheap. Documented as a real gap; the logic itself (timer keyed on buffer creation, not reattach) is unit-tested. |
| 5 | Deleting an agent flushes and releases its buffer | If you delete an agent while it still has unsaved logs sitting in memory, do those logs get saved first — or are they just lost? | [ ] planned | Provision a test agent, let it buffer some lines, delete it via the real `DELETE /agents/:id` API (not a raw DB delete — must go through the app's deletion path to trigger the flush), assert a segment landed before the row disappeared. |
| 6 | Capacity gate blocks a new flush once local usage is at/past the cap, with real data (not the synthetic DB row used for manual UI testing this session) | Once local disk storage is full, does Nora actually stop writing new logs to it — using real flushed data, not a fake test row — instead of silently going over the limit? | **[x] implemented** — `03-capacity-gate-real-data.sh` | Lets a real agent emit until it organically crosses a small test cap, confirms the write is skipped rather than parked, and that the stream shows capacity-paused (cross-checked against Phase 4's own capacity-pause test). |
| 7 | Retry-and-park for a remote destination: a `putStorageObject` failure retries, then parks to `.staging`, then re-uploads once the destination recovers | If the connection to remote storage (S3/MinIO) drops mid-write, does Nora retry and hold the data locally until it can upload it — or does it lose the logs? | **[x] implemented — 2 bugs found and fixed** — `04-retry-and-park.sh` | (1) `retryParkedSegments()` was exported but never scheduled; worker.ts now calls `segmentWriter.startParkedSegmentRetry()` at boot (30s tick). (2) The ~15.5s retry backoff outlasted the shutdown coordinator's 10s deadline, so a SIGTERM during an outage could lose the segment outright; the coordinator now calls `segmentWriter.shutdown()`, which cuts backoff short and parks immediately. The script still distinguishes all three outcomes (parked / lost / raced-and-uploaded). See the script's header for detail. |
| 8 | `local` driver does NOT park on a write failure — it surfaces immediately (a disk problem, not a transient network one) | If writing to LOCAL disk fails, does the error show up right away (so someone notices) — rather than Nora quietly stashing it away and hiding the problem? | [ ] planned | Companion to #7 — make a local write fail (e.g. point `localPath` at a read-only mount) and confirm nothing appears in `.staging`. |

Everything else in the plan's Phase 3 test list (byte-identical output
across drivers, `assignOrd` determinism across replay, index-row field
accuracy, global buffer overflow accounting) is pure logic already
exercised by the unit test suite with mocked time/IO — no real infra
condition changes the outcome, so it isn't duplicated here.
