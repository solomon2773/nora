#!/usr/bin/env bash
# Phase 14, test 3: `helm template infra/helm/nora` renders cleanly with
# both an s3 and an r2 log-storage configuration.
#
# Cheapest test in this phase per the README — no cluster, no auth, no
# docker compose at all, just a client-side `helm template` invocation
# twice. Doesn't touch the running dev stack, so unlike phase5c's scripts
# this one is safe to run repeatedly without any cross-worktree collision
# risk (see deletion-recovery/README.md's "Blocked on" section for
# why that risk is real for anything that touches `docker compose`).
#
# Every required chart value (`secrets.*`) is supplied with throwaway
# dummy values purely to get past those unrelated `fail` guards
# (`infra/helm/nora/templates/secret-env.yaml`) — none of this is ever
# actually applied to a cluster.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

require_confirmation
test_start "k8s-parity" "03-helm-renders-s3-and-r2"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHART_DIR="$REPO_ROOT/infra/helm/nora"
DUMMY_SECRETS_FILE=""

cleanup() {
  test_trap_incomplete
  [ -n "$DUMMY_SECRETS_FILE" ] && rm -f "$DUMMY_SECRETS_FILE"
}
trap cleanup EXIT

if ! command -v helm >/dev/null 2>&1; then
  test_fail "helm is not installed/on PATH — cannot render the chart"
  exit 0
fi

DUMMY_SECRETS_FILE="$(mktemp)"
cat > "$DUMMY_SECRETS_FILE" <<'EOF'
secrets:
  jwtSecret: "0000000000000000000000000000000000000000000000000000000000000000"
  encryptionKey: "1111111111111111111111111111111111111111111111111111111111111111"
  backupEncryptionKey: "2222222222222222222222222222222222222222222222222222222222222222"
  apiKeyHashSecret: "3333333333333333333333333333333333333333333333333333333333333333"
  agentHubApiKeyHashSecret: "4444444444444444444444444444444444444444444444444444444444444444"
  dbPassword: "5555555555555555555555555555555555555555555555555555555555555555"
EOF

log_step "rendering with NORA_LOG_STORAGE=s3"
s3_output="$(helm template "$CHART_DIR" -f "$DUMMY_SECRETS_FILE" \
  --set backendEnv.NORA_LOG_STORAGE=s3 \
  --set backendEnv.NORA_LOG_S3_BUCKET=infra-test-bucket \
  --set backendEnv.NORA_LOG_S3_REGION=us-east-1 \
  --set backendEnv.NORA_LOG_S3_ACCESS_KEY_ID=AKIAINFRATEST \
  --set backendEnv.NORA_LOG_S3_SECRET_ACCESS_KEY=infra-test-secret 2>&1)"
s3_status=$?
log_info "s3 render exit=$s3_status, $(echo "$s3_output" | wc -l | tr -d ' ') line(s) of output"

log_step "rendering with NORA_LOG_STORAGE=r2"
r2_output="$(helm template "$CHART_DIR" -f "$DUMMY_SECRETS_FILE" \
  --set backendEnv.NORA_LOG_STORAGE=r2 \
  --set backendEnv.NORA_LOG_R2_BUCKET=infra-test-bucket \
  --set backendEnv.NORA_LOG_R2_ENDPOINT=https://infra-test.r2.cloudflarestorage.com \
  --set backendEnv.NORA_LOG_R2_ACCESS_KEY_ID=AKIAINFRATEST \
  --set backendEnv.NORA_LOG_R2_SECRET_ACCESS_KEY=infra-test-secret 2>&1)"
r2_status=$?
log_info "r2 render exit=$r2_status, $(echo "$r2_output" | wc -l | tr -d ' ') line(s) of output"

if [ "$s3_status" -ne 0 ]; then
  test_fail "s3 render failed (exit $s3_status): $(echo "$s3_output" | tail -5)"
elif [ "$r2_status" -ne 0 ]; then
  test_fail "r2 render failed (exit $r2_status): $(echo "$r2_output" | tail -5)"
elif ! grep -q 'NORA_LOG_STORAGE: "s3"' <<<"$s3_output"; then
  test_fail "s3 render succeeded but the rendered ConfigMap does not contain NORA_LOG_STORAGE: \"s3\""
elif ! grep -q 'NORA_LOG_STORAGE: "r2"' <<<"$r2_output"; then
  test_fail "r2 render succeeded but the rendered ConfigMap does not contain NORA_LOG_STORAGE: \"r2\""
else
  test_pass "both s3 and r2 renders succeeded with the expected NORA_LOG_STORAGE value present in the rendered ConfigMap"
fi
