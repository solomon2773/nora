# Behaviour tests for the logging parts of setup.ps1: the interactive questions
# (Read-LogCollectionSettings) and the env-file filler used on upgrades
# (Ensure-LogEnv).
#
# These load the REAL functions out of setup.ps1 with the PowerShell parser and
# replace only Read-Host with scripted answers, so they run the same on Windows,
# Linux and macOS without a terminal, Docker, or a full setup run. Run through
# scripts/setup-ps1.test.mjs (which skips when pwsh is not installed), or directly:
#
#   pwsh -NoProfile -File scripts/setup-ps1-log-settings.test.ps1
#
# Why this exists: setup.ps1 could only be syntax-checked, and a condition that
# should have made upgrades default to "No" silently never applied. Parsing
# cannot catch that; running the code can.

$ErrorActionPreference = "Stop"
$setupPath = Join-Path (Split-Path -Parent $PSScriptRoot) "setup.ps1"

# ── load the real functions ──────────────────────────────────────────────
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($setupPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "setup.ps1 does not parse: $($errors[0].Message)" }

$wanted = @(
    "Write-Info", "Write-Ok", "Write-Warn", "Write-Err", "Write-Header",
    "Protect-EnvFile", "Set-EnvValue", "Read-EnvValue", "ConvertFrom-ComposeEnvLiteral",
    "New-HexSecret", "Get-RecommendedLogMaxBytes", "Ensure-LogEnv", "Read-LogCollectionSettings"
)
$found = @{}
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($wanted -contains $fn.Name) { $found[$fn.Name] = $fn }
}
foreach ($name in $wanted) {
    if (-not $found.ContainsKey($name)) { throw "setup.ps1 no longer defines $name (update this test if it was renamed)" }
}
foreach ($name in $wanted) { . ([scriptblock]::Create($found[$name].Extent.Text)) }

# Anything the extracted functions print must not pollute the test output.
function Write-Host { }

# ── scripted Read-Host ───────────────────────────────────────────────────
$script:Answers = [System.Collections.Generic.Queue[string]]::new()
$script:Prompts = [System.Collections.Generic.List[string]]::new()
function Read-Host {
    param([string]$Prompt)
    $script:Prompts.Add($Prompt)
    # An unscripted extra question is itself a finding (the caller asked more than
    # expected), so answer Enter and let the checks on the prompt count fail
    # clearly instead of crashing the whole run.
    if ($script:Answers.Count -eq 0) { return "" }
    return $script:Answers.Dequeue()
}

