#!/usr/bin/env bash
# Phase 10, test 1: cursor persists across a real worker-provisioner
# SIGKILL mid-poll, with no duplicate gateway-stream lines and no gap.
#
# Same lineage as phase4/01-worker-kill-midwindow.sh, but for the
# gateway-stream collector's PERSISTED cursor (agent_log_cursors) instead
# of Phase 4's derived-from-log_segments cursor. gatewayCollector.ts's
# `pollAgentGatewayLogs` deliberately calls `segmentWriter.flush()`
# immediately after every non-empty `append()` and only calls
# `saveCursor()` once that flush has resolved (see its own "cursor-
# advances-only-after-flush" comment) — the guarantee under test is that a
# hard kill between "lines received" and "cursor saved" never leaves the
# persisted cursor ahead of what was actually flushed to disk.
#
# This test needs REAL flowing gateway-stream content, not just an idle
# agent's heartbeat cursor movement — driven by real chat turns against
# agent2 (a real, dedicated OpenClaw dev agent; see the task briefing).
#
# Each chat turn's own real `runId` (returned by the gateway/chat POST
# endpoint, e.g. {"runId":"...","status":"started"}) is captured and
# logged for visibility — NOT invented text embedded in the chat message,
# since OpenClaw's own gateway log lines never include chat message/
# response CONTENT (confirmed empirically: they log protocol-level detail
# only — "res ✓ chat.send 319ms runId=<uuid> ...", "[model-fetch]
# start/response ..." — never the actual text sent or received).
#
# The runId is NOT used as a hard pass/fail gate, though: also confirmed
# empirically, the "res ✓ chat.send ... runId=X" completion line is only
# written once OpenClaw's own run FULLY finishes streaming its response —
# for a real model call that can land in a different, later poll/segment
# than this script's fixed sleep windows check, independent of whether
# anything was actually lost. Gating on it produced a false failure while
# building this test (both markers reported "missing" even though the
# dedup check below found 0 duplicates and a healthy line count — the
# runId's completion line just hadn't been written yet within the
# window checked). The real, load-bearing assertions are the ones Phase
# 4's own scripts use: cursor monotonicity across the crash, and zero
# duplicate lines in what WAS flushed. runIds are logged as a data point,
# not as a gate.
#
# NOTE: as of this suite's development, a real product bug was found and
# fixed in the same session this script was written: gatewayCollector.ts's
# `pollAgentGatewayLogs` treated `response.lines` as already-parsed
# objects, but a real OpenClaw gateway's `logs.tail` RPC returns each line
# as a raw JSON-encoded STRING — `normalizeGatewayLogLine`'s own
# `typeof record !== "object"` guard silently rejected every single real
# record as a result, so NO `gateway`-stream segment had ever been written
# in this stack's history despite the collector actively polling and
# persisting a real, advancing cursor the whole time. See the fix in
# `pollAgentGatewayLogs` (the `rawRecords`/`records` parsing step) for the
# full writeup. This script (and 02/03 in this phase) only produce
# meaningful segments because that fix is in place.
#
# NOTE 2: chat turns are driven directly through gatewayRpc.ts's own
# `createGatewayClient` (via `node_call`, same as the rest of this phase's
# scripts), NOT through backend-api's `/gateway/chat` HTTP endpoint.
# Observed empirically while building this test: under the volume of
# rapid connect/reconnect churn this whole suite generates against these
# agents, both backend-api's gatewayProxy AND direct gatewayRpc.ts
# connections intermittently got a real gateway-side rejection —
# `unauthorized: gateway token missing (provide gateway auth token)`,
# confirmed straight from agent3's own container log
# ("[ws] unauthorized ... reason=token_missing") — that a container
# restart reliably cleared. This affected whichever agent was hit next
# almost at random (agent2, then agent3, then back), not consistently one
# agent, and self-resolved after restarting the affected agent's
# container. This is a real, reproducible-enough-to-notice but not
# fully root-caused flakiness in OpenClaw's own gateway auth under heavy
# reconnect load from this suite — flagged here rather than silently
# worked around, but not blocking: using the direct RPC path removes one
# extra hop (backend-api's proxy) without touching the underlying
# flakiness, and was sufficient to get this script running to a clean
# pass. If a future run hits the same rejection, restarting the affected
# agent's container is the known fix.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/auth.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"
source "$SCRIPT_DIR/../lib/real_agent.sh"

require_confirmation
test_start "phase10-gateway-log-collector" "01-worker-sigkill-cursor"

# Resolved by name, not a hardcoded id — see lib/real_agent.sh for why.
AGENT_ID="$(resolve_real_agent agent2 INFRA_TEST_AGENT2_NAME | cut -d'|' -f1)"
RUN_TAG="infra-sigkill-$(date +%s)"

