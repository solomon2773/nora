#!/usr/bin/env bash
# ============================================================
# Nora — One-line installer & setup
# ============================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh | bash
#   — or —
#   bash setup.sh        (from inside the repo)
#
# Clones the repo (if needed), generates secrets, configures
# the platform, collects an LLM key, starts Nora, deploys
# the first agent, and injects the key — all in one shot.
# ============================================================

set -euo pipefail

ENV_FILE=".env"

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

HAS_CURL=true

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

# Check for existing .env
if [ -f "$ENV_FILE" ]; then
  echo ""
  warn ".env already exists."
  printf "  Overwrite? [y/N] "
  read -r answer < /dev/tty
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    info "Keeping existing .env — no changes made."
    exit 0
  fi
fi

# ── Generate secrets ─────────────────────────────────────────

header "Generating Secrets"

JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
NEXTAUTH_SECRET=$(openssl rand -hex 32)

ok "JWT_SECRET      (64-char hex)"
ok "ENCRYPTION_KEY  (64-char hex — AES-256-GCM)"
ok "NEXTAUTH_SECRET (64-char hex)"

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

# ── Provisioner backend ──────────────────────────────────────

header "Provisioner Backend"

printf "  How should Nora provision agent containers?\n"
printf "    1) Docker (default) — Docker-in-Docker via local socket\n"
printf "    2) Proxmox — LXC containers via Proxmox REST API\n"
printf "    3) Kubernetes — Pods via Kubernetes API\n"
printf "  Select [1/2/3]: "
read -r backend_answer < /dev/tty

PROVISIONER_BACKEND="docker"
PROXMOX_API_URL=""
PROXMOX_TOKEN_ID=""
PROXMOX_TOKEN_SECRET=""
PROXMOX_NODE="pve"
PROXMOX_TEMPLATE="ubuntu-22.04-standard"

case "$backend_answer" in
  2)
    PROVISIONER_BACKEND="proxmox"
    echo ""
    printf "  Proxmox API URL (e.g., https://proxmox.local:8006/api2/json): "
    read -r PROXMOX_API_URL < /dev/tty
    printf "  Proxmox Token ID (e.g., user@pam!tokenname): "
    read -r PROXMOX_TOKEN_ID < /dev/tty
    printf "  Proxmox Token Secret: "
    read -r PROXMOX_TOKEN_SECRET < /dev/tty
    printf "  Proxmox Node [pve]: "
    read -r input < /dev/tty; PROXMOX_NODE="${input:-pve}"
    printf "  Proxmox Template [ubuntu-22.04-standard]: "
    read -r input < /dev/tty; PROXMOX_TEMPLATE="${input:-ubuntu-22.04-standard}"
    ok "Proxmox backend configured"
    ;;
  3)
    PROVISIONER_BACKEND="k8s"
    ok "Kubernetes backend — ensure kubeconfig is available in the worker container"
    ;;
  *)
    PROVISIONER_BACKEND="docker"
    ok "Docker backend (default)"
    ;;
esac

# ── Default Admin Account ─────────────────────────────────────

header "Default Admin Account"

printf "  This account is created on first boot so you can log in immediately.\n\n"
printf "  Admin email [admin@nora.local]: "
read -r admin_email_input < /dev/tty
DEFAULT_ADMIN_EMAIL="${admin_email_input:-admin@nora.local}"

printf "  Admin password [admin123]: "
read -r admin_pass_input < /dev/tty
DEFAULT_ADMIN_PASSWORD="${admin_pass_input:-admin123}"

if [ "$DEFAULT_ADMIN_PASSWORD" = "admin123" ]; then
  warn "Using default password 'admin123' — change it after first login"
else
  ok "Admin account: $DEFAULT_ADMIN_EMAIL (custom password)"
fi

# ── LLM Provider Key ─────────────────────────────────────────

header "LLM Provider (Required for your first agent)"

printf "  Choose a provider to connect to your first agent:\n\n"
printf "    1) Google AI (Gemini)          6) OpenRouter\n"
printf "    2) Anthropic (Claude)          7) Together AI\n"
printf "    3) OpenAI (GPT)               8) Groq\n"
printf "    4) DeepSeek                    9) Mistral\n"
printf "    5) xAI (Grok)                10) Skip — I'll add one later\n"
printf "\n  Select [1-10]: "
read -r llm_choice < /dev/tty

LLM_PROVIDER=""
LLM_API_KEY=""
LLM_MODEL=""
FIRST_AGENT_NAME=""

