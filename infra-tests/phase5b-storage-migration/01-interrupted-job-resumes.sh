#!/usr/bin/env bash
# Phase 5b, matrix row 2: a migration interrupted MID-BATCH resumes from its
# checkpoint without re-migrating or skipping a single segment.
#
# An earlier version of this script inserted an abandoned 'running' job with
# two segments and restarted the worker. That proved "an abandoned job
# resumes," but the batch size is 100, so two segments never came near a batch
# boundary — it could not show what the plan actually claims.
#
# What makes a mid-batch interruption the interesting case: migrateSegmentBatch
# advances `checkpoint` only at the END of a batch, while each segment's index
# row is repointed as soon as that one segment is copied. A worker killed
# partway through a batch therefore leaves segments already moved past the
# checkpoint. On resume, the batch query (`storage_backend = from AND
# id > checkpoint`) should skip those — they no longer match the source
# backend — and migrate only the rest.
#
# So this builds 600 real local segments (six batches), lets the REAL worker
# drive the job, SIGKILLs the worker the moment the moved count sits strictly
# inside a batch, confirms segments really were moved past the checkpoint at
# the instant of the kill (otherwise the kill landed on a boundary and the run
# proves nothing), restarts, and waits for completion.
#
# This script found a real bug on its first run: progress used to be credited
# once per batch, so the segments moved mid-batch before the kill were never
# counted, and a completed job read 578/600. The fix credits each segment in
# the same statement that repoints it, so moved and credited must now be equal
# at the instant of the kill — asserted directly, as a regression check.
#
# Data correctness and the progress counter are still asserted separately.
# Every segment readable at its new location, none left behind, no source copy
# lingering: that is the plan's data guarantee. `segments_migrated` equalling
# the total is a separate, operator-visible promise — the admin UI shows it as
# migration progress.

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
test_start "phase5b-storage-migration" "01-interrupted-job-resumes"
cleanup_orphaned_test_agents
restore_any_stuck_quarantined_segments_all_backends
cleanup_stale_migration_jobs

SEGMENTS=600
BATCH=100
AGENT_ID=""
ORIGINAL_DEST=""
JOB_ID=""

START_MARK=""
cleanup() {
  test_trap_incomplete
  [ -n "$JOB_ID" ] && db_exec "DELETE FROM storage_migration_jobs WHERE id = '${JOB_ID}';" >/dev/null 2>&1
  [ -n "$START_MARK" ] && db_exec "DELETE FROM storage_migration_jobs WHERE started_at >= '${START_MARK}';" >/dev/null 2>&1
  restore_all_quarantined_segments
  compose up -d worker-provisioner >/dev/null 2>&1 || true
  wait_for_healthy worker-provisioner 60 >/dev/null 2>&1 || true
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

warn_if_destination_not_local
ORIGINAL_DEST="$(capture_storage_destination)"

AGENT_ID="$(provision_logless_test_agent "interrupted")"
log_info "agent_id=${AGENT_ID}"

log_step "building ${SEGMENTS} real local segments (${SEGMENTS}/${BATCH} batches)"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const built = await buildSegments({ agentId: '__AGENT_ID__', backend: 'local', count: __COUNT__ });
  done({ built: built.length });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
JS="${JS//__COUNT__/$SEGMENTS}"
OUT="$(worker_js "$JS" 2>&1)"
built="$(json_field "$(extract_marker RESULT_JSON "$OUT")" built 2>/dev/null)"
if [ "$built" != "$SEGMENTS" ]; then
  test_fail "built ${built:-0} of ${SEGMENTS} local segments: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  exit 0
fi

log_step "pointing the destination at MinIO so the job has somewhere to migrate to"
set_storage_destination_minio_with_creds

# Quarantine only AFTER the switch. The switch restarts the worker, and that
# SIGTERM flushes every dev agent's buffer while the worker still has `local`
# cached — creating fresh foreign local segments. Quarantined before the
# switch, those would be invisible to the quarantine and swept into this job.
quarantine_foreign_segments local "$AGENT_ID"

JOB_ID="$(db_query "
  INSERT INTO storage_migration_jobs (from_backend, to_backend, keep_source, status, segments_total, segments_migrated)
  VALUES ('local', 's3', false, 'running', ${SEGMENTS}, 0) RETURNING id;
")"
log_info "job_id=${JOB_ID}, left 'running' with nothing driving it"

log_step "restarting worker-provisioner so its boot-time resume drives the job for real"
compose stop -t 25 worker-provisioner >/dev/null
compose up -d worker-provisioner >/dev/null

moved_sql="SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND storage_backend = 's3';"
log_step "watching progress, to SIGKILL the worker while the moved count sits strictly inside a batch"
killed=0
moved=0
deadline=$(($(date +%s) + 120))
while [ "$(date +%s)" -lt "$deadline" ]; do
  moved="$(db_query "$moved_sql")"
  if [ "$moved" -ge "$SEGMENTS" ]; then
    break
  fi
  if [ "$moved" -gt 0 ] && [ $((moved % BATCH)) -ne 0 ]; then
    docker kill --signal KILL "$(container_id_for worker-provisioner)" >/dev/null 2>&1
    killed=1
    break
  fi
done

# Snapshot before anything can move on: the container restarts itself
# (restart: unless-stopped), and its boot resume would advance the job.
moved_at_kill="$(db_query "$moved_sql")"
credited_at_kill="$(db_query "SELECT segments_migrated FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
checkpoint_at_kill="$(db_query "SELECT COALESCE(checkpoint::text, '') FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
past_checkpoint="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}' AND storage_backend = 's3' AND ('${checkpoint_at_kill}' = '' OR id > NULLIF('${checkpoint_at_kill}', '')::uuid);")"
log_info "killed=${killed} moved_at_kill=${moved_at_kill} credited_at_kill=${credited_at_kill} checkpoint_at_kill=${checkpoint_at_kill:-none} moved_past_checkpoint=${past_checkpoint}"

