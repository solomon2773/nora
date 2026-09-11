# Phase 5b — Storage Destination Migration

**Plan doc:** "Phase 5b: Storage Destination Migration" (line 909).

**Objective:** turn a destination change from an instantaneous cutover
into an asynchronous, resumable migration of every previously-written
segment, with an operator-visible keep-or-delete choice for the old copy.

**Code:** `workers/provisioner/logs/storageMigration.ts`,
`backend-api/routes/observability.ts` (`PUT`/`GET /admin/log-storage*`).

**Context this session already covered manually, unscripted:** the
MinIO-backed migration UI (destination form, progress panel, retry button)
was built and hand-tested extensively earlier in this session — including
finding and fixing two real bugs (`logStorageConfig()` never decrypting
DB-stored S3 credentials, and the UI never offering a retry path for a
`failed` job). That manual testing is exactly the kind of thing this
directory should turn into repeatable scripts, not leave as one-off
terminal history.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | A segment is readable from its old location throughout its own migration, and from the new location immediately after | While Nora is migrating a batch of logs from one storage location to another, can you still read them the whole time — with no gap where a log briefly exists in neither place? | [ ] planned | Needs a segment large enough (or an artificial delay injected via a test-only `deps.sleep`) that a read can be attempted mid-copy — tight timing window with the real MinIO harness from this session. |
| 2 | An interrupted job resumes from `checkpoint` without re-migrating or skipping | If the migration process crashes halfway through moving log files, does it pick up exactly where it left off — instead of re-copying everything or skipping files? | **[x] implemented, documented limitation** — `01-interrupted-job-resumes.sh` | Inserts a `storage_migration_jobs` row directly with `status='running'` (simulating a job abandoned by a crash) and restarts — the real boot-time `resumeStorageMigration()` discovers and drives it for real. With only 2 test segments (vs. the real 100-segment batch size), this proves "an abandoned running job resumes and completes correctly" rather than specifically "mid-BATCH interruption" — see the script's header for why forcing a true mid-batch interruption wasn't practical to engineer reliably. |
| 3 | `keepSourceCopies: false` deletes the old object; `true` leaves it and creates a `log_segment_legacy_copies` row | When you migrate storage locations, do you get to choose whether the old copies are deleted or kept around as a backup — and does Nora actually honor that choice? | [ ] planned | Partially validated manually this session (local ↔ MinIO round trips with `keepSourceCopies` left at its default) — not yet a scripted, asserted version. |
| 4 | `PUT /admin/log-storage` rejects clearing credentials for a destination still referenced by a running migration or an unexpired legacy copy | Does Nora stop you from deleting the login credentials for a storage location that's still actively in use — mid-migration, or by logs you chose to keep there? | [ ] planned | Needs the auth helper (see Phase 5's README) since this is a `PUT` request, not a DB/container manipulation. |
| 5 | `PUT /admin/log-storage` to `local` is rejected with NO side effects when `localStorageUsage() + segments-to-migrate` exceeds the cap | If you try to migrate all your logs back to local disk but there isn't enough space, does Nora block the change up front — or does it let you start and fail partway through? | [ ] planned | Manually validated this session (see the conversation's capacity-exceeded toast test) — not yet scripted. Straightforward extension of Phase 5's `local_cap.sh` helper plus the auth helper. |
| 6 | A running migration to `local` **pauses** (not `failed`) when usage crosses the cap mid-run, and live collection halts at the same time | If local disk fills up WHILE a migration into it is running, does the migration pause cleanly to resume later — instead of failing outright and needing someone to manually retry it? | [ ] planned | The genuinely interesting case: needs a migration in flight when the cap-lowering restart happens. Since lowering the cap requires a `worker-provisioner` recreate (see Phase 5's README on why), and a migration job's progress lives in Postgres (not in-memory), this one might actually be SAFE across that restart unlike the plain capacity-state singleton — `resumeStorageMigration()` explicitly re-reads job status from the DB on boot. Worth confirming this distinction empirically before assuming either way. |
| 7 | A paused migration resumes automatically once usage drops back under the cap — no separate operator action | Once the disk has space again, does a paused migration pick itself back up on its own? | [ ] planned | Direct extension of #6, same "drop usage via direct deletion" pattern as Phase 5 test 1. |
| 8 | A worker restart while `paused` does not bypass the capacity gate — stays paused if the cap is still exceeded | If the worker restarts while a migration is paused due to full storage, does it correctly stay paused — rather than accidentally resuming even though the disk is still full? | [ ] planned | |
| 9 | Object-storage destinations (`s3`, `r2`) never trigger the capacity check or a `paused` status | Since cloud storage (S3/R2) doesn't have the same space limits as local disk, does migrating there skip the local capacity checks entirely, as it should? | [ ] planned | Cheapest test in this file to build — migrate local → s3 with a tiny cap already exceeded, confirm it proceeds anyway (the check is explicitly local-only). |
| 10 | **The credential-decryption bug found this session** — a real destination change with credentials set purely through the UI (no env vars) must actually work end-to-end | If you set up S3/cloud credentials purely through the settings page (not environment variables), does Nora actually use those saved credentials when it moves your logs there? (This broke once already, this session.) | **[x] implemented** — `02-credential-decryption-regression.sh` | Sets real credentials via the actual `encrypt()` call (mirroring the UI path), confirms `NORA_LOG_S3_*` env vars are genuinely unset, drives a real migration through the live process via the boot-time resume path, and confirms the object is actually retrievable from MinIO afterward — not just that the job status says "completed." |
| 11 | **The retry-after-failure gap found this session** — a `failed` job must be retryable, and re-saving the same destination with fixed credentials must NOT silently no-op | If a migration fails (e.g. bad credentials), can you fix the credentials and retry that SAME migration — or does the retry silently do nothing? (This also broke once already, this session.) | **[x] implemented** — `03-retry-after-failure-regression.sh` | Forces a real failure with genuinely bad credentials, fixes them for real, then calls `retryStorageMigration()` directly (driven synchronously within the same call — see the script's header for why, given `driveMigrationJob`'s fire-and-forget design), and confirms the object lands in MinIO. This specific script tests the function directly rather than the `POST /admin/log-storage/migration/retry` HTTP endpoint, since that still needs the auth helper — a thinner, HTTP-layer-only follow-up is worth adding once that exists. |

Tests 10 and 11 were flagged high priority for the same reason: they're not
hypothetical edge cases from the plan doc — they're regressions that
already happened once, in this exact session. Both are now implemented.

## What unblocked tests 2, 10, and 11

`lib/node_call.sh` (calls `storageMigration.ts`'s exported functions
directly, inside the real worker-provisioner container, with real DB/
encryption-key access) and `lib/storage_dest.sh` (temporarily points the
platform destination at MinIO, capturing/restoring whatever was configured
before) together avoid needing the auth helper for these three — none of
them are testing the HTTP validation layer itself, only the underlying
migration mechanics, which are callable directly. `lib/minio_ctl.sh` wraps
`mc` for confirming an object actually landed where expected.

## What's still needed for the rest

1. The auth helper (see Phase 5's README) — tests 4, 5, and the
   HTTP-endpoint-specific half of test 11 (does `POST
   .../migration/retry` itself work, not just the function it calls)
   genuinely need a `PUT`/`POST /admin/log-storage*` request with a real
   JWT, since they're testing request validation/auth enforcement, not
   underlying mechanics.
2. Tests 1, 3, 6-9 are buildable with what already exists (`node_call` +
   `storage_dest.sh` + `minio_ctl.sh`) — just not yet written.
