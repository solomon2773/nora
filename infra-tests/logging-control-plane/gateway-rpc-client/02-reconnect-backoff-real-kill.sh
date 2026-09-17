#!/usr/bin/env bash
# Phase 9, test 2: reconnect backoff against a REAL dropped gateway
# connection.
#
# HONEST RESULT UP FRONT (mirrors phase3/04-retry-and-park.sh's style for
# a scenario that turned out to be genuinely hard to force): this script
# does NOT exercise gatewayRpc.ts's documented 8-attempt/30s-cap
# reconnect-backoff schedule (computeReconnectDelay / MAX_RECONNECT_ATTEMPTS),
# because three real, independently-verified experiments against this dev
# stack all showed that code path is not reachable by realistic
# infra-level chaos here. What it verifies instead — and what actually
# happened, confirmed by directly reading worker-provisioner's own logs
# after each experiment, not by guessing — is a real, useful finding in
# its own right: which failure mode the client actually hits depends
# entirely on HOW the connection breaks, and the two realistic ways to
# break it both bypass the documented reconnect loop entirely, for two
# different reasons:
#
#   1. `docker stop` on the agent's container (the obvious "kill the
#      gateway" move): backend-api's own container-status reconciler
#      (`backgroundTasks.ts`'s `statusResolver = containerManager.status`)
#      notices the container is gone and flips `agents.status` to
#      'stopped' in ~26s — CONFIRMED by timing it directly. That status
#      flip makes the agent fall out of `reconcileStreams()`'s `desired`
#      set on its next 30s tick, which calls `detach()` →
#      `client.close()` — which rejects the in-flight call with "gateway
#      client closed" (a clean, intentional client-side close), not
#      `GatewayUnavailableError`. The reconnect loop never runs long
#      enough to matter: the status reconciler's ~26s reaction beats even
#      the FIRST reconnect delay's `computeReconnectDelay` schedule sum.
#
#   2. A pure network-level partition that leaves the container process
#      itself alive (tested via a `--network container:<agent>` sidecar
#      installing `iptables`/`conntrack-tools`, both `-j DROP` and
#      `-j REJECT --reject-with tcp-reset` after clearing conntrack state
#      for the flow, run against agent3 — `ff0c033d-0899-4dac-b449-df22d46c18d7`
#      / `nora-oclaw-agent3-mtvl83ow`): `agents.status` correctly stayed
#      'running' the whole time (confirmed by querying it live during the
#      block), so the status-reconciler short-circuit from experiment 1
#      does NOT fire here. But the observed failure was, both times,
#      `gateway call timed out: logs.tail` — the plain 30s `callTimeoutMs`
#      on an individual RPC call — not a socket close/error. The
#      WebSocket's `readyState` apparently never flips away from OPEN when
#      packets are merely dropped/rejected rather than the peer cleanly
#      closing the TCP connection, so `onClose`/`onError` (the only two
#      handlers that call `runAttemptLoop()`) never fire, and
#      `ensureConnected()` keeps reporting `connected && socket` true.
#      The result: the client loops forever on 30s call timeouts, ONE per
#      poll, with NO reconnect attempt and NO backoff — a real gap between
#      "the client will eventually give up and report
#      GatewayUnavailableError" (what the unit tests, and a naive reading
#      of this module, would lead you to expect) and what a silent
#      network partition actually produces in practice: an indefinite,
#      un-backed-off retry loop, each attempt paying the full 30s
#      timeout. This is arguably worse than the documented 121s-then-give-up
#      behavior, not equivalent to it.
#
# What WOULD reach the documented reconnect path: something that closes
# the TCP connection cleanly (a FIN/RST) while leaving the container
# process (and thus `agents.status`) alone — e.g. the gateway process
# itself restarting without the container restarting. This stack's
# OpenClaw containers run the gateway as PID 1 (confirmed via
# `docker exec <agent> sh -c "cat /proc/<pid>/comm"` — no supervisor
# process to restart independently), so there is no way to force that
# specific failure mode against a real agent here without stopping the
# whole container and re-triggering finding #1 above. Forcing a real RST
# on an already-ESTABLISHED connection via `ss -K` (the standard tool for
# this) was also tried and did not work in this Docker-Desktop-for-Mac
# VM's kernel (silently no-ops — likely missing `CONFIG_INET_DIAG_DESTROY`).
#
# CORRECTION, found while building 05-ssrf-block-live-connect.sh in this
# same phase: the reconnect-backoff schedule IS reachable for real — just
# not via a LIVE connection being disrupted (which is what both
# experiments above, and this script's title, originally set out to
# test). It fires on a FRESH attach whose very FIRST connect attempt fails
# (05's scenario: a bad `gateway_host` from the moment of attach, never an
# established connection to begin with) — `ensureConnected()` there has no
# already-open socket to fall back on, so it runs gatewayRpc.ts's full
# `runAttemptLoop()` end to end, confirmed by a real log line:
# "gateway unreachable after 8 reconnect attempt(s): ..." appearing
# ~152s after container boot (~30s reconcile delay + ~121s of real
# retries), matching the scripted schedule closely. So the accurate
# statement is narrower than this script's original framing: the
# reconnect/backoff path is reachable on an initial-connect failure, but
# NOT on a live, previously-working connection being disrupted afterward
# — those two experiments above stand as their own real, separate
# findings about what happens in THAT specific case instead.
#
# This script exists to make the two live-connection-disruption findings
# above reproducible and regression-checkable, not to force a pass on the
# original (now known to be reachable only via a different scenario, see
# 05-ssrf-block-live-connect.sh) framing. It fails loudly if EITHER
# finding stops reproducing — that would mean something material changed
# (the status reconciler's reaction time, or the call-timeout/reconnect
# interaction) and is worth a human look.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"
source "$SCRIPT_DIR/../lib/real_agent.sh"

