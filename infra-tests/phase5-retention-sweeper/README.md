# Phase 5 — Retention Sweeper, Storage Settings, and Reconciliation

**Plan doc:** "Phase 5: Retention Sweeper, Storage Settings, And
Reconciliation" (line 768).

**Objective:** enforce per-workspace retention under a platform ceiling,
expose the storage destination as a changeable setting, and reconcile
storage against the index so orphaned objects are reclaimed.

**Code:** `workers/provisioner/logs/retentionSweeper.ts`,
`backend-api/platformSettings.ts`, `backend-api/routes/observability.ts`.

**Why this phase gets outsized attention here:** this session found that
`retentionSweeper.startRetentionSweeper()` — which drives the capacity
check, the hourly sweep, AND the daily reconciliation — was fully built
and unit-tested in isolation but **never actually called from
`worker.ts`**. All three loops were dead code in production until that was
fixed mid-session. Unit tests passed the whole time, because they call
`checkCapacityState()`/`sweepExpiredSegments()`/`reconcileStorage()`
directly rather than going through the real boot sequence — which is
exactly the class of gap this suite exists for. Treat this phase as having
had **zero** real-world verification before this suite, not just the
usual "unit tests exist, infra tests add more confidence."

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | Full `ok → halted → resumed` cycle with real data, no restart between the two transitions | As real log storage fills up past the limit, does Nora actually pause collection, tell you clearly it happened, and then automatically resume once space frees up — without you having to do anything? | **[x] implemented** — `01-capacity-halt-resume-cycle.sh` | See the script's own header for why this can't be done by changing the cap twice — restarting to change `NORA_LOG_LOCAL_MAX_BYTES` resets the in-memory state machine, so the halted→resumed leg is driven by dropping usage instead. |
| 2 | `ok → warning` transition (crossing 80% without reaching 100%) | Before storage completely fills up, do you get an early warning (e.g. at 80% full) so there's time to react before collection actually stops? | [ ] planned | Same restart-resets-state constraint applies in reverse here: warning has to be reached from a fresh `ok` on boot, which is easy (like test 1's halted leg), but proving it does NOT then also cross to halted requires a precisely-sized real segment (85% of cap, not 100%+) — doable, just needs care with `bytes` arithmetic against real (not synthetic) segment sizes. Not yet built. |
| 3 | Hourly sweep actually deletes expired segments (object before row) | Do old log segments that are past their retention period actually get deleted — from both the storage location and the database — instead of piling up forever? | **[x] implemented** — `02-hourly-sweep-deletes-expired.sh` | Calls the directly-exported `sweepExpiredSegments()` via `lib/node_call.sh` against a real flushed segment backdated 100 days, checking both the object AND the row are gone afterward. |
| 4 | Daily reconciliation deletes a true orphan | Does Nora clean up "orphaned" files that exist in storage but aren't tracked anywhere? | **[x] implemented** — `03-daily-reconciliation-orphans.sh` | Covers the "true orphan gets deleted" half only — the "never deletes a kept legacy copy" half needs a real migration to set up, so it's covered by Phase 5b's tests instead (cross-referenced in both READMEs). |
| 5 | `DELETE /logs` removes exactly the requested agent/range, plus matching legacy copies, and rejects a range the actor lacks access to | Can an operator manually delete logs for one agent/date-range — and does the system correctly block someone from deleting logs they don't have permission to touch? | [ ] planned | This one needs a real authenticated request (JWT), which none of the other scripts in this suite have needed yet — see Phase 6/7's README for the same gap. Worth building the auth helper once and sharing it across phases 5's item 7b, 6, and 7 rather than duplicating. |
| 6 | A workspace with no `workspace_log_settings` row falls back to the platform ceiling rather than retaining forever | If a workspace never explicitly configured its own retention period, does it fall back to a sane platform default — instead of keeping logs forever by accident? | Covered by unit tests | `retentionSweeper.test.js`, with a fake `db` — no real infra condition changes this fallback-chain logic. Not duplicated here. |
| 7 | `PUT /admin/log-storage` rejects `local` while `k8s` is enabled | Does Nora stop an operator from picking local-disk storage when it's running on Kubernetes agents, which local storage can't actually support? | Covered by unit tests | `observabilityAdmin.test.ts` — pure request-validation logic, no infra condition involved. |

## `lib/node_call.sh` — bypassing HTTP/auth for worker-internal functions

Added after the first pass: `retentionSweeper.ts` and `storageMigration.ts`
both export their real functions directly (`sweepExpiredSegments`,
`reconcileStorage`, `startStorageMigration`, `retryStorageMigration`, ...),
callable from a real, DB-connected Node process inside the
worker-provisioner container WITHOUT going through the HTTP layer at all.
`lib/node_call.sh` makes this practical — it replicates the one line of
the container's own entrypoint that resolves `DB_PASSWORD`/`ENCRYPTION_KEY`
/etc. from their Docker secret files (a plain `docker compose exec node -e`
fails auth, since `exec` doesn't re-run the entrypoint). This unlocked
most of Phase 5's and Phase 5b's core-logic tests without needing a JWT.

## Auth helper — a narrower remaining gap

What `node_call` does NOT unlock: anything testing the HTTP
request-validation layer itself — does `PUT /admin/log-storage` actually
reject a bad request, does `DELETE /logs` actually enforce workspace
role — since that logic lives in the Express route handler, not in a
directly-callable function. `DELETE /logs` (item 5 above), and all of
Phase 6/7, still need a real JWT. A shared `lib/auth.sh` remains the next
thing to build for those specifically.