# ── tiny test harness ────────────────────────────────────────────────────
$script:Pass = 0; $script:Fail = 0
function Check([string]$Name, [bool]$Condition, [string]$Detail = "") {
    if ($Condition) { $script:Pass++; Write-Output "PASS  $Name" }
    else { $script:Fail++; Write-Output "FAIL  $Name $Detail" }
}
$GiB = [int64]1073741824
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("nora-ps1-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null

function New-Env([string[]]$Lines = @(), [switch]$Crlf) {
    $path = Join-Path $tmp ([guid]::NewGuid().ToString("N") + ".env")
    $base = @("JWT_SECRET=abc", "NGINX_HTTP_PORT=8080") + $Lines
    $nl = if ($Crlf) { "`r`n" } else { "`n" }
    [System.IO.File]::WriteAllText($path, (($base -join $nl) + $nl), [System.Text.UTF8Encoding]::new($false))
    return $path
}
function Value([string]$Path, [string]$Name) {
    $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
    if ($null -eq $line) { return $null }
    return $line.Substring($Name.Length + 1)
}
function Run-Prompts([string]$EnvPath, [string[]]$Answers, [string]$DefaultAnswer = "yes") {
    $script:ENV_FILE = $EnvPath
    $script:Answers.Clear(); $script:Prompts.Clear()
    foreach ($a in $Answers) { $script:Answers.Enqueue($a) }
    Read-LogCollectionSettings -DefaultAnswer $DefaultAnswer
}
function Prompt-Text([int]$Index) { if ($script:Prompts.Count -gt $Index) { return $script:Prompts[$Index] } else { return "" } }

try {
    # ── the questions: fresh install (default answer yes) ───────────────
    $e = New-Env
    Run-Prompts $e @("", "", "")
    Check "install: Enter, Enter, Enter accepts the recommendation (on, 30 days)" (($script:NORA_LOG_ENABLED -eq "true") -and ($script:NORA_LOG_RETENTION_CEILING_DAYS -eq "30"))
    Check "install: the first question defaults to Yes ([Y/n])" ((Prompt-Text 0) -cmatch "\[Y/n\]")

    $e = New-Env
    Run-Prompts $e @("n")
    Check "install: 'n' turns it off" ($script:NORA_LOG_ENABLED -eq "false")
    Check "install: declining asks nothing further (no days or disk questions)" ($script:Prompts.Count -eq 1)

    $e = New-Env
    Run-Prompts $e @("y", "14", "3")
    Check "install: custom answers apply (14 days)" ($script:NORA_LOG_RETENTION_CEILING_DAYS -eq "14")
    Check "install: custom answers apply (3 GB cap)" ($script:NORA_LOG_LOCAL_MAX_BYTES -eq [string](3 * $GiB))

    $e = New-Env
    Run-Prompts $e @("y", "abc", "0", "99999", "14", "abc", "0", "-5", "3")
    Check "install: invalid days are re-asked until valid" ($script:NORA_LOG_RETENTION_CEILING_DAYS -eq "14")
    Check "install: invalid disk sizes are re-asked until valid" ($script:NORA_LOG_LOCAL_MAX_BYTES -eq [string](3 * $GiB))
    Check "install: every bad answer produced exactly one more question (1 + 4 days + 4 disk)" ($script:Prompts.Count -eq 9)

    # ── the questions: upgrade (default answer no) ──────────────────────
    $e = New-Env
    Run-Prompts $e @("") "no"
    Check "UPGRADE: pressing Enter means NO (collection stays off)" ($script:NORA_LOG_ENABLED -eq "false")
    Check "UPGRADE: the question defaults to No ([y/N])" ((Prompt-Text 0) -cmatch "\[y/N\]")
    Check "UPGRADE: Enter asks nothing further" ($script:Prompts.Count -eq 1)

    $e = New-Env
    Run-Prompts $e @("y", "30", "2") "no"
    Check "upgrade: an explicit 'y' still turns it on" ($script:NORA_LOG_ENABLED -eq "true")
    Check "upgrade: and the answers after it apply (2 GB cap)" ($script:NORA_LOG_LOCAL_MAX_BYTES -eq [string](2 * $GiB))

    $e = New-Env @("NORA_LOG_ENABLED=false")
    Run-Prompts $e @("")
    Check "reconfigure after an earlier 'off' defaults to No as well" (((Prompt-Text 0) -cmatch "\[y/N\]") -and ($script:NORA_LOG_ENABLED -eq "false"))

    # ── Ensure-LogEnv: what an upgrade writes without asking ────────────
    $e = New-Env
    Ensure-LogEnv -EnvPath $e
    Check "ensure: generates a 64-hex encryption key" ((Value $e "NORA_LOG_ENCRYPTION_KEY") -match "^[0-9a-f]{64}$")
    Check "ensure: generates a 64-hex OTLP secret" ((Value $e "NORA_OTLP_INGEST_SECRET") -match "^[0-9a-f]{64}$")
    Check "ensure: sets the 30-day ceiling" ((Value $e "NORA_LOG_RETENTION_CEILING_DAYS") -eq "30")
    $cap = [int64](Value $e "NORA_LOG_LOCAL_MAX_BYTES")
    Check "ensure: presets a disk cap between 1 GiB and 10 GiB" (($cap -ge $GiB) -and ($cap -le 10 * $GiB)) "(cap=$cap)"
    Check "ensure: NEVER writes NORA_LOG_ENABLED (an upgrade must not turn collection on)" ($null -eq (Value $e "NORA_LOG_ENABLED"))
    Check "ensure: leaves other settings alone" (((Value $e "JWT_SECRET") -eq "abc") -and ((Value $e "NGINX_HTTP_PORT") -eq "8080"))

    $before = Get-Content -LiteralPath $e -Raw
    Ensure-LogEnv -EnvPath $e
    Check "ensure: a second run changes nothing" ((Get-Content -LiteralPath $e -Raw) -eq $before)

    $ring = "k2:$('a' * 64),k1:$('b' * 64)"
    $e = New-Env @("NORA_LOG_ENCRYPTION_KEY=$ring")
    Ensure-LogEnv -EnvPath $e
    Check "ensure: never replaces an existing key or key ring" ((Value $e "NORA_LOG_ENCRYPTION_KEY") -eq $ring)

    $e = New-Env @("NORA_LOG_LOCAL_MAX_BYTES=123456789")
    Ensure-LogEnv -EnvPath $e
    Check "ensure: keeps an existing disk cap" ((Value $e "NORA_LOG_LOCAL_MAX_BYTES") -eq "123456789")

    $e = New-Env @("NORA_LOG_ENCRYPTION_KEY=", "NORA_OTLP_INGEST_SECRET=")
    Ensure-LogEnv -EnvPath $e
    $keyLines = @(Get-Content -LiteralPath $e | Where-Object { $_ -match "^NORA_LOG_ENCRYPTION_KEY=" }).Count
    Check "ensure: fills empty template lines in place, without duplicating keys" (($keyLines -eq 1) -and ((Value $e "NORA_LOG_ENCRYPTION_KEY") -match "^[0-9a-f]{64}$"))

    foreach ($choice in @("true", "false")) {
        $e = New-Env @("NORA_LOG_ENABLED=$choice")
        Ensure-LogEnv -EnvPath $e
        Check "ensure: respects an explicit NORA_LOG_ENABLED=$choice" ((Value $e "NORA_LOG_ENABLED") -eq $choice)
    }

    # ── Windows-style files: CRLF line endings ──────────────────────────
    $e = New-Env -Crlf
    Ensure-LogEnv -EnvPath $e
    Check "CRLF env file: keys are generated and read back cleanly (no stray carriage return)" (((Value $e "NORA_LOG_ENCRYPTION_KEY") -match "^[0-9a-f]{64}$") -and ((Value $e "NORA_LOG_RETENTION_CEILING_DAYS") -eq "30"))

    $e = New-Env @("NORA_LOG_ENABLED=true", "NORA_LOG_RETENTION_CEILING_DAYS=14") -Crlf
    $script:ENV_FILE = $e
    $script:Answers.Clear(); $script:Prompts.Clear(); $script:Answers.Enqueue("y"); $script:Answers.Enqueue(""); $script:Answers.Enqueue("")
    Read-LogCollectionSettings -DefaultAnswer "yes"
    Check "CRLF env file: an existing 14-day setting is read as the default" (($script:NORA_LOG_RETENTION_CEILING_DAYS -eq "14") -and ((Prompt-Text 1) -match "\[14\]"))
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "---- $($script:Pass) passed, $($script:Fail) failed"
if ($script:Fail -gt 0) { exit 1 }
