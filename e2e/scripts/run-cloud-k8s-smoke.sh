#!/usr/bin/env bash
# Run the Kubernetes adapter lifecycle smoke against an operator-supplied cluster.
#
# Works for K3s, AKS, GKE, and EKS — they all share the same k8s adapter, so this
# script just expects a working KUBECONFIG and the generic Kubernetes Compose overlay.
#
# Required:
#   KUBECONFIG_PATH       Host path to a kubeconfig the Compose stack can mount.
#
# Optional:
#   COMPOSE_OVERLAY       Defaults to docker-compose.kubernetes.yml.
#   API_BASE_URL          Defaults to http://127.0.0.1:8080/api
#   NORA_K8S_PROVIDER     k3s, aks, gke, eks, or kubernetes.
#   NORA_K8S_NAMESPACE    Defaults to openclaw-agents.
#   KUBECTL_BIN           Defaults to kubectl.
#   K8S_SMOKE_RUNTIME_FAMILIES
#                         Comma-separated runtime families to deploy.
#                         Defaults to openclaw in the script; smoke:k8s-aks
#                         defaults to openclaw,hermes.
#   K8S_SMOKE_CELLS       Optional runtime:sandbox pairs. Example:
#                         openclaw:standard,openclaw:nemoclaw,hermes:standard.
#                         NemoClaw cells require NVIDIA_API_KEY.
#   CONTAINER_KUBECONFIG_PATH
#                         Defaults to KUBECONFIG_PATH (use this when the API server
#                         URL in the kubeconfig differs between host and containers).
#   KEEP_ENV=true         Leave the Compose stack running after the smoke completes.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

: "${KUBECONFIG_PATH:?KUBECONFIG_PATH is required}"
if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  echo "KUBECONFIG_PATH does not exist: $KUBECONFIG_PATH" >&2
  exit 1
fi

COMPOSE_OVERLAY="${COMPOSE_OVERLAY:-docker-compose.kubernetes.yml}"
if [[ ! -f "$COMPOSE_OVERLAY" ]]; then
  echo "COMPOSE_OVERLAY does not exist: $COMPOSE_OVERLAY" >&2
  exit 1
fi

CONTAINER_KUBECONFIG_PATH="${CONTAINER_KUBECONFIG_PATH:-$KUBECONFIG_PATH}"
if [[ ! -f "$CONTAINER_KUBECONFIG_PATH" ]]; then
  echo "CONTAINER_KUBECONFIG_PATH does not exist: $CONTAINER_KUBECONFIG_PATH" >&2
  exit 1
fi
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8080/api}"
NORA_K8S_NAMESPACE="${NORA_K8S_NAMESPACE:-openclaw-agents}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
DEFAULT_PROVIDER="${NORA_K8S_PROVIDER:-kubernetes}"

case "$DEFAULT_PROVIDER" in
  k3s)
    DEFAULT_PROVIDER="k3s"
    DEFAULT_LABEL="K3s Smoke"
    DEFAULT_EXPOSURE="node-port"
    ;;
  aks)
    DEFAULT_PROVIDER="aks"
    DEFAULT_LABEL="AKS Smoke"
    DEFAULT_EXPOSURE="load-balancer"
    ;;
  gke)
    DEFAULT_PROVIDER="gke"
    DEFAULT_LABEL="GKE Smoke"
    DEFAULT_EXPOSURE="load-balancer"
    ;;
  eks)
    DEFAULT_PROVIDER="eks"
    DEFAULT_LABEL="EKS Smoke"
    DEFAULT_EXPOSURE="load-balancer"
    ;;
  *)
    DEFAULT_PROVIDER="kubernetes"
    DEFAULT_LABEL="Kubernetes Smoke"
    DEFAULT_EXPOSURE="load-balancer"
    ;;
esac

export NORA_KUBECONFIGS_DIR="${NORA_KUBECONFIGS_DIR:-$(dirname "$CONTAINER_KUBECONFIG_PATH")}"
export API_BASE_URL
export NORA_K8S_CLUSTER_ID="${NORA_K8S_CLUSTER_ID:-${DEFAULT_PROVIDER}-smoke}"
export NORA_K8S_CLUSTER_LABEL="${NORA_K8S_CLUSTER_LABEL:-$DEFAULT_LABEL}"
export NORA_K8S_CLUSTER_NAME="${NORA_K8S_CLUSTER_NAME:-$NORA_K8S_CLUSTER_ID}"
export NORA_K8S_PROVIDER="${NORA_K8S_PROVIDER:-$DEFAULT_PROVIDER}"
export NORA_K8S_KUBECONFIG_PATH="${NORA_K8S_KUBECONFIG_PATH:-/kubeconfigs/$(basename "$CONTAINER_KUBECONFIG_PATH")}"
export NORA_K8S_NAMESPACE
export NORA_K8S_OPENCLAW_NAMESPACE="${NORA_K8S_OPENCLAW_NAMESPACE:-$NORA_K8S_NAMESPACE}"
export NORA_K8S_HERMES_NAMESPACE="${NORA_K8S_HERMES_NAMESPACE:-$NORA_K8S_NAMESPACE}"
export NORA_K8S_EXPOSURE_MODE="${NORA_K8S_EXPOSURE_MODE:-$DEFAULT_EXPOSURE}"
export NORA_K8S_RUNTIME_HOST="${NORA_K8S_RUNTIME_HOST:-host.docker.internal}"
export KUBECTL_BIN
export KUBECONFIG="$KUBECONFIG_PATH"

COMPOSE_FILES=(-f docker-compose.yml -f "$COMPOSE_OVERLAY")

cleanup() {
  if [[ "${KEEP_ENV:-false}" == "true" ]]; then
    return
  fi
  docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

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
"$ROOT_DIR/e2e/node_modules/.bin/tsx" "$ROOT_DIR/e2e/scripts/k8s-smoke.mts"
