# ============================================================
# Nora — One-line installer & setup (Windows PowerShell)
# ============================================================
# Usage:
#   iwr -useb https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1 | iex
#   — or —
#   .\setup.ps1        (from inside the repo)
#
# Clones the repo (if needed), generates secrets and database
# credentials, configures the platform, and starts Nora.
# ============================================================

$ErrorActionPreference = "Stop"

$ENV_FILE = ".env"
$PUBLIC_NGINX_TEMPLATE = "infra/nginx_public.conf.template"
$TLS_NGINX_TEMPLATE = "infra/nginx_tls.conf"
$PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE = "infra/docker-compose.public-prod.yml"
$TLS_COMPOSE_OVERRIDE_TEMPLATE = "infra/docker-compose.public-tls.yml"
$PUBLIC_NGINX_CONF = "nginx.public.conf"
$COMPOSE_OVERRIDE_FILE = "docker-compose.override.yml"

# ── Color helpers ────────────────────────────────────────────

function Write-Info  { param($msg) Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[ok]    $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[error] $msg" -ForegroundColor Red }
function Write-Header { param($msg) Write-Host "`n── $msg ──`n" -ForegroundColor Cyan }

function Write-PublicNginxConfig {
    param([string]$TemplatePath, [string]$Domain)
    $content = Get-Content $TemplatePath -Raw
    $content = $content.Replace('$' + '{DOMAIN}', $Domain)
    $content | Out-File -FilePath $PUBLIC_NGINX_CONF -Encoding utf8NoBOM
}

function Write-ComposeOverride {
    param([string]$TemplatePath)
    Copy-Item $TemplatePath $COMPOSE_OVERRIDE_FILE -Force
}

function Clear-PublicAccessArtifacts {
    if (Test-Path $PUBLIC_NGINX_CONF) { Remove-Item $PUBLIC_NGINX_CONF -Force }
    if (Test-Path $COMPOSE_OVERRIDE_FILE) { Remove-Item $COMPOSE_OVERRIDE_FILE -Force }
}

# ── Helper: generate random hex ─────────────────────────────

function New-HexSecret {
    param([int]$Bytes = 32)
    $bytes = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return ($bytes | ForEach-Object { $_.ToString("x2") }) -join ''
}

# ── Helper: refresh PATH from registry ─────────────────────

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ── Helper: check if running as admin ──────────────────────

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── Auto-install functions ─────────────────────────────────

function Install-WithWinget {
    param([string]$PackageId, [string]$Name)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Installing $Name via winget..."
        winget install $PackageId --accept-package-agreements --accept-source-agreements --silent
        Refresh-Path
        return $true
    }
    return $false
}

function Install-WithChoco {
    param([string]$PackageName, [string]$Name)
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Info "Installing $Name via Chocolatey..."
        choco install $PackageName -y
        Refresh-Path
        return $true
    }
    return $false
}

function Install-GitIfMissing {
    if (Get-Command git -ErrorAction SilentlyContinue) { return }
    Write-Info "Git not found — installing..."

    if (Install-WithWinget "Git.Git" "Git") {
        # winget install succeeded
    } elseif (Install-WithChoco "git" "Git") {
        # choco install succeeded
    } else {
        Write-Err "Cannot auto-install Git. No package manager found (winget or choco)."
        Write-Host "  Install manually: https://git-scm.com/download/win"
        exit 1
    }

    # Verify
    Refresh-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "Git was installed but is not in PATH. Restart your terminal and re-run."
        exit 1
    }
    Write-Ok "Git installed: $(git --version)"
}

function Install-DockerIfMissing {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return }
    Write-Info "Docker not found — installing Docker Desktop..."

    if (-not (Test-Admin)) {
        Write-Err "Docker Desktop install requires administrator privileges."
        Write-Host "  Re-run this script as Administrator (right-click PowerShell > Run as Administrator)"
        exit 1
    }

    if (Install-WithWinget "Docker.DockerDesktop" "Docker Desktop") {
        # winget install succeeded
    } elseif (Install-WithChoco "docker-desktop" "Docker Desktop") {
        # choco install succeeded
    } else {
        Write-Err "Cannot auto-install Docker. No package manager found (winget or choco)."
        Write-Host "  Install manually: https://docs.docker.com/desktop/install/windows-install/"
        exit 1
    }

    Refresh-Path

    # Start Docker Desktop
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-Info "Starting Docker Desktop..."
        Start-Process $dockerExe
    }
}

