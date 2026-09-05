#!/usr/bin/env bash
# ============================================================
# Nora — One-line installer & setup
# ============================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh | bash
#   — or —
#   bash setup.sh        (from inside the repo)
#   bash setup.sh --update
#   bash setup.sh --clean-reinstall
#
# Clones the repo (if needed), generates secrets and database
# credentials, configures the platform, and starts Nora.
# ============================================================

set -euo pipefail

ENV_FILE=".env"
ENV_BACKUP_FILE=""
NORA_GITHUB_REPO_SLUG="solomon2773/nora"
PUBLIC_NGINX_TEMPLATE="infra/nginx_public.conf.template"
TLS_NGINX_TEMPLATE="infra/nginx_tls.conf"
PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE="infra/docker-compose.public-prod.yml"
TLS_COMPOSE_OVERRIDE_TEMPLATE="infra/docker-compose.public-tls.yml"
PUBLIC_NGINX_CONF="nginx.public.conf"
COMPOSE_OVERRIDE_FILE="docker-compose.override.yml"
SETUP_MODE=""
DEFAULT_HEALTHCHECK_ATTEMPTS=221
DEFAULT_HEALTHCHECK_INTERVAL_SECONDS=3
LEGACY_HEALTHCHECK_ATTEMPTS=40
LEGACY_HEALTHCHECK_INTERVAL_SECONDS=3
MAX_HEALTHCHECK_WINDOW_SECONDS=3900
DEFAULT_HEALTHCHECK_WINDOW_SECONDS=$(((DEFAULT_HEALTHCHECK_ATTEMPTS - 1) * DEFAULT_HEALTHCHECK_INTERVAL_SECONDS))
MIN_COMPOSE_VERSION="2.24.4"
DEFAULT_COMPOSE_SECRETS_DIR=".secrets/compose"
DEFAULT_COMPOSE_PROJECT_NAME="nora"

# ── Color helpers ────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
error() { printf "${RED}[error]${NC} %s\n" "$1"; }
header(){ printf "\n${BOLD}${CYAN}── %s ──${NC}\n\n" "$1"; }

bootstrap_admin_email_is_valid() {
  local value="$1" lowered
  [[ "$value" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || return 1
  case "$value" in
    *'<'*|*'>'*|*'{{'*) return 1 ;;
  esac
  lowered="$(printf '%s' "$value" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    your_*|replace_with*|replace-with*|placeholder*) return 1 ;;
  esac
  return 0
}

bootstrap_admin_password_is_forbidden() {
  local value="$1" lowered comparable
  lowered="$(printf '%s' "$value" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    your_*|example*|sample*|placeholder*|changeme*|replace-me*|test-*|demo-*|*'<'*|*'{{'*)
      return 0
      ;;
  esac
  comparable="$(printf '%s' "$lowered" | LC_ALL=C tr -cd 'a-z0-9')"
  case "$comparable" in
    admin123*|administrator*|password*|changeme*|letmein*|welcome1*|qwerty123*) return 0 ;;
  esac
  return 1
}

usage() {
  cat <<'EOF'
Usage: bash setup.sh [--install | --update | --clean-reinstall]

Modes:
  --install          Configure Nora and start the compose stack.
  --update           Pull code when possible and restart app services without
                     deleting .env, compose volumes, or provisioned instances.
  --clean-reinstall  Recreate local compose state and remove local Nora agent
                     containers. External Kubernetes/VM backends are untouched.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install)
      if [ -n "$SETUP_MODE" ]; then
        error "Choose only one setup mode."
        exit 1
      fi
      SETUP_MODE="install"
      ;;
    --update)
      if [ -n "$SETUP_MODE" ]; then
        error "Choose only one setup mode."
        exit 1
      fi
      SETUP_MODE="update"
      ;;
    --clean-reinstall)
      if [ -n "$SETUP_MODE" ]; then
        error "Choose only one setup mode."
        exit 1
      fi
      SETUP_MODE="clean-reinstall"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage >&2
      exit 1
      ;;
  esac
  shift
done

write_public_nginx_conf() {
  local template="$1"
  local domain="$2"
  sed "s/\${DOMAIN}/${domain}/g" "$template" > "$PUBLIC_NGINX_CONF"
}

write_compose_override() {
  local template="$1"
  cp "$template" "$COMPOSE_OVERRIDE_FILE"
}

secure_env_file_permissions() {
  local env_path="$1" mode
  [ -f "$env_path" ] || return 0

  if ! chmod 600 "$env_path"; then
    error "Could not restrict $env_path to owner read/write access."
    return 1
  fi
  mode="$(stat -c '%a' "$env_path" 2>/dev/null || stat -f '%Lp' "$env_path" 2>/dev/null || true)"
  if [ "$mode" != "600" ]; then
    error "Refusing to continue because $env_path permissions are $mode instead of 600."
    return 1
  fi
}

compose_version_is_supported() {
  local raw="${1#v}" major minor patch
  raw="${raw%%[-+]*}"
  IFS=. read -r major minor patch <<EOF
$raw
EOF
  major="${major:-0}"
  minor="${minor:-0}"
  patch="${patch:-0}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -gt 2 ] ||
    { [ "$major" -eq 2 ] && { [ "$minor" -gt 24 ] || { [ "$minor" -eq 24 ] && [ "$patch" -ge 4 ]; }; }; }
}

set_env_value() {
  local env_path="$1" name="$2" value="$3" tmp_file
  tmp_file="$(mktemp "${env_path}.tmp.XXXXXX")"
  awk -v name="$name" -v value="$value" '
    BEGIN { wrote = 0 }
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      if (!wrote) {
        print name "=" value
        wrote = 1
      }
      next
    }
    { print }
    END {
      if (!wrote) print name "=" value
    }
  ' "$env_path" > "$tmp_file"
  mv "$tmp_file" "$env_path"
  secure_env_file_permissions "$env_path"
}

resolve_docker_gid() {
  if [ -e /var/run/docker.sock ]; then
    stat -c '%g' /var/run/docker.sock 2>/dev/null ||
      stat -f '%g' /var/run/docker.sock 2>/dev/null ||
      printf '0\n'
  else
    printf '0\n'
  fi
}

normalize_generated_compose_override() {
  local source_file="$1"
  sed -E \
    -e '/NORA_KUBECONFIGS_DIR.*\/kubeconfigs:ro/d' \
    -e '/NORA_HOST_REPO_DIR.*\/nora-host-repo:ro/d' \
    -e '/^[[:space:]]*NODE_PATH:[[:space:]]*\/app\/node_modules[[:space:]]*$/d' \
    "$source_file"
}

compose_override_matches_generated_history() {
  local override_file="$1" template_file="$2"
  local normalized_override raw_candidate normalized_candidate commit

  normalized_override="$(mktemp)"
  raw_candidate="$(mktemp)"
  normalized_candidate="$(mktemp)"
  normalize_generated_compose_override "$override_file" > "$normalized_override"

  if [ -f "$template_file" ]; then
    normalize_generated_compose_override "$template_file" > "$normalized_candidate"
    if cmp -s "$normalized_override" "$normalized_candidate"; then
      rm -f "$normalized_override" "$raw_candidate" "$normalized_candidate"
      return 0
    fi
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    while IFS= read -r commit; do
      [ -n "$commit" ] || continue
      if git show "${commit}:${template_file}" > "$raw_candidate" 2>/dev/null; then
        normalize_generated_compose_override "$raw_candidate" > "$normalized_candidate"
        if cmp -s "$normalized_override" "$normalized_candidate"; then
          rm -f "$normalized_override" "$raw_candidate" "$normalized_candidate"
          return 0
        fi
      fi
    done < <(git log --format=%H --all -- "$template_file" 2>/dev/null || true)
  fi

  rm -f "$normalized_override" "$raw_candidate" "$normalized_candidate"
  return 1
}

backup_legacy_compose_override() {
  local timestamp candidate suffix
  timestamp="$(date -u +%Y%m%d-%H%M%SZ)"
  candidate="${COMPOSE_OVERRIDE_FILE}.legacy-${timestamp}"
  suffix=1
  while [ -e "$candidate" ]; do
    candidate="${COMPOSE_OVERRIDE_FILE}.legacy-${timestamp}.${suffix}"
    suffix=$((suffix + 1))
  done
  cp "$COMPOSE_OVERRIDE_FILE" "$candidate"
  printf '%s\n' "$candidate"
}

clear_public_access_artifacts() {
  rm -f "$PUBLIC_NGINX_CONF" "$COMPOSE_OVERRIDE_FILE"
}

backup_existing_env_file() {
  local env_path="$1"
  local env_dir env_name timestamp candidate suffix

  env_dir="$(dirname "$env_path")"
  env_name="$(basename "$env_path")"
  timestamp="$(date -u +"%Y%m%d-%H%M%SZ")"
  candidate="${env_name}.backup-${timestamp}"
  if [ "$env_dir" != "." ]; then
    candidate="${env_dir}/${candidate}"
  fi

  suffix=1
  while [ -e "$candidate" ]; do
    candidate="${env_name}.backup-${timestamp}.${suffix}"
    if [ "$env_dir" != "." ]; then
      candidate="${env_dir}/${candidate}"
    fi
    suffix=$((suffix + 1))
  done

  secure_env_file_permissions "$env_path"
  cp "$env_path" "$candidate"
  secure_env_file_permissions "$candidate"
  printf "%s\n" "$candidate"
}

update_source_checkout() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  if [ -n "$(git status --porcelain)" ]; then
    warn "Skipping git pull because this worktree has uncommitted changes."
    return 0
  fi

  local branch
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$branch" ]; then
    info "Skipping git pull because this checkout is detached."
    return 0
  fi

  if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
    info "Pulling latest code for ${branch}..."
    git pull --ff-only
  else
    info "Skipping git pull because ${branch} has no upstream."
  fi
}

refresh_release_tags() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  local branch remote
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -n "$branch" ]; then
    remote="$(git config --get "branch.${branch}.remote" 2>/dev/null || true)"
  fi
  remote="${remote:-$(git remote 2>/dev/null | sed -n '1p' || true)}"
  if [ -z "$remote" ]; then
    warn "Skipping release tag refresh because this checkout has no Git remote."
    return 0
  fi

  info "Fetching release tags from ${remote}..."
  if git fetch --tags --prune "$remote"; then
    ok "Release tags refreshed"
  else
    warn "Release tag refresh failed; Admin Settings may show stale release tracking."
  fi
}

resolve_current_release_commit() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  git rev-parse HEAD 2>/dev/null || true
}

resolve_current_release_version() {
  local candidate_tag exact_tag product_version_pattern

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  product_version_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  exact_tag=""
  while IFS= read -r candidate_tag; do
    if [[ "$candidate_tag" =~ $product_version_pattern ]]; then
      exact_tag="$(printf '%s\n%s\n' "$exact_tag" "$candidate_tag" | sed '/^$/d' | sort -V | tail -n 1)"
    fi
  done < <(git tag --points-at HEAD 2>/dev/null || true)

  if [ -n "$exact_tag" ]; then
    printf "%s\n" "$exact_tag"
  fi
}

stamp_release_tracking_env() {
  local env_path="$1"
  local current_commit current_version

  if [ ! -f "$env_path" ]; then
    return 0
  fi

  current_commit="$(resolve_current_release_commit)"
  if [ -z "$current_commit" ]; then
    warn "Skipping release tracking stamp because the current Git commit could not be resolved."
    return 0
  fi

  current_version="$(resolve_current_release_version)"
  if [ ! -f "infra/update-release-env.sh" ]; then
    warn "Skipping release tracking stamp because infra/update-release-env.sh is missing."
    return 0
  fi

  bash infra/update-release-env.sh "$env_path" "$current_version" "$current_commit" "$NORA_GITHUB_REPO_SLUG"
  secure_env_file_permissions "$env_path"
  ok "Release tracking stamped: ${current_version:-source checkout} @ ${current_commit:0:12}"
}

