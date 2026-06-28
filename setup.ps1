# ============================================================
# Nora — One-line installer & setup (Windows PowerShell)
# ============================================================
# Usage:
#   iwr -useb https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1 | iex
#   — or —
#   .\setup.ps1        (from inside the repo)
#   .\setup.ps1 -Update
#   .\setup.ps1 -CleanReinstall
#
# Clones the repo (if needed), generates secrets and database
# credentials, configures the platform, and starts Nora.
# Requires PowerShell 7+ (pwsh). Windows PowerShell 5 is not supported.
# ============================================================

param(
    [switch]$Install,
    [switch]$Update,
    [switch]$CleanReinstall
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host "[error] setup.ps1 requires PowerShell 7 or newer." -ForegroundColor Red
    Write-Host "        Current version: $($PSVersionTable.PSVersion)"
    Write-Host "        Install PowerShell 7, then run this script from pwsh:"
    Write-Host "        pwsh -ExecutionPolicy Bypass -File .\setup.ps1"
    exit 1
}

$ENV_FILE = ".env"
$ENV_BACKUP_FILE = $null
$NORA_GITHUB_REPO_SLUG = "solomon2773/nora"
$PUBLIC_NGINX_TEMPLATE = "infra/nginx_public.conf.template"
$TLS_NGINX_TEMPLATE = "infra/nginx_tls.conf"
$PUBLIC_PROD_COMPOSE_OVERRIDE_TEMPLATE = "infra/docker-compose.public-prod.yml"
$TLS_COMPOSE_OVERRIDE_TEMPLATE = "infra/docker-compose.public-tls.yml"
$PUBLIC_NGINX_CONF = "nginx.public.conf"
$COMPOSE_OVERRIDE_FILE = "docker-compose.override.yml"
$SETUP_MODE = ""

$selectedModes = @($Install.IsPresent, $Update.IsPresent, $CleanReinstall.IsPresent) | Where-Object { $_ }
if ($selectedModes.Count -gt 1) {
    Write-Host "[error] Choose only one setup mode." -ForegroundColor Red
    exit 1
}
if ($Install) { $SETUP_MODE = "install" }
elseif ($Update) { $SETUP_MODE = "update" }
elseif ($CleanReinstall) { $SETUP_MODE = "clean-reinstall" }

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

function Backup-ExistingEnvFile {
    param([string]$EnvPath)

    $resolvedEnvPath = (Resolve-Path -LiteralPath $EnvPath).Path
    $envDirectory = Split-Path -Parent $resolvedEnvPath
    $envName = Split-Path -Leaf $resolvedEnvPath
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssZ")
    $candidate = Join-Path $envDirectory "$envName.backup-$timestamp"
    $suffix = 1

    while (Test-Path -LiteralPath $candidate) {
        $candidate = Join-Path $envDirectory "$envName.backup-$timestamp.$suffix"
        $suffix += 1
    }

    Copy-Item -LiteralPath $resolvedEnvPath -Destination $candidate -Force
    return $candidate
}

function Update-SourceCheckout {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) {
        return
    }

    $dirty = git status --porcelain
    if ($dirty) {
        Write-Warn "Skipping git pull because this worktree has uncommitted changes."
        return
    }

    $branch = git symbolic-ref --quiet --short HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $branch) {
        Write-Info "Skipping git pull because this checkout is detached."
        return
    }

    $null = git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Info "Pulling latest code for $branch..."
        git pull --ff-only
    } else {
        Write-Info "Skipping git pull because $branch has no upstream."
    }
}

function Refresh-ReleaseTags {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) {
        return
    }

    $branch = git symbolic-ref --quiet --short HEAD 2>$null | Select-Object -First 1
    $remote = ""

    if ($LASTEXITCODE -eq 0 -and $branch) {
        $branch = $branch.Trim()
        $remote = git config --get "branch.$branch.remote" 2>$null | Select-Object -First 1
        if ($LASTEXITCODE -ne 0) { $remote = "" }
    }

    if (-not $remote) {
        $remote = git remote 2>$null | Select-Object -First 1
        if ($LASTEXITCODE -ne 0) { $remote = "" }
    }

    if ($remote) { $remote = $remote.Trim() }
    if (-not $remote) {
        Write-Warn "Skipping release tag refresh because this checkout has no Git remote."
        return
    }

    Write-Info "Fetching release tags from $remote..."
    git fetch --tags --prune $remote
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Release tags refreshed"
    } else {
        Write-Warn "Release tag refresh failed; Admin Settings may show stale release tracking."
    }
}

function Resolve-CurrentReleaseCommit {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) {
        return ""
    }

    $commit = git rev-parse HEAD 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $commit) {
        return ""
    }

    return $commit.Trim()
}

function Resolve-CurrentReleaseVersion {
    $null = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0) {
        return ""
    }

    $exactTag = git describe --tags --exact-match 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and $exactTag) {
        return $exactTag.Trim()
    }

    $latestTag = git describe --tags --abbrev=0 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $latestTag) {
        return ""
    }

    $latestTag = $latestTag.Trim()
    $null = git merge-base --is-ancestor $latestTag HEAD 2>$null
    if ($LASTEXITCODE -eq 0) {
        return $latestTag
    }

    return ""
}

