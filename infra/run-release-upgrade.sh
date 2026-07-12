#!/usr/bin/env bash

set -u

STATE_DIR="${NORA_UPGRADE_STATE_DIR:-/var/lib/nora-upgrade}"
STATE_FILE="${STATE_DIR}/status.json"
LOG_FILE="${NORA_UPGRADE_LOG_FILE:-${STATE_DIR}/upgrade.log}"
WORKSPACE="${NORA_HOST_REPO_DIR:-}"
UPGRADE_ERROR=""
DEFAULT_HEALTHCHECK_ATTEMPTS=221
DEFAULT_HEALTHCHECK_INTERVAL_SECONDS=3
LEGACY_HEALTHCHECK_ATTEMPTS=40
LEGACY_HEALTHCHECK_INTERVAL_SECONDS=3
MAX_HEALTHCHECK_WINDOW_SECONDS=3900
DEFAULT_HEALTHCHECK_WINDOW_SECONDS=$(((DEFAULT_HEALTHCHECK_ATTEMPTS - 1) * DEFAULT_HEALTHCHECK_INTERVAL_SECONDS))

mkdir -p "$STATE_DIR"
touch "$LOG_FILE"

update_status() {
  local phase="$1" exit_code="${2:-}" error_message="${3:-}"
  PHASE="$phase" EXIT_CODE="$exit_code" ERROR_MESSAGE="$error_message" STATE_FILE="$STATE_FILE" \
    node <<'NODE'
const fs = require("fs");

const stateFile = process.env.STATE_FILE;
const phase = process.env.PHASE;
const exitCode = process.env.EXIT_CODE;
const errorMessage = process.env.ERROR_MESSAGE;
const now = new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "rollback_required"]);
let state = {};

try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {
  state = {};
}

const job = state.job || {};
job.phase = phase;
if (phase !== "queued" && !job.startedAt) {
  job.startedAt = now;
}
job.finishedAt = terminal.has(phase) ? now : null;
job.exitCode = exitCode === "" ? null : Number(exitCode);
job.error = errorMessage || null;
state.job = job;
state.updatedAt = now;

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
NODE
}

fail_step() {
  local code="$1" message="$2"
  UPGRADE_ERROR="$message"
  echo "$message"
  return "$code"
}

build_compose_args() {
  local env_file="$1" compose_files_raw="$2"
  COMPOSE_ARGS=(--env-file "$env_file")

  IFS=':' read -r -a COMPOSE_FILES <<< "$compose_files_raw"
  for compose_file in "${COMPOSE_FILES[@]}"; do
    [ -z "$compose_file" ] && continue
    if [ ! -f "$compose_file" ]; then
      fail_step 23 "Missing compose file: ${compose_file}"
      return $?
    fi
    COMPOSE_ARGS+=(-f "$compose_file")
  done

  if [ "${#COMPOSE_ARGS[@]}" -le 2 ]; then
    fail_step 23 "No compose files configured for upgrade"
    return $?
  fi
}

read_env_setting() {
  local env_file="$1" name="$2"
  awk -v name="$name" '
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == sprintf("%c", 39) && substr(value, length(value), 1) == sprintf("%c", 39))) {
        value = substr(value, 2, length(value) - 2)
      }
      found = value
    }
    END { if (found != "") print found }
  ' "$env_file"
}

resolve_compose_files_from_env() {
  local env_file="$1" configured
  configured="$(read_env_setting "$env_file" NORA_UPGRADE_COMPOSE_FILES)"
  if [ -z "$configured" ]; then
    configured="$(read_env_setting "$env_file" COMPOSE_FILE)"
  fi
  printf '%s\n' "${configured:-${NORA_UPGRADE_COMPOSE_FILES:-docker-compose.yml}}"
}

