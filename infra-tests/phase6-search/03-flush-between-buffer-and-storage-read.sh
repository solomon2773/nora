#!/usr/bin/env bash
# Phase 6, matrix row 3: a flush landing between search's buffer read and its
# storage read yields each line exactly once — no gap, no duplicate.
#
# This README row was marked flaky by nature. The window sits a few
# milliseconds inside a single request, and winning that race on purpose from
# outside seemed to need a test-only pause hook or a retry loop.
#
# It needs neither, because the race has a fixed ORDER even though it has no
# fixed timing — buffer read, then flush, then storage read — and each of the
# three steps can be performed for real, one at a time:
#
#   1. Take a genuine snapshot of the agent's live buffer through the same
#      internal HTTP call search uses (fetchWorkerBufferOverHttp).
#   2. Force a genuine flush (SIGTERM, then flushAll), so those same lines
#      now also live in a real segment.
#   3. Run the real searchLogs with its buffer read answered by the snapshot
#      from step 1. Everything else is real: the candidate query, the segment
#      fetch, decryption, and the storage-wins admission.
#
# Nothing about the data is simulated; only the interleaving is pinned. That
# makes this deterministic rather than flaky, and it tests exactly the
# property at stake: admitRecencyGapLines must drop every buffered line the
# flushed segment already covers.
#
# Two guards keep it from passing hollowly.
#
# The snapshot and the segment must actually OVERLAP. Without that, "each
# line exactly once" would hold trivially and prove nothing about
# deduplication. Overlap is measured with a separate storage-only search.
#
# Duplication is measured relative to storage, not in absolute terms. A
# flushed segment can legitimately carry replay duplicates of its own (see
# phase3-segment-writer/02), and those are not what this row is about. So a
# line fails only if the combined result holds MORE copies of it than
# storage alone does — that is, only if admission added one.
#
# Line identity is (message, ts), as phase3-segment-writer/02 established:
# Docker stamps each line with a stable nanosecond timestamp that survives a
# replay unchanged.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/node_call_backend_api.sh"

require_confirmation
test_start "phase6-search" "03-flush-between-buffer-and-storage-read"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""
SNAPSHOT_FILE=""
CONTAINER_SNAPSHOT_PATH="/tmp/.infra-test-snapshot.json"

cleanup() {
  test_trap_incomplete
  [ -n "$SNAPSHOT_FILE" ] && rm -f "$SNAPSHOT_FILE"
  local api_cid
  api_cid="$(container_id_for backend-api)"
  if [ -n "$api_cid" ]; then
    docker exec "$api_cid" rm -f "$CONTAINER_SNAPSHOT_PATH" >/dev/null 2>&1 || true
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

iso_offset() {
  date -u -v"$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "$2" +"%Y-%m-%dT%H:%M:%SZ"
}

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "search-flush-race")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35
log_step "letting it emit for 8s so the buffer holds real content"
sleep 8

segments_before="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
if [ "$segments_before" != "0" ]; then
  test_fail "expected 0 flushed segments before the snapshot, got ${segments_before} — the buffer-then-flush ordering this test pins cannot be established"
  exit 0
fi

log_step "step 1 of 3 — snapshotting the real live buffer through fetchWorkerBufferOverHttp"
SNAP_OUTPUT="$(node_call_backend_api "
(async () => {
  const logSearch = require('/app/logSearch.ts');
  const snap = await logSearch.fetchWorkerBufferOverHttp('${AGENT_ID}', 'runtime');
  const lines = snap && Array.isArray(snap.lines) ? snap.lines : [];
  console.log('SNAPSHOT_JSON=' + JSON.stringify(lines));
  process.exit(0);
})().catch((e) => { console.error('SCRIPT_ERR ' + ((e && e.stack) || e)); process.exit(1); });
" 2>&1)"
snap_rc=$?
SNAPSHOT_JSON="$(extract_marker SNAPSHOT_JSON "$SNAP_OUTPUT")"
if [ "$snap_rc" -ne 0 ] || [ -z "$SNAPSHOT_JSON" ]; then
  test_fail "could not read the live buffer (exit ${snap_rc}): $(printf '%s' "$SNAP_OUTPUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi
SNAPSHOT_FILE="$(mktemp -t nora-infra-snapshot)"
printf '%s' "$SNAPSHOT_JSON" > "$SNAPSHOT_FILE"
snapshot_count="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length))' "$SNAPSHOT_FILE")"
log_info "snapshot holds ${snapshot_count} buffered line(s)"
if [ "$snapshot_count" = "0" ]; then
  test_fail "the live buffer snapshot was empty — the collector never attached, so there is nothing for a flush to overlap"
  exit 0
fi

log_step "step 2 of 3 — forcing a real flush, so the snapshotted lines now also exist in a segment"
if ! force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND stream = 'runtime';"; then
  test_fail "the forced flush never produced a runtime segment — the flush half of the race could not be performed"
  exit 0
fi
segments_after_flush="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND stream = 'runtime';")"
log_info "runtime segments after flush: ${segments_after_flush}"