case "$llm_choice" in
  1)  LLM_PROVIDER="google";     LLM_MODEL="gemini-2.0-flash" ;;
  2)  LLM_PROVIDER="anthropic";  LLM_MODEL="claude-sonnet-4-5-20250514" ;;
  3)  LLM_PROVIDER="openai";     LLM_MODEL="gpt-4o" ;;
  4)  LLM_PROVIDER="deepseek";   LLM_MODEL="deepseek-chat" ;;
  5)  LLM_PROVIDER="xai";        LLM_MODEL="grok-3" ;;
  6)  LLM_PROVIDER="openrouter"; LLM_MODEL="openrouter/auto" ;;
  7)  LLM_PROVIDER="together";   LLM_MODEL="meta-llama/Llama-3-70b-chat-hf" ;;
  8)  LLM_PROVIDER="groq";       LLM_MODEL="llama-3.3-70b-versatile" ;;
  9)  LLM_PROVIDER="mistral";    LLM_MODEL="mistral-large-latest" ;;
  *)  LLM_PROVIDER="" ;;
esac

if [ -n "$LLM_PROVIDER" ]; then
  printf "  %s API key: " "$LLM_PROVIDER"
  read -r llm_key_input < /dev/tty
  if [ -n "$llm_key_input" ]; then
    LLM_API_KEY="$llm_key_input"
    ok "$LLM_PROVIDER key saved (model: $LLM_MODEL)"

    printf "\n  Name for your first agent [nora]: "
    read -r agent_name_input < /dev/tty
    FIRST_AGENT_NAME="${agent_name_input:-nora}"
    ok "Will deploy agent '$FIRST_AGENT_NAME' after startup"
  else
    warn "No key entered — skipping auto-deploy"
    LLM_PROVIDER=""
  fi
else
  info "Skipped — add an LLM key from Settings after login"
fi

# ── NemoClaw / NVIDIA ────────────────────────────────────────

header "NemoClaw (Optional)"

NEMOCLAW_ENABLED="false"
NVIDIA_API_KEY=""

printf "  Enable NVIDIA NemoClaw sandboxed agents?\n"
printf "  (Requires NVIDIA API key from build.nvidia.com)\n"
printf "  Enable NemoClaw? [y/N] "
read -r nemoclaw_answer < /dev/tty
if [[ "$nemoclaw_answer" =~ ^[Yy]$ ]]; then
  NEMOCLAW_ENABLED="true"
  printf "  NVIDIA API key: "
  read -r nvidia_key < /dev/tty
  if [ -n "$nvidia_key" ]; then
    NVIDIA_API_KEY="$nvidia_key"
    ok "NemoClaw enabled with API key"
  else
    warn "NemoClaw enabled but no key — add NVIDIA_API_KEY to .env later"
  fi
else
  info "NemoClaw disabled (enable later in .env)"
fi

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

# ── Write .env ───────────────────────────────────────────────

header "Writing Configuration"

info "Writing $ENV_FILE..."

cat > "$ENV_FILE" <<EOF
# ============================================================
# Nora — Environment Configuration
# ============================================================
# Auto-generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ============================================================

# ── Required (auto-generated) ────────────────────────────────
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# ── Default Admin Account (created on first boot) ────────────
DEFAULT_ADMIN_EMAIL=${DEFAULT_ADMIN_EMAIL}
DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}

# ── Database (defaults work with Docker Compose) ─────────────
DB_HOST=postgres
DB_USER=platform
DB_PASSWORD=platform
DB_NAME=platform
DB_PORT=5432

# ── Redis (defaults work with Docker Compose) ────────────────
REDIS_HOST=redis
REDIS_PORT=6379
PORT=4000

# ── OAuth ────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NEXTAUTH_URL=http://localhost:8080

# ── Platform Mode ────────────────────────────────────────────
PLATFORM_MODE=${PLATFORM_MODE}

# ── Self-hosted limits (only when PLATFORM_MODE=selfhosted) ──
MAX_VCPU=${MAX_VCPU}
MAX_RAM_MB=${MAX_RAM_MB}
MAX_DISK_GB=${MAX_DISK_GB}
MAX_AGENTS=${MAX_AGENTS}

# ── Billing (only when PLATFORM_MODE=paas) ───────────────────
BILLING_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=

# ── Provisioner ──────────────────────────────────────────────
PROVISIONER_BACKEND=${PROVISIONER_BACKEND}

# ── Proxmox (only when PROVISIONER_BACKEND=proxmox) ──────────
PROXMOX_API_URL=${PROXMOX_API_URL}
PROXMOX_TOKEN_ID=${PROXMOX_TOKEN_ID}
PROXMOX_TOKEN_SECRET=${PROXMOX_TOKEN_SECRET}
PROXMOX_NODE=${PROXMOX_NODE}
PROXMOX_TEMPLATE=${PROXMOX_TEMPLATE}

# ── NemoClaw / NVIDIA ────────────────────────────────────────
NEMOCLAW_ENABLED=${NEMOCLAW_ENABLED}
NVIDIA_API_KEY=${NVIDIA_API_KEY}
NEMOCLAW_DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b
NEMOCLAW_SANDBOX_IMAGE=ghcr.io/nvidia/openshell-community/sandboxes/openclaw

