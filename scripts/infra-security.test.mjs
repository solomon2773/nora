import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helmSecretArgs = [
  "--set",
  "secrets.jwtSecret=ci-jwt-secret-0000000000000000000000000000",
  "--set",
  "secrets.encryptionKey=ci-encryption-key-0000000000000000000000",
  "--set",
  "secrets.backupEncryptionKey=ci-backup-key-000000000000000000000000",
  "--set",
  "secrets.apiKeyHashSecret=ci-hash-key-00000000000000000000000000",
  "--set",
  "secrets.agentHubApiKeyHashSecret=ci-agent-hub-hash-key-0000000000000000000",
  "--set",
  "secrets.dbPassword=ci-db-password",
];

function withoutHelmSetting(args, settingName) {
  const filtered = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--set" && String(args[index + 1] || "").startsWith(`${settingName}=`)) {
      index += 1;
      continue;
    }
    filtered.push(args[index]);
  }
  return filtered;
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function shellLogicalLines(source) {
  return source.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout || `${command} failed`,
  );
  return result.stdout;
}

function serviceSection(source, serviceName) {
  const match = source.match(
    new RegExp(
      `\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\nvolumes:|\\nsecrets:|$)`,
    ),
  );
  assert.ok(match, `missing service ${serviceName}`);
  return match[1];
}

function nginxRequestMapSection(source, variableName) {
  const match = source.match(
    new RegExp(`map \\$request_uri \\$${variableName} \\{([\\s\\S]*?)\\n    \\}`),
  );
  assert.ok(match, `missing request map ${variableName}`);
  return match[1];
}

function manifestDocument(source, kind, name) {
  const document = source
    .split(/^---\s*$/m)
    .find(
      (candidate) =>
        new RegExp(`^kind: ${kind}$`, "m").test(candidate) &&
        new RegExp(`^  name: ${name}$`, "m").test(candidate),
    );
  assert.ok(document, `missing ${kind} ${name}`);
  return document;
}

function renderFrontendManifests(extraArgs = []) {
  return runChecked("helm", [
    "template",
    "nora-security-test",
    "infra/helm/nora",
    "--show-only",
    "templates/frontends.yaml",
    ...helmSecretArgs,
    ...extraArgs,
  ]);
}

test("marketing Compose services use an explicit environment allowlist", () => {
  for (const file of ["docker-compose.yml", "docker-compose.e2e.yml"]) {
    const service = serviceSection(read(file), "frontend-marketing");
    assert.doesNotMatch(service, /env_file:/);
    for (const forbidden of [
      "JWT_SECRET",
      "ENCRYPTION_KEY",
      "DB_PASSWORD",
      "REDIS_PASSWORD",
      "NORA_BACKUP_ENCRYPTION_KEY",
      "NORA_AGENT_HUB_API_KEY_HASH_SECRET",
      "NORA_API_KEY_HASH_SECRET",
      "NEXT_PUBLIC_OAUTH_LOGIN_ENABLED",
    ]) {
      assert.doesNotMatch(service, new RegExp(`\\b${forbidden}:`), `${file} leaked ${forbidden}`);
    }
  }
  for (const overlay of [
    "infra/docker-compose.public-prod.yml",
    "infra/docker-compose.public-tls.yml",
  ]) {
    assert.match(serviceSection(read(overlay), "frontend-marketing"), /env_file: !override \[\]/);
  }
});