log_step "step 3 of 3 — running the real searchLogs with its buffer read answered by the pre-flush snapshot"
API_CID="$(container_id_for backend-api)"
if [ -z "$API_CID" ]; then
  test_fail "backend-api is not running after the flush"
  exit 0
fi
docker exec -i "$API_CID" sh -c "cat > ${CONTAINER_SNAPSHOT_PATH}" < "$SNAPSHOT_FILE"

FROM="$(iso_offset -10M '10 minutes ago')"
TO="$(iso_offset +5M '5 minutes')"
RACE_OUTPUT="$(node_call_backend_api "
(async () => {
  const fs = require('fs');
  const db = require('/app/db.ts');
  const logSearch = require('/app/logSearch.ts');
  const AGENT_ID = '${AGENT_ID}';
  const snapshot = JSON.parse(fs.readFileSync('${CONTAINER_SNAPSHOT_PATH}', 'utf8'));

  const ownerRow = await db.query('SELECT user_id FROM agents WHERE id = \$1', [AGENT_ID]);
  const actor = { id: ownerRow.rows[0].user_id, role: 'user' };
  const params = { agentId: AGENT_ID, streams: ['runtime'], from: '${FROM}', to: '${TO}', limit: 1000 };
  const id = (l) => String(l.message || '') + '@' + String(l.ts || l.observed_ts);
  const tally = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(id(l), (m.get(id(l)) || 0) + 1);
    return m;
  };

  // Storage only: the buffer read answers with nothing.
  const storageOnly = await logSearch.searchLogs(params, actor, { fetchWorkerBuffer: async () => null });
  // The race: buffer read answers with what the buffer held before the flush.
  const raced = await logSearch.searchLogs(params, actor, {
    fetchWorkerBuffer: async (_agentId, stream) =>
      stream === 'runtime' ? { found: true, lines: snapshot } : null,
  });

  const storageCounts = tally(storageOnly.lines);
  const racedCounts = tally(raced.lines);
  const snapshotIds = Array.from(new Set(snapshot.map(id)));

  const overlap = snapshotIds.filter((k) => storageCounts.has(k));
  const addedByAdmission = snapshotIds.filter(
    (k) => (racedCounts.get(k) || 0) > Math.max(storageCounts.get(k) || 0, 1),
  );
  const missing = snapshotIds.filter((k) => !racedCounts.has(k));
  let storageInternalDuplicates = 0;
  for (const c of storageCounts.values()) if (c > 1) storageInternalDuplicates += 1;

  console.log('RESULT_JSON=' + JSON.stringify({
    snapshotLines: snapshotIds.length,
    storageOnlyLines: storageOnly.lines.length,
    racedLines: raced.lines.length,
    overlap: overlap.length,
    addedByAdmission: addedByAdmission.length,
    missing: missing.length,
    storageInternalDuplicates,
    sampleAdded: addedByAdmission.slice(0, 3),
    sampleMissing: missing.slice(0, 3),
  }));
  process.exit(0);
})().catch((e) => { console.error('SCRIPT_ERR ' + ((e && e.stack) || e)); process.exit(1); });
" 2>&1)"
race_rc=$?
RESULT_JSON="$(extract_marker RESULT_JSON "$RACE_OUTPUT")"
log_info "node exit=${race_rc} result: ${RESULT_JSON:-<none>}"

if [ "$race_rc" -ne 0 ] || [ -z "$RESULT_JSON" ]; then
  test_fail "running searchLogs over the pinned race failed (exit ${race_rc}): $(printf '%s' "$RACE_OUTPUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi

field() {
  printf '%s' "$RESULT_JSON" | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$1"
}
snapshot_lines="$(field snapshotLines)"
overlap="$(field overlap)"
added="$(field addedByAdmission)"
missing="$(field missing)"
raced_lines="$(field racedLines)"
storage_lines="$(field storageOnlyLines)"
storage_dups="$(field storageInternalDuplicates)"
sample_added="$(field sampleAdded)"
sample_missing="$(field sampleMissing)"

if [ "$overlap" = "0" ]; then
  test_fail "the pre-flush snapshot (${snapshot_lines} line(s)) and the flushed segment (${storage_lines} line(s)) share no lines, so the race was not actually staged and 'exactly once' would hold trivially — result inconclusive"
elif [ "$added" != "0" ]; then
  test_fail "admission added a duplicate for ${added} line(s) storage already held (e.g. ${sample_added}) — a flush landing between the buffer read and the storage read produces DUPLICATES; storage is not winning on overlap"
elif [ "$missing" != "0" ]; then
  test_fail "${missing} snapshotted line(s) are absent from the result entirely (e.g. ${sample_missing}) — a flush landing between the buffer read and the storage read produces a GAP"
else
  test_pass "with a real flush pinned between a real buffer read and the real storage read, all ${snapshot_lines} buffered line(s) appear exactly once: ${overlap} of them were also in the flushed segment and storage won every overlap, 0 duplicates added and 0 gaps (${raced_lines} line(s) returned; ${storage_dups} replay duplicate(s) already inside storage, excluded from the count by design)"
fi