function Update-ReleaseTrackingEnv {
    param([string]$EnvPath)

    if (-not (Test-Path $EnvPath)) {
        return
    }

    $currentCommit = Resolve-CurrentReleaseCommit
    if (-not $currentCommit) {
        Write-Warn "Skipping release tracking stamp because the current Git commit could not be resolved."
        return
    }

    $currentVersion = Resolve-CurrentReleaseVersion
    $lines = Get-Content -LiteralPath $EnvPath
    $updatedLines = New-Object System.Collections.Generic.List[string]
    $sawVersion = $false
    $sawCommit = $false
    $sawRepo = $false

    foreach ($line in $lines) {
        if ($line -match '^NORA_CURRENT_VERSION=') {
            $updatedLines.Add("NORA_CURRENT_VERSION=$currentVersion")
            $sawVersion = $true
        } elseif ($line -match '^NORA_CURRENT_COMMIT=') {
            $updatedLines.Add("NORA_CURRENT_COMMIT=$currentCommit")
            $sawCommit = $true
        } elseif ($line -match '^NORA_GITHUB_REPO=') {
            $updatedLines.Add("NORA_GITHUB_REPO=$NORA_GITHUB_REPO_SLUG")
            $sawRepo = $true
        } else {
            $updatedLines.Add($line)
        }
    }

    if (-not $sawVersion) { $updatedLines.Add("NORA_CURRENT_VERSION=$currentVersion") }
    if (-not $sawCommit) { $updatedLines.Add("NORA_CURRENT_COMMIT=$currentCommit") }
    if (-not $sawRepo) { $updatedLines.Add("NORA_GITHUB_REPO=$NORA_GITHUB_REPO_SLUG") }

    $updatedLines | Out-File -FilePath $EnvPath -Encoding utf8NoBOM
    $label = if ($currentVersion) { $currentVersion } else { "source checkout" }
    Write-Ok "Release tracking stamped: $label @ $($currentCommit.Substring(0, [Math]::Min(12, $currentCommit.Length)))"
}

function Get-EnvAssignmentValue {
    param([string]$Line)

    $value = $Line -replace '^[^=]*=', ''
    $value = $value -replace '\s+#.*$', ''
    $value = $value.Trim()
    if (
        ($value.Length -ge 2) -and
        (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))
    ) {
        $value = $value.Substring(1, $value.Length - 2).Trim()
    }
    return $value
}

function Test-AgentHubHashSecretPresent {
    param([string[]]$Lines)

    foreach ($line in $Lines) {
        if ($line -match '^\s*NORA_AGENT_HUB_API_KEY_HASH_SECRET\s*=') {
            if (Get-EnvAssignmentValue -Line $line) {
                return $true
            }
        }
    }
    return $false
}

function Test-BackupEncryptionKeyPresent {
    param([string[]]$Lines)

    foreach ($line in $Lines) {
        if ($line -match '^\s*NORA_BACKUP_ENCRYPTION_KEY\s*=') {
            if (Get-EnvAssignmentValue -Line $line) {
                return $true
            }
        }
    }
    return $false
}

function Ensure-AgentHubHashSecretEnv {
    param([string]$EnvPath)

    if (-not (Test-Path $EnvPath)) {
        return
    }

    $lines = Get-Content -LiteralPath $EnvPath
    if (Test-AgentHubHashSecretPresent -Lines $lines) {
        Write-Info "NORA_AGENT_HUB_API_KEY_HASH_SECRET already set; preserving existing value."
        return
    }

    $secret = New-HexSecret
    $updatedLines = New-Object System.Collections.Generic.List[string]
    $wroteSecret = $false

    foreach ($line in $lines) {
        if ($line -match '^\s*NORA_AGENT_HUB_API_KEY_HASH_SECRET\s*=') {
            if (-not $wroteSecret) {
                $updatedLines.Add("NORA_AGENT_HUB_API_KEY_HASH_SECRET=$secret")
                $wroteSecret = $true
            }
            continue
        }
        $updatedLines.Add($line)
    }

    if (-not $wroteSecret) {
        if ($updatedLines.Count -gt 0) {
            $updatedLines.Add("")
        }
        $updatedLines.Add("NORA_AGENT_HUB_API_KEY_HASH_SECRET=$secret")
    }

    $updatedLines | Out-File -FilePath $EnvPath -Encoding utf8NoBOM
    Write-Ok "NORA_AGENT_HUB_API_KEY_HASH_SECRET generated (64-char hex)"
}

