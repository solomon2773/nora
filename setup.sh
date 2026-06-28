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

  cp "$env_path" "$candidate"
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
  local exact_tag latest_tag

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  exact_tag="$(git describe --tags --exact-match 2>/dev/null || true)"
  if [ -n "$exact_tag" ]; then
    printf "%s\n" "$exact_tag"
    return 0
  fi

  latest_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  if [ -n "$latest_tag" ] && git merge-base --is-ancestor "$latest_tag" HEAD >/dev/null 2>&1; then
    printf "%s\n" "$latest_tag"
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
  ok "NORA_AGENT_HUB_API_KEY_HASH_SECRET generated (64-char hex)"
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
  ok "NORA_BACKUP_ENCRYPTION_KEY generated (64-char hex)"
}

remove_local_agent_containers() {
  local containers
  containers="$(
    {
      docker ps -a --filter "label=openclaw.agent.id" -q 2>/dev/null || true
      docker ps -a --filter "label=nora.agent.id" -q 2>/dev/null || true
    } | sort -u
  )"

  if [ -z "$containers" ]; then
    info "No local Nora agent containers found."
    return 0
  fi

  info "Removing local Nora agent containers..."
  while IFS= read -r container_id; do
    [ -z "$container_id" ] && continue
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  done <<EOF
$containers
EOF
  ok "Removed local Nora agent containers"
}

clean_reinstall_state() {
  warn "Clean reinstall selected: local compose containers and volumes will be removed."
  info "External Kubernetes, planned Proxmox, NemoClaw, and VM resources will not be touched."
  docker compose down -v --remove-orphans 2>/dev/null || true
  remove_local_agent_containers
  ok "Local Nora compose state cleaned"
}

