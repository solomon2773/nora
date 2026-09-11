# Phase 4 — Container Log Collector

**Plan doc:** "Phase 4: Container Log Collector" (line 646).

**Objective:** maintain one live follow stream per running agent, feed the
segment writer, and survive restarts, reconnects, and workspace
reassignment.

**Code:** `workers/provisioner/logs/logCollector.ts`,
`workers/provisioner/backends/docker.ts` (`tail`-default fix),
`workers/provisioner/backends/k8s.ts` (same).

**Unit tests:** `workers/provisioner/logCollector.test.js` covers the
reconcile diff, tenant resolution, and null-handling logic against a fake
`containerManager`. It cannot verify that a real crash-and-restart actually
replays from the real Docker log retention without loss — that's a claim
about Docker's own behavior interacting with Nora's cursor logic, not
something a fake stream can stand in for.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | **Killing the worker mid-window loses no lines** — a real `SIGKILL`, real restart, real Docker log replay | If the whole worker process crashes (not just gracefully stops) while it's collecting an agent's logs, do you lose any log lines once it comes back up? | **[x] implemented** — `01-worker-kill-midwindow.sh` | The highest-priority test in the whole suite. Documented limitation: this run crashes the worker before any flush has ever happened for the agent, so it's validating "replay from an empty cursor loses nothing," not "replay from a real prior flushed cursor loses nothing" — the latter needs either a real 15-minute wait or a test-only flush trigger. See the script's own header comment. |
| 2 | Reconnect doesn't re-ingest duplicate lines (regression guard for the `tail \|\| 100` default that used to silently re-fetch the last 100 lines on every reconnect) | When the collector reconnects to an agent's log stream, does it avoid re-reading and duplicating lines it already saved? | **[x] implemented** — `02-reconnect-no-duplicates.sh` | Decrypts/decompresses the real flushed segment and checks the deterministic "infra-test line N" content for repeated numbers — not just a line-count check, an actual content-identity check. |
| 3 | The live WebSocket viewer's behavior is unchanged (`attachLogStream` still gets the last 100 lines on connect via an explicit `tail: 100`) | Does the live "tail -f"-style log viewer in the browser still show the last 100 lines on connect, even after the reconnect-duplicate fix above? | [ ] planned | This one actually IS reachable through the browser/API rather than needing chaos conditions — connect to `/api/ws/logs/:agentId` and count the initial burst. Borderline e2e territory; flagging for a decision on whether it belongs here or in Playwright instead. |
| 4 | A capacity-paused stream is disconnected, not held open buffering unboundedly | Once local storage hits capacity, does the collector actually stop pulling new logs from the agent — instead of endlessly buffering data it can't save anyway? | [ ] planned | Reuses Phase 3 test 3's cap-lowering technique; the new assertion here is on the *collector* side — confirm `logCollector`'s held-stream count actually drops (no open follow connection) rather than just confirming no new segment. |
| 5 | Capacity clearing lets the reconciler re-attach on its own next tick, no manual action | Once you free up disk space, does log collection start again on its own — or does someone have to manually restart it? | [ ] planned | Direct continuation of #4 — raise the cap back, wait one more 30s tick, confirm reattachment and correct `since` cursor. |
| 6 | A `null` from `containerManager.logs()` doesn't retry-storm | If an agent's container isn't available yet, does the collector fail quietly and try again on its next tick — instead of spamming retries/errors? | **[x] implemented, adapted scope** — `03-null-logs-no-retry-storm.sh` | Found on a second read-through: `DockerBackend.logs()` never actually returns `null` — it either succeeds or throws (a literal `null` return is K8s-adapter/base-adapter-only, unreachable with a Docker-backed test agent). Rewritten to remove the container entirely while `agents.status` stays `'running'`, so the collector's `try/catch` around a thrown attach error is what's actually exercised — the same graceful-degradation code path, reached the way a Docker-backed agent can actually reach it. See the script's header for the full correction (an earlier version tested something else by accident: taking the agent out of the reconciler's desired set entirely). |
| 7 | The tenant is resolved once per stream attach, not per line | Does Nora look up which workspace an agent belongs to just once when it connects, instead of re-checking on every single log line (which would be wasteful)? | Covered by unit tests (mocked call-count assertion) | No infra-level condition changes this — pure logic, not touched here. |
| 8 | An agent with no workspace membership writes under `user_<userId>/` | If an agent doesn't belong to any workspace, do its logs still get filed correctly under its owner's own storage prefix, instead of getting lost or misfiled? | Partially covered | `provision_test_agent` already creates agents with no workspace row, so any test using it exercises this path implicitly. No dedicated script needed unless a workspace-scoped variant is wanted later. |

## A note on timing

Every script here waits ~35s after an attach-relevant change for the
collector's 30s reconcile tick to actually run (with margin). If you're
iterating on one of these scripts, that's the dominant wall-clock cost —
there's no faster path without adding a test-only "reconcile now" trigger
to `logCollector.ts` itself, which isn't currently exposed.
