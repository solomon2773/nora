#!/usr/bin/env bash
# Phase 5c, test 3: `deleteLogs: true` on a real `DELETE /agents/:id`
# removes segments/spans/legacy copies for the deleted agent, and leaves a
# sibling agent's logs untouched.
#
# A real finding, worth stating plainly: the phase5c README (row #3)
# describes this as running "via the REAL enqueued worker-provisioner
# job" — but reading `backend-api/routes/agents.ts`'s `destroyAgent()`
# shows that's not what happens. `logDeletion.deleteAgentLogs(agent.id)`
# is called directly, fire-and-forget (no `await`, no BullMQ job, no
# worker-provisioner queue row), IN BACKEND-API'S OWN PROCESS —
# `workers/provisioner/logs/logDeletion.ts` is required directly via a
# relative `../../workers/provisioner/logs/logDeletion.ts` path (the same
# shared-mount pattern the backend-adapter code uses), not dispatched
# anywhere. There is no job id to poll; this script polls the resulting
# `log_segments`/`agent_spans` row counts directly instead. Filed here
# rather than silently working around it, per this suite's own rule about
# documenting real bugs/mismatches found while writing tests — though this
# one is arguably a README inaccuracy rather than a product bug: the
# actual behavior (synchronous-enough single-process cleanup, correctly
# scoped by agent_id) meets the plan's stated guarantee, it just isn't
# literally an "enqueued worker-provisioner job."
#
# Also worth noting: `deleteAgentLogs`/`purgeAllLogsByColumn` scope
# strictly by `agent_id` (see logDeletion.ts) — never by `workspace_id` —
# so putting the two test agents in the same workspace (as the README's
# prose suggests) would not exercise any additional isolation logic beyond
# what a bare agent_id scope already guarantees. This script provisions
# two independent test agents (no workspace assignment) for that reason;
# the sibling-isolation assertion below is exactly as strong either way.
#
# KNOWN LOCAL ENVIRONMENT LIMITATION, found while writing this script —
# not a Phase 5c bug: on THIS dev machine (Docker Desktop for Mac),
# `DELETE /agents/:id` currently 500s with "Container cleanup error:
# connect EACCES /var/run/docker.sock" — backend-api's containerManager
# can't reach the Docker socket, because its container runs as uid 1000
# with `group_add: [DOCKER_GID]` (docker-compose.override.yml), and
# DOCKER_GID resolves wrong on Docker Desktop for Mac. This is a
# PRE-EXISTING, ALREADY-DOCUMENTED gap — see docker-compose.override.yml's
# own comment on the worker-provisioner service ("LOCAL-ONLY WORKAROUND —
# do not commit. Docker Desktop for Mac's docker.sock is owned root:root
# in its Linux VM, but setup.sh's resolve_docker_gid can only stat the
# macOS-side symlink... The proper fix belongs in setup.sh"): worker-
# provisioner was given `user: "0:0"` to sidestep exactly this, but
# backend-api (which is what actually calls containerManager.destroy())
# was not. This blocks getting a live pass out of THIS script on an
# unpatched macOS dev machine; it's a local Docker socket permission gap,
# not a Phase 5c deletion-logic defect — every assertion below was
# validated by careful reading of the real destroyAgent()/logDeletion.ts
# source and by confirming mint_jwt/authed_curl reach the real, correctly-
# auth-gated routes (e.g. a live GET /admin/log-recovery 200'd with a real
# admin token). On a host where DOCKER_GID resolves correctly (Linux, or
# a macOS setup.sh patched per that comment), this script should run
# straight through.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"

require_confirmation
test_start "deletion-recovery" "01-agent-delete-true-removes-logs"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

TARGET_AGENT_ID=""; TARGET_CONTAINER=""
SIBLING_AGENT_ID=""; SIBLING_CONTAINER=""
TARGET_ALREADY_DELETED=0

cleanup() {
  test_trap_incomplete
  # The target agent is expected to be gone already (that's the point of
  # the test) — teardown_test_agent would just no-op on the DB rows and
  # harmlessly attempt to remove an already-removed container, but skip it
  # explicitly for clarity when the real delete call succeeded.
  if [ -n "$TARGET_CONTAINER" ] && [ "$TARGET_ALREADY_DELETED" -eq 0 ]; then
    teardown_test_agent "$TARGET_AGENT_ID" "$TARGET_CONTAINER"
  elif [ -n "$TARGET_CONTAINER" ]; then
    stop_and_remove "$TARGET_CONTAINER"
  fi
  if [ -n "$SIBLING_CONTAINER" ]; then
    teardown_test_agent "$SIBLING_AGENT_ID" "$SIBLING_CONTAINER"
  fi
}
trap cleanup EXIT