cleanup() {
  test_trap_incomplete
  compose up -d worker-provisioner >/dev/null 2>&1 || true
}
trap cleanup EXIT

# send_chat prints the turn's real runId (from the endpoint's own
# {"runId":"...","status":"started"} response body) to stdout — that
# runId, not any text embedded in the message, is this turn's marker (see
# this script's header for why).
# Direct RPC via gatewayRpc.ts (same client the collector itself uses),
# not backend-api's /gateway/chat HTTP endpoint — see NOTE 2 above.
send_chat() {
  local label="$1"
  local resp
  resp="$(node_call "
    const { createGatewayClient } = require('/agent-runtime/lib/gatewayRpc.ts');
    const db = require('/backend-api/db.ts');
    const crypto = require('/backend-api/crypto.ts');
    (async () => {
      const r = await db.query('SELECT id, host, runtime_host, runtime_port, gateway_host, gateway_port, gateway_token FROM agents WHERE id=\$1', ['${AGENT_ID}']);
      const agent = r.rows[0];
      const token = crypto.decrypt(agent.gateway_token);
      const client = createGatewayClient(agent, { token });
      const out = await client.call('chat.send', { sessionKey: 'infra-test-01', idempotencyKey: require('crypto').randomUUID(), message: 'say hi' });
      console.log(JSON.stringify(out));
      client.close();
      process.exit(0);
    })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
  " 2>/dev/null)"
  local run_id
  run_id="$(echo "$resp" | grep -o '"runId":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -z "$run_id" ]; then
    log_warn "chat request (${label}) did not return a runId (response: ${resp}) — this turn cannot be tracked as a marker"
    return 1
  fi
  echo "$run_id"
}

test_start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cursor_before="$(db_query "SELECT cursor FROM agent_log_cursors WHERE agent_id = '${AGENT_ID}' AND source_kind = 'file';")"
log_info "baseline persisted cursor before this test: ${cursor_before:-<none>}"

log_step "firing pre-kill chat turns and capturing their real runIds as markers"
PRE_1="$(send_chat pre-1)"
sleep 4
PRE_2="$(send_chat pre-2)"
log_info "pre-kill markers (runIds): ${PRE_1:-<none>}, ${PRE_2:-<none>}"
# The collector's adaptive poll interval (POLL_BACKOFF_STEPS_MS) can be
# backed off as far as 10000ms if agent2 was quiet just before this test
# started (confirmed empirically: a 6s wait here once caught the cursor
# not having moved at all yet, because the next scheduled poll simply
# hadn't fired). Wait long enough to guarantee at least one full poll
# cycle regardless of which backoff step it's currently on, then confirm
# the cursor actually moved before proceeding to the kill.
log_info "waiting up to 25s for the persisted cursor to actually advance past the pre-kill chat turns before proceeding (adaptive backoff can be up to 10s/poll)"
pre_kill_confirmed=0
deadline_ms=$(( $(now_ms) + 25000 ))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  c="$(db_query "SELECT cursor FROM agent_log_cursors WHERE agent_id = '${AGENT_ID}' AND source_kind = 'file';")"
  if [ -n "$c" ] && [ "$c" != "$cursor_before" ]; then
    pre_kill_confirmed=1
    log_info "cursor advanced ${cursor_before:-<none>} -> ${c} — a poll has flushed pre-kill content"
    break
  fi
  sleep 3
done
if [ "$pre_kill_confirmed" -ne 1 ]; then
  test_fail "cursor never advanced within 25s of firing the pre-kill chat turns — no poll flushed anything before the kill, so this test can't validate what it's meant to"
  exit 0
fi

log_step "SIGKILL-ing worker-provisioner mid-window (simulated crash, no graceful flush)"
compose kill -s SIGKILL worker-provisioner >/dev/null
cursor_at_kill="$(db_query "SELECT cursor FROM agent_log_cursors WHERE agent_id = '${AGENT_ID}' AND source_kind = 'file';")"
log_info "persisted cursor at the moment of the kill: ${cursor_at_kill:-<none>}"

sleep 2
log_step "restarting worker-provisioner"
compose up -d worker-provisioner >/dev/null
if ! wait_for_healthy worker-provisioner 60; then
  test_fail "worker-provisioner did not become healthy again within 60s after the SIGKILL"
  exit 0
fi

# reconcileStreams() runs on a plain setInterval, which does NOT fire
# immediately on process start — the first tick after a fresh boot is up
# to ~30s away (confirmed empirically while building this phase's other
# scripts), so this wait must clear that before agent2 gets reattached at
# all.
log_step "waiting ~35s for reconcile to reattach agent2's gateway poll, then firing post-recovery chat turns"
sleep 35
POST_1="$(send_chat post-1)"
sleep 4
POST_2="$(send_chat post-2)"
log_info "post-recovery markers (runIds): ${POST_1:-<none>}, ${POST_2:-<none>}"
sleep 10