test("public nginx templates enforce marketing security and homepage cache headers", () => {
  const cloudflareNetworks = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ];
  for (const file of ["infra/nginx_public.conf.template", "infra/nginx_tls.conf"]) {
    const source = read(file);
    for (const network of cloudflareNetworks) {
      assert.match(
        source,
        new RegExp(`^\\s*set_real_ip_from ${network.replaceAll(".", "\\.")};$`, "m"),
        `${file} must trust Cloudflare network ${network}`,
      );
    }
    assert.match(source, /^\s*real_ip_header CF-Connecting-IP;$/m);
    assert.match(source, /^\s*real_ip_recursive on;$/m);
    assert.doesNotMatch(source, /^\s*#\s*(set_real_ip_from|real_ip_header|real_ip_recursive)/m);
    assert.match(source, /server_tokens off;/, `${file} must suppress version disclosure`);
    assert.match(
      source,
      /Strict-Transport-Security "max-age=63072000" always;/,
      `${file} must emit HSTS`,
    );
    assert.doesNotMatch(
      source,
      /Strict-Transport-Security[^;]*includeSubDomains/,
      `${file} must not pin unrelated subdomains by default`,
    );
    assert.match(
      source,
      /proxy_hide_header Strict-Transport-Security;/,
      `${file} must hide upstream HSTS`,
    );
    assert.match(
      source,
      /add_header Content-Security-Policy \$marketing_content_security_policy always;/,
      `${file} must emit the marketing CSP`,
    );
    assert.match(source, /frame-ancestors 'none'/, `${file} must prevent marketing framing`);
    assert.match(
      source,
      /~\^\/\(api\|app\|admin\)\(\/\|\$\) "";/,
      `${file} must exclude protected surfaces from the marketing CSP`,
    );
    assert.match(
      source,
      /add_header X-Frame-Options \$surface_x_frame_options always;/,
      `${file} must choose frame policy by surface`,
    );
    assert.match(
      nginxRequestMapSection(source, "surface_x_frame_options"),
      /~\^\/api\(\/\|\\\?\|\$\) "";[\s\S]*?~\^\/\(app\|admin\)\(\/\|\\\?\|\$\) "SAMEORIGIN";/,
      `${file} must preserve backend embed headers and protect dashboards`,
    );
    assert.match(
      source,
      /"\/" "public, max-age=0, s-maxage=300, stale-while-revalidate=60";/,
      `${file} must mark only the homepage for shared caching`,
    );
    assert.match(
      source,
      /location = \/ \{[\s\S]*?proxy_hide_header Cache-Control;[\s\S]*?proxy_hide_header Strict-Transport-Security;/,
    );
  }
});

test("Next.js frontends suppress framework disclosure headers", () => {
  for (const file of [
    "frontend-marketing/next.config.ts",
    "frontend-dashboard/next.config.ts",
    "admin-dashboard/next.config.ts",
  ]) {
    assert.match(read(file), /poweredByHeader:\s*false/, `${file} must hide X-Powered-By`);
  }
});

test("every active nginx edge preserves backend API-owned browser policy", () => {
  for (const file of [
    "nginx.conf",
    "infra/nginx_public.conf.template",
    "infra/nginx_tls.conf",
    "infra/helm/nora/files/nginx-k8s.conf",
  ]) {
    const source = read(file);
    const frameMap = nginxRequestMapSection(source, "surface_x_frame_options");
    assert.match(frameMap, /~\^\/api\(\/\|\\\?\|\$\) "";/);
    assert.match(frameMap, /~\^\/\(app\|admin\)\(\/\|\\\?\|\$\) "SAMEORIGIN";/);
    assert.match(source, /add_header X-Frame-Options \$surface_x_frame_options always;/);
    assert.doesNotMatch(source, /add_header X-Frame-Options DENY always;/);
    for (const [header, variable] of [
      ["X-Content-Type-Options", "surface_x_content_type_options"],
      ["Referrer-Policy", "surface_referrer_policy"],
      ["Cross-Origin-Opener-Policy", "surface_cross_origin_opener_policy"],
    ]) {
      assert.match(
        nginxRequestMapSection(source, variable),
        /~\^\/api\(\/\|\\\?\|\$\) "";/,
        `${file} must preserve backend ${header} on APIs`,
      );
      assert.match(
        source,
        new RegExp(`add_header ${header} \\$${variable} always;`),
        `${file} must apply edge ${header} outside APIs`,
      );
    }
  }
});

test("production Compose mounts core secrets and fails closed on ownership migration", () => {
  const rootCompose = read("docker-compose.yml");
  assert.match(rootCompose, /target: JWT_SECRET/);
  assert.match(rootCompose, /target: NORA_API_KEY_HASH_SECRET/);
  assert.match(rootCompose, /target: DB_PASSWORD/);
  assert.match(rootCompose, /file: \$\{NORA_COMPOSE_SECRETS_DIR:-\.secrets\/compose\}\/JWT_SECRET/);
  assert.doesNotMatch(rootCompose.slice(rootCompose.indexOf("\nsecrets:")), /environment:/);
  assert.match(
    serviceSection(rootCompose, "postgres"),
    /POSTGRES_PASSWORD_FILE: \/run\/secrets\/DB_PASSWORD/,
  );
  const onDemandBackup = serviceSection(rootCompose, "backup");
  assert.match(onDemandBackup, /PGPASSWORD: ""/);
  assert.match(onDemandBackup, /PGPASSWORD_FILE: \/run\/secrets\/DB_PASSWORD/);
  assert.match(onDemandBackup, /source: nora_db_password/);
  const backupScript = read("infra/backup.sh");
  assert.match(backupScript, /PGPASSWORD_FILE/);
  assert.match(backupScript, /PGPASSWORD or a readable PGPASSWORD_FILE is required/);
  for (const overlay of [
    "infra/docker-compose.public-prod.yml",
    "infra/docker-compose.public-tls.yml",
  ]) {
    const source = read(overlay);
    for (const serviceName of ["backend-api", "worker-provisioner", "worker-backup"]) {
      const service = serviceSection(source, serviceName);
      assert.match(service, /JWT_SECRET: ""/);
      assert.match(service, /DB_PASSWORD: ""/);
    }
    const permissionCommand = serviceSection(source, "volume-permissions");
    assert.match(permissionCommand, /set -eu/);
    assert.match(permissionCommand, /Failed to migrate Nora volume ownership/);
    assert.match(permissionCommand, /exit 1/);
  }
});

test("backup worker images include backend adapters for remote agent capture", () => {
  for (const file of ["workers/backup/Dockerfile", "workers/backup/Dockerfile.prod"]) {
    assert.match(
      read(file),
      /COPY workers\/provisioner\/backends \/backend-api\/backends/,
      `${file} must package the backend selected by containerManager`,
    );
  }
});

test("Helm keeps secrets out of frontends and mounts them into control-plane pods", () => {
  const frontends = read("infra/helm/nora/templates/frontends.yaml");
  const helpers = read("infra/helm/nora/templates/_helpers.tpl");
  const backend = read("infra/helm/nora/templates/backend-api.yaml");
  const workers = read("infra/helm/nora/templates/workers.yaml");
  const postgres = read("infra/helm/nora/templates/postgres.yaml");

  assert.doesNotMatch(frontends, /nora\.extraEnv[^\n]+Values\.commonEnv/);
  assert.match(frontends, /Values\.frontendEnv/);
  assert.doesNotMatch(helpers, /secretRef:/);
  assert.match(helpers, /mountPath: \/run\/secrets/);
  assert.match(backend, /mountPath: \/run\/secrets/);
  assert.match(backend, /failureThreshold: 132/);
  assert.match(workers, /mountPath: \/run\/secrets/);
  assert.match(postgres, /POSTGRES_PASSWORD_FILE/);
  assert.match(postgres, /mountPath: \/run\/secrets/);
});

test("Helm separates API hash secrets for new installs and preserves the upgrade fallback", () => {
  const rendered = runChecked("helm", [
    "template",
    "nora-security-test",
    "infra/helm/nora",
    "--show-only",
    "templates/secret-env.yaml",
    ...helmSecretArgs,
  ]);
  assert.match(rendered, /NORA_API_KEY_HASH_SECRET: "ci-hash-key-00000000000000000000000000"/);
  assert.match(
    rendered,
    /NORA_AGENT_HUB_API_KEY_HASH_SECRET: "ci-agent-hub-hash-key-0000000000000000000"/,
  );

  const legacyArgs = withoutHelmSetting(helmSecretArgs, "secrets.agentHubApiKeyHashSecret");
  const installWithoutDedicatedSecret = spawnSync(
    "helm",
    [
      "template",
      "nora-security-test",
      "infra/helm/nora",
      "--show-only",
      "templates/secret-env.yaml",
      ...legacyArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(installWithoutDedicatedSecret.status, 0);
  assert.match(
    `${installWithoutDedicatedSecret.stderr}${installWithoutDedicatedSecret.stdout}`,
    /agentHubApiKeyHashSecret is required for new installs/,
  );

  const upgradeRendered = runChecked("helm", [
    "template",
    "nora-security-test",
    "infra/helm/nora",
    "--is-upgrade",
    "--show-only",
    "templates/secret-env.yaml",
    ...legacyArgs,
  ]);
  assert.match(
    upgradeRendered,
    /NORA_AGENT_HUB_API_KEY_HASH_SECRET: "ci-hash-key-00000000000000000000000000"/,
  );
});

test("Helm exposes only optional OAuth Secret keys to marketing", () => {
  const oauthEnvNames = [
    "OAUTH_LOGIN_ENABLED",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
  ];
  const rendered = renderFrontendManifests([
    "--set",
    "frontendMarketing.oauthExistingSecret=nora-marketing-oauth",
    "--set-string",
    "commonEnv.OAUTH_LOGIN_ENABLED=legacy-must-not-win",
    "--set-string",
    "commonEnv.UNRELATED_CONTROL_PLANE_SECRET=must-not-leak",
  ]);
  const marketing = manifestDocument(rendered, "Deployment", "nora-frontend-marketing");
  const dashboard = manifestDocument(rendered, "Deployment", "nora-frontend-dashboard");
  const admin = manifestDocument(rendered, "Deployment", "nora-admin-dashboard");

  for (const envName of oauthEnvNames) {
    assert.match(marketing, new RegExp(`- name: ${envName}\\n\\s+valueFrom:`));
    assert.match(
      marketing,
      new RegExp(`key: "${envName}"\\n\\s+optional: true`),
      `${envName} must be an optional Secret key`,
    );
    assert.doesNotMatch(dashboard, new RegExp(`- name: ${envName}\\b`));
    assert.doesNotMatch(admin, new RegExp(`- name: ${envName}\\b`));
  }
  assert.equal(marketing.match(/name: "nora-marketing-oauth"/g)?.length, oauthEnvNames.length);
  assert.doesNotMatch(marketing, /legacy-must-not-win|UNRELATED_CONTROL_PLANE_SECRET/);
  assert.doesNotMatch(dashboard + admin, /nora-marketing-oauth|secretKeyRef:/);
});

test("Helm keeps only legacy commonEnv OAuth compatibility for marketing", () => {
  const rendered = renderFrontendManifests([
    "--set-string",
    "commonEnv.OAUTH_LOGIN_ENABLED=true",
    "--set-string",
    "commonEnv.GOOGLE_CLIENT_SECRET=legacy-google-secret",
    "--set-string",
    "commonEnv.UNRELATED_CONTROL_PLANE_SECRET=must-not-leak",
  ]);
  const marketing = manifestDocument(rendered, "Deployment", "nora-frontend-marketing");
  const dashboard = manifestDocument(rendered, "Deployment", "nora-frontend-dashboard");
  const admin = manifestDocument(rendered, "Deployment", "nora-admin-dashboard");

  assert.match(marketing, /- name: OAUTH_LOGIN_ENABLED\n\s+value: "true"/);
  assert.match(marketing, /- name: GOOGLE_CLIENT_SECRET\n\s+value: "legacy-google-secret"/);
  assert.doesNotMatch(marketing, /UNRELATED_CONTROL_PLANE_SECRET|secretKeyRef:/);
  assert.doesNotMatch(
    dashboard + admin,
    /OAUTH_LOGIN_ENABLED|GOOGLE_CLIENT_SECRET|UNRELATED_CONTROL_PLANE_SECRET/,
  );
});

test("Helm rejects a local Docker backend when no socket is mounted", () => {
  const configMap = read("infra/helm/nora/templates/configmap-env.yaml");
  assert.match(configMap, /enabledBackends must include k8s/);
  assert.match(configMap, /enabledBackends must not include docker/);
  assert.match(configMap, /normalizedBackend := trim/);

  for (const mapName of ["backendEnv", "commonEnv"]) {
    const result = spawnSync(
      "helm",
      [
        "template",
        "nora-security-test",
        "infra/helm/nora",
        ...helmSecretArgs,
        "--set-string",
        `${mapName}.ENABLED_BACKENDS=docker`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr}${result.stdout}`,
      new RegExp(`${mapName}\\.ENABLED_BACKENDS is reserved`),
    );
  }

  const spacedDocker = spawnSync(
    "helm",
    [
      "template",
      "nora-security-test",
      "infra/helm/nora",
      ...helmSecretArgs,
      "--set-string",
      "enabledBackends=k8s\\, docker",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(spacedDocker.status, 0);
  assert.match(
    `${spacedDocker.stderr}${spacedDocker.stdout}`,
    /enabledBackends must not include docker/,
  );
});

test("setup requires Compose 2.24.4+ and rejects standalone v1", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");

  assert.match(bashSetup, /MIN_COMPOSE_VERSION="2\.24\.4"/);
  assert.match(powershellSetup, /\$MIN_COMPOSE_VERSION = \[version\]"2\.24\.4"/);
  assert.match(bashSetup, /docker-compose v1 is unsupported/);
  assert.match(powershellSetup, /docker-compose v1 is unsupported/);

  runChecked("bash", [
    "-c",
    `set -euo pipefail
     source <(awk '/^compose_version_is_supported\\(\\)/,/^}/' setup.sh)
     compose_version_is_supported 2.24.4
     compose_version_is_supported v2.25.0
     ! compose_version_is_supported 2.24.3
     ! compose_version_is_supported 1.29.2
     ! compose_version_is_supported invalid`,
  ]);
});

test("setup separates new API hash secrets while preserving migration fallbacks", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");

  assert.match(
    bashSetup,
    /if \[ -f "\$ENV_FILE" \]; then\s+NORA_API_KEY_HASH_SECRET="\$NORA_AGENT_HUB_API_KEY_HASH_SECRET"\s+else\s+NORA_API_KEY_HASH_SECRET="\$\(openssl rand -hex 32\)"/,
  );
  assert.match(
    powershellSetup,
    /if \(Test-Path \$ENV_FILE\) \{\s+\$NORA_API_KEY_HASH_SECRET = \$NORA_AGENT_HUB_API_KEY_HASH_SECRET\s+\} else \{\s+\$NORA_API_KEY_HASH_SECRET = New-HexSecret/,
  );
  assert.match(
    bashSetup,
    /ensure_api_key_hash_secret_env\(\)[\s\S]*?secure_env_file_permissions "\$env_path"[\s\S]*?if \[ -n "\$existing" \]/,
  );
  assert.match(
    powershellSetup,
    /function Ensure-ApiKeyHashSecretEnv[\s\S]*?Protect-EnvFile -EnvPath \$EnvPath[\s\S]*?if \(\$existing\)/,
  );

  runChecked("bash", [
    "-c",
    `set -euo pipefail
     error() { printf '%s\\n' "$*" >&2; }
     info() { :; }
     ok() { :; }
     source <(awk '/^secure_env_file_permissions\\(\\)/,/^}/' setup.sh)
     source <(awk '/^set_env_value\\(\\)/,/^}/' setup.sh)
     source <(awk '/^ensure_api_key_hash_secret_env\\(\\)/,/^}/' setup.sh)
     source <(awk '/^read_env_value\\(\\)/,/^}/' setup.sh)
     legacy_fixture="$(mktemp /tmp/nora-api-hash-legacy.XXXXXX)"
     existing_fixture="$(mktemp /tmp/nora-api-hash-existing.XXXXXX)"
     trap 'rm -f "$legacy_fixture" "$existing_fixture"' EXIT
     printf '%s\\n' 'NORA_AGENT_HUB_API_KEY_HASH_SECRET=legacy-hash-secret' > "$legacy_fixture"
     printf '%s\\n' 'NORA_API_KEY_HASH_SECRET=existing-primary-secret' > "$existing_fixture"
     chmod 644 "$legacy_fixture" "$existing_fixture"
     ensure_api_key_hash_secret_env "$legacy_fixture"
     ensure_api_key_hash_secret_env "$existing_fixture"
     test "$(read_env_value "$legacy_fixture" NORA_API_KEY_HASH_SECRET '')" = legacy-hash-secret
     test "$(read_env_value "$existing_fixture" NORA_API_KEY_HASH_SECRET '')" = existing-primary-secret
     test "$(stat -c '%a' "$legacy_fixture")" = 600
     test "$(stat -c '%a' "$existing_fixture")" = 600`,
  ]);
});

const hasPowerShell =
  spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    cwd: repoRoot,
  }).status === 0;

test(
  "PowerShell API hash migration preserves values and secures files",
  { skip: !hasPowerShell },
  () => {
    runChecked("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      input: `$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path "setup.ps1"),
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
foreach ($name in @("Protect-EnvFile", "Set-EnvValue", "Ensure-ApiKeyHashSecretEnv", "Read-EnvValue")) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression $definition.Extent.Text
}
function Write-Info { param([string]$Message) }
function Write-Ok { param([string]$Message) }
$legacyFixture = Join-Path ([System.IO.Path]::GetTempPath()) ("nora-api-hash-legacy-" + [guid]::NewGuid().ToString("N"))
$existingFixture = Join-Path ([System.IO.Path]::GetTempPath()) ("nora-api-hash-existing-" + [guid]::NewGuid().ToString("N"))
try {
  Set-Content -LiteralPath $legacyFixture -Value "NORA_AGENT_HUB_API_KEY_HASH_SECRET=legacy-hash-secret"
  Set-Content -LiteralPath $existingFixture -Value "NORA_API_KEY_HASH_SECRET=existing-primary-secret"
  & chmod 644 $legacyFixture $existingFixture
  Ensure-ApiKeyHashSecretEnv -EnvPath $legacyFixture
  Ensure-ApiKeyHashSecretEnv -EnvPath $existingFixture
  if ((Read-EnvValue -EnvPath $legacyFixture -Name "NORA_API_KEY_HASH_SECRET") -ne "legacy-hash-secret") { throw "Migration fallback changed" }
  if ((Read-EnvValue -EnvPath $existingFixture -Name "NORA_API_KEY_HASH_SECRET") -ne "existing-primary-secret") { throw "Existing primary changed" }
  if ((& stat -c '%a' $legacyFixture).Trim() -ne "600") { throw "Legacy fixture mode is not 0600" }
  if ((& stat -c '%a' $existingFixture).Trim() -ne "600") { throw "Existing fixture mode is not 0600" }
} finally {
  Remove-Item -LiteralPath $legacyFixture, $existingFixture -Force -ErrorAction SilentlyContinue
}`,
    });
  },
);

test("setup and entrypoint retain fail-closed secret handling contracts", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");
  const entrypoint = read("infra/container-entrypoint.sh");
  const composeSecretMaterializer = read("scripts/materialize-compose-secrets.sh");
  const deployWorkflow = read(".github/workflows/deploy-production.yml");
  const proxmoxWorkflow = read(".github/workflows/proxmox-real-hardware.yml");
  const releaseUpgrade = read("infra/run-release-upgrade.sh");
  const gitignore = read(".gitignore");

  assert.match(bashSetup, /secure_env_file_permissions/);
  assert.match(bashSetup, /chmod 600/);
  assert.match(bashSetup, /materialize_compose_secret_files/);
  assert.match(bashSetup, /scripts\/materialize-compose-secrets\.sh/);
  assert.match(bashSetup, /docker compose -p "\$project_name" down -v --remove-orphans/);
  assert.match(bashSetup, /--filter "network=\$compose_network"/);
  assert.match(composeSecretMaterializer, /chmod 700 "\$secrets_dir"/);
  assert.match(composeSecretMaterializer, /chmod 444 "\$tmp_file"/);
  assert.match(composeSecretMaterializer, /symlinked path component/);
  assert.match(powershellSetup, /unexpected entry/);
  assert.match(deployWorkflow, /bash scripts\/materialize-compose-secrets\.sh "\$DEPLOY_ENV_FILE"/);
  assert.match(deployWorkflow, /Verifying Docker socket access from \$\{service\}/);
  assert.match(deployWorkflow, /socketPath:"\/var\/run\/docker\.sock"/);
  assert.match(proxmoxWorkflow, /NORA_COMPOSE_SECRETS_DIR=%s/);
  assert.match(proxmoxWorkflow, /bash scripts\/materialize-compose-secrets\.sh "\$env_file"/);
  assert.match(proxmoxWorkflow, /rm -rf "\$secrets_dir"/);
  assert.match(releaseUpgrade, /bash scripts\/materialize-compose-secrets\.sh "\$env_file"/);
  assert.match(gitignore, /docker-compose\.override\.yml\.legacy-\*/);
  assert.match(powershellSetup, /function Protect-EnvFile/);
  assert.match(powershellSetup, /function Write-ComposeSecretFiles/);
  assert.match(powershellSetup, /docker compose -p \$projectName down -v --remove-orphans/);
  assert.match(powershellSetup, /--filter "network=\$composeNetwork"/);
  assert.match(powershellSetup, /\/inheritance:r/);
  assert.match(powershellSetup, /Failed to restrict the Windows ACL/);
  assert.match(entrypoint, /NORA_SECRETS_DIR:-\/run\/secrets/);
  assert.match(entrypoint, /Configured secret file is not readable/);

  const bashCheck = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
       error() { printf '%s\\n' "$*" >&2; }
       source <(awk '/^secure_env_file_permissions\\(\\)/,/^}/' setup.sh)
       fixture="$(mktemp /tmp/nora-env-mode.XXXXXX)"
       trap 'rm -f "$fixture"' EXIT
       chmod 644 "$fixture"
       secure_env_file_permissions "$fixture"
       test "$(stat -c '%a' "$fixture")" = 600`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(bashCheck.status, 0, bashCheck.stderr || bashCheck.stdout);

  runChecked("bash", [
    "-c",
    `set -euo pipefail
     error() { printf '%s\\n' "$*" >&2; }
     fixture_dir="$(mktemp -d /tmp/nora-compose-secrets.XXXXXX)"
     trap 'rm -rf "$fixture_dir"' EXIT
     env_file="$fixture_dir/.env"
     secrets_dir="$fixture_dir/secrets"
     printf '%s\\n' \
       'JWT_SECRET=jwt-secret' \
       'ENCRYPTION_KEY=encryption-secret' \
       'NORA_BACKUP_ENCRYPTION_KEY=backup-secret' \
       'NORA_AGENT_HUB_API_KEY_HASH_SECRET=agent-hub-secret' \
       'NORA_API_KEY_HASH_SECRET=api-secret' \
       'DB_PASSWORD=db-secret' \
       "NORA_COMPOSE_SECRETS_DIR=$secrets_dir" > "$env_file"
     chmod 600 "$env_file"
     bash scripts/materialize-compose-secrets.sh "$env_file"
     test "$(stat -c '%a' "$secrets_dir")" = 700
     test "$(stat -c '%a' "$secrets_dir/JWT_SECRET")" = 444
     test "$(tr -d '\\n' < "$secrets_dir/JWT_SECRET")" = jwt-secret
     test "$(find "$secrets_dir" -maxdepth 1 -type f | wc -l)" -eq 6
     unsafe_dir="$fixture_dir/unsafe"
     mkdir -p "$unsafe_dir"
     printf '%s\\n' keep > "$unsafe_dir/existing"
     chmod 755 "$unsafe_dir"
     sed "s#^NORA_COMPOSE_SECRETS_DIR=.*#NORA_COMPOSE_SECRETS_DIR=$unsafe_dir#" "$env_file" > "$fixture_dir/unsafe.env"
     ! bash scripts/materialize-compose-secrets.sh "$fixture_dir/unsafe.env"
     real_parent="$fixture_dir/real-parent"
     mkdir -p "$real_parent"
     ln -s "$real_parent" "$fixture_dir/linked-parent"
     sed "s#^NORA_COMPOSE_SECRETS_DIR=.*#NORA_COMPOSE_SECRETS_DIR=$fixture_dir/linked-parent/secrets#" "$env_file" > "$fixture_dir/symlink.env"
     ! bash scripts/materialize-compose-secrets.sh "$fixture_dir/symlink.env"`,
  ]);
});

test("release env refreshes and deduplicates the live Docker socket group", () => {
  runChecked("bash", [
    "-c",
    `set -euo pipefail
     fixture_dir="$(mktemp -d /tmp/nora-release-docker-gid.XXXXXX)"
     socket_pid=""
     cleanup() {
       if [ -n "$socket_pid" ]; then
         kill "$socket_pid" >/dev/null 2>&1 || true
         wait "$socket_pid" >/dev/null 2>&1 || true
       fi
       rm -rf "$fixture_dir"
     }
     trap cleanup EXIT
     env_file="$fixture_dir/.env"
     socket_path="$fixture_dir/docker.sock"
     fake_bin="$fixture_dir/bin"
     mkdir -p "$fake_bin"
     printf '%s\n' \
       '#!/bin/sh' \
       'if [ "$1" = "-c" ] && [ "$2" = "%g" ]; then printf "990\\n"; exit 0; fi' \
       'exec /usr/bin/stat "$@"' > "$fake_bin/stat"
     chmod 755 "$fake_bin/stat"
     printf '%s\n' \
       'NORA_CURRENT_VERSION=v1.16.0' \
       'NORA_CURRENT_COMMIT=old-commit' \
       'NORA_GITHUB_REPO=old/repo' \
       'DOCKER_GID=0' \
       'DOCKER_GID=123' \
       'NORA_AGENT_HUB_API_KEY_HASH_SECRET=existing-secret' > "$env_file"
     chmod 600 "$env_file"
     node -e 'const net=require("node:net");const server=net.createServer();server.listen(process.argv[1]);process.on("SIGTERM",()=>server.close(()=>process.exit(0)));' "$socket_path" &
     socket_pid=$!
     for _ in $(seq 1 50); do
       [ -S "$socket_path" ] && break
       sleep 0.02
     done
     test -S "$socket_path"
     PATH="$fake_bin:$PATH" NORA_DOCKER_SOCKET_PATH="$socket_path" \
       bash infra/update-release-env.sh "$env_file" v1.16.1 new-commit solomon2773/nora
     test "$(grep -c '^DOCKER_GID=' "$env_file")" -eq 1
     grep -Fxq 'DOCKER_GID=990' "$env_file"
     grep -Fxq 'NORA_CURRENT_VERSION=v1.16.1' "$env_file"
     grep -Fxq 'NORA_CURRENT_COMMIT=new-commit' "$env_file"
     grep -Fxq 'NORA_GITHUB_REPO=solomon2773/nora' "$env_file"
     grep -Fxq 'NORA_AGENT_HUB_API_KEY_HASH_SECRET=existing-secret' "$env_file"
     test "$(stat -c '%a' "$env_file")" = 600`,
  ]);
});

test("production update paths activate refreshed nginx config without touching custom configs", () => {
  const deployWorkflow = read(".github/workflows/deploy-production.yml");
  const rootPackage = JSON.parse(read("package.json"));
  const setupBash = read("setup.sh");
  const setupPowerShell = read("setup.ps1");
  const releaseUpgrade = read("infra/run-release-upgrade.sh");
  const setupTls = read("infra/setup-tls.sh");
  assert.match(
    rootPackage.scripts["ci:validate-infra"],
    /node --test scripts\/infra-security\.test\.mjs/,
  );
  assert.match(
    deployWorkflow,
    /bash infra\/render-public-nginx\.sh[\s\S]*?"\$DEPLOY_ENV_FILE"[\s\S]*?"\$DEPLOY_COMPOSE_FILES"/,
  );
  assert.match(
    deployWorkflow,
    /docker compose "\$\{compose_args\[@\]\}" run --rm --no-deps --interactive=false -T nginx nginx -t[\s\S]*?docker compose "\$\{compose_args\[@\]\}" up -d --build[\s\S]*?docker compose "\$\{compose_args\[@\]\}" up -d --force-recreate --no-deps nginx[\s\S]*?docker compose "\$\{compose_args\[@\]\}" exec -T nginx nginx -t <\/dev\/null/,
  );
  assert.match(
    deployWorkflow,
    /docker compose "\$\{compose_args\[@\]\}" exec -T backend-api \\\s*\n\s*node -e [^\n]+ <\/dev\/null; then/,
  );
  assert.match(
    deployWorkflow,
    /docker compose "\$\{compose_args\[@\]\}" exec -T "\$service" node -e "\$docker_probe" <\/dev\/null; then/,
  );
  assert.match(
    setupBash,
    /bash infra\/render-public-nginx\.sh "\$ENV_FILE" "\$compose_file_value"/,
  );
  assert.match(
    setupBash,
    /docker compose run --rm --no-deps --interactive=false -T nginx nginx -t[\s\S]*?docker compose up -d --build[\s\S]*?docker compose up -d --force-recreate --no-deps nginx[\s\S]*?docker compose exec -T nginx nginx -t <\/dev\/null/,
  );
  assert.match(
    setupPowerShell,
    /Write-PublicNginxConfig -TemplatePath \$updateNginxTemplate -Domain \$parsedPublicUri\.Host/,
  );
  assert.match(
    setupPowerShell,
    /docker compose run --rm --no-deps --interactive=false -T nginx nginx -t[\s\S]*?docker compose up -d --build[\s\S]*?docker compose up -d --force-recreate --no-deps nginx[\s\S]*?docker compose exec -T nginx nginx -t/,
  );
  assert.match(
    releaseUpgrade,
    /bash infra\/render-public-nginx\.sh "\$env_file" "\$compose_files"/,
  );
  assert.match(
    releaseUpgrade,
    /docker compose "\$\{COMPOSE_ARGS\[@\]\}" run --rm --no-deps --interactive=false -T nginx nginx -t[\s\S]*?docker compose "\$\{COMPOSE_ARGS\[@\]\}" up -d --build[\s\S]*?docker compose "\$\{COMPOSE_ARGS\[@\]\}" up -d --force-recreate --no-deps nginx[\s\S]*?docker compose "\$\{COMPOSE_ARGS\[@\]\}" exec -T nginx nginx -t <\/dev\/null/,
  );
  assert.match(
    setupTls,
    /certbot renew --quiet[\s\S]*?docker compose exec -T nginx nginx -t <\/dev\/null[\s\S]*?docker compose exec -T nginx nginx -s reload <\/dev\/null/,
  );

  for (const [file, source] of [
    [".github/workflows/deploy-production.yml", deployWorkflow],
    ["setup.sh", setupBash],
    ["infra/run-release-upgrade.sh", releaseUpgrade],
    ["infra/setup-tls.sh", setupTls],
  ]) {
    for (const line of shellLogicalLines(source)) {
      if (!line.includes("docker compose") || !line.includes("exec -T")) continue;
      const execCount = line.match(/\bexec -T\b/g)?.length || 0;
      const nullInputCount = line.match(/<\/dev\/null/g)?.length || 0;
      assert.equal(
        nullInputCount,
        execCount,
        `${file} must detach stdin for every docker compose exec: ${line.trim()}`,
      );
    }
  }

  const remoteValidation = deployWorkflow.match(
    /^\s*(docker compose "\$\{compose_args\[@\]\}" run --rm --no-deps --interactive=false -T nginx nginx -t)\s*$/m,
  );
  assert.ok(remoteValidation, "deploy workflow must expose a non-interactive nginx preflight");
  const activeValidation = deployWorkflow.match(
    /^\s*(docker compose "\$\{compose_args\[@\]\}" exec -T nginx nginx -t <\/dev\/null)\s*$/m,
  );
  assert.ok(activeValidation, "deploy workflow must detach stdin from active nginx validation");
  const setupPreflight = setupBash.match(
    /^\s*(docker compose run --rm --no-deps --interactive=false -T nginx nginx -t)\s*$/m,
  );
  assert.ok(setupPreflight, "setup must expose a non-interactive nginx preflight");
  const setupActiveValidation = setupBash.match(
    /^\s*(docker compose exec -T nginx nginx -t <\/dev\/null)\s*$/m,
  );
  assert.ok(setupActiveValidation, "setup must detach stdin from active nginx validation");
  const verificationBlockStart = deployWorkflow.indexOf(
    '          echo "Pre-validating the generated nginx config before replacing services."',
  );
  const verificationBlockEnd = deployWorkflow.indexOf("\n          REMOTE", verificationBlockStart);
  assert.ok(verificationBlockStart >= 0, "deploy workflow must expose the verification block");
  assert.ok(verificationBlockEnd > verificationBlockStart, "deploy verification block must end");
  const verificationBlock = deployWorkflow
    .slice(verificationBlockStart, verificationBlockEnd)
    .replace(/^ {10}/gm, "");
  const stdinFixture = mkdtempSync(path.join(tmpdir(), "nora-nginx-preflight-stdin-"));
  try {
    const fakeDocker = path.join(stdinFixture, "docker");
    const dockerLog = path.join(stdinFixture, "docker.log");
    const deployMarker = path.join(stdinFixture, "deploy-continued");
    const verificationMarker = path.join(stdinFixture, "verification-continued");
    const setupMarker = path.join(stdinFixture, "setup-continued");
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\t%s\n' "$(readlink /proc/$$/fd/0 || true)" "$*" >> "\${FAKE_DOCKER_LOG:?}"
if [[ " $* " == *" run "* && " $* " != *" --interactive=false "* ]]; then
  cat >/dev/null
fi
if [[ " $* " == *" exec "* && "$(readlink /proc/$$/fd/0 || true)" != "/dev/null" ]]; then
  cat >/dev/null
fi
`,
    );
    chmodSync(fakeDocker, 0o755);
    const remoteScript = `set -euo pipefail
compose_args=()
${remoteValidation[1]}
${activeValidation[1]}
printf continued > ${JSON.stringify(deployMarker)}
`;
    const deployResult = spawnSync("bash", ["-s"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: remoteScript,
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: dockerLog,
        PATH: `${stdinFixture}:${process.env.PATH}`,
      },
    });
    assert.equal(deployResult.status, 0, deployResult.stderr || deployResult.stdout);
    assert.equal(readFileSync(deployMarker, "utf8"), "continued");

    const verificationScript = `set -euo pipefail
compose_args=()
${verificationBlock}
printf continued > ${JSON.stringify(verificationMarker)}
`;
    const verificationResult = spawnSync("bash", ["-s"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: verificationScript,
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: dockerLog,
        PATH: `${stdinFixture}:${process.env.PATH}`,
      },
    });
    assert.equal(
      verificationResult.status,
      0,
      verificationResult.stderr || verificationResult.stdout,
    );
    assert.equal(readFileSync(verificationMarker, "utf8"), "continued");
    const execCalls = readFileSync(dockerLog, "utf8")
      .split("\n")
      .filter((line) => line.includes("\tcompose exec "));
    assert.equal(execCalls.length, 6, "expected one focused and five full-block exec calls");
    assert.ok(
      execCalls.every((line) => line.startsWith("/dev/null\t")),
      `all Compose exec calls must detach stdin:\n${execCalls.join("\n")}`,
    );
    for (const service of ["backend-api", "worker-provisioner", "worker-backup"]) {
      assert.ok(
        execCalls.some((line) => line.includes(`exec -T ${service} node -e`)),
        `verification block must probe ${service}`,
      );
    }

    const setupScript = `set -euo pipefail
${setupPreflight[1]}
${setupActiveValidation[1]}
printf continued > ${JSON.stringify(setupMarker)}
`;
    const setupResult = spawnSync("bash", ["-s"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: setupScript,
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: dockerLog,
        PATH: `${stdinFixture}:${process.env.PATH}`,
      },
    });
    assert.equal(setupResult.status, 0, setupResult.stderr || setupResult.stdout);
    assert.equal(readFileSync(setupMarker, "utf8"), "continued");
  } finally {
    rmSync(stdinFixture, { recursive: true, force: true });
  }

  runChecked("bash", [
    "-c",
    `set -euo pipefail
     fixture_dir="$(mktemp -d /tmp/nora-render-public-nginx.XXXXXX)"
     cleanup() {
       rm -rf "$fixture_dir"
     }
     trap cleanup EXIT
     fixture_repo="$fixture_dir/repo"
     mkdir -p "$fixture_repo/infra"
     cp infra/render-public-nginx.sh infra/nginx_public.conf.template infra/nginx_tls.conf "$fixture_repo/infra/"
     env_file="$fixture_repo/.env"

     printf '%s\n' \\
       'NGINX_CONFIG_FILE=nginx.public.conf' \\
       'NEXTAUTH_URL=https://launch.example.com' > "$env_file"
     bash "$fixture_repo/infra/render-public-nginx.sh" "$env_file" 'docker-compose.yml:infra/docker-compose.public-tls.yml'
     grep -Fq 'server_name launch.example.com;' "$fixture_repo/nginx.public.conf"
     grep -Fq 'ssl_certificate     /etc/letsencrypt/live/launch.example.com/fullchain.pem;' "$fixture_repo/nginx.public.conf"
     grep -Fq 'Strict-Transport-Security "max-age=63072000" always;' "$fixture_repo/nginx.public.conf"
     grep -Fq 'add_header X-Frame-Options $surface_x_frame_options always;' "$fixture_repo/nginx.public.conf"

     printf '%s\n' \\
       'NGINX_CONFIG_FILE=custom-nginx.conf' \\
       'NEXTAUTH_URL=https://ignored.example.com' > "$env_file"
     before="$(sha256sum "$fixture_repo/nginx.public.conf" | awk '{ print $1 }')"
     bash "$fixture_repo/infra/render-public-nginx.sh" "$env_file" 'docker-compose.yml:infra/docker-compose.public-prod.yml'
     after="$(sha256sum "$fixture_repo/nginx.public.conf" | awk '{ print $1 }')"
     test "$before" = "$after"`,
  ]);
});

test("production deploy accepts only exact Nora product release tags", () => {
  const workflow = read(".github/workflows/deploy-production.yml");
  const setupBash = read("setup.sh");
  const setupPowerShell = read("setup.ps1");
  const patternMatch = workflow.match(/product_version_pattern='([^']+)'/);
  assert.ok(patternMatch, "deploy workflow must declare the Nora product-version pattern");

  const productVersionPattern = new RegExp(patternMatch[1]);
  for (const accepted of ["v0.0.0", "v1.16.0", "v12.34.56"]) {
    assert.match(accepted, productVersionPattern);
  }
  for (const rejected of [
    "nora-copilot-plugin-v0.1.3",
    "nora-mcp-v1.16.0",
    "1.16.0",
    "v01.16.0",
    "v1.16.0-rc.1",
  ]) {
    assert.doesNotMatch(rejected, productVersionPattern);
  }

  assert.match(workflow, /git tag --points-at HEAD/);
  assert.match(workflow, /Version override must be an exact Nora product tag/);
  assert.match(workflow, /Version override must name an existing Nora product tag/);
  assert.match(workflow, /is not reachable from target commit/);
  assert.doesNotMatch(workflow, /git describe --tags/);
  assert.doesNotMatch(workflow, /latest_tag=/);
  assert.match(setupBash, /resolve_current_release_version\(\)/);
  assert.match(setupBash, /git tag --points-at HEAD/);
  assert.doesNotMatch(setupBash, /git describe --tags/);
  assert.match(setupPowerShell, /function Resolve-CurrentReleaseVersion/);
  assert.match(setupPowerShell, /git tag --points-at HEAD/);
  assert.doesNotMatch(setupPowerShell, /git describe --tags/);
  assert.match(workflow, /health_attempts=221/);
  assert.match(workflow, /health_interval_seconds=3/);

  const stepMatch = workflow.match(
    / {6}- name: Compute deployed version metadata\n {8}id: release_meta\n {8}run: \|\n([\s\S]*?)(?=\n {6}- uses:)/,
  );
  assert.ok(stepMatch, "deploy workflow must keep the release metadata step executable in tests");
  const releaseMetadataScript = stepMatch[1].replace(/^ {10}/gm, "");
  const setupFunctionMatch = setupBash.match(
    /resolve_current_release_version\(\) \{\n([\s\S]*?)\n\}/,
  );
  assert.ok(setupFunctionMatch, "setup.sh must expose executable product-version resolution");
  const setupVersionScript = `resolve_current_release_version() {\n${setupFunctionMatch[1]}\n}\nresolve_current_release_version\n`;
  const fixtureRepo = mkdtempSync(path.join(tmpdir(), "nora-release-metadata-"));

  try {
    writeFileSync(path.join(fixtureRepo, "fixture.txt"), "release metadata fixture\n");
    runChecked("git", ["init", "-q"], { cwd: fixtureRepo });
    runChecked("git", ["add", "fixture.txt"], { cwd: fixtureRepo });
    runChecked(
      "git",
      [
        "-c",
        "user.name=Nora CI",
        "-c",
        "user.email=ci@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: fixtureRepo },
    );

    const runMetadata = (inputVersion = "") => {
      const outputFile = path.join(fixtureRepo, `github-output-${Date.now()}-${Math.random()}`);
      writeFileSync(outputFile, "");
      const result = spawnSync("bash", ["-c", releaseMetadataScript], {
        cwd: fixtureRepo,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputFile,
          INPUT_VERSION: inputVersion,
        },
      });
      return { result, output: readFileSync(outputFile, "utf8") };
    };
    const runSetupVersion = () =>
      spawnSync("bash", ["-c", setupVersionScript], {
        cwd: fixtureRepo,
        encoding: "utf8",
        env: process.env,
      });

    runChecked(
      "git",
      [
        "-c",
        "user.name=Nora CI",
        "-c",
        "user.email=ci@example.invalid",
        "tag",
        "-a",
        "nora-copilot-plugin-v0.1.3",
        "-m",
        "component release",
      ],
      { cwd: fixtureRepo },
    );
    const componentOnly = runMetadata();
    assert.equal(componentOnly.result.status, 0, componentOnly.result.stderr);
    assert.match(componentOnly.output, /^version=$/m);
    assert.doesNotMatch(componentOnly.output, /nora-copilot-plugin/);
    assert.match(componentOnly.output, /^commit=[0-9a-f]{40}$/m);
    const componentOnlySetup = runSetupVersion();
    assert.equal(componentOnlySetup.status, 0, componentOnlySetup.stderr);
    assert.equal(componentOnlySetup.stdout, "");

    runChecked(
      "git",
      [
        "-c",
        "user.name=Nora CI",
        "-c",
        "user.email=ci@example.invalid",
        "tag",
        "-a",
        "v1.16.0",
        "-m",
        "product release",
      ],
      { cwd: fixtureRepo },
    );
    const automaticProductVersion = runMetadata();
    assert.equal(automaticProductVersion.result.status, 0, automaticProductVersion.result.stderr);
    assert.match(automaticProductVersion.output, /^version=v1\.16\.0$/m);
    const automaticSetupVersion = runSetupVersion();
    assert.equal(automaticSetupVersion.status, 0, automaticSetupVersion.stderr);
    assert.equal(automaticSetupVersion.stdout.trim(), "v1.16.0");

    writeFileSync(path.join(fixtureRepo, "post-release.txt"), "post-release source checkout\n");
    runChecked("git", ["add", "post-release.txt"], { cwd: fixtureRepo });
    runChecked(
      "git",
      [
        "-c",
        "user.name=Nora CI",
        "-c",
        "user.email=ci@example.invalid",
        "commit",
        "-qm",
        "post-release source checkout",
      ],
      { cwd: fixtureRepo },
    );

    const sourceCheckout = runMetadata();
    assert.equal(sourceCheckout.result.status, 0, sourceCheckout.result.stderr);
    assert.match(sourceCheckout.output, /^version=$/m);

    const manualProductVersion = runMetadata("v1.16.0");
    assert.equal(manualProductVersion.result.status, 0, manualProductVersion.result.stderr);
    assert.match(manualProductVersion.output, /^version=v1\.16\.0$/m);

    const nonexistentManualVersion = runMetadata("v2.3.4");
    assert.notEqual(nonexistentManualVersion.result.status, 0);
    assert.match(
      `${nonexistentManualVersion.result.stderr}${nonexistentManualVersion.result.stdout}`,
      /Version override must name an existing Nora product tag/,
    );

    const invalidManualVersion = runMetadata("nora-copilot-plugin-v0.1.3");
    assert.notEqual(invalidManualVersion.result.status, 0);
    assert.match(
      `${invalidManualVersion.result.stderr}${invalidManualVersion.result.stdout}`,
      /Version override must be an exact Nora product tag/,
    );

    const tree = runChecked("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: fixtureRepo,
    }).trim();
    const unrelatedCommit = runChecked(
      "git",
      [
        "-c",
        "user.name=Nora CI",
        "-c",
        "user.email=ci@example.invalid",
        "commit-tree",
        tree,
        "-m",
        "unrelated release",
      ],
      { cwd: fixtureRepo },
    ).trim();
    runChecked("git", ["tag", "v2.0.0", unrelatedCommit], { cwd: fixtureRepo });
    const unrelatedManualVersion = runMetadata("v2.0.0");
    assert.notEqual(unrelatedManualVersion.result.status, 0);
    assert.match(
      `${unrelatedManualVersion.result.stderr}${unrelatedManualVersion.result.stdout}`,
      /is not reachable from target commit/,
    );
  } finally {
    rmSync(fixtureRepo, { recursive: true, force: true });
  }
});
