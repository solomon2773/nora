#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="${1:-.env}"
DEFAULT_COMPOSE_SECRETS_DIR=".secrets/compose"

error() {
  printf '[error] %s\n' "$1" >&2
}

read_env_value() {
  local env_path="$1" name="$2" default_value="$3" line value

  if [ ! -f "$env_path" ]; then
    printf '%s\n' "$default_value"
    return 0
  fi

  line="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$env_path" 2>/dev/null | tail -n 1 || true)"
  if [ -z "$line" ]; then
    printf '%s\n' "$default_value"
    return 0
  fi

  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="$(decode_compose_env_literal "$value")"

  printf '%s\n' "$value"
}

decode_compose_env_literal() {
  local value="$1" first last body output="" current next i=0 length quote_mode
  if [ "${#value}" -lt 2 ]; then
    printf '%s\n' "$value"
    return 0
  fi

  first="${value:0:1}"
  last="${value: -1}"
  if [ "$first" = '"' ] && [ "$last" = '"' ]; then
    quote_mode="double"
  elif [ "$first" = "'" ] && [ "$last" = "'" ]; then
    quote_mode="single"
  else
    printf '%s\n' "$value"
    return 0
  fi

  body="${value:1:${#value}-2}"
  length="${#body}"
  while [ "$i" -lt "$length" ]; do
    current="${body:$i:1}"
    if [ "$quote_mode" = "single" ] && [ "$current" = "\\" ] && [ $((i + 1)) -lt "$length" ]; then
      next="${body:$((i + 1)):1}"
      if [ "$next" = "'" ]; then
        output="${output}${next}"
        i=$((i + 2))
        continue
      fi
    fi
    if [ "$quote_mode" = "double" ] && [ $((i + 1)) -lt "$length" ]; then
      next="${body:$((i + 1)):1}"
      if [ "$current" = "\\" ] && { [ "$next" = "\\" ] || [ "$next" = '"' ]; }; then
        output="${output}${next}"
        i=$((i + 2))
        continue
      fi
      if [ "$current" = '$' ] && [ "$next" = '$' ]; then
        output="${output}${current}"
        i=$((i + 2))
        continue
      fi
    fi
    output="${output}${current}"
    i=$((i + 1))
  done
  printf '%s\n' "$output"
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || true
}

is_expected_secret_name() {
  case "$1" in
    JWT_SECRET | ENCRYPTION_KEY | NORA_BACKUP_ENCRYPTION_KEY | NORA_AGENT_HUB_API_KEY_HASH_SECRET | NORA_API_KEY_HASH_SECRET | DB_PASSWORD)
      return 0
      ;;
    *) return 1 ;;
  esac
}

secure_secrets_directory() {
  local secrets_dir="$1" resolved_dir resolved_root current_dir mode candidate component
  case "$secrets_dir" in
    "" | / | . | .. | ./ | ../)
      error "NORA_COMPOSE_SECRETS_DIR must point to a dedicated directory, not '$secrets_dir'."
      return 1
      ;;
  esac
  case "$(basename "$secrets_dir")" in
    . | ..)
      error "NORA_COMPOSE_SECRETS_DIR must not resolve through '.' or '..'."
      return 1
      ;;
  esac
  case "/$secrets_dir/" in
    */./* | */../*)
      error "NORA_COMPOSE_SECRETS_DIR must not contain '.' or '..' path segments."
      return 1
      ;;
  esac
  component="$secrets_dir"
  while [ "$component" != "." ] && [ "$component" != "/" ]; do
    if [ -L "$component" ]; then
      error "Refusing NORA_COMPOSE_SECRETS_DIR with symlinked path component: $component"
      return 1
    fi
    component="$(dirname "$component")"
  done
  if [ -e "$secrets_dir" ] && [ ! -d "$secrets_dir" ]; then
    error "NORA_COMPOSE_SECRETS_DIR is not a directory: $secrets_dir"
    return 1
  fi

  if [ ! -d "$secrets_dir" ]; then
    mkdir -p -- "$secrets_dir"
  fi
  resolved_dir="$(cd "$secrets_dir" && pwd -P)"
  resolved_root="$(cd / && pwd -P)"
  current_dir="$(pwd -P)"
  if [ "$resolved_dir" = "$resolved_root" ] || [ "$resolved_dir" = "$current_dir" ]; then
    error "NORA_COMPOSE_SECRETS_DIR must not be the filesystem or repository root: $resolved_dir"
    return 1
  fi

  for candidate in "$secrets_dir"/.[!.]* "$secrets_dir"/..?* "$secrets_dir"/*; do
    if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
      continue
    fi
    if ! is_expected_secret_name "$(basename "$candidate")"; then
      error "Refusing non-dedicated NORA_COMPOSE_SECRETS_DIR; unexpected entry: $candidate"
      return 1
    fi
  done

  mode="$(file_mode "$secrets_dir")"
  if [ "$mode" != "700" ]; then
    chmod 700 "$secrets_dir"
    mode="$(file_mode "$secrets_dir")"
  fi
  if [ "$mode" != "700" ]; then
    error "Refusing to continue because $secrets_dir permissions are ${mode:-unknown} instead of 700."
    return 1
  fi
}

materialize_secret() {
  local secrets_dir="$1" file_name="$2" env_name="$3" value tmp_file mode
  value="$(read_env_value "$ENV_FILE" "$env_name" "")"
  if [ -z "$value" ]; then
    error "Cannot materialize Compose secrets because $env_name is empty in $ENV_FILE."
    return 1
  fi

  tmp_file="$(mktemp "$secrets_dir/.${file_name}.XXXXXX")"
  if ! printf '%s\n' "$value" > "$tmp_file" ||
    ! chmod 444 "$tmp_file" ||
    ! mv -f "$tmp_file" "$secrets_dir/$file_name"; then
    rm -f "$tmp_file"
    error "Could not securely write Compose secret file: $secrets_dir/$file_name"
    return 1
  fi
  mode="$(file_mode "$secrets_dir/$file_name")"
  if [ "$mode" != "444" ]; then
    error "Refusing to continue because $secrets_dir/$file_name permissions are ${mode:-unknown} instead of 444."
    return 1
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  error "Missing deploy env file: $ENV_FILE"
  exit 1
fi

secrets_dir="$(read_env_value "$ENV_FILE" "NORA_COMPOSE_SECRETS_DIR" "$DEFAULT_COMPOSE_SECRETS_DIR")"
secure_secrets_directory "$secrets_dir"
materialize_secret "$secrets_dir" JWT_SECRET JWT_SECRET
materialize_secret "$secrets_dir" ENCRYPTION_KEY ENCRYPTION_KEY
materialize_secret "$secrets_dir" NORA_BACKUP_ENCRYPTION_KEY NORA_BACKUP_ENCRYPTION_KEY
materialize_secret "$secrets_dir" NORA_AGENT_HUB_API_KEY_HASH_SECRET NORA_AGENT_HUB_API_KEY_HASH_SECRET
materialize_secret "$secrets_dir" NORA_API_KEY_HASH_SECRET NORA_API_KEY_HASH_SECRET
materialize_secret "$secrets_dir" DB_PASSWORD DB_PASSWORD

if [ "${NORA_MATERIALIZE_QUIET:-false}" != "true" ]; then
  printf 'Compose secret files refreshed under %s (owner-only directory)\n' "$secrets_dir"
fi
