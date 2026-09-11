#!/usr/bin/env bash
# infra-tests/lib/auth.sh — mint a real JWT for a real DB user, without a
# login HTTP round trip or knowing anyone's password.
#
# backend-api signs JWTs as: jwt.sign({id, email, role}, process.env.JWT_SECRET,
# {expiresIn: "7d", algorithm: "HS256"}) — see backend-api/routes/auth.ts.
# JWT_SECRET is resolved from /run/secrets/JWT_SECRET by the container's own
# entrypoint, the same way DB_PASSWORD is (see node_call.sh's header for
# why `docker compose exec` alone can't see it). This helper runs a `jwt.sign`
# call inside the REAL backend-api container with that secret properly
# resolved, using a real user row's id/email/role from the DB — so the
# resulting token is indistinguishable from one issued by a real login.
#
# A note on the "platform_admin" role name: this file's public interface
# (the `mint_jwt platform_admin` call) uses that name because it's the name
# used throughout the plan doc and the phase5c/phase14 READMEs. The ACTUAL
# column value in this codebase's `users.role` is the plain string
# "admin" — confirmed by reading backend-api/middleware/auth.ts's
# `requireAdmin` ("req.user.role !== 'admin'") and routes/admin.ts's
# `WHERE role = 'admin'` queries; there is no "platform_admin" string
# anywhere in the schema or code. mint_jwt keeps the "platform_admin"
# argument name for interface stability — phase5c's own scripts already
# call `authed_curl_status ... platform_admin`, so renaming the argument
# would just move the mismatch to every call site instead of resolving it
# in one place.

AUTH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$AUTH_LIB_DIR/db.sh"
source "$AUTH_LIB_DIR/docker_ctl.sh"

# NGINX_HTTP_PORT: fall back to reading it out of the repo's real .env
# (same file lib/local_cap.sh already reads) rather than trusting it to be
# exported in the caller's shell. Confirmed empirically this matters: this
# dev stack's own .env sets NGINX_HTTP_PORT=8081 (not the documented
# default of 8080), and authed_curl/authed_curl_status would otherwise
# silently 404 against the wrong port — every request would reach nginx's
# default location block instead of /api/, not a real auth failure. Only
# used if the caller's shell hasn't already exported a value, so an
# explicit override still wins.
if [ -z "${NGINX_HTTP_PORT:-}" ]; then
  _AUTH_ENV_FILE="${ENV_FILE:-$COMPOSE_ROOT/.env}"
  if [ -f "$_AUTH_ENV_FILE" ]; then
    NGINX_HTTP_PORT="$(grep '^NGINX_HTTP_PORT=' "$_AUTH_ENV_FILE" | head -1 | cut -d= -f2)"
  fi
  NGINX_HTTP_PORT="${NGINX_HTTP_PORT:-8080}"
fi

