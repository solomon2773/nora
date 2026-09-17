#!/usr/bin/env bash
# infra-tests/lib/segment_fixtures.sh — build real log segments directly, and
# read them back, from inside worker-provisioner.
#
# Migration and capacity tests need segments with exact, known byte counts on
# a chosen backend. Flushing a live emitter takes over a minute per test,
# yields whatever count the flush timing happens to produce, and only ever
# lands on the current destination. These helpers write what a flush writes —
# NDJSON, zstd, AES-256-GCM through segmentWriter's own primitives, a real
# object on the chosen backend, and a matching log_segments row — in seconds,
# to `local` or to MinIO.
#
# JS lives in quoted heredocs, and values are substituted into __PLACEHOLDER__
# tokens with bash's ${var//pattern/replacement}, rather than being embedded in
# a bash double-quoted string. That removes the quoting hazard documented in
# lib/node_call_backend_api.sh: nothing in these snippets needs escaping.
#
# Usage:
#   JS='(async () => {
#     const built = await buildSegments({ agentId: "__AGENT_ID__", backend: "local", count: 3 });
#     done({ ids: built.map((s) => s.id) });
#   })().catch(fail);'
#   JS="${JS//__AGENT_ID__/$AGENT_ID}"
#   OUT="$(worker_js "$JS" 2>&1)"
#   RESULT="$(extract_marker RESULT_JSON "$OUT")"

SEGMENT_FIXTURES_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SEGMENT_FIXTURES_LIB_DIR/node_call.sh"
source "$SEGMENT_FIXTURES_LIB_DIR/node_call_backend_api.sh"

