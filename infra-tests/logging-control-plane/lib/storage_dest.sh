#!/usr/bin/env bash
# infra-tests/lib/storage_dest.sh — temporarily point the platform-wide log
# storage destination at the local MinIO test instance, then restore
# whatever was configured before.
#
# Like lib/local_cap.sh, this mutates real shared platform state
# (`platform_settings`, one row, installation-wide) and requires
# restarting worker-provisioner + backend-api to pick up the change (same
# reason as NORA_LOG_LOCAL_MAX_BYTES: the resolved config is cached
# in-process and only re-read fresh after a restart/cache invalidation —
# see logStorageConfig.ts's `invalidateLogStorageConfigCache()`, which
# only the real `PUT /admin/log-storage` handler calls; going around that
# handler means a restart is the only way to force a re-resolve).
#
# Capture/restore copies the row's columns VERBATIM (including the
# encrypted credential columns) rather than decrypting and re-encrypting —
# there's no need to ever see the plaintext to put the exact same
# encrypted bytes back.

STORAGE_DEST_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$STORAGE_DEST_LIB_DIR/db.sh"
source "$STORAGE_DEST_LIB_DIR/docker_ctl.sh"
source "$STORAGE_DEST_LIB_DIR/node_call.sh"

# cleanup_stale_migration_jobs — deletes any 'failed' storage_migration_jobs
# rows left over from a previous run.
#
# Why this matters specifically for retryStorageMigration(): it re-drives
# "the most recent `failed` job" (`ORDER BY started_at DESC LIMIT 1`, no
# job-id scoping — see storageMigration.ts's own header comment on why:
# there's normally only ever one migration's worth of history that
# matters). That's safe in real usage, where a `failed` job either gets
# retried or superseded before another one could exist. It is NOT safe
# against accumulated test debris: found the hard way during this suite's
# development — a `failed` job from a much earlier, unrelated test run
# was still sitting in the table, and when THIS run's own newly-created
# job happened to complete instead of failing (a separate, since-fixed
# issue), retryStorageMigration() fell through to that stale unrelated
# job instead — silently retrying 29-segment-old history rather than the
# 1 segment this run actually cared about, with `segments_migrated`
# staying 0 for the job this run was watching. Call this at the start of
# any script that will call retryStorageMigration() (or create a job
# expected to reach 'failed'), the same way cleanup_orphaned_test_agents
# guards against stale agent rows.
cleanup_stale_migration_jobs() {
  local stale
  stale="$(db_query "SELECT COUNT(*) FROM storage_migration_jobs WHERE status = 'failed';")"
  if [ "$stale" -gt 0 ]; then
    log_warn "removing ${stale} stale 'failed' storage_migration_jobs row(s) from previous run(s) — leaving them would let retryStorageMigration() silently retry the wrong job"
    db_exec "DELETE FROM storage_migration_jobs WHERE status = 'failed';" >/dev/null
  fi
}

# restart_log_storage_consumers — force worker-provisioner + backend-api to
# re-resolve the destination after a direct platform_settings write.
#
# Must be `compose restart`, NOT `compose up -d`: this file only changes a
# DB row, never the compose config/env, so `up -d` sees nothing to change
# and leaves the already-running containers untouched — the in-process
# logStorageConfig() cache then keeps serving the PREVIOUS destination.
# That silently invalidated every test built on these helpers (e.g. a
# worker still flushing to MinIO with the NULL credentials from an earlier
# set_storage_destination_minio call, failing every write with "S3 storage
# is not fully configured" long after the row itself had real creds).
restart_log_storage_consumers() {
  compose restart worker-provisioner backend-api >/dev/null
  wait_for_healthy worker-provisioner 60
  wait_for_healthy backend-api 60
}

# capture_storage_destination — prints the current row, pipe-delimited, to
# stdout. Capture with:
#   ORIGINAL_DEST="$(capture_storage_destination)"
capture_storage_destination() {
  db_query "SELECT
      COALESCE(log_storage_backend, 'local'),
      COALESCE(log_storage_local_path, ''),
      COALESCE(log_storage_s3_bucket, ''),
      COALESCE(log_storage_s3_region, ''),
      COALESCE(log_storage_s3_endpoint, ''),
      COALESCE(log_storage_s3_access_key_id_encrypted, ''),
      COALESCE(log_storage_s3_secret_access_key_encrypted, '')
    FROM platform_settings WHERE singleton = TRUE;"
}

# set_storage_destination_minio — points the destination at this session's
# local MinIO test instance (bucket/creds match lib/minio_ctl.sh). Restarts
# worker-provisioner + backend-api.
set_storage_destination_minio() {
  db_exec "UPDATE platform_settings SET
      log_storage_backend = 's3',
      log_storage_s3_bucket = 'nora-logs-local',
      log_storage_s3_region = 'us-east-1',
      log_storage_s3_endpoint = 'http://minio:9000',
      log_storage_s3_access_key_id_encrypted = NULL,
      log_storage_s3_secret_access_key_encrypted = NULL
    WHERE singleton = TRUE;" >/dev/null
  # NULL credentials above is deliberate for most callers: NORA_LOG_S3_*
  # env vars aren't set in this stack either, so a plain retry-and-park
  # test would need REAL credentials some other way. Callers that need
  # working MinIO credentials should call set_storage_destination_minio_with_creds
  # instead (below) — this bare version exists for the credential-decryption
  # regression test, which specifically wants to set credentials itself via
  # a real encrypt() call and prove they get used.
  restart_log_storage_consumers
}

