# ============================================================
# Nora — One-line installer & setup (Windows PowerShell)
# ============================================================
# Usage:
#   iwr -useb https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1 | iex
#   — or —
#   .\setup.ps1        (from inside the repo)
#
# Clones the repo (if needed), generates secrets, configures
# the platform, collects an LLM key, starts Nora, deploys
# the first agent, and injects the key — all in one shot.
# ============================================================

$ErrorActionPreference = "Stop"

$ENV_FILE = ".env"

# ── Color helpers ────────────────────────────────────────────

function Write-Info  { param($msg) Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[ok]    $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[error] $msg" -ForegroundColor Red }
function Write-Header { param($msg) Write-Host "`n── $msg ──`n" -ForegroundColor Cyan }

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

Write-Ok "JWT_SECRET      (64-char hex)"
Write-Ok "ENCRYPTION_KEY  (64-char hex — AES-256-GCM)"
Write-Ok "NEXTAUTH_SECRET (64-char hex)"

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

# ── Provisioner backend ──────────────────────────────────────

Write-Header "Provisioner Backend"

Write-Host "  How should Nora provision agent containers?"
Write-Host "    1) Docker (default) — Docker-in-Docker via local socket"
Write-Host "    2) Proxmox — LXC containers via Proxmox REST API"
Write-Host "    3) Kubernetes — Pods via Kubernetes API"
$backendAnswer = Read-Host "  Select [1/2/3]"

$PROVISIONER_BACKEND = "docker"
$PROXMOX_API_URL = ""
$PROXMOX_TOKEN_ID = ""
$PROXMOX_TOKEN_SECRET = ""
$PROXMOX_NODE = "pve"
$PROXMOX_TEMPLATE = "ubuntu-22.04-standard"

switch ($backendAnswer) {
    "2" {
        $PROVISIONER_BACKEND = "proxmox"
        Write-Host ""
        $PROXMOX_API_URL     = Read-Host "  Proxmox API URL (e.g., https://proxmox.local:8006/api2/json)"
        $PROXMOX_TOKEN_ID    = Read-Host "  Proxmox Token ID (e.g., user@pam!tokenname)"
        $PROXMOX_TOKEN_SECRET = Read-Host "  Proxmox Token Secret"
        $input = Read-Host "  Proxmox Node [pve]"
        if ($input) { $PROXMOX_NODE = $input }
        $input = Read-Host "  Proxmox Template [ubuntu-22.04-standard]"
        if ($input) { $PROXMOX_TEMPLATE = $input }
        Write-Ok "Proxmox backend configured"
    }
    "3" {
        $PROVISIONER_BACKEND = "k8s"
        Write-Ok "Kubernetes backend — ensure kubeconfig is available in the worker container"
    }
    default {
        $PROVISIONER_BACKEND = "docker"
        Write-Ok "Docker backend (default)"
    }
}

# ── Default Admin Account ─────────────────────────────────────

Write-Header "Default Admin Account"

Write-Host "  This account is created on first boot so you can log in immediately.`n"
$adminEmailInput = Read-Host "  Admin email [admin@nora.local]"
$DEFAULT_ADMIN_EMAIL = if ($adminEmailInput) { $adminEmailInput } else { "admin@nora.local" }

$adminPassInput = Read-Host "  Admin password [admin123]"
$DEFAULT_ADMIN_PASSWORD = if ($adminPassInput) { $adminPassInput } else { "admin123" }

if ($DEFAULT_ADMIN_PASSWORD -eq "admin123") {
    Write-Warn "Using default password 'admin123' — change it after first login"
} else {
    Write-Ok "Admin account: $DEFAULT_ADMIN_EMAIL (custom password)"
}

# ── LLM Provider Key ─────────────────────────────────────────

Write-Header "LLM Provider (Required for your first agent)"

Write-Host "  Choose a provider to connect to your first agent:`n"
Write-Host "    1) Google AI (Gemini)          6) OpenRouter"
Write-Host "    2) Anthropic (Claude)          7) Together AI"
Write-Host "    3) OpenAI (GPT)               8) Groq"
Write-Host "    4) DeepSeek                    9) Mistral"
Write-Host "    5) xAI (Grok)                10) Skip — I'll add one later"
Write-Host ""
$llmChoice = Read-Host "  Select [1-10]"

$LLM_PROVIDER = ""
$LLM_API_KEY = ""
$LLM_MODEL = ""
$FIRST_AGENT_NAME = ""

switch ($llmChoice) {
    "1" { $LLM_PROVIDER = "google";     $LLM_MODEL = "gemini-2.0-flash" }
    "2" { $LLM_PROVIDER = "anthropic";  $LLM_MODEL = "claude-sonnet-4-5-20250514" }
    "3" { $LLM_PROVIDER = "openai";     $LLM_MODEL = "gpt-4o" }
    "4" { $LLM_PROVIDER = "deepseek";   $LLM_MODEL = "deepseek-chat" }
    "5" { $LLM_PROVIDER = "xai";        $LLM_MODEL = "grok-3" }
    "6" { $LLM_PROVIDER = "openrouter"; $LLM_MODEL = "openrouter/auto" }
    "7" { $LLM_PROVIDER = "together";   $LLM_MODEL = "meta-llama/Llama-3-70b-chat-hf" }
    "8" { $LLM_PROVIDER = "groq";       $LLM_MODEL = "llama-3.3-70b-versatile" }
    "9" { $LLM_PROVIDER = "mistral";    $LLM_MODEL = "mistral-large-latest" }
    default { $LLM_PROVIDER = "" }
}

if ($LLM_PROVIDER) {
    $llmKeyInput = Read-Host "  $LLM_PROVIDER API key"
    if ($llmKeyInput) {
        $LLM_API_KEY = $llmKeyInput
        Write-Ok "$LLM_PROVIDER key saved (model: $LLM_MODEL)"

        $agentNameInput = Read-Host "`n  Name for your first agent [nora]"
        $FIRST_AGENT_NAME = if ($agentNameInput) { $agentNameInput } else { "nora" }
        Write-Ok "Will deploy agent '$FIRST_AGENT_NAME' after startup"
    } else {
        Write-Warn "No key entered — skipping auto-deploy"
        $LLM_PROVIDER = ""
    }
} else {
    Write-Info "Skipped — add an LLM key from Settings after login"
}

# ── NemoClaw / NVIDIA ────────────────────────────────────────

Write-Header "NemoClaw (Optional)"

$NEMOCLAW_ENABLED = "false"
$NVIDIA_API_KEY = ""

Write-Host "  Enable NVIDIA NemoClaw sandboxed agents?"
Write-Host "  (Requires NVIDIA API key from build.nvidia.com)"
$nemoAnswer = Read-Host "  Enable NemoClaw? [y/N]"
if ($nemoAnswer -match '^[Yy]$') {
    $NEMOCLAW_ENABLED = "true"
    $nvidiaKey = Read-Host "  NVIDIA API key"
    if ($nvidiaKey) {
        $NVIDIA_API_KEY = $nvidiaKey
        Write-Ok "NemoClaw enabled with API key"
    } else {
        Write-Warn "NemoClaw enabled but no key — add NVIDIA_API_KEY to .env later"
    }
} else {
    Write-Info "NemoClaw disabled (enable later in .env)"
}

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

# ── Default Admin Account (created on first boot) ────────────
DEFAULT_ADMIN_EMAIL=$DEFAULT_ADMIN_EMAIL
DEFAULT_ADMIN_PASSWORD=$DEFAULT_ADMIN_PASSWORD

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
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
NEXTAUTH_SECRET=$NEXTAUTH_SECRET
NEXTAUTH_URL=http://localhost:8080

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

# ── Provisioner ──────────────────────────────────────────────
PROVISIONER_BACKEND=$PROVISIONER_BACKEND

# ── Proxmox (only when PROVISIONER_BACKEND=proxmox) ──────────
PROXMOX_API_URL=$PROXMOX_API_URL
PROXMOX_TOKEN_ID=$PROXMOX_TOKEN_ID
PROXMOX_TOKEN_SECRET=$PROXMOX_TOKEN_SECRET
PROXMOX_NODE=$PROXMOX_NODE
PROXMOX_TEMPLATE=$PROXMOX_TEMPLATE

# ── NemoClaw / NVIDIA ────────────────────────────────────────
NEMOCLAW_ENABLED=$NEMOCLAW_ENABLED
NVIDIA_API_KEY=$NVIDIA_API_KEY
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
"@

$envContent | Out-File -FilePath $ENV_FILE -Encoding utf8NoBOM

Write-Ok ".env created successfully"

# ── Summary ──────────────────────────────────────────────────

Write-Host ""
Write-Header "Setup Complete"

$maskedPass = '*' * $DEFAULT_ADMIN_PASSWORD.Length
Write-Host "  Admin:        $DEFAULT_ADMIN_EMAIL"
Write-Host "  Password:     $maskedPass"
Write-Host "  Secrets:      auto-generated (JWT, AES, NextAuth)"
Write-Host "  Database:     PostgreSQL 15 (Docker Compose)"
Write-Host "  Redis:        Redis 7 (Docker Compose)"

if ($PLATFORM_MODE -eq "paas") {
    Write-Host "  Mode:         PaaS (Stripe billing)"
} else {
    Write-Host "  Mode:         Self-hosted"
    Write-Host ("  Limits:       {0}vCPU / {1}MB / {2}GB / {3} agents" -f $MAX_VCPU, $MAX_RAM_MB, $MAX_DISK_GB, $MAX_AGENTS)
}

switch ($PROVISIONER_BACKEND) {
    "proxmox" { Write-Host "  Provisioner:  Proxmox LXC" }
    "k8s"     { Write-Host "  Provisioner:  Kubernetes" }
    default   { Write-Host "  Provisioner:  Docker (local socket)" }
}

if ($NEMOCLAW_ENABLED -eq "true") {
    Write-Host "  NemoClaw:     Enabled (NVIDIA Nemotron)"
} else {
    Write-Host "  NemoClaw:     Disabled"
}

if ($GOOGLE_CLIENT_ID -or $GITHUB_CLIENT_ID) {
    $providers = @()
    if ($GOOGLE_CLIENT_ID) { $providers += "Google" }
    if ($GITHUB_CLIENT_ID) { $providers += "GitHub" }
    Write-Host ("  OAuth:        {0}" -f ($providers -join ", "))
} else {
    Write-Host "  OAuth:        Not configured (email/password only)"
}

if ($LLM_PROVIDER) {
    Write-Host ("  LLM:          {0} ({1})" -f $LLM_PROVIDER, $LLM_MODEL)
    Write-Host "  First Agent:  $FIRST_AGENT_NAME"
} else {
    Write-Host "  LLM:          Not configured (add from Settings)"
}

Write-Host ""

# ── Start Nora ──────────────────────────────────────────────

$startAnswer = Read-Host "[info]  Start Nora now? [Y/n]"
if ($startAnswer -match '^[Nn]$') {
    Write-Host ""
    Write-Info "Run 'docker compose up -d' when you're ready to start."
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
Write-Info "Starting Nora (docker compose up -d)..."
Write-Host ""
docker compose up -d
Write-Host ""
Write-Ok "Nora is running!"

# ── Auto-deploy first agent ─────────────────────────────────

$AGENT_ID = ""

if ($LLM_PROVIDER -and $LLM_API_KEY -and $FIRST_AGENT_NAME) {
    Write-Header "Deploying First Agent"

    $API_BASE = "http://localhost:8080/api"
    $MAX_WAIT = 90
    $waited = 0

    Write-Info "Waiting for API to be ready..."
    while ($waited -lt $MAX_WAIT) {
        try {
            $null = Invoke-RestMethod -Uri "$API_BASE/health" -TimeoutSec 3 -ErrorAction Stop
            break
        } catch {
            Start-Sleep -Seconds 2
            $waited += 2
            Write-Host "." -NoNewline
        }
    }
    Write-Host ""

    if ($waited -ge $MAX_WAIT) {
        Write-Warn "API didn't respond within ${MAX_WAIT}s — skipping auto-deploy"
        Write-Info "After services start, log in and deploy manually."
    } else {
        Write-Ok "API is ready"

        # Login as admin — retry since DB migration and admin seeding
        # run asynchronously after the health endpoint is already responding
        Write-Info "Logging in as $DEFAULT_ADMIN_EMAIL..."
        $TOKEN = ""
        $loginAttempts = 0
        $loginMax = 10
        while ($loginAttempts -lt $loginMax -and -not $TOKEN) {
            try {
                $loginBody = @{ email = $DEFAULT_ADMIN_EMAIL; password = $DEFAULT_ADMIN_PASSWORD } | ConvertTo-Json
                $loginResp = Invoke-RestMethod -Uri "$API_BASE/auth/login" -Method POST -ContentType "application/json" -Body $loginBody -ErrorAction Stop
                $TOKEN = $loginResp.token
            } catch {
                $TOKEN = ""
                $loginAttempts++
                Start-Sleep -Seconds 3
                Write-Host "." -NoNewline
            }
        }
        if (-not $TOKEN) { Write-Host "" }

        if (-not $TOKEN) {
            Write-Warn "Could not authenticate after $loginMax attempts."
            Write-Info "Log in manually at http://localhost:8080 and deploy your agent."
        } else {
            Write-Ok "Authenticated"
            $headers = @{ Authorization = "Bearer $TOKEN" }

            # Save LLM key
            Write-Info "Saving $LLM_PROVIDER API key..."
            try {
                $providerBody = @{ provider = $LLM_PROVIDER; apiKey = $LLM_API_KEY; model = $LLM_MODEL } | ConvertTo-Json
                $providerResp = Invoke-RestMethod -Uri "$API_BASE/llm-providers" -Method POST -ContentType "application/json" -Headers $headers -Body $providerBody -ErrorAction Stop
                Write-Ok "$LLM_PROVIDER key stored (encrypted, AES-256-GCM)"
            } catch {
                Write-Warn "Could not save LLM key — add it from Settings > LLM Providers"
            }

            # Deploy agent
            Write-Info "Deploying agent '$FIRST_AGENT_NAME'..."
            try {
                $deployBody = @{ name = $FIRST_AGENT_NAME } | ConvertTo-Json
                $deployResp = Invoke-RestMethod -Uri "$API_BASE/agents/deploy" -Method POST -ContentType "application/json" -Headers $headers -Body $deployBody -ErrorAction Stop
                $AGENT_ID = $deployResp.id
            } catch {
                $AGENT_ID = ""
            }

            if ($AGENT_ID) {
                $shortId = $AGENT_ID.Substring(0, [Math]::Min(8, $AGENT_ID.Length))
                Write-Ok "Agent queued for deployment (id: $shortId...)"

                # Wait for agent to come up, then sync key
                Write-Info "Waiting for agent to start (this may take 30-60s)..."
                $agentWait = 0
                $agentMax = 120
                $agentRunning = $false
                while ($agentWait -lt $agentMax) {
                    try {
                        $agentStatus = Invoke-RestMethod -Uri "$API_BASE/agents/$AGENT_ID" -Headers $headers -ErrorAction Stop
                        if ($agentStatus.status -eq "running") {
                            $agentRunning = $true
                            break
                        }
                    } catch {}
                    Start-Sleep -Seconds 5
                    $agentWait += 5
                    Write-Host "." -NoNewline
                }
                Write-Host ""

                if ($agentRunning) {
                    Write-Ok "Agent is running!"

                    # The LLM key was injected as an env var at container creation time.
                    # The startup CMD writes auth-profiles.json and sets the model automatically.
                    Write-Info "Waiting for gateway to initialize..."
                    $gwWait = 0
                    $gwMax = 60
                    $gwHealthy = $false
                    while ($gwWait -lt $gwMax) {
                        try {
                            $gwStatus = Invoke-RestMethod -Uri "$API_BASE/agents/$AGENT_ID/gateway/status" -Headers $headers -TimeoutSec 5 -ErrorAction Stop
                            if ($gwStatus.health.ok -eq $true) {
                                $gwHealthy = $true
                                break
                            }
                        } catch {}
                        Start-Sleep -Seconds 5
                        $gwWait += 5
                        Write-Host "." -NoNewline
                    }
                    Write-Host ""

                    if ($gwHealthy) {
                        Write-Ok "Gateway is online and model is configured"
                    } else {
                        Write-Warn "Gateway may still be starting — refresh the Status tab in a moment"
                    }
                } else {
                    Write-Warn "Agent is still provisioning — it will be ready shortly"
                    Write-Info "Sync your LLM key from Settings > LLM Providers after it starts"
                }
            } else {
                Write-Warn "Could not deploy agent — deploy from the dashboard"
            }
        }
    }
}

# ── Done ─────────────────────────────────────────────────────

Write-Host ""
Write-Header "Nora is live!"

Write-Host "  Open your browser:  http://localhost:8080"
Write-Host "  Login:              $DEFAULT_ADMIN_EMAIL"
Write-Host ""

if ($FIRST_AGENT_NAME -and $AGENT_ID) {
    Write-Ok "Your agent '$FIRST_AGENT_NAME' is deploying — open the Chat tab to start talking!"
} else {
    Write-Info "Go to Deploy to create your first agent."
}

Write-Host ""
Write-Info "Useful commands:"
Write-Host "    docker compose logs -f              # watch logs"
Write-Host "    docker compose logs -f backend-api  # single service"
Write-Host "    docker compose down                 # stop everything"
Write-Host ""
Write-Info "Need a different path?"
Write-Host "    Install guide:      https://github.com/solomon2773/nora/blob/master/docs/INSTALL.md"
Write-Host "    Support paths:      https://github.com/solomon2773/nora/blob/master/SUPPORT.md"
Write-Host "    Rollout help:       https://github.com/solomon2773/nora/discussions"
Write-Host "    Hosted evaluation:  https://nora.solomontsao.com/signup"
Write-Host "    Pricing / paths:    https://nora.solomontsao.com/pricing"
Write-Host ""
