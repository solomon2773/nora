#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: update-release-env.sh <env-file> <version> <commit> [github-repo]

Updates or appends:
  NORA_CURRENT_VERSION
  NORA_CURRENT_COMMIT
  NORA_GITHUB_REPO (when provided)
  DOCKER_GID (from the live Docker socket)
  NORA_AGENT_HUB_API_KEY_HASH_SECRET (only when missing or empty)

Removes retired release metadata token keys:
  NORA_GITHUB_TOKEN

The version argument may be empty for source checkouts where only the commit
is known.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  usage >&2
  exit 1
fi

env_file="$1"
version="$2"
commit="$3"
github_repo="${4:-}"

if [ -z "$env_file" ] || [ -z "$commit" ]; then
  echo "env file and commit are required" >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  echo "env file does not exist: $env_file" >&2
  echo "Run setup first or point DEPLOY_ENV_FILE at the existing production env file." >&2
  exit 1
fi

env_dir="$(dirname "$env_file")"

resolve_docker_gid() {
  socket_path="${NORA_DOCKER_SOCKET_PATH:-/var/run/docker.sock}"
  if [ ! -S "$socket_path" ]; then
    echo "Docker socket does not exist or is not a Unix socket: $socket_path" >&2
    return 1
  fi

  socket_gid="$(
    stat -c '%g' "$socket_path" 2>/dev/null ||
      stat -f '%g' "$socket_path" 2>/dev/null ||
      true
  )"
  case "$socket_gid" in
    ''|*[!0-9]*)
      echo "Could not determine the numeric Docker socket group for $socket_path" >&2
      return 1
      ;;
  esac

  printf '%s\n' "$socket_gid"
}

docker_gid="$(resolve_docker_gid)"

env_has_agent_hub_hash_secret() {
  awk -F= '
    /^[[:space:]]*NORA_AGENT_HUB_API_KEY_HASH_SECRET[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value == "\"\"" || value == sprintf("%c%c", 39, 39)) {
        value = ""
      }
      if (value != "") {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  ' "$env_file"
}

agent_hub_hash_secret=""
if ! env_has_agent_hub_hash_secret; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate NORA_AGENT_HUB_API_KEY_HASH_SECRET" >&2
    exit 1
  fi
  agent_hub_hash_secret="$(openssl rand -hex 32)"
fi

tmp_file="$(mktemp "$env_dir/.nora-release-env.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

awk \
  -v version="$version" \
  -v commit="$commit" \
  -v github_repo="$github_repo" \
  -v docker_gid="$docker_gid" \
  -v agent_hub_hash_secret="$agent_hub_hash_secret" \
  '
  BEGIN {
    saw_version = 0
    saw_commit = 0
    saw_repo = 0
    saw_docker_gid = 0
    saw_agent_hub_hash_secret = 0
  }

  /^NORA_CURRENT_VERSION=/ {
    print "NORA_CURRENT_VERSION=" version
    saw_version = 1
    next
  }

  /^NORA_CURRENT_COMMIT=/ {
    print "NORA_CURRENT_COMMIT=" commit
    saw_commit = 1
    next
  }

  /^NORA_GITHUB_REPO=/ && github_repo != "" {
    print "NORA_GITHUB_REPO=" github_repo
    saw_repo = 1
    next
  }

  /^NORA_GITHUB_TOKEN=/ {
    next
  }

  /^DOCKER_GID=/ {
    if (!saw_docker_gid) {
      print "DOCKER_GID=" docker_gid
      saw_docker_gid = 1
    }
    next
  }

  /^[[:space:]]*NORA_AGENT_HUB_API_KEY_HASH_SECRET[[:space:]]*=/ && agent_hub_hash_secret != "" {
    if (!saw_agent_hub_hash_secret) {
      print "NORA_AGENT_HUB_API_KEY_HASH_SECRET=" agent_hub_hash_secret
      saw_agent_hub_hash_secret = 1
    }
    next
  }

  {
    print
  }

  END {
    if (!saw_version) {
      print "NORA_CURRENT_VERSION=" version
    }
    if (!saw_commit) {
      print "NORA_CURRENT_COMMIT=" commit
    }
    if (github_repo != "" && !saw_repo) {
      print "NORA_GITHUB_REPO=" github_repo
    }
    if (!saw_docker_gid) {
      print "DOCKER_GID=" docker_gid
    }
    if (agent_hub_hash_secret != "" && !saw_agent_hub_hash_secret) {
      print "NORA_AGENT_HUB_API_KEY_HASH_SECRET=" agent_hub_hash_secret
    }
  }
  ' "$env_file" > "$tmp_file"

mv "$tmp_file" "$env_file"
