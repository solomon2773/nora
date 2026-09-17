#!/usr/bin/env bash
# Phase 5c, test 9: manual purge from the admin recovery view
# (`DELETE /admin/log-recovery/:id`) removes segments, spans, legacy
# copies, and the `deleted_log_owners` row itself — against a real running
# stack, with a real platform-admin JWT.
#
# Role-name note: this codebase's `users.role` column uses the literal
# string "admin" for platform admins, not "platform_admin" — confirmed by
# reading backend-api/middleware/auth.ts's requireAdmin
# ("req.user.role !== 'admin'") and the routes/admin.ts queries. This
# script uses `mint_jwt platform_admin` (lib/auth.sh's interface, which
# maps that argument to `role = 'admin'` under the hood — see auth.sh's
# header) and fails loudly rather than guessing if no such user exists,
# per this test's own spec.
#
# This script's SETUP (provisioning an agent, then deleting it with
# deleteLogs:false to create a kept-logs entry) depends on the same real
# DELETE /agents/:id path as 01/02 — see 01's header for a KNOWN LOCAL
# ENVIRONMENT LIMITATION found while writing these scripts: on this dev
# machine that call currently 500s on a Docker-socket-permission error
# unrelated to Phase 5c (a pre-existing, already-documented gap in
# docker-compose.override.yml's DOCKER_GID handling for backend-api on
# Docker Desktop for Mac). The purge assertions themselves
# (`DELETE /admin/log-recovery/:id` and its admin-only gating) were
# validated by direct code reading against workers/provisioner/logs/
# logDeletion.ts's purgeDeletedLogOwner and backend-api/middleware/
# auth.ts's requireAdmin, and by a live confirmed 200 from
# GET /admin/log-recovery with a real admin JWT — but the full script
# could not be run end-to-end on this machine for the same reason 01/02
# couldn't.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"

require_confirmation
test_start "deletion-recovery" "03-manual-purge-from-recovery-view"
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
  # Best-effort: if the purge under test actually worked, all of this is
  # already gone; these are just a safety net for a failed/partial run.
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

log_step "checking a real platform-admin (role='admin') user exists before doing anything else"
admin_user_id="$(db_query "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1;")"
if [ -z "$admin_user_id" ]; then
  test_fail "no platform_admin user exists (users.role = 'admin') — create one to run this test"
  exit 0
fi
log_info "using admin user_id=$admin_user_id for the platform-admin JWT"

log_step "provisioning a test agent, flushing a real segment, and deleting it with deleteLogs:false to create a kept-logs entry"
_A="$(provision_test_agent "manual-purge")"
AGENT_ID="$(echo "$_A" | sed -n '1p')"; CONTAINER_NAME="$(echo "$_A" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

sleep 35
sleep 10
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "baseline flush never landed after retries — the checks below will fail with a clear message"

segments_before="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
if [ "$segments_before" -lt 1 ]; then
  test_fail "expected at least 1 flushed segment before testing purge, got $segments_before"
  exit 0
fi

delete_status="$(authed_curl_status DELETE "/agents/${AGENT_ID}" user \
  -H 'Content-Type: application/json' \
  -d '{"deleteLogs":false}')"
if [ "$delete_status" != "200" ]; then
  test_fail "setup DELETE /agents/${AGENT_ID} (deleteLogs:false) returned HTTP $delete_status, expected 200 — cannot proceed to the purge itself"
  exit 0
fi
AGENT_ALREADY_DELETED=1

owner_id="$(db_query "SELECT id FROM deleted_log_owners WHERE kind = 'agent' AND source_id = '${AGENT_ID}' ORDER BY deleted_at DESC LIMIT 1;")"
OWNER_ROW_ID="$owner_id"
if [ -z "$owner_id" ]; then
  test_fail "setup did not produce a deleted_log_owners row for agent ${AGENT_ID} — cannot proceed to the purge itself"
  exit 0
fi
log_info "kept-logs recovery entry created: deleted_log_owners.id=$owner_id"

log_step "confirming a non-admin (regular user) is refused the purge — sanity check the guard is real before trusting a 200 from the admin call below"
non_admin_purge_status="$(authed_curl_status DELETE "/admin/log-recovery/${owner_id}" user)"
log_info "non-admin purge attempt status: $non_admin_purge_status"

log_step "calling the real DELETE /admin/log-recovery/:id as platform-admin"
purge_status="$(authed_curl_status DELETE "/admin/log-recovery/${owner_id}" platform_admin)"
log_info "admin purge status: $purge_status"

segments_after="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
spans_after="$(db_query "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${AGENT_ID}';")"
legacy_after="$(db_query "SELECT COUNT(*) FROM log_segment_legacy_copies WHERE log_segment_id IN (SELECT id FROM log_segments WHERE agent_id = '${AGENT_ID}');")"
owner_row_after="$(db_query "SELECT COUNT(*) FROM deleted_log_owners WHERE id = '${owner_id}';")"
log_info "after purge: segments=$segments_after spans=$spans_after legacy_copies=$legacy_after owner_row_exists=$owner_row_after"

if [ "$non_admin_purge_status" = "200" ]; then
  test_fail "a non-admin user's DELETE /admin/log-recovery/${owner_id} returned 200 — requireAdmin is not actually gating this route"
elif [ "$purge_status" != "200" ]; then
  test_fail "platform-admin DELETE /admin/log-recovery/${owner_id} returned HTTP $purge_status, expected 200"
elif [ "$segments_after" -ne 0 ]; then
  test_fail "$segments_after log_segments row(s) still exist for agent ${AGENT_ID} after a 200 purge response"
elif [ "$spans_after" -ne 0 ]; then
  test_fail "$spans_after agent_spans row(s) still exist for agent ${AGENT_ID} after a 200 purge response"
elif [ "$legacy_after" -ne 0 ]; then
  test_fail "$legacy_after log_segment_legacy_copies row(s) still exist after a 200 purge response"
elif [ "$owner_row_after" -ne 0 ]; then
  test_fail "the deleted_log_owners row (id=$owner_id) itself still exists after a 200 purge response"
else
  OWNER_ROW_ID=""  # already gone — cleanup's DELETE is now a harmless no-op
  test_pass "manual purge removed all $segments_before segment(s), spans, legacy copies, and the deleted_log_owners row itself; a non-admin was correctly refused with HTTP $non_admin_purge_status"
fi
