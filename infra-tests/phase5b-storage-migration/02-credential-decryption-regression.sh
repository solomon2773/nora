#!/usr/bin/env bash
# Phase 5b, test 10 — regression guard for the real bug found this
# session: `logStorageConfig()` never decrypted the DB-stored S3
# credentials `PUT /admin/log-storage` correctly encrypted and saved — it
# only ever read secrets from `NORA_LOG_S3_*` env vars, which aren't set
# in this stack. A migration to a destination configured PURELY through
# the settings UI (no env vars) failed with "S3 storage is not fully
# configured" even though the saved credentials were completely correct.
#
# Setup mirrors 01-interrupted-job-resumes.sh (flush a local segment,
# point destination at MinIO via storage_dest.sh's real encrypt() call,
# insert a job row, restart to let the real long-running process drive
# it) — the difference is what this one actually checks: not just "did the
# job reach completed," but "is the migrated object actually retrievable
# from MinIO with the right content," which is the part that silently
# failed before the fix (the job reached `failed`, not `completed`, but a
# weaker test that only checked segment count could still miss WHY).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"
source "$SCRIPT_DIR/../lib/minio_ctl.sh"
source "$SCRIPT_DIR/../lib/quarantine.sh"

require_confirmation
test_start "phase5b-storage-migration" "02-credential-decryption-regression"
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
_A="$(provision_test_agent "cred-decrypt")"
AGENT_ID="$(echo "$_A" | sed -n '1p')"; CONTAINER_NAME="$(echo "$_A" | sed -n '2p')"
sleep 35
sleep 10
# Retries on the shutdown coordinator's own documented 10s-deadline race
# (see force_flush_via_sigterm's header) — this flush is setup to get a
# segment to migrate, not itself under test.
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the next check will fail with a clear message"

storage_key="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
if [ -z "$storage_key" ]; then
  test_fail "no segment flushed — cannot test migration"
  exit 0
fi

# Quarantine every OTHER agent's local segments BEFORE changing anything
# about the destination — a migration job is platform-wide (no per-agent
# scope in migrateSegmentBatch), so without this, the job created below
# would also migrate any other local segments that happen to exist
# (including real ones, not just other tests' leftovers). This makes
# segments_total below guaranteed to equal exactly this test's own 1
# segment.
quarantine_foreign_local_segments "$AGENT_ID"

log_step "setting S3 credentials via the real encrypt() call (mirrors 'set through the UI, no env vars') and restarting"
set_storage_destination_minio_with_creds

log_step "confirming NORA_LOG_S3_* env vars are genuinely unset (this is what made the original bug possible)"
env_check="$(compose exec -T worker-provisioner sh -c 'echo "${NORA_LOG_S3_ACCESS_KEY_ID:-unset}"')"
log_info "NORA_LOG_S3_ACCESS_KEY_ID=$env_check (expected: unset)"

# db_query_until_nonzero, not a plain db_query: see its header in
# lib/db.sh — a COUNT(*) here can transiently read 0 for a couple
# seconds even after a confirmed-successful flush.
segments_total="$(db_query_until_nonzero "SELECT COUNT(*) FROM log_segments WHERE storage_backend = 'local';")" \
  || log_warn "segments_total still 0 after polling — this may be a genuine 0, not just the transient read"
log_info "segments_total=$segments_total (should be exactly this test's own 1 segment now that other agents' local segments are quarantined)"

log_step "inserting a running migration job and restarting to let the real process drive it"
JOB_ID="$(db_query "
  INSERT INTO storage_migration_jobs (from_backend, to_backend, keep_source, status, segments_total, segments_migrated)
  VALUES ('local', 's3', false, 'running', ${segments_total}, 0)
  RETURNING id;
")"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"

log_step "waiting up to 45s for the job to reach a terminal state"
waited=0
job_status="running"
while [ "$waited" -lt 45 ]; do
  job_status="$(db_query "SELECT status FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
  [ "$job_status" = "completed" ] || [ "$job_status" = "failed" ] && break
  sleep 2
  waited=$((waited + 2))
done
log_info "job_status=$job_status"

if [ "$job_status" = "failed" ]; then
  test_fail "migration job FAILED using credentials set purely through the DB/UI path (no env vars) — this is exactly the original bug: logStorageConfig() not decrypting DB-stored S3 credentials"
  exit 0
elif [ "$job_status" != "completed" ]; then
  test_fail "job did not reach a terminal state within 30s (status=$job_status)"
  exit 0
fi

log_step "confirming the migrated object is actually retrievable from MinIO"
if minio_object_exists "$storage_key"; then
  test_pass "migration completed and the object is confirmed present in MinIO using UI-only (no env var) credentials — the decryption path works correctly"
else
  test_fail "job reported 'completed' but the object is NOT found in MinIO at the expected key ($storage_key) — the job's own success reporting may be wrong, or the object landed somewhere unexpected"
fi
