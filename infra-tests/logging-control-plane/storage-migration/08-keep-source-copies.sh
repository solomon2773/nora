#!/usr/bin/env bash
# Phase 5b, matrix row 3: the operator's keep-or-delete choice for the old copy
# is honored, per segment.
#
#   keepSourceCopies = true   the old object stays where it was, and a
#                             log_segment_legacy_copies row records its backend
#                             and the segment's ts_to, so it can expire on its
#                             ORIGINAL retention window rather than live forever
#   keepSourceCopies = false  the old object is deleted, and no legacy row
#                             exists for it
#
# Both outcomes are checked against real storage, not just the job status or
# the table: a job can report "completed" while an object silently survives,
# or while its only surviving copy is unreadable. For every segment this
# checks the index row, a real read through the row's recorded location, the
# old object's presence or absence on local disk, the new object on MinIO, and
# the legacy row's contents.
#
# The two choices run as two consecutive real jobs over two separate sets of
# segments. The first set is already on MinIO by the time the second job
# starts, so the second job's source query cannot pick it up again.

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
test_start "storage-migration" "08-keep-source-copies"
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments_all_backends
cleanup_stale_migration_jobs

AGENT_ID=""
ORIGINAL_DEST=""
KEPT_KEYS=""

START_MARK=""
cleanup() {
  test_trap_incomplete
  if [ -n "$KEPT_KEYS" ]; then
    # The kept local copies are real files this test created on purpose.
    IFS= read -r -d '' CJS <<'EOF'
(async () => {
  const cfg = await configFor('local');
  for (const key of __KEYS__) { try { await objectStorage.deleteStorageObject(key, cfg); } catch (e) {} }
  done({ ok: true });
})().catch(fail);
EOF
    CJS="${CJS//__KEYS__/$KEPT_KEYS}"
    worker_js "$CJS" >/dev/null 2>&1 || true
  fi
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
log_step "pointing the destination at MinIO"
set_storage_destination_minio_with_creds

AGENT_ID="$(provision_logless_test_agent "keep-source")"
log_info "agent_id=${AGENT_ID}"
quarantine_foreign_segments local "$AGENT_ID"

log_step "running a keep=true job over two real segments, then a keep=false job over two more"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const storageMigration = require('./logs/storageMigration.ts');
  const AGENT = '__AGENT_ID__';

  async function runJob(keep) {
    const started = await storageMigration.startStorageMigration(
      { storageBackend: 'local' }, { storageBackend: 's3' }, keep, { autoAdvance: false },
    );
    storageMigration.stopCapacityResumeTimer();
    let outcome;
    for (let i = 0; i < 10; i++) {
      outcome = await storageMigration.migrateSegmentBatch(started.jobId, {});
      if (outcome.done || outcome.status !== 'running') break;
    }
    return { jobId: started.jobId, segmentsTotal: started.segmentsTotal, status: outcome.status };
  }

  async function inspect(segments) {
    const out = [];
    for (const s of segments) {
      const row = await db.query('SELECT storage_backend, ts_to FROM log_segments WHERE id = $1', [s.id]);
      const legacy = await db.query('SELECT storage_backend, ts_to FROM log_segment_legacy_copies WHERE log_segment_id = $1', [s.id]);
      const read = await readSegmentById(s.id);
      out.push({
        indexBackend: row.rows[0].storage_backend,
        readable: read.ok && read.lines === 2,
        oldCopyOnLocal: await objectExists(s.storageKey, 'local'),
        newCopyOnMinio: await objectExists(s.storageKey, 's3'),
        legacyRows: legacy.rows.length,
        legacyBackend: legacy.rows[0] ? legacy.rows[0].storage_backend : null,
        legacyTsToMatches: legacy.rows[0]
          ? new Date(legacy.rows[0].ts_to).getTime() === new Date(row.rows[0].ts_to).getTime()
          : null,
      });
    }
    return out;
  }

  const kept = await buildSegments({ agentId: AGENT, backend: 'local', count: 2 });
  const keepJob = await runJob(true);
  const keptResult = await inspect(kept);

  const dropped = await buildSegments({ agentId: AGENT, backend: 'local', count: 2 });
  const dropJob = await runJob(false);
  const droppedResult = await inspect(dropped);

  done({ keepJob, dropJob, kept: keptResult, dropped: droppedResult, keptKeys: kept.map((s) => s.storageKey) });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
OUT="$(worker_js "$JS" 2>&1)"
R="$(extract_marker RESULT_JSON "$OUT")"
if [ -z "$R" ]; then
  test_fail "the migration run failed: $(printf '%s' "$OUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi
log_info "result: ${R}"
KEPT_KEYS="$(json_field "$R" keptKeys)"

VERDICT="$(printf '%s' "$R" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const problems = [];
  for (const [name, job] of [["keep=true", r.keepJob], ["keep=false", r.dropJob]]) {
    if (job.status !== "completed") problems.push(name + " job ended " + job.status);
    if (job.segmentsTotal !== 2) problems.push(name + " job saw " + job.segmentsTotal + " segment(s), expected 2");
  }
  r.kept.forEach((s, i) => {
    const at = "kept segment " + (i + 1) + ": ";
    if (s.indexBackend !== "s3") problems.push(at + "index row on " + s.indexBackend + ", expected s3");
    if (!s.readable) problems.push(at + "not readable through its recorded location");
    if (!s.newCopyOnMinio) problems.push(at + "no copy on MinIO");
    if (!s.oldCopyOnLocal) problems.push(at + "old local copy was DELETED despite keepSourceCopies=true");
    if (s.legacyRows !== 1) problems.push(at + s.legacyRows + " legacy row(s), expected 1");
    else {
      if (s.legacyBackend !== "local") problems.push(at + "legacy row records backend " + s.legacyBackend + ", expected local");
      if (!s.legacyTsToMatches) problems.push(at + "legacy row ts_to does not match the segment, so it would not expire on the original window");
    }
  });
  r.dropped.forEach((s, i) => {
    const at = "dropped segment " + (i + 1) + ": ";
    if (s.indexBackend !== "s3") problems.push(at + "index row on " + s.indexBackend + ", expected s3");
    if (!s.readable) problems.push(at + "not readable through its recorded location");
    if (!s.newCopyOnMinio) problems.push(at + "no copy on MinIO");
    if (s.oldCopyOnLocal) problems.push(at + "old local copy SURVIVED despite keepSourceCopies=false");
    if (s.legacyRows !== 0) problems.push(at + s.legacyRows + " legacy row(s), expected none");
  });
  process.stdout.write(problems.join("; "));
')"

if [ -n "$VERDICT" ]; then
  test_fail "$VERDICT"
else
  test_pass "keep-or-delete was honored per segment against real storage: with keepSourceCopies=true, both old local copies stayed on disk with one legacy row each recording backend local and the segment's own ts_to; with keepSourceCopies=false, both old copies were deleted with no legacy rows; in both cases every segment was repointed to MinIO and readable there"
fi