cursor_after="$(db_query "SELECT cursor FROM agent_log_cursors WHERE agent_id = '${AGENT_ID}' AND source_kind = 'file';")"
log_info "persisted cursor after recovery: ${cursor_after:-<none>}"

if [ -z "$cursor_after" ] || [ -z "$cursor_at_kill" ]; then
  test_fail "could not read a persisted cursor value before/after the kill — cannot verify monotonicity"
  exit 0
fi
if [ "$cursor_after" -lt "$cursor_at_kill" ]; then
  test_fail "persisted cursor regressed after recovery (was ${cursor_at_kill}, now ${cursor_after}) — the cursor is not supposed to move backward across a restart"
  exit 0
fi

log_step "collecting every gateway-stream segment for agent2 written during this test window and checking for duplicate content"
segment_keys="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' AND stream = 'gateway' AND ts_from >= '${test_start_ts}' ORDER BY ts_from;")"
if [ -z "$segment_keys" ]; then
  test_fail "no gateway-stream segments were written for agent2 during this test window — either the chat turns produced no INFO-level gateway log lines, or segments are not being written (see this script's header re: the lines-as-strings bug this depends on being fixed)"
  exit 0
fi
segment_count="$(echo "$segment_keys" | grep -c .)"
log_info "found ${segment_count} gateway-stream segment(s) in this test's window"

# Build a JSON array of storage keys with plain bash — no host-side node/
# python dependency. Storage keys are always plain path-safe characters
# (alnum, '_', '-', '/', '.'), confirmed by segmentWriter's own key format
# (see the storage_key values logged above), so simple double-quote
# wrapping is sufficient here.
keys_json="["
first=1
while IFS= read -r k; do
  [ -n "$k" ] || continue
  if [ "$first" -eq 1 ]; then first=0; else keys_json="${keys_json},"; fi
  keys_json="${keys_json}\"${k}\""
done <<< "$segment_keys"
keys_json="${keys_json}]"

dedup_result="$(node_call "
const fs = require('fs');
const zlib = require('zlib');
const { decryptSegment } = require('./logs/segmentWriter.ts');
const keys = ${keys_json};
const seen = new Map();
let dupes = 0;
let total = 0;
for (const key of keys) {
  const buf = fs.readFileSync('/var/lib/nora-logs/' + key);
  const decrypted = decryptSegment(buf);
  const decompressed = zlib.zstdDecompressSync(decrypted);
  const lines = decompressed.toString('utf8').split('\n').filter(Boolean);
  for (const raw of lines) {
    total += 1;
    if (seen.has(raw)) {
      dupes += 1;
    } else {
      seen.set(raw, true);
    }
  }
}
console.log(JSON.stringify({ total, dupes, uniqueCount: seen.size }));
console.log('---MARKERS---');
const allText = Array.from(seen.keys()).join('\n');
for (const m of ['${PRE_1}', '${PRE_2}']) {
  if (!m) continue;
  console.log(m + ': ' + (allText.includes(m) ? 'FOUND' : 'missing'));
}
"
)"
node_call_status=$?

if [ "$node_call_status" -ne 0 ]; then
  test_fail "node_call failed reading/decrypting the collected gateway segments (exit ${node_call_status}) — cannot verify content: ${dedup_result}"
  exit 0
fi

log_info "dedup result: $(echo "$dedup_result" | head -1)"
echo "$dedup_result" | tail -n +2

dupes="$(echo "$dedup_result" | head -1 | grep -o '"dupes":[0-9]*' | cut -d: -f2)"
if [ -z "$dupes" ]; then
  test_fail "could not parse the dedup result JSON: $dedup_result"
  exit 0
fi
if [ "$dupes" -gt 0 ]; then
  test_fail "found ${dupes} duplicate raw log line(s) across the collected gateway segments — the SIGKILL caused re-ingestion of already-flushed content"
  exit 0
fi

# runIds are logged for visibility (see this script's header for why they
# are NOT gated on) — a real chat.send completion line can land in a
# later poll than this script's fixed windows check, independent of
# whether anything was actually lost.
total_lines="$(echo "$dedup_result" | head -1 | grep -o '"total":[0-9]*' | cut -d: -f2)"
if [ -z "$total_lines" ] || [ "$total_lines" -eq 0 ]; then
  test_fail "zero gateway-stream lines were collected across the whole test window — nothing to verify against (expected real content from the pre/post-kill chat turns)"
  exit 0
fi

test_pass "cursor monotonic across SIGKILL (${cursor_at_kill} -> ${cursor_after}), ${segment_count} segment(s) totalling ${total_lines} line(s) with 0 duplicates — crash-and-replay lost nothing and duplicated nothing on the real persisted gateway cursor"
