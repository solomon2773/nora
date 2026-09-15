#!/usr/bin/env bash
# Phase 7, matrix row 2: a real search and a real export over the IDENTICAL
# recent time range return the same lines — including content still sitting
# in worker-provisioner's unflushed buffer.
#
# This test exists because that was NOT true. `streamLogExport`
# (backend-api/logSearch.ts) read storage exclusively — it called
# `selectCandidateSegments`/`fetchSegmentLines` and never
# `fetchWorkerBufferOverHttp`, the internal worker call `searchLogs` uses to
# close the recency gap (Phase 6 item 7). So exporting a range that reached
# the present silently omitted every line not yet flushed, while a search
# over the byte-identical range returned them, despite both endpoints being
# documented as taking "the same filters." Found by auditing this phase's
# README against the actual code, then fixed alongside this script;
# `backend-api/__tests__/logExport.test.ts`'s "streamLogExport recency gap"
# block covers the same guarantee with injected deps.
#
# Why this needs real infra rather than another unit test: the divergence
# survived precisely because the existing unit tests mock the buffer fetch
# and use fixed historical timestamps, which `readBufferSnapshots` skips
# outright (a range whose `to` predates the oldest possible open buffer
# never consults the worker at all). Only a real agent, really buffering,
# with a real HTTP round trip from backend-api to worker-provisioner over
# a range that reaches the present, exercises the path that was broken.
#
# The deliberate omission here is the flush: every other script in this
# suite calls `force_flush_via_sigterm` to get durable segments to assert
# on. This one must NOT — the whole point is asserting on content that has
# never been flushed. `segment_count` is checked to be 0 for exactly that
# reason: if a flush somehow landed, the export could pass by reading
# storage and prove nothing about the buffer.
#
# One asymmetry the comparison has to account for, found by running this
# script rather than by reasoning about it: the test agent emits a line
# every second and cannot be queried atomically, so the two calls are
# necessarily sequential (and `mint_jwt` adds real `docker exec` round
# trips between them). Export, called second, therefore legitimately
# returns lines that did not exist when search ran — the first run of this
# script reported export=46 vs search=45 for exactly that reason, which is
# emission timing, not a disagreement. The comparison clamps export to the
# newest timestamp search actually saw; anything past that boundary is
# newer content, not a mismatch. The direction that genuinely matters —
# and the one row 2 exists to catch — is a line search returned that
# export omitted, which is asserted at zero with no tolerance.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"

require_confirmation
test_start "phase7-export" "01-search-export-recency-parity"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""
SEARCH_FILE=""
EXPORT_FILE=""

cleanup() {
  test_trap_incomplete
  [ -n "$SEARCH_FILE" ] && rm -f "$SEARCH_FILE"
  [ -n "$EXPORT_FILE" ] && rm -f "$EXPORT_FILE"
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

# macOS (bash 3.2 / BSD date) first, GNU date as the fallback — this suite
# targets both, see the top-level README's portability note.
iso_offset() {
  date -u -v"$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "$2" +"%Y-%m-%dT%H:%M:%SZ"
}

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "export-recency")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35
log_step "letting it emit for 8s so the buffer holds real, never-flushed content"
sleep 8

segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "segments flushed for this agent: ${segment_count} (expected 0 — this test deliberately never flushes)"
if [ "$segment_count" != "0" ]; then
  test_fail "expected 0 flushed segments (this test asserts on buffer-only content), got ${segment_count} — a flush landed mid-test, so an export passing here would prove nothing about the recency gap"
  exit 0
fi

FROM="$(iso_offset -10M '10 minutes ago')"
TO="$(iso_offset +5M '5 minutes')"
log_info "querying both endpoints over the identical range from=${FROM} to=${TO}"

SEARCH_FILE="$(mktemp -t nora-infra-search)"
EXPORT_FILE="$(mktemp -t nora-infra-export)"

log_step "calling the REAL GET /logs/search with a real JWT"
authed_curl GET "/logs/search?agentId=${AGENT_ID}&from=${FROM}&to=${TO}&limit=1000" user > "$SEARCH_FILE"
search_status=$?

log_step "calling the REAL GET /logs/export over the exact same range"
authed_curl GET "/logs/export?agentId=${AGENT_ID}&from=${FROM}&to=${TO}" user > "$EXPORT_FILE"
export_status=$?

if [ "$search_status" -ne 0 ] || [ "$export_status" -ne 0 ]; then
  test_fail "an endpoint call failed outright (search exit=${search_status}, export exit=${export_status}) — cannot compare results"
  exit 0
fi

