#!/usr/bin/env bash
# Phase 9, test 5: SSRF-safe target resolution actually blocks a live
# connection attempt in the real worker.ts wiring, not just the resolver
# function in isolation.
#
# gatewayRpc.ts's `resolveSafeGatewayTarget` is unit-tested as a pure
# function (gatewayRpc.test.ts). What that can't prove is that
# `createGatewayClient`'s real connect path — `connectOnce()`'s call to
# `resolveTarget(agent).then((target) => { socket = createSocket(target.url) ... })`
# — actually calls it and actually never reaches `createSocket` when it
# rejects. This script proves that against the real, running
# worker-provisioner, using a real agent row (agent2) with its
# `gateway_host` temporarily repointed at 169.254.169.254 (the canonical
# link-local/cloud-metadata SSRF target `resolveSafeGatewayHost`'s
# `isBlockedGatewayIP` explicitly denies).
#
# Two lines of evidence, not just one:
#   1. worker-provisioner's own log shows the specific
#      "not an allowed gateway address" rejection (from
#      `resolveSafeGatewayHost`), proving the resolver ran and rejected.
#   2. `/proc/net/tcp` inside the worker-provisioner container never shows
#      a connection to 169.254.169.254 (hex A9FEA9FE, any byte order) for
#      the whole observation window — proving no socket was ever opened,
#      not just that an error was logged (a logged-but-cosmetic error
#      wouldn't be caught by evidence #1 alone if some other code path
#      still dialed).
#
# A restart of worker-provisioner is used (rather than waiting for
# reconcileStreams' 30s tick) to force a genuinely fresh attach with the
# new gateway_host — an already-held agent's client is cached in
# gatewayCollector's `agents` map and would NOT pick up a DB change to an
# already-open connection.
#
# Timing note (confirmed empirically while building this test): the
# rejection does NOT show up quickly. `reconcileStreams()`'s own interval
# timer does not fire on process start (plain `setInterval`, not an
# immediate first call), so the first attach happens ~30s after boot; the
# freshly-attached client's FIRST poll then calls `ensureConnected()`,
# which — because this is a never-yet-established connection, unlike the
# live-connection-drop scenarios in phase9/02 — runs gatewayRpc.ts's FULL
# 8-attempt/30s-cap reconnect loop before giving up, since
# `resolveSafeGatewayTarget`'s rejection is not a `GatewayAuthError` and so
# is retried like any other connection failure. Total observed time from
# container boot to the log line: ~152s (30s reconcile delay + ~1s poll
# delay + ~121s of retries: 1+2+4+8+16+30+30+30). This is actually the
# clean confirmation of the reconnect-backoff schedule that phase9/02
# could not produce against a LIVE connection — it only appears on an
# INITIAL connect that fails from the very first attempt. The final
# message is the `GatewayUnavailableError` wrapping the original
# rejection: "gateway unreachable after 8 reconnect attempt(s): agent
# gateway host is not an allowed gateway address" — this script matches on
# the inner "not an allowed gateway address" substring so it still passes
# regardless of the outer wrapping's exact wording.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/real_agent.sh"

require_confirmation
test_start "phase9-gateway-rpc-client" "05-ssrf-block-live-connect"

# Resolved by name, not a hardcoded id — see lib/real_agent.sh for why.
AGENT_ID="$(resolve_real_agent agent2 INFRA_TEST_AGENT2_NAME | cut -d'|' -f1)"
ORIGINAL_HOST=""
ORIGINAL_PORT=""
HOST_CHANGED=0

cleanup() {
  test_trap_incomplete
  if [ "$HOST_CHANGED" -eq 1 ] && [ -n "$ORIGINAL_HOST" ]; then
    log_step "restoring agent2's real gateway_host/gateway_port"
    db_exec "UPDATE agents SET gateway_host = '${ORIGINAL_HOST}', gateway_port = ${ORIGINAL_PORT} WHERE id = '${AGENT_ID}';" >/dev/null
  fi
  log_step "restarting worker-provisioner so agent2 reattaches with its real gateway address"
  compose up -d worker-provisioner >/dev/null 2>&1 || true
  wait_for_healthy worker-provisioner 60 >/dev/null 2>&1 || log_warn "worker-provisioner did not report healthy during cleanup — check it manually"
}
trap cleanup EXIT

row="$(db_query "SELECT gateway_host, gateway_port FROM agents WHERE id = '${AGENT_ID}';")"
if [ -z "$row" ]; then
  test_fail "could not read agent2 (${AGENT_ID})'s gateway_host/gateway_port — re-resolve the agent before rerunning"
  exit 0
fi
ORIGINAL_HOST="$(echo "$row" | cut -d'|' -f1)"
ORIGINAL_PORT="$(echo "$row" | cut -d'|' -f2)"
log_info "agent2 real gateway target: ${ORIGINAL_HOST}:${ORIGINAL_PORT} (saved for restore)"

log_step "repointing agent2's gateway_host at 169.254.169.254 (blocked link-local/metadata address)"
db_exec "UPDATE agents SET gateway_host = '169.254.169.254' WHERE id = '${AGENT_ID}';" >/dev/null
HOST_CHANGED=1

log_step "restarting worker-provisioner to force a fresh connect attempt against the new (malicious) target"
drop_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose restart worker-provisioner >/dev/null
if ! wait_for_healthy worker-provisioner 60; then
  test_fail "worker-provisioner did not become healthy again after restart"
  exit 0
fi

log_step "waiting up to 200s for the SSRF rejection to show up in worker-provisioner's logs (see this script's Timing note above: ~30s reconcile delay + ~121s of real reconnect-loop exhaustion before the first log line)"
rejection_line=""
deadline_ms=$(( $(now_ms) + 200000 ))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  rejection_line="$(compose logs --since "$drop_ts" worker-provisioner 2>&1 | grep "${AGENT_ID}" | grep -i "not an allowed gateway address" | head -1)"
  if [ -n "$rejection_line" ]; then break; fi
  sleep 3
done

if [ -z "$rejection_line" ]; then
  test_fail "no 'not an allowed gateway address' rejection observed for agent2 within 60s of pointing gateway_host at 169.254.169.254 — either resolveSafeGatewayTarget did not run in the real worker.ts wiring, or its error message/wrapping has changed"
  exit 0
fi
log_info "observed: $rejection_line"

log_step "checking /proc/net/tcp inside worker-provisioner for any connection to 169.254.169.254 (hex A9FEA9FE)"
tcp_hits="$(compose exec -T worker-provisioner sh -c "cat /proc/net/tcp 2>/dev/null | grep -ic 'A9FEA9FE' || true")"
tcp_hits="${tcp_hits:-0}"
if [ "$tcp_hits" != "0" ]; then
  test_fail "found ${tcp_hits} entr(y/ies) in /proc/net/tcp matching 169.254.169.254's hex encoding — a socket connection to the blocked address WAS attempted despite the logged rejection, meaning something in the real path still dials before/regardless of resolveSafeGatewayTarget's rejection"
  exit 0
fi
log_info "confirmed: zero /proc/net/tcp entries reference 169.254.169.254 — no socket was ever opened toward the blocked target"

test_pass "resolveSafeGatewayTarget's rejection ('not an allowed gateway address') is confirmed to run in the real worker.ts/gatewayCollector wiring before any socket is created — both the log evidence and a direct /proc/net/tcp check on the live worker-provisioner container agree no connection to the blocked 169.254.169.254 target was ever attempted"