function Ensure-BackupEncryptionKeyEnv {
    param([string]$EnvPath)

    if (-not (Test-Path $EnvPath)) {
        return
    }

    $lines = Get-Content -LiteralPath $EnvPath
    if (Test-BackupEncryptionKeyPresent -Lines $lines) {
        Write-Info "NORA_BACKUP_ENCRYPTION_KEY already set; preserving existing value."
        return
    }

    $secret = New-HexSecret
    $updatedLines = New-Object System.Collections.Generic.List[string]
    $wroteSecret = $false

    foreach ($line in $lines) {
        if ($line -match '^\s*NORA_BACKUP_ENCRYPTION_KEY\s*=') {
            if (-not $wroteSecret) {
                $updatedLines.Add("NORA_BACKUP_ENCRYPTION_KEY=$secret")
                $wroteSecret = $true
            }
            continue
        }
        if ($line -match '^\s*ENCRYPTION_KEY\s*=') {
            $updatedLines.Add($line)
            if (-not $wroteSecret) {
                $updatedLines.Add("NORA_BACKUP_ENCRYPTION_KEY=$secret")
                $wroteSecret = $true
            }
            continue
        }
        $updatedLines.Add($line)
    }

    if (-not $wroteSecret) {
        if ($updatedLines.Count -gt 0) {
            $updatedLines.Add("")
        }
        $updatedLines.Add("NORA_BACKUP_ENCRYPTION_KEY=$secret")
    }

    $updatedLines | Out-File -FilePath $EnvPath -Encoding utf8NoBOM
    Write-Ok "NORA_BACKUP_ENCRYPTION_KEY generated (64-char hex)"
}

function Remove-LocalAgentContainers {
    $containerIds = @()
    foreach ($label in @("openclaw.agent.id", "nora.agent.id")) {
        $ids = docker ps -a --filter "label=$label" -q 2>$null
        if ($ids) { $containerIds += $ids }
    }

    $containerIds = $containerIds | Where-Object { $_ } | Sort-Object -Unique
    if (-not $containerIds) {
        Write-Info "No local Nora agent containers found."
        return
    }

    Write-Info "Removing local Nora agent containers..."
    foreach ($containerId in $containerIds) {
        docker rm -f $containerId 2>$null | Out-Null
    }
    Write-Ok "Removed local Nora agent containers"
}

function Invoke-CleanReinstallState {
    Write-Warn "Clean reinstall selected: local compose containers and volumes will be removed."
    Write-Info "External Kubernetes, planned Proxmox, NemoClaw, and VM resources will not be touched."
    docker compose down -v --remove-orphans 2>$null
    Remove-LocalAgentContainers
    Write-Ok "Local Nora compose state cleaned"
}

function Start-NoraComposeStack {
    Write-Host ""
    Write-Info "Starting Nora (docker compose up -d --build)..."
    Write-Info "Preserving Docker volumes and provisioned agent instances."
    Write-Host ""
    docker compose up -d --build
    Write-Host ""
    Write-Ok "Nora is running!"
}

# ── Helper: generate random hex ─────────────────────────────

function New-HexSecret {
    param([Alias("Bytes")][int]$ByteCount = 32)
    $secretBytes = [byte[]]::new($ByteCount)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($secretBytes)
    } finally {
        $rng.Dispose()
    }
    return ($secretBytes | ForEach-Object { $_.ToString("x2") }) -join ''
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

function Read-EnvValue {
    param([string]$EnvPath, [string]$Name, [string]$Default = "")

    if (-not (Test-Path -LiteralPath $EnvPath)) {
        return $Default
    }

    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=(.*)$'
    foreach ($line in Get-Content -LiteralPath $EnvPath) {
        if ($line -match $pattern) {
            $value = $matches[1].Trim()
            if ($value.Length -ge 2) {
                $first = $value.Substring(0, 1)
                $last = $value.Substring($value.Length - 1, 1)
                if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
            }
            return $value
        }
    }

    return $Default
}

function ConvertTo-PortNumber {
    param([string]$Value, [int]$Default, [string]$Name)

    if (-not $Value) {
        return $Default
    }

    $port = 0
    if ([int]::TryParse($Value.Trim(), [ref]$port) -and $port -ge 1 -and $port -le 65535) {
        return $port
    }

    Write-Warn "Invalid $Name value '$Value' — using default $Default."
    return $Default
}

function Test-HostPortAvailable {
    param([int]$Port, [string]$BindAddress = "0.0.0.0")

    $listener = $null
    try {
        $ipAddress = if ($BindAddress -eq "0.0.0.0" -or $BindAddress -eq "*") {
            [System.Net.IPAddress]::Any
        } else {
            [System.Net.IPAddress]::Parse($BindAddress)
        }

        $listener = [System.Net.Sockets.TcpListener]::new($ipAddress, $Port)
        $listener.Start()
        return $true
    } catch [System.Net.Sockets.SocketException] {
        return $false
    } catch {
        return $false
    } finally {
        if ($listener) {
            $listener.Stop()
        }
    }
}

function Test-ComposeServiceOwnsPort {
    param([string]$ServiceName, [int]$ContainerPort, [int]$HostPort)

    try {
        $publishedPorts = docker compose port $ServiceName $ContainerPort 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $publishedPorts) {
            return $false
        }

        foreach ($publishedPort in @($publishedPorts)) {
            if ($publishedPort -match ':(\d+)$' -and [int]$matches[1] -eq $HostPort) {
                return $true
            }
        }
    } catch {
        return $false
    }

    return $false
}

