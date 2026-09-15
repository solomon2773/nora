#!/usr/bin/env bash
# Phase 5b, matrix rows 6, 8, and 7 — the capacity gate on a migration INTO
# local, as one real sequence:
#
#   row 6  usage crosses the cap mid-run: the job PAUSES at its checkpoint
#          (not `failed`), and live collection halts at the same moment
#   row 8  a worker restart while still over the cap does not bypass the gate
#   row 7  once usage drops back under the cap, the job resumes by itself from
#          its checkpoint — no operator action
#
# How usage crosses the cap without editing .env or recreating containers:
# local capacity is a database sum — SUM(bytes) over log_segments rows on
# `local` — compared against NORA_LOG_LOCAL_MAX_BYTES as the worker process
# sees it. One synthetic row whose `bytes` equals the real configured cap puts
# usage at the cap exactly; deleting it drops usage back. The gate, the job,
# and the resume path are all real, and the cap is the stack's own. This also
# models the scenario the plan cares about: live collection and a migration
# draw from one installation-wide budget, and something other than the
# migration fills it.
#
# Ordering is pinned the way phase6-search/03 pins its race. The first batch is
# driven step by step (batch size 2) so the pause lands between two known
# batches. Then the REAL worker takes over: its boot-time resume (row 8) and
# the capacity-resume timer that boot starts (row 7). Nothing in the second
# half calls the migration code directly.
#
# Row 8 is only meaningful if the worker genuinely looked at the job while it
# was over the cap. It did if row 7 passes: the only thing that starts the
# live worker's resume timer is its boot resume finding this job, so a
# completed row 7 proves the boot resume ran — and re-confirmed `paused`.
#
# Side effect, by design and restored on exit: while the synthetic row exists
# the installation is genuinely at capacity, so live collection halts for
# every agent on this stack for the length of that window. Collection resumes
# from each agent's last flushed cursor, as it would after any capacity halt.

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
test_start "phase5b-storage-migration" "04-capacity-pause-restart-resume"
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments_all_backends
cleanup_stale_migration_jobs
db_exec "DELETE FROM log_segments WHERE storage_key LIKE 'infra-test-synthetic-usage-%';" >/dev/null 2>&1 || true

SEGMENTS=6
AGENT_ID=""
ORIGINAL_DEST=""
JOB_ID=""
SYNTH_ID=""

START_MARK=""
cleanup() {
  test_trap_incomplete
  # Synthetic usage first: it is what holds the whole stack at capacity.
  [ -n "$SYNTH_ID" ] && db_exec "DELETE FROM log_segments WHERE id = '${SYNTH_ID}';" >/dev/null 2>&1
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
if [ "$(echo "$ORIGINAL_DEST" | cut -d'|' -f1)" != "local" ]; then
  test_fail "this test migrates INTO local and needs the destination to be local (it is '$(echo "$ORIGINAL_DEST" | cut -d'|' -f1)')"
  exit 0
fi

CAP="$(compose exec -T worker-provisioner printenv NORA_LOG_LOCAL_MAX_BYTES 2>/dev/null | tr -d '[:space:]')"
case "$CAP" in
  '' | *[!0-9]*)
    test_fail "worker-provisioner has no numeric NORA_LOG_LOCAL_MAX_BYTES ('${CAP}') — with no cap the gate never engages, so there is nothing to test"
    exit 0
    ;;
esac
log_info "the stack's real local capacity cap: ${CAP} bytes"

log_step "configuring MinIO credentials (destination stays local) so the migration can read its source"
set_minio_credentials_keep_backend

AGENT_ID="$(provision_logless_test_agent "capacity-gate")"
log_info "agent_id=${AGENT_ID}"

