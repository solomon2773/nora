#!/usr/bin/env bash
# Phase 3, test 22 (capacity gate) — with REAL flushed data, not the
# synthetic log_segments row used for manual UI testing earlier this
# session. That row was a legitimate way to test the *reporting* path
# (capacity.state, the admin banner); this test exercises the *write*
# path itself — segmentWriter.ts's checkLocalCapacity() consulted before
# a flush is admitted, which the synthetic-row approach never touched at
# all (it never went through a real flush).
#
# Sequence: flush one real segment to establish genuine local usage, lower
# the cap below that usage, then prove a SECOND flush attempt for the same
# agent is skipped (not parked, not retried — skipped) rather than
# silently succeeding past the cap.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/local_cap.sh"

require_confirmation
test_start "segment-writer" "03-capacity-gate-real-data"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""
ORIGINAL_CAP=""

cleanup() {
  test_trap_incomplete
  if [ -n "$ORIGINAL_CAP" ]; then
    log_step "restoring NORA_LOG_LOCAL_MAX_BYTES=$ORIGINAL_CAP"
    restore_local_cap_bytes "$ORIGINAL_CAP"
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "capacity-gate")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for reconcile to attach"
sleep 35
log_step "letting it emit for 10s, then forcing a real flush via SIGTERM (retries on the shutdown coordinator's own documented 10s-deadline race — see force_flush_via_sigterm's header — since this is establishing the BASELINE, not the thing under test)"
sleep 10
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the next check will fail with a clear message"

first_segment_bytes="$(db_query "SELECT COALESCE(SUM(bytes),0) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
if [ "$first_segment_bytes" -le 0 ]; then
  test_fail "no real segment got flushed to establish a baseline — cannot proceed with the capacity-gate assertion"
  exit 0
fi
log_info "baseline real local usage from this segment: ${first_segment_bytes} bytes"

log_step "lowering NORA_LOG_LOCAL_MAX_BYTES below that usage"
ORIGINAL_CAP="$(set_local_cap_bytes $((first_segment_bytes - 1)))"
log_info "cap set to $((first_segment_bytes - 1)) (was $ORIGINAL_CAP)"

log_step "waiting ~35s for reconcile to reattach post-restart, then letting it emit for 10s more"
sleep 35
sleep 10

# Deliberately NOT using force_flush_via_sigterm here: "no new segment"
# is the CORRECT, expected outcome of this specific flush attempt (the
# capacity gate should block it) — retrying until a segment appears would
# defeat the point of this exact assertion, unlike every other use of the
# SIGTERM-flush pattern in this suite where a missing segment is pure
# setup noise.
log_step "attempting a second flush via SIGTERM while over cap"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"

# Give the 15s capacity-check interval a moment to run at least once more
# post-restart before we read state.
sleep 5

segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
halted_event_count="$(db_query "SELECT COUNT(*) FROM events WHERE type = 'log_storage_capacity_halted' AND created_at > NOW() - INTERVAL '3 minutes';")"
log_info "segment_count=$segment_count (expected 1, not 2) halted_events_recent=$halted_event_count"

if [ "$segment_count" -ge 2 ]; then
  test_fail "a second segment was flushed ($segment_count total) despite local usage being over the configured cap — the capacity gate did not block the write"
elif [ "$halted_event_count" -eq 0 ]; then
  test_fail "no segment count increase (good), but no log_storage_capacity_halted event was recorded either — the gate may have blocked the write for an unrelated reason rather than the capacity check actually firing; inconclusive"
else
  test_pass "second flush was correctly skipped (segment_count stayed at $segment_count) and a capacity-halted event was recorded"
fi
