#!/usr/bin/env bash
# Phase 14, test 4: `helm template infra/helm/nora` refuses to render with
# `NORA_LOG_STORAGE=local` (or unset, which defaults to `local`), and the
# error names the unsupported combination.
#
# See 03-helm-renders-s3-and-r2.sh's header for why this is cheap/safe
# (no cluster, no docker compose, no cross-worktree collision risk). The
# expected failure text below was copied verbatim from
# infra/helm/nora/templates/configmap-env.yaml's own `fail` guard, not
# guessed — read that file first, this assertion checks against the real
# message.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

require_confirmation
test_start "k8s-parity" "04-helm-rejects-local-storage"

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

# Exact fail-guard text from configmap-env.yaml (the "not \"local\"..."
# wording), confirmed by reading the template before writing this
# assertion.
EXPECTED_SUBSTRING='must not be "local" (or unset, which defaults to "local") for the Helm deployment'

log_step "rendering with NORA_LOG_STORAGE unset (the application default, which is 'local')"
unset_output="$(helm template "$CHART_DIR" -f "$DUMMY_SECRETS_FILE" 2>&1)"
unset_status=$?
log_info "unset render exit=$unset_status"

log_step "rendering with NORA_LOG_STORAGE explicitly set to 'local'"
local_output="$(helm template "$CHART_DIR" -f "$DUMMY_SECRETS_FILE" --set backendEnv.NORA_LOG_STORAGE=local 2>&1)"
local_status=$?
log_info "explicit-local render exit=$local_status"

if [ "$unset_status" -eq 0 ]; then
  test_fail "render with NORA_LOG_STORAGE unset succeeded (exit 0) — expected it to fail per Design Decision 2d"
elif [ "$local_status" -eq 0 ]; then
  test_fail "render with NORA_LOG_STORAGE=local succeeded (exit 0) — expected it to fail per Design Decision 2d"
elif ! grep -qF "$EXPECTED_SUBSTRING" <<<"$unset_output"; then
  test_fail "unset render failed as expected, but the error text doesn't name the unsupported combination as expected. Got: $(echo "$unset_output" | tail -5)"
elif ! grep -qF "$EXPECTED_SUBSTRING" <<<"$local_output"; then
  test_fail "explicit-local render failed as expected, but the error text doesn't name the unsupported combination as expected. Got: $(echo "$local_output" | tail -5)"
else
  test_pass "both unset and explicit NORA_LOG_STORAGE=local renders correctly fail render, citing the unsupported local-on-Kubernetes combination"
fi