log_step "comparing the two result sets line-for-line"
VERDICT="$(node -e '
  const fs = require("fs");
  const searchRaw = fs.readFileSync(process.argv[1], "utf8");
  const exportRaw = fs.readFileSync(process.argv[2], "utf8");
  let search;
  try {
    search = JSON.parse(searchRaw);
  } catch (e) {
    console.log(JSON.stringify({ parseError: searchRaw.slice(0, 300) }));
    process.exit(0);
  }
  const effTs = (l) => l.ts || l.observed_ts;
  const tsMs = (l) => new Date(effTs(l)).getTime();
  const searchLines = search.lines || [];
  const exportLines = exportRaw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return null;
      }
    })
    .filter((l) => l !== null);

  // The agent emits once a second and the two calls cannot be made
  // atomically, so export (issued second) sees content that did not exist
  // when search ran. Clamp to the newest timestamp search actually
  // returned: past that boundary a line is simply newer, not missing from
  // search. See this script header for the run that surfaced this.
  const searchTimes = searchLines.map(tsMs).filter((t) => Number.isFinite(t));
  const newestSearchMs = searchTimes.length ? Math.max.apply(null, searchTimes) : null;
  const comparedExport =
    newestSearchMs === null ? exportLines : exportLines.filter((l) => tsMs(l) <= newestSearchMs);

  const searchSet = new Set(searchLines.map((l) => l.message));
  const exportSet = new Set(comparedExport.map((l) => l.message));
  const onlyInSearch = Array.from(searchSet).filter((m) => !exportSet.has(m));
  const onlyInExport = Array.from(exportSet).filter((m) => !searchSet.has(m));
  console.log(JSON.stringify({
    searchCount: searchLines.length,
    exportCount: exportLines.length,
    comparedExportCount: comparedExport.length,
    arrivedAfterSearch: exportLines.length - comparedExport.length,
    onlyInSearchCount: onlyInSearch.length,
    onlyInExportCount: onlyInExport.length,
    sampleOnlyInSearch: onlyInSearch.slice(0, 3),
    sampleOnlyInExport: onlyInExport.slice(0, 3),
    searchWarning: search.warning || null,
  }));
' "$SEARCH_FILE" "$EXPORT_FILE")"

log_info "comparison: $VERDICT"

parse_error="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).parseError || ""))' 2>/dev/null)"
if [ -n "$parse_error" ]; then
  test_fail "GET /logs/search did not return JSON — likely an auth/routing failure rather than a result mismatch: ${parse_error}"
  exit 0
fi

search_count="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).searchCount))' 2>/dev/null)"
export_count="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).exportCount))' 2>/dev/null)"
only_in_search="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).onlyInSearchCount))' 2>/dev/null)"
only_in_export="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).onlyInExportCount))' 2>/dev/null)"
sample_missing="$(echo "$VERDICT" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).sampleOnlyInSearch))' 2>/dev/null)"
compared_export="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).comparedExportCount))' 2>/dev/null)"
arrived_after="$(echo "$VERDICT" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).arrivedAfterSearch))' 2>/dev/null)"
sample_extra="$(echo "$VERDICT" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).sampleOnlyInExport))' 2>/dev/null)"

# Precondition, not the assertion: if search itself returned nothing there
# is no recency gap to test, and a trivially-equal empty export would be a
# false pass.
if [ -z "$search_count" ] || [ "$search_count" = "0" ]; then
  test_fail "search returned 0 lines over a range covering a live, actively-emitting agent — the buffer read itself is not working, so this test cannot evaluate export parity (check worker-provisioner reachability and that the collector attached)"
  exit 0
fi

if [ "$export_count" = "0" ]; then
  test_fail "export returned 0 lines while search returned ${search_count} over the identical range — this is exactly the Phase 7 row 2 divergence: streamLogExport is reading storage only and ignoring the live buffer"
elif [ "$only_in_search" != "0" ]; then
  test_fail "export omitted ${only_in_search} line(s) that search returned over the identical range (search=${search_count}, export=${export_count}), e.g. ${sample_missing} — export and search disagree over the live-buffer window"
elif [ "$only_in_export" != "0" ]; then
  test_fail "export returned ${only_in_export} line(s) search did not, even after excluding the ${arrived_after} line(s) emitted between the two calls (search=${search_count}, export=${export_count}, compared=${compared_export}), e.g. ${sample_extra} — export is admitting buffer content search filters out, which is a real disagreement rather than emission timing"
else
  test_pass "search and export agree exactly over an identical range covering never-flushed content (search=${search_count}, export=${export_count}, compared=${compared_export} after excluding ${arrived_after} line(s) the agent emitted between the two sequential calls, 0 lines in either that the other lacks, segments_flushed=0) — the recency gap is closed for export, not just search"
fi
