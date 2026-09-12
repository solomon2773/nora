#!/usr/bin/env bash
# Phase 11, test 2: a real burst of concurrent OTLP POSTs is actually
# rate-limited, not just wired in per a mocked-middleware unit assertion.
#
# routes/otlp.ts's otlpIngestLimiter is keyed by the CLAIMED agent ID
# (req.noraAgentId, set by requireIngestHeaders BEFORE verifyIngestKey ever
# runs — see that module's header), windowed by NORA_OTLP_RATE_LIMIT_WINDOW_MS
# (default 60000ms) capped at NORA_OTLP_RATE_LIMIT_MAX (default 240). This
# script reads the REAL configured values from the running container rather
# than hard-coding the defaults, so it stays correct if this stack's .env
# overrides them, then fires (max + a margin) real concurrent requests and
# confirms at least one comes back 429 — real connection-level concurrency,
# not something a mocked single-request unit test can observe.
#
# Also confirms `skip: () => IS_TEST_ENV` is NOT silently neutering this in
# the stack this script runs against: IS_TEST_ENV is `NODE_ENV === "test" ||
# JEST_WORKER_ID` — docker-compose.yml's dev services set NODE_ENV=development,
# so the real container this hits should have rate limiting genuinely
# active. This script checks that precondition explicitly rather than
# assuming it, so a false pass (0 429s because the limiter was skipped, not
# because it isn't rate-limiting) is distinguishable from a real failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "phase11-otlp-ingest" "02-concurrent-burst-rate-limited"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents

AGENT_ID=""
CONTAINER_NAME=""
TMPDIR_STATUSES=""

cleanup() {
  test_trap_incomplete
  if [ -n "$TMPDIR_STATUSES" ]; then
    rm -rf "$TMPDIR_STATUSES" 2>/dev/null || true
  fi
  if [ -n "$AGENT_ID" ]; then
    db_exec "DELETE FROM agent_spans WHERE agent_id = '${AGENT_ID}';" >/dev/null 2>&1 || true
  fi
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
}
trap cleanup EXIT

log_step "confirming this container's NODE_ENV is not 'test' (otherwise the rate limiter is deliberately skipped — see this script's header)"
node_env="$(compose exec -T backend-api printenv NODE_ENV 2>/dev/null | tr -d '[:space:]')"
log_info "backend-api NODE_ENV=$node_env"
if [ "$node_env" = "test" ]; then
  test_fail "backend-api's NODE_ENV is 'test' — otlpIngestLimiter's own skip:() => IS_TEST_ENV means this run cannot observe real rate limiting at all. Re-run against a dev-mode stack."
  exit 0
fi

log_step "reading the real configured rate limit window/max from the running container"
rate_max="$(compose exec -T backend-api printenv NORA_OTLP_RATE_LIMIT_MAX 2>/dev/null | tr -d '[:space:]')"
rate_window_ms="$(compose exec -T backend-api printenv NORA_OTLP_RATE_LIMIT_WINDOW_MS 2>/dev/null | tr -d '[:space:]')"
[ -z "$rate_max" ] && rate_max=240
[ -z "$rate_window_ms" ] && rate_window_ms=60000
log_info "rate_max=$rate_max rate_window_ms=$rate_window_ms"

# Margin above the limit: enough to comfortably guarantee at least one 429
# even accounting for the burst not landing perfectly simultaneously, but
# not so large that firing it becomes its own bottleneck on a dev laptop.
BURST_COUNT=$((rate_max + 40))
log_info "will fire $BURST_COUNT concurrent requests (limit=$rate_max + 40 margin) within the ${rate_window_ms}ms window"

log_step "provisioning a dedicated test agent and computing its real ingest key"
_AGENT_INFO="$(provision_test_agent "otlp-burst")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

# Real bug found running phase11's 01 script for the first time against a
# live stack (see its comment near the same node_call pattern): requiring
# routes/otlp.ts opens live BullMQ/ioredis connections at module scope
# (../redisQueue.ts) that keep the spawned node process alive indefinitely
# without an explicit exit — turning this instant HMAC computation into a
# 10-20 minute stall. The trailing process.exit(0) is the fix.
INGEST_KEY="$(node_call "
  const { computeIngestKey } = require('../backend-api/routes/otlp.ts');
  console.log(computeIngestKey('${AGENT_ID}'));
  process.exit(0);
")"
if [ -z "$INGEST_KEY" ]; then
  test_fail "could not compute a real ingest key via node_call — cannot proceed"
  exit 0
fi

BACKEND_PORT="${BACKEND_API_PORT:-4100}"
TMPDIR_STATUSES="$(mktemp -d)"
# An empty resourceSpans array is a valid, minimal, cheap-to-decode OTLP
# JSON payload — this test is about request-level rate limiting, not span
# content, so there is no reason to pay for building/parsing real span data
# $BURST_COUNT times over.
EMPTY_PAYLOAD='{"resourceSpans":[]}'

log_step "firing $BURST_COUNT real concurrent POSTs (backgrounded curls, collected on wait)"
i=0
while [ "$i" -lt "$BURST_COUNT" ]; do
  (
    status="$(curl -sS -o /dev/null -w '%{http_code}' \
      -X POST "http://localhost:${BACKEND_PORT}/otlp/v1/traces" \
      -H "content-type: application/json" \
      -H "x-nora-agent-id: ${AGENT_ID}" \
      -H "x-nora-ingest-key: ${INGEST_KEY}" \
      --data-binary "$EMPTY_PAYLOAD")"
    echo "$status" > "${TMPDIR_STATUSES}/${i}.status"
  ) &
  i=$((i + 1))
done
wait

ok_count=0
too_many_count=0
other_count=0
for f in "$TMPDIR_STATUSES"/*.status; do
  [ -f "$f" ] || continue
  s="$(cat "$f")"
  case "$s" in
    202) ok_count=$((ok_count + 1)) ;;
    429) too_many_count=$((too_many_count + 1)) ;;
    *) other_count=$((other_count + 1)); log_warn "unexpected status $s from $f" ;;
  esac
done
total_observed=$((ok_count + too_many_count + other_count))
log_info "results: 202=$ok_count 429=$too_many_count other=$other_count (total observed=$total_observed of $BURST_COUNT fired)"

if [ "$total_observed" -lt "$BURST_COUNT" ]; then
  log_warn "$(($BURST_COUNT - total_observed)) request(s) never produced a captured status file — a curl process may have failed outright (connection refused/reset) rather than completing with an HTTP status; treating this as informational, not a hard failure of the rate-limit assertion below"
fi

if [ "$too_many_count" -eq 0 ]; then
  test_fail "sent $BURST_COUNT concurrent requests against a configured limit of $rate_max/${rate_window_ms}ms and got ZERO 429s ($ok_count accepted, $other_count other) — the rate limiter did not engage under real concurrency"
elif [ "$ok_count" -eq 0 ]; then
  test_fail "ALL $too_many_count observed requests came back 429 — either the limit is far lower than $rate_max in practice, or every request landed after the bucket was already exhausted by something else (e.g. leftover state from a previous run within the same window); re-run in isolation if this looks like the latter"
else
  test_pass "real concurrent burst was rate-limited as configured: $ok_count accepted (202), $too_many_count rejected (429) against a configured limit of $rate_max/${rate_window_ms}ms"
fi
