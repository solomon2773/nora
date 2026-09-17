#!/usr/bin/env bash
# Phase 12, test 2: after the live tracing-config merge, real spans land in
# `agent_spans` via the real OTLP ingest path, attributed to agent5's real
# agent id.
#
# REAL FINDING FROM RUNNING THIS TEST (documented, not worked around):
# a genuine OpenClaw-triggered span could NOT be produced, and the root
# cause is not a bug in Nora's own code — it's upstream, inside the
# installed OpenClaw runtime image itself:
#
#   1. agent5's diagnostics.otel config was confirmed live (01-live-merge-
#      no-restart.sh), `openclaw config get diagnostics` / `openclaw config
#      validate` both confirm the file is read and schema-valid, and the
#      schema (`openclaw config schema`) confirms every field
#      agentTracing.ts's buildTracingConfigDelta sends
#      (tracesEndpoint/protocol/headers/sampleRate/captureContent) matches
#      exactly what OpenClaw 2026.6.11 expects.
#   2. A real chat.send turn was fired at agent5 (nvidia/nemotron-3, a real
#      configured API key, confirmed via a real 200 response from
#      integrate.api.nvidia.com in the container's own logs).
#   3. Temporarily instrumenting backend-api's real POST /otlp/v1/traces
#      handler (reverted immediately after, via `git checkout`) proved ZERO
#      requests ever reached it — not even a malformed/unauthenticated one
#      — across three separate chat turns, including one right after a
#      full real container restart (ruling out "needs a restart" as the
#      cause too).
#   4. Reading the actual installed OpenClaw package
#      (/usr/local/lib/node_modules/openclaw/dist/*.js inside the
#      container) shows `tracesEndpoint`/`otlp/v1/traces` appear ONLY in
#      the config-schema/validation files (runtime-schema-*.js,
#      zod-schema-*.js) — there is no `@opentelemetry/*` package under
#      node_modules, and no NodeSDK/BatchSpanProcessor/OTLPTraceExporter/
#      exportSpans code anywhere in dist. The `diagnostics.otel.*` config
#      surface is fully schema-validated and accepted by this build, but
#      this build contains no OTel exporter implementation at all — the
#      config is a real, valid no-op in openclaw@2026.6.11.
#
# This means row 2 of this phase's matrix cannot be proven with a genuine
# agent-generated span against this stack's current OpenClaw version, for
# a reason entirely outside backend-api/agentTracing.ts's control. Per the
# task briefing's own fallback guidance, this script instead proves the
# REAL ingest path (real HMAC-signed POST, real auth, real enqueue, real
# drain) works end-to-end for agent5's real agent id — the same technique
# Phase 11's 01-worker-crash-midbatch.sh already validated generically —
# and separately re-confirms the live config really is reachable, so this
# is a documented upstream blocker rather than a silently faked pass.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "agent-trace-enablement" "02-real-span-ingest"

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
  if [ -n "$AGENT_ID" ]; then
    db_exec "DELETE FROM agent_spans WHERE agent_id = '${AGENT_ID}';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log_step "confirming agent5's live diagnostics.otel config is enabled and schema-valid (reachability half of this test)"
config_json="$(docker exec "$CONTAINER_NAME" sh -c 'cat /root/.openclaw/openclaw.json 2>/dev/null')"
if ! echo "$config_json" | grep -q '"enabled": true'; then
  test_fail "agent5's diagnostics.otel is not enabled — run 01-live-merge-no-restart.sh first"
  exit 0
fi
validate_out="$(docker exec "$CONTAINER_NAME" sh -c 'openclaw config validate 2>&1')"
log_info "openclaw config validate: ${validate_out}"
if ! echo "$validate_out" | grep -qi "valid"; then
  test_fail "openclaw itself does not consider the current config valid: ${validate_out}"
  exit 0
fi

pre_count="$(db_query "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${AGENT_ID}';")"
if [ "$pre_count" -ne 0 ]; then
  test_fail "expected zero agent_spans rows before sending anything, found $pre_count — a prior run's debris wasn't cleaned up"
  exit 0
fi