resolve_target_ref() {
  TARGET_REF=""
  local target_version="${NORA_UPGRADE_TARGET_VERSION:-}"

  if [ -n "$target_version" ]; then
    local version_without_v="${target_version#v}"
    local candidates=("$target_version")
    if [ "$version_without_v" = "$target_version" ]; then
      candidates+=("v${target_version}")
    else
      candidates+=("$version_without_v")
    fi

    for candidate in "${candidates[@]}"; do
      if git rev-parse --verify --quiet "refs/tags/${candidate}^{commit}" >/dev/null; then
        TARGET_REF="refs/tags/${candidate}"
        TARGET_VERSION_RESOLVED="$candidate"
        return 0
      fi
    done
  fi

  TARGET_REF="refs/remotes/nora-upgrade/${NORA_UPGRADE_REF:-master}"
  git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

resolve_healthcheck_budget() {
  local attempts_raw interval_raw attempts interval window invalid="false"

  attempts_raw="$(trim_whitespace "${NORA_UPGRADE_HEALTHCHECK_ATTEMPTS:-$DEFAULT_HEALTHCHECK_ATTEMPTS}")"
  interval_raw="$(trim_whitespace "${NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS:-$DEFAULT_HEALTHCHECK_INTERVAL_SECONDS}")"
  if [ "$attempts_raw" = "$LEGACY_HEALTHCHECK_ATTEMPTS" ] &&
    [ "$interval_raw" = "$LEGACY_HEALTHCHECK_INTERVAL_SECONDS" ]; then
    attempts_raw="$DEFAULT_HEALTHCHECK_ATTEMPTS"
    interval_raw="$DEFAULT_HEALTHCHECK_INTERVAL_SECONDS"
  fi

  if [[ "$attempts_raw" =~ ^[0-9]+$ ]] && [ "${#attempts_raw}" -le 10 ]; then
    attempts=$((10#$attempts_raw))
  else
    invalid="true"
    attempts=0
  fi
  if [[ "$interval_raw" =~ ^[0-9]+$ ]] && [ "${#interval_raw}" -le 10 ]; then
    interval=$((10#$interval_raw))
  else
    invalid="true"
    interval=0
  fi

  if [ "$attempts" -lt 1 ] || [ "$attempts" -gt $((MAX_HEALTHCHECK_WINDOW_SECONDS + 1)) ] ||
    [ "$interval" -lt 1 ] || [ "$interval" -gt "$MAX_HEALTHCHECK_WINDOW_SECONDS" ]; then
    invalid="true"
  fi

  window=0
  if [ "$invalid" = "false" ]; then
    window=$(((attempts - 1) * interval))
    if [ "$window" -gt "$MAX_HEALTHCHECK_WINDOW_SECONDS" ]; then
      invalid="true"
    fi
  fi

  if [ "$invalid" = "true" ]; then
    echo "Invalid NORA_UPGRADE health-check overrides (attempts='${attempts_raw}', interval='${interval_raw}s'); using ${DEFAULT_HEALTHCHECK_ATTEMPTS} attempts every ${DEFAULT_HEALTHCHECK_INTERVAL_SECONDS}s (${DEFAULT_HEALTHCHECK_WINDOW_SECONDS}s from first to final attempt). Values must be positive integers with a first-to-final window no greater than ${MAX_HEALTHCHECK_WINDOW_SECONDS}s." >&2
    attempts="$DEFAULT_HEALTHCHECK_ATTEMPTS"
    interval="$DEFAULT_HEALTHCHECK_INTERVAL_SECONDS"
    window=$(((attempts - 1) * interval))
  fi

  printf '%s %s %s\n' "$attempts" "$interval" "$window"
}

wait_for_backend_health() {
  local attempts interval window
  local service="${NORA_UPGRADE_HEALTHCHECK_SERVICE:-backend-api}"
  local public_url="${NORA_UPGRADE_PUBLIC_HEALTH_URL:-}"
  read -r attempts interval window < <(resolve_healthcheck_budget)

  echo "Waiting for ${service} health: ${attempts} attempts every ${interval}s (${window}s from first to final attempt)."
  for attempt in $(seq 1 "$attempts"); do
    if docker compose "${COMPOSE_ARGS[@]}" exec -T "$service" \
      node -e "require('http').get('http://localhost:4000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
      echo "${service} is healthy."
      break
    fi

    if [ "$attempt" -eq "$attempts" ]; then
      fail_step 30 "${service} did not become healthy after ${attempts} attempts every ${interval}s (${window}s first-to-final window)"
      return $?
    fi

    sleep "$interval"
  done

  if [ -n "$public_url" ]; then
    echo "Checking public health URL ${public_url}: ${attempts} attempts every ${interval}s (${window}s from first to final attempt)."
    for attempt in $(seq 1 "$attempts"); do
      if curl -fsS "$public_url" >/dev/null; then
        echo "Public health URL is reachable."
        return 0
      fi

      if [ "$attempt" -eq "$attempts" ]; then
        fail_step 31 "Public health URL did not become reachable after ${attempts} attempts every ${interval}s (${window}s first-to-final window)"
        return $?
      fi

      sleep "$interval"
    done
  fi
}

run_upgrade() {
  set -e

  if [ -z "$WORKSPACE" ]; then
    fail_step 10 "NORA_HOST_REPO_DIR is required"
    return $?
  fi

  cd "$WORKSPACE"
  git config --global --add safe.directory "$WORKSPACE"

  local env_file="${NORA_ENV_FILE:-.env}"
  local compose_files
  compose_files="$(resolve_compose_files_from_env "$env_file")"

  if [ ! -f "$env_file" ]; then
    fail_step 21 "Missing deploy env file: ${env_file}"
    return $?
  fi

  for required_key in JWT_SECRET ENCRYPTION_KEY DB_PASSWORD; do
    if ! grep -Eq "^${required_key}=.+" "$env_file"; then
      fail_step 22 "Deploy env file ${env_file} is missing required key: ${required_key}"
      return $?
    fi
  done

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Tracked local changes:"
    git status --short --untracked-files=no
    fail_step 20 "Refusing to upgrade because the host Nora checkout has uncommitted tracked changes."
    return $?
  fi

  update_status "fetching"
  echo "Fetching Nora source from ${NORA_UPGRADE_REPO}..."
  git remote remove nora-upgrade >/dev/null 2>&1 || true
  git remote add nora-upgrade "$NORA_UPGRADE_REPO"
  git fetch --prune --tags nora-upgrade '+refs/heads/*:refs/remotes/nora-upgrade/*' '+refs/tags/*:refs/tags/*'

  resolve_target_ref || {
    fail_step 24 "Could not resolve target ref from ${NORA_UPGRADE_TARGET_VERSION:-${NORA_UPGRADE_REF:-master}}"
    return $?
  }

  update_status "applying"
  echo "Applying ${TARGET_REF}..."
  local current_branch
  current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  if [ -n "$current_branch" ]; then
    git merge --ff-only "$TARGET_REF"
  else
    git checkout --detach "$TARGET_REF"
  fi

  # Reload the runner from the newly merged checkout exactly once. This keeps
  # upgrade behavior and compose-layer migration aligned with the target
  # release even when the initiating backend container still has older code.
  if [ "${NORA_UPGRADE_REEXECUTED:-0}" != "1" ] && [ -f "$WORKSPACE/infra/run-release-upgrade.sh" ]; then
    export NORA_UPGRADE_REEXECUTED=1
    exec bash "$WORKSPACE/infra/run-release-upgrade.sh"
  fi

  local version commit
  version="${TARGET_VERSION_RESOLVED:-${NORA_UPGRADE_TARGET_VERSION:-$(git describe --tags --always)}}"
  commit="$(git rev-parse HEAD)"
  if [ -f infra/update-release-env.sh ]; then
    bash infra/update-release-env.sh "$env_file" "$version" "$commit" "${NORA_UPGRADE_REPO_SLUG:-}"
  fi

  compose_files="$(resolve_compose_files_from_env "$env_file")"
  update_status "building"
  if [ -f setup.sh ] && [ "${NORA_UPGRADE_USE_SETUP:-true}" != "false" ]; then
    echo "Migrating install configuration and rebuilding through setup.sh --update..."
    bash setup.sh --update
    compose_files="$(resolve_compose_files_from_env "$env_file")"
  else
    if [ ! -f scripts/materialize-compose-secrets.sh ]; then
      fail_step 25 "Missing scripts/materialize-compose-secrets.sh; cannot prepare read-only Compose secrets"
      return $?
    fi
    bash scripts/materialize-compose-secrets.sh "$env_file"
    bash infra/render-public-nginx.sh "$env_file" "$compose_files"
    echo "Rebuilding and restarting Nora services..."
  fi

  build_compose_args "$env_file" "$compose_files" || return $?
  if [ ! -f setup.sh ] || [ "${NORA_UPGRADE_USE_SETUP:-true}" = "false" ]; then
    echo "Pre-validating nginx configuration..."
    docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --interactive=false -T nginx nginx -t
    docker compose "${COMPOSE_ARGS[@]}" up -d --build
    echo "Recreating nginx so generated configuration mounts are refreshed..."
    docker compose "${COMPOSE_ARGS[@]}" up -d --force-recreate --no-deps nginx
    docker compose "${COMPOSE_ARGS[@]}" exec -T nginx nginx -t
  fi
  docker compose "${COMPOSE_ARGS[@]}" ps

  update_status "health_checking"
  wait_for_backend_health || return $?

  echo "Nora direct GitHub upgrade completed."
}

{
  echo "Starting Nora direct GitHub upgrade job ${NORA_UPGRADE_JOB_ID:-unknown}"
  echo "Workspace: ${WORKSPACE:-not configured}"
  echo "Env file: ${NORA_ENV_FILE:-.env}"
  echo "Compose files: ${NORA_UPGRADE_COMPOSE_FILES:-docker-compose.yml}"
  echo ""
} >> "$LOG_FILE" 2>&1

set +e
run_upgrade >> "$LOG_FILE" 2>&1
exit_code=$?
set -e

if [ "$exit_code" -eq 0 ]; then
  update_status "succeeded" "$exit_code" ""
else
  update_status "failed" "$exit_code" "${UPGRADE_ERROR:-Nora upgrade runner exited with ${exit_code}}"
fi

exit "$exit_code"
