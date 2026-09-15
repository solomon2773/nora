#!/usr/bin/env bash
# Phase 6, matrix row 1: search fetches candidate segments concurrently
# against a real object store, rather than being serialized by the
# connection pool underneath it.
#
# The plan names this risk directly: a serial implementation passes every
# test against the `local` driver, where a disk read takes about a
# millisecond, and then fails in production against s3/r2, where every
# fetch is a network round trip. Only a real object store shows the
# difference. So segments are built straight into MinIO the way
# phase13-traces-lens/01 builds them — real NDJSON, real zstd, real
# AES-256-GCM through segmentWriter's own primitives, real upload, matching
# log_segments row — and then the REAL logSearch.searchLogs runs over them.
#
# Two independent signals are required, because each can mislead alone:
#
#   - A spy wrapped around the real getStorageObject records the peak number
#     of simultaneously pending fetches. That proves the application FANS
#     OUT, deterministically, with no timing involved. It cannot see the
#     failure the plan actually warns about, though: undici queuing requests
#     at the socket layer would still leave every promise "pending" while
#     serializing the real I/O underneath.
#   - Wall time against a single-fetch baseline catches exactly that. A
#     genuinely concurrent fetch of N segments lands near ONE fetch's
#     latency; a serialized one lands near N times it.
#
# Each is measured three times and the median taken — local MinIO round
# trips are around 10ms, fast enough that one sample is noisy, and the first
# search also pays for undici's lazy require.
#
# Each timed run gets a fresh decoded-segment cache. fetchSegmentLines keeps
# decoded plaintext in a module-level LRU keyed by storage_key, so a second
# search in the same process would hit the cache and fetch nothing at all.
# The real fetchSegmentLines still runs; only its cache instance is swapped.
#
# The query range sits entirely more than a flush interval in the past, so
# readBufferSnapshots skips the worker call and no internal HTTP round trip
# pollutes the timing.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"
source "$SCRIPT_DIR/../lib/minio_ctl.sh"
source "$SCRIPT_DIR/../lib/node_call_backend_api.sh"

require_confirmation
test_start "phase6-search" "01-concurrent-fetch-real-minio"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents

SEGMENT_COUNT=24
AGENT_ID=""
CONTAINER_NAME=""
ORIGINAL_DEST=""