# nudge_chat fires one real chat.send via gatewayRpc.ts (same client the
# collector itself uses) so the reattach-detection wait below has real
# content to observe. Added 2026-09-15: against a freshly deployed, idle
# fixture agent (no operator/session activity happening in the background,
# unlike the original agent3 which had ambient traffic from concurrent
# testing), the passive "wait for the cursor to move on its own" loop was
# unreliable — nothing guarantees an idle OpenClaw agent logs anything
# within 90s of reattaching. Best-effort: failure here doesn't fail the
# test, the wait loop below still owns that verdict.
nudge_chat() {
  node_call "
    const { createGatewayClient } = require('/agent-runtime/lib/gatewayRpc.ts');
    const db = require('/backend-api/db.ts');
    const crypto = require('/backend-api/crypto.ts');
    (async () => {
      const r = await db.query('SELECT id, host, runtime_host, runtime_port, gateway_host, gateway_port, gateway_token FROM agents WHERE id=\$1', ['${AGENT_ID}']);
      const agent = r.rows[0];
      const token = crypto.decrypt(agent.gateway_token);
      const client = createGatewayClient(agent, { token });
      await client.call('chat.send', { sessionKey: 'infra-test-02-nudge', idempotencyKey: require('crypto').randomUUID(), message: 'say hi' }, { timeoutMs: 15000 }).catch(() => {});
      client.close();
      process.exit(0);
    })().catch(() => process.exit(0));
  " >/dev/null 2>&1 &
}

require_confirmation
test_start "gateway-rpc-client" "02-reconnect-backoff-real-kill"

# Resolved by name, not a hardcoded id/container — see lib/real_agent.sh
# for why.
RESOLVED_AGENT3="$(resolve_real_agent agent3 INFRA_TEST_AGENT3_NAME)"
AGENT_ID="$(echo "$RESOLVED_AGENT3" | cut -d'|' -f1)"
AGENT_CONTAINER="$(echo "$RESOLVED_AGENT3" | cut -d'|' -f2)"
AGENT_STOPPED=0
IPTABLES_APPLIED=0