env_has_agent_hub_hash_secret() {
  local env_path="$1"

  awk -F= '
    /^[[:space:]]*NORA_AGENT_HUB_API_KEY_HASH_SECRET[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value == "\"\"" || value == sprintf("%c%c", 39, 39)) {
        value = ""
      }
      if (value != "") {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  ' "$env_path"
}

ensure_agent_hub_hash_secret_env() {
  local env_path="$1" env_dir secret tmp_file

  if [ ! -f "$env_path" ]; then
    return 0
  fi
  secure_env_file_permissions "$env_path"

  if env_has_agent_hub_hash_secret "$env_path"; then
    info "NORA_AGENT_HUB_API_KEY_HASH_SECRET already set; preserving existing value."
    return 0
  fi

  secret="$(openssl rand -hex 32)"
  env_dir="$(dirname "$env_path")"
  tmp_file="$(mktemp "$env_dir/.nora-env.XXXXXX")"
  awk -v secret="$secret" '
    /^[[:space:]]*NORA_AGENT_HUB_API_KEY_HASH_SECRET[[:space:]]*=/ {
      if (!wrote_secret) {
        print "NORA_AGENT_HUB_API_KEY_HASH_SECRET=" secret
        wrote_secret = 1
      }
      next
    }
    { print }
    END {
      if (!wrote_secret) {
        if (NR > 0) print ""
        print "NORA_AGENT_HUB_API_KEY_HASH_SECRET=" secret
      }
    }
  ' "$env_path" > "$tmp_file"
  mv "$tmp_file" "$env_path"
  secure_env_file_permissions "$env_path"
  ok "NORA_AGENT_HUB_API_KEY_HASH_SECRET generated (64-char hex)"
}

ensure_api_key_hash_secret_env() {
  local env_path="$1" existing fallback
  [ -f "$env_path" ] || return 0
  secure_env_file_permissions "$env_path"

  existing="$(read_env_value "$env_path" "NORA_API_KEY_HASH_SECRET" "")"
  if [ -n "$existing" ]; then
    info "NORA_API_KEY_HASH_SECRET already set; preserving existing value."
    return 0
  fi

  # Match lib/apiTokens.ts's legacy fallback order so adding the primary name
  # does not invalidate tokens already hashed by an existing installation.
  fallback="$(read_env_value "$env_path" "NORA_AGENT_HUB_API_KEY_HASH_SECRET" "")"
  [ -n "$fallback" ] || fallback="$(read_env_value "$env_path" "ENCRYPTION_KEY" "")"
  [ -n "$fallback" ] || fallback="$(read_env_value "$env_path" "JWT_SECRET" "")"
  [ -n "$fallback" ] || fallback="$(openssl rand -hex 32)"
  set_env_value "$env_path" "NORA_API_KEY_HASH_SECRET" "$fallback"
  ok "NORA_API_KEY_HASH_SECRET populated from the existing token-hash fallback"
}

env_has_backup_encryption_key() {
  local env_path="$1"

  awk -F= '
    /^[[:space:]]*NORA_BACKUP_ENCRYPTION_KEY[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value == "\"\"" || value == sprintf("%c%c", 39, 39)) {
        value = ""
      }
      if (value != "") {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  ' "$env_path"
}

ensure_backup_encryption_key_env() {
  local env_path="$1" env_dir secret tmp_file

  if [ ! -f "$env_path" ]; then
    return 0
  fi
  secure_env_file_permissions "$env_path"

  if env_has_backup_encryption_key "$env_path"; then
    info "NORA_BACKUP_ENCRYPTION_KEY already set; preserving existing value."
    return 0
  fi

  secret="$(openssl rand -hex 32)"
  env_dir="$(dirname "$env_path")"
  tmp_file="$(mktemp "$env_dir/.nora-env.XXXXXX")"
  awk -v secret="$secret" '
    /^[[:space:]]*NORA_BACKUP_ENCRYPTION_KEY[[:space:]]*=/ {
      if (!wrote_secret) {
        print "NORA_BACKUP_ENCRYPTION_KEY=" secret
        wrote_secret = 1
      }
      next
    }
    /^[[:space:]]*ENCRYPTION_KEY[[:space:]]*=/ {
      print
      if (!wrote_secret) {
        print "NORA_BACKUP_ENCRYPTION_KEY=" secret
        wrote_secret = 1
      }
      next
    }
    { print }
    END {
      if (!wrote_secret) {
        if (NR > 0) print ""
        print "NORA_BACKUP_ENCRYPTION_KEY=" secret
      }
    }
  ' "$env_path" > "$tmp_file"
  mv "$tmp_file" "$env_path"
  secure_env_file_permissions "$env_path"
  ok "NORA_BACKUP_ENCRYPTION_KEY generated (64-char hex)"
}

materialize_compose_secret_files() {
  local env_path="$1" secrets_dir
  secrets_dir="$(read_env_value "$env_path" "NORA_COMPOSE_SECRETS_DIR" "$DEFAULT_COMPOSE_SECRETS_DIR")"
  if [ ! -f "scripts/materialize-compose-secrets.sh" ]; then
    error "Missing scripts/materialize-compose-secrets.sh; cannot prepare read-only Compose secrets."
    return 1
  fi
  NORA_MATERIALIZE_QUIET=true bash scripts/materialize-compose-secrets.sh "$env_path"
  set_env_value "$env_path" "NORA_COMPOSE_SECRETS_DIR" "$secrets_dir"
  ok "Compose secret files refreshed under $secrets_dir (owner-only directory)"
}

resolve_compose_project_name() {
  local env_path="${1:-$ENV_FILE}" project_name
  project_name="$(read_env_value "$env_path" "COMPOSE_PROJECT_NAME" "$DEFAULT_COMPOSE_PROJECT_NAME")"
  if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    error "Invalid COMPOSE_PROJECT_NAME '$project_name'; use lowercase letters, digits, hyphens, or underscores."
    return 1
  fi
  printf '%s\n' "$project_name"
}

remove_local_agent_containers() {
  local project_name="$1" compose_network="${1}_default" containers
  containers="$(
    {
      docker ps -a --filter "label=openclaw.agent.id" --filter "network=$compose_network" -q 2>/dev/null || true
      docker ps -a --filter "label=nora.agent.id" --filter "network=$compose_network" -q 2>/dev/null || true
    } | sort -u
  )"

  if [ -z "$containers" ]; then
    info "No local Nora agent containers found on $compose_network."
    return 0
  fi

  info "Removing local Nora agent containers attached to $compose_network..."
  while IFS= read -r container_id; do
    [ -z "$container_id" ] && continue
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  done <<EOF
$containers
EOF
  ok "Removed local Nora agent containers"
}

clean_reinstall_state() {
  local project_name
  project_name="$(resolve_compose_project_name "$ENV_FILE")"
  warn "Clean reinstall selected: local compose containers and volumes will be removed."
  info "External Kubernetes, Proxmox, NemoClaw, and other VM resources will not be touched."
  remove_local_agent_containers "$project_name"
  docker compose -p "$project_name" down -v --remove-orphans 2>/dev/null || true
  ok "Local Nora compose state cleaned for project $project_name"
}

start_compose_stack() {
  echo ""
  info "Starting Nora (docker compose up -d --build)..."
  info "Preserving Docker volumes and provisioned agent instances."
  echo ""
  info "Pre-validating nginx configuration..."
  docker compose run --rm --no-deps --interactive=false -T nginx nginx -t
  docker compose up -d --build
  info "Recreating nginx so generated configuration mounts are refreshed..."
  docker compose up -d --force-recreate --no-deps nginx
  docker compose exec -T nginx nginx -t </dev/null
  ok "Nginx configuration activated"
  verify_compose_runtime_permissions
  echo ""
  ok "Nora is running!"
}

run_compose_node_probe() {
  local service="$1" description="$2" script="$3" attempts="$4" interval="$5" window="$6"
  local attempt
  info "Waiting for ${service} probe: ${attempts} attempts every ${interval}s (${window}s from first to final attempt)."
  for attempt in $(seq 1 "$attempts"); do
    if docker compose exec -T "$service" node -e "$script" </dev/null >/dev/null 2>&1; then
      ok "$description"
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$interval"
    fi
  done

  docker compose exec -T "$service" node -e "$script" </dev/null || true
  error "$description failed after ${attempts} attempts every ${interval}s (${window}s first-to-final window). Inspect: docker compose logs --tail=100 $service"
  return 1
}

verify_compose_runtime_permissions() {
  local docker_probe backend_volume_probe backup_volume_probe attempts interval window
  info "Verifying runtime permissions and upgrade mounts..."

  read -r attempts interval window < <(resolve_healthcheck_budget)

  docker_probe='const http=require("http");const request=http.request({socketPath:"/var/run/docker.sock",path:"/_ping",method:"GET"},response=>{let body="";response.setEncoding("utf8");response.on("data",chunk=>body+=chunk);response.on("end",()=>process.exit(response.statusCode===200&&body.trim()==="OK"?0:1));});request.setTimeout(5000,()=>request.destroy(new Error("Docker socket timeout")));request.on("error",error=>{console.error(error.message);process.exit(1);});request.end();'
  backend_volume_probe='const fs=require("fs");fs.accessSync("/nora-host-repo/infra/run-release-upgrade.sh",fs.constants.R_OK);const path=`/var/lib/nora-upgrade/.nora-write-probe-${process.pid}`;try{fs.writeFileSync(path,"ok",{mode:0o600});fs.unlinkSync(path);}finally{try{fs.unlinkSync(path);}catch{}}'
  backup_volume_probe='const fs=require("fs");const path=`/var/lib/nora-backups/.nora-write-probe-${process.pid}`;try{fs.writeFileSync(path,"ok",{mode:0o600});fs.unlinkSync(path);}finally{try{fs.unlinkSync(path);}catch{}}'

  run_compose_node_probe "worker-provisioner" "Provisioner Docker socket access verified" "$docker_probe" "$attempts" "$interval" "$window"
  run_compose_node_probe "backend-api" "Upgrade checkout and state volume verified" "$backend_volume_probe" "$attempts" "$interval" "$window"
  run_compose_node_probe "worker-backup" "Backup volume write access verified" "$backup_volume_probe" "$attempts" "$interval" "$window"
}

read_env_value() {
  local env_path="$1" name="$2" default_value="$3" line value first last

  if [ ! -f "$env_path" ]; then
    printf "%s\n" "$default_value"
    return 0
  fi

  line="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$env_path" 2>/dev/null | tail -n 1 || true)"
  if [ -z "$line" ]; then
    printf "%s\n" "$default_value"
    return 0
  fi

  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="$(decode_compose_env_literal "$value")"

  printf "%s\n" "$value"
}

compose_env_literal() {
  local value="$1" escaped
  case "$value" in
    *$'\n'* | *$'\r'*)
      error "Compose environment values cannot contain newlines."
      return 1
      ;;
  esac

  if [ -n "$value" ] && { [ "${value: -1}" = "\\" ] || [[ "$value" == *"\\'"* ]]; }; then
    escaped="${value//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    escaped="${escaped//\$/\$\$}"
    printf '"%s"\n' "$escaped"
    return 0
  fi

  escaped="${value//\'/\\\'}"
  printf "'%s'\n" "$escaped"
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

read_env_value_with_alias() {
  local env_path="$1" name="$2" alias_name="$3" default_value="$4" value
  value="$(read_env_value "$env_path" "$name" "")"
  if [ -z "$value" ] && [ -n "$alias_name" ]; then
    value="$(read_env_value "$env_path" "$alias_name" "")"
  fi
  printf '%s\n' "${value:-$default_value}"
}

nemoclaw_image_ref_is_mutable() {
  local reference="$1" last_component tag
  reference="${reference#"${reference%%[![:space:]]*}"}"
  reference="${reference%"${reference##*[![:space:]]}"}"
  [ -n "$reference" ] || return 1
  [[ "$reference" == *"@"* ]] && return 1
  last_component="${reference##*/}"
  [[ "$last_component" != *":"* ]] && return 0
  tag="${last_component##*:}"
  case "$tag" in
    [Ll][Aa][Tt][Ee][Ss][Tt]) return 0 ;;
    *) return 1 ;;
  esac
}

csv_value_is_enabled() {
  local csv="$1" expected="$2" item
  local -a items=()
  IFS=',' read -r -a items <<< "$csv"
  for item in "${items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [ "$item" = "$expected" ] && return 0
  done
  return 1
}

