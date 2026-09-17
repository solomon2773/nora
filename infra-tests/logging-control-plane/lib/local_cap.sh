#!/usr/bin/env bash
# infra-tests/lib/local_cap.sh — temporarily override NORA_LOG_LOCAL_MAX_BYTES.
#
# This env var is read at call time by both backend-api (the migration
# pre-flight check) and worker-provisioner (the live flush gate, the
# capacity-state sweep), and — like every other env var in this stack —
# changing it in .env does NOT take effect on a plain `docker compose
# restart`; the container must be recreated (`docker compose up -d`) to
# pick up a new value, since `restart` reuses the already-materialized
# environment baked in at container creation. This bit us once already
# this session (see the DOCKER_GID/JWT_SECRET debugging earlier) — worth
# stating plainly here rather than rediscovering it per test.
#
# set_local_cap_bytes prints the ORIGINAL value to stdout; callers MUST
# capture it and pass it to restore_local_cap_bytes in their cleanup trap,
# or a failed test run permanently leaves your dev stack's real cap
# lowered.

LOCAL_CAP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LOCAL_CAP_LIB_DIR/docker_ctl.sh"

ENV_FILE="${ENV_FILE:-$COMPOSE_ROOT/.env}"

# set_local_cap_bytes <bytes>
set_local_cap_bytes() {
  local new_value="$1"
  local original
  original="$(grep '^NORA_LOG_LOCAL_MAX_BYTES=' "$ENV_FILE" | head -1 | cut -d= -f2)"
  if [ -z "$original" ]; then
    echo "set_local_cap_bytes: NORA_LOG_LOCAL_MAX_BYTES not found in $ENV_FILE" >&2
    return 1
  fi
  # -i.infra-test-bak (suffix attached, no space) is the one `sed -i` form
  # that's portable across BSD sed (macOS) and GNU sed (Linux) — BSD
  # requires a backup suffix argument, GNU treats an attached one as
  # optional but accepts it identically.
  sed -i.infra-test-bak "s/^NORA_LOG_LOCAL_MAX_BYTES=.*/NORA_LOG_LOCAL_MAX_BYTES=${new_value}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.infra-test-bak"
  compose up -d worker-provisioner backend-api >/dev/null
  wait_for_healthy worker-provisioner 60
  wait_for_healthy backend-api 60
  echo "$original"
}

# restore_local_cap_bytes <original-value>
restore_local_cap_bytes() {
  local original_value="$1"
  sed -i.infra-test-bak "s/^NORA_LOG_LOCAL_MAX_BYTES=.*/NORA_LOG_LOCAL_MAX_BYTES=${original_value}/" "$ENV_FILE"
  rm -f "${ENV_FILE}.infra-test-bak"
  compose up -d worker-provisioner backend-api >/dev/null
  wait_for_healthy worker-provisioner 60
  wait_for_healthy backend-api 60
}
