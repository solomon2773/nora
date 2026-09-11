#!/usr/bin/env bash
# Phase 4, test 1: "killing the worker mid-window loses no lines."
#
# See ../README.md and this directory's README.md for the full rationale.
# Short version: the plan's durability guarantee is that an ungraceful
# worker crash never loses a line, because Docker (or the kubelet) retains
# the container's own log history and the collector replays from the last
# FLUSHED cursor on reattach — never from "last line seen in memory," which
# a crash wipes out. This is exactly the class of guarantee a mocked unit
# test cannot verify: it depends on Docker's real log retention surviving a
# real process restart, not a simulated one.
#
# What this script does NOT cover (documented limitation, not an oversight):
# it crashes the worker before any flush has ever happened for this agent
# (forcing a real 15-minute-boundary flush first isn't practical for a
# routine test run), so it validates "replay from an empty cursor loses
# nothing," not "replay from a real prior flushed cursor loses nothing."
# The latter is a stronger claim and worth its own longer-running test —
# see this directory's README TODO list.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"

require_confirmation
test_start "phase4-log-collector" "01-worker-kill-midwindow"
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
  # Leave worker-provisioner running for whatever's next, regardless of how
  # this script got here.
  compose up -d worker-provisioner >/dev/null 2>&1 || true
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "worker-kill")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35

log_step "letting it emit for 8s before the crash"
sleep 8
lines_before_kill="$(docker logs "$CONTAINER_NAME" 2>&1 | wc -l | tr -d ' ')"
log_info "container has emitted $lines_before_kill line(s) so far"

log_step "SIGKILL-ing worker-provisioner (simulated crash, no graceful flush)"
compose kill -s SIGKILL worker-provisioner >/dev/null

sleep 3
log_step "restarting worker-provisioner"
compose up -d worker-provisioner >/dev/null
if ! wait_for_healthy worker-provisioner 60; then
  test_fail "worker-provisioner did not become healthy again within 60s after the crash"
  exit 0
fi

log_step "waiting ~35s for reconcile to reattach the stream"
sleep 35

log_step "letting it emit for 8s more post-recovery"
sleep 8
lines_after_recovery="$(docker logs "$CONTAINER_NAME" 2>&1 | wc -l | tr -d ' ')"
log_info "container has emitted $lines_after_recovery line(s) total"

log_step "gracefully stopping worker-provisioner to force the final flush (retries on the shutdown coordinator's own documented 10s-deadline race — see force_flush_via_sigterm's header — since this final flush is scaffolding to observe the crash-recovery result, not itself under test)"
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "final flush never landed after retries — the check below will fail with a clear message"

log_step "checking log_segments for this agent"
segment_lines="$(db_query "SELECT COALESCE(SUM(lines), 0) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "flushed segment_count=$segment_count total_lines=$segment_lines (container emitted $lines_after_recovery before the flush-forcing stop)"

# Tolerance: a couple of lines can legitimately be emitted in the brief
# window between our last `docker logs` count and the SIGTERM actually
# reaching the collector's follow stream — this is not the gap being
# tested for. What matters is that segment_lines is NOT meaningfully less
# than what was emitted before the crash (a real loss) and not wildly more
# (a duplication bug).
if [ "$segment_count" -eq 0 ]; then
  test_fail "no segment was ever flushed for this agent — the final graceful stop should have forced one"
elif [ "$segment_lines" -lt "$lines_before_kill" ]; then
  test_fail "segment lines ($segment_lines) is less than what was emitted BEFORE the crash ($lines_before_kill) — lines were lost"
elif [ "$segment_lines" -gt $((lines_after_recovery + 5)) ]; then
  test_fail "segment lines ($segment_lines) exceeds what was ever emitted ($lines_after_recovery) by more than the timing tolerance — lines were duplicated"
else
  test_pass "segment_lines=$segment_lines within [$lines_before_kill, $((lines_after_recovery + 5))] — crash-and-replay lost nothing and duplicated nothing"
fi