ensure_nemoclaw_sandbox_image() {
  local image="$1" image_present="false"
  image="${image#"${image%%[![:space:]]*}"}"
  image="${image%"${image##*[![:space:]]}"}"
  if [ -z "$image" ]; then
    error "NEMOCLAW_SANDBOX_IMAGE must not be empty"
    return 1
  fi

  if [ "$image" = "nora-nemoclaw-agent:local" ]; then
    echo ""
    info "Building nora-nemoclaw-agent:local (OpenShell sandbox + tsx)..."
    echo ""
    if ! docker build \
      -f agent-runtime/Dockerfile.nemoclaw-agent \
      -t nora-nemoclaw-agent:local \
      agent-runtime/; then
      error "Failed to build nora-nemoclaw-agent:local"
      return 1
    fi
    ok "NemoClaw sandbox image ready"
    return 0
  fi

  if docker image inspect "$image" >/dev/null 2>&1; then
    image_present="true"
  fi
  if [ "$image_present" = "true" ] && ! nemoclaw_image_ref_is_mutable "$image"; then
    info "Using existing immutable NemoClaw sandbox image"
    ok "NemoClaw sandbox image ready"
    return 0
  fi

  if [ "$image_present" = "true" ]; then
    info "Refreshing mutable NemoClaw sandbox image..."
  else
    info "Pulling missing NemoClaw sandbox image..."
  fi
  if ! docker pull "$image"; then
    error "Failed to pull configured NemoClaw sandbox image"
    return 1
  fi
  ok "NemoClaw sandbox image ready"
}

ensure_signup_protection_env() {
  local env_path="$1"
  local signup_enabled burst_max burst_window daily_max daily_window provider turnstile_site_key
  local turnstile_secret recaptcha_site_key recaptcha_secret

  signup_enabled="$(read_env_value "$env_path" "SIGNUP_ENABLED" "true")"
  burst_max="$(read_env_value "$env_path" "SIGNUP_RATE_LIMIT_BURST_MAX" "5")"
  burst_window="$(read_env_value "$env_path" "SIGNUP_RATE_LIMIT_BURST_WINDOW_MS" "600000")"
  daily_max="$(read_env_value "$env_path" "SIGNUP_RATE_LIMIT_DAILY_MAX" "20")"
  daily_window="$(read_env_value "$env_path" "SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS" "86400000")"
  provider="$(read_env_value_with_alias "$env_path" "SIGNUP_BOT_PROTECTION_PROVIDER" "NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER" "none")"
  turnstile_site_key="$(read_env_value_with_alias "$env_path" "SIGNUP_TURNSTILE_SITE_KEY" "NEXT_PUBLIC_SIGNUP_TURNSTILE_SITE_KEY" "")"
  turnstile_secret="$(read_env_value "$env_path" "SIGNUP_TURNSTILE_SECRET" "")"
  recaptcha_site_key="$(read_env_value_with_alias "$env_path" "SIGNUP_RECAPTCHA_SITE_KEY" "NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY" "")"
  recaptcha_secret="$(read_env_value "$env_path" "SIGNUP_RECAPTCHA_SECRET" "")"

  set_env_value "$env_path" "SIGNUP_ENABLED" "$signup_enabled"
  set_env_value "$env_path" "SIGNUP_RATE_LIMIT_BURST_MAX" "$burst_max"
  set_env_value "$env_path" "SIGNUP_RATE_LIMIT_BURST_WINDOW_MS" "$burst_window"
  set_env_value "$env_path" "SIGNUP_RATE_LIMIT_DAILY_MAX" "$daily_max"
  set_env_value "$env_path" "SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS" "$daily_window"
  set_env_value "$env_path" "SIGNUP_BOT_PROTECTION_PROVIDER" "$provider"
  set_env_value "$env_path" "SIGNUP_TURNSTILE_SITE_KEY" "$turnstile_site_key"
  set_env_value "$env_path" "SIGNUP_TURNSTILE_SECRET" "$turnstile_secret"
  set_env_value "$env_path" "SIGNUP_RECAPTCHA_SITE_KEY" "$recaptcha_site_key"
  set_env_value "$env_path" "SIGNUP_RECAPTCHA_SECRET" "$recaptcha_secret"
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

resolve_healthcheck_budget() {
  local attempts_raw interval_raw attempts interval window invalid="false"

  attempts_raw="${NORA_UPGRADE_HEALTHCHECK_ATTEMPTS:-}"
  interval_raw="${NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS:-}"
  if [ -z "$attempts_raw" ]; then
    attempts_raw="$(read_env_value "$ENV_FILE" "NORA_UPGRADE_HEALTHCHECK_ATTEMPTS" "$DEFAULT_HEALTHCHECK_ATTEMPTS")"
  fi
  if [ -z "$interval_raw" ]; then
    interval_raw="$(read_env_value "$ENV_FILE" "NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS" "$DEFAULT_HEALTHCHECK_INTERVAL_SECONDS")"
  fi
  attempts_raw="$(trim_whitespace "$attempts_raw")"
  interval_raw="$(trim_whitespace "$interval_raw")"
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
    warn "Invalid NORA_UPGRADE health-check overrides (attempts='${attempts_raw}', interval='${interval_raw}s'); using ${DEFAULT_HEALTHCHECK_ATTEMPTS} attempts every ${DEFAULT_HEALTHCHECK_INTERVAL_SECONDS}s (${DEFAULT_HEALTHCHECK_WINDOW_SECONDS}s from first to final attempt). Values must be positive integers with a first-to-final window no greater than ${MAX_HEALTHCHECK_WINDOW_SECONDS}s." >&2
    attempts="$DEFAULT_HEALTHCHECK_ATTEMPTS"
    interval="$DEFAULT_HEALTHCHECK_INTERVAL_SECONDS"
    window=$(((attempts - 1) * interval))
  fi

  printf '%s %s %s\n' "$attempts" "$interval" "$window"
}

migrate_legacy_healthcheck_defaults() {
  local env_path="$1" attempts interval
  attempts="$(trim_whitespace "$(read_env_value "$env_path" "NORA_UPGRADE_HEALTHCHECK_ATTEMPTS" "")")"
  interval="$(trim_whitespace "$(read_env_value "$env_path" "NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS" "")")"
  if [ "$attempts" = "$LEGACY_HEALTHCHECK_ATTEMPTS" ] &&
    [ "$interval" = "$LEGACY_HEALTHCHECK_INTERVAL_SECONDS" ]; then
    set_env_value "$env_path" "NORA_UPGRADE_HEALTHCHECK_ATTEMPTS" "$DEFAULT_HEALTHCHECK_ATTEMPTS"
    set_env_value "$env_path" "NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS" "$DEFAULT_HEALTHCHECK_INTERVAL_SECONDS"
    ok "Migrated legacy health-check budget from ${LEGACY_HEALTHCHECK_ATTEMPTS}x${LEGACY_HEALTHCHECK_INTERVAL_SECONDS}s to ${DEFAULT_HEALTHCHECK_ATTEMPTS}x${DEFAULT_HEALTHCHECK_INTERVAL_SECONDS}s (${DEFAULT_HEALTHCHECK_WINDOW_SECONDS}s first-to-final window)"
  fi
}

to_port_number() {
  local value="$1" default_value="$2" name="$3"

  if [ -z "$value" ]; then
    printf "%s\n" "$default_value"
    return 0
  fi

  if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
    printf "%s\n" "$value"
    return 0
  fi

  warn "Invalid ${name} value '${value}' — using default ${default_value}." >&2
  printf "%s\n" "$default_value"
}

test_host_port_available() {
  local port="$1" bind_address="${2:-0.0.0.0}" probe_status

  if command -v ss >/dev/null 2>&1; then
    ! ss -H -ltn 2>/dev/null | awk -v port=":${port}" '$4 ~ port "$" { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi

  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  if command -v netstat >/dev/null 2>&1; then
    ! netstat -an 2>/dev/null | awk -v port="\\.${port}" '$0 ~ /LISTEN/ && $4 ~ port "$" { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    set +e
    python3 - "$port" "$bind_address" <<'PY'
import errno
import socket
import sys

port = int(sys.argv[1])
bind_address = sys.argv[2]
sock = None
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((bind_address, port))
except OSError as exc:
    if exc.errno in (errno.EADDRINUSE, errno.EADDRNOTAVAIL):
        sys.exit(1)
    sys.exit(2)
finally:
    if sock is not None:
        sock.close()
PY
    probe_status=$?
    set -e
    case "$probe_status" in
      0) return 0 ;;
      1) return 1 ;;
      *) warn "Unable to bind-probe port ${port}; treating it as available." >&2; return 0 ;;
    esac
  fi

  if command -v python >/dev/null 2>&1; then
    set +e
    python - "$port" "$bind_address" <<'PY'
import errno
import socket
import sys

port = int(sys.argv[1])
bind_address = sys.argv[2]
sock = None
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((bind_address, port))
except OSError as exc:
    if exc.errno in (errno.EADDRINUSE, errno.EADDRNOTAVAIL):
        sys.exit(1)
    sys.exit(2)
finally:
    if sock is not None:
        sock.close()
PY
    probe_status=$?
    set -e
    case "$probe_status" in
      0) return 0 ;;
      1) return 1 ;;
      *) warn "Unable to bind-probe port ${port}; treating it as available." >&2; return 0 ;;
    esac
  fi

  warn "No local port scanner found; skipping availability probe for port ${port}." >&2
  return 0
}

compose_service_owns_port() {
  local service="$1" container_port="$2" host_port="$3" published_ports published_port

  published_ports="$(docker compose port "$service" "$container_port" 2>/dev/null || true)"
  if [ -z "$published_ports" ]; then
    return 1
  fi

  while IFS= read -r published_port; do
    case "$published_port" in
      *:"$host_port") return 0 ;;
    esac
  done <<EOF
$published_ports
EOF

  return 1
}

port_owner_summary() {
  local port="$1" owner

  if command -v lsof >/dev/null 2>&1; then
    owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { printf "%s (PID %s) on %s", $1, $2, $9; exit }')"
    if [ -n "$owner" ]; then
      printf "%s\n" "$owner"
      return 0
    fi
  fi

  if command -v ss >/dev/null 2>&1; then
    owner="$(ss -H -ltnp 2>/dev/null | awk -v port=":${port}" '$4 ~ port "$" { print; exit }')"
    if [ -n "$owner" ]; then
      printf "%s\n" "$owner"
      return 0
    fi
  fi

  if command -v netstat >/dev/null 2>&1; then
    owner="$(netstat -anp 2>/dev/null | awk -v port="[:.]${port}" '$0 ~ /LISTEN/ && $4 ~ port "$" { print; exit }')"
    if [ -n "$owner" ]; then
      printf "%s\n" "$owner"
      return 0
    fi
  fi

  printf "another process\n"
}

find_next_available_port() {
  local start_port="$1" bind_address="${2:-0.0.0.0}" candidate

  if [ "$start_port" -gt 65535 ]; then
    return 1
  fi

  for ((candidate = start_port; candidate <= 65535; candidate++)); do
    if test_host_port_available "$candidate" "$bind_address"; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done

  return 1
}

resolve_available_host_port() {
  local preferred_port="$1" purpose="$2" service="$3" container_port="$4" bind_address="${5:-0.0.0.0}"
  local port suggested_port port_answer

  port="$preferred_port"
  while true; do
    if compose_service_owns_port "$service" "$container_port" "$port" || test_host_port_available "$port" "$bind_address"; then
      printf "%s\n" "$port"
      return 0
    fi

    warn "${purpose} port ${port} is already in use by $(port_owner_summary "$port")." >&2
    if ! suggested_port="$(find_next_available_port "$((port + 1))" "$bind_address")"; then
      error "No available TCP port found after ${port}."
      exit 1
    fi
    if [ ! -r /dev/tty ]; then
      error "${purpose} port ${port} is unavailable and no interactive terminal is attached."
      error "Set the matching port variable in ${ENV_FILE} or stop the conflicting service, then re-run setup."
      exit 1
    fi
    printf "  Enter another host port [%s]: " "$suggested_port" > /dev/tty
    read -r port_answer < /dev/tty
    port_answer="${port_answer:-$suggested_port}"

    if [[ "$port_answer" =~ ^[0-9]+$ ]] && [ "$port_answer" -ge 1 ] && [ "$port_answer" -le 65535 ]; then
      port="$port_answer"
    else
      warn "Enter a TCP port between 1 and 65535." >&2
    fi
  done
}

get_nora_host_port_checks() {
  local env_path="${1:-$ENV_FILE}" nginx_http_port="${2:-}" backend_api_port

  if [ -z "$nginx_http_port" ]; then
    nginx_http_port="$(to_port_number "$(read_env_value "$env_path" "NGINX_HTTP_PORT" "8080")" "8080" "NGINX_HTTP_PORT")"
  fi
  backend_api_port="$(to_port_number "$(read_env_value "$env_path" "BACKEND_API_PORT" "4100")" "4100" "BACKEND_API_PORT")"

  printf "web gateway|nginx|80|%s|0.0.0.0|NGINX_HTTP_PORT\n" "$nginx_http_port"
  printf "backend API|backend-api|4000|%s|127.0.0.1|BACKEND_API_PORT\n" "$backend_api_port"
  printf "Postgres|postgres|5432|5433|127.0.0.1|\n"

  if [ -f "$COMPOSE_OVERRIDE_FILE" ] && grep -Eq '(^|[[:space:]"'\''])443:443($|[[:space:]"'\''])' "$COMPOSE_OVERRIDE_FILE"; then
    printf "HTTPS gateway|nginx|443|443|0.0.0.0|\n"
  fi
}

assert_nora_host_ports_available() {
  local env_path="${1:-$ENV_FILE}" nginx_http_port="${2:-}" blocked=0
  local line name service container_port host_port bind_address env_var owner hint

  while IFS='|' read -r name service container_port host_port bind_address env_var; do
    [ -z "$name" ] && continue

    if ! [[ "$host_port" =~ ^[0-9]+$ ]] || [ "$host_port" -lt 1 ] || [ "$host_port" -gt 65535 ]; then
      printf "  %s: invalid host port '%s'.\n" "$name" "$host_port"
      blocked=1
      continue
    fi

    if compose_service_owns_port "$service" "$container_port" "$host_port"; then
      continue
    fi

    if ! test_host_port_available "$host_port" "$bind_address"; then
      owner="$(port_owner_summary "$host_port")"
      hint=""
      if [ -n "$env_var" ]; then
        hint=" Set ${env_var} in ${ENV_FILE} to use a different port."
      fi
      printf "  %s: %s:%s is blocked by %s.%s\n" "$name" "$bind_address" "$host_port" "$owner" "$hint"
      blocked=1
    fi
  done < <(get_nora_host_port_checks "$env_path" "$nginx_http_port")

  if [ "$blocked" -eq 0 ]; then
    ok "Required host ports are available"
    return 0
  fi

  error "One or more required host ports are already in use."
  error "Stop the conflicting service or change the Nora host port, then re-run setup."
  exit 1
}

# ── OS detection ────────────────────────────────────────────

OS="unknown"
DISTRO=""
IS_WSL=false

detect_os() {
  case "$(uname -s)" in
    Darwin*) OS="macos" ;;
    Linux*)  OS="linux" ;;
    *)       OS="unknown" ;;
  esac

  if [ "$OS" = "linux" ]; then
    if [ -f /etc/os-release ]; then
      . /etc/os-release
      DISTRO="$ID"
    fi
    if grep -qi microsoft /proc/version 2>/dev/null; then
      IS_WSL=true
    fi
  fi
}

