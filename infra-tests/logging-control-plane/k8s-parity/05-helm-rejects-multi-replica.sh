#!/usr/bin/env bash
# Phase 14, test 5: `helm template infra/helm/nora` refuses to render with
# `workerProvisioner.replicas` above 1, citing the single-buffer-owner
# constraint.
#
# See 03-helm-renders-s3-and-r2.sh's header for why this is cheap/safe.
# The expected failure text below was copied verbatim from
# infra/helm/nora/templates/configmap-env.yaml's own `fail` guard.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

require_confirmation
test_start "k8s-parity" "05-helm-rejects-multi-replica"

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

# Exact fail-guard text from configmap-env.yaml, confirmed by reading the
# template before writing this assertion.
EXPECTED_SUBSTRING='it must stay 1'

log_step "sanity check: replicas=1 (the default) with a valid s3 config renders cleanly"
baseline_output="$(helm template "$CHART_DIR" -f "$DUMMY_SECRETS_FILE" \
  --set backendEnv.NORA_LOG_STORAGE=s3 \
  --set backendEnv.NORA_LOG_S3_BUCKET=infra-test-bucket \
  --set backendEnv.NORA_LOG_S3_REGION=us-east-1 \
  --set backendEnv.NORA_LOG_S3_ACCESS_KEY_ID=AKIAINFRATEST \
  --set backendEnv.NORA_LOG_S3_SECRET_ACCESS_KEY=infra-test-secret \
  --set workerProvisioner.replicas=1 2>&1)"
baseline_status=$?
log_info "replicas=1 baseline render exit=$baseline_status"

log_step "rendering with workerProvisioner.replicas=2"
replicas2_output="$(helm template "$CHART_DIR" -f "$DUMMY_SECRETS_FILE" \
  --set backendEnv.NORA_LOG_STORAGE=s3 \
  --set backendEnv.NORA_LOG_S3_BUCKET=infra-test-bucket \
  --set backendEnv.NORA_LOG_S3_REGION=us-east-1 \
  --set backendEnv.NORA_LOG_S3_ACCESS_KEY_ID=AKIAINFRATEST \
  --set backendEnv.NORA_LOG_S3_SECRET_ACCESS_KEY=infra-test-secret \
  --set workerProvisioner.replicas=2 2>&1)"
replicas2_status=$?
log_info "replicas=2 render exit=$replicas2_status"

if [ "$baseline_status" -ne 0 ]; then
  test_fail "replicas=1 baseline render failed unexpectedly (exit $baseline_status) — cannot trust the replicas=2 comparison below: $(echo "$baseline_output" | tail -5)"
elif [ "$replicas2_status" -eq 0 ]; then
  test_fail "render with workerProvisioner.replicas=2 succeeded (exit 0) — expected it to fail per the single-buffer-owner constraint"
elif ! grep -qF "$EXPECTED_SUBSTRING" <<<"$replicas2_output"; then
  test_fail "replicas=2 render failed as expected, but the error text doesn't cite the single-buffer-owner constraint as expected. Got: $(echo "$replicas2_output" | tail -5)"
else
  test_pass "replicas=1 renders cleanly; replicas=2 correctly fails render, citing the single-buffer-owner constraint"
fi