# set_storage_destination_minio_with_creds — same as above, but with real,
# working MinIO credentials encrypted via node_call's crypto access, so
# the destination is immediately usable for an actual flush/migration, not
# just for testing credential resolution itself.
set_storage_destination_minio_with_creds() {
  # encrypt()'s output ("hex:hex:hex") has no characters that need SQL
  # escaping, so it's inlined directly into the query text below rather
  # than fighting parameterized-placeholder escaping through three layers
  # of quoting (bash -> JS template literal -> node_call's own heredoc).
  node_call "
    const db = require('../backend-api/db.ts');
    const { encrypt } = require('../backend-api/crypto.ts');
    (async () => {
      const accessKey = encrypt('${MINIO_ACCESS_KEY:-noraminio}');
      const secretKey = encrypt('${MINIO_SECRET_KEY:-noraminiosecret}');
      await db.query(
        \"UPDATE platform_settings SET \" +
        \"log_storage_backend = 's3', \" +
        \"log_storage_s3_bucket = '${MINIO_BUCKET:-nora-logs-local}', \" +
        \"log_storage_s3_region = 'us-east-1', \" +
        \"log_storage_s3_endpoint = 'http://minio:9000', \" +
        \"log_storage_s3_access_key_id_encrypted = '\" + accessKey + \"', \" +
        \"log_storage_s3_secret_access_key_encrypted = '\" + secretKey + \"' \" +
        \"WHERE singleton = TRUE\"
      );
      console.log('OK');
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  " >/dev/null
  restart_log_storage_consumers
}

# restore_storage_destination <captured-row>
restore_storage_destination() {
  local row="$1"
  local backend local_path bucket region endpoint access_key secret_key
  backend="$(echo "$row" | cut -d'|' -f1)"
  local_path="$(echo "$row" | cut -d'|' -f2)"
  bucket="$(echo "$row" | cut -d'|' -f3)"
  region="$(echo "$row" | cut -d'|' -f4)"
  endpoint="$(echo "$row" | cut -d'|' -f5)"
  access_key="$(echo "$row" | cut -d'|' -f6)"
  secret_key="$(echo "$row" | cut -d'|' -f7)"

  local access_key_sql secret_key_sql
  if [ -z "$access_key" ]; then access_key_sql="NULL"; else access_key_sql="'${access_key}'"; fi
  if [ -z "$secret_key" ]; then secret_key_sql="NULL"; else secret_key_sql="'${secret_key}'"; fi

  db_exec "UPDATE platform_settings SET
      log_storage_backend = '${backend}',
      log_storage_local_path = '${local_path}',
      log_storage_s3_bucket = '${bucket}',
      log_storage_s3_region = '${region}',
      log_storage_s3_endpoint = '${endpoint}',
      log_storage_s3_access_key_id_encrypted = ${access_key_sql},
      log_storage_s3_secret_access_key_encrypted = ${secret_key_sql}
    WHERE singleton = TRUE;" >/dev/null
  restart_log_storage_consumers
}

# set_minio_credentials_keep_backend — writes working MinIO bucket, endpoint,
# and encrypted credentials into platform_settings WITHOUT changing
# log_storage_backend, then restarts both consumers.
#
# A migration INTO local still has to read its source objects from MinIO, and
# storageConfigForSegment takes credentials from the current platform
# settings, not from the segment row. So tests migrating s3 -> local need
# MinIO credentials configured while the destination stays local. Capture the
# row with capture_storage_destination first and restore it in cleanup.
set_minio_credentials_keep_backend() {
  node_call "
    const db = require('../backend-api/db.ts');
    const { encrypt } = require('../backend-api/crypto.ts');
    (async () => {
      const accessKey = encrypt('${MINIO_ACCESS_KEY:-noraminio}');
      const secretKey = encrypt('${MINIO_SECRET_KEY:-noraminiosecret}');
      await db.query(
        \"UPDATE platform_settings SET \" +
        \"log_storage_s3_bucket = '${MINIO_BUCKET:-nora-logs-local}', \" +
        \"log_storage_s3_region = 'us-east-1', \" +
        \"log_storage_s3_endpoint = 'http://minio:9000', \" +
        \"log_storage_s3_access_key_id_encrypted = '\" + accessKey + \"', \" +
        \"log_storage_s3_secret_access_key_encrypted = '\" + secretKey + \"' \" +
        \"WHERE singleton = TRUE\"
      );
      console.log('OK');
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  " >/dev/null
  restart_log_storage_consumers
}
