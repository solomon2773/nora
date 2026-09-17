#!/usr/bin/env bash
# Phase 5b, matrix row 1: a segment is readable from its old location
# throughout its own migration, and from its new location immediately after —
# there is no moment when it exists in neither place.
#
# This is the promise Decision 2b-i buys: every segment records where it
# lives, so a reader resolving the row mid-migration always lands on a real
# object. migrateOneSegment enforces it purely by ORDER — read old, write new,
# repoint the index row, then delete old — and a gap would appear if any step
# ran out of that order.
#
# The README suggested catching this with a large segment or an injected sleep
# and a racing reader. There is no need to race. The migration's own step
# functions are injectable, so this wraps the real ones — the real MinIO
# write, the real index-row update, the real delete — and, the instant each
# one returns, reads the segment the way search does: resolve the row's
# recorded location, fetch, decrypt, decompress, count lines. Four reads, one
# at every boundary a gap could hide in, each against real storage and the
# real row. Nothing is simulated; the reads are simply placed exactly where a
# racing reader would have to get lucky to land.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"
source "$SCRIPT_DIR/../lib/minio_ctl.sh"
source "$SCRIPT_DIR/../lib/quarantine.sh"
source "$SCRIPT_DIR/../lib/segment_fixtures.sh"

require_confirmation
test_start "storage-migration" "05-readable-throughout-migration"
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments_all_backends
cleanup_stale_migration_jobs

AGENT_ID=""
ORIGINAL_DEST=""
JOB_ID=""

START_MARK=""
cleanup() {
  test_trap_incomplete
  [ -n "$JOB_ID" ] && db_exec "DELETE FROM storage_migration_jobs WHERE id = '${JOB_ID}';" >/dev/null 2>&1
  [ -n "$START_MARK" ] && db_exec "DELETE FROM storage_migration_jobs WHERE started_at >= '${START_MARK}';" >/dev/null 2>&1
  restore_all_quarantined_segments
  [ -n "$ORIGINAL_DEST" ] && restore_storage_destination "$ORIGINAL_DEST"
  teardown_logless_test_agent "$AGENT_ID"
  return 0
}
trap cleanup EXIT

active="$(db_query "SELECT COUNT(*) FROM storage_migration_jobs WHERE status IN ('running','paused');")"
if [ "$active" != "0" ]; then
  test_fail "${active} storage migration job(s) are already running or paused on this stack — refusing to start another"
  exit 0
fi
# Nothing was active a moment ago, so every job started from here on is this
# script's own. Cleanup deletes them by this mark rather than by returned id:
# if a JS step dies after creating a job but before reporting it, a leftover
# 'running' row would otherwise be driven by the next worker boot.
START_MARK="$(db_query "SELECT NOW();")"

ORIGINAL_DEST="$(capture_storage_destination)"
log_step "configuring MinIO credentials so the post-migration read can reach the new location"
set_minio_credentials_keep_backend

AGENT_ID="$(provision_logless_test_agent "readable-migration")"
log_info "agent_id=${AGENT_ID}"
quarantine_foreign_segments local "$AGENT_ID"

log_step "migrating one real local segment to MinIO, reading it back at every step boundary"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const storageMigration = require('./logs/storageMigration.ts');
  const [seg] = await buildSegments({ agentId: '__AGENT_ID__', backend: 'local', count: 1, linesPerSegment: 3 });
  const probes = [];
  const probe = async (label) => { probes.push({ label, ...(await readSegmentById(seg.id)) }); };
  await probe('before migration');

  const toConfig = await configFor('s3');
  const started = await storageMigration.startStorageMigration(
    { storageBackend: 'local' }, { storageBackend: 's3' }, false, { autoAdvance: false },
  );
  storageMigration.stopCapacityResumeTimer();

  const deps = {
    logStorageConfig: async () => toConfig,
    db: {
      query: async (sql, params) => {
        const result = await db.query(sql, params);
        if (/UPDATE log_segments SET storage_backend/.test(sql)) {
          await probe('after index row repointed, before old copy deleted');
        }
        return result;
      },
    },
    putStorageObject: async (key, body, config) => {
      await objectStorage.putStorageObject(key, body, config);
      await probe('after new copy written, before index row repointed');
    },
    deleteStorageObject: async (key, config) => {
      await objectStorage.deleteStorageObject(key, config);
      await probe('after old copy deleted');
    },
  };
  let outcome;
  for (let i = 0; i < 5; i++) {
    outcome = await storageMigration.migrateSegmentBatch(started.jobId, deps);
    if (outcome.done || outcome.status !== 'running') break;
  }
  done({
    jobId: started.jobId,
    segmentsTotal: started.segmentsTotal,
    outcome: outcome.status,
    probes,
    oldCopyOnLocal: await objectExists(seg.storageKey, 'local'),
    newCopyOnMinio: await objectExists(seg.storageKey, 's3'),
  });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
OUT="$(worker_js "$JS" 2>&1)"
R="$(extract_marker RESULT_JSON "$OUT")"
if [ -z "$R" ]; then
  test_fail "the instrumented migration failed to run: $(printf '%s' "$OUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi
JOB_ID="$(json_field "$R" jobId)"
log_info "result: ${R}"

VERDICT="$(printf '%s' "$R" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const expected = [
    ["before migration", "local"],
    ["after new copy written, before index row repointed", "local"],
    ["after index row repointed, before old copy deleted", "s3"],
    ["after old copy deleted", "s3"],
  ];
  const problems = [];
  if (r.segmentsTotal !== 1) problems.push("job segments_total=" + r.segmentsTotal + ", expected 1 (isolation)");
  if (r.outcome !== "completed") problems.push("job ended " + r.outcome);
  if (r.probes.length !== expected.length) problems.push("took " + r.probes.length + " reads, expected " + expected.length + " — a step did not run");
  expected.forEach(([label, backend], i) => {
    const p = r.probes[i];
    if (!p) return;
    if (p.label !== label) problems.push("read " + (i + 1) + " happened at \"" + p.label + "\", expected \"" + label + "\" — steps ran out of order");
    else if (!p.ok) problems.push("GAP at \"" + label + "\": the row pointed at " + p.backend + " and nothing was readable there (" + p.reason + ")");
    else if (p.backend !== backend) problems.push("at \"" + label + "\" the row pointed at " + p.backend + ", expected " + backend);
    else if (p.lines !== 3) problems.push("at \"" + label + "\" read " + p.lines + " line(s), expected 3");
  });
  if (r.oldCopyOnLocal) problems.push("the old local copy still exists after a keep_source=false migration");
  if (!r.newCopyOnMinio) problems.push("the new MinIO copy is missing at the end");
  process.stdout.write(problems.join("; "));
')"

if [ -n "$VERDICT" ]; then
  test_fail "$VERDICT"
else
  test_pass "one real segment stayed readable at every boundary of its own migration: from local before the move and after the new MinIO copy was written, then from MinIO immediately after the index row was repointed and after the old copy was deleted — all four reads returned the full 3 lines through the row's recorded location, the steps ran in the safe order, and the old copy was gone at the end"
fi
