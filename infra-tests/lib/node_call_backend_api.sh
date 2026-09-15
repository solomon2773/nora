#!/usr/bin/env bash
# infra-tests/lib/node_call_backend_api.sh — run a Node snippet inside the
# REAL backend-api container, with its secrets resolved.
#
# Extracted from phase13-traces-lens/01-concurrent-correlation-real-minio.sh,
# which defined it inline and proved it against a live stack. phase6-search
# needs it in three scripts, so it lives here rather than being copied. It is
# a separate file from lib/node_call.sh (which targets worker-provisioner)
# rather than an extension of it — see that file's header for why it stays
# unchanged.
#
# Two constraints drive the shape, both confirmed empirically:
#   - backend-api runs with a read-only root filesystem, so the snippet is
#     piped over stdin into /tmp (a tmpfs mount). `docker cp` into the
#     container fails outright; see lib/auth.sh's mint_jwt header.
#   - `docker exec` does not re-run the entrypoint that resolves
#     /run/secrets/* into env vars, so each secret is re-exported by hand.
#
# The snippet runs with cwd /app but lives in /tmp, and require() resolves
# relative paths against the requiring FILE — so snippets must use absolute
# paths: require('/app/logSearch.ts'), require('/workers/provisioner/...').
#
# A required module can log on load, so callers should print the line they
# care about behind a marker and pull it out with extract_marker.
#
# The snippet is passed inside a bash double-quoted string by every caller:
# a literal double quote anywhere in it — including inside a JS comment —
# ends that string early and corrupts the script. Use single quotes in JS,
# and escape `$` and backticks.

NODE_CALL_BACKEND_API_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$NODE_CALL_BACKEND_API_LIB_DIR/docker_ctl.sh"

# node_call_backend_api <js-source>
node_call_backend_api() {
  local js="$1"
  local cid
  cid="$(container_id_for backend-api)"
  if [ -z "$cid" ]; then
    echo "node_call_backend_api: backend-api is not running" >&2
    return 1
  fi

  printf '%s\n%s\n' "require('tsx/cjs');" "$js" \
    | docker exec -i "$cid" sh -c "cat > /tmp/.infra-test-call-backend.js"

  local -a secret_env_args=()
  local secret_name secret_value
  for secret_name in $(docker exec "$cid" sh -c 'ls /run/secrets 2>/dev/null'); do
    secret_value="$(docker exec "$cid" sh -c "cat /run/secrets/${secret_name} 2>/dev/null")"
    secret_env_args+=(-e "${secret_name}=${secret_value}")
  done

  # `${arr[@]+"${arr[@]}"}` rather than `"${arr[@]}"`: bash 3.2 treats an
  # empty array as unbound under `set -u`.
  docker exec ${secret_env_args[@]+"${secret_env_args[@]}"} -w /app "$cid" \
    node /tmp/.infra-test-call-backend.js
  local rc=$?
  docker exec "$cid" rm -f /tmp/.infra-test-call-backend.js >/dev/null 2>&1 || true
  return $rc
}

# extract_marker <marker> <text> — prints the payload of the first line that
# starts with "<marker>=", or nothing.
extract_marker() {
  local marker="$1" text="$2"
  printf '%s\n' "$text" | sed -n "s/^${marker}=//p" | head -1
}
