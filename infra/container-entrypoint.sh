#!/bin/sh
set -eu
umask 027

load_secret_file() {
  secret_name="$1"
  secret_path="$2"

  [ -n "$secret_path" ] || return 0
  if [ ! -f "$secret_path" ] || [ ! -r "$secret_path" ]; then
    echo "Configured secret file is not readable: $secret_path" >&2
    exit 1
  fi

  current_value="$(printenv "$secret_name" 2>/dev/null || true)"
  [ -z "$current_value" ] || return 0
  secret_value="$(cat "$secret_path")"
  export "$secret_name=$secret_value"
}

# Support conventional *_FILE inputs and Kubernetes/Docker secret mounts. A
# non-empty explicit environment value wins; otherwise a file named exactly
# like a valid environment variable is loaded from /run/secrets.
load_secret_file JWT_SECRET "${JWT_SECRET_FILE:-}"
load_secret_file ENCRYPTION_KEY "${ENCRYPTION_KEY_FILE:-}"
load_secret_file NORA_BACKUP_ENCRYPTION_KEY "${NORA_BACKUP_ENCRYPTION_KEY_FILE:-}"
load_secret_file NORA_AGENT_HUB_API_KEY_HASH_SECRET "${NORA_AGENT_HUB_API_KEY_HASH_SECRET_FILE:-}"
load_secret_file NORA_API_KEY_HASH_SECRET "${NORA_API_KEY_HASH_SECRET_FILE:-}"
load_secret_file DB_PASSWORD "${DB_PASSWORD_FILE:-}"

secret_directory="${NORA_SECRETS_DIR:-/run/secrets}"
if [ -d "$secret_directory" ]; then
  for secret_path in "$secret_directory"/*; do
    [ -f "$secret_path" ] || continue
    secret_name="${secret_path##*/}"
    case "$secret_name" in
      [A-Za-z_]* ) ;;
      * ) continue ;;
    esac
    case "$secret_name" in
      *[!A-Za-z0-9_]* ) continue ;;
    esac
    current_value="$(printenv "$secret_name" 2>/dev/null || true)"
    [ -z "$current_value" ] || continue
    secret_value="$(cat "$secret_path")"
    export "$secret_name=$secret_value"
  done
fi

if [ "$(id -u)" -eq 0 ]; then
  if [ -S /var/run/docker.sock ]; then
    socket_gid="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || printf '0')"
    case "$socket_gid" in
      ''|*[!0-9]*) socket_gid=0 ;;
    esac
    socket_group="$(awk -F: -v gid="$socket_gid" '$3 == gid { print $1; exit }' /etc/group)"
    if [ -z "$socket_group" ]; then
      socket_group="nora-docker"
      addgroup -S -g "$socket_gid" "$socket_group"
    fi
    if ! id -nG node | tr ' ' '\n' | grep -Fxq "$socket_group"; then
      addgroup node "$socket_group"
    fi
  fi

  for directory in /var/lib/nora-upgrade /var/lib/nora-backups; do
    [ -d "$directory" ] || continue
    marker="$directory/.nora-owner-1000-v1"
    [ -f "$marker" ] && continue
    lock="$directory/.nora-owner-migration-v1.lock"
    if mkdir "$lock" 2>/dev/null; then
      if chown -R node:node "$directory" &&
        touch "$marker" &&
        chown node:node "$marker"; then
        rmdir "$lock" 2>/dev/null || true
      else
        rmdir "$lock" 2>/dev/null || true
        echo "Failed to migrate Nora volume ownership: $directory" >&2
        exit 1
      fi
    else
      attempts=0
      while [ ! -f "$marker" ] && [ "$attempts" -lt 120 ]; do
        attempts=$((attempts + 1))
        sleep 1
      done
      if [ ! -f "$marker" ]; then
        echo "Timed out waiting for Nora volume ownership migration: $directory" >&2
        exit 1
      fi
    fi
  done

  exec su-exec node "$@"
fi

exec "$@"