function Get-PortOwnerSummary {
    param([int]$Port)

    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        return "another process"
    }

    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 3)
    if ($listeners.Count -eq 0) {
        return "another process"
    }

    $owners = @()
    foreach ($listener in $listeners) {
        $processName = "PID $($listener.OwningProcess)"
        try {
            $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
            $processName = "$($process.ProcessName) (PID $($listener.OwningProcess))"
        } catch {}
        $owners += "$($listener.LocalAddress):$($listener.LocalPort) by $processName"
    }

    return ($owners -join "; ")
}

function Find-NextAvailablePort {
    param([int]$StartPort, [string]$BindAddress = "0.0.0.0")

    if ($StartPort -gt 65535) {
        return 0
    }

    for ($candidate = $StartPort; $candidate -le 65535; $candidate += 1) {
        if (Test-HostPortAvailable -Port $candidate -BindAddress $BindAddress) {
            return $candidate
        }
    }

    return 0
}

function Resolve-AvailableHostPort {
    param(
        [int]$PreferredPort,
        [string]$Purpose,
        [string]$ServiceName,
        [int]$ContainerPort,
        [string]$BindAddress = "0.0.0.0"
    )

    $port = $PreferredPort
    while ($true) {
        if ((Test-ComposeServiceOwnsPort -ServiceName $ServiceName -ContainerPort $ContainerPort -HostPort $port) -or
            (Test-HostPortAvailable -Port $port -BindAddress $BindAddress)) {
            return $port
        }

        Write-Warn "$Purpose port $port is already in use by $(Get-PortOwnerSummary -Port $port)."
        $suggestedPort = Find-NextAvailablePort -StartPort ($port + 1) -BindAddress $BindAddress
        if (-not $suggestedPort) {
            Write-Err "No available TCP port found after $port."
            exit 1
        }
        $portAnswer = Read-Host "  Enter another host port [$suggestedPort]"
        if (-not $portAnswer) {
            $port = $suggestedPort
            continue
        }

        $selectedPort = 0
        if ([int]::TryParse($portAnswer.Trim(), [ref]$selectedPort) -and $selectedPort -ge 1 -and $selectedPort -le 65535) {
            $port = $selectedPort
        } else {
            Write-Warn "Enter a TCP port between 1 and 65535."
        }
    }
}

function New-PortCheck {
    param(
        [string]$Name,
        [string]$ServiceName,
        [int]$ContainerPort,
        [int]$HostPort,
        [string]$BindAddress,
        [string]$EnvVar
    )

    [pscustomobject]@{
        Name = $Name
        ServiceName = $ServiceName
        ContainerPort = $ContainerPort
        HostPort = $HostPort
        BindAddress = $BindAddress
        EnvVar = $EnvVar
    }
}

function Get-NoraHostPortChecks {
    param(
        [string]$EnvPath = $ENV_FILE,
        [int]$NginxHttpPort = 0
    )

    if ($NginxHttpPort -le 0) {
        $NginxHttpPort = ConvertTo-PortNumber -Value (Read-EnvValue -EnvPath $EnvPath -Name "NGINX_HTTP_PORT" -Default "8080") -Default 8080 -Name "NGINX_HTTP_PORT"
    }
    $backendApiPort = ConvertTo-PortNumber -Value (Read-EnvValue -EnvPath $EnvPath -Name "BACKEND_API_PORT" -Default "4100") -Default 4100 -Name "BACKEND_API_PORT"

    $checks = @()
    $checks += New-PortCheck -Name "web gateway" -ServiceName "nginx" -ContainerPort 80 -HostPort $NginxHttpPort -BindAddress "0.0.0.0" -EnvVar "NGINX_HTTP_PORT"
    $checks += New-PortCheck -Name "backend API" -ServiceName "backend-api" -ContainerPort 4000 -HostPort $backendApiPort -BindAddress "127.0.0.1" -EnvVar "BACKEND_API_PORT"
    $checks += New-PortCheck -Name "Postgres" -ServiceName "postgres" -ContainerPort 5432 -HostPort 5433 -BindAddress "127.0.0.1" -EnvVar ""

    if ((Test-Path -LiteralPath $COMPOSE_OVERRIDE_FILE) -and
        (Select-String -LiteralPath $COMPOSE_OVERRIDE_FILE -Pattern '(^|\s|")443:443($|\s|")' -Quiet)) {
        $checks += New-PortCheck -Name "HTTPS gateway" -ServiceName "nginx" -ContainerPort 443 -HostPort 443 -BindAddress "0.0.0.0" -EnvVar ""
    }

    return $checks
}