# ── Security ─────────────────────────────────────────────────
CORS_ORIGINS=http://localhost:8080

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

printf "  Admin:        %s\n" "$DEFAULT_ADMIN_EMAIL"
printf "  Password:     %s\n" "$(echo "$DEFAULT_ADMIN_PASSWORD" | sed 's/./*/g')"
printf "  Secrets:      auto-generated (JWT, AES, NextAuth)\n"
printf "  Database:     PostgreSQL 15 (Docker Compose)\n"
printf "  Redis:        Redis 7 (Docker Compose)\n"

if [ "$PLATFORM_MODE" = "paas" ]; then
  printf "  Mode:         PaaS (Stripe billing)\n"
else
  printf "  Mode:         Self-hosted\n"
  printf "  Limits:       %svCPU / %sMB / %sGB / %s agents\n" "$MAX_VCPU" "$MAX_RAM_MB" "$MAX_DISK_GB" "$MAX_AGENTS"
fi

case "$PROVISIONER_BACKEND" in
  proxmox)  printf "  Provisioner:  Proxmox LXC\n" ;;
  k8s)      printf "  Provisioner:  Kubernetes\n" ;;
  *)        printf "  Provisioner:  Docker (local socket)\n" ;;
esac

if [ "$NEMOCLAW_ENABLED" = "true" ]; then
  printf "  NemoClaw:     Enabled (NVIDIA Nemotron)\n"
else
  printf "  NemoClaw:     Disabled\n"
fi

if [ -n "$GOOGLE_CLIENT_ID" ] || [ -n "$GITHUB_CLIENT_ID" ]; then
  providers=""
  [ -n "$GOOGLE_CLIENT_ID" ] && providers="Google"
  [ -n "$GITHUB_CLIENT_ID" ] && providers="${providers:+$providers, }GitHub"
  printf "  OAuth:        %s\n" "$providers"
else
  printf "  OAuth:        Not configured (email/password only)\n"
fi

if [ -n "$LLM_PROVIDER" ]; then
  printf "  LLM:          %s (%s)\n" "$LLM_PROVIDER" "$LLM_MODEL"
  printf "  First Agent:  %s\n" "$FIRST_AGENT_NAME"
else
  printf "  LLM:          Not configured (add from Settings)\n"
fi

echo ""

# ── Start Nora ──────────────────────────────────────────────

printf "${CYAN}[info]${NC}  Start Nora now? [Y/n] "
read -r start_answer < /dev/tty
if [[ "$start_answer" =~ ^[Nn]$ ]]; then
  echo ""
  info "Run 'docker compose up -d' when you're ready to start."
  echo ""
  exit 0
fi

# Stop any existing deployment and clean up stale data
if docker compose ps --quiet 2>/dev/null | grep -q .; then
  info "Stopping existing Nora deployment..."
  docker compose down -v --remove-orphans 2>/dev/null || true
  # Remove orphaned agent containers from previous runs
  docker ps -a --filter "label=openclaw.agent.id" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
  ok "Cleaned up previous deployment"
fi

echo ""
info "Starting Nora (docker compose up -d)..."
echo ""
docker compose up -d
echo ""
ok "Nora is running!"

# ── Auto-deploy first agent ─────────────────────────────────

