# Phase 5b — Storage Destination Migration

**Plan doc:** "Phase 5b: Storage Destination Migration" (line 909).

**Objective:** turn a destination change from an instantaneous cutover into
an asynchronous, resumable migration of every previously-written segment,
with an operator-visible keep-or-delete choice for the old copy — gated by the
same installation-wide local capacity budget as live collection (Decision
2c-i).

**Code:** `workers/provisioner/logs/storageMigration.ts`,
`backend-api/routes/observability.ts` (`PUT`/`GET /admin/log-storage*`).

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | A segment is readable from its old location throughout its own migration, and from the new one immediately after | Is there ever a moment mid-migration when a log exists in neither place? | [x] implemented — `05-readable-throughout-migration.sh` | No racing reader needed. The migration's step functions are injectable, so the real MinIO write, real index-row update, and real delete are each wrapped, and the segment is read back through its recorded location the instant each returns — four reads at every boundary a gap could hide in. **Passes:** readable at all four, steps in the safe order. |
| 2 | An interrupted job resumes from `checkpoint` without re-migrating or skipping | If the worker crashes mid-migration, does it pick up exactly where it left off? | [x] implemented — `01-interrupted-job-resumes.sh` | Rewritten. The old version used 2 segments against a 100-segment batch, so it never came near a batch boundary and proved only "an abandoned job resumes." Now: 600 real segments, the live worker drives the job, and the worker is SIGKILLed while the moved count sits strictly inside a batch (confirmed after the fact: segments moved past the checkpoint at the instant of the kill). **Passes:** all 600 on the destination and readable, none skipped or re-migrated, no source copies left, and the completed job reads 600/600. Also asserts moved == credited at the instant of the kill, as a regression check for the bug below. |
| 3 | `keepSourceCopies: false` deletes the old object; `true` keeps it and creates a `log_segment_legacy_copies` row | Does the keep-or-delete choice actually happen? | [x] implemented — `08-keep-source-copies.sh` | Two consecutive real jobs, checked against real storage, not just job status. **Passes:** kept copies stay on disk with one legacy row each carrying the old backend and the segment's own `ts_to` (so they expire on the original window); deleted copies are gone with no legacy row; everything readable on MinIO. |
| 4 | `PUT /admin/log-storage` rejects clearing credentials still needed by a running migration or an unexpired legacy copy | Can you strand data by deleting credentials it still needs? | [x] implemented — `09-credentials-in-use-rejected.sh` | Real HTTP requests with an admin JWT. **Passes:** 409 `log_storage_credentials_in_use` with credentials left intact for an in-flight migration and for an unexpired legacy copy; positive control with only an *expired* legacy copy returns 200 and genuinely clears them (so the guard is conditional, and expired copies don't hold credentials). |
| 5 | `PUT /admin/log-storage` to `local` is rejected with NO side effects when usage + bytes-to-migrate exceeds the cap | Does Nora refuse up front, or start and fail partway? | [x] implemented — `06-local-switch-rejected-over-capacity.sh` | Overflow comes from a synthetic `s3` row larger than the real cap, on the source side, so live collection is never halted. **Passes:** 400 `log_storage_capacity_exceeded`; settings row byte-identical, no job row, no settings-changed event. No positive control performing a real switch (it would migrate other agents' data); the rejection is pinned to its `code` instead. |
| 6 | A running migration to `local` **pauses** (not `failed`) when usage crosses the cap, and live collection halts at the same time | If disk fills mid-migration, does it pause cleanly? | [x] implemented — `04-capacity-pause-restart-resume.sh` | Usage crosses the cap through one synthetic `local` row whose `bytes` equals the stack's real configured cap — capacity is a DB sum, so no `.env` edits or container recreates. **Passes:** paused at its checkpoint after 2 of 6 segments, nothing moved while over cap, `log_storage_migration_paused` recorded, and `log_storage_capacity_halted` recorded for live collection. |
| 7 | A paused migration resumes on its own once usage drops — no operator action | Once space frees up, does it continue by itself? | [x] implemented — same script | After the synthetic usage is removed, nothing calls migration code; the live worker's own resume timer picks it up. **Passes:** resumed from the checkpoint to 6/6, every segment readable on local, MinIO sources gone, `log_storage_capacity_resumed` recorded. |
| 8 | A worker restart while `paused` does not bypass the gate | Does a restart accidentally resume a job while disk is still full? | [x] implemented — same script | Worker restarted while still over cap, then given boot resume plus two resume-timer ticks. **Passes:** still paused, checkpoint and counts unchanged. Only meaningful because row 7 passes: the live worker's resume timer exists only if its boot resume found this job, so row 7 completing proves the restart really re-examined the paused job. |
| 9 | Object-storage destinations never trigger the capacity check or a `paused` status | Is migrating to S3 gated on local disk? | [x] implemented — `07-object-storage-skips-capacity.sh` | Real local data can't be used as synthetic usage here (the migration's source *is* local), so the capacity check is replaced with an always-full spy. A control shows the same spy pauses a migration into local immediately, so a skipped check can't be confused with an unreachable one. **Passes:** 0 gate calls, never paused, all segments readable on MinIO; control paused on its first batch. |
| 10 | Credentials set purely through the UI (no env vars) work end-to-end | Does a UI-configured destination actually get used? | [x] implemented — `02-credential-decryption-regression.sh` | Regression for a bug found earlier. **Passes.** |
| 11 | A `failed` job is retryable after fixing credentials | Can you fix credentials and retry the same migration? | [x] implemented — `03-retry-after-failure-regression.sh` | Regression for a bug found earlier. Calls `retryStorageMigration()` directly; the `POST /admin/log-storage/migration/retry` endpoint's own validation is still unexercised. **Passes.** |

**Result: all 11 rows pass.** Row 2 first failed on a real product bug, now fixed (below).

## Findings

### Fixed: the progress counter undercounted after a mid-batch crash

`migrateSegmentBatch` repoints each segment's index row as soon as that
segment is copied, but used to advance `segments_migrated` (along with
`checkpoint`) only once, at the end of the batch. A worker that died partway
through a batch left the segments it had already copied uncredited. On resume
the batch query correctly skipped them — they no longer matched the source
backend — but nothing added them to the count either.

Observed live: a SIGKILL with 22 segments moved but uncredited produced a
**completed** job reading `segments_migrated = 578 / 600`. No data is lost or
duplicated; the operator-visible progress is simply wrong, and a completed
migration appears to have stopped short.

**Fixed** in `storageMigration.ts`: `migrateOneSegment` now repoints the row
and credits the job in a single statement (a data-modifying CTE), so a crash
lands before or after both, never between. The repoint only fires while the row
is still on its source backend, which keeps the credit idempotent when
`migrateOneSegmentWithRetry` re-runs a segment whose later step (such as
deleting the old copy) failed. Batch-end and failure paths now advance only the
checkpoint. Deriving progress from `log_segments` instead was rejected:
retention can delete segments mid-migration, which would skew that count.

Unit coverage in `storageMigration.test.js`: a mid-batch kill (a write that
never returns stands in for SIGKILL) — confirmed to fail against the original
code with exactly the live symptom — and a retry-credited-once test. The
existing test named "mid-batch" used `batchSize: 1`, so it could only ever
interrupt between batches; it was renamed accordingly, and was the reason the
unit suite never caught this.

### Fixtures must be written as the logs volume's owner

`docker exec` runs as root, but worker-provisioner's app process runs as
uid 1000 and writes owner-only files. The first run of this suite built
fixtures as root, and the live worker then hit `EACCES` on every path a
fixture had created — failing rows 2 and 7 for a reason unrelated to the
product. `lib/segment_fixtures.sh`'s `worker_js` now runs as the volume's
owner (read from the volume, not assumed). Worth remembering for any future
script that writes to `/var/lib/nora-logs` through `node_call`, which still
runs as root.

## Harness

- `lib/segment_fixtures.sh` — builds real segments (NDJSON, zstd, AES-256-GCM
  through `segmentWriter`'s primitives, a real object, a matching row) on
  `local` or MinIO in seconds, and reads them back the way search does. JS
  lives in quoted heredocs with `__PLACEHOLDER__` substitution, avoiding the
  double-quote hazard documented in `lib/node_call_backend_api.sh`.
- `lib/quarantine.sh` — now backend-generic (`quarantine_foreign_segments
  <backend> <ids>`), since migrations *into* local also read from `s3`, and
  this stack has foreign `s3` segments.
- `lib/agent.sh` — `provision_logless_test_agent`: an agent row with no
  container, so the collector adds no segments of its own mid-test.
- `lib/storage_dest.sh` — `set_minio_credentials_keep_backend`, for
  migrations into local that still need to read from MinIO.

## Running these safely on a shared stack

Every migration is installation-wide and the capacity budget is too, so each
script quarantines other agents' segments, and cleanup runs in a deliberate
order: synthetic usage first (it holds the whole stack at capacity), then
every migration job started since the script began — deleted by timestamp, so
a job orphaned by a crashed step can't be driven by the next worker boot —
then the quarantine restore, then the destination. Quarantining happens only
*after* any destination switch, because the switch's restart flushes live
buffers into fresh local segments. Script 04 halts live collection for every
agent on the stack for about a minute, by design; collection resumes from each
agent's last flushed cursor.
