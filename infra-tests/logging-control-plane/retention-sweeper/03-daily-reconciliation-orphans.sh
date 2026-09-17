#!/usr/bin/env bash
# Phase 5, test 8: daily reconciliation deletes a true orphan (an object
# with no matching log_segments row, older than the in-flight guard).
#
# Scope note: this script covers ONLY the "true orphan gets deleted" half.
# The other half — "a kept `log_segment_legacy_copies` object is NEVER
# treated as an orphan" (item 8a) — needs a real `keepSourceCopies: true`
# migration to set up realistically, so it's covered by
# storage-migration's interrupted-job test instead of duplicated
# here; see that directory's README.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "retention-sweeper" "03-daily-reconciliation-orphans"
# Unlike the other scripts that only ASSUME 'local' (and just warn if it
# isn't), this one's correctness genuinely depends on it:
# `reconcileStorage('')` lists objects from whatever the CURRENT resolved
# destination is, so if that's not 'local', it will list MinIO/S3 instead
# and never see the orphan file this script plants on local disk at all —
# not a "probably fine, just a heads up" situation, an outright wrong-target
# test. Still just a warning, not a hard block (matching this suite's
# general policy of surfacing rather than gatekeeping), but worth reading
# if this test fails in a way that doesn't make sense.
warn_if_destination_not_local

ORPHAN_KEY="user_infra-test-orphan/agent_infra-test-orphan/runtime/2020-01-01/0000-0000.ndjson.zst.enc"
ORPHAN_PATH="/var/lib/nora-logs/${ORPHAN_KEY}"

cleanup() {
  test_trap_incomplete
  compose exec -T worker-provisioner sh -c "rm -f '${ORPHAN_PATH}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1 hour comfortably clears the in-flight guard (DEFAULT_FLUSH_INTERVAL_MS
# = 15 minutes). The fallback timestamp is computed on THIS host (macOS,
# `date -v-1H`, or Linux, `date -d`) and passed into the container as a
# literal `touch -t` value, not re-evaluated inside the container — Alpine
# busybox's own `touch -d` doesn't understand GNU's "1 hour ago" relative
# date syntax, so that first attempt is expected to fail and fall through
# to the literal timestamp every time (not just as a fallback for an
# unusual environment).
old_mtime="$(date -v-1H +%Y%m%d%H%M 2>/dev/null || date -d '1 hour ago' +%Y%m%d%H%M)"
log_step "planting a true orphan object directly on disk (old mtime, no DB row)"
compose exec -T worker-provisioner sh -c "
  mkdir -p \"\$(dirname '${ORPHAN_PATH}')\" &&
  echo 'not a real segment, just orphan bait' > '${ORPHAN_PATH}' &&
  touch -t '${old_mtime}' '${ORPHAN_PATH}'
" >/dev/null

exists_before="$(compose exec -T worker-provisioner sh -c "[ -f '${ORPHAN_PATH}' ] && echo yes || echo no")"
log_info "orphan file present before reconciliation: $exists_before"

log_step "running reconcileStorage('') directly"
reconcile_output="$(node_call "
  const { reconcileStorage } = require('./logs/retentionSweeper.ts');
  reconcileStorage('')
    .then((r) => { console.log('RECONCILE_OK ' + JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('RECONCILE_ERR ' + e.message); process.exit(1); });
")"
log_info "reconcile result: $reconcile_output"

exists_after="$(compose exec -T worker-provisioner sh -c "[ -f '${ORPHAN_PATH}' ] && echo yes || echo no")"
log_info "orphan file present after reconciliation: $exists_after"

if [ "$exists_before" != "yes" ]; then
  test_fail "the orphan file wasn't actually on disk before reconciliation ran — setup problem"
elif [ "$exists_after" = "yes" ]; then
  test_fail "the orphan object is STILL on disk after reconciliation — it should have been deleted (no matching log_segments row, no legacy-copy reference, well past the in-flight guard)"
else
  test_pass "true orphan object was correctly deleted by reconciliation"
fi
