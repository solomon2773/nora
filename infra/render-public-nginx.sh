#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: infra/render-public-nginx.sh <env-file> [compose-files]

Refreshes the generated root nginx.public.conf from the tracked public or TLS
template. Custom NGINX_CONFIG_FILE values and local-only nginx.conf installs are
left untouched.
EOF
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
  exit 2
fi

env_file="$1"
compose_files="${2:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

if [ ! -f "$env_file" ]; then
  echo "Missing deploy env file: $env_file" >&2
  exit 1
fi

read_env_value() {
  local name="$1"
  awk -v name="$name" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }

    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      line = $0
      sub(/^[^=]*=/, "", line)
      line = trim(line)
      if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
          (substr(line, 1, 1) == "\047" && substr(line, length(line), 1) == "\047")) {
        line = substr(line, 2, length(line) - 2)
      }
      value = line
    }

    END {
      print value
    }
  ' "$env_file"
}

nginx_config_file="$(read_env_value NGINX_CONFIG_FILE)"
case "$nginx_config_file" in
  ""|nginx.conf)
    echo "Local nginx config is active; no generated public config refresh is needed."
    exit 0
    ;;
  nginx.public.conf)
    ;;
  *)
    echo "Custom NGINX_CONFIG_FILE=$nginx_config_file is active; leaving it unchanged."
    exit 0
    ;;
esac

public_url="$(read_env_value NORA_PUBLIC_URL)"
if [ -z "$public_url" ]; then
  public_url="$(read_env_value NEXTAUTH_URL)"
fi

domain=""
if [[ "$public_url" == *://* ]]; then
  authority="${public_url#*://}"
  authority="${authority%%/*}"
  authority="${authority##*@}"
  domain="${authority%%:*}"
fi

output_path="$repo_dir/nginx.public.conf"
if [ -z "$domain" ] && [ -f "$output_path" ]; then
  domain="$(awk '$1 == "server_name" { gsub(/;/, "", $2); print $2; exit }' "$output_path")"
fi

if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || [[ "$domain" != *.* ]]; then
  echo "Could not derive a valid public domain from NORA_PUBLIC_URL or NEXTAUTH_URL." >&2
  exit 1
fi

tls_enabled=false
if [[ ":$compose_files:" == *":infra/docker-compose.public-tls.yml:"* ]] ||
  { [ -f "$output_path" ] && grep -Eq '^[[:space:]]*(listen[[:space:]]+443[[:space:]]+ssl|ssl_certificate[[:space:]])' "$output_path"; }; then
  tls_enabled=true
else
  IFS=':' read -r -a compose_paths <<< "$compose_files"
  for compose_path in "${compose_paths[@]}"; do
    [ -n "$compose_path" ] || continue
    if [[ "$compose_path" != /* ]]; then
      compose_path="$repo_dir/$compose_path"
    fi
    if [ -f "$compose_path" ] && grep -Eq '443:443|/etc/letsencrypt' "$compose_path"; then
      tls_enabled=true
      break
    fi
  done
fi

template="$script_dir/nginx_public.conf.template"
if [ "$tls_enabled" = true ]; then
  template="$script_dir/nginx_tls.conf"
fi

tmp_file="$(mktemp "$repo_dir/.nginx.public.conf.XXXXXX")"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

awk -v domain="$domain" '{ gsub(/\$\{DOMAIN\}/, domain); print }' "$template" > "$tmp_file"
chmod 644 "$tmp_file"
mv -f "$tmp_file" "$output_path"
trap - EXIT

echo "Refreshed nginx.public.conf from ${template#"$repo_dir/"} for $domain."
