#!/usr/bin/env bash
# Phase 12, test 3: reconciliation re-applies tracing config to an agent
# whose config drifted while it was already running.
#
# This used to strip diagnostics.otel and then `docker restart` the
# container, on the assumption that a plain restart only restarts the
# process (not the filesystem) and so couldn't itself be the thing putting
# the config back. That assumption about the FILESYSTEM was right, but it
# missed a second real actor: the agent container's own entrypoint/
# bootstrap sequence (agent-runtime/lib/runtimeBootstrap.ts) also runs on
# every container start, independent of Nora's backend-side reconciler,
# and it re-applies expected config as part of coming up. Confirmed live:
# after strip -> restart -> sleep 8, diagnostics.otel was ALREADY back,
# well before backgroundTasks.ts's 30s RECONCILE_INTERVAL could plausibly
# have ticked. That's not a bug -- the agent doing the right thing on its
# own boot is fine -- but it means a bare restart can never isolate
# reconcileTracingConfig specifically: bootstrap wins the race every time.
#
# Fixed approach: never restart the container at all. Strip
# diagnostics.otel from the on-disk config of an agent that is already
# running and has been stable for a while (so bootstrap has long since
# finished and cannot be a candidate explanation), then wait for the real
# 30s reconcile loop -- and ONLY that loop, since nothing else touches a
# running container's config file outside of a restart or an explicit
# apply -- to notice the drift and fix it with zero manual trigger from
# this script. `docker inspect`'s StartedAt/Pid are checked before and
# after to prove no restart happened, the same technique
# 01-live-merge-no-restart.sh already uses for the same purpose.

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
    log_step "restoring agent5's original openclaw.json (whatever it held before this test) directly, no restart needed"
    printf '%s' "$ORIGINAL_CONFIG" | docker exec -i "$CONTAINER_NAME" sh -c "cat > ${CONFIG_PATH}.infra-restore.tmp && mv ${CONFIG_PATH}.infra-restore.tmp ${CONFIG_PATH}"
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

log_step "recording StartedAt/Pid before the strip, so a restart happening (by accident, or from something else in the stack) is caught rather than silently invalidating the isolation this test depends on"
started_at_before="$(docker inspect "$CONTAINER_NAME" --format '{{.State.StartedAt}}')"
pid_before="$(docker inspect "$CONTAINER_NAME" --format '{{.State.Pid}}')"
log_info "container has been running since $started_at_before (pid $pid_before) — no restart will be issued by this script"

log_step "stripping diagnostics.otel from the on-disk config of the already-running container (simulating config drift while live, not a restart)"
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
log_info "confirmed diagnostics.otel removed from agent5's on-disk config, container never restarted"

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
  test_fail "diagnostics.otel did not reappear in agent5's config within ${waited}s of the drift — reconcileTracingConfig's 30s self-healing loop did not recover it"
  exit 0
fi

log_info "diagnostics.otel reappeared within ${waited}s, with no manual applyTracingConfig call from this script — the real 30s reconcile loop restored it"

log_step "confirming the container genuinely never restarted during the wait — otherwise bootstrap (not the reconciler) could still be the real explanation"
started_at_after="$(docker inspect "$CONTAINER_NAME" --format '{{.State.StartedAt}}')"
pid_after="$(docker inspect "$CONTAINER_NAME" --format '{{.State.Pid}}')"
if [ "$started_at_after" != "$started_at_before" ] || [ "$pid_after" != "$pid_before" ]; then
  test_fail "container restarted during the test (StartedAt $started_at_before -> $started_at_after, pid $pid_before -> $pid_after) — this invalidates the isolation this test depends on; something else in the stack restarted agent5 mid-run, re-run once nothing else is touching it"
  exit 0
fi
log_info "confirmed no restart occurred (StartedAt/Pid unchanged) — the reconcile loop, not container bootstrap, is what restored the config"

final_config="$(docker exec "$CONTAINER_NAME" sh -c "cat ${CONFIG_PATH}")"
otel_enabled_ok=0
protocol_ok=0
echo "$final_config" | grep -q '"enabled": true' && otel_enabled_ok=1
echo "$final_config" | grep -q '"protocol": "http/protobuf"' && protocol_ok=1

if [ "$otel_enabled_ok" -eq 1 ] && [ "$protocol_ok" -eq 1 ]; then
  test_pass "after diagnostics.otel drifted off an already-running agent's on-disk config (no restart, StartedAt/Pid unchanged throughout), the real 30s reconcileTracingConfig loop (backgroundTasks.ts, no manual trigger) restored it within ${waited}s: enabled=true, protocol=http/protobuf"
else
  test_fail "diagnostics.otel reappeared but with unexpected shape: ${final_config}"
fi
