#!/usr/bin/env bash
set -euo pipefail

NORA_K8S_TOOLS_DIR="${NORA_K8S_TOOLS_DIR:-/tmp/nora-tools}"
NORA_KIND_VERSION="${NORA_KIND_VERSION:-v0.31.0}"
NORA_KUBECTL_VERSION="${NORA_KUBECTL_VERSION:-v1.34.6}"
NORA_KIND_BIN="${NORA_KIND_BIN:-$NORA_K8S_TOOLS_DIR/kind-$NORA_KIND_VERSION}"
NORA_KUBECTL_BIN="${NORA_KUBECTL_BIN:-$NORA_K8S_TOOLS_DIR/kubectl-$NORA_KUBECTL_VERSION}"

mkdir -p "$NORA_K8S_TOOLS_DIR"

if [[ ! -x "$NORA_KIND_BIN" ]]; then
  curl -fsSL "https://kind.sigs.k8s.io/dl/${NORA_KIND_VERSION}/kind-linux-amd64" -o "$NORA_KIND_BIN"
  chmod +x "$NORA_KIND_BIN"
fi

if [[ ! -x "$NORA_KUBECTL_BIN" ]]; then
  curl -fsSL "https://dl.k8s.io/release/${NORA_KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o "$NORA_KUBECTL_BIN"
  chmod +x "$NORA_KUBECTL_BIN"
fi

ln -sf "$(basename "$NORA_KIND_BIN")" "$NORA_K8S_TOOLS_DIR/kind"
ln -sf "$(basename "$NORA_KUBECTL_BIN")" "$NORA_K8S_TOOLS_DIR/kubectl"

export PATH="$NORA_K8S_TOOLS_DIR:$PATH"
export NORA_KIND_BIN
export NORA_KUBECTL_BIN
