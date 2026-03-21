#!/usr/bin/env bash
# ============================================================
# Nora — First-time setup & .env generator
# ============================================================
# Usage:  bash setup.sh
#
# Generates a .env file with auto-generated cryptographic secrets
# and working defaults for Docker Compose development.
# Optionally starts the platform after configuration.
# ============================================================

set -euo pipefail

ENV_FILE=".env"
EXAMPLE_FILE=".env.example"

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

# ── Pre-flight checks ───────────────────────────────────────

header "Pre-flight Checks"

# Check Docker
if ! command -v docker &>/dev/null; then
  error "Docker is required but not found."
  echo "  Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi
ok "Docker found: $(docker --version | head -1)"

# Check Docker Compose
if docker compose version &>/dev/null; then
  ok "Docker Compose found: $(docker compose version --short 2>/dev/null || echo 'v2+')"
elif command -v docker-compose &>/dev/null; then
  warn "Found docker-compose (v1). Docker Compose v2+ is recommended."
  warn "  Upgrade: https://docs.docker.com/compose/install/"
else
  error "Docker Compose is required but not found."
  echo "  Install: https://docs.docker.com/compose/install/"
  exit 1
fi

# Check Docker daemon is running
if ! docker info &>/dev/null; then
  error "Docker daemon is not running. Start Docker and re-run."
  exit 1
fi
ok "Docker daemon is running"

# Check openssl
if ! command -v openssl &>/dev/null; then
  error "openssl is required but not found. Install it and re-run."
  exit 1
fi
ok "openssl found"

# Check for existing .env
if [ -f "$ENV_FILE" ]; then
  echo ""
  warn ".env already exists."
  printf "  Overwrite? [y/N] "
  read -r answer
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
read -r mode_answer

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
  read -r input; MAX_VCPU="${input:-16}"
  printf "  Max RAM (MB) per agent [32768]: "
  read -r input; MAX_RAM_MB="${input:-32768}"
  printf "  Max Disk (GB) per agent [500]: "
  read -r input; MAX_DISK_GB="${input:-500}"
  printf "  Max agents per user [50]: "
  read -r input; MAX_AGENTS="${input:-50}"
  ok "Self-hosted: ${MAX_VCPU} vCPU, ${MAX_RAM_MB}MB RAM, ${MAX_DISK_GB}GB disk, ${MAX_AGENTS} agents"
fi

# ── Provisioner backend ──────────────────────────────────────

header "Provisioner Backend"

printf "  How should Nora provision agent containers?\n"
printf "    1) Docker (default) — Docker-in-Docker via local socket\n"
printf "    2) Proxmox — LXC containers via Proxmox REST API\n"
printf "    3) Kubernetes — Pods via Kubernetes API\n"
printf "  Select [1/2/3]: "
read -r backend_answer

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
    read -r PROXMOX_API_URL
    printf "  Proxmox Token ID (e.g., user@pam!tokenname): "
    read -r PROXMOX_TOKEN_ID
    printf "  Proxmox Token Secret: "
    read -r PROXMOX_TOKEN_SECRET
    printf "  Proxmox Node [pve]: "
    read -r input; PROXMOX_NODE="${input:-pve}"
    printf "  Proxmox Template [ubuntu-22.04-standard]: "
    read -r input; PROXMOX_TEMPLATE="${input:-ubuntu-22.04-standard}"
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
read -r admin_email_input
DEFAULT_ADMIN_EMAIL="${admin_email_input:-admin@nora.local}"

printf "  Admin password [admin123]: "
read -r admin_pass_input
DEFAULT_ADMIN_PASSWORD="${admin_pass_input:-admin123}"

if [ "$DEFAULT_ADMIN_PASSWORD" = "admin123" ]; then
  warn "Using default password 'admin123' — change it after first login"
else
  ok "Admin account: $DEFAULT_ADMIN_EMAIL (custom password)"
fi

# ── NemoClaw / NVIDIA ────────────────────────────────────────

header "NemoClaw (Optional)"

NEMOCLAW_ENABLED="false"
NVIDIA_API_KEY=""

