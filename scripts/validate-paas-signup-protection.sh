#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-}"
if [ -z "$env_file" ]; then
  echo "Usage: $0 <env-file>" >&2
  exit 2
fi
if [ ! -f "$env_file" ]; then
  echo "Missing deploy env file: $env_file" >&2
  exit 1
fi

read_env_value() {
  local name="$1" default_value="${2:-}" line value first last
  line="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$env_file" 2>/dev/null | tail -n 1 || true)"
  if [ -z "$line" ]; then
    printf '%s\n' "$default_value"
    return 0
  fi

  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ "${#value}" -ge 2 ]; then
    first="${value:0:1}"
    last="${value: -1}"
    if { [ "$first" = '"' ] && [ "$last" = '"' ]; } || { [ "$first" = "'" ] && [ "$last" = "'" ]; }; then
      value="${value:1:${#value}-2}"
      printf '%s\n' "$value"
      return 0
    fi
  fi
  if [[ "$value" = \#* ]]; then
    value=""
  else
    value="${value%%[[:space:]]#*}"
    value="${value%"${value##*[![:space:]]}"}"
  fi
  printf '%s\n' "$value"
}

read_env_value_with_alias() {
  local name="$1" alias_name="$2" default_value="${3:-}" value
  value="$(read_env_value "$name" "")"
  if [ -z "$value" ]; then
    value="$(read_env_value "$alias_name" "")"
  fi
  printf '%s\n' "${value:-$default_value}"
}

platform_mode="$(read_env_value PLATFORM_MODE selfhosted)"
platform_mode="$(printf '%s' "$platform_mode" | tr '[:upper:]' '[:lower:]')"
if [ "$platform_mode" != "paas" ]; then
  exit 0
fi

provider="$(read_env_value_with_alias SIGNUP_BOT_PROTECTION_PROVIDER NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER none)"
provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
case "$provider" in
  turnstile)
    site_key="$(read_env_value_with_alias SIGNUP_TURNSTILE_SITE_KEY NEXT_PUBLIC_SIGNUP_TURNSTILE_SITE_KEY "")"
    secret="$(read_env_value SIGNUP_TURNSTILE_SECRET "")"
    ;;
  recaptcha)
    site_key="$(read_env_value_with_alias SIGNUP_RECAPTCHA_SITE_KEY NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY "")"
    secret="$(read_env_value SIGNUP_RECAPTCHA_SECRET "")"
    ;;
  *)
    echo "PaaS deployment requires SIGNUP_BOT_PROTECTION_PROVIDER=turnstile or recaptcha; got '${provider:-unset}'." >&2
    exit 1
    ;;
esac

if [ -z "$site_key" ] || [ -z "$secret" ]; then
  echo "PaaS deployment requires both the public site key and server secret for signup $provider protection." >&2
  exit 1
fi

echo "Validated PaaS signup bot protection provider: $provider"
