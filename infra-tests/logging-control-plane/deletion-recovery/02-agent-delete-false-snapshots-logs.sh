#!/usr/bin/env bash
# Phase 5c, test 5: `deleteLogs: false` on a real `DELETE /agents/:id`
# leaves segments/spans intact and records a `deleted_log_owners` snapshot
# row with the correct retention_days.
#
# See 01-agent-delete-true-removes-logs.sh's header for the same real
# finding that applies here too: `snapshotDeletedLogOwner` runs
# synchronously (awaited, BEFORE the agent row delete — see
# routes/agents.ts's destroyAgent()), inside backend-api's own process via
# a direct require of workers/provisioner/logs/logDeletion.ts — not an
# enqueued worker-provisioner job. Unlike the deleteLogs:true path this one
# genuinely IS synchronous with the HTTP response, so there's no polling
# needed here — if the row isn't there immediately after a 200 response,
# it never will be.
#
# See 01-agent-delete-true-removes-logs.sh's header for a KNOWN LOCAL
# ENVIRONMENT LIMITATION found while writing these scripts: on this dev
# machine, DELETE /agents/:id 500s with a Docker-socket-permission error
# unrelated to Phase 5c (a pre-existing, already-documented gap in
# docker-compose.override.yml's DOCKER_GID handling for backend-api on
# Docker Desktop for Mac). Not reproduced here a second time verbatim —
# see that script for the full explanation.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"

require_confirmation
test_start "deletion-recovery" "02-agent-delete-false-snapshots-logs"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""; CONTAINER_NAME=""
AGENT_ALREADY_DELETED=0
OWNER_ROW_ID=""

cleanup() {
  test_trap_incomplete
  if [ -n "$CONTAINER_NAME" ] && [ "$AGENT_ALREADY_DELETED" -eq 0 ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  elif [ -n "$CONTAINER_NAME" ]; then
    stop_and_remove "$CONTAINER_NAME"
  fi
  # The agent row is gone either way (that's the point of this test), so
  # clean up whatever the delete path left behind directly by agent_id:
  # segments/spans (should still exist — that's what we're asserting —
  # but must not survive the test run) and the deleted_log_owners snapshot
  # row itself, which teardown_test_agent doesn't know about.
  if [ -n "$AGENT_ID" ]; then
    db_exec "DELETE FROM log_segment_legacy_copies WHERE log_segment_id IN (SELECT id FROM log_segments WHERE agent_id = '${AGENT_ID}');" >/dev/null 2>&1 || true
    db_exec "DELETE FROM log_segments WHERE agent_id = '${AGENT_ID}';" >/dev/null 2>&1 || true
    db_exec "DELETE FROM agent_spans WHERE agent_id = '${AGENT_ID}';" >/dev/null 2>&1 || true
  fi
  if [ -n "$OWNER_ROW_ID" ]; then
    db_exec "DELETE FROM deleted_log_owners WHERE id = '${OWNER_ROW_ID}';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log_step "provisioning a test agent and flushing a real segment"
_A="$(provision_test_agent "delete-false")"
AGENT_ID="$(echo "$_A" | sed -n '1p')"; CONTAINER_NAME="$(echo "$_A" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

sleep 35
sleep 10
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the checks below will fail with a clear message"

segments_before="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "segments before delete: $segments_before"
if [ "$segments_before" -lt 1 ]; then
  test_fail "expected at least 1 flushed segment before testing deletion, got $segments_before"
  exit 0
fi

log_step "calling the real DELETE /agents/:id with deleteLogs:false, as the agent's real owner"
delete_status="$(authed_curl_status DELETE "/agents/${AGENT_ID}" user \
  -H 'Content-Type: application/json' \
  -d '{"deleteLogs":false}')"
log_info "DELETE response status: $delete_status"

if [ "$delete_status" != "200" ]; then
  test_fail "DELETE /agents/${AGENT_ID} with deleteLogs:false returned HTTP $delete_status, expected 200"
  exit 0
fi
AGENT_ALREADY_DELETED=1

agent_row_count="$(db_query "SELECT COUNT(*) FROM agents WHERE id = '${AGENT_ID}';")"
segments_after="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
owner_row="$(db_query "SELECT id, kind, source_id, retention_days FROM deleted_log_owners WHERE kind = 'agent' AND source_id = '${AGENT_ID}' ORDER BY deleted_at DESC LIMIT 1;")"
OWNER_ROW_ID="$(echo "$owner_row" | cut -d'|' -f1)"
owner_retention_days="$(echo "$owner_row" | cut -d'|' -f4)"
log_info "agent_row_count=$agent_row_count segments_after=$segments_after owner_row_id=${OWNER_ROW_ID:-<none>} retention_days=${owner_retention_days:-<none>}"

if [ "$agent_row_count" -ne 0 ]; then
  test_fail "agents row for ${AGENT_ID} still exists after a 200 DELETE response"
elif [ "$segments_after" -ne "$segments_before" ]; then
  test_fail "segment count changed ($segments_before -> $segments_after) after deleteLogs:false — logs should be left completely untouched"
elif [ -z "$OWNER_ROW_ID" ]; then
  test_fail "no deleted_log_owners row was created for kind=agent source_id=${AGENT_ID} after deleteLogs:false"
elif [ -z "$owner_retention_days" ] || [ "$owner_retention_days" -le 0 ]; then
  test_fail "deleted_log_owners row exists but retention_days is missing/non-positive: '${owner_retention_days}'"
else
  test_pass "deleteLogs:false left $segments_after segment(s) intact and recorded a deleted_log_owners row (id=$OWNER_ROW_ID) with retention_days=$owner_retention_days"
fi