function Wait-ForDocker {
    $max = 60
    $waited = 0
    Write-Info "Waiting for Docker daemon..."
    while ($waited -lt $max) {
        try {
            $null = docker info 2>&1
            return
        } catch {}
        Start-Sleep -Seconds 2
        $waited += 2
        Write-Host "." -NoNewline
    }
    Write-Host ""
    Write-Err "Docker daemon didn't start within ${max}s."
    Write-Host "  Start Docker Desktop manually and re-run this script."
    exit 1
}

# ── Pre-flight checks & auto-install ──────────────────────

$REPO_URL = "https://github.com/solomon2773/nora.git"
$INSTALL_DIR = "nora"

Write-Header "Pre-flight Checks"

# Ensure Git
Install-GitIfMissing
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Ok "Git found: $(git --version)"
}

# Ensure Docker
Install-DockerIfMissing

# Start daemon if not running
$dockerRunning = $false
try {
    $null = docker info 2>&1
    $dockerRunning = $true
} catch {}

if (-not $dockerRunning) {
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-Info "Starting Docker Desktop..."
        Start-Process $dockerExe
    }
    Wait-ForDocker
}

$dockerVer = docker --version 2>&1 | Select-Object -First 1
Write-Ok "Docker found: $dockerVer"

# Verify Compose
$composeOk = $false
try {
    $null = docker compose version 2>&1
    $composeVer = docker compose version --short 2>&1
    Write-Ok "Docker Compose found: $composeVer"
    $composeOk = $true
} catch {}

if (-not $composeOk) {
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        Write-Warn "Found docker-compose (v1). Docker Compose v2+ is recommended."
    } else {
        Write-Err "Docker Compose not found. Reinstall Docker Desktop."
        exit 1
    }
}

Write-Ok "Docker daemon is running"

# ── Clone repo if running via iwr pipe ────────────────────

$composeExists = (Test-Path "docker-compose.yml") -or (Test-Path "compose.yml") -or (Test-Path "compose.yaml")
if (-not $composeExists) {
    Write-Header "Downloading Nora"

    if (Test-Path $INSTALL_DIR) {
        Write-Info "Directory '$INSTALL_DIR' already exists — pulling latest..."
        Set-Location $INSTALL_DIR
        git pull --ff-only 2>$null
    } else {
        git clone $REPO_URL $INSTALL_DIR
        Set-Location $INSTALL_DIR
    }

    Write-Ok "Repository ready in ./$INSTALL_DIR"
}

# Check for existing .env
if (Test-Path $ENV_FILE) {
    Write-Host ""
    Write-Warn ".env already exists."
    $answer = Read-Host "  Overwrite? [y/N]"
    if ($answer -notmatch '^[Yy]$') {
        Write-Info "Keeping existing .env — no changes made."
        exit 0
    }
}

# ── Generate secrets ─────────────────────────────────────────

Write-Header "Generating Secrets"

$JWT_SECRET      = New-HexSecret
$ENCRYPTION_KEY  = New-HexSecret
$NEXTAUTH_SECRET = New-HexSecret
$DB_USER         = "nora"
$DB_NAME         = "nora"
$DB_PASSWORD     = New-HexSecret -Bytes 24

Write-Ok "JWT_SECRET      (64-char hex)"
Write-Ok "ENCRYPTION_KEY  (64-char hex — AES-256-GCM)"
Write-Ok "NEXTAUTH_SECRET (64-char hex)"
Write-Ok "DB_PASSWORD     (48-char hex)"

# ── Platform mode ────────────────────────────────────────────

Write-Header "Platform Configuration"

Write-Host "  Platform Mode:"
Write-Host "    1) Self-hosted (default) — operator sets resource limits"
Write-Host "    2) PaaS — Stripe billing with plan-locked resources"
$modeAnswer = Read-Host "  Select [1/2]"

$MAX_VCPU   = "16"
$MAX_RAM_MB = "32768"
$MAX_DISK_GB = "500"
$MAX_AGENTS = "50"