if [ -n "$LLM_PROVIDER" ] && [ -n "$LLM_API_KEY" ] && [ -n "$FIRST_AGENT_NAME" ] && [ "$HAS_CURL" = true ]; then
  header "Deploying First Agent"

  API_BASE="http://localhost:8080/api"
  MAX_WAIT=90
  WAITED=0

  info "Waiting for API to be ready..."
  while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf "${API_BASE}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    printf "."
  done
  echo ""

  if [ $WAITED -ge $MAX_WAIT ]; then
    warn "API didn't respond within ${MAX_WAIT}s — skipping auto-deploy"
    info "After services start, log in and deploy manually."
    echo ""
    exit 0
  fi

  ok "API is ready"

  # Login as admin — retry a few times since DB migration and admin seeding
  # run asynchronously after the health endpoint is already responding
  info "Logging in as $DEFAULT_ADMIN_EMAIL..."
  TOKEN=""
  LOGIN_ATTEMPTS=0
  LOGIN_MAX=10
  while [ $LOGIN_ATTEMPTS -lt $LOGIN_MAX ] && [ -z "$TOKEN" ]; do
    LOGIN_RESPONSE=$(curl -sf -X POST "${API_BASE}/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"${DEFAULT_ADMIN_EMAIL}\",\"password\":\"${DEFAULT_ADMIN_PASSWORD}\"}" 2>&1) || true

    TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -z "$TOKEN" ]; then
      LOGIN_ATTEMPTS=$((LOGIN_ATTEMPTS + 1))
      sleep 3
      printf "."
    fi
  done
  if [ -z "$TOKEN" ]; then echo ""; fi

  if [ -z "$TOKEN" ]; then
    warn "Could not authenticate after ${LOGIN_MAX} attempts."
    info "Log in manually at http://localhost:8080 and deploy your agent."
    echo ""
    exit 0
  fi
  ok "Authenticated"

  # Save LLM key
  info "Saving $LLM_PROVIDER API key..."
  PROVIDER_RESPONSE=$(curl -sf -X POST "${API_BASE}/llm-providers" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "{\"provider\":\"${LLM_PROVIDER}\",\"apiKey\":\"${LLM_API_KEY}\",\"model\":\"${LLM_MODEL}\"}" 2>&1) || true

  if echo "$PROVIDER_RESPONSE" | grep -q '"id"'; then
    ok "$LLM_PROVIDER key stored (encrypted, AES-256-GCM)"
  else
    warn "Could not save LLM key — add it from Settings > LLM Providers"
  fi

  # Deploy agent
  info "Deploying agent '$FIRST_AGENT_NAME'..."
  DEPLOY_RESPONSE=$(curl -sf -X POST "${API_BASE}/agents/deploy" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "{\"name\":\"${FIRST_AGENT_NAME}\"}" 2>&1) || true

  AGENT_ID=$(echo "$DEPLOY_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$AGENT_ID" ]; then
    ok "Agent queued for deployment (id: ${AGENT_ID:0:8}...)"

    # Wait for agent to come up, then sync key
    info "Waiting for agent to start (this may take 30-60s)..."
    AGENT_WAIT=0
    AGENT_MAX=120
    AGENT_RUNNING=false
    while [ $AGENT_WAIT -lt $AGENT_MAX ]; do
      AGENT_STATUS=$(curl -sf -X GET "${API_BASE}/agents/${AGENT_ID}" \
        -H "Authorization: Bearer ${TOKEN}" 2>&1) || true
      if echo "$AGENT_STATUS" | grep -q '"status":"running"'; then
        AGENT_RUNNING=true
        break
      fi
      sleep 5
      AGENT_WAIT=$((AGENT_WAIT + 5))
      printf "."
    done
    echo ""

    if [ "$AGENT_RUNNING" = true ]; then
      ok "Agent is running!"

      # The LLM key was injected as an env var at container creation time.
      # The startup CMD writes auth-profiles.json and sets the model automatically.
      # No explicit sync needed — just wait for the gateway to initialize.
      info "Waiting for gateway to initialize..."
      GW_WAIT=0
      GW_MAX=60
      GW_HEALTHY=false
      while [ $GW_WAIT -lt $GW_MAX ]; do
        GW_STATUS=$(curl -sf "${API_BASE}/agents/${AGENT_ID}/gateway/status" \
          -H "Authorization: Bearer ${TOKEN}" 2>&1) || true
        if echo "$GW_STATUS" | grep -q '"ok":true'; then
          GW_HEALTHY=true
          break
        fi
        sleep 5
        GW_WAIT=$((GW_WAIT + 5))
        printf "."
      done
      echo ""

      if [ "$GW_HEALTHY" = true ]; then
        ok "Gateway is online and model is configured"
      else
        warn "Gateway may still be starting — refresh the Status tab in a moment"
      fi
    else
      warn "Agent is still provisioning — it will be ready shortly"
      info "Sync your LLM key from Settings > LLM Providers after it starts"
    fi
  else
    warn "Could not deploy agent — deploy from the dashboard"
  fi
fi

# ── Done ─────────────────────────────────────────────────────

echo ""
header "Nora is live!"

printf "  Open your browser:  http://localhost:8080\n"
printf "  Login:              %s\n" "$DEFAULT_ADMIN_EMAIL"
echo ""

if [ -n "$FIRST_AGENT_NAME" ] && [ -n "$AGENT_ID" ]; then
  ok "Your agent '$FIRST_AGENT_NAME' is deploying — open the Chat tab to start talking!"
else
  info "Go to Deploy to create your first agent."
fi

echo ""
info "Useful commands:"
echo "    docker compose logs -f              # watch logs"
echo "    docker compose logs -f backend-api  # single service"
echo "    docker compose down                 # stop everything"
echo ""
info "Need a different path?"
echo "    Install guide:      https://github.com/solomon2773/nora/blob/master/docs/INSTALL.md"
echo "    Support paths:      https://github.com/solomon2773/nora/blob/master/SUPPORT.md"
echo "    Rollout help:       https://github.com/solomon2773/nora/discussions"
echo "    Hosted evaluation:  https://nora.solomontsao.com/signup"
echo "    Pricing / paths:    https://nora.solomontsao.com/pricing"
echo ""