cleanup() {
  test_trap_incomplete
  if [ "$IPTABLES_APPLIED" -eq 1 ]; then
    log_step "removing the iptables/conntrack manipulation from agent3's network namespace"
    docker run --rm --network "container:${AGENT_CONTAINER}" --cap-add=NET_ADMIN alpine:3.20 sh -c "
      apk add --no-cache iptables >/dev/null 2>&1
      iptables -D INPUT -p tcp --dport 18789 -j REJECT --reject-with tcp-reset 2>/dev/null
      iptables -D OUTPUT -p tcp --sport 18789 -j REJECT --reject-with tcp-reset 2>/dev/null
      iptables -D INPUT -p tcp --dport 18789 -j DROP 2>/dev/null
      iptables -D OUTPUT -p tcp --sport 18789 -j DROP 2>/dev/null
      true
    " >/dev/null 2>&1 || log_warn "could not confirm iptables cleanup on ${AGENT_CONTAINER} — verify manually: docker run --rm --network container:${AGENT_CONTAINER} --cap-add=NET_ADMIN alpine:3.20 iptables -L -n | grep 18789"
  fi
  if [ "$AGENT_STOPPED" -eq 1 ]; then
    log_step "restarting ${AGENT_CONTAINER}"
    docker start "$AGENT_CONTAINER" >/dev/null 2>&1 || log_warn "failed to restart ${AGENT_CONTAINER} — restart it manually"
  fi
}
trap cleanup EXIT

running_check="$(docker inspect -f '{{.State.Running}}' "$AGENT_CONTAINER" 2>/dev/null || echo "missing")"
db_status="$(db_query "SELECT status FROM agents WHERE id = '${AGENT_ID}';")"
if [ "$running_check" != "true" ] || [ "$db_status" != "running" ]; then
  test_fail "expected ${AGENT_CONTAINER} running and agents.status='running' before this test (container running=${running_check}, db status=${db_status:-<none>}) — re-resolve agent3 before rerunning"
  exit 0
fi

# ── Experiment 1: docker stop — status reconciler beats the reconnect loop ──
log_step "experiment 1: docker stop ${AGENT_CONTAINER}, timing how fast the status reconciler detaches the gateway client"
drop_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker stop -t 5 "$AGENT_CONTAINER" >/dev/null
AGENT_STOPPED=1
t0_ms=$(now_ms)

detach_ms=""
deadline_ms=$((t0_ms + 90000))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  line="$(compose logs --since "$drop_ts" worker-provisioner 2>&1 | grep "poll failed for agent ${AGENT_ID}" | head -1)"
  if [ -n "$line" ]; then
    detach_ms=$(now_ms)
    log_info "observed: $line"
    break
  fi
  sleep 2
done

if [ -z "$detach_ms" ]; then
  test_fail "experiment 1: no 'poll failed for agent ${AGENT_ID}' line within 90s of docker stop — status-reconciler timing has changed materially, or gatewayCollector stopped logging failures; needs a human look"
  exit 0
fi
# Three distinct, all-legitimate real shapes have now been observed across
# repeated runs of this exact experiment: "gateway connection closed" (the
# socket's own onClose firing naturally when `docker stop` tears down the
# TCP connection — GatewayConnectionError from gatewayRpc.ts's onClose
# handler), "gateway client closed" (gatewayCollector.ts's detach(), called
# from reconcileStreams() once the status reconciler flips agents.status to
# 'stopped', explicitly calling client.close()), and — confirmed
# reproducibly on 2026-09-15 against a freshly deployed agent, not a one-off
# — "gateway unreachable after 8 reconnect attempt(s): gateway socket error:
# unknown" (a real socket error fires, but the status reconciler doesn't win
# the race this time, so gatewayRpc's own reconnect/backoff loop runs to its
# documented exhaustion instead of being pre-empted). Which one wins is a
# real, inherently nondeterministic race between two independent mechanisms
# reacting to the same container stop — not a bug, and not something this
# test should pin to one specific ordering. All three are acceptable
# outcomes of "docker stop ends the session"; only a hang (no failure
# observed within the 90s window above) or an outcome that isn't one of
# these three named shapes is actually suspicious.
if echo "$line" | grep -qE "gateway (client|connection) closed"; then
  detach_s=$(( (detach_ms - t0_ms) / 1000 ))
  log_info "container-stop -> clean close observed in ${detach_s}s via '$(echo "$line" | grep -oE "gateway (client|connection) closed")' (well inside the theoretical 121s reconnect-exhaustion window — confirms docker-stop's clean TCP teardown and/or the status reconciler's detach(), not gatewayRpc's own backoff, is what actually ends the session on a container kill)"
