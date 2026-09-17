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
MINIO_IMAGE="minio/minio:RELEASE.2025-04-08T15-41-24Z"
MINIO_MC_IMAGE="minio/mc:RELEASE.2025-04-08T15-39-49Z"

# Docker Hub no longer serves these exact pinned tags — confirmed directly:
# `docker pull` of either, from this host, fails with "pull access denied,
# repository does not exist" as of this writing, not a transient outage
# (docker-compose.override.yml's own `minio`/`minio-init` services pin the
# identical tags, and are affected the same way on a fresh clone with no
# locally cached image). Both are already present in this host's local
# Docker image store, though — pulled by that same compose stack earlier —
# so `kind load docker-image` sideloads them directly into the node's
# containerd without touching the registry at all. This is the standard
# kind pattern for exactly this situation (see kind's own "Loading an Image
# Into Your Cluster" docs), not a workaround specific to this outage; it
# also makes every run here independent of Docker Hub rate limits generally.
# `imagePullPolicy: IfNotPresent` is set explicitly below, in case a
# scheduler restart ever caused a fresh pull attempt with the default
# policy — belt and suspenders once the tag is confirmed gone upstream.
#
# Neither `kind load docker-image` NOR a plain `docker save` + `kind load
# image-archive` works on these specific images: both fail identically with
# "ctr: content digest ... not found". The image was originally pulled as a
# multi-platform manifest list, and even though a single `docker pull` only
# fetches the host's own platform's layers, this host's local Docker image
# store (containerd-backed, the current Docker Desktop default) retains the
# manifest-list/OCI-index metadata referencing every platform — including
# ones never actually fetched — and BOTH kind loaders ask containerd to
# import `--all-platforms` regardless of source, erroring the moment they
# hit one of those un-fetched digests. Confirmed directly against this
# node: `docker save` still embeds that multi-platform index even though
# only the host's own platform has real blob content behind it.
#
# Fix: flatten each image to a single-platform image with no manifest-list
# metadata at all before saving — `docker create` (never runs anything, so
# there is no filesystem diff) then `docker commit` produces exactly that,
# inheriting the original image's config unchanged. Committed to a
# DEDICATED local-only tag (suffixed `-kindload`), never overwriting the
# original `minio/*` tag — docker-compose.override.yml's own `minio`/
# `minio-init` services pin that exact tag too, and this script has no
# business mutating shared local image state other tooling depends on.
NORA_KIND_IMAGE_TMPDIR="$(mktemp -d)"
NORA_KIND_MINIO_IMAGE="${MINIO_IMAGE}-kindload"
NORA_KIND_MINIO_MC_IMAGE="${MINIO_MC_IMAGE}-kindload"
for pair in "${MINIO_IMAGE}=${NORA_KIND_MINIO_IMAGE}" "${MINIO_MC_IMAGE}=${NORA_KIND_MINIO_MC_IMAGE}"; do
  source_image="${pair%%=*}"
  flat_image="${pair#*=}"
  if ! docker image inspect "$source_image" >/dev/null 2>&1; then
    echo "run-kind-k8s-smoke.sh: ${source_image} is not present in the local Docker image store, and Docker Hub no longer serves this exact tag — pull it from wherever it's still cached (e.g. another host, or update the pin repo-wide to a current MinIO release) before running this script." >&2
    exit 1
  fi
  flatten_container="nora-kind-flatten-$(echo "$source_image" | tr '/:' '__')"
  docker rm -f "$flatten_container" >/dev/null 2>&1 || true
  docker create --name "$flatten_container" "$source_image" >/dev/null
  docker commit "$flatten_container" "$flat_image" >/dev/null
  docker rm "$flatten_container" >/dev/null
  archive="${NORA_KIND_IMAGE_TMPDIR}/$(echo "$flat_image" | tr '/:' '__').tar"
  docker save "$flat_image" -o "$archive"
  "$KIND_BIN" load image-archive "$archive" --name "$KIND_CLUSTER_NAME"
  docker rmi "$flat_image" >/dev/null
