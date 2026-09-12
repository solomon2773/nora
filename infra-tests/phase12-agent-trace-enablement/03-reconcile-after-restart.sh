#!/usr/bin/env bash
# Phase 12, test 3: reconciliation re-applies tracing config to an agent
# that actually restarted (not the mocked "restarted" state
# agentTracing.test.ts simulates).
#
# The scenario this proves: a real container restart is not itself what
# discards the config (confirmed empirically in 02-real-span-ingest.sh's
# development — /root/.openclaw/openclaw.json genuinely persists across a
# plain `docker restart`, since that only restarts the process, not the
# container filesystem). What COULD discard it is anything that rewrites
# openclaw.json without the diagnostics section between the restart and
# the next reconcile tick — this script manufactures exactly that
# (clearing diagnostics.otel from the on-disk config directly, the
# simplest reliable stand-in for "this agent's config no longer has
# tracing applied") and confirms `reconcileTracingConfig` (the real
# function, on the real 30s `backgroundTasks.ts` timer already running
# inside the real backend-api process — NOT called directly via
# node_call, so this is the actual production timer catching it) puts it
# back with zero manual intervention.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "phase12-agent-trace-enablement" "03-reconcile-after-restart"

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

CONFIG_PATH="/root/.openclaw/openclaw.json"
ORIGINAL_CONFIG=""

cleanup() {
  test_trap_incomplete
  if [ -n "$ORIGINAL_CONFIG" ]; then
    log_step "restoring agent5's original openclaw.json (whatever it held before this test) and restarting so the running process matches it"
    printf '%s' "$ORIGINAL_CONFIG" | docker exec -i "$CONTAINER_NAME" sh -c "cat > ${CONFIG_PATH}.infra-restore.tmp && mv ${CONFIG_PATH}.infra-restore.tmp ${CONFIG_PATH}"
    docker restart "$CONTAINER_NAME" >/dev/null 2>&1 || true
    sleep 5
  fi
}
trap cleanup EXIT

log_step "recording agent5's current openclaw.json so it can be restored exactly, regardless of pass/fail"
ORIGINAL_CONFIG="$(docker exec "$CONTAINER_NAME" sh -c "cat ${CONFIG_PATH} 2>/dev/null")"
if [ -z "$ORIGINAL_CONFIG" ]; then
  test_fail "could not read agent5's current openclaw.json — refusing to proceed without a known-good config to restore"
  exit 0
fi
if ! echo "$ORIGINAL_CONFIG" | grep -q '"otel"'; then
  test_fail "agent5's config has no diagnostics.otel section before this test even starts — run 01-live-merge-no-restart.sh first so there is something real to lose and recover"
  exit 0
fi

log_step "writing a version of openclaw.json with diagnostics.otel removed entirely (simulating an agent that restarted and lost its tracing config), then restarting the container for real"
# Strip with a small inline node script executed directly inside the
# agent's own container (it already has node), rather than piping the
# multi-KB JSON blob through node_call/another container — no cross-
# container plumbing needed, and bash 3.2 has no clean way to
# shell-quote a large JSON blob as a literal anyway.
docker exec "$CONTAINER_NAME" sh -c "node -e \"
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('${CONFIG_PATH}', 'utf8'));
if (cfg.diagnostics) { delete cfg.diagnostics.otel; delete cfg.diagnostics; }
fs.writeFileSync('${CONFIG_PATH}', JSON.stringify(cfg, null, 2) + '\\n');
console.log('stripped');
\""
strip_status=$?
if [ "$strip_status" -ne 0 ]; then
  test_fail "could not strip diagnostics.otel from agent5's config directly"
  exit 0
fi

after_strip="$(docker exec "$CONTAINER_NAME" sh -c "cat ${CONFIG_PATH}")"
if echo "$after_strip" | grep -q '"otel"'; then
  test_fail "diagnostics.otel is still present after the strip — test setup itself failed"
  exit 0
fi
log_info "confirmed diagnostics.otel removed from agent5's on-disk config"

log_step "restarting agent5's container for real (a genuine restart, not the unit test's mocked 'restarted' state)"
docker restart "$CONTAINER_NAME" >/dev/null
sleep 8
restart_status="$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}')"
if [ "$restart_status" != "running" ]; then
  test_fail "agent5's container did not come back up running after the restart (status: ${restart_status})"
  exit 0
fi
log_info "agent5 container restarted and is running again"

# Confirm the stripped state genuinely survived the restart (i.e. this
# test isn't accidentally validating against a config OpenClaw itself
# regenerated at boot) before waiting on reconciliation.
post_restart_config="$(docker exec "$CONTAINER_NAME" sh -c "cat ${CONFIG_PATH}" 2>/dev/null)"
if echo "$post_restart_config" | grep -q '"otel"'; then
  test_fail "diagnostics.otel reappeared immediately after the restart, before reconciliation could have run — something other than reconcileTracingConfig restored it, invalidating this test's premise"
  exit 0
fi
log_info "confirmed diagnostics.otel is still absent immediately post-restart — the real 30s reconcile loop (not container boot) is what must restore it"

log_step "waiting for the real backend-api reconcile loop (backgroundTasks.ts's 30s RECONCILE_INTERVAL, calling the real reconcileTracingConfig -> applyTracingConfig) to notice and re-apply, without any manual trigger from this script"
waited=0
reconciled=0
while [ "$waited" -lt 75 ]; do
  current_config="$(docker exec "$CONTAINER_NAME" sh -c "cat ${CONFIG_PATH}" 2>/dev/null)"
  if echo "$current_config" | grep -q '"otel"' && echo "$current_config" | grep -q '"enabled": true'; then
    reconciled=1
    break
  fi
  sleep 5
  waited=$((waited + 5))
done

if [ "$reconciled" -ne 1 ]; then
  test_fail "diagnostics.otel did not reappear in agent5's config within ${waited}s of the real restart — reconcileTracingConfig's 30s self-healing loop did not recover it"
  exit 0
fi

log_info "diagnostics.otel reappeared within ${waited}s, with no manual applyTracingConfig call from this script — the real 30s reconcile loop restored it"

final_config="$(docker exec "$CONTAINER_NAME" sh -c "cat ${CONFIG_PATH}")"
otel_enabled_ok=0
protocol_ok=0
echo "$final_config" | grep -q '"enabled": true' && otel_enabled_ok=1
echo "$final_config" | grep -q '"protocol": "http/protobuf"' && protocol_ok=1

if [ "$otel_enabled_ok" -eq 1 ] && [ "$protocol_ok" -eq 1 ]; then
  test_pass "after a real container restart wiped diagnostics.otel from disk, the real 30s reconcileTracingConfig loop (backgroundTasks.ts, no manual trigger) restored it within ${waited}s: enabled=true, protocol=http/protobuf"
else
  test_fail "diagnostics.otel reappeared but with unexpected shape: ${final_config}"
fi
