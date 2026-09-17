#!/usr/bin/env bash
# Phase 13, test 1: correlatedLogsForTrace's in-trace/in-window split is
# correct against a real mix of traced (gateway) and untraced (runtime)
# segments in real MinIO, and the underlying segment fetch is actually
# concurrent — not silently serialized by a connection-pool limit.
#
# Why this needs real infra (see this directory's README and
# search/README.md row 1, whose concern this inherits verbatim):
# correlatedLogsForTrace (backend-api/traceQuery.ts) reuses Phase 6's
# selectCandidateSegments/fetchSegmentLines unchanged. Against the `local`
# storage driver, every "fetch" is a synchronous-fast disk read and a
# serial implementation would pass every unit test; only a real network
# round trip to an object store can show whether Promise.all is actually
# buying real concurrency or is quietly bottlenecked by an unsized
# connection pool.
#
# Why this builds segments directly instead of running a real agent:
# Phase 12 (agent-side trace enablement, needs a real OpenClaw container)
# is explicitly out of scope for this suite right now. What's actually
# under test here is entirely on the read side — segment layout, pruning,
# and the correlation split — so segments are constructed the same way
# log-collector/02-reconnect-no-duplicates.sh reads one (via the
# real segmentWriter encrypt/compress primitives through node_call), just
# in reverse: build real NDJSON, real zstd-compress it, real
# AES-256-GCM-encrypt it (encryptSegment), real-upload it to MinIO
# (objectStorage.putStorageObject), and insert a matching real log_segments
# row — so fetchSegmentLines reads back exactly what production would have
# written, not a synthetic shortcut.
#
# Why this runs inside the BACKEND-API container specifically, not
# worker-provisioner (unlike every other node_call user in this suite):
# backend-api/logSearch.ts requires `../workers/provisioner/logs/segmentWriter.ts`
# and `./workers/provisioner/logs/logStorageConfig.ts` relative to
# backend-api's OWN root — resolvable only because backend-api's compose
# service additionally mounts the whole repo's `./workers` at `/workers:ro`
# (see docker-compose.yml's backend-api volumes). worker-provisioner's own
# container does NOT mount `/workers` at all (only `/backend-api:ro` and
# `/agent-runtime:ro`), so requiring backend-api's traceQuery.ts/logSearch.ts
# from inside worker-provisioner via lib/node_call.sh would fail with
# MODULE_NOT_FOUND on that inner require — a real, asymmetric mount
# difference between the two containers, not a bug in either script. This
# script therefore defines its own small backend-api-targeted node-call
# helper below rather than extending lib/node_call.sh (which must stay
# byte-for-byte identical to the copy other worktrees build from the same
# spec — see this repo's own lib/node_call.sh header for why it only ever
# targets worker-provisioner).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/storage_dest.sh"
source "$SCRIPT_DIR/../lib/minio_ctl.sh"

# node_call_backend_api <js-source>
#
# Same shape/rationale as lib/node_call.sh's node_call (see its header for
# the full explanation of why `docker compose exec` alone can't see
# secrets), targeting the backend-api container instead of worker-provisioner.
#
# Real bug found running this script for the first time against a live
# stack: unlike worker-provisioner (node_call.sh's target, which writes its
# scratch script to /app and works fine there), backend-api's container in
# THIS stack runs with a read-only root filesystem (confirmed via `docker
# inspect` — HostConfig.ReadonlyRootfs=true, and empirically: `docker cp`
# into /app failed outright with "container rootfs is marked read-only").
# lib/auth.sh's mint_jwt already hit and solved this exact problem for this
# exact container (see its header) — piping the script over stdin to `sh -c
# 'cat > /tmp/...'` writes into the one writable path (a tmpfs mount at
# /tmp) instead of routing through `docker cp`'s root-FS-driver path. This
# helper originally used the worker-provisioner-style docker-cp-to-/app
# pattern unchanged, which is wrong for backend-api specifically — fixed to
# match auth.sh's already-proven approach.
node_call_backend_api() {
  local js="$1"
  local cid
  cid="$(container_id_for backend-api)"
  if [ -z "$cid" ]; then
    echo "node_call_backend_api: backend-api is not running" >&2
    return 1
  fi

  local js_source
  js_source="$(
    echo "require('tsx/cjs');"
    printf '%s\n' "$js"
  )"
  printf '%s\n' "$js_source" | docker exec -i "$cid" sh -c "cat > /tmp/.infra-test-call-backend.js"

  local -a secret_env_args=()
  local secret_name secret_value
  for secret_name in $(docker exec "$cid" sh -c 'ls /run/secrets 2>/dev/null'); do
    secret_value="$(docker exec "$cid" sh -c "cat /run/secrets/${secret_name} 2>/dev/null")"
    secret_env_args+=(-e "${secret_name}=${secret_value}")
  done

  # cwd stays -w /app (backend-api's real app root, same as auth.sh's
  # mint_jwt) so `require("./db.ts")`/relative requires inside the script
  # resolve the same way production code does, even though the script file
  # itself physically lives under /tmp.
  docker exec "${secret_env_args[@]}" -w /app "$cid" node /tmp/.infra-test-call-backend.js
  local status=$?
  docker exec "$cid" rm -f /tmp/.infra-test-call-backend.js >/dev/null 2>&1 || true
  return $status
}