start_compose_stack() {
  echo ""
  info "Starting Nora (docker compose up -d --build)..."
  info "Preserving Docker volumes and provisioned agent instances."
  echo ""
  docker compose up -d --build
  echo ""
  ok "Nora is running!"
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
  if [ "${#value}" -ge 2 ]; then
    first="${value:0:1}"
    last="${value: -1}"
    if { [ "$first" = '"' ] && [ "$last" = '"' ]; } || { [ "$first" = "'" ] && [ "$last" = "'" ]; }; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf "%s\n" "$value"
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

# Verify Compose
if docker compose version &>/dev/null; then
  ok "Docker Compose found: $(docker compose version --short 2>/dev/null || echo 'v2+')"
elif command -v docker-compose &>/dev/null; then
  warn "Found docker-compose (v1). Docker Compose v2+ is recommended."
else
  error "Docker Compose is required but was not installed. Re-run setup."
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
  info "Code update mode keeps $ENV_FILE, Postgres/backup volumes, and provisioned instances."
  # A leftover public-mode docker-compose.override.yml is auto-loaded by
  # `docker compose` and would pin a LOCAL stack to prod/TLS wiring (443 + cert
  # mounts). If .env selects the local nginx.conf, retire the stale override.
  if [ "$(read_env_value "$ENV_FILE" "NGINX_CONFIG_FILE" "nginx.conf")" = "nginx.conf" ] && [ -f "$COMPOSE_OVERRIDE_FILE" ]; then
    mv "$COMPOSE_OVERRIDE_FILE" "${COMPOSE_OVERRIDE_FILE}.disabled-$(date -u +%Y%m%d-%H%M%SZ)"
    warn "Disabled a stale ${COMPOSE_OVERRIDE_FILE} (it did not match local mode in $ENV_FILE)."
  fi
  update_source_checkout
  refresh_release_tags
  ensure_agent_hub_hash_secret_env "$ENV_FILE"
  ensure_backup_encryption_key_env "$ENV_FILE"
  stamp_release_tracking_env "$ENV_FILE"
  assert_nora_host_ports_available "$ENV_FILE"
  start_compose_stack
  echo ""
  info "Update complete. No compose volumes or agent Docker/K8s/VM instances were removed."
  exit 0
fi

if [ "$SETUP_MODE" = "clean-reinstall" ]; then
  header "Clean Reinstall"
  if [ -f "$ENV_FILE" ]; then
    ENV_BACKUP_FILE="$(backup_existing_env_file "$ENV_FILE")"
    ok "Existing $ENV_FILE backed up to $ENV_BACKUP_FILE"
  fi
  clean_reinstall_state
elif [ -f "$ENV_FILE" ]; then
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
DB_USER="nora"
DB_NAME="nora"
DB_PASSWORD="$(read_env_value "$ENV_FILE" "DB_PASSWORD" "")"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD=$(openssl rand -hex 24)

ok "JWT_SECRET            (64-char hex)"
ok "ENCRYPTION_KEY        (64-char hex — AES-256-GCM)"
ok "BACKUP_ENCRYPTION_KEY (64-char hex — managed backup archives)"
ok "AGENT_HUB_HASH        (64-char hex)"
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
HERMES_RUNTIME_ENABLED="false"
NEMOCLAW_SANDBOX_ENABLED="false"
PROXMOX_API_URL=""
PROXMOX_TOKEN_ID=""
PROXMOX_TOKEN_SECRET=""
PROXMOX_NODE="pve"
PROXMOX_TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
PROXMOX_HERMES_TEMPLATE=""
PROXMOX_NEMOCLAW_TEMPLATE=""
PROXMOX_ROOTFS_STORAGE="local-lvm"
PROXMOX_BRIDGE="vmbr0"
PROXMOX_SSH_HOST=""
PROXMOX_SSH_USER="root"
PROXMOX_SSH_PRIVATE_KEY_PATH=""
PROXMOX_SSH_PASSWORD=""
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
info "Proxmox is planned but release-blocked in this Nora release; setup will not enable it."

printf "  Enable Hermes runtime family? [y/N] "
read -r hermes_runtime_answer < /dev/tty
if [[ "$hermes_runtime_answer" =~ ^[Yy]$ ]]; then
  HERMES_RUNTIME_ENABLED="true"
  ok "Hermes runtime family enabled"
else
  info "Hermes runtime family disabled"
fi

printf "  Enable NemoClaw sandbox profile? [y/N] "
read -r nemoclaw_sandbox_answer < /dev/tty
if [[ "$nemoclaw_sandbox_answer" =~ ^[Yy]$ ]]; then
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
  info "NemoClaw sandbox profile disabled"
fi

enabled_backends=()
[ "$DOCKER_BACKEND_ENABLED" = "true" ] && enabled_backends+=("docker")

if [ ${#enabled_backends[@]} -eq 0 ]; then
  warn "No deploy backends selected — enabling Docker so Nora can deploy agents."
  DOCKER_BACKEND_ENABLED="true"
  enabled_backends=("docker")
fi

ENABLED_BACKENDS="$(IFS=,; echo "${enabled_backends[*]}")"
ok "Enabled backends: ${ENABLED_BACKENDS}"

enabled_runtime_families=("openclaw")
[ "$HERMES_RUNTIME_ENABLED" = "true" ] && enabled_runtime_families+=("hermes")

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

# ── Bootstrap Admin Account (Optional) ───────────────────────

header "Bootstrap Admin Account (Optional)"

printf "  Leave both fields blank to skip bootstrap admin creation.\n"
printf "  If set, the password must be at least 12 characters.\n\n"

while true; do
  printf "  Admin email [leave blank to skip]: "
  read -r admin_email_input < /dev/tty

  printf "  Admin password (min 12 chars, leave blank to skip): "
  read -rs admin_pass_input < /dev/tty
  printf "\n"

  if [ -z "$admin_email_input" ] && [ -z "$admin_pass_input" ]; then
    DEFAULT_ADMIN_EMAIL=""
    DEFAULT_ADMIN_PASSWORD=""
    info "Skipping bootstrap admin seed — create your operator account after first boot."
    break
  fi

  if [ -z "$admin_email_input" ] || [ -z "$admin_pass_input" ]; then
    warn "To pre-seed an admin, provide both email and password, or leave both blank to skip."
    continue
  fi

  if [ ${#admin_pass_input} -lt 12 ]; then
    warn "Bootstrap admin password must be at least 12 characters."
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
NEXT_PUBLIC_OAUTH_LOGIN_ENABLED="false"
if [ -n "$GOOGLE_CLIENT_ID" ] || [ -n "$GITHUB_CLIENT_ID" ]; then
  OAUTH_LOGIN_ENABLED="true"
  NEXT_PUBLIC_OAUTH_LOGIN_ENABLED="true"
fi

# ── Write .env ───────────────────────────────────────────────

header "Writing Configuration"

info "Writing $ENV_FILE..."

NORA_CURRENT_VERSION="$(resolve_current_release_version)"
NORA_CURRENT_COMMIT="$(resolve_current_release_commit)"
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

# ── Bootstrap Admin Account (optional; seeded only when both are set securely) ──
DEFAULT_ADMIN_EMAIL=${DEFAULT_ADMIN_EMAIL}
DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}

# ── Database (defaults work with Docker Compose) ─────────────
DB_HOST=postgres
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
DB_PORT=5432

# ── Redis (defaults work with Docker Compose) ────────────────
REDIS_HOST=redis
REDIS_PORT=6379
PORT=4000
BACKEND_API_PORT=${BACKEND_API_PORT}

# ── Access / URL ─────────────────────────────────────────────
NGINX_CONFIG_FILE=${NGINX_CONFIG_FILE}
NGINX_HTTP_PORT=${NGINX_HTTP_PORT}
# Forces the Secure flag on the session cookie for always-on-TLS public deploys
# (set to 1 for https public modes; empty for local http). Guards against an
# upstream proxy that strips X-Forwarded-Proto.
NORA_FORCE_SECURE_COOKIES=${NORA_FORCE_SECURE_COOKIES}

# ── OAuth ────────────────────────────────────────────────────
OAUTH_LOGIN_ENABLED=${OAUTH_LOGIN_ENABLED}
NEXT_PUBLIC_OAUTH_LOGIN_ENABLED=${NEXT_PUBLIC_OAUTH_LOGIN_ENABLED}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
NEXTAUTH_URL=${NEXTAUTH_URL}

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
NORA_UPGRADE_COMPOSE_FILES=
NORA_UPGRADE_PUBLIC_HEALTH_URL=
NORA_UPGRADE_HEALTHCHECK_ATTEMPTS=40
NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS=3
NORA_INSTALL_METHOD=source
NORA_MANUAL_UPGRADE_COMMAND=./setup.sh --update
NORA_MANUAL_UPGRADE_STEPS=

# ── Runtime families, deploy targets, and sandbox profiles ───
ENABLED_RUNTIME_FAMILIES=${ENABLED_RUNTIME_FAMILIES}
ENABLED_BACKENDS=${ENABLED_BACKENDS}
ENABLED_SANDBOX_PROFILES=${ENABLED_SANDBOX_PROFILES}

# ── Proxmox (planned; release-blocked in current Nora releases) ─────────
# These values are retained for adapter development and future validation.
# Setting them does not make Proxmox a supported deploy target yet.
PROXMOX_API_URL=${PROXMOX_API_URL}
PROXMOX_TOKEN_ID=${PROXMOX_TOKEN_ID}
PROXMOX_TOKEN_SECRET=${PROXMOX_TOKEN_SECRET}
PROXMOX_NODE=${PROXMOX_NODE}
PROXMOX_TEMPLATE=${PROXMOX_TEMPLATE}
PROXMOX_HERMES_TEMPLATE=${PROXMOX_HERMES_TEMPLATE}
PROXMOX_NEMOCLAW_TEMPLATE=${PROXMOX_NEMOCLAW_TEMPLATE}
PROXMOX_ROOTFS_STORAGE=${PROXMOX_ROOTFS_STORAGE}
PROXMOX_BRIDGE=${PROXMOX_BRIDGE}
PROXMOX_SSH_HOST=${PROXMOX_SSH_HOST}
PROXMOX_SSH_USER=${PROXMOX_SSH_USER}
PROXMOX_SSH_PRIVATE_KEY_PATH=${PROXMOX_SSH_PRIVATE_KEY_PATH}
PROXMOX_SSH_PASSWORD=${PROXMOX_SSH_PASSWORD}

# ── NemoClaw / NVIDIA (when ENABLED_SANDBOX_PROFILES includes nemoclaw) ──
NVIDIA_API_KEY=${NVIDIA_API_KEY}
NEMOCLAW_DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b
# Defaults to the Nora-published GHCR image. For offline hosts or private
# clusters, build/preload nora-nemoclaw-agent:local and override this value.
NEMOCLAW_SANDBOX_IMAGE=ghcr.io/solomon2773/nora-nemoclaw-agent:latest

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

ok ".env created successfully"

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
info "Building nora-openclaw-agent:local (prebaked openclaw + tsx)..."
echo ""
docker build \
  -f agent-runtime/Dockerfile.openclaw-agent \
  -t nora-openclaw-agent:local \
  agent-runtime/
ok "OpenClaw agent image ready"

# Only build the NemoClaw fallback image when the operator enables the sandbox
# and explicitly points NEMOCLAW_SANDBOX_IMAGE at the local tag.
case ",${ENABLED_SANDBOX_PROFILES:-}," in
  *,nemoclaw,*)
    if grep -Eq '^NEMOCLAW_SANDBOX_IMAGE=nora-nemoclaw-agent:local$' "$ENV_FILE"; then
      echo ""
      info "Building nora-nemoclaw-agent:local (OpenShell sandbox + tsx)..."
      echo ""
      docker build \
        -f agent-runtime/Dockerfile.nemoclaw-agent \
        -t nora-nemoclaw-agent:local \
        agent-runtime/
      ok "NemoClaw sandbox image ready"
    else
      info "Using GHCR NemoClaw sandbox image from NEMOCLAW_SANDBOX_IMAGE"
    fi
    ;;
esac

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
echo "    GitHub repo:        https://github.com/solomon2773/nora"
echo "    Public site:        https://nora.solomontsao.com"
echo "    Log in:             https://nora.solomontsao.com/login"
echo "    Create account:     https://nora.solomontsao.com/signup"
echo "    OSS / PaaS mode:    https://nora.solomontsao.com/pricing"
echo "    Start paths:        https://github.com/solomon2773/nora/blob/master/SUPPORT.md"
echo ""
