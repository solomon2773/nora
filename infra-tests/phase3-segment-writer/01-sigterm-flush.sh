#!/usr/bin/env bash
# Phase 3, test 1: SIGTERM flushes all open buffers before exit.
#
# This is the single most important test in Phase 3: without the shutdown
# coordinator (registerShutdownCoordinator in worker.ts, added specifically
# for this), a plain `docker compose restart worker-provisioner` — a
# routine, GRACEFUL operation an operator does all the time — silently
# discards up to 15 minutes of buffered logs for every agent, because the
# only other flush triggers are a 15-minute timer and an agent deletion.
# No unit test with a mocked process/fake timer can prove the REAL
# process.on("SIGTERM", ...) handler is actually registered and actually
# reachable end-to-end; this test sends a real signal to the real process.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"

require_confirmation
test_start "phase3-segment-writer" "01-sigterm-flush"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""

cleanup() {
  test_trap_incomplete
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
  compose up -d worker-provisioner >/dev/null 2>&1 || true
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "sigterm-flush")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35

log_step "letting it emit for 10s so there's a real buffered window"
sleep 10
lines_emitted="$(docker logs "$CONTAINER_NAME" 2>&1 | wc -l | tr -d ' ')"
log_info "container has emitted $lines_emitted line(s)"

pre_segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
if [ "$pre_segment_count" -ne 0 ]; then
  test_fail "expected zero segments before any flush trigger, found $pre_segment_count — a flush happened for an unexpected reason, invalidating this test's premise"
  exit 0
fi
log_info "confirmed: no segment flushed yet (as expected — nothing but SIGTERM should have flushed it)"

log_step "sending a real SIGTERM via graceful 'docker compose stop' (15s grace, wider than the coordinator's own ~10s deadline)"
stop_started_ms=$(now_ms)
compose stop -t 25 worker-provisioner >/dev/null
stop_elapsed_ms=$(( $(now_ms) - stop_started_ms ))
log_info "worker-provisioner stopped in ${stop_elapsed_ms}ms"

log_step "restarting worker-provisioner"
compose up -d worker-provisioner >/dev/null
if ! wait_for_healthy worker-provisioner 60; then
  log_warn "worker-provisioner did not report healthy after restart — checking results anyway"
fi

log_step "checking log_segments for a flush triggered by the SIGTERM"
segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
segment_lines="$(db_query "SELECT COALESCE(SUM(lines), 0) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "segment_count=$segment_count segment_lines=$segment_lines (container had emitted $lines_emitted before the stop)"

if [ "$segment_count" -eq 0 ]; then
  test_fail "no segment was flushed — SIGTERM did not reach the shutdown coordinator, or it did not flush this agent's buffer (this would mean up to 15 minutes of real logs get silently dropped on every graceful restart)"
elif [ "$stop_elapsed_ms" -gt 14000 ]; then
  test_fail "worker-provisioner took ${stop_elapsed_ms}ms to stop — at/past the 15s grace period, meaning it likely got SIGKILLed by Compose rather than exiting on its own after a clean flush"
elif [ "$segment_lines" -lt 1 ]; then
  test_fail "a segment row exists but recorded 0 lines — check for a logic bug in the flush path, not just whether it fired"
else
  test_pass "SIGTERM flushed ${segment_lines} line(s) into ${segment_count} segment(s) and the process exited cleanly in ${stop_elapsed_ms}ms"
fi