done
rm -rf "$NORA_KIND_IMAGE_TMPDIR"

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
          image: ${NORA_KIND_MINIO_IMAGE}
          imagePullPolicy: IfNotPresent
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
          image: ${NORA_KIND_MINIO_MC_IMAGE}
          imagePullPolicy: IfNotPresent
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
  # k8s-smoke.mts's assertLogSegmentsProduced checks for a real, FLUSHED
  # MinIO object (not the live in-memory buffer — see that function's own
  # comment for why the buffer can't be trusted as proof of persistence),
  # so a real flush has to actually happen inside this run. The production
  # default (15 minutes) would make every run either wait a quarter hour or
  # time out; worker.ts already reads this exact env var as an override
  # (see its own "NORA_LOG_FLUSH_INTERVAL_MS overrides the 15-minute default
  # flush timer" comment). Scoped to this smoke env file only. 45s leaves
  # assertLogSegmentsProduced's default 180s poll timeout (K8S_SMOKE_LOG_
  # SEGMENT_TIMEOUT_MS) comfortable margin for at least one real flush.
  echo "NORA_LOG_FLUSH_INTERVAL_MS=45000"
  # Pre-existing bug, unrelated to logging, found running this script for
  # real: backend-api/lib/connectionConfig.ts's buildPostgresConfig() only
  # ever reads a plain DB_PASSWORD env var — DB_PASSWORD_FILE (what
  # docker-compose.yml actually sets, pointing at
  # .secrets/compose/DB_PASSWORD) is never referenced anywhere in
  # backend-api's code at all. The real dev stack's .env happens to also
  # carry a plain DB_PASSWORD that matches the shared secret file, so this
  # goes unnoticed there. NORA_ENV_FILE's default here is .env.test, whose
  # DB_USER/DB_PASSWORD/DB_NAME are all the placeholder string "platform" —
  # never intended to match the real secret file, and genuinely don't.
  # Postgres itself DOES honor POSTGRES_PASSWORD_FILE correctly (the
  # official image's own entrypoint), so it ends up initialized with the
  # real secret while backend-api tries to authenticate with the literal
  # string "platform" — confirmed directly: a fresh nora-kind-postgres-1
  # rejects connections from nora-kind-backend-api-1 with "password
  # authentication failed for user \"platform\"" every time, and the two
  # passwords were confirmed byte-for-byte different by inspection. Not
  # fixed at its root (connectionConfig.ts) here, since that's a
  # significant behavior change to code every other service and test in
  # the repo also depends on; overridden narrowly in this script's own
  # overlay instead, to the same real secret every other service already
  # uses, so this harness stops depending on .env.test's mismatched values
  # at all.
  echo "DB_USER=nora"
  echo "DB_NAME=nora"
  echo "DB_PASSWORD=$(cat "${NORA_COMPOSE_SECRETS_DIR:-.secrets/compose}/DB_PASSWORD")"
} >>"$LOG_STORAGE_ENV_FILE"
# k8s-smoke.mts's assertLogSegmentsProduced reads these same names to run
# its own `mc find` pod against the identical in-cluster MinIO deployment/
# bucket built above — MINIO_MC_IMAGE as the flattened, actually-loaded tag
# (see the flatten-and-sideload block above for why the original tag name
# won't resolve inside the cluster). These were plain (unexported) shell
# variables until now — needed exporting for the `tsx` subprocess invoked
# at the end of this script to see them at all.
export MINIO_NAMESPACE MINIO_BUCKET MINIO_ACCESS_KEY MINIO_SECRET_KEY
export MINIO_MC_IMAGE="$NORA_KIND_MINIO_MC_IMAGE"
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
  # Real, confirmed finding, not a hypothetical: waitForAgentReadiness's
  # initial runtime/gateway check (worker.ts's runProvisioningReadinessBarrier)
  # runs INSIDE worker-provisioner's OWN process, hitting the deployed pod's
  # NodePort directly — never proxied through backend-api. Omitting
  # worker-provisioner's own container IP from this trusted list means
  # Calico's `nora-openclaw-allow-trusted-ingress` policy (built from
  # exactly this CIDR set — see k8s.ts's `_trustedIngressCidrs`) blocks that
  # check outright, every single time, regardless of how long the pod is
  # given to become Ready: confirmed directly against a live run — the pod
  # reached 1/1 Ready repeatedly, and every readiness attempt still failed
  # with "fetch failed" until this IP was added. This is a real gotcha for
  # any operator manually setting `loadBalancerSourceRanges` on a real
  # Kubernetes cluster profile too (see k8s.ts: it's operator-supplied, not
  # auto-computed there) — not a Nora code defect, but exactly the mistake
  # this script itself was making by omission.
  WORKER_CONTAINER_IP="$(
    docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' \
      "${COMPOSE_PROJECT_NAME}-worker-provisioner-1"
  )"
  TRUSTED_INGRESS_CIDRS=()
  if [[ -n "$BACKEND_CONTAINER_IP" ]]; then
    TRUSTED_INGRESS_CIDRS+=("${BACKEND_CONTAINER_IP}/32")
  fi
  if [[ -n "$WORKER_CONTAINER_IP" ]] && [[ "$WORKER_CONTAINER_IP" != "$BACKEND_CONTAINER_IP" ]]; then
    TRUSTED_INGRESS_CIDRS+=("${WORKER_CONTAINER_IP}/32")
  fi
  if [[ "$NORA_K8S_RUNTIME_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && \
    [[ "$NORA_K8S_RUNTIME_HOST" != "$BACKEND_CONTAINER_IP" ]] && \
    [[ "$NORA_K8S_RUNTIME_HOST" != "$WORKER_CONTAINER_IP" ]]; then
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