require_confirmation
test_start "traces-lens" "01-concurrent-correlation-real-minio"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents

AGENT_ID=""
CONTAINER_NAME=""
ORIGINAL_DEST=""
TRACE_ID="infra-test-trace-$(date +%s)"

cleanup() {
  test_trap_incomplete
  if [ -n "$AGENT_ID" ]; then
    db_exec "DELETE FROM agent_spans WHERE agent_id = '${AGENT_ID}';" >/dev/null 2>&1 || true
  fi
  if [ -n "$ORIGINAL_DEST" ]; then
    restore_storage_destination "$ORIGINAL_DEST"
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "capturing the current storage destination, then pointing it at real MinIO with real credentials"
ORIGINAL_DEST="$(capture_storage_destination)"
set_storage_destination_minio_with_creds

log_step "provisioning a dedicated test agent (owner-only, no workspace — workspace_id stays NULL throughout, same as Phase 6/13's null-workspace coverage)"
_AGENT_INFO="$(provision_test_agent "traces-correlation")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME trace_id=$TRACE_ID"

log_step "building real segments (gateway matching-trace x4, gateway other-trace x1, runtime in-window x2, runtime out-of-window x1), uploading them to real MinIO, inserting matching log_segments + agent_spans rows, then calling correlatedLogsForTrace for real and timing the concurrent fetch"
RESULT_JSON="$(node_call_backend_api "
(async () => {
  const zlib = require('zlib');
  const crypto = require('crypto');
  // Absolute paths, not relative ('./db.ts', '../agent-runtime/...'): this
  // script file is written to /tmp (see node_call_backend_api's header —
  // backend-api's rootfs is read-only, so /app isn't writable), and a
  // relative require() resolves against the REQUIRING FILE's own directory,
  // not the process cwd — so a relative path here would resolve against
  // /tmp, not /app, and fail with MODULE_NOT_FOUND. These absolute paths are
  // exactly what the original relative paths resolved to when this script
  // still lived under /app (backend-api's real app root, and the /agent-runtime
  // and /workers read-only mount points CLAUDE.md documents).
  const db = require('/app/db.ts');
  const objectStorage = require('/agent-runtime/lib/objectStorage.ts');
  const segmentWriter = require('/workers/provisioner/logs/segmentWriter.ts');
  const logStorageConfigModule = require('/workers/provisioner/logs/logStorageConfig.ts');
  const traceQuery = require('/app/traceQuery.ts');

  const AGENT_ID = '${AGENT_ID}';
  const TRACE_ID = '${TRACE_ID}';
  const OTHER_TRACE_ID = 'infra-test-other-trace';

  const ownerRow = await db.query('SELECT user_id FROM agents WHERE id = \$1', [AGENT_ID]);
  const ownerUserId = ownerRow.rows[0].user_id;
  const tenant = { workspaceId: null, ownerUserId };

  // Trace window: [T0, T0 + 10000ms]. Well in the past (10 minutes ago),
  // clear of anything a real agent in this dev stack could be writing
  // concurrently.
  const T0 = Date.now() - 600000;
  const traceStart = new Date(T0).toISOString();
  const traceEnd = new Date(T0 + 10000).toISOString();

  await db.query(
    \"INSERT INTO agent_spans (trace_id, span_id, parent_span_id, workspace_id, agent_id, name, kind, started_at, duration_ms, status) VALUES (\$1,\$2,NULL,NULL,\$3,\$4,'internal',\$5,\$6,'ok')\",
    [TRACE_ID, 'infra-test-span-root', AGENT_ID, 'root-span', traceStart, 0],
  );
  await db.query(
    \"INSERT INTO agent_spans (trace_id, span_id, parent_span_id, workspace_id, agent_id, name, kind, started_at, duration_ms, status) VALUES (\$1,\$2,\$3,NULL,\$4,\$5,'internal',\$6,\$7,'ok')\",
    [TRACE_ID, 'infra-test-span-child', 'infra-test-span-root', AGENT_ID, 'child-span', new Date(T0 + 8000).toISOString(), 2000],
  );

  const keyRing = segmentWriter.loadLogEncryptionKeys();
  const destConfig = await logStorageConfigModule.logStorageConfig();
  const configSnapshot = logStorageConfigModule.logStorageConfigSnapshot(destConfig);

  async function writeSegment(stream, tsFromMs, tsToMs, lines) {
    const tsFrom = new Date(tsFromMs);
    const tsTo = new Date(tsToMs);
    // buildStorageKey's own layout is HH:MM-granularity by design (real
    // flushes are minutes apart, so that's plenty unique there) — several
    // of this script's OWN synthetic segments are only ~2.5s apart to keep
    // the whole trace window tight, which would collide on the same HHMM
    // bucket and violate log_segments.storage_key's UNIQUE constraint.
    // Appending a random suffix keeps the real prefix/layout but guarantees
    // uniqueness for this test's own tightly-packed segments — not a
    // product code path, purely test construction.
    const storageKey = segmentWriter
      .buildStorageKey(tenant, AGENT_ID, stream, tsFrom, tsTo)
      .replace(/\.ndjson\.zst\.enc\$/, '-' + crypto.randomBytes(4).toString('hex') + '.ndjson.zst.enc');
    const ndjson = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const compressed = zlib.zstdCompressSync(Buffer.from(ndjson, 'utf8'));
    const { buffer: encrypted, keyId } = segmentWriter.encryptSegment(compressed, keyRing);
    await objectStorage.putStorageObject(storageKey, encrypted, destConfig);
    await db.query(
      \`INSERT INTO log_segments (workspace_id, agent_id, stream, ts_from, ts_to, storage_key, storage_backend, storage_config, encryption_key_id, bytes, lines)
       VALUES (NULL, \$1, \$2, \$3, \$4, \$5, \$6, \$7::jsonb, \$8, \$9, \$10)\`,
      [AGENT_ID, stream, tsFrom.toISOString(), tsTo.toISOString(), storageKey, destConfig.storageBackend, JSON.stringify(configSnapshot), keyId, encrypted.length, lines.length],
    );
    return storageKey;
  }

  function gatewayLine(tsMs, traceId, i) {
    return { ts: new Date(tsMs).toISOString(), stream: 'gateway', level: 'info', message: 'infra-test gateway line ' + i, trace_id: traceId, span_id: 'infra-test-span-root' };
  }
  function runtimeLine(tsMs, i) {
    return { ts: new Date(tsMs).toISOString(), stream: 'runtime', level: 'info', message: 'infra-test runtime line ' + i };
  }

  const builtKeys = [];
  // 4 gateway segments matching the real trace, spanning the whole window.
  for (let i = 0; i < 4; i++) {
    const from = T0 + i * 2500;
    const to = from + 2000;
    builtKeys.push(await writeSegment('gateway', from, to, [gatewayLine(from + 500, TRACE_ID, i * 2), gatewayLine(from + 1000, TRACE_ID, i * 2 + 1)]));
  }
  // 1 gateway segment inside the window but carrying a DIFFERENT trace_id
  // — OpenClaw's internal gateway trace_id is a different id space than the
  // OTel trace_id (see traceQuery.ts's module-header Correlation rule
  // comment), so this must NOT be excluded outright; it must appear as
  // inTrace:false/category:window, same as an untagged runtime line, and
  // must NOT be marked inTrace:true/category:trace (that would wrongly
  // conflate it with this trace's own lines).
  builtKeys.push(await writeSegment('gateway', T0 + 3000, T0 + 5000, [gatewayLine(T0 + 3500, OTHER_TRACE_ID, 100), gatewayLine(T0 + 4000, OTHER_TRACE_ID, 101)]));
  // 2 runtime segments inside the window, no trace_id — every line must be
  // included as inTrace:false/category:window regardless.
  builtKeys.push(await writeSegment('runtime', T0 + 1000, T0 + 3000, [runtimeLine(T0 + 1500, 200), runtimeLine(T0 + 2000, 201)]));
  builtKeys.push(await writeSegment('runtime', T0 + 6000, T0 + 8000, [runtimeLine(T0 + 6500, 202), runtimeLine(T0 + 7000, 203)]));
  // 1 runtime segment well BEFORE the window — must be pruned at the SQL
  // level (selectCandidateSegments), never even fetched.
  await writeSegment('runtime', T0 - 120000, T0 - 60000, [runtimeLine(T0 - 90000, 300)]);

  // Baseline single-object-fetch latency, measured via the raw primitives
  // (NOT fetchSegmentLines, which caches decoded content — using it here
  // would make a later cache hit read as suspiciously fast and corrupt the
  // concurrency comparison below). Uses the first built segment, which
  // correlatedLogsForTrace will fetch fresh afterward (this call never
  // touches its cache).
  const probeConfig = await logStorageConfigModule.storageConfigForSegment({ storage_key: builtKeys[0], storage_backend: destConfig.storageBackend, storage_config: configSnapshot });
  const probeStart = Date.now();
  await objectStorage.getStorageObject(builtKeys[0], probeConfig);
  const singleLatencyMs = Math.max(1, Date.now() - probeStart);

  const spanRows = (await db.query('SELECT trace_id, span_id, parent_span_id, workspace_id, agent_id, name, kind, started_at, duration_ms, status, model, provider, tokens_in, tokens_out, cost_usd, attrs FROM agent_spans WHERE trace_id = \$1', [TRACE_ID])).rows;

  const fetchStart = Date.now();
  const correlated = await traceQuery.correlatedLogsForTrace(spanRows, {});
  const fetchWallMs = Date.now() - fetchStart;

  const inTraceLines = correlated.filter((l) => l.inTrace === true && l.category === 'trace');
  const windowLines = correlated.filter((l) => l.inTrace === false && l.category === 'window');
  const otherTraceLines = correlated.filter((l) => l.trace_id === OTHER_TRACE_ID);
  // Misclassified means the other trace's own lines were wrongly tagged as
  // THIS trace's (inTrace:true/category:trace) -- not that they're absent.
  // Per the current, intentional design (traceQuery.ts's Correlation rule
  // comment), they must be present, just correctly demoted to
  // inTrace:false/category:window like any other in-window, non-matching
  // line.
  const otherTraceMisclassified = otherTraceLines.some((l) => l.inTrace !== false || l.category !== 'window');
  const otherTraceMissing = otherTraceLines.length !== 2;
  const outsideWindowLeaked = correlated.some((l) => typeof l.message === 'string' && l.message.includes('infra-test runtime line 300'));

  console.log(JSON.stringify({
    totalCorrelated: correlated.length,
    inTraceCount: inTraceLines.length,
    windowCount: windowLines.length,
    otherTraceMisclassified,
    otherTraceMissing,
    outsideWindowLeaked,
    candidateSegmentsFetched: builtKeys.length,
    singleLatencyMs,
    fetchWallMs,
  }));
  process.exit(0);
})().catch((e) => { console.error('SCRIPT_ERR ' + (e && e.stack || e)); process.exit(1); });
")"
node_call_status=$?
log_info "node_call_backend_api exit=$node_call_status output: $RESULT_JSON"

if [ "$node_call_status" -ne 0 ] || [ -z "$RESULT_JSON" ]; then
  test_fail "node_call_backend_api failed building/querying real segments and spans (exit $node_call_status) — see logged output above for the real error"
  exit 0
fi

total_correlated="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).totalCorrelated))' 2>/dev/null)"
in_trace_count="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).inTraceCount))' 2>/dev/null)"
window_count="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).windowCount))' 2>/dev/null)"
other_trace_misclassified="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).otherTraceMisclassified))' 2>/dev/null)"
other_trace_missing="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).otherTraceMissing))' 2>/dev/null)"
outside_window_leaked="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).outsideWindowLeaked))' 2>/dev/null)"
candidate_segments="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).candidateSegmentsFetched))' 2>/dev/null)"
single_latency_ms="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).singleLatencyMs))' 2>/dev/null)"
fetch_wall_ms="$(echo "$RESULT_JSON" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).fetchWallMs))' 2>/dev/null)"

log_info "total_correlated=$total_correlated in_trace_count=$in_trace_count (expect 8) window_count=$window_count (expect 6 -- 4 runtime + 2 other-trace-gateway, both demoted to window) other_trace_misclassified=$other_trace_misclassified (expect false) other_trace_missing=$other_trace_missing (expect false) outside_window_leaked=$outside_window_leaked (expect false)"
log_info "candidate_segments=$candidate_segments single_latency_ms=$single_latency_ms fetch_wall_ms=$fetch_wall_ms"

correctness_ok=1
if [ "$in_trace_count" != "8" ]; then
  log_warn "expected 8 in-trace gateway lines (4 segments x 2 lines), got $in_trace_count"
  correctness_ok=0
fi
if [ "$window_count" != "6" ]; then
  log_warn "expected 6 in-window lines (2 runtime segments x 2 lines + 1 other-trace gateway segment x 2 lines, all demoted to category:window), got $window_count"
  correctness_ok=0
fi
if [ "$other_trace_missing" != "false" ]; then
  log_warn "the other-trace gateway segment's lines are missing entirely from correlatedLogs — per the current design (traceQuery.ts's Correlation rule) they must still appear, just demoted to category:window, since OpenClaw's internal gateway trace_id is a different id space than the OTel trace_id"
  correctness_ok=0
fi
if [ "$other_trace_misclassified" != "false" ]; then
  log_warn "a gateway line from a DIFFERENT trace_id was wrongly tagged inTrace:true/category:trace — it must be demoted to inTrace:false/category:window instead of being conflated with this trace"
  correctness_ok=0
fi
if [ "$outside_window_leaked" != "false" ]; then
  log_warn "a runtime line from a segment well outside the trace window leaked into correlatedLogs — selectCandidateSegments' time pruning (item 3) is broken"
  correctness_ok=0
fi

# Concurrency check, same timing-based technique Phase 6's own row 1
# describes (see search/README.md): a genuinely concurrent fetch of
# N segments should land close to ONE segment's latency, not N times it.
# Against local MinIO round trips this can be a matter of single-digit
# milliseconds either way — noisy by nature, not a hard proof — so this
# uses a generous threshold (well under N x, not close to 1x) rather than a
# tight one, and reports the raw numbers either way so a borderline result
# is legible rather than a bare pass/fail.
concurrency_threshold_ms=$(( single_latency_ms * candidate_segments / 2 ))
concurrency_ok=1
if [ "$fetch_wall_ms" -ge "$concurrency_threshold_ms" ]; then
  concurrency_ok=0
fi

if [ "$correctness_ok" -ne 1 ]; then
  test_fail "correlation correctness failed — see warnings above (in_trace=$in_trace_count/8, window=$window_count/4, other_trace_leaked=$other_trace_leaked, outside_window_leaked=$outside_window_leaked)"
elif [ "$concurrency_ok" -ne 1 ]; then
  test_fail "correlation content was correct, but the segment fetch does NOT look concurrent: fetching $candidate_segments segments took ${fetch_wall_ms}ms, close to or exceeding a serial estimate of ~$((single_latency_ms * candidate_segments))ms (single-segment baseline ${single_latency_ms}ms) — this is the exact failure mode Phase 6's README warns about (a connection-pool limit silently serializing what should be Promise.all concurrency). Note local MinIO round trips are fast enough that this signal can be noisy on a lightly-loaded machine; re-run if this looks like a fluke rather than a reproducible regression."
else
  test_pass "correlation split correct (in_trace=$in_trace_count/8, window=$window_count/6, other-trace gateway lines correctly demoted to category:window rather than excluded, out-of-window runtime line correctly pruned) AND the $candidate_segments-segment fetch looks genuinely concurrent (${fetch_wall_ms}ms wall vs ~${single_latency_ms}ms single-segment baseline, well under the ~$((single_latency_ms * candidate_segments))ms a serial fetch would take)"
fi
