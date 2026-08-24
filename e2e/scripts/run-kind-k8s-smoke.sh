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
NORA_K8S_NAMESPACE="${NORA_K8S_NAMESPACE:-openclaw-agents}"
KIND_API_PORT="${KIND_API_PORT:-4110}"
KIND_CONTROL_PLANE_HOST="${KIND_CONTROL_PLANE_HOST:-${KIND_CLUSTER_NAME}-control-plane}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:${KIND_API_PORT}}"
CALICO_VERSION="${CALICO_VERSION:-v3.32.0}"

export KIND_CLUSTER_NAME
export KUBECONFIG_PATH
export CONTAINER_KUBECONFIG_PATH
export NORA_KUBECONFIGS_DIR="${NORA_KUBECONFIGS_DIR:-$(dirname "$CONTAINER_KUBECONFIG_PATH")}"
export COMPOSE_PROJECT_NAME
export NORA_ENV_FILE
export NORA_K8S_CLUSTER_ID="${NORA_K8S_CLUSTER_ID:-kind-local}"
export NORA_K8S_CLUSTER_LABEL="${NORA_K8S_CLUSTER_LABEL:-Kind Local}"
export NORA_K8S_CLUSTER_NAME="${NORA_K8S_CLUSTER_NAME:-$KIND_CLUSTER_NAME}"
export NORA_K8S_PROVIDER="${NORA_K8S_PROVIDER:-kubernetes}"
export NORA_K8S_KUBECONFIG_PATH="${NORA_K8S_KUBECONFIG_PATH:-/kubeconfigs/$(basename "$CONTAINER_KUBECONFIG_PATH")}"
export NORA_K8S_NAMESPACE
export NORA_K8S_OPENCLAW_NAMESPACE="${NORA_K8S_OPENCLAW_NAMESPACE:-$NORA_K8S_NAMESPACE}"
export NORA_K8S_HERMES_NAMESPACE="${NORA_K8S_HERMES_NAMESPACE:-$NORA_K8S_NAMESPACE}"
export NORA_K8S_EXPOSURE_MODE="${NORA_K8S_EXPOSURE_MODE:-node-port}"
export NORA_K8S_RUNTIME_NODE_PORT="${NORA_K8S_RUNTIME_NODE_PORT:-30909}"
export NORA_K8S_GATEWAY_NODE_PORT="${NORA_K8S_GATEWAY_NODE_PORT:-31879}"
export K8S_SMOKE_RUNTIME_FAMILIES="${K8S_SMOKE_RUNTIME_FAMILIES:-openclaw,hermes}"
export API_BASE_URL
export KIND_API_PORT
export KIND_CONTROL_PLANE_HOST
export BACKEND_API_PORT="${BACKEND_API_PORT:-$KIND_API_PORT}"
export POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-55433}"

KIND_BIN="${KIND_BIN:-$NORA_KIND_BIN}"
KUBECTL_BIN="${KUBECTL_BIN:-$NORA_KUBECTL_BIN}"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.kubernetes.yml -f docker-compose.kind.yml)
COMPOSE_ARGS=(--env-file "$NORA_ENV_FILE" "${COMPOSE_FILES[@]}")