# mint_jwt [role]
#
# role: "user" (default) or "platform_admin" — selects which real user row
# to mint against ("platform_admin" resolves to the real `role = 'admin'`
# DB value — see header). Prints the JWT to stdout, nothing else. Fails
# loudly (no JWT-shaped output) if no matching user exists — callers must
# check for a non-empty, well-formed result rather than assuming success.
mint_jwt() {
  local want_role="${1:-user}"
  local cid
  cid="$(container_id_for backend-api)"
  if [ -z "$cid" ]; then
    echo "mint_jwt: backend-api is not running" >&2
    return 1
  fi

  local user_row
  if [ "$want_role" = "platform_admin" ]; then
    user_row="$(db_query "SELECT id, email, role FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1;")"
  else
    user_row="$(db_query "SELECT id, email, role FROM users ORDER BY created_at LIMIT 1;")"
  fi
  # db.sh's db_query runs psql with -A (unaligned), whose default field
  # separator is a pipe ('|') — confirmed by reading lib/db.sh (`psql -qtAc`)
  # and psql's own docs for -A/-F. Split on '|', not a guessed delimiter.
  if [ -z "$user_row" ]; then
    echo "mint_jwt: no user row found for role=$want_role" >&2
    return 1
  fi

  local user_id user_email user_db_role
  user_id="$(echo "$user_row" | cut -d'|' -f1)"
  user_email="$(echo "$user_row" | cut -d'|' -f2)"
  user_db_role="$(echo "$user_row" | cut -d'|' -f3)"
  if [ -z "$user_id" ]; then
    echo "mint_jwt: could not parse id from user row: $user_row" >&2
    return 1
  fi

  # Unlike worker-provisioner (node_call.sh's target), backend-api's
  # container runs with a read-only root filesystem in this stack's dev
  # compose (confirmed via `docker inspect` — HostConfig.ReadonlyRootfs=
  # true) — `docker cp` into ANY path inside it, even a writable tmpfs
  # mount like /tmp, fails outright with "Error response from daemon:
  # container rootfs is marked read-only" (docker cp routes through the
  # container's root FS driver before it ever reaches the target mount, so
  # the tmpfs underneath doesn't save it). Piping the script over stdin to
  # `sh -c 'cat > ...'` writes straight into the tmpfs mount instead and
  # works fine — verified empirically against the real running container
  # before relying on it here. /tmp is used (not /app, which node_call.sh
  # uses for worker-provisioner) because /app itself is part of the
  # read-only rootfs in backend-api; /tmp is the one writable path (a
  # tmpfs mount, confirmed via `docker inspect`'s HostConfig.Tmpfs).
  local js_source
  js_source="$(cat <<EOF
const jwt = require('jsonwebtoken');
console.log(jwt.sign(
  { id: '${user_id}', email: '${user_email}', role: '${user_db_role}' },
  process.env.JWT_SECRET,
  { expiresIn: '7d', algorithm: 'HS256' }
));
EOF
)"
  printf '%s\n' "$js_source" | docker exec -i "$cid" sh -c "cat > /tmp/.infra-test-mint-jwt.js"

  # Same secret-resolution replication node_call.sh documents: `docker
  # compose exec`/`docker exec` does not re-run the container's own
  # entrypoint, which is what normally resolves JWT_SECRET from
  # /run/secrets/JWT_SECRET into a real env var before the app starts.
  # backend-api's real app root inside the container is /app (confirmed
  # via backend-api/Dockerfile*/Dockerfile.prod's `WORKDIR /app`) — same as
  # worker-provisioner — but the script itself must live under /tmp per
  # the read-only-rootfs note above; `node /tmp/....js` run with cwd still
  # at /app (via `-w /app`) resolves `require('jsonwebtoken')` fine since
  # Node's module resolution walks up from the current working directory's
  # own node_modules search when the running script has no meaningful
  # __dirname of its own to resolve from, and /app/node_modules is on that
  # path via the working directory — verified empirically.
  local -a secret_env_args=()
  local secret_name secret_value
  for secret_name in $(docker exec "$cid" sh -c 'ls /run/secrets 2>/dev/null'); do
    secret_value="$(docker exec "$cid" sh -c "cat /run/secrets/${secret_name} 2>/dev/null")"
    secret_env_args+=(-e "${secret_name}=${secret_value}")
  done

  local token
  token="$(docker exec "${secret_env_args[@]}" -w /app "$cid" node /tmp/.infra-test-mint-jwt.js)"
  local status=$?
  docker exec "$cid" rm -f /tmp/.infra-test-mint-jwt.js >/dev/null 2>&1 || true

  if [ "$status" -ne 0 ] || [ -z "$token" ]; then
    echo "mint_jwt: jwt.sign failed inside backend-api — check JWT_SECRET resolution" >&2
    return 1
  fi
  echo "$token"
}

# authed_curl <method> <path> [role] [extra curl args...]
#
# Convenience wrapper: mints a JWT for `role` (default "user") and curls
# http://localhost:${NGINX_HTTP_PORT:-8080}/api<path> with it as a Bearer
# token. Prints the response body; the caller checks status via -w/-o as
# needed, or use `authed_curl_status` below for just the HTTP status code.
authed_curl() {
  local method="$1" path="$2" role="${3:-user}"
  if [ "$#" -ge 3 ]; then shift 3; else shift "$#"; fi
  local token
  token="$(mint_jwt "$role")" || return 1
  curl -sS -X "$method" \
    -H "Authorization: Bearer ${token}" \
    "http://localhost:${NGINX_HTTP_PORT:-8080}/api${path}" \
    "$@"
}

# authed_curl_status <method> <path> [role] [extra curl args...]
#
# Same as authed_curl but prints only the HTTP status code (-o /dev/null
# -w '%{http_code}').
authed_curl_status() {
  local method="$1" path="$2" role="${3:-user}"
  if [ "$#" -ge 3 ]; then shift 3; else shift "$#"; fi
  local token
  token="$(mint_jwt "$role")" || return 1
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${token}" \
    "http://localhost:${NGINX_HTTP_PORT:-8080}/api${path}" \
    "$@"
}