# ── Privilege helper ────────────────────────────────────────

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo &>/dev/null; then
    sudo "$@"
  else
    error "Root privileges required. Run as root or install sudo."
    exit 1
  fi
}

# ── Package manager helper (Linux) ─────────────────────────

pkg_install() {
  case "$DISTRO" in
    ubuntu|debian|pop|linuxmint|elementary|zorin)
      run_privileged apt-get update -qq && run_privileged apt-get install -y -qq "$@" ;;
    fedora)
      run_privileged dnf install -y -q "$@" ;;
    centos|rhel|rocky|alma|amzn)
      run_privileged yum install -y -q "$@" ;;
    arch|manjaro|endeavouros)
      run_privileged pacman -S --noconfirm --needed "$@" ;;
    alpine)
      run_privileged apk add --quiet "$@" ;;
    *)
      error "Unsupported Linux distro: $DISTRO"
      error "Manually install: $*"
      exit 1 ;;
  esac
}

# ── Install functions ───────────────────────────────────────

install_git() {
  if command -v git &>/dev/null; then return 0; fi
  info "Installing git..."
  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install git
    else
      info "Installing Xcode Command Line Tools (includes git)..."
      xcode-select --install 2>/dev/null || true
      # Wait for xcode-select to finish
      until command -v git &>/dev/null; do sleep 3; done
    fi
  else
    pkg_install git
  fi
  ok "git installed: $(git --version)"
}

install_openssl() {
  if command -v openssl &>/dev/null; then return 0; fi
  info "Installing openssl..."
  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install openssl
    else
      error "openssl is missing. Install Homebrew first: https://brew.sh"
      exit 1
    fi
  else
    pkg_install openssl
  fi
  ok "openssl installed"
}

install_docker() {
  if command -v docker &>/dev/null; then return 0; fi
  info "Installing Docker..."

  if [ "$OS" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      info "Installing Homebrew (needed for Docker Desktop)..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Add brew to PATH for Apple Silicon and Intel
      if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -f /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi
      ok "Homebrew installed"
    fi
    info "Installing Docker Desktop via Homebrew..."
    brew install --cask docker
    ok "Docker Desktop installed"
    info "Starting Docker Desktop..."
    open -a Docker
  else
    # Linux — use official convenience script (installs Docker Engine + Compose plugin)
    if [ "$IS_WSL" = true ]; then
      warn "WSL2 detected. Docker Desktop for Windows is recommended."
      info "Attempting Linux Docker Engine install as fallback..."
    fi
    curl -fsSL https://get.docker.com | run_privileged sh
    run_privileged systemctl enable --now docker 2>/dev/null || true
    # Add current user to docker group (takes effect on next login)
    if [ "$(id -u)" -ne 0 ]; then
      run_privileged usermod -aG docker "$USER" 2>/dev/null || true
      warn "Added $USER to docker group — may need to log out/in for group to take effect"
    fi
    ok "Docker Engine installed"
  fi
}

wait_for_docker() {
  local max=60 waited=0
  while [ $waited -lt $max ]; do
    if docker info &>/dev/null 2>&1; then return 0; fi
    sleep 2
    waited=$((waited + 2))
    printf "."
  done
  echo ""
  error "Docker daemon didn't start within ${max}s."
  error "Start Docker manually and re-run this script."
  exit 1
}

# ── Bootstrap: detect OS and install prerequisites ──────────

detect_os

REPO_URL="https://github.com/solomon2773/nora.git"
INSTALL_DIR="nora"

header "Pre-flight Checks"

# Ensure git (needed for clone)
install_git

# Ensure Docker + Compose
if ! command -v docker &>/dev/null; then
  install_docker
fi

# Start daemon if not running
if ! docker info &>/dev/null 2>&1; then
  if [ "$OS" = "macos" ]; then
    info "Starting Docker Desktop..."
    open -a Docker 2>/dev/null || true
  fi
  info "Waiting for Docker daemon..."
  wait_for_docker
fi
ok "Docker found: $(docker --version | head -1)"

# Verify the Compose plugin version required by the !override merge tags used
# in Nora's generated hardened overlays.
if docker compose version &>/dev/null; then
  compose_version="$(docker compose version --short 2>/dev/null || true)"
  if ! compose_version_is_supported "$compose_version"; then
    error "Docker Compose ${compose_version:-unknown} is too old; Nora requires ${MIN_COMPOSE_VERSION} or newer."
    error "Upgrade Docker Desktop or the Docker Compose plugin, then re-run setup."
    exit 1
  fi
  ok "Docker Compose found: $compose_version (minimum $MIN_COMPOSE_VERSION)"
else
  if command -v docker-compose &>/dev/null; then
    error "docker-compose v1 is unsupported; Nora requires the 'docker compose' plugin ${MIN_COMPOSE_VERSION} or newer."
  else
    error "Docker Compose ${MIN_COMPOSE_VERSION}+ is required but was not installed."
  fi
  error "Upgrade Docker Desktop or install the current Docker Compose plugin, then re-run setup."
  exit 1
fi

ok "Docker daemon is running"

# Ensure openssl
install_openssl
ok "openssl found"

# ── Clone repo if running via curl pipe ──────────────────────

if [ ! -f "docker-compose.yml" ] && [ ! -f "compose.yml" ] && [ ! -f "compose.yaml" ]; then
  header "Downloading Nora"

  if [ -d "$INSTALL_DIR" ]; then
    info "Directory '$INSTALL_DIR' already exists — pulling latest..."
    cd "$INSTALL_DIR"
    git pull --ff-only 2>/dev/null || true
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  ok "Repository ready in ./$INSTALL_DIR"
fi

# ── Select setup mode ───────────────────────────────────────

if [ -z "$SETUP_MODE" ]; then
  if [ -f "$ENV_FILE" ]; then
    header "Existing Nora Install"
    printf "  Select maintenance mode:\n"
    printf "    1) Update code only (default) — preserve .env, data volumes, and provisioned instances\n"
    printf "    2) Reconfigure install — overwrite .env but preserve data volumes and instances\n"
    printf "    3) Clean reinstall — delete local compose volumes and local Nora agent containers\n"
    printf "  Select [1/2/3]: "
    read -r setup_mode_answer < /dev/tty
    case "$setup_mode_answer" in
      2) SETUP_MODE="install" ;;
      3) SETUP_MODE="clean-reinstall" ;;
      *) SETUP_MODE="update" ;;
    esac
  else
    SETUP_MODE="install"
  fi
fi

