#!/usr/bin/env bash
# Phase 5b, test 2: an interrupted migration job resumes from its
# checkpoint on restart, without re-migrating or skipping.
#
# Design note — why this doesn't call `startStorageMigration` through a
# short-lived helper process: `driveMigrationJob` is explicitly
# fire-and-forget (started, never awaited) so the HTTP handler that starts
# a migration can return immediately. That only makes sense when the
# CALLER is the real, long-running worker-provisioner process — a
# short-lived `node_call` invocation would call it, then exit before the
# async work ever runs, silently testing nothing. Instead, this inserts a
# `storage_migration_jobs` row directly with status='running' (simulating
# exactly what a real crash mid-migration leaves behind: a job abandoned
# in 'running' with no process left driving it), then restarts
# worker-provisioner — its own boot sequence calls `resumeStorageMigration()`
# unconditionally (see worker.ts), which discovers the abandoned job and
# drives it for real, in the actual long-running process. This exercises
# the exact same resume path a genuine crash would, without needing HTTP
# or auth to start the migration in the first place.

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
test_start "phase5b-storage-migration" "01-interrupted-job-resumes"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments
cleanup_stale_migration_jobs

AGENT1_ID=""; AGENT1_CONTAINER=""
AGENT2_ID=""; AGENT2_CONTAINER=""
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
  [ -n "$AGENT1_CONTAINER" ] && teardown_test_agent "$AGENT1_ID" "$AGENT1_CONTAINER"
  [ -n "$AGENT2_CONTAINER" ] && teardown_test_agent "$AGENT2_ID" "$AGENT2_CONTAINER"
}
trap cleanup EXIT

log_step "capturing the current storage destination (should be 'local' for this test's setup to make sense)"
warn_if_destination_not_local
ORIGINAL_DEST="$(capture_storage_destination)"

log_step "flushing two real LOCAL segments (across two agents) to migrate"
_A1="$(provision_test_agent "interrupted-1")"
AGENT1_ID="$(echo "$_A1" | sed -n '1p')"; AGENT1_CONTAINER="$(echo "$_A1" | sed -n '2p')"
_A2="$(provision_test_agent "interrupted-2")"
AGENT2_ID="$(echo "$_A2" | sed -n '1p')"; AGENT2_CONTAINER="$(echo "$_A2" | sed -n '2p')"
sleep 35
sleep 10
# Retries on the shutdown coordinator's own documented 10s-deadline race
# (see force_flush_via_sigterm's header) — this flush is setup to get
# segments to migrate, not itself under test.
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id IN ('${AGENT1_ID}','${AGENT2_ID}');" \
  || log_warn "baseline flush never landed after retries — the next check will fail with a clear message"

test_segments_total="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id IN ('${AGENT1_ID}','${AGENT2_ID}') AND storage_backend = 'local';")"
if [ "$test_segments_total" -lt 1 ]; then
  test_fail "expected at least 1 flushed local segment across the two test agents, found $test_segments_total"
  exit 0
fi

# A migration job is platform-wide by design (migrateSegmentBatch has no
# per-agent scope) — it would otherwise migrate EVERY local segment, not
# just this test's, if any other agent (a real dev agent, or leftover
# from another test) also has local segments sitting around. Quarantining
# every OTHER agent's local segments makes them temporarily invisible to
# the job's own query, so segments_total computed right after this is
# guaranteed to equal exactly this test's own count — real isolation, not
# a predicted/tolerated installation-wide number. Restored automatically
# on exit by the cleanup trap regardless of how this script ends.
quarantine_foreign_local_segments "$AGENT1_ID" "$AGENT2_ID"
segments_total="$(db_query "SELECT COUNT(*) FROM log_segments WHERE storage_backend = 'local';")"
log_info "segments_total=$segments_total (should equal test_segments_total=$test_segments_total now that other agents' local segments are quarantined)"

log_step "pointing the destination at MinIO with real credentials (needed for the resumed job to actually succeed)"
set_storage_destination_minio_with_creds

log_step "inserting a storage_migration_jobs row directly, simulating a job abandoned mid-run by a crash"
JOB_ID="$(db_query "
  INSERT INTO storage_migration_jobs (from_backend, to_backend, keep_source, status, segments_total, segments_migrated)
  VALUES ('local', 's3', false, 'running', ${segments_total}, 0)
  RETURNING id;
")"
log_info "job_id=$JOB_ID status=running (abandoned, nothing currently driving it)"

log_step "restarting worker-provisioner — its boot sequence should discover and resume this job"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"

log_step "waiting up to 30s for the resumed job to complete"
waited=0
job_status="running"
while [ "$waited" -lt 30 ]; do
  job_status="$(db_query "SELECT status FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
  [ "$job_status" = "completed" ] || [ "$job_status" = "failed" ] && break
  sleep 2
  waited=$((waited + 2))
done

segments_migrated="$(db_query "SELECT segments_migrated FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
test_migrated_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id IN ('${AGENT1_ID}','${AGENT2_ID}') AND storage_backend = 's3';")"
log_info "final job_status=$job_status segments_migrated=$segments_migrated (expected $segments_total installation-wide), this test's own rows now on s3=$test_migrated_count (expected $test_segments_total)"

if [ "$job_status" != "completed" ]; then
  test_fail "job did not reach 'completed' within 30s of the restart (status=$job_status) — resumeStorageMigration() may not be discovering/driving abandoned 'running' jobs correctly"
elif [ "$segments_migrated" -ne "$segments_total" ]; then
  test_fail "segments_migrated ($segments_migrated) does not match the installation-wide total ($segments_total) on a completed job"
elif [ "$test_migrated_count" -ne "$test_segments_total" ]; then
  test_fail "expected exactly $test_segments_total of this test's own segment(s) now recorded as storage_backend='s3', found $test_migrated_count — possible duplicate or missed migration for this test's own data specifically"
else
  test_pass "abandoned 'running' job was picked up on restart and completed correctly: $segments_migrated/$segments_total migrated installation-wide, including this test's own $test_migrated_count/$test_segments_total, no duplicates"
fi
