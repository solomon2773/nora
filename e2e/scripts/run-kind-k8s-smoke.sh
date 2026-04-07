#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-nora-kind}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-/tmp/${KIND_CLUSTER_NAME}.kubeconfig}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-nora-kind}"
NORA_ENV_FILE="${NORA_ENV_FILE:-.env.test}"
K8S_NAMESPACE="${K8S_NAMESPACE:-openclaw-agents}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:4100}"

export KIND_CLUSTER_NAME
export KUBECONFIG_PATH
export COMPOSE_PROJECT_NAME
export NORA_ENV_FILE
export K8S_NAMESPACE
export API_BASE_URL
export K8S_EXPOSURE_MODE="${K8S_EXPOSURE_MODE:-node-port}"
export K8S_RUNTIME_NODE_PORT="${K8S_RUNTIME_NODE_PORT:-30909}"
export K8S_GATEWAY_NODE_PORT="${K8S_GATEWAY_NODE_PORT:-31879}"
export K8S_RUNTIME_HOST="${K8S_RUNTIME_HOST:-host.docker.internal}"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.kind.yml)

cleanup() {
  if [[ "${KEEP_ENV:-false}" == "true" ]]; then
    return
  fi

  docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  kind delete cluster --name "$KIND_CLUSTER_NAME" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG_PATH"
}

trap cleanup EXIT INT TERM

if ! kind get clusters | grep -qx "$KIND_CLUSTER_NAME"; then
  kind create cluster \
    --name "$KIND_CLUSTER_NAME" \
    --config "$ROOT_DIR/infra/kind/nora-kind.yaml" \
    --wait 120s \
    --kubeconfig "$KUBECONFIG_PATH"
else
  kind export kubeconfig --name "$KIND_CLUSTER_NAME" --kubeconfig "$KUBECONFIG_PATH"
fi

export KUBECONFIG="$KUBECONFIG_PATH"
kubectl cluster-info >/dev/null

docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose "${COMPOSE_FILES[@]}" up -d --build postgres redis backend-api worker-provisioner

for _ in $(seq 1 120); do
  if curl -fsS "${API_BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS "${API_BASE_URL}/health" >/dev/null
node "$ROOT_DIR/e2e/scripts/k8s-smoke.mjs"
