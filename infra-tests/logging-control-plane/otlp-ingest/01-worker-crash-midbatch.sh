#!/usr/bin/env bash
# Phase 11, test 1 (folds in test 3 — see this directory's README): a
# worker-provisioner crash/restart near a span-ingest drain loses no spans
# and double-inserts none, and along the way exercises the full real round
# trip (real POST -> real HMAC auth -> real enqueue -> real Redis -> real
# drain -> real agent_spans rows).
#
# Authentication only needs an agent ID + the correct HMAC under
# NORA_OTLP_INGEST_SECRET (see routes/otlp.ts's module header: "Trace
# ingest is the one new trust boundary") — the agent does not need to be a
# live running container for this route, only a real `agents` row so
# workspace attribution resolves. `provision_test_agent` gives us that row
# (plus a throwaway container we never actually use for OTLP here).
#
# Timing honesty, mirroring log-collector/01-worker-kill-midwindow.sh's
# own header: precisely landing a SIGKILL while a specific BullMQ job is
# ACTIVE (locked, mid drainSpanIngest()) rather than still WAITING is not
# something this script can guarantee — there is no test-only hook into
# BullMQ's internal state to synchronize on. What this script actually does
# is POST a real batch, give the worker a brief real window to start
# pulling jobs, then SIGKILL it and wait out BullMQ's default stalled-job
# recovery cycle (lockDuration + the stalled-check interval, both ~30s
# with no override in worker.ts's `new Worker("span-ingest", ...)` call —
# see worker.ts around the "Span Ingest Worker" comment) before asserting.
# This exercises the real crash-recovery path end-to-end even though it
# cannot force the exact interleaving on every run.
#
# What this could reveal, and why it matters: `spanDrain.ts`'s
# `batchInsertSpans` is a bare multi-row INSERT with no ON CONFLICT and
# `agent_spans` has no UNIQUE constraint on (trace_id, span_id) (see
# db_schema.sql's `agent_spans` table — only non-unique indexes). If a job
# gets marked "active" (locked) by one worker instance, that instance dies
# before completing, and BullMQ's stalled-job recovery redelivers the SAME
# job to the new instance after restart, the batch would be inserted a
# SECOND time with no constraint to stop it. This script's job is to prove
# whether that actually happens, not to assume it doesn't.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "otlp-ingest" "01-worker-crash-midbatch"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents

AGENT_ID=""
CONTAINER_NAME=""
SPAN_COUNT=25

cleanup() {
  test_trap_incomplete
  if [ -n "$AGENT_ID" ]; then
    db_exec "DELETE FROM agent_spans WHERE agent_id = '${AGENT_ID}';" >/dev/null 2>&1 || true
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
  # Leave worker-provisioner running for whatever's next, regardless of how
  # this script got here.
  compose up -d worker-provisioner >/dev/null 2>&1 || true
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent (only need a real agents row for workspace attribution — the container itself is never used for OTLP)"
_AGENT_INFO="$(provision_test_agent "otlp-crash-midbatch")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

pre_count="$(db_query "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${AGENT_ID}';")"
if [ "$pre_count" -ne 0 ]; then
  test_fail "expected zero agent_spans rows before sending anything, found $pre_count — a prior run's debris wasn't cleaned up, invalidating this test's premise"
  exit 0
fi

log_step "computing the real ingest key (routes/otlp.ts's own computeIngestKey — HMAC-SHA256 under NORA_OTLP_INGEST_SECRET) and building a real OTLP/JSON batch of $SPAN_COUNT spans, both via node_call so this exactly mirrors production code rather than a bash re-implementation"
# Real bug found running this script for the first time against a live stack:
# requiring routes/otlp.ts pulls in ../redisQueue.ts, which opens live BullMQ
# Queue objects (real ioredis connections) at MODULE SCOPE. Those are active
# handles that keep the spawned node process's event loop alive forever —
# node_call's own header says the caller must make sure the process actually
# exits (e.g. `process.exit(0)`), and this snippet originally didn't, so it
# silently turned an instant HMAC computation into a 10-20 MINUTE stall per
# invocation (confirmed empirically: identical call returns in ~1s with an
# explicit process.exit(0), vs. never returning inside a reasonable window
# without one). The trailing process.exit(0) below is the fix.
_INGEST_INFO="$(node_call "
  const { computeIngestKey } = require('../backend-api/routes/otlp.ts');
  const crypto = require('crypto');
  console.log(computeIngestKey('${AGENT_ID}'));
  const spans = [];
  for (let i = 0; i < ${SPAN_COUNT}; i++) {
    const traceId = crypto.randomBytes(16).toString('base64');
    const spanId = crypto.randomBytes(8).toString('base64');
    const now = Date.now() + i;
    spans.push({
      traceId,
      spanId,
      name: 'infra-test-crash-midbatch-' + i,
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: String(now * 1e6),
      endTimeUnixNano: String((now + 5) * 1e6),
      status: { code: 'STATUS_CODE_OK' },
      attributes: [],
    });
  }
  const payload = {
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: {}, spans }] }],
  };
  console.log(JSON.stringify(payload));
  process.exit(0);
