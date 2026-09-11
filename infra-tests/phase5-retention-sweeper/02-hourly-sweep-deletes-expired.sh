#!/usr/bin/env bash
# Phase 5, test 3-4: the (hourly, in production) sweep actually deletes
# expired segments — object before row.
#
# Calls `sweepExpiredSegments` directly via node_call rather than waiting
# a real hour or re-starting the always-on hourly timer — this is testing
# the sweep LOGIC against real data (real flushed segment, real file on
# disk, real DB row), not the timer that schedules it (which is what
# `startRetentionSweeper` being wired into worker.ts, fixed earlier this
# session, is already responsible for).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "phase5-retention-sweeper" "02-hourly-sweep-deletes-expired"
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
}
trap cleanup EXIT

log_step "provisioning a test agent and flushing one real segment"
_AGENT_INFO="$(provision_test_agent "hourly-sweep")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
sleep 35
sleep 10
# Retries on the shutdown coordinator's own documented 10s-deadline race
# (see force_flush_via_sigterm's header) — this flush is setup for the
# expiry test, not itself under test.
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the next check will fail with a clear message"

segment_id="$(db_query "SELECT id FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
storage_key="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
if [ -z "$segment_id" ]; then
  test_fail "no segment flushed — cannot test expiry"
  exit 0
fi
log_info "segment id=$segment_id key=$storage_key"

log_step "backdating this segment's content time (ts_to) to 100 days ago"
db_exec "UPDATE log_segments SET ts_to = NOW() - INTERVAL '100 days' WHERE id = '${segment_id}';" >/dev/null

file_exists_before="$(compose exec -T worker-provisioner sh -c "[ -f '/var/lib/nora-logs/${storage_key}' ] && echo yes || echo no")"
log_info "object exists on disk before sweep: $file_exists_before"

log_step "running sweepExpiredSegments(null, now) directly — this agent has no workspace"
sweep_output="$(node_call "
  const { sweepExpiredSegments } = require('./logs/retentionSweeper.ts');
  sweepExpiredSegments(null, new Date().toISOString())
    .then((r) => { console.log('SWEEP_OK ' + JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('SWEEP_ERR ' + e.message); process.exit(1); });
")"
log_info "sweep result: $sweep_output"

row_exists_after="$(db_query "SELECT COUNT(*) FROM log_segments WHERE id = '${segment_id}';")"
file_exists_after="$(compose exec -T worker-provisioner sh -c "[ -f '/var/lib/nora-logs/${storage_key}' ] && echo yes || echo no")"
log_info "row exists after=$row_exists_after, object exists after=$file_exists_after"

if [ "$file_exists_before" != "yes" ]; then
  test_fail "the segment's object wasn't even present on disk before the sweep ran — setup problem, not a sweep problem"
elif [ "$row_exists_after" -ne 0 ]; then
  test_fail "the index row still exists after sweeping a segment backdated 100 days past any reasonable retention ceiling"
elif [ "$file_exists_after" = "yes" ]; then
  test_fail "the index row is gone but the object is still on disk — an orphan was created instead of a clean delete"
else
  test_pass "expired segment's object and index row were both deleted (object-before-row ordering not independently verified here, but end state is correct)"
fi
