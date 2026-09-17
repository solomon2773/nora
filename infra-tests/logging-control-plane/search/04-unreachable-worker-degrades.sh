#!/usr/bin/env bash
# Phase 6, matrix row 4: with worker-provisioner down, search still answers
# from storage and says recent lines are unavailable — it does not fail the
# query.
#
# The degraded path is only reachable through a real outage. The unit test
# throws from an injected buffer fetch; a genuinely stopped container
# produces a DNS or connection failure on the internal URL instead, bounded
# by WORKER_INTERNAL_TIMEOUT_MS. This confirms that failure is caught,
# surfaced as the marker, and bounded in time rather than hanging the
# request.
#
# A segment is flushed first, on purpose. A 200 carrying zero lines would
# technically satisfy "did not fail" while hiding a degraded path that
# returns nothing at all, so the assertion requires storage results to
# actually come back.
#
# The marker is then checked in reverse with the worker restored. If it
# still appeared, the field would be getting set unconditionally rather than
# in response to the outage.
#
# The query range reaches the present. readBufferSnapshots skips the worker
# call outright for a range older than one flush interval, which would make
# the outage invisible and the test meaningless.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"

require_confirmation
test_start "search" "04-unreachable-worker-degrades"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""
BODY_FILE=""
TOKEN=""
FROM=""
TO=""
WORKER_STOPPED=0

cleanup() {
  test_trap_incomplete
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  if [ "$WORKER_STOPPED" -eq 1 ]; then
    log_step "restoring worker-provisioner, which this test stopped"
    compose up -d worker-provisioner >/dev/null 2>&1 || true
    wait_for_healthy worker-provisioner 60 || log_warn "worker-provisioner did not report healthy after restore"
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

iso_offset() {
  date -u -v"$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "$2" +"%Y-%m-%dT%H:%M:%SZ"
}

# search_once — prints "<http_code>|<elapsed_seconds>"; body lands in $BODY_FILE.
search_once() {
  local started code
  started="$(date +%s)"
  code="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' --max-time 60 \
    -H "Authorization: Bearer ${TOKEN}" \
    "http://localhost:${NGINX_HTTP_PORT:-8080}/api/logs/search?agentId=${AGENT_ID}&from=${FROM}&to=${TO}&limit=1000")"
  echo "${code}|$(($(date +%s) - started))"
}

body_summary() {
  node -e '
    const fs = require("fs");
    let b = {};
    try {
      b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (e) {}
    process.stdout.write(JSON.stringify({
      lines: Array.isArray(b.lines) ? b.lines.length : 0,
      warning: b.warning || null,
      error: b.error || null,
    }));
  ' "$BODY_FILE"
}

json_get() {
  printf '%s' "$1" | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(v === null || v === undefined ? "" : String(v));
  ' "$2"
}

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "search-degrade")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35
log_step "letting it emit for 8s"
sleep 8

log_step "flushing a real segment first, so degraded results have real storage content to return"
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "flush never landed after retries — the segment check below will catch this"
segments="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "segments flushed: ${segments}"
if [ "$segments" = "0" ]; then
  test_fail "no segment was flushed, so a storage-only degraded result could not be told apart from an empty one"
  exit 0
fi

TOKEN="$(mint_jwt user)"
if [ -z "$TOKEN" ]; then
  test_fail "could not mint a JWT for the search request"
  exit 0
fi
FROM="$(iso_offset -10M '10 minutes ago')"
TO="$(iso_offset +5M '5 minutes')"
BODY_FILE="$(mktemp -t nora-infra-degrade)"

log_step "stopping worker-provisioner so its internal buffer endpoint is genuinely unreachable"
compose stop -t 25 worker-provisioner >/dev/null
WORKER_STOPPED=1
still_running="$(compose ps --status running -q worker-provisioner 2>/dev/null)"
if [ -n "$still_running" ]; then
  test_fail "worker-provisioner is still running after 'compose stop' — the outage could not be staged"
  exit 0
fi
log_info "confirmed worker-provisioner is stopped"

outage="$(search_once)"
outage_code="${outage%%|*}"
outage_elapsed="${outage#*|}"
outage_summary="$(body_summary)"
outage_lines="$(json_get "$outage_summary" lines)"
outage_warning="$(json_get "$outage_summary" warning)"
outage_error="$(json_get "$outage_summary" error)"
log_info "during outage: HTTP ${outage_code} in ${outage_elapsed}s, ${outage_summary}"

log_step "restoring worker-provisioner and repeating the identical query"
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "worker-provisioner did not report healthy"
WORKER_STOPPED=0

restored="$(search_once)"
restored_code="${restored%%|*}"
restored_summary="$(body_summary)"
restored_warning="$(json_get "$restored_summary" warning)"
log_info "worker restored: HTTP ${restored_code}, ${restored_summary}"

if [ "$outage_code" != "200" ]; then
  test_fail "search failed outright while the worker was down (HTTP ${outage_code}: ${outage_error:-no error body}) — an unreachable worker is failing the whole query instead of degrading to storage"
elif [ "$outage_warning" != "recent_lines_unavailable" ]; then
  test_fail "search returned 200 during the outage but without the recent_lines_unavailable marker (warning='${outage_warning}') — a caller cannot tell these results are missing the last few minutes"
elif [ "$outage_lines" = "0" ]; then
  test_fail "search returned 200 with the marker but 0 lines, despite ${segments} flushed segment(s) in range — the degraded path is returning nothing rather than falling back to storage"
elif [ "$outage_elapsed" -ge 15 ]; then
  test_fail "the degraded search took ${outage_elapsed}s — the unreachable worker is not being bounded by WORKER_INTERNAL_TIMEOUT_MS"
elif [ "$restored_code" != "200" ]; then
  test_fail "after restoring the worker, the same query returned HTTP ${restored_code}"
elif [ -n "$restored_warning" ]; then
  test_fail "the marker is still present with the worker restored (warning='${restored_warning}') — it is being set unconditionally, not in response to the outage"
else
  test_pass "with worker-provisioner genuinely stopped, search returned HTTP 200 in ${outage_elapsed}s carrying ${outage_lines} storage line(s) and warning=recent_lines_unavailable; with the worker restored, the identical query returned 200 with no marker — the outage degrades search rather than failing it, and the marker tracks the outage"
fi