")"
INGEST_KEY="$(echo "$_INGEST_INFO" | sed -n '1p')"
PAYLOAD="$(echo "$_INGEST_INFO" | sed -n '2p')"
if [ -z "$INGEST_KEY" ] || [ -z "$PAYLOAD" ]; then
  test_fail "node_call did not produce an ingest key and/or payload — cannot proceed. Check NORA_OTLP_INGEST_SECRET is actually configured in this stack's .env"
  exit 0
fi
log_info "ingest key computed (${#INGEST_KEY} hex chars), payload built ($SPAN_COUNT spans, ${#PAYLOAD} bytes)"

BACKEND_PORT="${BACKEND_API_PORT:-4100}"
log_step "POSTing the real batch to backend-api directly (this route is intentionally NOT proxied through nginx — see server.ts: app.use('/otlp', ...) with no matching nginx.conf location — so agents hit backend-api's own host-exposed port)"
post_status="$(curl -sS -o /tmp/infra-test-otlp-post-response.$$ -w '%{http_code}' \
  -X POST "http://localhost:${BACKEND_PORT}/otlp/v1/traces" \
  -H "content-type: application/json" \
  -H "x-nora-agent-id: ${AGENT_ID}" \
  -H "x-nora-ingest-key: ${INGEST_KEY}" \
  --data-binary "$PAYLOAD")"
post_body="$(cat /tmp/infra-test-otlp-post-response.$$ 2>/dev/null)"
rm -f /tmp/infra-test-otlp-post-response.$$
log_info "POST status=$post_status body=$post_body"
if [ "$post_status" != "202" ]; then
  test_fail "expected 202 Accepted for a real, correctly-authenticated OTLP export, got $post_status ($post_body) — cannot proceed to the crash/restart assertion"
  exit 0
fi

log_step "brief window for the span-ingest worker to pick the job up as ACTIVE (best-effort — see this script's header on why the exact interleaving can't be forced), then SIGKILL worker-provisioner"
sleep 1
compose kill -s SIGKILL worker-provisioner >/dev/null

sleep 3
log_step "restarting worker-provisioner"
compose up -d worker-provisioner >/dev/null
if ! wait_for_healthy worker-provisioner 60; then
  test_fail "worker-provisioner did not become healthy again within 60s after the crash"
  exit 0
fi

log_step "waiting up to ~100s for the job to (re)drain — covers a normal same-run completion AND BullMQ's default ~30s lock + ~30s stalled-check redelivery cycle if the job was genuinely mid-flight when killed"
waited=0
count=-1
stable_polls=0
while [ "$waited" -lt 100 ]; do
  new_count="$(db_query "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${AGENT_ID}';")"
  if [ "$new_count" -eq "$count" ] && [ "$new_count" -gt 0 ]; then
    stable_polls=$((stable_polls + 1))
    # Two consecutive stable reads ~10s apart: good enough evidence nothing
    # is still in flight (a redelivered duplicate insert would show up as
    # another jump, not a quiet plateau).
    if [ "$stable_polls" -ge 2 ]; then
      count="$new_count"
      break
    fi
  else
    stable_polls=0
  fi
  count="$new_count"
  sleep 10
  waited=$((waited + 10))
done
log_info "final agent_spans count for this agent after ${waited}s: $count"

distinct_span_ids="$(db_query "SELECT COUNT(DISTINCT span_id) FROM agent_spans WHERE agent_id = '${AGENT_ID}';")"
log_info "distinct span_ids=$distinct_span_ids (sent $SPAN_COUNT)"

if [ "$count" -eq 0 ]; then
  test_fail "zero spans landed in agent_spans after the crash/restart — the batch was lost outright (accepted with 202, but never drained). Check the span-ingest BullMQ queue/worker wiring."
elif [ "$count" -lt "$SPAN_COUNT" ]; then
  test_fail "only $count of $SPAN_COUNT sent spans landed — spans were lost across the crash/restart (job not requeued, or requeued and partially failed with no further retry)"
elif [ "$count" -gt "$SPAN_COUNT" ] || [ "$distinct_span_ids" -lt "$count" ]; then
  test_fail "found $count rows ($distinct_span_ids distinct span_id) for $SPAN_COUNT spans sent once — the batch was inserted more than once. This matches the exact real-bug risk flagged in this script's header: spanDrain.ts's batchInsertSpans has no ON CONFLICT and agent_spans has no UNIQUE(trace_id, span_id) constraint, so a BullMQ stalled-job redelivery after the SIGKILL duplicate-inserted the same batch. See this directory's README for whether this was actually observed on this run."
else
  test_pass "exactly $count/$SPAN_COUNT spans landed, all with distinct span_id — a worker-provisioner crash near the drain lost nothing and double-inserted nothing on this run"
fi