if ($modeAnswer -eq "2") {
    $PLATFORM_MODE = "paas"
    Write-Ok "PaaS mode — configure Stripe keys in .env after setup"
} else {
    $PLATFORM_MODE = "selfhosted"
    Write-Host ""
    $input = Read-Host "  Max vCPU per agent [16]"
    if ($input) { $MAX_VCPU = $input }
    $input = Read-Host "  Max RAM (MB) per agent [32768]"
    if ($input) { $MAX_RAM_MB = $input }
    $input = Read-Host "  Max Disk (GB) per agent [500]"
    if ($input) { $MAX_DISK_GB = $input }
    $input = Read-Host "  Max agents per user [50]"
    if ($input) { $MAX_AGENTS = $input }
    Write-Ok "Self-hosted: ${MAX_VCPU} vCPU, ${MAX_RAM_MB}MB RAM, ${MAX_DISK_GB}GB disk, ${MAX_AGENTS} agents"
}

# ── Deploy backends ──────────────────────────────────────────

Write-Header "Deploy Backends"

$DOCKER_BACKEND_ENABLED = $true
$K8S_BACKEND_ENABLED = $false
$PROXMOX_BACKEND_ENABLED = $false
$NEMOCLAW_BACKEND_ENABLED = $false
$K8S_NAMESPACE = "openclaw-agents"
$K8S_EXPOSURE_MODE = "cluster-ip"
$K8S_RUNTIME_NODE_PORT = ""
$K8S_GATEWAY_NODE_PORT = ""
$K8S_RUNTIME_HOST = ""
$PROXMOX_API_URL = ""
$PROXMOX_TOKEN_ID = ""
$PROXMOX_TOKEN_SECRET = ""
$PROXMOX_NODE = "pve"
$PROXMOX_TEMPLATE = "ubuntu-22.04-standard"
$NVIDIA_API_KEY = ""

$dockerBackendAnswer = Read-Host "  Enable Docker backend for local socket provisioning? [Y/n]"
if ($dockerBackendAnswer -match '^[Nn]$') {
    $DOCKER_BACKEND_ENABLED = $false
    Write-Info "Docker backend disabled"
} else {
    Write-Ok "Docker backend enabled"
}

$k8sBackendAnswer = Read-Host "  Enable Kubernetes backend? [y/N]"
if ($k8sBackendAnswer -match '^[Yy]$') {
    $K8S_BACKEND_ENABLED = $true
    Write-Ok "Kubernetes backend enabled — ensure kubeconfig is available in backend-api and worker-provisioner"
} else {
    Write-Info "Kubernetes backend disabled"
}

$proxmoxBackendAnswer = Read-Host "  Enable Proxmox backend? [y/N]"
if ($proxmoxBackendAnswer -match '^[Yy]$') {
    $PROXMOX_BACKEND_ENABLED = $true
    Write-Host ""
    $PROXMOX_API_URL      = Read-Host "  Proxmox API URL (e.g., https://proxmox.local:8006/api2/json)"
    $PROXMOX_TOKEN_ID     = Read-Host "  Proxmox Token ID (e.g., user@pam!tokenname)"
    $PROXMOX_TOKEN_SECRET = Read-Host "  Proxmox Token Secret"
    $input = Read-Host "  Proxmox Node [pve]"
    if ($input) { $PROXMOX_NODE = $input }
    $input = Read-Host "  Proxmox Template [ubuntu-22.04-standard]"
    if ($input) { $PROXMOX_TEMPLATE = $input }
    Write-Ok "Proxmox backend configured"
} else {
    Write-Info "Proxmox backend disabled"
}

$nemoclawBackendAnswer = Read-Host "  Enable NemoClaw backend? [y/N]"
if ($nemoclawBackendAnswer -match '^[Yy]$') {
    $NEMOCLAW_BACKEND_ENABLED = $true
    $nvidiaKey = Read-Host "  NVIDIA API key [optional during setup]"
    if ($nvidiaKey) {
        $NVIDIA_API_KEY = $nvidiaKey
        Write-Ok "NemoClaw backend enabled with NVIDIA API key"
    } else {
        Write-Warn "NemoClaw enabled without NVIDIA_API_KEY — add it to .env later if needed"
    }
} else {
    Write-Info "NemoClaw backend disabled"
}

