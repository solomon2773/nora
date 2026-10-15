#!/usr/bin/env bash
#
# Fills in the logging control plane's env settings that an install is
# missing, without ever touching a value that is already set:
#
#   NORA_LOG_ENCRYPTION_KEY    64-char hex; encrypts stored log segments
#   NORA_OTLP_INGEST_SECRET    64-char hex; signs per-agent trace-ingest keys
#   NORA_LOG_LOCAL_MAX_BYTES   smaller of 10 GiB and 20% of free disk
#
# NORA_LOG_ENABLED is deliberately NOT written here. Collection stores agent
# output on disk, so an upgrade must not turn it on for the operator. Leaving
# it unset means "not decided yet": collection stays off and the admin
# dashboard asks. setup.sh --update asks interactively before this runs, and
# fresh installs ask during setup, so both write an explicit value.
#   NORA_LOG_RETENTION_CEILING_DAYS  30, the code default, so upgrades keep
#                              today's behavior but the setting is visible
#
# NORA_LOG_ENCRYPTION_KEY is never regenerated once present: it may hold a
# comma-separated key ring mid-rotation, and replacing it makes every stored
# log segment unreadable.
#
# Used by `setup.sh --update` and infra/update-release-env.sh (one-click
# upgrades). `--recommend-bytes` only prints the recommended local cap
# (0 when there is too little free disk) for setup's interactive prompt.

set -euo pipefail

LOG_CAP_CEILING_BYTES=$((10 * 1024 * 1024 * 1024))
LOG_CAP_FLOOR_BYTES=$((1024 * 1024 * 1024))

usage() {
  cat <<'EOF'
Usage: ensure-log-env.sh <env-file>
       ensure-log-env.sh --recommend-bytes [path]
EOF
}

# Free space where Docker keeps the nora_logs volume, falling back to the
# given path when the Docker root is not visible from here (Docker Desktop,
# or the one-click upgrade runner container).
free_disk_bytes() {
  local probe_path="${1:-.}" docker_root free_kb
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -n "$docker_root" ] && [ -d "$docker_root" ]; then
    probe_path="$docker_root"
  fi
  free_kb="$(df -Pk "$probe_path" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  case "$free_kb" in
    '' | *[!0-9]*) printf '0\n' ;;
    *) printf '%s\n' "$((free_kb * 1024))" ;;
  esac
}

recommend_log_max_bytes() {
  local free_bytes cap
  free_bytes="$(free_disk_bytes "${1:-.}")"
  cap=$((free_bytes / 5))
  [ "$cap" -gt "$LOG_CAP_CEILING_BYTES" ] && cap="$LOG_CAP_CEILING_BYTES"
  [ "$cap" -lt "$LOG_CAP_FLOOR_BYTES" ] && cap=0
  printf '%s\n' "$cap"
}

random_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
    printf '\n'
  fi
}

env_value() {
  local env_file="$1" name="$2"
  awk -v name="$name" '
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value == "\"\"" || value == sprintf("%c%c", 39, 39)) value = ""
      last = value
    }
    END { printf "%s", last }
  ' "$env_file"
}

# Replaces an existing (empty) NAME= line in place, or appends one.
write_env_value() {
  local env_file="$1" name="$2" value="$3" tmp_file
  tmp_file="$(mktemp "$(dirname "$env_file")/.nora-log-env.XXXXXX")"
  awk -v name="$name" -v value="$value" '
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      if (!wrote) print name "=" value
      wrote = 1
      next
    }
    { print }
    END { if (!wrote) print name "=" value }
  ' "$env_file" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv "$tmp_file" "$env_file"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "${1:-}" = "--recommend-bytes" ]; then
  recommend_log_max_bytes "${2:-.}"
  exit 0
fi

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  usage >&2
  exit 1
fi

env_file="$1"

if [ -z "$(env_value "$env_file" NORA_LOG_ENCRYPTION_KEY)" ]; then
  write_env_value "$env_file" NORA_LOG_ENCRYPTION_KEY "$(random_hex_32)"
  echo "NORA_LOG_ENCRYPTION_KEY generated (64-char hex). Keep a copy with your .env backup."
fi

if [ -z "$(env_value "$env_file" NORA_OTLP_INGEST_SECRET)" ]; then
  write_env_value "$env_file" NORA_OTLP_INGEST_SECRET "$(random_hex_32)"
  echo "NORA_OTLP_INGEST_SECRET generated (64-char hex)."
fi

if [ -z "$(env_value "$env_file" NORA_LOG_RETENTION_CEILING_DAYS)" ]; then
  write_env_value "$env_file" NORA_LOG_RETENTION_CEILING_DAYS 30
  echo "NORA_LOG_RETENTION_CEILING_DAYS set to 30 (platform-wide maximum days logs are kept)."
fi

# Preset a safe disk cap so enabling collection later (Admin -> Logging, or
# NORA_LOG_ENABLED=true) never starts with an unbounded budget. Never changes
# an existing value, and never writes NORA_LOG_ENABLED itself.
if [ -z "$(env_value "$env_file" NORA_LOG_LOCAL_MAX_BYTES)" ]; then
  recommended_cap="$(recommend_log_max_bytes "$(dirname "$env_file")")"
  [ "$recommended_cap" -ge "$LOG_CAP_FLOOR_BYTES" ] || recommended_cap="$LOG_CAP_FLOOR_BYTES"
  write_env_value "$env_file" NORA_LOG_LOCAL_MAX_BYTES "$recommended_cap"
fi

if [ -z "$(env_value "$env_file" NORA_LOG_ENABLED)" ]; then
  echo "Log collection is OFF until you turn it on (Admin -> Settings -> Log Collection, or NORA_LOG_ENABLED=true in .env)."
fi
