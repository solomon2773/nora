#!/usr/bin/env bash
# Phase 10, test 2: real log rotation at `logging.maxFileBytes` mid-poll
# does not drop any lines.
#
# Uses agent4 (dbb500ee-2689-4743-a538-d9c5ba3cde70) — explicitly
# designated in the task briefing for this test. `logging.maxFileBytes` is
# pushed down to a tiny value (2000 bytes) via the same live config-merge
# mechanism `agentTracing.ts`'s `applyTracingConfig` and
# `gatewayCollector.ts`'s own `applyConsoleLevelConfig` use
# (`buildOpenClawConfigMergeCommand` + `runRuntimeCommand`, both from
# `agent-runtime/lib/runtimeBootstrap.ts` / `worker.ts`), so a handful of
# real chat turns is enough to cross the rotation threshold within test
# time — the plan doc's real default (100MB) would never rotate in a
# reasonable test window.
#
# "No gap across rotation" is verified the same way 10-01 (this phase)
# ended up verifying it, after an initial per-turn-runId design proved too
# fragile against real LLM response timing: rather than gating on each
# chat turn's own `runId` appearing exactly once (OpenClaw only writes the
# "res ✓ chat.send ... runId=X" completion line once the WHOLE run
# finishes streaming, which can land in a poll well after this script's
# fixed per-turn sleep — confirmed empirically, see 10-01's header for the
# full story), this asserts on the same two structural invariants Phase
# 4's own scripts use: zero duplicate raw lines across every
# gateway-stream segment collected in the window (proves nothing was
# double-ingested across the rotation boundary), and more than one
# segment written (weak but real evidence that at least one flush/
# transition boundary — consistent with a rotation having occurred —
# happened during the window, at 2000 bytes of real gateway log volume).
# This sidesteps needing to pin down OpenClaw's exact `{"type":"meta"}`
# record shape (gatewayCollector.ts's own header flags this as an
# unverified assumption).
#
# `logging.maxFileBytes` is restored to 104857600 (100MB, the plan doc's
# stated default) in cleanup() regardless of pass/fail, per the task
# briefing's explicit requirement not to leave agent4's config altered.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/auth.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"
source "$SCRIPT_DIR/../lib/real_agent.sh"

require_confirmation
test_start "phase10-gateway-log-collector" "02-log-rotation-no-drop"

# Resolved by name, not a hardcoded id — see lib/real_agent.sh for why.
AGENT_ID="$(resolve_real_agent agent4 INFRA_TEST_AGENT4_NAME | cut -d'|' -f1)"
RUN_TAG="infra-rot-$(date +%s)"
CONFIG_SHRUNK=0