function Assert-NoraHostPortsAvailable {
    param([array]$Checks)

    $blocked = @()
    foreach ($check in $Checks) {
        if ($check.HostPort -lt 1 -or $check.HostPort -gt 65535) {
            $blocked += [pscustomobject]@{ Check = $check; Owner = "invalid port" }
            continue
        }

        if (Test-ComposeServiceOwnsPort -ServiceName $check.ServiceName -ContainerPort $check.ContainerPort -HostPort $check.HostPort) {
            continue
        }

        if (-not (Test-HostPortAvailable -Port $check.HostPort -BindAddress $check.BindAddress)) {
            $blocked += [pscustomobject]@{ Check = $check; Owner = (Get-PortOwnerSummary -Port $check.HostPort) }
        }
    }

    if ($blocked.Count -eq 0) {
        Write-Ok "Required host ports are available"
        return
    }

    Write-Err "One or more required host ports are already in use."
    foreach ($item in $blocked) {
        $check = $item.Check
        $hint = if ($check.EnvVar) { " Set $($check.EnvVar) in $ENV_FILE to use a different port." } else { "" }
        Write-Host ("  {0}: {1}:{2} is blocked by {3}.{4}" -f $check.Name, $check.BindAddress, $check.HostPort, $item.Owner, $hint)
    }
    Write-Host "  Stop the conflicting service or change the Nora host port, then re-run setup."
    exit 1
}

# ── Pre-flight checks & auto-install ──────────────────────

$REPO_URL = "https://github.com/solomon2773/nora.git"
$INSTALL_DIR = "nora"

Write-Header "Pre-flight Checks"

Write-Ok "PowerShell found: $($PSVersionTable.PSVersion)"

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

# ── Select setup mode ───────────────────────────────────────

if (-not $SETUP_MODE) {
    if (Test-Path $ENV_FILE) {
        Write-Header "Existing Nora Install"
        Write-Host "  Select maintenance mode:"
        Write-Host "    1) Update code only (default) — preserve .env, data volumes, and provisioned instances"
        Write-Host "    2) Reconfigure install — overwrite .env but preserve data volumes and instances"
        Write-Host "    3) Clean reinstall — delete local compose volumes and local Nora agent containers"
        $setupModeAnswer = Read-Host "  Select [1/2/3]"
        switch ($setupModeAnswer) {
            "2" { $SETUP_MODE = "install" }
            "3" { $SETUP_MODE = "clean-reinstall" }
            default { $SETUP_MODE = "update" }
        }
    } else {
        $SETUP_MODE = "install"
    }
}