if [ "$killed" -ne 1 ]; then
  reason="$(last_migration_failure "$JOB_ID")"
  test_fail "never caught the job strictly inside a batch (last moved count ${moved} of ${SEGMENTS}, job status '$(db_query "SELECT status FROM storage_migration_jobs WHERE id = '${JOB_ID}';")'${reason:+, failure: ${reason}}) — the migration finished or never started within the window, so a mid-batch interruption could not be staged"
  exit 0
fi
if [ "$past_checkpoint" -le 0 ]; then
  test_fail "the kill landed on a batch boundary (moved ${moved_at_kill}, nothing past checkpoint ${checkpoint_at_kill:-none}) — no in-flight batch work existed, so this run cannot test mid-batch resume; re-run"
  exit 0
fi
log_info "${past_checkpoint} segment(s) were moved past the checkpoint at the instant of the kill — a genuine mid-batch interruption"
if [ "$credited_at_kill" != "$moved_at_kill" ]; then
  test_fail "REGRESSION: at the instant of a mid-batch kill, ${moved_at_kill} segment(s) had moved but only ${credited_at_kill} were credited — progress is no longer credited in the same statement that repoints each segment, so a crash will leave a completed job short of its total"
  exit 0
fi

log_step "bringing the worker back and waiting for its boot resume to finish the job"
compose up -d worker-provisioner >/dev/null
wait_for_healthy worker-provisioner 90 || log_warn "worker-provisioner did not report healthy"
job_status=""
deadline=$(($(date +%s) + 180))
while [ "$(date +%s)" -lt "$deadline" ]; do
  job_status="$(db_query "SELECT status FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"
  if [ "$job_status" = "completed" ] || [ "$job_status" = "failed" ]; then break; fi
  sleep 3
done
segments_migrated="$(db_query "SELECT segments_migrated FROM storage_migration_jobs WHERE id = '${JOB_ID}';")"

log_step "verifying every segment against real storage"
IFS= read -r -d '' JS <<'EOF'
(async () => {
  const rows = await db.query('SELECT id, storage_key, storage_backend FROM log_segments WHERE agent_id = $1', ['__AGENT_ID__']);
  let onS3 = 0, readable = 0, sourceLeftOnLocal = 0;
  const problems = [];
  for (const r of rows.rows) {
    if (r.storage_backend === 's3') onS3 += 1;
    const read = await readSegmentById(r.id);
    if (read.ok && read.backend === 's3' && read.lines === 2) readable += 1;
    else if (problems.length < 3) problems.push({ id: r.id, read });
    if (await objectExists(r.storage_key, 'local')) sourceLeftOnLocal += 1;
  }
  done({ rows: rows.rows.length, onS3, readable, sourceLeftOnLocal, problems });
})().catch(fail);
EOF
JS="${JS//__AGENT_ID__/$AGENT_ID}"
OUT="$(worker_js "$JS" 2>&1)"
V="$(extract_marker RESULT_JSON "$OUT")"
log_info "job status=${job_status} segments_migrated=${segments_migrated}; storage check: ${V:-<none>}"

if [ -z "$V" ]; then
  test_fail "could not verify segments against storage: $(printf '%s' "$OUT" | tail -4 | tr '\n' ' ')"
  exit 0
fi
rows="$(json_field "$V" rows)"
on_s3="$(json_field "$V" onS3)"
readable="$(json_field "$V" readable)"
left="$(json_field "$V" sourceLeftOnLocal)"
problems="$(json_field "$V" problems)"

if [ "$job_status" != "completed" ]; then
  test_fail "the job did not complete after the mid-batch kill (status=${job_status:-none}$([ -n "$(last_migration_failure "$JOB_ID")" ] && printf ', failure: %s' "$(last_migration_failure "$JOB_ID")")) — resume from checkpoint is not recovering an interrupted batch"
elif [ "$rows" != "$SEGMENTS" ] || [ "$on_s3" != "$SEGMENTS" ] || [ "$readable" != "$SEGMENTS" ]; then
  test_fail "after resuming a mid-batch kill, ${on_s3}/${SEGMENTS} index rows point at the destination and ${readable}/${SEGMENTS} segments are readable there (rows=${rows}; e.g. ${problems}) — segments were skipped or damaged"
elif [ "$left" != "0" ]; then
  test_fail "all ${SEGMENTS} segments migrated, but ${left} source copy(ies) are still on local storage despite keep_source=false — resume re-read or failed to delete the in-flight batch's sources"
elif [ "$segments_migrated" != "$SEGMENTS" ]; then
  test_fail "DATA IS INTACT — all ${SEGMENTS} segments are on the destination, readable, with no source copies left — but the completed job reads segments_migrated=${segments_migrated}/${SEGMENTS}, so an operator would see the migration stop short of its total"
else
  test_pass "a real SIGKILL mid-batch (${moved_at_kill} moved and ${credited_at_kill} credited at the instant of the kill, ${past_checkpoint} past the checkpoint) resumed from checkpoint to completion: all ${SEGMENTS} segments on the destination and readable, no source copies left, none re-migrated or skipped, and the completed job reads segments_migrated=${segments_migrated}/${SEGMENTS}"
fi