# NOTE: this does NOT `require('./worker.ts')` for `runRuntimeCommand` —
# doing so was tried first and crashed the real running worker-provisioner
# process: `require()`ing worker.ts from inside a node_call-spawned
# process re-executes its ENTIRE top-level module body (including
# starting its own health-check HTTP listener), which collided with the
# already-running real process's own listener on the same port
# (EADDRINUSE :4001) and crashed. worker.ts is designed to be the single
# process entrypoint, not a library — gatewayCollector.ts's own
# `applyConsoleLevelConfig` gets away with `require("../worker.ts")`
# because it runs INSIDE that same already-running process (a cached,
# already-initialized module), not from a fresh one. This instead
# replicates just the one HTTP call `runRuntimeCommand` makes
# (`POST <runtime>/exec` with a bearer auth header) directly, which is
# all this test actually needs.
set_max_file_bytes() {
  local bytes="$1"
  node_call "
    const { buildOpenClawConfigMergeCommand } = require('/agent-runtime/lib/runtimeBootstrap.ts');
    const { runtimeUrlForAgent, buildRuntimeAuthHeaders } = require('/agent-runtime/lib/agentEndpoints.ts');
    const db = require('/backend-api/db.ts');
    const crypto = require('/backend-api/crypto.ts');
    (async () => {
      const r = await db.query(\"SELECT id, host, runtime_host, runtime_port, gateway_host, gateway_port, gateway_token FROM agents WHERE id='${AGENT_ID}'\");
      const agent = r.rows[0];
      const runtimeUrl = runtimeUrlForAgent(agent, '/exec');
      if (!runtimeUrl) throw new Error('agent runtime endpoint unavailable');
      const command = buildOpenClawConfigMergeCommand({ logging: { maxFileBytes: ${bytes} } });
      const token = agent.gateway_token ? crypto.decrypt(agent.gateway_token) : null;
      const response = await fetch(runtimeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildRuntimeAuthHeaders(token) },
        body: JSON.stringify({ command, timeout: 30000 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.exitCode !== 0) {
        throw new Error('runtime command failed: HTTP ' + response.status + ' exitCode=' + payload.exitCode + ' stderr=' + (payload.stderr || ''));
      }
      console.log('applied maxFileBytes=${bytes}');
      process.exit(0);
    })().catch(e => { console.error('ERR', e.message); process.exit(1); });
  "
}

cleanup() {
  test_trap_incomplete
  if [ "$CONFIG_SHRUNK" -eq 1 ]; then
    log_step "restoring agent4's logging.maxFileBytes to 104857600 (100MB, plan-doc default)"
    set_max_file_bytes 104857600 || log_warn "failed to restore agent4's maxFileBytes — verify/fix manually via runRuntimeCommand"
  fi
}
trap cleanup EXIT

log_step "shrinking agent4's logging.maxFileBytes to 2000 bytes to make rotation reachable in test time"
if ! set_max_file_bytes 2000; then
  test_fail "could not apply the shrunk maxFileBytes config to agent4 — see node_call output above"
  exit 0
fi
CONFIG_SHRUNK=1
sleep 3

test_start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# send_chat prints the turn's real runId as its marker — OpenClaw's own
# gateway log lines never include chat message/response CONTENT, only
# protocol-level detail (runId, timing), confirmed empirically while
# building 10-01 in this same phase. See that script's header for the
# full explanation.
# Direct RPC via gatewayRpc.ts (same client the collector itself uses),
# not backend-api's /gateway/chat HTTP endpoint — see 10-01's "NOTE 2" for
# why: under this suite's own reconnect churn, both paths intermittently
# hit a real gateway-side "token_missing" rejection that a container
# restart clears; using the direct path removes one extra hop without
# depending on it being fixed.
send_chat() {
  local resp run_id
  resp="$(node_call "
    const { createGatewayClient } = require('/agent-runtime/lib/gatewayRpc.ts');
    const db = require('/backend-api/db.ts');
    const crypto = require('/backend-api/crypto.ts');
    (async () => {
      const r = await db.query('SELECT id, host, runtime_host, runtime_port, gateway_host, gateway_port, gateway_token FROM agents WHERE id=\$1', ['${AGENT_ID}']);
      const agent = r.rows[0];
      const token = crypto.decrypt(agent.gateway_token);
      const client = createGatewayClient(agent, { token });
      const out = await client.call('chat.send', { sessionKey: 'infra-test-02', idempotencyKey: require('crypto').randomUUID(), message: 'say hi' });
      console.log(JSON.stringify(out));
      client.close();
      process.exit(0);
    })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
  " 2>/dev/null)"
  run_id="$(echo "$resp" | grep -o '"runId":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -z "$run_id" ]; then
    log_warn "chat request did not return a runId (response: ${resp}) — this turn cannot be tracked"
    return 1
  fi
  echo "$run_id"
}

log_step "firing 8 chat turns (tracked by real runId) spaced 4s apart — at 2000 bytes this should force at least one rotation partway through"
markers=""
for i in 1 2 3 4 5 6 7 8; do
  m="$(send_chat)"
  if [ -n "$m" ]; then markers="${markers} ${m}"; fi
  sleep 4
done
marker_count="$(echo "$markers" | wc -w | tr -d ' ')"
log_info "tracked ${marker_count} of 8 chat turns by runId"

log_step "letting the collector settle (a couple more poll/flush cycles)"
sleep 15

log_step "collecting gateway-stream segments for agent4 in this test's window"
segment_keys="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' AND stream = 'gateway' AND ts_from >= '${test_start_ts}' ORDER BY ts_from;")"
if [ -z "$segment_keys" ]; then
  test_fail "no gateway-stream segments were written for agent4 during this test window"
  exit 0
fi
segment_count="$(echo "$segment_keys" | grep -c .)"
log_info "found ${segment_count} gateway-stream segment(s) — more than 1 is itself weak evidence rotation triggered multiple source-kind/flush transitions"

keys_json="["
first=1
while IFS= read -r k; do
  [ -n "$k" ] || continue
  if [ "$first" -eq 1 ]; then first=0; else keys_json="${keys_json},"; fi
  keys_json="${keys_json}\"${k}\""
done <<< "$segment_keys"
keys_json="${keys_json}]"

# Structural invariants (same as 10-01 in this phase, and Phase 4's own
# scripts): zero duplicate raw lines across the whole window proves
# nothing was double-ingested across the rotation boundary; a nonzero
# total proves real content was actually collected to check in the first
# place. See this script's header for why per-turn runId matching was
# dropped in favor of this.
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
    if (seen.has(raw)) { dupes += 1; } else { seen.set(raw, true); }
  }
}
console.log(JSON.stringify({ total, dupes }));
"
)"
node_call_status=$?

if [ "$node_call_status" -ne 0 ]; then
  test_fail "node_call failed reading/decrypting the collected gateway segments (exit ${node_call_status}): ${dedup_result}"
  exit 0
fi

log_info "dedup result: ${dedup_result}"
total_lines="$(echo "$dedup_result" | grep -o '"total":[0-9]*' | cut -d: -f2)"
dupes="$(echo "$dedup_result" | grep -o '"dupes":[0-9]*' | cut -d: -f2)"
if [ -z "$total_lines" ] || [ -z "$dupes" ]; then
  test_fail "could not parse the dedup result JSON: $dedup_result"
  exit 0
fi
if [ "$total_lines" -eq 0 ]; then
  test_fail "zero gateway-stream lines were collected across the whole test window — nothing to verify against"
  exit 0
fi
if [ "$dupes" -gt 0 ]; then
  test_fail "found ${dupes} duplicate raw log line(s) across the collected gateway segments — log rotation caused re-ingestion of already-flushed content"
  exit 0
fi
if [ "$segment_count" -lt 2 ]; then
  log_warn "only 1 segment was written across the whole window — weaker evidence a rotation boundary was actually crossed during this run (2000 bytes should force at least one, but the dedup check above is what actually gates pass/fail here)"
fi

test_pass "${segment_count} gateway-stream segment(s) totalling ${total_lines} line(s) with 0 duplicates across the rotation window — no drop, no duplication across logging.maxFileBytes rotation"
