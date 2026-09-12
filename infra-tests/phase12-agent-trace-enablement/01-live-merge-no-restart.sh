#!/usr/bin/env bash
# Phase 12, test 1: applying tracing config to a real running OpenClaw
# container issues no restart, and the config actually lands on disk.
#
# Uses agent5 (re-resolved by name, not a hardcoded id — see this phase's
# README/task briefing: "names/IDs can drift"), assigned to workspace2
# (10dcb117-3d27-4a96-878a-df46e1e4f05e), which already has
# tracesEnabled=true / traceSampleRate=1 set via a real
# PUT /workspaces/:id/log-settings call.
#
# `backend-api/agentTracing.ts`'s own applyTracingConfig is called directly
# via node_call, inside the REAL worker-provisioner container (backend-api
# source is mounted at /backend-api there — confirmed empirically, same
# mount phase10's 02 script already relies on for
# /agent-runtime/lib/runtimeBootstrap.ts). This is more direct than round-
# tripping through the PUT route (which only re-applies when tracesEnabled
# actually CHANGES — see observability.ts's own doc comment — so toggling
# it off/on would be needed to force a fresh apply through that path
# instead).
#
# "No restart" is verified via `docker inspect`'s StartedAt/Pid, which only
# change across a real container restart — a live config-file merge inside
# the running container's filesystem does not touch either.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "phase12-agent-trace-enablement" "01-live-merge-no-restart"

# Re-resolve agent5 by name — names/ids can drift, per the task briefing.
AGENT_ROW="$(db_query "SELECT id, container_name, status FROM agents WHERE name='agent5';")"
if [ -z "$AGENT_ROW" ]; then
  test_fail "no agents row named 'agent5' found — re-resolve before rerunning"
  exit 0
fi
AGENT_ID="$(echo "$AGENT_ROW" | cut -d'|' -f1)"
CONTAINER_NAME="$(echo "$AGENT_ROW" | cut -d'|' -f2)"
AGENT_STATUS="$(echo "$AGENT_ROW" | cut -d'|' -f3)"
log_info "resolved agent5: id=$AGENT_ID container=$CONTAINER_NAME status=$AGENT_STATUS"

if [ "$AGENT_STATUS" != "running" ]; then
  test_fail "expected agent5 (${AGENT_ID}) to have status='running' before this test (got: ${AGENT_STATUS:-<none>})"
  exit 0
fi

cleanup() {
  test_trap_incomplete
}
trap cleanup EXIT

log_step "recording docker inspect StartedAt/Pid for ${CONTAINER_NAME} before the live config merge"
before="$(docker inspect "$CONTAINER_NAME" --format '{{.State.StartedAt}}|{{.State.Pid}}')"
before_started_at="$(echo "$before" | cut -d'|' -f1)"
before_pid="$(echo "$before" | cut -d'|' -f2)"
log_info "before: StartedAt=${before_started_at} Pid=${before_pid}"

log_step "calling agentTracing.applyTracingConfig(agent) directly against the real running worker-provisioner process"
apply_result="$(node_call "
  const agentTracing = require('/backend-api/agentTracing.ts');
  const db = require('/backend-api/db.ts');
  (async () => {
    const r = await db.query(\"SELECT id, user_id, container_id, backend_type, deploy_target, execution_target_id, runtime_family, sandbox_profile, status, host, runtime_host, runtime_port, gateway_host, gateway_port FROM agents WHERE id='${AGENT_ID}'\");
    const agent = r.rows[0];
    if (!agent) throw new Error('agent row not found');
    const result = await agentTracing.applyTracingConfig(agent);
    console.log(JSON.stringify(result));
    process.exit(0);
  })().catch(e => { console.error('ERR', e.message); process.exit(1); });
")"
apply_status=$?
log_info "applyTracingConfig result: ${apply_result}"
if [ "$apply_status" -ne 0 ]; then
  test_fail "applyTracingConfig call failed (exit ${apply_status}): ${apply_result}"
  exit 0
fi
if ! echo "$apply_result" | grep -q '"applied":true'; then
  test_fail "applyTracingConfig did not report applied:true: ${apply_result}"
  exit 0
fi

log_step "recording docker inspect StartedAt/Pid after the live config merge"
after="$(docker inspect "$CONTAINER_NAME" --format '{{.State.StartedAt}}|{{.State.Pid}}')"
after_started_at="$(echo "$after" | cut -d'|' -f1)"
after_pid="$(echo "$after" | cut -d'|' -f2)"
log_info "after: StartedAt=${after_started_at} Pid=${after_pid}"

if [ "$before_started_at" != "$after_started_at" ] || [ "$before_pid" != "$after_pid" ]; then
  test_fail "container restarted across the live config merge (StartedAt ${before_started_at} -> ${after_started_at}, Pid ${before_pid} -> ${after_pid}) — applyTracingConfig should never restart the agent"
  exit 0
fi
log_info "confirmed no restart: StartedAt and Pid unchanged"

log_step "reading the config that actually landed on disk inside the container (/root/.openclaw/openclaw.json)"
config_json="$(docker exec "$CONTAINER_NAME" sh -c 'cat /root/.openclaw/openclaw.json 2>/dev/null')"
if [ -z "$config_json" ]; then
  test_fail "could not read /root/.openclaw/openclaw.json from ${CONTAINER_NAME}"
  exit 0
fi
log_info "diagnostics.otel section: $(echo "$config_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(JSON.stringify(j.diagnostics));}catch(e){console.log('PARSE_ERROR '+e.message);}});" 2>/dev/null || echo "(node not available on host — falling back to grep)")"

otel_enabled_ok=0
protocol_ok=0
capture_content_ok=0
echo "$config_json" | grep -q '"enabled": true' && otel_enabled_ok=1
echo "$config_json" | grep -q '"protocol": "http/protobuf"' && protocol_ok=1
echo "$config_json" | grep -q '"captureContent": false' && capture_content_ok=1

if [ "$otel_enabled_ok" -eq 1 ] && [ "$protocol_ok" -eq 1 ] && [ "$capture_content_ok" -eq 1 ]; then
  test_pass "no restart (StartedAt/Pid unchanged) AND config landed on disk: diagnostics.otel.enabled=true, protocol=http/protobuf, captureContent=false"
else
  test_fail "config did not land as expected on disk — otel_enabled_ok=${otel_enabled_ok} protocol_ok=${protocol_ok} capture_content_ok=${capture_content_ok}; raw: ${config_json}"
fi
