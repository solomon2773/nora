#!/usr/bin/env bash
# Phase 4, test 6: a `null` from containerManager.logs() is handled
# quietly, not as a retry storm.
#
# ⚠️ Adapted scope, found while reviewing this script a second time:
# `DockerBackend.logs()` (workers/provisioner/backends/docker.ts:1318)
# NEVER returns `null` — it calls `container.logs(logOptions)` and either
# returns the stream or THROWS (e.g. a 404 for a removed container). A
# literal `null` return is specific to the generic base adapter and to the
# Kubernetes adapter when no pod is Running — neither reachable with a
# Docker-backed test agent, which is all `lib/agent.sh` can create. An
# earlier version of this script stopped the container and set
# `agents.status = 'stopped'`, which actually tested something else
# entirely: taking the agent OUT of the reconciler's desired set (`WHERE
# status IN ('running','warning')`) so it's never attached again at all —
# not a null-handling test.
#
# What this version actually tests instead: `agents.status` stays
# 'running' (so the reconciler keeps trying to attach every 30s tick), but
# the container is REMOVED entirely, so `containerManager.logs()` throws.
# `attachAgentStream`'s own try/catch treats a caught error identically to
# a `null` return (log a warning, return null, the next reconcile tick
# tries again) — so this exercises the same graceful-degradation code path
# the plan's item 3 is actually protecting, just reached via the
# throw-then-catch branch rather than a literal `null`, which is the only
# branch a Docker-backed agent can reach.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"

require_confirmation
test_start "phase4-log-collector" "03-null-logs-no-retry-storm"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""

cleanup() {
  test_trap_incomplete
  # teardown_test_agent's own container removal is already `|| true`-guarded
  # (see lib/docker_ctl.sh's stop_and_remove), so it's safe to call even
  # though this test already removed the container itself mid-run.
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "null-logs")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

sleep 35 # reconcile attach

log_step "removing the container entirely (agents.status stays 'running' — the reconciler will keep trying to attach)"
docker rm -f "$CONTAINER_NAME" >/dev/null

log_step "watching worker-provisioner logs across ~3 reconcile ticks (100s) for error/retry spam"
sleep 100
logs_recent="$(compose logs worker-provisioner --since 100s 2>&1)"
mention_count="$(echo "$logs_recent" | grep -ci "${AGENT_ID}" || true)"
log_info "log lines mentioning this agent id in the last 100s: $mention_count"

# A handful of mentions is fine (roughly one attach-failed warning per 30s
# reconcile tick — ~3 over 100s is expected and healthy); a storm looks
# like dozens of repeated attach/error lines, far more than one per tick.
if [ "$mention_count" -gt 10 ]; then
  test_fail "found $mention_count log lines mentioning this agent in 100s (agents.status still 'running', container removed) — looks like a retry storm rather than one graceful warning per reconcile tick"
else
  test_pass "no retry storm — $mention_count log line(s) mentioning this agent across ~3 reconcile ticks while its container was gone but status still said 'running'"
fi