# local_rows counts this test's real segments on local, never the synthetic row.
local_rows() { db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND storage_backend = 'local' AND storage_key NOT LIKE 'infra-test-synthetic-usage-%';"; }
s3_rows() { db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND storage_backend = 's3';"; }
job_field() { db_query "SELECT $1 FROM storage_migration_jobs WHERE id = '${JOB_ID}';"; }
event_since() { db_query "SELECT COUNT(*) FROM events WHERE type = '$1' AND created_at >= '$2';"; }
wait_event_since() { # <type> <since> <timeout_s>
  local deadline=$(($(date +%s) + $3))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(event_since "$1" "$2")" != "0" ] && return 0
    sleep 3
  done
  return 1
}

log_step "building ${SEGMENTS} real segments in MinIO to migrate into local"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const built = await buildSegments({ agentId: '__AGENT_ID__', backend: 's3', count: __COUNT__ });
  done({ built: built.length, bytes: built.reduce((sum, s) => sum + s.bytes, 0) });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
JS="${JS//__COUNT__/$SEGMENTS}"
OUT="$(worker_js "$JS" 2>&1)"
R="$(extract_marker RESULT_JSON "$OUT")"
if [ "$(json_field "$R" built 2>/dev/null)" != "$SEGMENTS" ]; then
  test_fail "could not build ${SEGMENTS} MinIO segments: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  exit 0
fi

quarantine_foreign_segments s3 "$AGENT_ID"
quarantine_foreign_segments local "$AGENT_ID"

# ── Row 6: pause at the checkpoint, not fail ───────────────────────────────

log_step "starting a real s3 -> local job and driving its first batch (2 segments) directly"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const storageMigration = require('./logs/storageMigration.ts');
  const started = await storageMigration.startStorageMigration(
    { storageBackend: 's3' }, { storageBackend: 'local' }, false, { autoAdvance: false },
  );
  storageMigration.stopCapacityResumeTimer();
  const batch = await storageMigration.migrateSegmentBatch(started.jobId, { batchSize: 2 });
  done({ jobId: started.jobId, segmentsTotal: started.segmentsTotal, status: batch.status, migrated: batch.migrated || 0 });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
OUT="$(worker_js "$JS" 2>&1)"
R="$(extract_marker RESULT_JSON "$OUT")"
JOB_ID="$(json_field "$R" jobId 2>/dev/null)"
if [ -z "$JOB_ID" ]; then
  test_fail "could not start the migration job: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  exit 0
fi
total="$(json_field "$R" segmentsTotal)"
if [ "$total" != "$SEGMENTS" ] || [ "$(json_field "$R" status)" != "running" ] || [ "$(json_field "$R" migrated)" != "2" ]; then
  test_fail "unexpected first batch (job total=${total}, expected ${SEGMENTS}): ${R} — isolation or setup is off"
  exit 0
fi
checkpoint_before="$(job_field checkpoint)"
log_info "job ${JOB_ID}: first batch moved 2 of ${total}; checkpoint=${checkpoint_before}"

MARK="$(db_query "SELECT NOW()::timestamp;")"
log_step "pushing local usage to the real cap with one synthetic row (bytes=${CAP})"
SYNTH_ID="$(db_query "
  INSERT INTO log_segments (agent_id, stream, ts_from, ts_to, storage_key, storage_backend, storage_config, encryption_key_id, bytes, lines)
  VALUES ('${AGENT_ID}', 'runtime', NOW(), NOW(), 'infra-test-synthetic-usage-$(date +%s)', 'local', '{}'::jsonb, 'default', ${CAP}, 0)
  RETURNING id;
")"

log_step "driving the next batch — it should pause"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const storageMigration = require('./logs/storageMigration.ts');
  const batch = await storageMigration.migrateSegmentBatch('__JOB_ID__', { batchSize: 2 });
  done({ status: batch.status, done: batch.done, migrated: batch.migrated || 0 });
})().catch(fail);
EOF
JS="${JS//__JOB_ID__/$JOB_ID}"
OUT="$(worker_js "$JS" 2>&1)"
R="$(extract_marker RESULT_JSON "$OUT")"
paused_status="$(job_field status)"
paused_checkpoint="$(job_field checkpoint)"
paused_migrated="$(job_field segments_migrated)"
paused_local="$(local_rows)"
paused_s3="$(s3_rows)"
paused_event="$(event_since log_storage_migration_paused "$MARK")"
log_info "after the capacity breach: batch=${R:-<none>} job status=${paused_status} checkpoint=${paused_checkpoint} migrated=${paused_migrated} local=${paused_local} s3=${paused_s3} paused_event=${paused_event}"

row6_fail=""
if [ "$paused_status" != "paused" ]; then
  row6_fail="job status is '${paused_status}', not 'paused'"
elif [ "$paused_checkpoint" != "$checkpoint_before" ] || [ "$paused_migrated" != "2" ] || [ "$paused_local" != "2" ] || [ "$paused_s3" != "4" ]; then
  row6_fail="the job moved while over the cap (checkpoint ${checkpoint_before} -> ${paused_checkpoint}, migrated=${paused_migrated}, local=${paused_local}, s3=${paused_s3})"
elif [ "$paused_event" = "0" ]; then
  row6_fail="no log_storage_migration_paused event was recorded"
fi

log_step "waiting up to 45s for live collection to halt on the same breach"
halted=0
wait_event_since log_storage_capacity_halted "$MARK" 45 && halted=1
[ -z "$row6_fail" ] && [ "$halted" -ne 1 ] && row6_fail="the job paused, but live collection did not halt (no log_storage_capacity_halted event within 45s) — the two are not sharing one budget"