if [ "$SETUP_MODE" = "update" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    error "Update mode requires an existing $ENV_FILE. Run setup without --update for first install."
    exit 1
  fi

  header "Updating Nora"
  secure_env_file_permissions "$ENV_FILE"
  info "Code update mode keeps $ENV_FILE, Postgres/backup volumes, and provisioned instances."
  # Every install mode uses a hardened application overlay. Preserve whether
  # nginx terminates TLS locally, then refresh the matching current template so
  # older installs receive non-root/read-only defaults and volume migration.
  update_overlay_template="$PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE"
  if [ "$(read_env_value "$ENV_FILE" "NGINX_CONFIG_FILE" "nginx.conf")" != "nginx.conf" ] &&
    { { [ -f "$COMPOSE_OVERRIDE_FILE" ] && grep -Eq '/etc/letsencrypt|443:443' "$COMPOSE_OVERRIDE_FILE"; } ||
      { [ -f "$PUBLIC_NGINX_CONF" ] && grep -Eq 'listen[[:space:]]+443' "$PUBLIC_NGINX_CONF"; }; }; then
    update_overlay_template="$TLS_COMPOSE_OVERRIDE_TEMPLATE"
  fi
  update_overlay_had_kubeconfigs="false"
  if [ -f "$COMPOSE_OVERRIDE_FILE" ] &&
    grep -q 'NORA_KUBECONFIGS_DIR.*\/kubeconfigs:ro' "$COMPOSE_OVERRIDE_FILE"; then
    update_overlay_had_kubeconfigs="true"
  fi
  update_source_checkout
  update_overlay_custom="false"
  update_overlay_generated="false"
  if [ -f "$COMPOSE_OVERRIDE_FILE" ]; then
    if compose_override_matches_generated_history "$COMPOSE_OVERRIDE_FILE" "$update_overlay_template"; then
      update_overlay_generated="true"
    else
      update_overlay_custom="true"
    fi
  fi

  if [ "$update_overlay_generated" = "true" ]; then
    if ! cmp -s "$COMPOSE_OVERRIDE_FILE" "$update_overlay_template"; then
      legacy_override_backup="$(backup_legacy_compose_override)"
      info "Backed up the generated legacy override to $legacy_override_backup."
    fi
    write_compose_override "$update_overlay_template"
    compose_file_value="docker-compose.yml:${COMPOSE_OVERRIDE_FILE}"
    if [ "$update_overlay_had_kubeconfigs" = "true" ]; then
      compose_file_value="${compose_file_value}:docker-compose.kubernetes.yml"
      info "Migrated Kubernetes kubeconfig mounts into docker-compose.kubernetes.yml."
    fi
  elif [ "$update_overlay_custom" = "true" ]; then
    compose_file_value="docker-compose.yml:${update_overlay_template}:${COMPOSE_OVERRIDE_FILE}"
    info "Preserving customized $COMPOSE_OVERRIDE_FILE as the final compose layer."
  else
    write_compose_override "$update_overlay_template"
    compose_file_value="docker-compose.yml:${COMPOSE_OVERRIDE_FILE}"
  fi
  set_env_value "$ENV_FILE" "COMPOSE_PATH_SEPARATOR" ":"
  set_env_value "$ENV_FILE" "COMPOSE_FILE" "$compose_file_value"
  set_env_value "$ENV_FILE" "COMPOSE_PROJECT_NAME" "$(resolve_compose_project_name "$ENV_FILE")"
  set_env_value "$ENV_FILE" "NORA_UPGRADE_COMPOSE_FILES" "$compose_file_value"
  migrate_legacy_healthcheck_defaults "$ENV_FILE"
  ensure_signup_protection_env "$ENV_FILE"
  export COMPOSE_PATH_SEPARATOR=":"
  export COMPOSE_FILE="$compose_file_value"
  set_env_value "$ENV_FILE" "DOCKER_GID" "$(resolve_docker_gid)"
  if [ -z "$(read_env_value "$ENV_FILE" "DOCKER_AGENT_BIND_IP" "")" ]; then
    set_env_value "$ENV_FILE" "DOCKER_AGENT_BIND_IP" "127.0.0.1"
  fi
  refresh_release_tags
  ensure_agent_hub_hash_secret_env "$ENV_FILE"
  ensure_api_key_hash_secret_env "$ENV_FILE"
  ensure_backup_encryption_key_env "$ENV_FILE"
  materialize_compose_secret_files "$ENV_FILE"
  stamp_release_tracking_env "$ENV_FILE"
  bash infra/render-public-nginx.sh "$ENV_FILE" "$compose_file_value"
  assert_nora_host_ports_available "$ENV_FILE"
  start_compose_stack
  echo ""
  info "Update complete. No compose volumes or agent Docker/K8s/VM instances were removed."
  exit 0
fi

if [ "$SETUP_MODE" = "clean-reinstall" ]; then
  header "Clean Reinstall"
  if [ -f "$ENV_FILE" ]; then
    secure_env_file_permissions "$ENV_FILE"
    ENV_BACKUP_FILE="$(backup_existing_env_file "$ENV_FILE")"
    ok "Existing $ENV_FILE backed up to $ENV_BACKUP_FILE"
  fi
  clean_reinstall_state
elif [ -f "$ENV_FILE" ]; then
  secure_env_file_permissions "$ENV_FILE"
  echo ""
  warn ".env already exists."
  printf "  Overwrite configuration while preserving data volumes and instances? [y/N] "
  read -r answer < /dev/tty
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    info "Keeping existing .env — no changes made."
    info "Use './setup.sh --update' for a non-destructive code update."
    exit 0
  fi
  ENV_BACKUP_FILE="$(backup_existing_env_file "$ENV_FILE")"
  ok "Existing $ENV_FILE backed up to $ENV_BACKUP_FILE"
fi

# ── Generate secrets ─────────────────────────────────────────

header "Generating Secrets"

# Preserve existing secrets on reconfigure so live sessions, AES-encrypted
# provider keys, managed backups, Agent Hub keys, and the initialized Postgres
# volume remain usable. Only a first install with no value generates new ones.
JWT_SECRET="$(read_env_value "$ENV_FILE" "JWT_SECRET" "")"
[[ "$JWT_SECRET" =~ ^[0-9a-fA-F]{64}$ ]] || JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY="$(read_env_value "$ENV_FILE" "ENCRYPTION_KEY" "")"
[[ "$ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || ENCRYPTION_KEY=$(openssl rand -hex 32)
NORA_BACKUP_ENCRYPTION_KEY="$(read_env_value "$ENV_FILE" "NORA_BACKUP_ENCRYPTION_KEY" "")"
[[ "$NORA_BACKUP_ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || NORA_BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)
NORA_AGENT_HUB_API_KEY_HASH_SECRET="$(read_env_value "$ENV_FILE" "NORA_AGENT_HUB_API_KEY_HASH_SECRET" "")"
[[ "$NORA_AGENT_HUB_API_KEY_HASH_SECRET" =~ ^[0-9a-fA-F]{64}$ ]] || NORA_AGENT_HUB_API_KEY_HASH_SECRET=$(openssl rand -hex 32)
NORA_API_KEY_HASH_SECRET="$(read_env_value "$ENV_FILE" "NORA_API_KEY_HASH_SECRET" "")"
if [ -z "$NORA_API_KEY_HASH_SECRET" ]; then
  if [ -f "$ENV_FILE" ]; then
    NORA_API_KEY_HASH_SECRET="$NORA_AGENT_HUB_API_KEY_HASH_SECRET"
  else
    NORA_API_KEY_HASH_SECRET="$(openssl rand -hex 32)"
  fi
fi
DB_USER="nora"
DB_NAME="nora"
DB_PASSWORD="$(read_env_value "$ENV_FILE" "DB_PASSWORD" "")"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD=$(openssl rand -hex 24)

ok "JWT_SECRET            (64-char hex)"
ok "ENCRYPTION_KEY        (64-char hex — AES-256-GCM)"
ok "BACKUP_ENCRYPTION_KEY (64-char hex — managed backup archives)"
ok "AGENT_HUB_HASH        (64-char hex)"
ok "API_KEY_HASH          (preserved primary/fallback secret)"
ok "DB_PASSWORD           (48-char hex)"

# ── Platform mode ────────────────────────────────────────────

header "Platform Configuration"

printf "  Platform Mode:\n"
printf "    1) Self-hosted (default) — operator sets resource limits\n"
printf "    2) PaaS — Stripe billing with plan-locked resources\n"
printf "  Select [1/2]: "
read -r mode_answer < /dev/tty

MAX_VCPU="16"
MAX_RAM_MB="32768"
MAX_DISK_GB="500"
MAX_AGENTS="50"

if [[ "$mode_answer" == "2" ]]; then
  PLATFORM_MODE="paas"
  ok "PaaS mode — configure Stripe keys in .env after setup"
else
  PLATFORM_MODE="selfhosted"
  echo ""
  printf "  Max vCPU per agent [16]: "
  read -r input < /dev/tty; MAX_VCPU="${input:-16}"
  printf "  Max RAM (MB) per agent [32768]: "
  read -r input < /dev/tty; MAX_RAM_MB="${input:-32768}"
  printf "  Max Disk (GB) per agent [500]: "
  read -r input < /dev/tty; MAX_DISK_GB="${input:-500}"
  printf "  Max agents per user [50]: "
  read -r input < /dev/tty; MAX_AGENTS="${input:-50}"
  ok "Self-hosted: ${MAX_VCPU} vCPU, ${MAX_RAM_MB}MB RAM, ${MAX_DISK_GB}GB disk, ${MAX_AGENTS} agents"
fi

# ── Deploy backends ──────────────────────────────────────────

header "Deploy Backends"

DOCKER_BACKEND_ENABLED="true"
PROXMOX_BACKEND_ENABLED="false"
case ",$(read_env_value "$ENV_FILE" "ENABLED_BACKENDS" "")," in
  *,proxmox,*) PROXMOX_BACKEND_ENABLED="true" ;;
esac

# Seed the runtime and sandbox choices from the existing install so re-running
# setup preserves them. Previously these were pinned to false regardless of
# what .env said, so an operator re-running the installer silently lost their
# Hermes and NemoClaw selections while Proxmox was remembered (#409).
existing_runtime_families="$(read_env_value "$ENV_FILE" "ENABLED_RUNTIME_FAMILIES" "")"
existing_sandbox_profiles="$(read_env_value "$ENV_FILE" "ENABLED_SANDBOX_PROFILES" "")"
if [ -n "$existing_runtime_families" ]; then
  OPENCLAW_RUNTIME_ENABLED="false"
  HERMES_RUNTIME_ENABLED="false"
  csv_value_is_enabled "$existing_runtime_families" "openclaw" && OPENCLAW_RUNTIME_ENABLED="true"
  csv_value_is_enabled "$existing_runtime_families" "hermes" && HERMES_RUNTIME_ENABLED="true"
else
  # Fresh install: OpenClaw is the default runtime family, Hermes is opt-in.
  OPENCLAW_RUNTIME_ENABLED="true"
  HERMES_RUNTIME_ENABLED="false"
fi
NEMOCLAW_SANDBOX_ENABLED="false"
csv_value_is_enabled "$existing_sandbox_profiles" "nemoclaw" && NEMOCLAW_SANDBOX_ENABLED="true"
PROXMOX_API_URL="$(read_env_value "$ENV_FILE" "PROXMOX_API_URL" "")"
PROXMOX_TOKEN_ID="$(read_env_value "$ENV_FILE" "PROXMOX_TOKEN_ID" "")"
PROXMOX_TOKEN_SECRET="$(read_env_value "$ENV_FILE" "PROXMOX_TOKEN_SECRET" "")"
PROXMOX_VERIFY_TLS="$(read_env_value "$ENV_FILE" "PROXMOX_VERIFY_TLS" "true")"
PROXMOX_CA_CERT="$(read_env_value "$ENV_FILE" "PROXMOX_CA_CERT" "")"
PROXMOX_CA_CERT_PATH="$(read_env_value "$ENV_FILE" "PROXMOX_CA_CERT_PATH" "")"
PROXMOX_ALLOW_INSECURE_HTTP="$(read_env_value "$ENV_FILE" "PROXMOX_ALLOW_INSECURE_HTTP" "false")"
PROXMOX_NODE="$(read_env_value "$ENV_FILE" "PROXMOX_NODE" "pve")"
PROXMOX_TEMPLATE="$(read_env_value "$ENV_FILE" "PROXMOX_TEMPLATE" "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst")"
PROXMOX_HERMES_TEMPLATE="$(read_env_value "$ENV_FILE" "PROXMOX_HERMES_TEMPLATE" "")"
PROXMOX_ROOTFS_STORAGE="$(read_env_value "$ENV_FILE" "PROXMOX_ROOTFS_STORAGE" "local-lvm")"
PROXMOX_BRIDGE="$(read_env_value "$ENV_FILE" "PROXMOX_BRIDGE" "vmbr0")"
PROXMOX_SSH_HOST="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_HOST" "")"
PROXMOX_SSH_USER="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_USER" "root")"
PROXMOX_SSH_PORT="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_PORT" "22")"
PROXMOX_SSH_PRIVATE_KEY="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_PRIVATE_KEY" "")"
PROXMOX_SSH_PRIVATE_KEY_PATH="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_PRIVATE_KEY_PATH" "")"
PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE" "")"
PROXMOX_SSH_PASSWORD="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_PASSWORD" "")"
PROXMOX_SSH_HOST_FINGERPRINT="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_HOST_FINGERPRINT" "")"
PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY="$(read_env_value "$ENV_FILE" "PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY" "false")"
PROXMOX_PCT_COMMAND="$(read_env_value "$ENV_FILE" "PROXMOX_PCT_COMMAND" "pct")"
PROXMOX_SUDO="$(read_env_value "$ENV_FILE" "PROXMOX_SUDO" "")"
PROXMOX_OFFLINE_STAGE_COMMAND="$(read_env_value "$ENV_FILE" "PROXMOX_OFFLINE_STAGE_COMMAND" "")"
PROXMOX_NODE_MAJOR="$(read_env_value "$ENV_FILE" "PROXMOX_NODE_MAJOR" "24")"
PROXMOX_OPENCLAW_PACKAGE="$(read_env_value "$ENV_FILE" "PROXMOX_OPENCLAW_PACKAGE" "openclaw@2026.6.11")"
if [ "$PROXMOX_OPENCLAW_PACKAGE" = "openclaw@latest" ]; then
  warn "Migrating legacy PROXMOX_OPENCLAW_PACKAGE=openclaw@latest to Nora's validated pin."
  PROXMOX_OPENCLAW_PACKAGE="openclaw@2026.6.11"
fi
PROXMOX_HERMES_BIN="$(read_env_value "$ENV_FILE" "PROXMOX_HERMES_BIN" "/opt/hermes/.venv/bin/hermes")"
PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD="$(read_env_value "$ENV_FILE" "PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD" "false")"
NVIDIA_API_KEY=""

printf "  Enable Docker backend for local socket provisioning? [Y/n] "
read -r docker_backend_answer < /dev/tty
if [[ "$docker_backend_answer" =~ ^[Nn]$ ]]; then
  DOCKER_BACKEND_ENABLED="false"
  info "Docker backend disabled"
else
  ok "Docker backend enabled"
fi

info "Kubernetes clusters are registered after setup in Admin -> Kubernetes."
if [ "$PROXMOX_BACKEND_ENABLED" = "true" ]; then
  printf "  Keep experimental Proxmox LXC target enabled? [Y/n] "
else
  printf "  Enable experimental Proxmox LXC target? [y/N] "
fi
read -r proxmox_backend_answer < /dev/tty
if { [ "$PROXMOX_BACKEND_ENABLED" = "true" ] && [[ ! "$proxmox_backend_answer" =~ ^[Nn]$ ]]; } ||
  { [ "$PROXMOX_BACKEND_ENABLED" != "true" ] && [[ "$proxmox_backend_answer" =~ ^[Yy]$ ]]; }; then
  PROXMOX_BACKEND_ENABLED="true"
  warn "Proxmox is experimental. Configure HTTPS API TLS, pinned SSH host verification, and run e2e/scripts/run-proxmox-smoke.sh before production use."
else
  PROXMOX_BACKEND_ENABLED="false"
  info "Proxmox target disabled"
fi

# OpenClaw is prompted like every other runtime rather than assumed. It was
# previously forced into ENABLED_RUNTIME_FAMILIES with no way to decline, and
# its agent image was built unconditionally, so a Hermes-only operator still
# paid for a runtime they never wanted (#409).
if [ "$OPENCLAW_RUNTIME_ENABLED" = "true" ]; then
  printf "  Keep OpenClaw runtime family enabled? [Y/n] "
else
  printf "  Enable OpenClaw runtime family? [y/N] "
fi
read -r openclaw_runtime_answer < /dev/tty
if { [ "$OPENCLAW_RUNTIME_ENABLED" = "true" ] && [[ ! "$openclaw_runtime_answer" =~ ^[Nn]$ ]]; } ||
  { [ "$OPENCLAW_RUNTIME_ENABLED" != "true" ] && [[ "$openclaw_runtime_answer" =~ ^[Yy]$ ]]; }; then
  OPENCLAW_RUNTIME_ENABLED="true"
  ok "OpenClaw runtime family enabled"
else
  OPENCLAW_RUNTIME_ENABLED="false"
  info "OpenClaw runtime family disabled"
fi

if [ "$HERMES_RUNTIME_ENABLED" = "true" ]; then
  printf "  Keep Hermes runtime family enabled? [Y/n] "
else
  printf "  Enable Hermes runtime family? [y/N] "