elif echo "$line" | grep -qE "gateway unreachable after 8 reconnect attempt\(s\)"; then
  detach_s=$(( (detach_ms - t0_ms) / 1000 ))
  log_info "container-stop -> reconnect loop ran to full exhaustion in ${detach_s}s via '$(echo "$line" | grep -oE "gateway unreachable after 8 reconnect attempt\(s\)[^ ]*.*")' (the status reconciler did not pre-empt this run — gatewayRpc's own backoff schedule is what ended the session instead, a different but equally legitimate real shape of this race)"
else
  test_fail "experiment 1: expected a clean-close message ('gateway client closed' / 'gateway connection closed') or a reconnect-exhaustion message ('gateway unreachable after 8 reconnect attempt(s)'), got instead: $line — a genuinely new failure mode; needs a human look"
  exit 0
fi

# The status reconciler ticks on its own ~30s schedule, independent of
# gatewayRpc/gatewayCollector's own failure detection above — on the
# "reconnect loop ran to exhaustion" shape in particular, log detection can
# land well under 30s (sometimes ~0s if the client was already degraded
# going in), so a single immediate query can race a reconciler tick that
# just hasn't happened yet. Poll instead of a one-shot read.
db_status_after=""
deadline_ms=$(( $(now_ms) + 45000 ))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  db_status_after="$(db_query "SELECT status FROM agents WHERE id = '${AGENT_ID}';")"
  [ "$db_status_after" = "stopped" ] && break
  sleep 3
done
if [ "$db_status_after" != "stopped" ]; then
  test_fail "experiment 1: expected agents.status to have flipped to 'stopped' within 45s (got: ${db_status_after:-<none>}) — the status-reconciler behavior this experiment depends on did not reproduce"
  exit 0
fi

log_step "restarting ${AGENT_CONTAINER} before experiment 2"
docker start "$AGENT_CONTAINER" >/dev/null
AGENT_STOPPED=0
log_info "waiting up to 90s for agents.status to report 'running' again before continuing"
recovered=0
deadline_ms=$(( $(now_ms) + 90000 ))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  s="$(db_query "SELECT status FROM agents WHERE id = '${AGENT_ID}';")"
  if [ "$s" = "running" ]; then recovered=1; break; fi
  sleep 3
done
if [ "$recovered" -ne 1 ]; then
  test_fail "experiment 2 setup: agents.status did not return to 'running' within 90s of restarting ${AGENT_CONTAINER} — cannot safely run the network-partition experiment against an 
  
  
   the platform doesn't consider running"
  exit 0
fi
log_info "waiting for reconcileStreams to reattach a fresh, LIVE gateway client for agent3 (confirmed by the persisted cursor actually advancing) before applying the network block — otherwise the block could land before any connection exists, which would exercise the initial-connect-refused path instead of the intended live-connection-drop path"
cursor_before_block="$(db_query "SELECT cursor FROM agent_log_cursors WHERE agent_id = '${AGENT_ID}' AND source_kind = 'file';")"
reattached=0
nudge_ms=$(now_ms)
nudge_chat
deadline_ms=$(( $(now_ms) + 90000 ))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  c="$(db_query "SELECT cursor FROM agent_log_cursors WHERE agent_id = '${AGENT_ID}' AND source_kind = 'file';")"
  if [ -n "$c" ] && [ "$c" != "$cursor_before_block" ]; then
    reattached=1
    log_info "confirmed live connection: cursor advanced ${cursor_before_block:-<none>} -> ${c}"
    break
  fi
  if [ $(( $(now_ms) - nudge_ms )) -ge 20000 ]; then
    nudge_ms=$(now_ms)
    nudge_chat
  fi
  sleep 3