printf "  Enable NVIDIA NemoClaw sandboxed agents?\n"
printf "  (Requires NVIDIA API key from build.nvidia.com)\n"
printf "  Enable NemoClaw? [y/N] "
read -r nemoclaw_answer
if [[ "$nemoclaw_answer" =~ ^[Yy]$ ]]; then
  NEMOCLAW_ENABLED="true"
  printf "  NVIDIA API key: "
  read -r nvidia_key
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
read -r google_answer
if [[ "$google_answer" =~ ^[Yy]$ ]]; then
  printf "  Google Client ID: "
  read -r GOOGLE_CLIENT_ID
  printf "  Google Client Secret: "
  read -r GOOGLE_CLIENT_SECRET
  if [ -n "$GOOGLE_CLIENT_ID" ]; then
    ok "Google OAuth configured"
  fi
fi

printf "  Configure GitHub OAuth? [y/N] "
read -r github_answer
if [[ "$github_answer" =~ ^[Yy]$ ]]; then
  printf "  GitHub Client ID: "
  read -r GITHUB_CLIENT_ID
  printf "  GitHub Client Secret: "
  read -r GITHUB_CLIENT_SECRET
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
echo "┌────────────────────────────────────────────────────────┐"
echo "│                  Nora — Setup Complete                  │"
echo "├────────────────────────────────────────────────────────┤"
printf "│  Admin:        %s\n" "$DEFAULT_ADMIN_EMAIL"
printf "│  Password:     %s\n" "$(echo "$DEFAULT_ADMIN_PASSWORD" | sed 's/./*/g')"
printf "│  Secrets:      auto-generated (JWT, AES, NextAuth)    │\n"
printf "│  Database:     PostgreSQL 15 (Docker Compose)         │\n"
printf "│  Redis:        Redis 7 (Docker Compose)               │\n"

if [ "$PLATFORM_MODE" = "paas" ]; then
  printf "│  Mode:         PaaS (Stripe billing)                  │\n"
else
  printf "│  Mode:         Self-hosted                            │\n"
  printf "│  Limits:       %svCPU / %sMB / %sGB / %s agents\n" "$MAX_VCPU" "$MAX_RAM_MB" "$MAX_DISK_GB" "$MAX_AGENTS"
fi

case "$PROVISIONER_BACKEND" in
  proxmox)  printf "│  Provisioner:  Proxmox LXC                            │\n" ;;
  k8s)      printf "│  Provisioner:  Kubernetes                              │\n" ;;
  *)        printf "│  Provisioner:  Docker (local socket)                   │\n" ;;
esac

if [ "$NEMOCLAW_ENABLED" = "true" ]; then
  printf "│  NemoClaw:     Enabled (NVIDIA Nemotron)              │\n"
else
  printf "│  NemoClaw:     Disabled                               │\n"
fi

if [ -n "$GOOGLE_CLIENT_ID" ] || [ -n "$GITHUB_CLIENT_ID" ]; then
  providers=""
  [ -n "$GOOGLE_CLIENT_ID" ] && providers="Google"
  [ -n "$GITHUB_CLIENT_ID" ] && providers="${providers:+$providers, }GitHub"
  printf "│  OAuth:        %s\n" "$providers"
else
  printf "│  OAuth:        Not configured (email/password only)   │\n"
fi

echo "├────────────────────────────────────────────────────────┤"
echo "│                                                        │"
echo "│  Next steps:                                           │"
echo "│    1. docker compose up -d                             │"
echo "│    2. open http://localhost:8080                        │"
printf "│    3. Log in with: %-36s │\n" "$DEFAULT_ADMIN_EMAIL"
echo "│    4. Deploy your first agent                          │"
echo "│                                                        │"
echo "│  Useful commands:                                      │"
echo "│    docker compose logs -f          # watch all logs    │"
echo "│    docker compose logs -f backend-api  # single svc   │"
echo "│    docker compose down             # stop everything   │"
echo "│                                                        │"
echo "└────────────────────────────────────────────────────────┘"
echo ""

# ── Offer to start ───────────────────────────────────────────

printf "${CYAN}[info]${NC}  Start Nora now? [Y/n] "
read -r start_answer
if [[ ! "$start_answer" =~ ^[Nn]$ ]]; then
  echo ""
  info "Starting Nora (docker compose up -d)..."
  echo ""
  docker compose up -d
  echo ""
  ok "Nora is starting! Open http://localhost:8080 in your browser."
  info "First startup may take 1-2 minutes while services initialize."
  info "Watch logs with: docker compose logs -f"
else
  echo ""
  info "Run 'docker compose up -d' when you're ready to start."
fi

echo ""