fi
read -r hermes_runtime_answer < /dev/tty
if { [ "$HERMES_RUNTIME_ENABLED" = "true" ] && [[ ! "$hermes_runtime_answer" =~ ^[Nn]$ ]]; } ||
  { [ "$HERMES_RUNTIME_ENABLED" != "true" ] && [[ "$hermes_runtime_answer" =~ ^[Yy]$ ]]; }; then
  HERMES_RUNTIME_ENABLED="true"
  ok "Hermes runtime family enabled"
else
  HERMES_RUNTIME_ENABLED="false"
  info "Hermes runtime family disabled"
fi

# NemoClaw is a sandbox profile for OpenClaw agents, so it is only offered when
# OpenClaw is on. Skipping the question makes the contradictory combination
# unreachable rather than something to reconcile afterwards.
if [ "$OPENCLAW_RUNTIME_ENABLED" != "true" ]; then
  if [ "$NEMOCLAW_SANDBOX_ENABLED" = "true" ]; then
    warn "NemoClaw sandboxes OpenClaw agents; disabling it because OpenClaw is off."
  fi
  NEMOCLAW_SANDBOX_ENABLED="false"
else
  if [ "$NEMOCLAW_SANDBOX_ENABLED" = "true" ]; then
    printf "  Keep NemoClaw sandbox profile enabled? [Y/n] "
  else
    printf "  Enable NemoClaw sandbox profile? [y/N] "
  fi
  read -r nemoclaw_sandbox_answer < /dev/tty
  if { [ "$NEMOCLAW_SANDBOX_ENABLED" = "true" ] && [[ ! "$nemoclaw_sandbox_answer" =~ ^[Nn]$ ]]; } ||
    { [ "$NEMOCLAW_SANDBOX_ENABLED" != "true" ] && [[ "$nemoclaw_sandbox_answer" =~ ^[Yy]$ ]]; }; then
    NEMOCLAW_SANDBOX_ENABLED="true"
    printf "  NVIDIA API key [optional during setup]: "
    read -r nvidia_key < /dev/tty
    if [ -n "$nvidia_key" ]; then
      NVIDIA_API_KEY="$nvidia_key"
      ok "NemoClaw sandbox profile enabled with NVIDIA API key"
    else
      warn "NemoClaw enabled without NVIDIA_API_KEY — add it to .env later if needed"
    fi
  else
    NEMOCLAW_SANDBOX_ENABLED="false"
    info "NemoClaw sandbox profile disabled"
  fi
fi

enabled_backends=()
[ "$DOCKER_BACKEND_ENABLED" = "true" ] && enabled_backends+=("docker")
[ "$PROXMOX_BACKEND_ENABLED" = "true" ] && enabled_backends+=("proxmox")

