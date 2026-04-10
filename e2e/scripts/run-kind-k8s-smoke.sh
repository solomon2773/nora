#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/e2e/scripts/ensure-kind-tools.sh"

KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-nora-kind}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-/tmp/${KIND_CLUSTER_NAME}.kubeconfig}"
CONTAINER_KUBECONFIG_PATH="${CONTAINER_KUBECONFIG_PATH:-/tmp/${KIND_CLUSTER_NAME}.container.kubeconfig}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-nora-kind}"
NORA_ENV_FILE="${NORA_ENV_FILE:-.env.test}"
K8S_NAMESPACE="${K8S_NAMESPACE:-openclaw-agents}"
KIND_API_PORT="${KIND_API_PORT:-4110}"
KIND_CONTROL_PLANE_HOST="${KIND_CONTROL_PLANE_HOST:-${KIND_CLUSTER_NAME}-control-plane}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:${KIND_API_PORT}}"

export KIND_CLUSTER_NAME
export KUBECONFIG_PATH
export CONTAINER_KUBECONFIG_PATH
export COMPOSE_PROJECT_NAME
export NORA_ENV_FILE
export K8S_NAMESPACE
export API_BASE_URL
export KIND_API_PORT
export KIND_CONTROL_PLANE_HOST
export BACKEND_API_PORT="${BACKEND_API_PORT:-$KIND_API_PORT}"
export K8S_EXPOSURE_MODE="${K8S_EXPOSURE_MODE:-node-port}"
export K8S_RUNTIME_NODE_PORT="${K8S_RUNTIME_NODE_PORT:-30909}"
export K8S_GATEWAY_NODE_PORT="${K8S_GATEWAY_NODE_PORT:-31879}"
export K8S_RUNTIME_HOST="${K8S_RUNTIME_HOST:-$KIND_CONTROL_PLANE_HOST}"

KIND_BIN="${KIND_BIN:-$NORA_KIND_BIN}"
KUBECTL_BIN="${KUBECTL_BIN:-$NORA_KUBECTL_BIN}"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.kind.yml)

cleanup() {
  if [[ "${KEEP_ENV:-false}" == "true" ]]; then
    return
  fi

  docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  "$KIND_BIN" delete cluster --name "$KIND_CLUSTER_NAME" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG_PATH" "$CONTAINER_KUBECONFIG_PATH"
}

trap cleanup EXIT INT TERM

if ! "$KIND_BIN" get clusters | grep -qx "$KIND_CLUSTER_NAME"; then
  "$KIND_BIN" create cluster \
    --name "$KIND_CLUSTER_NAME" \
    --config "$ROOT_DIR/infra/kind/nora-kind.yaml" \
    --wait 120s \
    --kubeconfig "$KUBECONFIG_PATH"
else
  "$KIND_BIN" export kubeconfig --name "$KIND_CLUSTER_NAME" --kubeconfig "$KUBECONFIG_PATH"
fi

cp "$KUBECONFIG_PATH" "$CONTAINER_KUBECONFIG_PATH"
sed -Ei \
  "s#server: https://[^[:space:]]+#server: https://${KIND_CONTROL_PLANE_HOST}:6443#" \
  "$CONTAINER_KUBECONFIG_PATH"

export KUBECONFIG="$KUBECONFIG_PATH"
"$KUBECTL_BIN" cluster-info >/dev/null

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