$enabledBackends = @()
if ($DOCKER_BACKEND_ENABLED) { $enabledBackends += "docker" }
if ($K8S_BACKEND_ENABLED) { $enabledBackends += "k8s" }
if ($PROXMOX_BACKEND_ENABLED) { $enabledBackends += "proxmox" }
if ($NEMOCLAW_BACKEND_ENABLED) { $enabledBackends += "nemoclaw" }

if ($enabledBackends.Count -eq 0) {
    Write-Warn "No deploy backends selected — enabling Docker so Nora can deploy agents."
    $DOCKER_BACKEND_ENABLED = $true
    $enabledBackends = @("docker")
}

$ENABLED_BACKENDS = $enabledBackends -join ","
Write-Ok "Enabled backends: $ENABLED_BACKENDS"

# ── Access mode ──────────────────────────────────────────────

Write-Header "Access Mode"

Write-Host "  How should users reach Nora?"
Write-Host "    1) Local only (default) — http://localhost:8080"
Write-Host "    2) Public domain behind HTTPS proxy — nginx listens on port 80"
Write-Host "    3) Public domain with TLS at nginx — nginx listens on ports 80 and 443"
$accessAnswer = Read-Host "  Select [1/2/3]"

$ACCESS_MODE = "local"
$PUBLIC_DOMAIN = ""
$PUBLIC_SCHEME = "http"
$NEXTAUTH_URL = "http://localhost:8080"
$CORS_ORIGINS = "http://localhost:8080"
$NGINX_CONFIG_FILE = "nginx.conf"
$NGINX_HTTP_PORT = "8080"
$CAN_START_NORA = $true

switch ($accessAnswer) {
    "2" {
        while ($true) {
            $PUBLIC_DOMAIN = Read-Host "  Public domain (hosted default: nora.solomontsao.com; self-hosted: your own domain)"
            if ($PUBLIC_DOMAIN -match '^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$') { break }
            Write-Warn "Enter a valid hostname without http:// or path segments."
        }

        $schemeInput = Read-Host "  Public URL scheme [https]"
        $PUBLIC_SCHEME = if ($schemeInput) { $schemeInput.ToLowerInvariant() } else { "https" }
        if ($PUBLIC_SCHEME -ne "http" -and $PUBLIC_SCHEME -ne "https") {
            Write-Warn "Unsupported scheme '$PUBLIC_SCHEME' — using https."
            $PUBLIC_SCHEME = "https"
        }

        Write-PublicNginxConfig -TemplatePath $PUBLIC_NGINX_TEMPLATE -Domain $PUBLIC_DOMAIN
        Write-ComposeOverride -TemplatePath $PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE

        $ACCESS_MODE = "public-proxy"
        $NEXTAUTH_URL = "${PUBLIC_SCHEME}://${PUBLIC_DOMAIN}"
        $CORS_ORIGINS = $NEXTAUTH_URL
        $NGINX_CONFIG_FILE = $PUBLIC_NGINX_CONF
        $NGINX_HTTP_PORT = "80"
        Write-Ok "Public proxy mode — nginx will serve $PUBLIC_DOMAIN on port 80"
    }
    "3" {
        while ($true) {
            $PUBLIC_DOMAIN = Read-Host "  Public domain (hosted default: nora.solomontsao.com; self-hosted: your own domain)"
            if ($PUBLIC_DOMAIN -match '^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$') { break }
            Write-Warn "Enter a valid hostname without http:// or path segments."
        }

        Write-PublicNginxConfig -TemplatePath $TLS_NGINX_TEMPLATE -Domain $PUBLIC_DOMAIN
        Write-ComposeOverride -TemplatePath $TLS_COMPOSE_OVERRIDE_TEMPLATE

        $ACCESS_MODE = "public-tls"
        $PUBLIC_SCHEME = "https"
        $NEXTAUTH_URL = "https://${PUBLIC_DOMAIN}"
        $CORS_ORIGINS = $NEXTAUTH_URL
        $NGINX_CONFIG_FILE = $PUBLIC_NGINX_CONF
        $NGINX_HTTP_PORT = "80"

        if (-not (Test-Path "/etc/letsencrypt/live/$PUBLIC_DOMAIN/fullchain.pem") -or -not (Test-Path "/etc/letsencrypt/live/$PUBLIC_DOMAIN/privkey.pem")) {
            $CAN_START_NORA = $false
            Write-Warn "TLS certs not found for $PUBLIC_DOMAIN."
            Write-Info "Run: DOMAIN=$PUBLIC_DOMAIN EMAIL=you@example.com ./infra/setup-tls.sh"
            Write-Info "The stack will be configured, but startup will be skipped until certs are installed."
        } else {
            Write-Ok "Public TLS mode — certs found for $PUBLIC_DOMAIN"
        }
    }
    default {
        Clear-PublicAccessArtifacts
        Write-Ok "Local mode — Nora will be available at http://localhost:8080"
    }
}