if [ ${#enabled_backends[@]} -eq 0 ]; then
  warn "No deploy backends selected — enabling Docker so Nora can deploy agents."
  DOCKER_BACKEND_ENABLED="true"
  enabled_backends=("docker")
fi

ENABLED_BACKENDS="$(IFS=,; echo "${enabled_backends[*]}")"
ok "Enabled backends: ${ENABLED_BACKENDS}"

enabled_runtime_families=()
[ "$OPENCLAW_RUNTIME_ENABLED" = "true" ] && enabled_runtime_families+=("openclaw")
[ "$HERMES_RUNTIME_ENABLED" = "true" ] && enabled_runtime_families+=("hermes")

# Mirrors the deploy-backend guard above: an install with no runtime family can
# never deploy an agent, so fall back rather than write an unusable config.
if [ ${#enabled_runtime_families[@]} -eq 0 ]; then
  warn "No runtime families selected — enabling OpenClaw so Nora can deploy agents."
  OPENCLAW_RUNTIME_ENABLED="true"
  enabled_runtime_families=("openclaw")
fi

ENABLED_RUNTIME_FAMILIES="$(IFS=,; echo "${enabled_runtime_families[*]}")"
ok "Enabled runtime families: ${ENABLED_RUNTIME_FAMILIES}"

enabled_sandbox_profiles=("standard")
[ "$NEMOCLAW_SANDBOX_ENABLED" = "true" ] && enabled_sandbox_profiles+=("nemoclaw")
ENABLED_SANDBOX_PROFILES="$(IFS=,; echo "${enabled_sandbox_profiles[*]}")"
ok "Enabled sandbox profiles: ${ENABLED_SANDBOX_PROFILES}"

# ── Access mode ──────────────────────────────────────────────

header "Access Mode"

printf "  How should users reach Nora?\n"
printf "    1) Local only (default) — http://localhost:8080 (auto-picks the next free port if 8080 is busy)\n"
printf "    2) Public domain behind HTTPS proxy — nginx listens on port 80\n"
printf "    3) Public domain with TLS at nginx — nginx listens on ports 80 and 443\n"
printf "  Select [1/2/3]: "
read -r access_answer < /dev/tty

ACCESS_MODE="local"
PUBLIC_DOMAIN=""
PUBLIC_SCHEME="http"
NEXTAUTH_URL="http://localhost:8080"
CORS_ORIGINS="http://localhost:8080"
NGINX_CONFIG_FILE="nginx.conf"
NGINX_HTTP_PORT="8080"
BACKEND_API_PORT="4100"
NORA_FORCE_SECURE_COOKIES=""
CAN_START_NORA=true

case "$access_answer" in
  2|3)
    while true; do
      printf "  Public domain (hosted default: nora.solomontsao.com; self-hosted: your own domain): "
      read -r PUBLIC_DOMAIN < /dev/tty
      if [[ "$PUBLIC_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] && [[ "$PUBLIC_DOMAIN" == *.* ]]; then
        break
      fi
      warn "Enter a valid hostname without http:// or path segments."
    done

    if [ "$access_answer" = "2" ]; then
      printf "  Public URL scheme [https]: "
      read -r input < /dev/tty
      PUBLIC_SCHEME="${input:-https}"
      if [ "$PUBLIC_SCHEME" != "http" ] && [ "$PUBLIC_SCHEME" != "https" ]; then
        warn "Unsupported scheme '$PUBLIC_SCHEME' — using https."
        PUBLIC_SCHEME="https"
      fi
      write_public_nginx_conf "$PUBLIC_NGINX_TEMPLATE" "$PUBLIC_DOMAIN"
      write_compose_override "$PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE"
      ok "Public proxy mode — nginx will serve ${PUBLIC_DOMAIN} on port 80"
    else
      PUBLIC_SCHEME="https"
      write_public_nginx_conf "$TLS_NGINX_TEMPLATE" "$PUBLIC_DOMAIN"
      write_compose_override "$TLS_COMPOSE_OVERRIDE_TEMPLATE"
      if [ ! -f "/etc/letsencrypt/live/${PUBLIC_DOMAIN}/fullchain.pem" ] || [ ! -f "/etc/letsencrypt/live/${PUBLIC_DOMAIN}/privkey.pem" ]; then
        CAN_START_NORA=false
        warn "TLS certs not found for ${PUBLIC_DOMAIN}."
        info "Run: DOMAIN=${PUBLIC_DOMAIN} EMAIL=you@example.com ./infra/setup-tls.sh"
        info "The stack will be configured, but startup will be skipped until certs are installed."
      else
        ok "Public TLS mode — certs found for ${PUBLIC_DOMAIN}"
      fi
    fi

    ACCESS_MODE=$([ "$access_answer" = "3" ] && printf "public-tls" || printf "public-proxy")
    NEXTAUTH_URL="${PUBLIC_SCHEME}://${PUBLIC_DOMAIN}"
    CORS_ORIGINS="${NEXTAUTH_URL}"
    [ "$PUBLIC_SCHEME" = "https" ] && NORA_FORCE_SECURE_COOKIES=1
    NGINX_CONFIG_FILE="$PUBLIC_NGINX_CONF"
    NGINX_HTTP_PORT="80"
    ;;
  *)
    clear_public_access_artifacts
    write_compose_override "$PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE"
    NGINX_HTTP_PORT="$(resolve_available_host_port "8080" "Local web gateway" "nginx" "80")"
    NEXTAUTH_URL="http://localhost:${NGINX_HTTP_PORT}"
    CORS_ORIGINS="${NEXTAUTH_URL}"
    ok "Local mode — Nora will be available at ${NEXTAUTH_URL}"
    if [ "$NGINX_HTTP_PORT" != "8080" ]; then
      warn "Port 8080 was busy — Nora will run at ${NEXTAUTH_URL}."
      warn "Open THAT URL (not http://localhost:8080) to sign in."
    fi
    ;;
esac

BACKEND_API_PORT="$(resolve_available_host_port "4100" "backend API" "backend-api" "4000" "127.0.0.1")"
if [ "$BACKEND_API_PORT" != "4100" ]; then
  warn "Port 4100 was busy — Nora backend API will run at 127.0.0.1:${BACKEND_API_PORT}."
fi

# ── Bootstrap Admin Account ──────────────────────────────────

if [ "$PLATFORM_MODE" = "paas" ]; then
  header "Bootstrap Admin Account (Required for PaaS)"
  printf "  Hosted PaaS requires an explicit bootstrap administrator.\n"
else
  header "Bootstrap Admin Account (Optional)"
  printf "  Leave both fields blank to claim the first admin after boot.\n"
fi
printf "  If set, use a valid email and a non-default password of at least 12 characters.\n\n"

while true; do
  printf "  Admin email [leave blank to skip]: "
  read -r admin_email_input < /dev/tty

  printf "  Admin password (min 12 chars, leave blank to skip): "
  read -rs admin_pass_input < /dev/tty
  printf "\n"

  if [ -z "$admin_email_input" ] && [ -z "$admin_pass_input" ]; then
    if [ "$PLATFORM_MODE" = "paas" ]; then
      warn "Hosted PaaS cannot expose first-account admin claim. Configure the bootstrap administrator."
      continue
    fi
    DEFAULT_ADMIN_EMAIL=""
    DEFAULT_ADMIN_PASSWORD=""
    info "Skipping bootstrap admin seed — claim your self-hosted operator account after first boot."
    break
  fi

  if [ -z "$admin_email_input" ] || [ -z "$admin_pass_input" ]; then
    warn "To pre-seed an admin, provide both email and password, or leave both blank to skip."
    continue
  fi

  if ! bootstrap_admin_email_is_valid "$admin_email_input"; then
    warn "Bootstrap admin email must be a valid non-placeholder address."
    continue
  fi

  if [ ${#admin_pass_input} -lt 12 ]; then
    warn "Bootstrap admin password must be at least 12 characters."
    continue
  fi

  if bootstrap_admin_password_is_forbidden "$admin_pass_input"; then
    warn "Bootstrap admin password cannot be a shipped placeholder or derived from a common default."
    continue
  fi

  DEFAULT_ADMIN_EMAIL="$admin_email_input"
  DEFAULT_ADMIN_PASSWORD="$admin_pass_input"
  ok "Bootstrap admin configured: $DEFAULT_ADMIN_EMAIL"
  break
done

# ── LLM Provider ─────────────────────────────────────────────

header "LLM Provider"

info "Setup no longer creates an agent automatically."
info "Add your LLM provider key from Settings after login."

# ── OAuth (optional) ─────────────────────────────────────────

header "OAuth (Optional)"

GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""

printf "  Configure Google OAuth? [y/N] "
read -r google_answer < /dev/tty
if [[ "$google_answer" =~ ^[Yy]$ ]]; then
  printf "  Google Client ID: "
  read -r GOOGLE_CLIENT_ID < /dev/tty
  printf "  Google Client Secret: "
  read -r GOOGLE_CLIENT_SECRET < /dev/tty
  if [ -n "$GOOGLE_CLIENT_ID" ]; then
    ok "Google OAuth configured"
  fi
fi

printf "  Configure GitHub OAuth? [y/N] "
read -r github_answer < /dev/tty
if [[ "$github_answer" =~ ^[Yy]$ ]]; then
  printf "  GitHub Client ID: "
  read -r GITHUB_CLIENT_ID < /dev/tty
  printf "  GitHub Client Secret: "
  read -r GITHUB_CLIENT_SECRET < /dev/tty
  if [ -n "$GITHUB_CLIENT_ID" ]; then
    ok "GitHub OAuth configured"
  fi
fi

if [ -z "$GOOGLE_CLIENT_ID" ] && [ -z "$GITHUB_CLIENT_ID" ]; then
  info "No OAuth configured — users will sign up with email/password"
fi

OAUTH_LOGIN_ENABLED="false"
if [ -n "$GOOGLE_CLIENT_ID" ] || [ -n "$GITHUB_CLIENT_ID" ]; then
  OAUTH_LOGIN_ENABLED="true"
fi

# ── Write .env ───────────────────────────────────────────────

header "Writing Configuration"

info "Writing $ENV_FILE..."

NORA_CURRENT_VERSION="$(resolve_current_release_version)"
NORA_CURRENT_COMMIT="$(resolve_current_release_commit)"
DOCKER_GID="$(resolve_docker_gid)"
COMPOSE_PROJECT_NAME="$(resolve_compose_project_name "$ENV_FILE")"
DOCKER_AGENT_BIND_IP="$(read_env_value "$ENV_FILE" "DOCKER_AGENT_BIND_IP" "127.0.0.1")"
OPENCLAW_DOCKER_PACKAGE="$(read_env_value "$ENV_FILE" "OPENCLAW_DOCKER_PACKAGE" "openclaw@2026.6.11")"
if [ "$OPENCLAW_DOCKER_PACKAGE" = "openclaw@latest" ]; then
  warn "Migrating legacy OPENCLAW_DOCKER_PACKAGE=openclaw@latest to Nora's validated pin."
  OPENCLAW_DOCKER_PACKAGE="openclaw@2026.6.11"
fi
NEMOCLAW_SANDBOX_IMAGE="$(read_env_value "$ENV_FILE" "NEMOCLAW_SANDBOX_IMAGE" "ghcr.io/solomon2773/nora-nemoclaw-agent:latest")"
DATABASE_URL="$(read_env_value "$ENV_FILE" "DATABASE_URL" "")"
DB_SSL_MODE="$(read_env_value "$ENV_FILE" "DB_SSL_MODE" "")"
DB_SSL_CA="$(read_env_value "$ENV_FILE" "DB_SSL_CA" "")"
DB_SSL_CA_FILE="$(read_env_value "$ENV_FILE" "DB_SSL_CA_FILE" "")"
DB_SSL_CERT="$(read_env_value "$ENV_FILE" "DB_SSL_CERT" "")"
DB_SSL_CERT_FILE="$(read_env_value "$ENV_FILE" "DB_SSL_CERT_FILE" "")"
DB_SSL_KEY="$(read_env_value "$ENV_FILE" "DB_SSL_KEY" "")"
DB_SSL_KEY_FILE="$(read_env_value "$ENV_FILE" "DB_SSL_KEY_FILE" "")"
DB_POOL_MAX="$(read_env_value "$ENV_FILE" "DB_POOL_MAX" "20")"
DB_IDLE_TIMEOUT_MS="$(read_env_value "$ENV_FILE" "DB_IDLE_TIMEOUT_MS" "30000")"
DB_CONNECTION_TIMEOUT_MS="$(read_env_value "$ENV_FILE" "DB_CONNECTION_TIMEOUT_MS" "10000")"
DB_STATEMENT_TIMEOUT_MS="$(read_env_value "$ENV_FILE" "DB_STATEMENT_TIMEOUT_MS" "0")"
DB_MIGRATION_LOCK_TIMEOUT_MS="$(read_env_value "$ENV_FILE" "DB_MIGRATION_LOCK_TIMEOUT_MS" "60000")"
DB_MIGRATION_STATEMENT_TIMEOUT_MS="$(read_env_value "$ENV_FILE" "DB_MIGRATION_STATEMENT_TIMEOUT_MS" "600000")"
REDIS_URL="$(read_env_value "$ENV_FILE" "REDIS_URL" "")"
REDIS_USERNAME="$(read_env_value "$ENV_FILE" "REDIS_USERNAME" "")"
REDIS_PASSWORD="$(read_env_value "$ENV_FILE" "REDIS_PASSWORD" "")"
REDIS_DB="$(read_env_value "$ENV_FILE" "REDIS_DB" "")"
REDIS_TLS="$(read_env_value "$ENV_FILE" "REDIS_TLS" "false")"
REDIS_TLS_CA="$(read_env_value "$ENV_FILE" "REDIS_TLS_CA" "")"
REDIS_TLS_CA_FILE="$(read_env_value "$ENV_FILE" "REDIS_TLS_CA_FILE" "")"
REDIS_TLS_CERT="$(read_env_value "$ENV_FILE" "REDIS_TLS_CERT" "")"
REDIS_TLS_CERT_FILE="$(read_env_value "$ENV_FILE" "REDIS_TLS_CERT_FILE" "")"
REDIS_TLS_KEY="$(read_env_value "$ENV_FILE" "REDIS_TLS_KEY" "")"
REDIS_TLS_KEY_FILE="$(read_env_value "$ENV_FILE" "REDIS_TLS_KEY_FILE" "")"
REDIS_TLS_INSECURE_SKIP_VERIFY="$(read_env_value "$ENV_FILE" "REDIS_TLS_INSECURE_SKIP_VERIFY" "false")"
REDIS_CONNECT_TIMEOUT_MS="$(read_env_value "$ENV_FILE" "REDIS_CONNECT_TIMEOUT_MS" "10000")"
SIGNUP_ENABLED="$(read_env_value "$ENV_FILE" "SIGNUP_ENABLED" "true")"
SIGNUP_RATE_LIMIT_BURST_MAX="$(read_env_value "$ENV_FILE" "SIGNUP_RATE_LIMIT_BURST_MAX" "5")"
SIGNUP_RATE_LIMIT_BURST_WINDOW_MS="$(read_env_value "$ENV_FILE" "SIGNUP_RATE_LIMIT_BURST_WINDOW_MS" "600000")"
SIGNUP_RATE_LIMIT_DAILY_MAX="$(read_env_value "$ENV_FILE" "SIGNUP_RATE_LIMIT_DAILY_MAX" "20")"
SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS="$(read_env_value "$ENV_FILE" "SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS" "86400000")"
SIGNUP_BOT_PROTECTION_PROVIDER="$(read_env_value_with_alias "$ENV_FILE" "SIGNUP_BOT_PROTECTION_PROVIDER" "NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER" "none")"
SIGNUP_TURNSTILE_SITE_KEY="$(read_env_value_with_alias "$ENV_FILE" "SIGNUP_TURNSTILE_SITE_KEY" "NEXT_PUBLIC_SIGNUP_TURNSTILE_SITE_KEY" "")"
SIGNUP_TURNSTILE_SECRET="$(read_env_value "$ENV_FILE" "SIGNUP_TURNSTILE_SECRET" "")"
SIGNUP_RECAPTCHA_SITE_KEY="$(read_env_value_with_alias "$ENV_FILE" "SIGNUP_RECAPTCHA_SITE_KEY" "NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY" "")"
SIGNUP_RECAPTCHA_SECRET="$(read_env_value "$ENV_FILE" "SIGNUP_RECAPTCHA_SECRET" "")"
DEFAULT_ADMIN_EMAIL_ENV="$(compose_env_literal "$DEFAULT_ADMIN_EMAIL")"
DEFAULT_ADMIN_PASSWORD_ENV="$(compose_env_literal "$DEFAULT_ADMIN_PASSWORD")"
if [ -n "$NORA_CURRENT_COMMIT" ]; then
  ok "Release tracking: ${NORA_CURRENT_VERSION:-source checkout} @ ${NORA_CURRENT_COMMIT:0:12}"
else
  warn "Release tracking commit could not be resolved; Admin Settings will show tracking incomplete."
fi

cat > "$ENV_FILE" <<EOF
# ============================================================
# Nora — Environment Configuration
# ============================================================
# Auto-generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ============================================================

# ── Required (auto-generated) ────────────────────────────────
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
NORA_BACKUP_ENCRYPTION_KEY=${NORA_BACKUP_ENCRYPTION_KEY}
NORA_AGENT_HUB_API_KEY_HASH_SECRET=${NORA_AGENT_HUB_API_KEY_HASH_SECRET}
NORA_API_KEY_HASH_SECRET=${NORA_API_KEY_HASH_SECRET}

# ── Bootstrap Admin Account (optional; seeded only when both are set securely) ──
DEFAULT_ADMIN_EMAIL=${DEFAULT_ADMIN_EMAIL_ENV}
DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD_ENV}

# ── Database (defaults work with Docker Compose) ─────────────
DB_HOST=postgres
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
DB_PORT=5432
DATABASE_URL=${DATABASE_URL}
DB_SSL_MODE=${DB_SSL_MODE}
DB_SSL_CA=${DB_SSL_CA}
DB_SSL_CA_FILE=${DB_SSL_CA_FILE}
DB_SSL_CERT=${DB_SSL_CERT}
DB_SSL_CERT_FILE=${DB_SSL_CERT_FILE}
DB_SSL_KEY=${DB_SSL_KEY}
DB_SSL_KEY_FILE=${DB_SSL_KEY_FILE}
DB_POOL_MAX=${DB_POOL_MAX}
DB_IDLE_TIMEOUT_MS=${DB_IDLE_TIMEOUT_MS}
DB_CONNECTION_TIMEOUT_MS=${DB_CONNECTION_TIMEOUT_MS}
DB_STATEMENT_TIMEOUT_MS=${DB_STATEMENT_TIMEOUT_MS}
DB_MIGRATION_LOCK_TIMEOUT_MS=${DB_MIGRATION_LOCK_TIMEOUT_MS}
DB_MIGRATION_STATEMENT_TIMEOUT_MS=${DB_MIGRATION_STATEMENT_TIMEOUT_MS}

# ── Redis (defaults work with Docker Compose) ────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_URL=${REDIS_URL}
REDIS_USERNAME=${REDIS_USERNAME}
REDIS_PASSWORD=${REDIS_PASSWORD}
REDIS_DB=${REDIS_DB}
REDIS_TLS=${REDIS_TLS}
REDIS_TLS_CA=${REDIS_TLS_CA}
REDIS_TLS_CA_FILE=${REDIS_TLS_CA_FILE}
REDIS_TLS_CERT=${REDIS_TLS_CERT}
REDIS_TLS_CERT_FILE=${REDIS_TLS_CERT_FILE}
REDIS_TLS_KEY=${REDIS_TLS_KEY}
REDIS_TLS_KEY_FILE=${REDIS_TLS_KEY_FILE}
REDIS_TLS_INSECURE_SKIP_VERIFY=${REDIS_TLS_INSECURE_SKIP_VERIFY}
REDIS_CONNECT_TIMEOUT_MS=${REDIS_CONNECT_TIMEOUT_MS}
PORT=4000
BACKEND_API_PORT=${BACKEND_API_PORT}
DOCKER_GID=${DOCKER_GID}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}

# ── Access / URL ─────────────────────────────────────────────
NGINX_CONFIG_FILE=${NGINX_CONFIG_FILE}
NGINX_HTTP_PORT=${NGINX_HTTP_PORT}
# Forces the Secure flag on the session cookie for always-on-TLS public deploys
# (set to 1 for https public modes; empty for local http). Guards against an
# upstream proxy that strips X-Forwarded-Proto.
NORA_FORCE_SECURE_COOKIES=${NORA_FORCE_SECURE_COOKIES}

# ── OAuth ────────────────────────────────────────────────────
OAUTH_LOGIN_ENABLED=${OAUTH_LOGIN_ENABLED}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
NEXTAUTH_URL=${NEXTAUTH_URL}

# ── Public Signup Abuse Protection ──────────────────────────
SIGNUP_ENABLED=${SIGNUP_ENABLED}
SIGNUP_RATE_LIMIT_BURST_MAX=${SIGNUP_RATE_LIMIT_BURST_MAX}
SIGNUP_RATE_LIMIT_BURST_WINDOW_MS=${SIGNUP_RATE_LIMIT_BURST_WINDOW_MS}
SIGNUP_RATE_LIMIT_DAILY_MAX=${SIGNUP_RATE_LIMIT_DAILY_MAX}
SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS=${SIGNUP_RATE_LIMIT_DAILY_WINDOW_MS}
SIGNUP_BOT_PROTECTION_PROVIDER=${SIGNUP_BOT_PROTECTION_PROVIDER}
SIGNUP_TURNSTILE_SITE_KEY=${SIGNUP_TURNSTILE_SITE_KEY}
SIGNUP_TURNSTILE_SECRET=${SIGNUP_TURNSTILE_SECRET}
SIGNUP_RECAPTCHA_SITE_KEY=${SIGNUP_RECAPTCHA_SITE_KEY}
SIGNUP_RECAPTCHA_SECRET=${SIGNUP_RECAPTCHA_SECRET}

# ── Platform Mode ────────────────────────────────────────────
PLATFORM_MODE=${PLATFORM_MODE}

# ── Self-hosted limits (only when PLATFORM_MODE=selfhosted) ──
MAX_VCPU=${MAX_VCPU}
MAX_RAM_MB=${MAX_RAM_MB}
MAX_DISK_GB=${MAX_DISK_GB}
MAX_AGENTS=${MAX_AGENTS}

# ── Managed Backups ──────────────────────────────────────────
# Leave storage destination vars empty to use Admin Settings (default: local volume).
NORA_BACKUP_STORAGE=
NORA_BACKUP_DIR=
NORA_BACKUP_LIMIT_PER_AGENT=10
NORA_BACKUP_STORAGE_MB=51200
NORA_BACKUP_RETENTION_DAYS=30
BACKUP_WORKER_CONCURRENCY=2
NORA_BACKUP_JOB_TIMEOUT_MS=1800000
NORA_BACKUP_SCHEDULE_POLL_MS=60000

# Optional S3 / Cloudflare R2 storage overrides. Admin Settings can also
# store these in the database when ENCRYPTION_KEY is configured.
NORA_BACKUP_S3_BUCKET=
NORA_BACKUP_S3_REGION=
NORA_BACKUP_S3_ENDPOINT=
NORA_BACKUP_S3_ACCESS_KEY_ID=
NORA_BACKUP_S3_SECRET_ACCESS_KEY=
NORA_BACKUP_S3_SESSION_TOKEN=
NORA_BACKUP_R2_BUCKET=
NORA_BACKUP_R2_REGION=
NORA_BACKUP_R2_ENDPOINT=
NORA_BACKUP_R2_ACCESS_KEY_ID=
NORA_BACKUP_R2_SECRET_ACCESS_KEY=
NORA_BACKUP_R2_SESSION_TOKEN=

# Optional SSH/SFTP storage overrides.
NORA_BACKUP_SSH_HOST=
NORA_BACKUP_SSH_PORT=
NORA_BACKUP_SSH_USERNAME=
NORA_BACKUP_SSH_REMOTE_PATH=
NORA_BACKUP_SSH_PRIVATE_KEY=
NORA_BACKUP_SSH_PASSWORD=

# ── Billing (only when PLATFORM_MODE=paas) ───────────────────
BILLING_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=

# ── Release Tracking / Admin Upgrade Banner ─────────────────
NORA_CURRENT_VERSION=${NORA_CURRENT_VERSION}
NORA_CURRENT_COMMIT=${NORA_CURRENT_COMMIT}
NORA_GITHUB_REPO=${NORA_GITHUB_REPO_SLUG}
NORA_RELEASE_CACHE_TTL_MS=300000
NORA_LATEST_VERSION=
NORA_LATEST_PUBLISHED_AT=
NORA_RELEASE_NOTES_URL=
NORA_LATEST_SEVERITY=warning
NORA_UPGRADE_REQUIRED=false
NORA_AUTO_UPGRADE_ENABLED=false
NORA_HOST_REPO_DIR=$(pwd)
# Direct upgrades fetch this public HTTPS repo. Do not include credentials.
NORA_UPGRADE_REPO=https://github.com/solomon2773/nora.git
NORA_UPGRADE_REF=master
NORA_UPGRADE_RUNNER_IMAGE=docker:29-cli
NORA_UPGRADE_STATE_VOLUME=nora_upgrade_state
NORA_ENV_FILE=.env
NORA_COMPOSE_SECRETS_DIR=${DEFAULT_COMPOSE_SECRETS_DIR}
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml
NORA_UPGRADE_COMPOSE_FILES=docker-compose.yml:docker-compose.override.yml
NORA_UPGRADE_PUBLIC_HEALTH_URL=
# Shared by setup post-start probes and one-click upgrade health checks.
# 221 attempts, 3s apart = 660s from the first to final attempt. Overrides
# must be positive integers with a first-to-final window no greater than 3900s.
NORA_UPGRADE_HEALTHCHECK_ATTEMPTS=221
NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS=3
NORA_INSTALL_METHOD=source
NORA_MANUAL_UPGRADE_COMMAND=./setup.sh --update
NORA_MANUAL_UPGRADE_STEPS=

# ── Runtime families, deploy targets, and sandbox profiles ───
ENABLED_RUNTIME_FAMILIES=${ENABLED_RUNTIME_FAMILIES}
ENABLED_BACKENDS=${ENABLED_BACKENDS}
ENABLED_SANDBOX_PROFILES=${ENABLED_SANDBOX_PROFILES}
DOCKER_AGENT_BIND_IP=${DOCKER_AGENT_BIND_IP}
OPENCLAW_DOCKER_PACKAGE=${OPENCLAW_DOCKER_PACKAGE}

# ── Proxmox LXC (experimental; secure configuration required) ──────────
PROXMOX_API_URL=${PROXMOX_API_URL}
PROXMOX_TOKEN_ID=${PROXMOX_TOKEN_ID}
PROXMOX_TOKEN_SECRET=${PROXMOX_TOKEN_SECRET}
PROXMOX_VERIFY_TLS=${PROXMOX_VERIFY_TLS}
PROXMOX_CA_CERT=${PROXMOX_CA_CERT}
PROXMOX_CA_CERT_PATH=${PROXMOX_CA_CERT_PATH}
PROXMOX_ALLOW_INSECURE_HTTP=${PROXMOX_ALLOW_INSECURE_HTTP}
PROXMOX_NODE=${PROXMOX_NODE}
PROXMOX_TEMPLATE=${PROXMOX_TEMPLATE}
PROXMOX_HERMES_TEMPLATE=${PROXMOX_HERMES_TEMPLATE}
PROXMOX_ROOTFS_STORAGE=${PROXMOX_ROOTFS_STORAGE}
PROXMOX_BRIDGE=${PROXMOX_BRIDGE}
PROXMOX_SSH_HOST=${PROXMOX_SSH_HOST}
PROXMOX_SSH_USER=${PROXMOX_SSH_USER}
PROXMOX_SSH_PORT=${PROXMOX_SSH_PORT}
PROXMOX_SSH_PRIVATE_KEY=${PROXMOX_SSH_PRIVATE_KEY}
PROXMOX_SSH_PRIVATE_KEY_PATH=${PROXMOX_SSH_PRIVATE_KEY_PATH}
PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE=${PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE}
PROXMOX_SSH_PASSWORD=${PROXMOX_SSH_PASSWORD}
PROXMOX_SSH_HOST_FINGERPRINT=${PROXMOX_SSH_HOST_FINGERPRINT}
PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY=${PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY}
PROXMOX_PCT_COMMAND=${PROXMOX_PCT_COMMAND}
PROXMOX_SUDO=${PROXMOX_SUDO}
PROXMOX_OFFLINE_STAGE_COMMAND=${PROXMOX_OFFLINE_STAGE_COMMAND}
PROXMOX_NODE_MAJOR=${PROXMOX_NODE_MAJOR}
PROXMOX_OPENCLAW_PACKAGE=${PROXMOX_OPENCLAW_PACKAGE}
PROXMOX_HERMES_BIN=${PROXMOX_HERMES_BIN}
PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD=${PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD}

# ── NemoClaw / NVIDIA (when ENABLED_SANDBOX_PROFILES includes nemoclaw) ──
NVIDIA_API_KEY=${NVIDIA_API_KEY}
NEMOCLAW_DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b
# Defaults to the Nora-published GHCR image. For offline hosts or private
# clusters, build/preload nora-nemoclaw-agent:local and override this value.
NEMOCLAW_SANDBOX_IMAGE=${NEMOCLAW_SANDBOX_IMAGE}

# ── Security ─────────────────────────────────────────────────
CORS_ORIGINS=${CORS_ORIGINS}

# ── LLM Key Storage ─────────────────────────────────────────
KEY_STORAGE=database

# ── Backups & TLS (optional) ────────────────────────────────
# TLS_CERT_PATH=
# TLS_KEY_PATH=
# AWS_S3_BUCKET=
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
EOF

secure_env_file_permissions "$ENV_FILE"
materialize_compose_secret_files "$ENV_FILE"
ok ".env created successfully"
export COMPOSE_PATH_SEPARATOR=":"
export COMPOSE_FILE="docker-compose.yml:docker-compose.override.yml"

# ── Summary ──────────────────────────────────────────────────

echo ""
header "Setup Complete"

if [ -n "$DEFAULT_ADMIN_EMAIL" ]; then
  printf "  Admin:        %s\n" "$DEFAULT_ADMIN_EMAIL"
  printf "  Password:     %s\n" "$(echo "$DEFAULT_ADMIN_PASSWORD" | sed 's/./*/g')"
else
  printf "  Admin:        Not pre-seeded (create via signup)\n"
  printf "  Password:     Not set\n"
fi
printf "  Secrets:      auto-generated (JWT, AES, backups, Agent Hub)\n"
printf "  Database:     PostgreSQL 15 (Docker Compose)\n"
printf "  DB Access:    %s / auto-generated / %s (.env)\n" "$DB_USER" "$DB_NAME"
printf "  Redis:        Redis 7 (Docker Compose)\n"
if [ "$ACCESS_MODE" = "local" ]; then
  printf "  Access:       %s\n" "$NEXTAUTH_URL"
  printf "  Runtime:      Development services\n"
else
  printf "  Access:       %s\n" "$NEXTAUTH_URL"
  printf "  Runtime:      Production services\n"
  if [ "$ACCESS_MODE" = "public-tls" ]; then
    printf "  TLS:          Terminated by nginx on this host\n"
  else
    printf "  TLS:          Terminated by your upstream proxy\n"
  fi
fi

if [ "$PLATFORM_MODE" = "paas" ]; then
  printf "  Mode:         PaaS (Stripe billing)\n"
else
  printf "  Mode:         Self-hosted\n"
  printf "  Limits:       %svCPU / %sMB / %sGB / %s agents\n" "$MAX_VCPU" "$MAX_RAM_MB" "$MAX_DISK_GB" "$MAX_AGENTS"
fi

printf "  Families:     %s\n" "$ENABLED_RUNTIME_FAMILIES"
printf "  Backends:     %s\n" "$ENABLED_BACKENDS"
printf "  Sandboxes:    %s\n" "$ENABLED_SANDBOX_PROFILES"

if [ -n "$GOOGLE_CLIENT_ID" ] || [ -n "$GITHUB_CLIENT_ID" ]; then
  providers=""
  [ -n "$GOOGLE_CLIENT_ID" ] && providers="Google"
  [ -n "$GITHUB_CLIENT_ID" ] && providers="${providers:+$providers, }GitHub"
  printf "  OAuth:        %s\n" "$providers"
else
  printf "  OAuth:        Not configured (email/password only)\n"
fi

printf "  LLM:          Configure from Settings after login\n"

echo ""

# ── Start Nora ──────────────────────────────────────────────

printf "${CYAN}[info]${NC}  Start Nora now? [Y/n] "
read -r start_answer < /dev/tty
if [[ "$start_answer" =~ ^[Nn]$ ]]; then
  echo ""
  info "Run 'docker compose up -d --build' when you're ready to start."
  echo ""
  exit 0
fi

if [ "$CAN_START_NORA" != true ]; then
  echo ""
  warn "Startup skipped until the public TLS certificate is installed."
  info "After certs exist, run 'docker compose up -d --build'."
  echo ""
  exit 0
fi

echo ""
assert_nora_host_ports_available "$ENV_FILE" "$NGINX_HTTP_PORT"
# Only build what the install actually runs. This image bakes in openclaw and
# tsx, so building it for a Hermes-only install spends minutes on a runtime that
# will never be deployed (#409).
if csv_value_is_enabled "${ENABLED_RUNTIME_FAMILIES:-}" "openclaw"; then
  info "Building nora-openclaw-agent:local (prebaked openclaw + tsx)..."
  echo ""
  docker build \
    -f agent-runtime/Dockerfile.openclaw-agent \
    -t nora-openclaw-agent:local \
    agent-runtime/
  ok "OpenClaw agent image ready"
else
  info "OpenClaw runtime family disabled — skipping its agent image build."
fi

# Build Nora's exact local NemoClaw tag. Other refs follow provisioner policy:
# refresh mutable refs, reuse present immutable refs, and pull any missing ref.
if csv_value_is_enabled "${ENABLED_SANDBOX_PROFILES:-}" "nemoclaw"; then
  ensure_nemoclaw_sandbox_image "$NEMOCLAW_SANDBOX_IMAGE"
fi

start_compose_stack

# ── Done ─────────────────────────────────────────────────────

echo ""
header "Nora is live!"

printf "  Open your browser:  %s\n" "$NEXTAUTH_URL"
if [ -n "$DEFAULT_ADMIN_EMAIL" ]; then
  printf "  Login:              %s\n" "$DEFAULT_ADMIN_EMAIL"
else
  printf "  Login:              create an account at /signup\n"
fi
echo ""

info "Next: sign in, add an LLM provider in Settings, then open Deploy when you're ready to create your first agent."

echo ""
info "Useful commands:"
echo "    docker compose logs -f              # watch logs"
echo "    docker compose logs -f backend-api  # single service"
echo "    docker compose down                 # stop everything"
echo ""
info "Useful links:"
echo "    Quick start:        https://github.com/solomon2773/nora#quick-start"
echo "    Star Nora:          https://github.com/solomon2773/nora"
echo "    Public site:        https://nora.solomontsao.com"
echo "    Log in:             https://nora.solomontsao.com/login"
echo "    Create account:     https://nora.solomontsao.com/signup"
echo "    OSS / PaaS mode:    https://nora.solomontsao.com/pricing"
echo "    Start paths:        https://github.com/solomon2773/nora/blob/master/SUPPORT.md"
echo ""