cleanup() {
  if [[ "${KEEP_ENV:-false}" == "true" ]]; then
    return
  fi

  docker compose "${COMPOSE_ARGS[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
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
sed -E -i.bak \
  "s#server: https://[^[:space:]]+#server: https://${KIND_CONTROL_PLANE_HOST}:6443#" \
  "$CONTAINER_KUBECONFIG_PATH"
rm -f "${CONTAINER_KUBECONFIG_PATH}.bak"

export KUBECONFIG="$KUBECONFIG_PATH"
"$KUBECTL_BIN" cluster-info >/dev/null

if ! "$KUBECTL_BIN" get daemonset calico-node -n kube-system >/dev/null 2>&1; then
  "$KUBECTL_BIN" apply -f \
    "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"
fi

"$KUBECTL_BIN" rollout status daemonset/calico-node -n kube-system --timeout=300s >/dev/null
"$KUBECTL_BIN" rollout status deployment/calico-kube-controllers -n kube-system --timeout=300s >/dev/null

# Build the OpenClaw agent image and load it into the node.
#
# Kubernetes' agent-image default is a bare node:24-slim (see
# agent-runtime/lib/agentImages.ts) — unlike Docker, which defaults to the
# prebuilt nora-openclaw-agent:local. A bare Node image sends the runtime
# bootstrap down its install-from-npm path, which Dockerfile.openclaw-agent
# documents as 5+ minutes to first readiness versus ~30s with openclaw and tsx
# baked in. The provisioner's readiness check gives up long before that, so
# every agent stalls in `deploying`, the Service never gets endpoints (an
# unready pod is not an endpoint), and the smoke times out looking like a
# node-port routing problem when it is really a cold-start one.
#
# kind load puts the image on the node so the pod resolves it without a
# registry; the tag is not :latest, so the default IfNotPresent pull policy
# uses it rather than trying to fetch.
AGENT_IMAGE="${NORA_K8S_SMOKE_AGENT_IMAGE:-nora-openclaw-agent:local}"
if [[ "${NORA_K8S_SMOKE_BUILD_AGENT_IMAGE:-true}" == "true" ]]; then
  echo "Building ${AGENT_IMAGE} for the kind smoke."
  docker build \
    -f "$ROOT_DIR/agent-runtime/Dockerfile.openclaw-agent" \
    -t "$AGENT_IMAGE" \
    "$ROOT_DIR/agent-runtime/"
fi
echo "Loading ${AGENT_IMAGE} into kind cluster ${KIND_CLUSTER_NAME}."
"$KIND_BIN" load docker-image "$AGENT_IMAGE" --name "$KIND_CLUSTER_NAME"
# Consumed by docker-compose.kind.yml, which forwards it to backend-api (image
# chosen when the agent row is created) and worker-provisioner (image used in
# the Deployment).
export OPENCLAW_STANDARD_IMAGE="$AGENT_IMAGE"

# Widen the provisioner's readiness budget for this run. Even with the image
# prebuilt, a first boot on a small runner can outlast the ~210s default; the
# job then fails, tears the deployment down, and the retry starts the cold boot
# over, so the agent never converges. These are forwarded to the worker by
# docker-compose.kind.yml.
export NORA_RUNTIME_READY_ATTEMPTS="${NORA_RUNTIME_READY_ATTEMPTS:-60}"
export NORA_RUNTIME_READY_INTERVAL_MS="${NORA_RUNTIME_READY_INTERVAL_MS:-5000}"
export NORA_GATEWAY_READY_ATTEMPTS="${NORA_GATEWAY_READY_ATTEMPTS:-60}"
export NORA_GATEWAY_READY_INTERVAL_MS="${NORA_GATEWAY_READY_INTERVAL_MS:-10000}"

if [[ -z "${NORA_K8S_RUNTIME_HOST:-}" ]]; then
  export NORA_K8S_RUNTIME_HOST="$(
    docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' "$KIND_CONTROL_PLANE_HOST"
  )"
fi

docker compose "${COMPOSE_ARGS[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose "${COMPOSE_ARGS[@]}" up -d --build postgres redis backend-api worker-provisioner

if [[ -z "${NORA_K8S_LOAD_BALANCER_SOURCE_RANGES:-}" ]]; then
  BACKEND_CONTAINER_IP="$(
    docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' \
      "${COMPOSE_PROJECT_NAME}-backend-api-1"
  )"
  TRUSTED_INGRESS_CIDRS=()
  if [[ -n "$BACKEND_CONTAINER_IP" ]]; then
    TRUSTED_INGRESS_CIDRS+=("${BACKEND_CONTAINER_IP}/32")
  fi
  if [[ "$NORA_K8S_RUNTIME_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && \
    [[ "$NORA_K8S_RUNTIME_HOST" != "$BACKEND_CONTAINER_IP" ]]; then
    TRUSTED_INGRESS_CIDRS+=("${NORA_K8S_RUNTIME_HOST}/32")
  fi
  export NORA_K8S_LOAD_BALANCER_SOURCE_RANGES="$(
    IFS=,
    echo "${TRUSTED_INGRESS_CIDRS[*]}"
  )"
fi

for _ in $(seq 1 120); do
  if curl -fsS "${API_BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS "${API_BASE_URL}/health" >/dev/null
"$ROOT_DIR/e2e/node_modules/.bin/tsx" "$ROOT_DIR/e2e/scripts/k8s-smoke.mts"
