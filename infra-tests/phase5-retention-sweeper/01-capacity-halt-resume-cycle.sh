#!/usr/bin/env bash
# Phase 5, tests 5-7: capacity halt is loud, reversible, and resumes
# automatically — not a one-time event.
#
# A real constraint this script works around, worth stating plainly:
# NORA_LOG_LOCAL_MAX_BYTES is read from process.env, which only changes
# when the container is RECREATED (docker compose up -d), never on a plain
# restart — and recreating worker-provisioner resets retentionSweeper.ts's
# in-memory `_capacityState` singleton back to "ok". That means you can't
# validate a halted -> resumed transition by changing the cap twice
# (raise it back up) — the second recreation would reset state to "ok"
# BEFORE observing "was it halted", so the "previousState === halted"
# branch that logs the resumed event would never see a real halted
# predecessor. This script sidesteps that entirely: set the cap ONCE
# (one restart, before anything matters), reach `halted` by having real
# usage exceed it, then bring usage back DOWN — not the cap back UP — by
# deleting the underlying segment directly. That's a same-process state
# transition, so the singleton correctly observes halted -> ok and logs
# the resumed event, exactly like an operator manually freeing space would
# trigger in production.
#
# Second constraint, found by this script false-failing against a real
# dev stack: `localStorageUsage()` sums `bytes` across EVERY 'local'
# segment installation-wide (same platform-wide pattern as migration, see
# lib/quarantine.sh) — not just this test's own. Picking a cap of just
# "this test's one segment minus 1 byte" only produces a real halt->resume
# cycle if this test's segment is the ONLY local usage that exists; with
# any other real local data around (a real agent's logs, easily orders of
# magnitude bigger than one test segment), deleting only the test's own
# segment never drops total usage back under that cap, so 'resumed' never
# fires — correctly, since usage genuinely never recovered. This is
# exactly what happened running this suite against a real dev stack: two
# real agents' local usage (~7-8KB each) dwarfed the test's ~900-byte
# segment, so the halted state never actually resolved. Quarantining
# every other agent's local segments (lib/quarantine.sh) fixes this the
# same way it fixes migration scoping: quarantined segments no longer
# match `storage_backend = 'local'`, so they drop out of
# localStorageUsage()'s SUM too, making the cap-vs-usage math accurate to
# this test's own data alone.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/local_cap.sh"
source "$SCRIPT_DIR/../lib/quarantine.sh"

require_confirmation
test_start "phase5-retention-sweeper" "01-capacity-halt-resume-cycle"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""
ORIGINAL_CAP=""

cleanup() {
  test_trap_incomplete
  restore_quarantined_local_segments
  if [ -n "$ORIGINAL_CAP" ]; then
    log_step "restoring NORA_LOG_LOCAL_MAX_BYTES=$ORIGINAL_CAP"
    restore_local_cap_bytes "$ORIGINAL_CAP"
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent and flushing one real segment"
_AGENT_INFO="$(provision_test_agent "capacity-cycle")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

sleep 35  # reconcile attach
sleep 10  # let it buffer real content
# Retries on the shutdown coordinator's own documented 10s-deadline race
# (see force_flush_via_sigterm's header) — this flush is establishing the
# baseline for the capacity cycle, not itself under test.
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the next check will fail with a clear message"

segment_id="$(db_query "SELECT id FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
segment_bytes="$(db_query "SELECT bytes FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
storage_key="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
if [ -z "$segment_id" ]; then
  test_fail "no segment flushed — cannot establish a baseline for the capacity cycle"
  exit 0
fi
log_info "baseline segment id=$segment_id bytes=$segment_bytes"

# See the header comment: localStorageUsage() sums bytes across EVERY
# local segment installation-wide, so without this, any other real local
# data would make the halted->resumed cycle below impossible to observe
# correctly (deleting only this test's segment would never drop total
# usage back under the cap).
quarantine_foreign_local_segments "$AGENT_ID"

log_step "setting the cap below this segment's size — this restart is the ONLY one for the rest of the test"
ORIGINAL_CAP="$(set_local_cap_bytes $((segment_bytes - 1)))"
log_info "cap=$((segment_bytes - 1)) (was $ORIGINAL_CAP)"

log_step "waiting ~20s for the capacity-check tick to observe halted"
sleep 20
halted_count="$(db_query "SELECT COUNT(*) FROM events WHERE type = 'log_storage_capacity_halted' AND created_at > NOW() - INTERVAL '2 minutes';")"
log_info "halted events in the last 2 minutes: $halted_count"

if [ "$halted_count" -eq 0 ]; then
  test_fail "expected a log_storage_capacity_halted event after setting the cap below real usage — none was recorded"
  exit 0
fi
log_info "confirmed: halted"

log_step "dropping usage back under the cap by deleting the segment directly (simulates an operator freeing space — same effect as DELETE /logs, done here without needing a real auth token)"
db_exec "DELETE FROM log_segments WHERE id = '${segment_id}';" >/dev/null
compose exec -T worker-provisioner sh -c "rm -f '/var/lib/nora-logs/${storage_key}'" >/dev/null 2>&1 || true

log_step "waiting ~20s for the capacity-check tick to observe the drop and log 'resumed'"
sleep 20
resumed_count="$(db_query "SELECT COUNT(*) FROM events WHERE type = 'log_storage_capacity_resumed' AND created_at > NOW() - INTERVAL '2 minutes';")"
log_info "resumed events in the last 2 minutes: $resumed_count"

if [ "$resumed_count" -eq 0 ]; then
  test_fail "usage dropped back under the cap but no log_storage_capacity_resumed event was recorded — resume may not be firing, or may require an operator action it shouldn't (the plan explicitly requires this to be automatic)"
else
  test_pass "full cycle observed: ok -> halted (on real usage exceeding the cap) -> resumed (on usage dropping back under it), with no restart and no manual 'resume' action in between the two transitions"
fi