segment_fixture_prelude() {
  cat <<'EOF'
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../backend-api/db.ts');
const objectStorage = require('/agent-runtime/lib/objectStorage.ts');
const segmentWriter = require('./logs/segmentWriter.ts');
const logStorageConfigModule = require('./logs/logStorageConfig.ts');

// Matches lib/minio_ctl.sh and docker-compose.override.yml's minio-init.
const MINIO = {
  bucket: '__MINIO_BUCKET__',
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKeyId: '__MINIO_ACCESS_KEY__',
  secretAccessKey: '__MINIO_SECRET_KEY__',
};

async function configFor(backend) {
  const current = await logStorageConfigModule.logStorageConfig();
  if (backend === 'local') return { ...current, storageBackend: 'local' };
  if (backend === 's3') return { ...current, ...MINIO, storageBackend: 's3' };
  throw new Error('configFor: unsupported backend ' + backend);
}

async function buildSegments({ agentId, backend, count, linesPerSegment = 2, startMs }) {
  const owner = await db.query('SELECT user_id FROM agents WHERE id = $1', [agentId]);
  if (!owner.rows[0]) throw new Error('buildSegments: no agents row for ' + agentId);
  const tenant = { workspaceId: null, ownerUserId: owner.rows[0].user_id };
  const config = await configFor(backend);
  const snapshot = logStorageConfigModule.logStorageConfigSnapshot(config);
  const keyRing = segmentWriter.loadLogEncryptionKeys();
  const t0 = startMs || Date.now() - 2 * 60 * 60 * 1000;
  const built = [];
  for (let i = 0; i < count; i++) {
    const fromMs = t0 + i * 10000;
    const toMs = fromMs + 5000;
    const lines = [];
    for (let j = 0; j < linesPerSegment; j++) {
      lines.push({
        ts: new Date(fromMs + 1000 + j * 1000).toISOString(),
        stream: 'runtime',
        level: 'INFO',
        ts_source: 'source',
        ord: j,
        message: 'infra-test fixture seg ' + i + ' line ' + j,
      });
    }
    // buildStorageKey buckets by HH:MM; fixture segments are seconds apart,
    // so a random suffix keeps storage_key unique.
    const storageKey = segmentWriter
      .buildStorageKey(tenant, agentId, 'runtime', new Date(fromMs), new Date(toMs))
      .replace(/\.ndjson\.zst\.enc$/, '-' + crypto.randomBytes(6).toString('hex') + '.ndjson.zst.enc');
    const plain = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    const { buffer, keyId } = segmentWriter.encryptSegment(zlib.zstdCompressSync(plain), keyRing);
    await objectStorage.putStorageObject(storageKey, buffer, config);
    const inserted = await db.query(
      `INSERT INTO log_segments (workspace_id, agent_id, stream, ts_from, ts_to, storage_key,
                                 storage_backend, storage_config, encryption_key_id, bytes, lines)
       VALUES (NULL, $1, 'runtime', $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [agentId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), storageKey, backend,
       JSON.stringify(snapshot), keyId, buffer.length, lines.length],
    );
    built.push({ id: inserted.rows[0].id, storageKey, bytes: buffer.length, lines: lines.length });
  }
  return built;
}

// Reads a segment the way search does: resolve the row's OWN recorded
// location, fetch, decrypt, decompress, count lines.
async function readSegmentById(segmentId) {
  const result = await db.query(
    'SELECT id, storage_key, storage_backend, storage_config, ts_to FROM log_segments WHERE id = $1',
    [segmentId],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'no log_segments row' };
  try {
    const config = await logStorageConfigModule.storageConfigForSegment(row);
    const encrypted = await objectStorage.getStorageObject(row.storage_key, config);
    const plain = zlib.zstdDecompressSync(
      segmentWriter.decryptSegment(encrypted, segmentWriter.loadLogEncryptionKeys()),
    );
    return { ok: true, backend: row.storage_backend, lines: plain.toString('utf8').split('\n').filter(Boolean).length };
  } catch (e) {
    return { ok: false, backend: row.storage_backend, reason: String((e && e.message) || e) };
  }
}

// True if an object exists at storageKey on the given backend.
async function objectExists(storageKey, backend) {
  try {
    await objectStorage.getStorageObject(storageKey, await configFor(backend));
    return true;
  } catch (e) {
    return false;
  }
}

function done(payload) {
  console.log('RESULT_JSON=' + JSON.stringify(payload));
  process.exit(0);
}

function fail(e) {
  console.error('SCRIPT_ERR ' + ((e && e.stack) || e));
  process.exit(1);
}
EOF
}

# worker_js <js-body> — prepends the prelude, fills in the MinIO placeholders,
# and runs the result inside worker-provisioner AS THE LOGS VOLUME'S OWNER.
#
# Not via node_call, which runs as whatever `docker exec` defaults to — root in
# this stack. worker-provisioner's own entrypoint drops to an unprivileged
# user (uid 1000 here), and the segment writer creates files and directories
# with owner-only permissions. Fixtures written as root were therefore
# unreadable and unwritable for the real worker: the first full run of this
# suite failed two scripts with EACCES the moment the live worker touched a
# path a fixture had created, while every script that also drove its
# migration as root passed. Running as the volume's owner is the identity
# production writes with, so fixture data is indistinguishable from flushed
# data. The uid is read from the volume itself rather than assumed.
worker_js() {
  local js
  js="$(segment_fixture_prelude)
$1"
  js="${js//__MINIO_BUCKET__/${MINIO_BUCKET:-nora-logs-local}}"
  js="${js//__MINIO_ACCESS_KEY__/${MINIO_ACCESS_KEY:-noraminio}}"
  js="${js//__MINIO_SECRET_KEY__/${MINIO_SECRET_KEY:-noraminiosecret}}"

  local cid owner tmp_host
  cid="$(container_id_for worker-provisioner)"
  if [ -z "$cid" ]; then
    echo "worker_js: worker-provisioner is not running" >&2
    return 1
  fi
  owner="$(docker exec "$cid" sh -c 'stat -c %u:%g "${NORA_LOG_DIR:-/var/lib/nora-logs}"' 2>/dev/null)"
  if [ -z "$owner" ]; then
    echo "worker_js: could not determine the logs volume owner" >&2
    return 1
  fi

  tmp_host="$(mktemp)"
  printf '%s\n%s\n' "require('tsx/cjs');" "$js" > "$tmp_host"
  # mktemp creates 0600 and docker cp preserves the mode, so without this the
  # copied script is root-owned and unreadable to the volume owner.
  chmod 644 "$tmp_host"
  docker cp "$tmp_host" "${cid}:/app/.infra-test-fixture.js" >/dev/null
  rm -f "$tmp_host"

  local -a secret_env_args=()
  local secret_name secret_value
  for secret_name in $(docker exec "$cid" sh -c 'ls /run/secrets 2>/dev/null'); do
    secret_value="$(docker exec "$cid" sh -c "cat /run/secrets/${secret_name} 2>/dev/null")"
    secret_env_args+=(-e "${secret_name}=${secret_value}")
  done

  docker exec -u "$owner" ${secret_env_args[@]+"${secret_env_args[@]}"} -w /app "$cid" node /app/.infra-test-fixture.js
  local rc=$?
  docker exec "$cid" rm -f /app/.infra-test-fixture.js >/dev/null 2>&1 || true
  return $rc
}

# last_migration_failure <job-id> — the recorded reason a migration job failed, if any.
last_migration_failure() {
  db_query "SELECT message FROM events WHERE type = 'log_storage_migration_failed' AND metadata->>'jobId' = '$1' ORDER BY created_at DESC LIMIT 1;"
}

# json_field <json> <field> — prints a top-level field; objects/arrays as JSON.
json_field() {
  printf '%s' "$1" | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$2"
}
