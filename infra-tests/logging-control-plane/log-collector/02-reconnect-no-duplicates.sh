#!/usr/bin/env bash
# Phase 4, test 2: a graceful reconnect doesn't re-ingest duplicate lines.
#
# Regression guard for the bug the plan doc names explicitly: both
# `DockerBackend.logs`/`K8sBackend.logs` used to default an absent `tail`
# to 100, so a collector that simply omitted the option (intending "give
# me everything") actually got "give me the last 100 lines" on every
# single reconnect — re-ingesting up to 100 duplicate lines each time. The
# fix distinguishes an absent `tail` from an explicit one; this test
# proves the fix holds by forcing a real reconnect (a graceful worker
# restart) and checking the flushed content for repeats.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "log-collector" "02-reconnect-no-duplicates"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""

cleanup() {
  test_trap_incomplete
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
  compose up -d worker-provisioner >/dev/null 2>&1 || true
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "reconnect-dup")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's first attach"
sleep 35
log_step "letting it emit a real 40+ line history before the reconnect"
sleep 40

log_step "graceful reconnect: restart worker-provisioner"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"

log_step "waiting ~35s for reattach, then a little more emission"
sleep 35
sleep 10

log_step "forcing a final flush via graceful SIGTERM (retries on the shutdown coordinator's own documented 10s-deadline race — see force_flush_via_sigterm's header — since this final flush is scaffolding to inspect content, not itself under test)"
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "final flush never landed after retries — the check below will fail with a clear message"

log_step "checking flushed segment content for duplicate lines"
# The emitter's content is deterministic ("infra-test line 0", "infra-test
# line 1", ...) and strictly incrementing, so ANY duplicate line number in
# the flushed output is unambiguous evidence of re-ingestion — not
# something that could happen for an innocent reason.
storage_key="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' ORDER BY ts_from LIMIT 1;")"
if [ -z "$storage_key" ]; then
  test_fail "no segment was ever flushed — cannot check for duplicates"
  exit 0
fi

# Decrypt/decompress via the real segmentWriter functions so this reads
# exactly what search/export would read, not a re-implementation of the
# format.
line_numbers="$(node_call "
  const fs = require('fs');
  const zlib = require('zlib');
  const { decryptSegment } = require('./logs/segmentWriter.ts');
  const buf = fs.readFileSync('/var/lib/nora-logs/${storage_key}');
  const decrypted = decryptSegment(buf);
  const decompressed = zlib.zstdDecompressSync(decrypted);
  const lines = decompressed.toString('utf8').split('\n').filter(Boolean);
  for (const raw of lines) {
    const parsed = JSON.parse(raw);
    const m = /infra-test line (\d+)/.exec(parsed.message || '');
    if (m) console.log(m[1]);
  }
  process.exit(0);
")"
node_call_status=$?

if [ "$node_call_status" -ne 0 ]; then
  test_fail "node_call failed decrypting/reading the flushed segment (exit $node_call_status) — cannot check for duplicates. This is NOT the same as '0 lines, all unique': it means the read itself errored (e.g. wrong path, bad format), and must not be treated as a pass."
  exit 0
fi

# Not `grep -c . || echo 0`: when the count is genuinely zero, `grep -c .`
# itself already prints "0" but exits 1 (no matches), which ALSO triggers
# the `|| echo 0` fallback — producing a bogus two-line "0\n0" instead of
# a single "0" (which then breaks the `-eq`/`-ne` comparisons below).
# `wc -l` never fails on empty input, so no fallback is needed.
total_count="$(printf '%s\n' "$line_numbers" | grep -c .)"
unique_count="$(printf '%s\n' "$line_numbers" | sort -n | uniq | grep -c .)"
log_info "total line entries=$total_count, unique line numbers=$unique_count"

if [ "$total_count" -eq 0 ]; then
  test_fail "could not extract any 'infra-test line N' entries from the flushed segment — check the decrypt/decompress path above still matches segmentWriter's real format"
elif [ "$total_count" -ne "$unique_count" ]; then
  test_fail "found $((total_count - unique_count)) duplicate line number(s) across $total_count total — the reconnect re-ingested content it had already flushed"
else
  test_pass "$total_count lines, all unique — reconnect did not re-ingest anything already flushed"
fi
