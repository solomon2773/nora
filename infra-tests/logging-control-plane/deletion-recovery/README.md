# Phase 5c — Deletion And Log Recovery

**Plan doc:** "Phase 5c: Deletion And Log Recovery" (line 1022).

**Objective:** let an operator choose, at agent or workspace deletion time,
whether logs are deleted with it or kept — and give kept logs a real
(admin-only) way back, since the normal `/app/logs` access model stops
working the moment the agent or workspace it depends on is gone.

**Code:** `backend-api/routes/agents.ts` (delete handler,
`requireDeleteLogsFlag`), `backend-api/routes/workspaces.ts` (delete
handler), `backend-api/routes/admin.ts` (`/log-recovery`,
`/log-recovery/:id/logs`, `/log-recovery/:id/export`,
`/log-recovery/:id` purge), `workers/provisioner/logs/logDeletion.ts`
(`deleteAgentLogs`, `deleteWorkspaceLogs`, `snapshotDeletedLogOwner`,
`purgeDeletedLogOwner`, `listRecoveredLogLines`,
`collectAllRecoveredLogLines`, `purgeAllLogsByColumn`),
`admin-dashboard/pages/log-recovery.tsx`.

**Unit tests:** both files referenced in the plan doc exist in this
worktree. `backend-api/__tests__/logDeletion.test.ts` ("Phase 5c:
deleteLogs contract" describe blocks) covers the route-level contract with
mocked DB calls: `deleteAgentLogs` scoping to one agent,
`deleteWorkspaceLogs` scoping by `workspace_id`,
`snapshotDeletedLogOwner` creating a `deleted_log_owners` row with a
resolved retention snapshot while leaving segments untouched,
`purgeDeletedLogOwner` removing segments/spans/the row itself, and a
404-shaped error for an unknown id. `workers/provisioner/logDeletion.test.js`
covers the same core logic against more realistic fixtures: sibling-agent
isolation on delete, workspace-scoped deletion (not membership
enumeration), retention-days resolution from `workspace_log_settings` (and
the platform-ceiling fallback when an agent has no workspace), the
retention snapshot surviving `workspace_log_settings` being deleted
afterward, full purge (segments + spans + legacy copies + the owner row),
`listRecoveredLogLines`/`collectAllRecoveredLogLines` decrypting and
paging real segment data, the retention sweeper expiring a
`deleted_log_owners` entry via its snapshotted retention scoped by
`agent_id`, and that `purgeAllLogsByColumn` is the one purge core every
call site (delete-true, `deleteWorkspaceLogs`, manual purge) shares. Both
suites use mocked/in-process DB and storage, not a real running stack.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Deleting an agent or workspace without `deleteLogs` is rejected with 400 | Does the API (and the dashboard delete flow that calls it) refuse a delete request that doesn't explicitly say whether to keep or delete logs, instead of silently picking a default? | Covered by unit tests | Pure request-validation logic (`requireDeleteLogsFlag`) — no infra condition changes this outcome. Already exercised in `backend-api/__tests__/logDeletion.test.ts` and would be redundant against a real stack. |
| 2 | `GET /admin/log-recovery` requires platform-admin and lists only kept (not deleted) entries | Can a non-admin reach the recovery list, and does a `deleteLogs: true` deletion ever show up in it? | Probably belongs in `backend-api/__tests__/` instead | Auth gating and query-shape concerns, well-suited to a normal Express+DB integration test (real app, real DB, mocked nothing but the JWT) — no chaos/infra condition changes this outcome. |
| 3 | `deleteLogs: true` removes segments, spans, and legacy copies for the deleted agent via a real async worker-provisioner job; a sibling agent in the same workspace is untouched | Against a real running stack (not mocked DB calls), does the async cleanup job that `DELETE /agents/:id` enqueues actually finish and clean up the right rows/objects, leaving everything else alone? | **[x] implemented** — `01-agent-delete-true-removes-logs.sh` | **Real bug in this row's own description, not in the product:** there is no "enqueued worker-provisioner job." Reading `backend-api/routes/agents.ts`'s `destroyAgent()` shows `logDeletion.deleteAgentLogs(agent.id)` is called directly, fire-and-forget, IN BACKEND-API'S OWN PROCESS — `workers/provisioner/logs/logDeletion.ts` is required directly via a relative path (the same shared-mount pattern the backend adapters use), never dispatched to a queue. The script polls `log_segments`/`agent_spans` row counts directly instead of a job row for that reason. Provisions two independent (not same-workspace) test agents — `deleteAgentLogs` scopes strictly by `agent_id`, so workspace co-membership adds no additional isolation surface to exercise. **Could not be run to a live pass on this dev machine**: `DELETE /agents/:id` 500s with `Container cleanup error: connect EACCES /var/run/docker.sock` — a pre-existing, already-documented Docker-socket-permission gap for backend-api on Docker Desktop for Mac (see `docker-compose.override.yml`'s comment on the `worker-provisioner` service's `user: "0:0"` workaround, which backend-api doesn't have). Validated by code reading + confirming real JWT/route wiring instead (see the script's header for the full account) — not a Phase 5c defect. |
| 4 | `deleteAgentLogs`/`deleteWorkspaceLogs` surviving a worker-provisioner crash mid-job leaves no orphaned objects and no orphaned rows | If worker-provisioner is killed partway through the object-then-row deletion order, does a retry (or the next reconciliation pass) still land in a consistent state — never a segment row pointing at an object that's already gone, and never an object left behind with no row referencing it? | [ ] planned | Still not attempted, now for a sharper reason than "no reliable kill hook": per row #3's finding, `deleteAgentLogs` runs in BACKEND-API's process, not worker-provisioner's — so this test's premise ("SIGKILL worker-provisioner mid-job") targets the wrong process entirely. The real crash-consistency question is what happens if BACKEND-API is killed between `purgeAllLogsByColumn`'s object-delete and row-delete steps — a `SIGKILL` timed into that specific window in backend-api's request-handling process, which has no equivalent to worker-provisioner's shutdown-coordinator instrumentation to hook a reliable pause off of. Flagging as a strong candidate for a follow-up once the target process is corrected; not attempted here as a stub, per this suite's own rule against faking a pass. |
| 5 | `deleteLogs: false` leaves segments and spans intact and creates a matching `deleted_log_owners` row with a correct `retention_days` snapshot | Does choosing "keep" against a real running stack actually leave the real segment/span rows and objects alone, and record the right retention window at the moment of deletion? | **[x] implemented** — `02-agent-delete-false-snapshots-logs.sh` | Unlike #3, `snapshotDeletedLogOwner` is awaited synchronously before the agent row delete (see `destroyAgent()`), so there's no polling needed — a 200 response means the snapshot is already there. Same live-environment blocker as #3 (`DELETE /agents/:id` 500s on this machine's docker.sock permission gap) prevented an actual pass here too — see the script's header. |
| 6 | A workspace deleted with `deleteLogs: false`: `workspace_log_settings` can subsequently be deleted without affecting the already-snapshotted retention | Once a workspace's retention snapshot is taken, does deleting the now-orphaned `workspace_log_settings` row (e.g. via a later cleanup pass) leave the snapshot's `retention_days` unaffected? | Covered by unit tests | `workers/provisioner/logDeletion.test.js` already asserts this directly ("retention snapshot survives workspace_log_settings being gone afterward") against real DB fixtures in-process; no distinct infra condition (crash, network, timing) changes this outcome, so a live-stack repeat wouldn't add coverage. |
| 7 | `/app/logs` returns nothing for a deleted agent/workspace regardless of the keep/delete choice | After either deletion path, does the normal operator-facing logs UI correctly show nothing for the now-gone agent/workspace — instead of erroring or, worse, still serving logs through a stale reference? | Probably belongs in `backend-api/__tests__/` or `e2e/` instead | An access-control/routing check (does the normal live-access code path correctly 404/empty once the owning row is gone) rather than something that needs real infra to observe — a normal API or Playwright test against a real-but-small dataset covers it fine. |
| 8 | Kept logs expire on their snapshotted retention window via the normal sweeper, reached through `deleted_log_owners` | Does the retention sweeper that already runs hourly actually walk `deleted_log_owners` rows too, and expire their segments at the right time using the value snapshotted at deletion (not whatever the live default is now)? | [ ] planned | Same shape as the full suite's Phase 5 retention-sweeper tests (see `logging-integration/infra-tests/retention-sweeper/`) — needs `lib/local_cap.sh`/`lib/node_call.sh`-equivalent real sweeper invocation against a real `deleted_log_owners` row with a short retention window, confirming segments are actually gone afterward. `workers/provisioner/logDeletion.test.js` covers the sweeper's expiry logic with mocked time; this would confirm the real hourly/scheduled path actually calls into that logic for recovered-log rows the way `worker.ts` wires it (the same class of "implemented but never actually called" bug the full suite's README calls out finding once already). |
| 9 | Manual purge from the admin recovery view removes segments, spans, legacy copies, and the `deleted_log_owners` row itself | Does clicking "purge permanently" in the admin dashboard (or calling the endpoint directly) against real data actually remove everything, leaving no orphaned objects or rows? | **[x] implemented** — `03-manual-purge-from-recovery-view.sh` | Also asserts a non-admin user is refused with a non-200 before trusting the admin call's 200 — a real check that `requireAdmin` is actually gating the route, not just that a purge which happened to be called by an admin worked. Setup depends on the same `DELETE /agents/:id` path as #3/#5, so it hit the same live-environment docker.sock blocker on this machine — see the script's header. The purge call itself and its admin gating were validated by code reading against `logDeletion.ts`'s `purgeDeletedLogOwner` and `middleware/auth.ts`'s `requireAdmin`, plus a live confirmed 200 from `GET /admin/log-recovery` with a real admin JWT (proving `lib/auth.sh`'s `mint_jwt platform_admin` → real `role='admin'` DB user → real accepted token chain works end-to-end). |

## Blocked on

The auth helper now exists (`infra-tests/lib/auth.sh`, built as part of
this work — see its header for the `mint_jwt`/`authed_curl` contract and
the real `users.role = 'admin'` vs. the "platform_admin" naming used in
this README/the plan doc). #4 still needs a way to reliably pause or kill
the right process mid-purge — and per its updated Notes above, the right
process turns out to be backend-api, not worker-provisioner, which changes
what that hook needs to look like.

**A live-environment blocker found while building #3/#5/#9's scripts,
not a Phase 5c defect:** on this dev machine, the real `DELETE
/agents/:id` call (both scripts' setup step) 500s with `Container cleanup
error: connect EACCES /var/run/docker.sock`. `docker-compose.override.yml`
already documents this exact class of problem for `worker-provisioner`
("LOCAL-ONLY WORKAROUND — do not commit. Docker Desktop for Mac's
docker.sock is owned root:root in its Linux VM, but setup.sh's
resolve_docker_gid can only stat the macOS-side symlink, which reports an
unrelated GID... The proper fix belongs in setup.sh") and gives that
service `user: "0:0"` to sidestep it — but `backend-api`, which is what
actually calls `containerManager.destroy()` on agent delete, was never
given the same fix. All three scripts were written and statically
verified (`bash -n`, and direct comparison against `destroyAgent()`/
`logDeletion.ts`'s real source) but could not be driven to a live pass on
this exact machine as a result. They should run straight through on a
host where `DOCKER_GID` resolves correctly (Linux, or a macOS `setup.sh`
patched the way that comment describes).

**A second, more serious finding from actually running these scripts
live: this worktree's docker-compose project is NOT isolated from other
worktrees.** `COMPOSE_PROJECT_NAME=nora` is hardcoded identically in this
worktree's `.env` AND in `logging-integration`'s `.env` — `docker compose
ls` during this session showed exactly one `nora` project, bound to
`logging-integration`'s compose files, while THIS worktree's scripts were
issuing `docker compose` commands (via `lib/docker_ctl.sh`, unchanged from
the reference) against the same named project using a possibly-different
config. Running `01-agent-delete-true-removes-logs.sh` once caused Compose
to detect config drift and recreate `postgres`/`redis`/`backend-api`/
`worker-provisioner` out from under whatever was already running — and
mid-session, another agent's `infra-test-retry-regress-*` container and
DB row (from what looks like `logging-integration`'s
`storage-migration/03-retry-after-failure-regression.sh`) was
observed live in `docker ps`/the `agents` table, confirming a concurrent
session was actively using the exact same containers at the same time.
This is a real, unresolved cross-worktree hazard for the whole infra-tests
suite as designed (not specific to Phase 5c/14) — running these scripts
from more than one worktree checkout at once against the shared dev stack
can corrupt or disrupt a concurrent run's state. Worth a real fix (e.g. a
per-worktree `COMPOSE_PROJECT_NAME`) before this suite is used by more
than one agent/session at a time; flagged here rather than silently
worked around, and further live destructive runs in this session were
deliberately curtailed once this was discovered.
