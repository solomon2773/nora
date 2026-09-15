#!/usr/bin/env bash
# Phase 5b, matrix row 4: PUT /admin/log-storage refuses to clear a
# destination's credentials while anything still needs them to read.
#
# Two things need old-destination credentials after a destination change: a
# migration still running (it reads every source object), and a kept legacy
# copy that has not yet expired. Clearing credentials in either state strands
# data that exists but can no longer be read.
#
# Three real requests, same body each time — clear the S3 access key and
# secret while leaving the destination unchanged:
#
#   (a) with a migration from s3 in flight           expect 409, credentials kept
#   (b) with an unexpired legacy copy on s3          expect 409, credentials kept
#   (c) with neither — but an EXPIRED legacy copy    expect 200, credentials cleared
#
# (c) is the positive control, and it is doing two jobs. It proves the 409 is
# conditional rather than unconditional, and it proves an expired legacy copy
# does not block — only unexpired ones hold credentials hostage. It really does
# clear the credentials, so the captured settings row is restored on exit.
#
# The in-flight migration in (a) is a bare `running` job row. A `running` row
# is only picked up by a worker at boot, and nothing here restarts the worker
# while it exists, so no real migration of other agents' data can start.

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
test_start "phase5b-storage-migration" "09-credentials-in-use-rejected"
cleanup_orphaned_test_agents
cleanup_stale_migration_jobs

AGENT_ID=""
ORIGINAL_DEST=""
JOB_ID=""
SEG_ID=""
BODY_FILE=""

cleanup() {
  test_trap_incomplete
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  [ -n "$JOB_ID" ] && db_exec "DELETE FROM storage_migration_jobs WHERE id = '${JOB_ID}';" >/dev/null 2>&1
  [ -n "$SEG_ID" ] && db_exec "DELETE FROM log_segment_legacy_copies WHERE log_segment_id = '${SEG_ID}';" >/dev/null 2>&1
  [ -n "$ORIGINAL_DEST" ] && restore_storage_destination "$ORIGINAL_DEST"
  teardown_logless_test_agent "$AGENT_ID"
  return 0
}
trap cleanup EXIT

active="$(db_query "SELECT COUNT(*) FROM storage_migration_jobs WHERE status IN ('running','paused');")"
live_legacy="$(db_query "SELECT COUNT(*) FROM log_segment_legacy_copies WHERE ts_to > NOW() AND storage_backend IN ('s3','r2');")"
ssh_host="$(db_query "SELECT COALESCE(log_storage_ssh_host, '') FROM platform_settings WHERE singleton = TRUE;" 2>/dev/null)"
if [ "$active" != "0" ] || [ "$live_legacy" != "0" ]; then
  test_fail "this stack already has ${active} active migration(s) and ${live_legacy} unexpired s3/r2 legacy copy(ies) — the positive control could not tell a real 200 from a pre-existing block"
  exit 0
fi
if [ -n "$ssh_host" ]; then
  test_fail "SSH log storage is configured on this stack (host '${ssh_host}'); the positive control rewrites the settings row, and the capture/restore helper does not cover SSH fields — refusing rather than risk losing them"
  exit 0
fi

ORIGINAL_DEST="$(capture_storage_destination)"
CURRENT_BACKEND="$(echo "$ORIGINAL_DEST" | cut -d'|' -f1)"
log_step "making sure S3 credentials are present to be cleared (destination stays ${CURRENT_BACKEND})"
set_minio_credentials_keep_backend

ADMIN_TOKEN="$(mint_jwt platform_admin)"
if [ -z "$ADMIN_TOKEN" ]; then
  test_fail "could not mint an admin JWT"
  exit 0
fi
BODY_FILE="$(mktemp -t nora-infra-creds)"

creds_present() {
  db_query "SELECT (log_storage_s3_access_key_id_encrypted IS NOT NULL AND log_storage_s3_secret_access_key_encrypted IS NOT NULL) FROM platform_settings WHERE singleton = TRUE;"
}

# clear_creds — prints "<http_code>|<code>"
clear_creds() {
  local http body
  http="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X PUT \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"storageBackend\":\"${CURRENT_BACKEND}\",\"clearS3AccessKey\":true,\"clearS3SecretAccessKey\":true}" \
    "http://localhost:${NGINX_HTTP_PORT:-8080}/api/admin/log-storage")"
  body="$(cat "$BODY_FILE")"
  echo "${http}|$(json_field "$body" code 2>/dev/null)"
}

