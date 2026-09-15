#!/usr/bin/env bash
# Phase 6, matrix row 2: search returns a line the agent wrote seconds ago,
# before any flush could have persisted it.
#
# Segments flush every 15 minutes, so storage alone is always up to a
# quarter-hour stale. Search closes that gap by asking worker-provisioner
# for its live in-memory buffer over an internal HTTP call — which only a
# real agent, really buffering, with a real backend-api to worker round trip,
# actually exercises. logSearch.test.ts injects that buffer fetch.
#
# The assertion is deliberately specific rather than "search returned
# something." The exact text of the newest line the container printed is
# captured from `docker logs` first, and that line must appear in the search
# result while log_segments for the agent is still empty — checked both
# before and after the query. An empty log_segments is what proves the line
# came from the buffer and not from storage.
#
# The plan phrases this as "a line written 30 seconds ago is returned."
# Capturing the newest line tests something strictly tighter: a line written
# a few seconds before the query.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"

require_confirmation
test_start "phase6-search" "02-recency-gap-closed"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""
BODY_FILE=""

cleanup() {
  test_trap_incomplete
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

iso_offset() {
  date -u -v"$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "$2" +"%Y-%m-%dT%H:%M:%SZ"
}

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "search-recency")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35
log_step "letting it emit for 8s so the buffer holds real, never-flushed content"
sleep 8

segments_before="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
if [ "$segments_before" != "0" ]; then
  test_fail "expected 0 flushed segments before querying (this test asserts on buffer-only content), got ${segments_before}"
  exit 0
fi

TOKEN="$(mint_jwt user)"
if [ -z "$TOKEN" ]; then
  test_fail "could not mint a JWT for the search request"
  exit 0
fi

NEWEST_LINE="$(docker logs --tail 1 "$CONTAINER_NAME" 2>&1 | tr -d '\r')"
log_info "newest line the container printed: '${NEWEST_LINE}'"
log_step "giving the collector 3s to ingest it, then searching"
sleep 3

FROM="$(iso_offset -10M '10 minutes ago')"
TO="$(iso_offset +5M '5 minutes')"
BODY_FILE="$(mktemp -t nora-infra-recency)"
HTTP_CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:${NGINX_HTTP_PORT:-8080}/api/logs/search?agentId=${AGENT_ID}&from=${FROM}&to=${TO}&limit=1000")"

segments_after="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"

VERDICT="$(node -e '
  const fs = require("fs");
  let body = {};
  try {
    body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  } catch (e) {}
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const target = String(process.argv[2] || "").trim();
  const hit = lines.find((l) => String(l.message || "").trim() === target);
  process.stdout.write(JSON.stringify({
    lineCount: lines.length,
    found: Boolean(hit),
    warning: body.warning || null,
    error: body.error || null,
  }));
' "$BODY_FILE" "$NEWEST_LINE")"
log_info "HTTP ${HTTP_CODE}, segments before=${segments_before} after=${segments_after}, result: ${VERDICT}"

get() {
  printf '%s' "$VERDICT" | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(v === null || v === undefined ? "" : String(v));
  ' "$1"
}
line_count="$(get lineCount)"
found="$(get found)"
warning="$(get warning)"
error_text="$(get error)"

if [ "$HTTP_CODE" != "200" ]; then
  test_fail "search returned HTTP ${HTTP_CODE} (${error_text:-no error body}) — cannot evaluate the recency gap"
elif [ "$segments_after" != "0" ]; then
  test_fail "a segment was flushed during the query (segments after=${segments_after}), so a returned line could have come from storage — result inconclusive, re-run"
elif [ "$line_count" = "0" ]; then
  test_fail "search returned 0 lines for a live, actively-emitting agent with nothing flushed${warning:+ (warning=${warning})} — the recency gap is not being closed"
elif [ "$found" != "true" ]; then
  test_fail "search returned ${line_count} buffered line(s) but not '${NEWEST_LINE}', the newest line the container printed before the query — the buffer read is returning stale content"
else
  test_pass "search returned '${NEWEST_LINE}', printed seconds before the query, with 0 segments flushed before or after (${line_count} line(s) total, all from the live buffer) — the recency gap is closed against a real worker"
fi
