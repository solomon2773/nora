#!/usr/bin/env bash
# Phase 5b, test 11 — regression guard for the real bug found this
# session: after a migration FAILED (e.g. bad credentials), fixing the
# credentials and re-saving the SAME destination via `PUT
# /admin/log-storage` silently did nothing — that endpoint only starts a
# new migration when the destination BACKEND actually changes, but it
# already reads as changed (the settings row is written before the
# migration is even attempted). The fix was `retryStorageMigration()` +
# `POST /admin/log-storage/migration/retry`, which re-drives the failed
# job from its own checkpoint. This test exercises `retryStorageMigration`
# directly.
#
# Driving note: `retryStorageMigration()`'s own internal drive
# (`driveMigrationJob`) is fire-and-forget, same issue as the other two
# scripts in this directory — but unlike those, there's no HTTP endpoint
# this test can lean on to run it in the real long-running process (the
# real retry endpoint needs a JWT). So this calls `retryStorageMigration`
# with `{ autoAdvance: false }` and then drives it to completion manually,
# via a `migrateSegmentBatch` loop, all within the SAME node_call
# invocation — avoiding the fire-and-forget problem by never actually
# forking off background work outside what this script awaits itself.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"
source "$SCRIPT_DIR/../lib/minio_ctl.sh"
source "$SCRIPT_DIR/../lib/quarantine.sh"

require_confirmation
test_start "phase5b-storage-migration" "03-retry-after-failure-regression"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments
cleanup_stale_migration_jobs

AGENT_ID=""; CONTAINER_NAME=""
ORIGINAL_DEST=""
JOB_ID=""

cleanup() {
  test_trap_incomplete
  restore_quarantined_local_segments
  if [ -n "$JOB_ID" ]; then
    db_exec "DELETE FROM storage_migration_jobs WHERE id = '${JOB_ID}';" >/dev/null 2>&1 || true
  fi
  if [ -n "$ORIGINAL_DEST" ]; then
    restore_storage_destination "$ORIGINAL_DEST"
  fi
  [ -n "$CONTAINER_NAME" ] && teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
}
trap cleanup EXIT

log_step "capturing the current storage destination"
warn_if_destination_not_local
ORIGINAL_DEST="$(capture_storage_destination)"

log_step "flushing one real LOCAL segment to migrate"
_A="$(provision_test_agent "retry-regress")"
AGENT_ID="$(echo "$_A" | sed -n '1p')"; CONTAINER_NAME="$(echo "$_A" | sed -n '2p')"
sleep 35
sleep 10
# Retries on the shutdown coordinator's own documented 10s-deadline race
# (see force_flush_via_sigterm's header) — confirmed via a live repro
# during this suite's development (worker-provisioner logged "[shutdown]
# flushAll did not complete within 10000ms — exiting anyway") that this
# exact setup step was the real cause of this test's segments_total=0
# mystery, not a display-only quirk. This flush is setup to get a segment
# to migrate, not itself under test.
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the next check will fail with a clear message"

storage_key="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
if [ -z "$storage_key" ]; then
  test_fail "no segment flushed — cannot test migration"
  exit 0
fi

# Quarantine every OTHER agent's local segments before touching the
# destination or creating a job — a migration job is platform-wide (no
# per-agent scope in migrateSegmentBatch), so without this, the job below
# would also migrate/attempt any other local segments that happen to
# exist (including real ones, and including segments left over from
# 01/02 if this script runs after them in the same suite run). This
# makes segments_total guaranteed to equal exactly this test's own 1
# segment, so the "reached failed with bad credentials" assertion below
# is actually exercised against real work, not a trivial no-op job with
# nothing to migrate.
quarantine_foreign_local_segments "$AGENT_ID"
# db_query_until_nonzero, not a plain db_query: see its header in
# lib/db.sh — a COUNT(*) here can transiently read 0 for a couple
# seconds even after a confirmed-successful flush.
segments_total="$(db_query_until_nonzero "SELECT COUNT(*) FROM log_segments WHERE storage_backend = 'local';")" \
  || log_warn "segments_total still 0 after polling — this may be a genuine 0, not just the transient read"
