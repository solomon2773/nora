#!/usr/bin/env bash
# Manual smoke test: install the Nora chart on a local Kind cluster, wait for
# the stack to go Ready, and probe the edge. Mirrors what a first-time
# `helm install` user experiences. Requires: kind, kubectl, helm, openssl.
#
# Usage: infra/helm/scripts/kind-smoke.sh [--keep]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLUSTER_NAME="nora-helm-smoke"
NAMESPACE="nora"
KEEP="${1:-}"

cleanup() {
  if [ "$KEEP" != "--keep" ]; then
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  else
    echo "Cluster kept: kind export kubeconfig --name $CLUSTER_NAME"
  fi
}
trap cleanup EXIT

echo "==> Creating Kind cluster ($CLUSTER_NAME)"
kind create cluster --name "$CLUSTER_NAME" --config "$REPO_ROOT/infra/kind/nora-kind.yaml" --wait 120s

echo "==> Installing chart"
helm install nora "$REPO_ROOT/infra/helm/nora" \
  --namespace "$NAMESPACE" --create-namespace \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set secrets.encryptionKey="$(openssl rand -hex 32)" \
  --set secrets.backupEncryptionKey="$(openssl rand -hex 32)" \
  --set secrets.apiKeyHashSecret="$(openssl rand -hex 32)" \
  --set secrets.agentHubApiKeyHashSecret="$(openssl rand -hex 32)" \
  --set secrets.dbPassword="$(openssl rand -hex 24)" \
  --wait --timeout 10m

echo "==> Pods"
kubectl -n "$NAMESPACE" get pods

echo "==> Probing the edge through nora-nginx"
kubectl -n "$NAMESPACE" port-forward svc/nora-nginx 18080:80 >/dev/null 2>&1 &
PF_PID=$!
sleep 3

fail=0
probe() {
  local path="$1" expect="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:18080$path")
  if [ "$code" = "$expect" ]; then
    echo "  OK  $path -> $code"
  else
    echo "  FAIL $path -> $code (expected $expect)"
    fail=1
  fi
}

probe "/api/health" "200"
probe "/" "200"
probe "/app" "200"
probe "/admin" "200"

kill "$PF_PID" >/dev/null 2>&1 || true

if [ "$fail" -ne 0 ]; then
  echo "Smoke test FAILED"
  exit 1
fi
echo "Smoke test passed."