log_step "provisioning two independent test agents"
_T="$(provision_test_agent "delete-true-target")"
TARGET_AGENT_ID="$(echo "$_T" | sed -n '1p')"; TARGET_CONTAINER="$(echo "$_T" | sed -n '2p')"
_S="$(provision_test_agent "delete-true-sibling")"
SIBLING_AGENT_ID="$(echo "$_S" | sed -n '1p')"; SIBLING_CONTAINER="$(echo "$_S" | sed -n '2p')"
log_info "target agent_id=$TARGET_AGENT_ID container=$TARGET_CONTAINER"
log_info "sibling agent_id=$SIBLING_AGENT_ID container=$SIBLING_CONTAINER"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach both"
sleep 35
log_step "letting both emit for 10s"
sleep 10

log_step "flushing real segments for both agents (retries on the shutdown coordinator's documented 10s-deadline race — see force_flush_via_sigterm's header)"
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id IN ('${TARGET_AGENT_ID}','${SIBLING_AGENT_ID}');" \
  || log_warn "baseline flush never landed after retries — the checks below will fail with a clear message"

target_segments_before="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${TARGET_AGENT_ID}';")"
sibling_segments_before="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${SIBLING_AGENT_ID}';")"
log_info "before delete: target_segments=$target_segments_before sibling_segments=$sibling_segments_before"

if [ "$target_segments_before" -lt 1 ] || [ "$sibling_segments_before" -lt 1 ]; then
  test_fail "expected at least 1 flushed segment for each agent before testing deletion, got target=$target_segments_before sibling=$sibling_segments_before"
  exit 0
fi

log_step "calling the real DELETE /agents/:id?deleteLogs=true against the live stack, as the agents' real owner"
delete_status="$(authed_curl_status DELETE "/agents/${TARGET_AGENT_ID}" user \
  -H 'Content-Type: application/json' \
  -d '{"deleteLogs":true}')"
log_info "DELETE response status: $delete_status"

if [ "$delete_status" != "200" ]; then
  test_fail "DELETE /agents/${TARGET_AGENT_ID} with deleteLogs:true returned HTTP $delete_status, expected 200"
  exit 0
fi
TARGET_ALREADY_DELETED=1

log_step "confirming the agent row itself is gone (synchronous part of the delete)"
agent_row_count="$(db_query "SELECT COUNT(*) FROM agents WHERE id = '${TARGET_AGENT_ID}';")"
if [ "$agent_row_count" -ne 0 ]; then
  test_fail "agents row for ${TARGET_AGENT_ID} still exists after a 200 DELETE response"
  exit 0
fi

log_step "polling for the fire-and-forget deleteAgentLogs() cleanup to finish (no job row to wait on — see header note)"
waited=0
target_segments_after="$target_segments_before"
while [ "$waited" -lt 30 ]; do
  target_segments_after="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${TARGET_AGENT_ID}';")"
  [ "$target_segments_after" -eq 0 ] && break
  sleep 2
  waited=$((waited + 2))
done
target_spans_after="$(db_query "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${TARGET_AGENT_ID}';")"
target_legacy_after="$(db_query "SELECT COUNT(*) FROM log_segment_legacy_copies WHERE log_segment_id IN (SELECT id FROM log_segments WHERE agent_id = '${TARGET_AGENT_ID}');")"
sibling_segments_after="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${SIBLING_AGENT_ID}';")"
log_info "after delete (waited ${waited}s): target_segments=$target_segments_after target_spans=$target_spans_after target_legacy_copies=$target_legacy_after sibling_segments=$sibling_segments_after"

if [ "$target_segments_after" -ne 0 ]; then
  test_fail "target agent still has $target_segments_after log_segments row(s) after deleteLogs:true and 30s of waiting — async cleanup did not complete or did not run"
elif [ "$target_spans_after" -ne 0 ]; then
  test_fail "target agent still has $target_spans_after agent_spans row(s) after deleteLogs:true"
elif [ "$target_legacy_after" -ne 0 ]; then
  test_fail "target agent still has $target_legacy_after log_segment_legacy_copies row(s) after deleteLogs:true"
elif [ "$sibling_segments_after" -ne "$sibling_segments_before" ]; then
  test_fail "sibling agent's segment count changed ($sibling_segments_before -> $sibling_segments_after) — deleteAgentLogs is not correctly scoped to agent_id"
else
  test_pass "deleteLogs:true removed all $target_segments_before target segment(s) (and spans/legacy copies) within ${waited}s, sibling agent's $sibling_segments_after segment(s) untouched"
fi
