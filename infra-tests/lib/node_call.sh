#!/usr/bin/env bash
# infra-tests/lib/node_call.sh — run a JS snippet inside the real
# worker-provisioner container, with real DB access, calling the actual
# retentionSweeper.ts / storageMigration.ts functions directly.
#
# Why this is needed: `docker compose exec` spawns a NEW process inside the
# container, but does NOT re-run the container's own entrypoint script
# (`nora-container-entrypoint`) — which is what resolves `DB_PASSWORD_FILE`
# (`/run/secrets/DB_PASSWORD`, a Docker secret) into a real `DB_PASSWORD`
# env var before the actual app starts. `docker-compose.override.yml`
# deliberately blanks `DB_PASSWORD` itself for these services (see the
# DOCKER_GID/JWT_SECRET debugging earlier this session for the same
# pattern), so a bare `docker compose exec worker-provisioner node -e ...`
# falls back to `backend-api/lib/connectionConfig.ts`'s dev default
# ("nora"), which is wrong, and fails with "password authentication
# failed." This helper replicates just the one line of the entrypoint that
# matters here: read the secret file and export it before running node.
#
# What this unlocks: `retentionSweeper.ts` exports `sweepExpiredSegments`,
# `reconcileStorage`, etc. directly (not only through the hourly/daily
# timers), and `storageMigration.ts` exports `startStorageMigration`,
# `migrateSegmentBatch`, `resumeStorageMigration`, `retryStorageMigration`
# directly too — all callable this way, with ZERO need for a JWT or the
# HTTP layer. That's most of Phase 5's and Phase 5b's core logic. It does
# NOT unlock the HTTP-validation-layer tests specifically (e.g. does `PUT
# /admin/log-storage` itself reject a bad request) — those still need a
# real authenticated request, tracked separately (see Phase 5's README).

NODE_CALL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$NODE_CALL_LIB_DIR/docker_ctl.sh"

# node_call <js-source>
#
# `js-source` runs with `require("tsx/cjs")` already done and the process
# cwd at worker-provisioner's app root (so `require("./logs/...")` paths
# match what the real app itself uses). Prints whatever the script prints;
# the caller is responsible for having the script `console.log` anything
# it wants to assert on, and for making sure the script's own promise
# chain actually resolves before the process would otherwise exit (e.g.
# `.then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); })`).
node_call() {
  local js="$1"
  local cid tmp_host
  cid="$(container_id_for worker-provisioner)"
  if [ -z "$cid" ]; then
    echo "node_call: worker-provisioner is not running" >&2
    return 1
  fi

  tmp_host="$(mktemp)"
  {
    echo "require('tsx/cjs');"
    printf '%s\n' "$js"
  } > "$tmp_host"
  # /app, not /tmp: `docker cp` into this container's /tmp silently no-ops
  # (the file never appears, despite `docker cp` reporting success) — some
  # mount quirk specific to this image/container, not something worth
  # chasing further since /app (the app's own working directory, already
  # writable) works fine and is just as appropriate a scratch location.
  docker cp "$tmp_host" "${cid}:/app/.infra-test-call.js" >/dev/null
  rm -f "$tmp_host"

  # Export every secret the entrypoint itself would have loaded from
  # /run/secrets/* (DB_PASSWORD, ENCRYPTION_KEY, JWT_SECRET, etc.) — not
  # just DB_PASSWORD — since a test that needs to encrypt/decrypt
  # credentials (Phase 5b) needs ENCRYPTION_KEY resolved the same real way.
  local -a secret_env_args=()
  local secret_name secret_value
  for secret_name in $(docker exec "$cid" sh -c 'ls /run/secrets 2>/dev/null'); do
    secret_value="$(docker exec "$cid" sh -c "cat /run/secrets/${secret_name} 2>/dev/null")"
    secret_env_args+=(-e "${secret_name}=${secret_value}")
  done

  docker exec "${secret_env_args[@]}" -w /app "$cid" node /app/.infra-test-call.js
  local status=$?
  docker exec "$cid" rm -f /app/.infra-test-call.js >/dev/null 2>&1 || true
  return $status
}