AGENT_ID="$(provision_logless_test_agent "credentials-in-use")"
SEG_ID="$(db_query "
  INSERT INTO log_segments (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, storage_config, encryption_key_id, bytes, lines)
  VALUES ('${AGENT_ID}', 'runtime', NOW(), NOW(), 'infra-test-legacy-anchor-$(date +%s)', 'local', '{}'::jsonb, 'default', 1, 0)
  RETURNING id;
")"

log_step "(a) clearing credentials while a migration from s3 is in flight"
JOB_ID="$(db_query "
  INSERT INTO storage_migration_jobs (from_backend, to_backend, keep_source, status, segments_total, segments_migrated)
  VALUES ('s3', 'local', false, 'running', 0, 0) RETURNING id;
")"
a_result="$(clear_creds)"
a_creds="$(creds_present)"
db_exec "DELETE FROM storage_migration_jobs WHERE id = '${JOB_ID}';" >/dev/null
JOB_ID=""
log_info "(a) -> HTTP ${a_result%%|*} code=${a_result#*|}; credentials still present: ${a_creds}"

log_step "(b) clearing credentials while an unexpired legacy copy lives on s3"
db_exec "INSERT INTO log_segment_legacy_copies (log_segment_id, storage_backend, storage_config, ts_to) VALUES ('${SEG_ID}', 's3', '{}'::jsonb, NOW() + INTERVAL '1 day');" >/dev/null
b_result="$(clear_creds)"
b_creds="$(creds_present)"
db_exec "DELETE FROM log_segment_legacy_copies WHERE log_segment_id = '${SEG_ID}';" >/dev/null
log_info "(b) -> HTTP ${b_result%%|*} code=${b_result#*|}; credentials still present: ${b_creds}"

log_step "(c) positive control — nothing in flight, only an EXPIRED legacy copy on s3"
db_exec "INSERT INTO log_segment_legacy_copies (log_segment_id, storage_backend, storage_config, ts_to) VALUES ('${SEG_ID}', 's3', '{}'::jsonb, NOW() - INTERVAL '1 day');" >/dev/null
c_result="$(clear_creds)"
c_creds="$(creds_present)"
log_info "(c) -> HTTP ${c_result%%|*} code=${c_result#*|}; credentials still present: ${c_creds}"

fail=""
if [ "${a_result%%|*}" != "409" ] || [ "${a_result#*|}" != "log_storage_credentials_in_use" ]; then
  fail="${fail}${fail:+; }(a) in-flight migration: expected HTTP 409 log_storage_credentials_in_use, got HTTP ${a_result%%|*} code=${a_result#*|}"
elif [ "$a_creds" != "t" ]; then
  fail="${fail}${fail:+; }(a) returned 409 but the credentials were cleared anyway"
fi
if [ "${b_result%%|*}" != "409" ] || [ "${b_result#*|}" != "log_storage_credentials_in_use" ]; then
  fail="${fail}${fail:+; }(b) unexpired legacy copy: expected HTTP 409 log_storage_credentials_in_use, got HTTP ${b_result%%|*} code=${b_result#*|}"
elif [ "$b_creds" != "t" ]; then
  fail="${fail}${fail:+; }(b) returned 409 but the credentials were cleared anyway"
fi
if [ "${c_result%%|*}" != "200" ]; then
  fail="${fail}${fail:+; }(c) positive control: expected HTTP 200 with only an expired legacy copy, got HTTP ${c_result%%|*} code=${c_result#*|} — the guard blocks unconditionally, or expired copies still hold credentials"
elif [ "$c_creds" != "f" ]; then
  fail="${fail}${fail:+; }(c) returned 200 but the credentials were not actually cleared"
fi

if [ -z "$fail" ]; then
  test_pass "clearing S3 credentials was refused with HTTP 409 log_storage_credentials_in_use while a migration from s3 was in flight and while an unexpired s3 legacy copy existed, leaving the credentials in place both times; with neither condition and only an expired legacy copy, the same request succeeded and really cleared them"
else
  test_fail "$fail"
fi