if ($SETUP_MODE -eq "update") {
    if (-not (Test-Path $ENV_FILE)) {
        Write-Err "Update mode requires an existing $ENV_FILE. Run setup without -Update for first install."
        exit 1
    }

    Write-Header "Updating Nora"
    Write-Info "Code update mode keeps $ENV_FILE, Postgres/backup volumes, and provisioned instances."
    # A leftover public-mode docker-compose.override.yml is auto-loaded by docker
    # compose and would pin a LOCAL stack to prod/TLS wiring (443 + cert mounts).
    # If .env selects the local nginx.conf, retire the stale override.
    if (((Read-EnvValue -EnvPath $ENV_FILE -Name "NGINX_CONFIG_FILE" -Default "nginx.conf") -eq "nginx.conf") -and (Test-Path $COMPOSE_OVERRIDE_FILE)) {
        $overrideStamp = ((Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss") + "Z")
        Move-Item $COMPOSE_OVERRIDE_FILE "$COMPOSE_OVERRIDE_FILE.disabled-$overrideStamp"
        Write-Warn "Disabled a stale $COMPOSE_OVERRIDE_FILE (it did not match local mode in $ENV_FILE)."
    }
    Update-SourceCheckout
    Refresh-ReleaseTags
    Ensure-AgentHubHashSecretEnv -EnvPath $ENV_FILE
    Ensure-BackupEncryptionKeyEnv -EnvPath $ENV_FILE
    Update-ReleaseTrackingEnv -EnvPath $ENV_FILE
    Assert-NoraHostPortsAvailable -Checks (Get-NoraHostPortChecks -EnvPath $ENV_FILE)
    Start-NoraComposeStack
    Write-Host ""
    Write-Info "Update complete. No compose volumes or agent Docker/K8s/VM instances were removed."
    exit 0
}

if ($SETUP_MODE -eq "clean-reinstall") {
    Write-Header "Clean Reinstall"
    if (Test-Path $ENV_FILE) {
        $ENV_BACKUP_FILE = Backup-ExistingEnvFile -EnvPath $ENV_FILE
        Write-Ok "Existing $ENV_FILE backed up to $ENV_BACKUP_FILE"
    }
    Invoke-CleanReinstallState
} elseif (Test-Path $ENV_FILE) {
    Write-Host ""
    Write-Warn ".env already exists."
    $answer = Read-Host "  Overwrite configuration while preserving data volumes and instances? [y/N]"
    if ($answer -notmatch '^[Yy]$') {
        Write-Info "Keeping existing .env — no changes made."
        Write-Info "Use '.\setup.ps1 -Update' for a non-destructive code update."
        exit 0
    }
    $ENV_BACKUP_FILE = Backup-ExistingEnvFile -EnvPath $ENV_FILE
    Write-Ok "Existing $ENV_FILE backed up to $ENV_BACKUP_FILE"
}

# ── Generate secrets ─────────────────────────────────────────

Write-Header "Generating Secrets"

# Preserve existing secrets on reconfigure so live sessions, AES-encrypted
# provider keys, managed backups, Agent Hub keys, and the initialized Postgres
# volume remain usable. Only a first install with no value generates new ones.
$JWT_SECRET = Read-EnvValue -EnvPath $ENV_FILE -Name "JWT_SECRET" -Default ""
if ($JWT_SECRET -notmatch '^[0-9a-fA-F]{64}$') { $JWT_SECRET = New-HexSecret }
$ENCRYPTION_KEY = Read-EnvValue -EnvPath $ENV_FILE -Name "ENCRYPTION_KEY" -Default ""
if ($ENCRYPTION_KEY -notmatch '^[0-9a-fA-F]{64}$') { $ENCRYPTION_KEY = New-HexSecret }
$NORA_BACKUP_ENCRYPTION_KEY = Read-EnvValue -EnvPath $ENV_FILE -Name "NORA_BACKUP_ENCRYPTION_KEY" -Default ""
if ($NORA_BACKUP_ENCRYPTION_KEY -notmatch '^[0-9a-fA-F]{64}$') { $NORA_BACKUP_ENCRYPTION_KEY = New-HexSecret }
$NORA_AGENT_HUB_API_KEY_HASH_SECRET = Read-EnvValue -EnvPath $ENV_FILE -Name "NORA_AGENT_HUB_API_KEY_HASH_SECRET" -Default ""
if ($NORA_AGENT_HUB_API_KEY_HASH_SECRET -notmatch '^[0-9a-fA-F]{64}$') { $NORA_AGENT_HUB_API_KEY_HASH_SECRET = New-HexSecret }
$DB_USER         = "nora"
$DB_NAME         = "nora"
$DB_PASSWORD     = Read-EnvValue -EnvPath $ENV_FILE -Name "DB_PASSWORD" -Default ""
if (-not $DB_PASSWORD) { $DB_PASSWORD = New-HexSecret -Bytes 24 }

Write-Ok "JWT_SECRET            (64-char hex)"
Write-Ok "ENCRYPTION_KEY        (64-char hex — AES-256-GCM)"
Write-Ok "BACKUP_ENCRYPTION_KEY (64-char hex — managed backup archives)"
Write-Ok "AGENT_HUB_HASH        (64-char hex)"
Write-Ok "DB_PASSWORD           (48-char hex)"

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
$HERMES_RUNTIME_ENABLED = $false
$NEMOCLAW_SANDBOX_ENABLED = $false
$PROXMOX_API_URL = ""
$PROXMOX_TOKEN_ID = ""
$PROXMOX_TOKEN_SECRET = ""
$PROXMOX_NODE = "pve"
$PROXMOX_TEMPLATE = "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
$PROXMOX_HERMES_TEMPLATE = ""
$PROXMOX_NEMOCLAW_TEMPLATE = ""
$PROXMOX_ROOTFS_STORAGE = "local-lvm"
$PROXMOX_BRIDGE = "vmbr0"
$PROXMOX_SSH_HOST = ""
$PROXMOX_SSH_USER = "root"
$PROXMOX_SSH_PRIVATE_KEY_PATH = ""
$PROXMOX_SSH_PASSWORD = ""
$NVIDIA_API_KEY = ""

$dockerBackendAnswer = Read-Host "  Enable Docker backend for local socket provisioning? [Y/n]"
if ($dockerBackendAnswer -match '^[Nn]$') {
    $DOCKER_BACKEND_ENABLED = $false
    Write-Info "Docker backend disabled"
} else {
    Write-Ok "Docker backend enabled"
}

Write-Info "Kubernetes clusters are registered after setup in Admin -> Kubernetes."
Write-Info "Proxmox is planned but release-blocked in this Nora release; setup will not enable it."

$hermesRuntimeAnswer = Read-Host "  Enable Hermes runtime family? [y/N]"
if ($hermesRuntimeAnswer -match '^[Yy]$') {
    $HERMES_RUNTIME_ENABLED = $true
    Write-Ok "Hermes runtime family enabled"
} else {
    Write-Info "Hermes runtime family disabled"
}

$nemoclawSandboxAnswer = Read-Host "  Enable NemoClaw sandbox profile? [y/N]"
if ($nemoclawSandboxAnswer -match '^[Yy]$') {
    $NEMOCLAW_SANDBOX_ENABLED = $true
    $nvidiaKey = Read-Host "  NVIDIA API key [optional during setup]"
    if ($nvidiaKey) {
        $NVIDIA_API_KEY = $nvidiaKey
        Write-Ok "NemoClaw sandbox profile enabled with NVIDIA API key"
    } else {
        Write-Warn "NemoClaw enabled without NVIDIA_API_KEY — add it to .env later if needed"
    }
} else {
    Write-Info "NemoClaw sandbox profile disabled"
}

$enabledBackends = @()
if ($DOCKER_BACKEND_ENABLED) { $enabledBackends += "docker" }

if ($enabledBackends.Count -eq 0) {
    Write-Warn "No deploy backends selected — enabling Docker so Nora can deploy agents."
    $DOCKER_BACKEND_ENABLED = $true
    $enabledBackends = @("docker")
}

$ENABLED_BACKENDS = $enabledBackends -join ","
Write-Ok "Enabled backends: $ENABLED_BACKENDS"

$enabledRuntimeFamilies = @("openclaw")
if ($HERMES_RUNTIME_ENABLED) { $enabledRuntimeFamilies += "hermes" }
$ENABLED_RUNTIME_FAMILIES = $enabledRuntimeFamilies -join ","
Write-Ok "Enabled runtime families: $ENABLED_RUNTIME_FAMILIES"

$enabledSandboxProfiles = @("standard")
if ($NEMOCLAW_SANDBOX_ENABLED) { $enabledSandboxProfiles += "nemoclaw" }
$ENABLED_SANDBOX_PROFILES = $enabledSandboxProfiles -join ","
Write-Ok "Enabled sandbox profiles: $ENABLED_SANDBOX_PROFILES"

# ── Access mode ──────────────────────────────────────────────

Write-Header "Access Mode"

Write-Host "  How should users reach Nora?"
Write-Host "    1) Local only (default) — http://localhost:8080 (auto-picks the next free port if 8080 is busy)"
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
$BACKEND_API_PORT = "4100"
$NORA_FORCE_SECURE_COOKIES = ""
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
        if ($PUBLIC_SCHEME -eq "https") { $NORA_FORCE_SECURE_COOKIES = "1" }
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
        $NORA_FORCE_SECURE_COOKIES = "1"
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
        $NGINX_HTTP_PORT = Resolve-AvailableHostPort -PreferredPort 8080 -Purpose "Local web gateway" -ServiceName "nginx" -ContainerPort 80
        $NEXTAUTH_URL = "http://localhost:$NGINX_HTTP_PORT"
        $CORS_ORIGINS = $NEXTAUTH_URL
        Write-Ok "Local mode — Nora will be available at $NEXTAUTH_URL"
        if ("$NGINX_HTTP_PORT" -ne "8080") {
            Write-Warn "Port 8080 was busy — Nora will run at $NEXTAUTH_URL."
            Write-Warn "Open THAT URL (not http://localhost:8080) to sign in."
        }
    }
}