log_step "attempting the stronger proof first: a genuine agent-triggered span via a real chat.send turn (real nvidia:default API key, direct gatewayRpc.ts client)"
resp="$(node_call "
  const { createGatewayClient } = require('/agent-runtime/lib/gatewayRpc.ts');
  const db = require('/backend-api/db.ts');
  const crypto = require('/backend-api/crypto.ts');
  (async () => {
    const r = await db.query('SELECT id, host, runtime_host, runtime_port, gateway_host, gateway_port, gateway_token FROM agents WHERE id=\$1', ['${AGENT_ID}']);
    const agent = r.rows[0];
    const token = crypto.decrypt(agent.gateway_token);
    const client = createGatewayClient(agent, { token });
    const out = await client.call('chat.send', { sessionKey: 'infra-test-span-trigger', idempotencyKey: require('crypto').randomUUID(), message: 'say hi' });
    console.log(JSON.stringify(out));
    client.close();
    process.exit(0);
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
" 2>&1)"
log_info "chat.send response: ${resp}"

log_step "waiting up to 30s for a genuine span to land (documented as unlikely — see this script's header for why — but checked honestly rather than assumed)"
waited=0
genuine_count=0
while [ "$waited" -lt 30 ]; do
  genuine_count="$(db_query "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${AGENT_ID}';")"
  if [ -n "$genuine_count" ] && [ "$genuine_count" != "0" ]; then
    break
  fi
  sleep 5
  waited=$((waited + 5))
done

if [ "$genuine_count" != "0" ]; then
  test_pass "${genuine_count} GENUINE agent-generated span row(s) landed for agent5 via the real OTLP ingest path after a live chat turn"
  exit 0
fi

log_warn "no genuine span landed within ${waited}s, consistent with this session's finding that the installed OpenClaw build (2026.6.11) has no OTel exporter implementation despite accepting/validating the diagnostics.otel config shape (see this script's header) — falling back to the task briefing's documented fallback: a real HMAC-signed OTLP POST via the real ingest path, attributed to agent5's real agent id"

log_step "computing agent5's real ingest key (routes/otlp.ts's own computeIngestKey) and building a real OTLP/JSON span batch, via node_call so this exactly mirrors production code"
_INGEST_INFO="$(node_call "
  const { computeIngestKey } = require('../backend-api/routes/otlp.ts');
  const crypto = require('crypto');
  console.log(computeIngestKey('${AGENT_ID}'));
  const now = Date.now();
  const payload = {
    resourceSpans: [{
      resource: { attributes: [] },
      scopeSpans: [{
        scope: {},
        spans: [{
          traceId: crypto.randomBytes(16).toString('base64'),
          spanId: crypto.randomBytes(8).toString('base64'),
          name: 'infra-test-phase12-fallback-span',
          kind: 'SPAN_KIND_INTERNAL',
          startTimeUnixNano: String(now * 1e6),
          endTimeUnixNano: String((now + 5) * 1e6),
          status: { code: 'STATUS_CODE_OK' },
          attributes: [],
        }],
      }],
    }],
  };
  console.log(JSON.stringify(payload));
  process.exit(0);
")"
INGEST_KEY="$(echo "$_INGEST_INFO" | sed -n '1p')"
PAYLOAD="$(echo "$_INGEST_INFO" | sed -n '2p')"
if [ -z "$INGEST_KEY" ] || [ -z "$PAYLOAD" ]; then
  test_fail "node_call did not produce an ingest key and/or payload — cannot proceed"
  exit 0
fi

BACKEND_PORT="${BACKEND_API_PORT:-4100}"
log_step "POSTing the real batch to backend-api's real, non-nginx-proxied /otlp/v1/traces endpoint"
post_status="$(curl -sS -o /tmp/infra-test-otlp-p12-response.$$ -w '%{http_code}' \
  -X POST "http://localhost:${BACKEND_PORT}/otlp/v1/traces" \
  -H "content-type: application/json" \
  -H "x-nora-agent-id: ${AGENT_ID}" \
  -H "x-nora-ingest-key: ${INGEST_KEY}" \
  --data-binary "$PAYLOAD")"
post_body="$(cat /tmp/infra-test-otlp-p12-response.$$ 2>/dev/null)"
rm -f /tmp/infra-test-otlp-p12-response.$$
log_info "POST status=$post_status body=$post_body"
if [ "$post_status" != "202" ]; then
  test_fail "expected 202 Accepted for a real, correctly-authenticated OTLP export against agent5's real ingest key, got $post_status ($post_body)"
  exit 0
fi

fallback_count="$(db_query_until_nonzero "SELECT COUNT(*) FROM agent_spans WHERE agent_id = '${AGENT_ID}';" 8 3)"
if [ -z "$fallback_count" ] || [ "$fallback_count" = "0" ]; then
  test_fail "the real ingest path (auth -> enqueue -> drain) did not land a row in agent_spans for agent5 even for the synthetic-but-real-HMAC fallback batch — this IS a real ingest-path bug, distinct from the documented OpenClaw exporter gap above"
  exit 0
fi

test_pass "config confirmed live+reachable (openclaw config validate: valid, diagnostics.otel.enabled=true); genuine OpenClaw span export not achievable — installed openclaw@2026.6.11 has no OTel exporter implementation despite validating the config shape (see script header); fallback real-HMAC OTLP POST landed ${fallback_count} row(s) in agent_spans for agent5, proving the real ingest path itself works end-to-end for this agent"
