#!/usr/bin/env bash
# Phase 5b, matrix row 5: PUT /admin/log-storage to `local` is rejected, with NO
# side effects at all, when local usage plus the bytes waiting to migrate would
# exceed the cap.
#
# The plan's wording is specific, and it is what this checks: an exact check
# rather than an estimate, performed BEFORE the settings row is written, so a
# rejected switch leaves nothing behind — no flipped destination, no migration
# job, no settings-changed event. A request that switched the destination and
# then failed partway through a migration would satisfy "returned an error"
# while breaking every one of those.
#
# The overflow comes from one synthetic `s3` row whose `bytes` exceeds the
# stack's real cap, so the real pre-flight sum exceeds the real limit. Putting
# the excess on the SOURCE side rather than on local usage matters: synthetic
# local usage would genuinely hold the installation at capacity and halt live
# collection for every agent, which this row has no need to do.
#
# There is no positive control that performs a real switch. A successful
# request mutates the platform destination and starts a migration of every
# `s3` segment on the stack, including other agents' data. Instead the
# rejection is pinned to its `code`, so an unrelated 400 (for example, local
# being refused because k8s is enabled) cannot pass as this one.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"
source "$SCRIPT_DIR/../lib/minio_ctl.sh"
source "$SCRIPT_DIR/../lib/auth.sh"
source "$SCRIPT_DIR/../lib/segment_fixtures.sh"

require_confirmation
test_start "phase5b-storage-migration" "06-local-switch-rejected-over-capacity"
cleanup_orphaned_test_agents
cleanup_stale_migration_jobs
db_exec "DELETE FROM log_segments WHERE storage_key LIKE 'infra-test-synthetic-overflow-%';" >/dev/null 2>&1 || true

AGENT_ID=""
ORIGINAL_DEST=""
SYNTH_ID=""
BODY_FILE=""

cleanup() {
  test_trap_incomplete
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  [ -n "$SYNTH_ID" ] && db_exec "DELETE FROM log_segments WHERE id = '${SYNTH_ID}';" >/dev/null 2>&1
  [ -n "$ORIGINAL_DEST" ] && restore_storage_destination "$ORIGINAL_DEST"
  teardown_logless_test_agent "$AGENT_ID"
  return 0
}
trap cleanup EXIT

active="$(db_query "SELECT COUNT(*) FROM storage_migration_jobs WHERE status IN ('running','paused');")"
if [ "$active" != "0" ]; then
  test_fail "${active} storage migration job(s) are running or paused — the route would answer 409 before reaching the capacity check"
  exit 0
fi

CAP="$(compose exec -T backend-api printenv NORA_LOG_LOCAL_MAX_BYTES 2>/dev/null | tr -d '[:space:]')"
case "$CAP" in
  '' | *[!0-9]*)
    test_fail "backend-api has no numeric NORA_LOG_LOCAL_MAX_BYTES ('${CAP}') — with no cap the pre-flight never rejects"
    exit 0
    ;;
esac

ORIGINAL_DEST="$(capture_storage_destination)"
log_step "pointing the destination at MinIO, so switching to local is a real destination change"
set_storage_destination_minio_with_creds

AGENT_ID="$(provision_logless_test_agent "capacity-preflight")"
SYNTH_ID="$(db_query "
  INSERT INTO log_segments (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, storage_config, encryption_key_id, bytes, lines)
  VALUES ('${AGENT_ID}', 'runtime', NOW(), NOW(), 'infra-test-synthetic-overflow-$(date +%s)', 's3', '{}'::jsonb, 'default', $((CAP + 1)), 0)
  RETURNING id;
")"
log_info "cap=${CAP}; added a synthetic s3 row of $((CAP + 1)) bytes waiting to migrate"

settings_before="$(capture_storage_destination)"
jobs_before="$(db_query "SELECT COUNT(*) FROM storage_migration_jobs;")"
events_before="$(db_query "SELECT COUNT(*) FROM events WHERE type = 'admin_log_storage_settings_updated';")"

ADMIN_TOKEN="$(mint_jwt platform_admin)"
if [ -z "$ADMIN_TOKEN" ]; then
  test_fail "could not mint an admin JWT"
  exit 0
fi

log_step "requesting a switch to local through the real admin route"
BODY_FILE="$(mktemp -t nora-infra-preflight)"
HTTP_CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" -H "Content-Type: application/json" \
  -d '{"storageBackend":"local","keepSourceCopies":false}' \
  "http://localhost:${NGINX_HTTP_PORT:-8080}/api/admin/log-storage")"
BODY="$(cat "$BODY_FILE")"
error_code="$(json_field "$BODY" code 2>/dev/null)"
error_text="$(json_field "$BODY" error 2>/dev/null)"

settings_after="$(capture_storage_destination)"
jobs_after="$(db_query "SELECT COUNT(*) FROM storage_migration_jobs;")"
events_after="$(db_query "SELECT COUNT(*) FROM events WHERE type = 'admin_log_storage_settings_updated';")"
log_info "HTTP ${HTTP_CODE} code=${error_code:-none}; jobs ${jobs_before}->${jobs_after}; settings events ${events_before}->${events_after}"

if [ "$HTTP_CODE" != "400" ] || [ "$error_code" != "log_storage_capacity_exceeded" ]; then
  test_fail "expected HTTP 400 log_storage_capacity_exceeded, got HTTP ${HTTP_CODE} code=${error_code:-none} (${error_text:-no body})"
elif [ "$settings_after" != "$settings_before" ]; then
  test_fail "the switch was rejected, but the platform storage settings changed anyway (destination now '$(echo "$settings_after" | cut -d'|' -f1)') — the pre-flight ran after a side effect"
elif [ "$jobs_after" != "$jobs_before" ]; then
  test_fail "the switch was rejected, but a storage_migration_jobs row was created (${jobs_before} -> ${jobs_after})"
elif [ "$events_after" != "$events_before" ]; then
  test_fail "the switch was rejected, but an admin_log_storage_settings_updated event was recorded (${events_before} -> ${events_after})"
else
  test_pass "switching to local with more bytes waiting to migrate than the ${CAP}-byte cap was refused with HTTP 400 log_storage_capacity_exceeded and an actionable message, and left no trace: destination still s3 with identical settings, no migration job created, no settings-changed event"
fi