$BACKEND_API_PORT = Resolve-AvailableHostPort -PreferredPort 4100 -Purpose "backend API" -ServiceName "backend-api" -ContainerPort 4000 -BindAddress "127.0.0.1"
if ("$BACKEND_API_PORT" -ne "4100") {
    Write-Warn "Port 4100 was busy — Nora backend API will run at 127.0.0.1:$BACKEND_API_PORT."
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
$NORA_CURRENT_VERSION = Resolve-CurrentReleaseVersion
$NORA_CURRENT_COMMIT = Resolve-CurrentReleaseCommit
if ($NORA_CURRENT_COMMIT) {
    $label = if ($NORA_CURRENT_VERSION) { $NORA_CURRENT_VERSION } else { "source checkout" }
    Write-Ok "Release tracking: $label @ $($NORA_CURRENT_COMMIT.Substring(0, [Math]::Min(12, $NORA_CURRENT_COMMIT.Length)))"
} else {
    Write-Warn "Release tracking commit could not be resolved; Admin Settings will show tracking incomplete."
}

$envContent = @"
# ============================================================
# Nora — Environment Configuration
# ============================================================
# Auto-generated by setup.ps1 on $timestamp
# ============================================================

# ── Required (auto-generated) ────────────────────────────────
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
NORA_BACKUP_ENCRYPTION_KEY=$NORA_BACKUP_ENCRYPTION_KEY
NORA_AGENT_HUB_API_KEY_HASH_SECRET=$NORA_AGENT_HUB_API_KEY_HASH_SECRET

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
BACKEND_API_PORT=$BACKEND_API_PORT

# ── Access / URL ─────────────────────────────────────────────
NGINX_CONFIG_FILE=$NGINX_CONFIG_FILE
NGINX_HTTP_PORT=$NGINX_HTTP_PORT
# Forces the Secure flag on the session cookie for always-on-TLS public deploys
# (set to 1 for https public modes; empty for local http). Guards against an
# upstream proxy that strips X-Forwarded-Proto.
NORA_FORCE_SECURE_COOKIES=$NORA_FORCE_SECURE_COOKIES

# ── OAuth ────────────────────────────────────────────────────
OAUTH_LOGIN_ENABLED=$OAUTH_LOGIN_ENABLED
NEXT_PUBLIC_OAUTH_LOGIN_ENABLED=$NEXT_PUBLIC_OAUTH_LOGIN_ENABLED
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
NEXTAUTH_URL=$NEXTAUTH_URL

# ── Platform Mode ────────────────────────────────────────────
PLATFORM_MODE=$PLATFORM_MODE

# ── Self-hosted limits (only when PLATFORM_MODE=selfhosted) ──
MAX_VCPU=$MAX_VCPU
MAX_RAM_MB=$MAX_RAM_MB
MAX_DISK_GB=$MAX_DISK_GB
MAX_AGENTS=$MAX_AGENTS

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
NORA_CURRENT_VERSION=$NORA_CURRENT_VERSION
NORA_CURRENT_COMMIT=$NORA_CURRENT_COMMIT
NORA_GITHUB_REPO=$NORA_GITHUB_REPO_SLUG
NORA_RELEASE_CACHE_TTL_MS=300000
NORA_LATEST_VERSION=
NORA_LATEST_PUBLISHED_AT=
NORA_RELEASE_NOTES_URL=
NORA_LATEST_SEVERITY=warning
NORA_UPGRADE_REQUIRED=false
NORA_AUTO_UPGRADE_ENABLED=false
NORA_HOST_REPO_DIR=$(Get-Location)
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
ENABLED_RUNTIME_FAMILIES=$ENABLED_RUNTIME_FAMILIES
ENABLED_BACKENDS=$ENABLED_BACKENDS
ENABLED_SANDBOX_PROFILES=$ENABLED_SANDBOX_PROFILES

# ── Proxmox (planned; release-blocked in current Nora releases) ─────────
# These values are retained for adapter development and future validation.
# Setting them does not make Proxmox a supported deploy target yet.
PROXMOX_API_URL=$PROXMOX_API_URL
PROXMOX_TOKEN_ID=$PROXMOX_TOKEN_ID
PROXMOX_TOKEN_SECRET=$PROXMOX_TOKEN_SECRET
PROXMOX_NODE=$PROXMOX_NODE
PROXMOX_TEMPLATE=$PROXMOX_TEMPLATE
PROXMOX_HERMES_TEMPLATE=$PROXMOX_HERMES_TEMPLATE
PROXMOX_NEMOCLAW_TEMPLATE=$PROXMOX_NEMOCLAW_TEMPLATE
PROXMOX_ROOTFS_STORAGE=$PROXMOX_ROOTFS_STORAGE
PROXMOX_BRIDGE=$PROXMOX_BRIDGE
PROXMOX_SSH_HOST=$PROXMOX_SSH_HOST
PROXMOX_SSH_USER=$PROXMOX_SSH_USER
PROXMOX_SSH_PRIVATE_KEY_PATH=$PROXMOX_SSH_PRIVATE_KEY_PATH
PROXMOX_SSH_PASSWORD=$PROXMOX_SSH_PASSWORD

# ── NemoClaw / NVIDIA (when ENABLED_SANDBOX_PROFILES includes nemoclaw) ──
NVIDIA_API_KEY=$NVIDIA_API_KEY
NEMOCLAW_DEFAULT_MODEL=nvidia/nemotron-3-super-120b-a12b
# Defaults to the Nora-published GHCR image. For offline hosts or private
# clusters, build/preload nora-nemoclaw-agent:local and override this value.
NEMOCLAW_SANDBOX_IMAGE=ghcr.io/solomon2773/nora-nemoclaw-agent:latest

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
Write-Host "  Secrets:      auto-generated (JWT, AES, backups, Agent Hub)"
Write-Host "  Database:     PostgreSQL 15 (Docker Compose)"
Write-Host "  DB Access:    $DB_USER / auto-generated / $DB_NAME (.env)"
Write-Host "  Redis:        Redis 7 (Docker Compose)"
if ($ACCESS_MODE -eq "local") {
    Write-Host "  Access:       $NEXTAUTH_URL"
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

Write-Host "  Families:     $ENABLED_RUNTIME_FAMILIES"
Write-Host "  Backends:     $ENABLED_BACKENDS"
Write-Host "  Sandboxes:    $ENABLED_SANDBOX_PROFILES"

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

Write-Host ""
Assert-NoraHostPortsAvailable -Checks (Get-NoraHostPortChecks -EnvPath $ENV_FILE -NginxHttpPort ([int]$NGINX_HTTP_PORT))
Write-Info "Building nora-openclaw-agent:local (prebaked openclaw + tsx)..."
Write-Host ""
docker build -f agent-runtime/Dockerfile.openclaw-agent -t nora-openclaw-agent:local agent-runtime/
if ($LASTEXITCODE -ne 0) { Write-Err "Failed to build nora-openclaw-agent:local"; exit 1 }
Write-Ok "OpenClaw agent image ready"

# Only build the NemoClaw fallback image when the operator enables the sandbox
# and explicitly points NEMOCLAW_SANDBOX_IMAGE at the local tag.
if (($ENABLED_SANDBOX_PROFILES -split ',') -contains 'nemoclaw') {
    $nemoclawImageLine = Select-String -Path $ENV_FILE -Pattern '^NEMOCLAW_SANDBOX_IMAGE=nora-nemoclaw-agent:local$' -Quiet
    if ($nemoclawImageLine) {
        Write-Host ""
        Write-Info "Building nora-nemoclaw-agent:local (OpenShell sandbox + tsx)..."
        Write-Host ""
        docker build -f agent-runtime/Dockerfile.nemoclaw-agent -t nora-nemoclaw-agent:local agent-runtime/
        if ($LASTEXITCODE -ne 0) { Write-Err "Failed to build nora-nemoclaw-agent:local"; exit 1 }
        Write-Ok "NemoClaw sandbox image ready"
    } else {
        Write-Info "Using GHCR NemoClaw sandbox image from NEMOCLAW_SANDBOX_IMAGE"
    }
}
Start-NoraComposeStack

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