cleanup() {
  test_trap_incomplete
  if [ -n "$ORIGINAL_DEST" ]; then
    restore_storage_destination "$ORIGINAL_DEST"
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "capturing the current storage destination, then pointing it at real MinIO with working credentials"
ORIGINAL_DEST="$(capture_storage_destination)"
set_storage_destination_minio_with_creds

log_step "provisioning a dedicated test agent (owner-only, no workspace)"
_AGENT_INFO="$(provision_test_agent "search-concurrency")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "building ${SEGMENT_COUNT} real encrypted segments in MinIO, then running the real searchLogs three times with a fetch spy and wall-clock timing"
OUTPUT="$(node_call_backend_api "
(async () => {
  const zlib = require('zlib');
  const crypto = require('crypto');
  const db = require('/app/db.ts');
  const objectStorage = require('/agent-runtime/lib/objectStorage.ts');
  const segmentWriter = require('/workers/provisioner/logs/segmentWriter.ts');
  const logStorageConfigModule = require('/workers/provisioner/logs/logStorageConfig.ts');
  const logSearch = require('/app/logSearch.ts');

  const AGENT_ID = '${AGENT_ID}';
  const SEGMENTS = ${SEGMENT_COUNT};
  const LINES_PER_SEGMENT = 2;

  const ownerRow = await db.query('SELECT user_id FROM agents WHERE id = \$1', [AGENT_ID]);
  const ownerUserId = ownerRow.rows[0].user_id;
  const tenant = { workspaceId: null, ownerUserId };

  // An hour back: older than one flush interval, so the buffer read is skipped.
  const T0 = Date.now() - 60 * 60 * 1000;
  const keyRing = segmentWriter.loadLogEncryptionKeys();
  const destConfig = await logStorageConfigModule.logStorageConfig();
  const configSnapshot = logStorageConfigModule.logStorageConfigSnapshot(destConfig);

  const builtKeys = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const fromMs = T0 + i * 10000;
    const toMs = fromMs + 5000;
    const lines = [];
    for (let j = 0; j < LINES_PER_SEGMENT; j++) {
      lines.push({
        ts: new Date(fromMs + 1000 + j * 1000).toISOString(),
        stream: 'runtime',
        level: 'INFO',
        ts_source: 'source',
        ord: j,
        message: 'infra-test concurrency seg ' + i + ' line ' + j,
      });
    }
    // buildStorageKey buckets by HH:MM; these segments are seconds apart, so a
    // random suffix keeps storage_key unique. Test construction only.
    const storageKey = segmentWriter
      .buildStorageKey(tenant, AGENT_ID, 'runtime', new Date(fromMs), new Date(toMs))
      .replace(/\.ndjson\.zst\.enc\$/, '-' + crypto.randomBytes(4).toString('hex') + '.ndjson.zst.enc');
    const ndjson = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const compressed = zlib.zstdCompressSync(Buffer.from(ndjson, 'utf8'));
    const { buffer: encrypted, keyId } = segmentWriter.encryptSegment(compressed, keyRing);
    await objectStorage.putStorageObject(storageKey, encrypted, destConfig);
    await db.query(
      \`INSERT INTO log_segments (workspace_id, agent_id, stream, ts_from, ts_to, storage_key, storage_backend, storage_config, encryption_key_id, bytes, lines)
       VALUES (NULL, \$1, 'runtime', \$2, \$3, \$4, \$5, \$6::jsonb, \$7, \$8, \$9)\`,
      [AGENT_ID, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), storageKey, destConfig.storageBackend, JSON.stringify(configSnapshot), keyId, encrypted.length, lines.length],
    );
    builtKeys.push(storageKey);
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  const elapsedMs = (start) => Number(process.hrtime.bigint() - start) / 1e6;
  const round = (n) => Math.round(n * 10) / 10;

  // Baseline: single raw fetches through the same primitive fetchSegmentLines
  // uses, with no cache in the way.
  const probeConfig = await logStorageConfigModule.storageConfigForSegment({
    storage_key: builtKeys[0],
    storage_backend: destConfig.storageBackend,
    storage_config: configSnapshot,
  });
  const baselines = [];
  for (let r = 0; r < 3; r++) {
    const start = process.hrtime.bigint();
    await objectStorage.getStorageObject(builtKeys[r], probeConfig);
    baselines.push(elapsedMs(start));
  }

  const actor = { id: ownerUserId, role: 'user' };
  const params = {
    agentId: AGENT_ID,
    streams: ['runtime'],
    from: new Date(T0 - 1000).toISOString(),
    to: new Date(T0 + SEGMENTS * 10000 + 10000).toISOString(),
    limit: 1000,
  };

  const walls = [];
  const peaks = [];
  let lastResult = null;
  for (let r = 0; r < 3; r++) {
    let inFlight = 0;
    let peak = 0;
    const spiedGet = async (key, config, opts) => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        return await objectStorage.getStorageObject(key, config, opts);
      } finally {
        inFlight -= 1;
      }
    };
    const deps = {
      fetchSegmentLines: (row, opts) =>
        logSearch.fetchSegmentLines(row, { ...opts, cache: new Map(), getStorageObjectFn: spiedGet }),
    };
    const start = process.hrtime.bigint();
    lastResult = await logSearch.searchLogs(params, actor, deps);
    walls.push(elapsedMs(start));
    peaks.push(peak);
  }

  const baselineMs = median(baselines);
  const wallMs = median(walls);
  const peakMedian = median(peaks);
  const thresholdMs = (baselineMs * SEGMENTS) / 2;

  console.log('RESULT_JSON=' + JSON.stringify({
    segments: SEGMENTS,
    expectedLines: SEGMENTS * LINES_PER_SEGMENT,
    returnedLines: lastResult.lines.length,
    warning: lastResult.warning || null,
    baselineMs: round(baselineMs),
    wallMs: round(wallMs),
    serialEstimateMs: round(baselineMs * SEGMENTS),
    thresholdMs: round(thresholdMs),
    peakMedian,
    peaks,
    walls: walls.map(round),
    baselines: baselines.map(round),
    // Fan-out threshold is half the segment count, not all of it: each fetch
    // first awaits storageConfigForSegment, so starts can stagger slightly.
    // A serial implementation peaks at exactly 1.
    fanOutOk: peakMedian >= SEGMENTS / 2,
    transportOk: wallMs < thresholdMs,
  }));
  process.exit(0);
})().catch((e) => { console.error('SCRIPT_ERR ' + ((e && e.stack) || e)); process.exit(1); });
" 2>&1)"
node_rc=$?
RESULT_JSON="$(extract_marker RESULT_JSON "$OUTPUT")"
log_info "node exit=$node_rc result: ${RESULT_JSON:-<none>}"

if [ "$node_rc" -ne 0 ] || [ -z "$RESULT_JSON" ]; then
  test_fail "building segments or running searchLogs failed (exit ${node_rc}): $(printf '%s' "$OUTPUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi

field() {
  printf '%s' "$RESULT_JSON" | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]];
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$1"
}

returned="$(field returnedLines)"
expected="$(field expectedLines)"
fan_out_ok="$(field fanOutOk)"
transport_ok="$(field transportOk)"
peak="$(field peakMedian)"
peaks="$(field peaks)"
wall="$(field wallMs)"
baseline="$(field baselineMs)"
serial="$(field serialEstimateMs)"
threshold="$(field thresholdMs)"
walls="$(field walls)"

if [ "$returned" != "$expected" ]; then
  test_fail "search returned ${returned} line(s) across ${SEGMENT_COUNT} real MinIO segments, expected exactly ${expected} — lines were dropped or duplicated, so the concurrency numbers below are not meaningful"
elif [ "$fan_out_ok" != "true" ]; then
  test_fail "search did not fan out: peak simultaneous fetches ${peak} (runs: ${peaks}) against ${SEGMENT_COUNT} candidate segments in a single wave — the application is issuing fetches serially or near-serially"
elif [ "$transport_ok" != "true" ]; then
  test_fail "search fans out at the application level (peak ${peak} pending fetches) but the transport serializes them: median wall ${wall}ms vs single-fetch baseline ${baseline}ms (serial estimate ${serial}ms, threshold ${threshold}ms; runs ${walls}). This is the plan's named risk — a connection pool quietly serializing what Promise.all issues concurrently. Local MinIO is fast enough that a loaded host can add noise, so re-run before treating one result as a regression."
else
  test_pass "search fetched ${SEGMENT_COUNT} real MinIO segments concurrently at both layers: peak ${peak} simultaneous fetches (runs ${peaks}), and median wall ${wall}ms against a ${baseline}ms single-fetch baseline — well under the ${threshold}ms threshold and the ~${serial}ms a serial fetch would take (runs ${walls}); all ${expected} lines returned"
fi
