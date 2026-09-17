#!/usr/bin/env bash
# Phase 5b, matrix row 9: migrating to an object-storage destination never
# consults the local capacity gate and never pauses.
#
# The capacity cap is local disk budget. Object storage has no such budget, so
# a migration to s3 must proceed even if local storage is completely full — a
# gate applied too broadly would strand an operator who is moving OFF local
# precisely because it filled up.
#
# Filling local storage for real is a poor fit here: the migration's source IS
# local, so synthetic local usage would be selected as a segment to migrate
# and fail on its missing object. Instead the capacity check itself is
# replaced by one that always answers "full," and a spy counts every call.
# The migration, its MinIO writes, and its index updates are all real. If the
# code consulted the gate for an s3 destination, the spy would be called and
# the job would pause.
#
# A replaced check is only persuasive if it would actually bite, so the same
# always-full check is then shown to pause a migration into local straight
# away. Without that control, a check the code never reaches would look
# identical to a check the code correctly skips.

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
test_start "storage-migration" "07-object-storage-skips-capacity"
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments_all_backends
cleanup_stale_migration_jobs

SEGMENTS=3
AGENT_ID=""
ORIGINAL_DEST=""

START_MARK=""
cleanup() {
  test_trap_incomplete
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

AGENT_ID="$(provision_logless_test_agent "object-storage-no-gate")"
log_info "agent_id=${AGENT_ID}"
quarantine_foreign_segments local "$AGENT_ID"
quarantine_foreign_segments s3 "$AGENT_ID"

log_step "migrating ${SEGMENTS} real local segments to MinIO with a capacity check that always reports full"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const storageMigration = require('./logs/storageMigration.ts');
  const AGENT = '__AGENT_ID__';
  await buildSegments({ agentId: AGENT, backend: 'local', count: __COUNT__ });

  let s3GateCalls = 0;
  const alwaysFullForS3 = async () => { s3GateCalls += 1; return { atCapacity: true, usedBytes: 1, limitBytes: 1 }; };
  const toS3 = await storageMigration.startStorageMigration(
    { storageBackend: 'local' }, { storageBackend: 's3' }, false, { autoAdvance: false, checkLocalCapacity: alwaysFullForS3 },
  );
  storageMigration.stopCapacityResumeTimer();
  const statuses = [];
  let outcome;
  for (let i = 0; i < 10; i++) {
    outcome = await storageMigration.migrateSegmentBatch(toS3.jobId, { checkLocalCapacity: alwaysFullForS3 });
    statuses.push(outcome.status);
    if (outcome.done || outcome.status === 'paused') break;
  }
  const rows = await db.query('SELECT id FROM log_segments WHERE agent_id = $1', [AGENT]);
  let readableOnS3 = 0;
  for (const r of rows.rows) {
    const read = await readSegmentById(r.id);
    if (read.ok && read.backend === 's3') readableOnS3 += 1;
  }

  // Control: the SAME always-full check must pause a migration into local.
  let localGateCalls = 0;
  const alwaysFullForLocal = async () => { localGateCalls += 1; return { atCapacity: true, usedBytes: 1, limitBytes: 1 }; };
  const localConfig = await configFor('local');
  const toLocal = await storageMigration.startStorageMigration(
    { storageBackend: 's3' }, { storageBackend: 'local' }, false, { autoAdvance: false },
  );
  storageMigration.stopCapacityResumeTimer();
  const control = await storageMigration.migrateSegmentBatch(toLocal.jobId, {
    checkLocalCapacity: alwaysFullForLocal,
    logStorageConfig: async () => localConfig,
  });
  const stillOnS3 = await db.query('SELECT COUNT(*)::int AS n FROM log_segments WHERE agent_id = $1 AND storage_backend = $2', [AGENT, 's3']);
  await db.query('DELETE FROM storage_migration_jobs WHERE id = ANY($1)', [[toS3.jobId, toLocal.jobId]]);

  done({
    segmentsTotal: toS3.segmentsTotal,
    statuses,
    finalStatus: outcome.status,
    s3GateCalls,
    readableOnS3,
    controlStatus: control.status,
    localGateCalls,
    controlLeftSegmentsOnS3: stillOnS3.rows[0].n,
  });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
JS="${JS//__COUNT__/$SEGMENTS}"
OUT="$(worker_js "$JS" 2>&1)"
R="$(extract_marker RESULT_JSON "$OUT")"
if [ -z "$R" ]; then
  test_fail "the migration run failed: $(printf '%s' "$OUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi
log_info "result: ${R}"

total="$(json_field "$R" segmentsTotal)"
final="$(json_field "$R" finalStatus)"
statuses="$(json_field "$R" statuses)"
s3_calls="$(json_field "$R" s3GateCalls)"
readable="$(json_field "$R" readableOnS3)"
control_status="$(json_field "$R" controlStatus)"
local_calls="$(json_field "$R" localGateCalls)"
control_left="$(json_field "$R" controlLeftSegmentsOnS3)"

if [ "$control_status" != "paused" ] || [ "$local_calls" = "0" ] || [ "$control_left" != "$SEGMENTS" ]; then
  test_fail "control failed — the always-full check did not pause a migration into local (status=${control_status}, gate calls=${local_calls}, segments still on s3=${control_left}), so the s3 result below proves nothing"
elif [ "$total" != "$SEGMENTS" ]; then
  test_fail "the s3 job saw ${total} segment(s), expected ${SEGMENTS} — isolation is off"
elif [ "$s3_calls" != "0" ]; then
  test_fail "a migration to s3 consulted the local capacity gate ${s3_calls} time(s) — object storage destinations must never be gated on local disk"
elif echo "$statuses" | grep -q paused; then
  test_fail "a migration to s3 paused (${statuses}) with local storage reporting full"
elif [ "$final" != "completed" ] || [ "$readable" != "$SEGMENTS" ]; then
  test_fail "the migration to s3 did not finish cleanly: final status ${final}, ${readable}/${SEGMENTS} readable on MinIO"
else
  test_pass "with local capacity reporting completely full, a real migration of ${SEGMENTS} segments to MinIO never consulted the gate (0 calls), never paused (${statuses}), and completed with all ${SEGMENTS} readable on MinIO; the same always-full check paused a migration into local on its first batch (${local_calls} call, 0 segments moved), proving the check was live and correctly skipped"
fi
