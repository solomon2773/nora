#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-nora-e2e}"
export NORA_ENV_FILE="${NORA_ENV_FILE:-.env.test}"
COMPOSE_FILES=(-f docker-compose.e2e.yml)

cleanup() {
  docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

cleanup

docker compose "${COMPOSE_FILES[@]}" up -d --build

while true; do
  sleep 1
done