# ── Row 8: a restart while still over the cap does not bypass the gate ─────

log_step "restarting worker-provisioner while still over the cap"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 90 || log_warn "worker-provisioner did not report healthy"
log_step "giving boot resume and two resume-timer ticks time to act (25s)"
sleep 25
r8_status="$(job_field status)"
r8_checkpoint="$(job_field checkpoint)"
r8_migrated="$(job_field segments_migrated)"
r8_s3="$(s3_rows)"
log_info "after restart, still over cap: status=${r8_status} checkpoint=${r8_checkpoint} migrated=${r8_migrated} s3=${r8_s3}"
row8_fail=""
if [ "$r8_status" != "paused" ] || [ "$r8_checkpoint" != "$checkpoint_before" ] || [ "$r8_migrated" != "2" ] || [ "$r8_s3" != "4" ]; then
  row8_fail="the restart bypassed the gate: status=${r8_status}, checkpoint ${checkpoint_before} -> ${r8_checkpoint}, migrated=${r8_migrated}, s3=${r8_s3}"
fi

# ── Row 7: usage drops, the job resumes by itself ──────────────────────────

MARK2="$(db_query "SELECT NOW()::timestamp;")"
log_step "dropping usage back under the cap (removing the synthetic row) — no other action from here on"
db_exec "DELETE FROM log_segments WHERE id = '${SYNTH_ID}';" >/dev/null
SYNTH_ID=""

final_status=""
deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  final_status="$(job_field status)"
  if [ "$final_status" = "completed" ] || [ "$final_status" = "failed" ]; then break; fi
  sleep 3
done
final_migrated="$(job_field segments_migrated)"
resumed_event=0
wait_event_since log_storage_capacity_resumed "$MARK2" 45 && resumed_event=1

IFS= read -r -d '' JS <<'EOF'
(async () => {
  const rows = await db.query('SELECT id, storage_key FROM log_segments WHERE agent_id = $1', ['__AGENT_ID__']);
  let readableOnLocal = 0, sourceLeftInMinio = 0;
  for (const r of rows.rows) {
    const read = await readSegmentById(r.id);
    if (read.ok && read.backend === 'local') readableOnLocal += 1;
    if (await objectExists(r.storage_key, 's3')) sourceLeftInMinio += 1;
  }
  done({ rows: rows.rows.length, readableOnLocal, sourceLeftInMinio });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
OUT="$(worker_js "$JS" 2>&1)"
V="$(extract_marker RESULT_JSON "$OUT")"
log_info "after usage dropped: status=${final_status} migrated=${final_migrated} resumed_event=${resumed_event} storage=${V:-<none>}"

row7_fail=""
if [ "$final_status" != "completed" ]; then
  reason="$(last_migration_failure "$JOB_ID")"
  row7_fail="the job did not resume and complete on its own within 90s of usage dropping (status=${final_status}${reason:+, failure: ${reason}})"
elif [ "$final_migrated" != "$SEGMENTS" ]; then
  row7_fail="the job completed with segments_migrated=${final_migrated}, expected ${SEGMENTS}"
elif [ "$(json_field "$V" readableOnLocal)" != "$SEGMENTS" ] || [ "$(json_field "$V" sourceLeftInMinio)" != "0" ]; then
  row7_fail="after completion, storage does not match: ${V}"
elif [ "$resumed_event" -ne 1 ]; then
  row7_fail="the migration resumed, but live collection did not (no log_storage_capacity_resumed event within 45s)"
fi

# Row 8 depends on row 7 having proved the boot resume actually ran.
if [ -z "$row8_fail" ] && [ -n "$row7_fail" ]; then
  row8_fail="inconclusive: row 7 did not complete, so there is no proof the restarted worker ever re-examined the paused job"
fi

summary="row 6 (pause, not fail; collection halts): ${row6_fail:-PASS}; row 8 (restart does not bypass): ${row8_fail:-PASS}; row 7 (auto-resume from checkpoint): ${row7_fail:-PASS}"
if [ -z "$row6_fail$row8_fail$row7_fail" ]; then
  test_pass "with local usage pushed to the stack's real ${CAP}-byte cap mid-migration, the job paused at its checkpoint after 2 of ${SEGMENTS} segments and live collection halted; a worker restart left it paused and untouched; removing the usage let the live worker resume it on its own from the checkpoint to ${final_migrated}/${SEGMENTS}, with every segment readable on local and no source copies left, and live collection resumed. ${summary}"
else
  test_fail "$summary"
fi
