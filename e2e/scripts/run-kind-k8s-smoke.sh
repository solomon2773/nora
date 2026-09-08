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

if [[ -z "${NORA_K8S_RUNTIME_HOST:-}" ]]; then
  export NORA_K8S_RUNTIME_HOST="$(
    docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' "$KIND_CONTROL_PLANE_HOST"
  )"
fi

# Logging control plane Phase 14 item 6: the Kubernetes deploy path requires
# s3/r2 (the `local` driver has no shared disk across kind nodes and is
# rejected outright per Design Decision 2d / the Helm chart guard in
# configmap-env.yaml). An in-cluster MinIO gives this smoke test a real S3
# target so a Kind-deployed agent's log collection can be asserted against
# actual segment writes, not just mocked in unit tests.
MINIO_NAMESPACE="${MINIO_NAMESPACE:-nora-minio}"
MINIO_BUCKET="${MINIO_BUCKET:-nora-logs-smoke}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-noraminio}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-noraminiosecret}"
MINIO_NODE_PORT="${MINIO_NODE_PORT:-30900}"

"$KUBECTL_BIN" create namespace "$MINIO_NAMESPACE" --dry-run=client -o yaml | "$KUBECTL_BIN" apply -f -

cat <<EOF | "$KUBECTL_BIN" apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: ${MINIO_NAMESPACE}
  labels:
    app: minio
spec:
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
        - name: minio
          image: minio/minio:RELEASE.2025-04-08T15-41-24Z
          args: ["server", "/data"]
          env:
            - name: MINIO_ROOT_USER
              value: "${MINIO_ACCESS_KEY}"
            - name: MINIO_ROOT_PASSWORD
              value: "${MINIO_SECRET_KEY}"
          ports:
            - containerPort: 9000
          readinessProbe:
            httpGet:
              path: /minio/health/ready
              port: 9000
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: ${MINIO_NAMESPACE}
spec:
  type: NodePort
  selector:
    app: minio
  ports:
    - port: 9000
      targetPort: 9000
      nodePort: ${MINIO_NODE_PORT}
EOF

"$KUBECTL_BIN" rollout status deployment/minio -n "$MINIO_NAMESPACE" --timeout=180s >/dev/null

# One-shot bucket creation via the mc client image — minio/minio itself does
# not bundle mc. Re-running `mc mb` against an already-existing bucket is a
# harmless no-op (mc returns non-zero, `|| true` absorbs it) so this step is
# safe to repeat across cluster/script re-runs.
"$KUBECTL_BIN" delete job minio-mb -n "$MINIO_NAMESPACE" --ignore-not-found=true >/dev/null 2>&1 || true
cat <<EOF | "$KUBECTL_BIN" apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-mb
  namespace: ${MINIO_NAMESPACE}
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: mc
          image: minio/mc:RELEASE.2025-04-08T15-39-49Z
          command:
            - /bin/sh
            - -c
            - |-
              set -eu
              mc alias set smoke http://minio.${MINIO_NAMESPACE}.svc.cluster.local:9000 "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}"
              mc mb --ignore-existing smoke/${MINIO_BUCKET}
EOF
"$KUBECTL_BIN" wait --for=condition=complete job/minio-mb -n "$MINIO_NAMESPACE" --timeout=120s

export NORA_K8S_LOG_STORAGE_ENDPOINT="http://${NORA_K8S_RUNTIME_HOST}:${MINIO_NODE_PORT}"
export K8S_SMOKE_ASSERT_LOG_SEGMENTS="true"

# Layer the S3/MinIO log-storage settings onto the smoke run's own env file
# rather than mutating the caller's $NORA_ENV_FILE in place — same
# not-mutating-the-input convention docker-entrypoint-style overlays use
# elsewhere in this repo. `docker compose --env-file` only affects variable
# interpolation IN the compose YAML; the values a service actually sees come
# from its own `env_file:` entry (docker-compose.yml's
# `env_file: - ${NORA_ENV_FILE:-.env}`), so this is what needs to grow.
LOG_STORAGE_ENV_FILE="$(mktemp)"
cp "$NORA_ENV_FILE" "$LOG_STORAGE_ENV_FILE"
{
  echo "NORA_LOG_STORAGE=s3"
  echo "NORA_LOG_S3_BUCKET=${MINIO_BUCKET}"
  echo "NORA_LOG_S3_REGION=us-east-1"
  echo "NORA_LOG_S3_ENDPOINT=${NORA_K8S_LOG_STORAGE_ENDPOINT}"
  echo "NORA_LOG_S3_ACCESS_KEY_ID=${MINIO_ACCESS_KEY}"
  echo "NORA_LOG_S3_SECRET_ACCESS_KEY=${MINIO_SECRET_KEY}"
} >>"$LOG_STORAGE_ENV_FILE"
export NORA_ENV_FILE="$LOG_STORAGE_ENV_FILE"
COMPOSE_ARGS=(--env-file "$NORA_ENV_FILE" "${COMPOSE_FILES[@]}")

cleanup_log_storage_env_file() {
  rm -f "$LOG_STORAGE_ENV_FILE"
}
trap 'cleanup_log_storage_env_file; cleanup' EXIT INT TERM

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