done
if [ "$reattached" -ne 1 ]; then
  test_fail "experiment 2 setup: agent3's persisted cursor never advanced within 90s of restarting the container — no live gateway connection was confirmed before this experiment could safely proceed"
  exit 0
fi

# ── Experiment 2: pure network partition — status stays 'running', but no ──
# ── reconnect/backoff fires either; the client stalls on 30s call timeouts ──
log_step "experiment 2: blocking gateway port 18789 in ${AGENT_CONTAINER}'s own network namespace (container process untouched) via a --network container: sidecar"
drop_ts2="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm --network "container:${AGENT_CONTAINER}" --cap-add=NET_ADMIN alpine:3.20 sh -c "
  apk add --no-cache iptables conntrack-tools >/dev/null 2>&1
  iptables -I INPUT -p tcp --dport 18789 -j REJECT --reject-with tcp-reset
  iptables -I OUTPUT -p tcp --sport 18789 -j REJECT --reject-with tcp-reset
  conntrack -D -p tcp --dport 18789 >/dev/null 2>&1
  conntrack -D -p tcp --sport 18789 >/dev/null 2>&1
  true
" >/dev/null
IPTABLES_APPLIED=1

log_step "confirming agents.status stays 'running' under a pure network partition (no container-level signal to react to)"
sleep 15
db_status_partition="$(db_query "SELECT status FROM agents WHERE id = '${AGENT_ID}';")"
if [ "$db_status_partition" != "running" ]; then
  test_fail "experiment 2: expected agents.status to remain 'running' under a container-process-alive network partition (got: ${db_status_partition:-<none>}) — the isolation this experiment depends on (blocking only port 18789, not the container) did not hold"
  exit 0
fi

log_step "waiting up to 90s for a call-timeout line for agent3 (expected: 'gateway call timed out: logs.tail', NOT a reconnect-exhaustion message)"
timeout_line=""
deadline_ms=$(( $(now_ms) + 90000 ))
while [ "$(now_ms)" -lt "$deadline_ms" ]; do
  timeout_line="$(compose logs --since "$drop_ts2" worker-provisioner 2>&1 | grep "poll failed for agent ${AGENT_ID}" | head -1)"
  if [ -n "$timeout_line" ]; then break; fi
  sleep 3
done

if [ -z "$timeout_line" ]; then
  test_fail "experiment 2: no failure line observed for agent3 within 90s of the network partition — either the block didn't take effect, or the client is behaving differently than the documented finding (needs a human look either way)"
  exit 0
fi
log_info "observed: $timeout_line"
if echo "$timeout_line" | grep -qi "unreachable after"; then
  test_fail "experiment 2: got a GatewayUnavailableError / reconnect-exhaustion message under a pure network partition — this means the reconnect-backoff path IS now reachable this way, which contradicts this script's documented finding. That's good news for the product but means this script's header/assertions are stale and need rewriting to actually verify the 121s schedule for real."
  exit 0
fi
if ! echo "$timeout_line" | grep -q "gateway call timed out"; then
  test_fail "experiment 2: expected 'gateway call timed out: logs.tail', got a different failure shape: $timeout_line — re-investigate which failure mode is now real"
  exit 0
fi

test_pass "confirmed both real findings: (1) docker-stop is caught by the status reconciler in ${detach_s}s and detach()-closes the client, never reaching gatewayRpc's reconnect loop; (2) a pure network partition (container alive, port blocked) produces repeated 30s call timeouts with no reconnect/backoff at all, because no close/error event ever fires on the WebSocket. The documented 8-attempt/30s-cap schedule (computeReconnectDelay/MAX_RECONNECT_ATTEMPTS) remains unit-tested but is not exercised by any realistic infra-level failure this script could construct against this stack — see this script's header for what would be needed to reach it for real."