# ── Bootstrap Admin Account (Optional) ───────────────────────

Write-Header "Bootstrap Admin Account (Optional)"

Write-Host "  Leave both fields blank to skip bootstrap admin creation."
Write-Host "  If set, the password must be at least 12 characters.`n"

while ($true) {
    $adminEmailInput = Read-Host "  Admin email [leave blank to skip]"
    $adminPassInput = Read-Host "  Admin password (min 12 chars, leave blank to skip)"

    if (-not $adminEmailInput -and -not $adminPassInput) {
        $DEFAULT_ADMIN_EMAIL = ""
        $DEFAULT_ADMIN_PASSWORD = ""
        Write-Info "Skipping bootstrap admin seed — create your operator account after first boot."
        break
    }

    if (-not $adminEmailInput -or -not $adminPassInput) {
        Write-Warn "To pre-seed an admin, provide both email and password, or leave both blank to skip."
        continue
    }

    if ($adminPassInput.Length -lt 12) {
        Write-Warn "Bootstrap admin password must be at least 12 characters."
        continue
    }

    $DEFAULT_ADMIN_EMAIL = $adminEmailInput
    $DEFAULT_ADMIN_PASSWORD = $adminPassInput
    Write-Ok "Bootstrap admin configured: $DEFAULT_ADMIN_EMAIL"
    break
}

# ── LLM Provider ─────────────────────────────────────────────

Write-Header "LLM Provider"

Write-Info "Setup no longer creates an agent automatically."
Write-Info "Add your LLM provider key from Settings after login."

# ── OAuth (optional) ─────────────────────────────────────────

Write-Header "OAuth (Optional)"

$GOOGLE_CLIENT_ID = ""
$GOOGLE_CLIENT_SECRET = ""
$GITHUB_CLIENT_ID = ""
$GITHUB_CLIENT_SECRET = ""

$googleAnswer = Read-Host "  Configure Google OAuth? [y/N]"
if ($googleAnswer -match '^[Yy]$') {
    $GOOGLE_CLIENT_ID     = Read-Host "  Google Client ID"
    $GOOGLE_CLIENT_SECRET = Read-Host "  Google Client Secret"
    if ($GOOGLE_CLIENT_ID) { Write-Ok "Google OAuth configured" }
}

$githubAnswer = Read-Host "  Configure GitHub OAuth? [y/N]"
if ($githubAnswer -match '^[Yy]$') {
    $GITHUB_CLIENT_ID     = Read-Host "  GitHub Client ID"
    $GITHUB_CLIENT_SECRET = Read-Host "  GitHub Client Secret"
    if ($GITHUB_CLIENT_ID) { Write-Ok "GitHub OAuth configured" }
}

if (-not $GOOGLE_CLIENT_ID -and -not $GITHUB_CLIENT_ID) {
    Write-Info "No OAuth configured — users will sign up with email/password"
}

$OAUTH_LOGIN_ENABLED = "false"
$NEXT_PUBLIC_OAUTH_LOGIN_ENABLED = "false"
if ($GOOGLE_CLIENT_ID -or $GITHUB_CLIENT_ID) {
    $OAUTH_LOGIN_ENABLED = "true"
    $NEXT_PUBLIC_OAUTH_LOGIN_ENABLED = "true"
}

# ── Write .env ───────────────────────────────────────────────

Write-Header "Writing Configuration"

Write-Info "Writing $ENV_FILE..."

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$envContent = @"
# ============================================================
# Nora — Environment Configuration
# ============================================================
# Auto-generated by setup.ps1 on $timestamp
# ============================================================

# ── Required (auto-generated) ────────────────────────────────
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY

# ── Bootstrap Admin Account (optional; seeded only when both are set securely) ──
DEFAULT_ADMIN_EMAIL=$DEFAULT_ADMIN_EMAIL
DEFAULT_ADMIN_PASSWORD=$DEFAULT_ADMIN_PASSWORD

# ── Database (defaults work with Docker Compose) ─────────────
DB_HOST=postgres
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_PORT=5432

# ── Redis (defaults work with Docker Compose) ────────────────
REDIS_HOST=redis
REDIS_PORT=6379
PORT=4000

# ── Access / URL ─────────────────────────────────────────────
NGINX_CONFIG_FILE=$NGINX_CONFIG_FILE
NGINX_HTTP_PORT=$NGINX_HTTP_PORT

# ── OAuth ────────────────────────────────────────────────────
OAUTH_LOGIN_ENABLED=$OAUTH_LOGIN_ENABLED
NEXT_PUBLIC_OAUTH_LOGIN_ENABLED=$NEXT_PUBLIC_OAUTH_LOGIN_ENABLED
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
NEXTAUTH_SECRET=$NEXTAUTH_SECRET
NEXTAUTH_URL=$NEXTAUTH_URL

# ── Platform Mode ────────────────────────────────────────────
PLATFORM_MODE=$PLATFORM_MODE

# ── Self-hosted limits (only when PLATFORM_MODE=selfhosted) ──
MAX_VCPU=$MAX_VCPU
MAX_RAM_MB=$MAX_RAM_MB
MAX_DISK_GB=$MAX_DISK_GB
MAX_AGENTS=$MAX_AGENTS

# ── Billing (only when PLATFORM_MODE=paas) ───────────────────
BILLING_ENABLED=false
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=

# ── Deploy backends ──────────────────────────────────────────
ENABLED_BACKENDS=$ENABLED_BACKENDS

# ── Kubernetes (when ENABLED_BACKENDS includes k8s) ──────────
K8S_NAMESPACE=$K8S_NAMESPACE
K8S_EXPOSURE_MODE=$K8S_EXPOSURE_MODE
K8S_RUNTIME_NODE_PORT=$K8S_RUNTIME_NODE_PORT
K8S_GATEWAY_NODE_PORT=$K8S_GATEWAY_NODE_PORT
K8S_RUNTIME_HOST=$K8S_RUNTIME_HOST

# ── Proxmox (when ENABLED_BACKENDS includes proxmox) ─────────
PROXMOX_API_URL=$PROXMOX_API_URL
PROXMOX_TOKEN_ID=$PROXMOX_TOKEN_ID
PROXMOX_TOKEN_SECRET=$PROXMOX_TOKEN_SECRET
PROXMOX_NODE=$PROXMOX_NODE
PROXMOX_TEMPLATE=$PROXMOX_TEMPLATE

# ── NemoClaw / NVIDIA (when ENABLED_BACKENDS includes nemoclaw) ──
NVIDIA_API_KEY=$NVIDIA_API_KEY
NEMOCLAW_DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b
NEMOCLAW_SANDBOX_IMAGE=ghcr.io/nvidia/openshell-community/sandboxes/openclaw

# ── Security ─────────────────────────────────────────────────
CORS_ORIGINS=$CORS_ORIGINS

# ── LLM Key Storage ─────────────────────────────────────────
KEY_STORAGE=database

# ── Backups & TLS (optional) ────────────────────────────────
# TLS_CERT_PATH=
# TLS_KEY_PATH=
# AWS_S3_BUCKET=
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
"@

$envContent | Out-File -FilePath $ENV_FILE -Encoding utf8NoBOM

Write-Ok ".env created successfully"

# ── Summary ──────────────────────────────────────────────────

Write-Host ""
Write-Header "Setup Complete"

if ($DEFAULT_ADMIN_EMAIL) {
    $maskedPass = '*' * $DEFAULT_ADMIN_PASSWORD.Length
    Write-Host "  Admin:        $DEFAULT_ADMIN_EMAIL"
    Write-Host "  Password:     $maskedPass"
} else {
    Write-Host "  Admin:        Not pre-seeded (create via signup)"
    Write-Host "  Password:     Not set"
}
Write-Host "  Secrets:      auto-generated (JWT, AES, NextAuth)"
Write-Host "  Database:     PostgreSQL 15 (Docker Compose)"
Write-Host "  DB Access:    $DB_USER / auto-generated / $DB_NAME (.env)"
Write-Host "  Redis:        Redis 7 (Docker Compose)"
if ($ACCESS_MODE -eq "local") {
    Write-Host "  Access:       Local only"
    Write-Host "  Runtime:      Development services"
} else {
    Write-Host "  Access:       $NEXTAUTH_URL"
    Write-Host "  Runtime:      Production services"
    if ($ACCESS_MODE -eq "public-tls") {
        Write-Host "  TLS:          Terminated by nginx on this host"
    } else {
        Write-Host "  TLS:          Terminated by your upstream proxy"
    }
}