log_info "segments_total=$segments_total (should be exactly this test's own 1 segment now that other agents' local segments are quarantined)"

log_step "pointing destination at MinIO with WRONG credentials, to force a real failure"
db_exec "UPDATE platform_settings SET
    log_storage_backend = 's3',
    log_storage_s3_bucket = '${MINIO_BUCKET:-nora-logs-local}',
    log_storage_s3_region = 'us-east-1',
    log_storage_s3_endpoint = 'http://minio:9000',
    log_storage_s3_access_key_id_encrypted = NULL,
    log_storage_s3_secret_access_key_encrypted = NULL
  WHERE singleton = TRUE;" >/dev/null
compose up -d worker-provisioner backend-api >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy, continuing"

log_step "inserting a running migration job and restarting so it fails for real"
JOB_ID="$(db_query "
  INSERT INTO storage_migration_jobs (from_backend, to_backend, keep_source, status, segments_total, segments_migrated)
  VALUES ('local', 's3', false, 'running', ${segments_total}, 0)
  RETURNING id;
")"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"

waited=0
job_status="running"
while [ "$waited" -lt 20 ]; do
  job_status="$(db_query "SELECT status FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
  [ "$job_status" = "failed" ] && break
  sleep 2
  waited=$((waited + 2))
done
log_info "job_status after forced-bad-credentials attempt: $job_status"

if [ "$job_status" != "failed" ]; then
  test_fail "expected the job to reach 'failed' with no credentials configured, got '$job_status' — cannot proceed with the retry assertion"
  exit 0
fi

log_step "fixing credentials for real, WITHOUT touching the job row (this is the exact scenario: fix creds, then retry the SAME failed job)"
set_storage_destination_minio_with_creds

log_step "calling retryStorageMigration() directly, driving it to completion manually within this one call"
retry_output="$(node_call "
  const { retryStorageMigration, migrateSegmentBatch } = require('./logs/storageMigration.ts');
  (async () => {
    const result = await retryStorageMigration({ autoAdvance: false });
    console.log('RETRY_STARTED jobId=' + result.jobId);
    let outcome = { done: false };
    let guard = 0;
    while (!outcome.done && guard < 20) {
      outcome = await migrateSegmentBatch(result.jobId);
      guard += 1;
    }
    console.log('FINAL_STATUS ' + outcome.status);
    process.exit(outcome.status === 'completed' ? 0 : 1);
  })().catch((e) => { console.error('RETRY_ERR ' + e.message); process.exit(1); });
")"
log_info "retry_output: $retry_output"

final_status="$(db_query "SELECT status FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
segments_migrated="$(db_query "SELECT segments_migrated FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
this_agent_on_s3="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND storage_backend = 's3';")"
log_info "final job status=$final_status segments_migrated=$segments_migrated (expected $segments_total installation-wide), this test's own agent on s3=$this_agent_on_s3 (expected 1)"

if [ "$final_status" != "completed" ]; then
  test_fail "retryStorageMigration did not bring the job to 'completed' after credentials were fixed (final status=$final_status) — the retry mechanism itself may be broken again"
elif [ "$segments_migrated" -ne "$segments_total" ]; then
  test_fail "job completed but segments_migrated=$segments_migrated, expected $segments_total (installation-wide total)"
elif [ "$this_agent_on_s3" -ne 1 ]; then
  test_fail "job completed but this test's own agent has $this_agent_on_s3 segment(s) recorded as storage_backend='s3', expected exactly 1"
elif ! minio_object_exists "$storage_key"; then
  test_fail "job completed and reports this test's segment migrated, but the object is not actually present in MinIO"
else
  test_pass "the failed job was successfully retried after fixing credentials, reached 'completed' ($segments_migrated/$segments_total installation-wide), and this test's own object is confirmed in MinIO — the retry mechanism works"
fi
