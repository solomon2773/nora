#!/usr/bin/env bash
# Phase 3, test 16: a failing putStorageObject retries, then parks to
# .staging, then re-uploads once the destination recovers.
#
# This test originally surfaced two real bugs, both since fixed:
#
#   1. `retryParkedSegments()` was never scheduled from worker.ts, so a
#      parked segment stayed stranded in .staging forever. worker.ts now
#      calls `segmentWriter.startParkedSegmentRetry()` at boot (30s tick).
#   2. The retry backoff ([500,1000,2000,4000,8000]ms ≈ 15.5s) outlasted the
#      shutdown coordinator's 10s deadline, so a SIGTERM during a remote
#      outage could exit mid-retry and lose the segment outright. The
#      coordinator now calls `segmentWriter.shutdown()`, which cuts the
#      backoff short and parks immediately.
#
# It still checks for and clearly distinguishes three possible outcomes: the
# segment got parked (expected per the plan spec), the segment got lost
# outright (a regression of #2), or it uploaded successfully despite MinIO being
# "down" (a setup race — MinIO wasn't actually unreachable yet when the
# flush attempt reached it; see the widened stop-before-flush gap below).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"

require_confirmation
test_start "segment-writer" "04-retry-and-park"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents

AGENT_ID=""
CONTAINER_NAME=""
ORIGINAL_DEST=""

cleanup() {
  test_trap_incomplete
  compose up -d minio >/dev/null 2>&1 || true
  if [ -n "$ORIGINAL_DEST" ]; then
    log_step "restoring the original storage destination"
    restore_storage_destination "$ORIGINAL_DEST"
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "capturing the current storage destination"
ORIGINAL_DEST="$(capture_storage_destination)"

log_step "pointing the destination at MinIO with real credentials"
set_storage_destination_minio_with_creds

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "retry-park")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

sleep 35  # reconcile attach
sleep 10  # buffer real content

log_step "stopping MinIO BEFORE the flush is attempted"
compose stop minio >/dev/null
sleep 3 # make sure the stop has fully taken effect before triggering the flush

log_step "forcing a flush via SIGTERM while MinIO is down (this may take up to ~15s to observe — see the header comment on why the coordinator's own 10s deadline matters here)"
compose stop -t 20 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"

log_step "checking the outcome: parked, lost, or (racily) uploaded anyway"
staged_files="$(compose exec -T worker-provisioner sh -c 'ls /var/lib/nora-logs/.staging/*.seg 2>/dev/null | wc -l' | tr -d ' ')"
segment_count_immediate="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "staged .seg files: $staged_files, log_segments rows: $segment_count_immediate"

if [ "$staged_files" -eq 0 ] && [ "$segment_count_immediate" -eq 0 ]; then
  test_fail "the segment was LOST OUTRIGHT — neither parked to .staging nor recorded in log_segments. This is a regression of the shutdown/backoff race documented at the top of this script: check that the shutdown coordinator still calls segmentWriter.shutdown() (which cuts retry backoff short and parks immediately) rather than a bare flushAll()."
  exit 0
elif [ "$segment_count_immediate" -gt 0 ]; then
  test_fail "a log_segments row exists even though MinIO was stopped before the flush was triggered — either the stop didn't take effect in time (setup race) or the write is being recorded as successful when it shouldn't be. Re-run with a longer gap between stopping MinIO and forcing the flush if this looks like a timing fluke rather than a real bug."
  exit 0
fi

log_step "parked correctly — bringing MinIO back up to test re-upload"
compose up -d minio >/dev/null
sleep 5 # let it become reachable

log_step "waiting ~30s to see if the parked segment gets re-uploaded on its own"
sleep 30

remaining_staged="$(compose exec -T worker-provisioner sh -c 'ls /var/lib/nora-logs/.staging/*.seg 2>/dev/null | wc -l' | tr -d ' ')"
segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "remaining staged files: $remaining_staged, log_segments rows: $segment_count"

if [ "$remaining_staged" -gt 0 ] && [ "$segment_count" -eq 0 ]; then
  test_fail "the parked segment was never re-uploaded after MinIO recovered — check that worker.ts still calls segmentWriter.startParkedSegmentRetry() at boot, and the worker logs for '[segmentWriter] re-upload of parked segment ... failed'"
else
  test_pass "parked segment re-uploaded automatically once MinIO recovered (remaining_staged=$remaining_staged, segment_count=$segment_count)"
fi