if ($PLATFORM_MODE -eq "paas") {
    Write-Host "  Mode:         PaaS (Stripe billing)"
} else {
    Write-Host "  Mode:         Self-hosted"
    Write-Host ("  Limits:       {0}vCPU / {1}MB / {2}GB / {3} agents" -f $MAX_VCPU, $MAX_RAM_MB, $MAX_DISK_GB, $MAX_AGENTS)
}

Write-Host "  Backends:     $ENABLED_BACKENDS"

if ($GOOGLE_CLIENT_ID -or $GITHUB_CLIENT_ID) {
    $providers = @()
    if ($GOOGLE_CLIENT_ID) { $providers += "Google" }
    if ($GITHUB_CLIENT_ID) { $providers += "GitHub" }
    Write-Host ("  OAuth:        {0}" -f ($providers -join ", "))
} else {
    Write-Host "  OAuth:        Not configured (email/password only)"
}

Write-Host "  LLM:          Configure from Settings after login"

Write-Host ""

# ── Start Nora ──────────────────────────────────────────────

$startAnswer = Read-Host "[info]  Start Nora now? [Y/n]"
if ($startAnswer -match '^[Nn]$') {
    Write-Host ""
    Write-Info "Run 'docker compose up -d --build' when you're ready to start."
    Write-Host ""
    exit 0
}

if (-not $CAN_START_NORA) {
    Write-Host ""
    Write-Warn "Startup skipped until the public TLS certificate is installed."
    Write-Info "After certs exist, run 'docker compose up -d --build'."
    Write-Host ""
    exit 0
}

# Stop any existing deployment and clean up stale data
$existingContainers = docker compose ps --quiet 2>$null
if ($existingContainers) {
    Write-Info "Stopping existing Nora deployment..."
    docker compose down -v --remove-orphans 2>$null
    # Remove orphaned agent containers from previous runs
    $agentContainers = docker ps -a --filter "label=openclaw.agent.id" -q 2>$null
    if ($agentContainers) {
        $agentContainers | ForEach-Object { docker rm -f $_ 2>$null }
    }
    Write-Ok "Cleaned up previous deployment"
}

Write-Host ""
Write-Info "Starting Nora (docker compose up -d --build)..."
Write-Host ""
docker compose up -d --build
Write-Host ""
Write-Ok "Nora is running!"

# ── Done ─────────────────────────────────────────────────────

Write-Host ""
Write-Header "Nora is live!"

Write-Host "  Open your browser:  $NEXTAUTH_URL"
if ($DEFAULT_ADMIN_EMAIL) {
    Write-Host "  Login:              $DEFAULT_ADMIN_EMAIL"
} else {
    Write-Host "  Login:              create an account at /signup"
}
Write-Host ""

Write-Info "Next: sign in, add an LLM provider in Settings, then open Deploy when you're ready to create your first agent."

Write-Host ""
Write-Info "Useful commands:"
Write-Host "    docker compose logs -f              # watch logs"
Write-Host "    docker compose logs -f backend-api  # single service"
Write-Host "    docker compose down                 # stop everything"
Write-Host ""
Write-Info "Useful links:"
Write-Host "    Quick start:        https://github.com/solomon2773/nora#quick-start"
Write-Host "    GitHub repo:        https://github.com/solomon2773/nora"
Write-Host "    Public site:        https://nora.solomontsao.com"
Write-Host "    Log in:             https://nora.solomontsao.com/login"
Write-Host "    Create account:     https://nora.solomontsao.com/signup"
Write-Host "    OSS / PaaS mode:    https://nora.solomontsao.com/pricing"
Write-Host "    Start paths:        https://github.com/solomon2773/nora/blob/master/SUPPORT.md"
Write-Host ""
