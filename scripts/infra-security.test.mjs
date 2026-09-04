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
      /"\/" "public, max-age=300, stale-while-revalidate=60";/,
      `${file} must give Cloudflare an explicit homepage edge TTL`,
    );
    assert.match(
      source,
      /add_header Cloudflare-CDN-Cache-Control \$marketing_cloudflare_cache_control always;/,
      `${file} must emit the homepage-only Cloudflare cache policy`,
    );
    assert.match(
      source,
      /location = \/ \{[\s\S]*?proxy_hide_header Cache-Control;[\s\S]*?proxy_hide_header Strict-Transport-Security;/,
    );
    assert.match(
      source,
      /location = \/admin \{\s*return 308 \/admin\/\$is_args\$args;\s*\}/,
      `${file} must normalize the bare admin path without dropping query arguments`,
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

test("validated OpenClaw defaults stay aligned across runtime, setup, and docs", () => {
  const defaults = read("agent-runtime/lib/openclawDefaults.ts");
  const match = defaults.match(/DEFAULT_OPENCLAW_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(match, "openclawDefaults.ts must expose an exact validated version");
  const version = match[1];
  const packageSpec = `openclaw@${version}`;

  for (const file of [
    "agent-runtime/Dockerfile.openclaw-agent",
    "agent-runtime/Dockerfile.nemoclaw-agent",
  ]) {
    assert.match(
      read(file),
      new RegExp(`ARG OPENCLAW_VERSION=${version.replaceAll(".", "\\.")}(?:\\s|$)`),
      `${file} must bake the validated OpenClaw version`,
    );
  }

  for (const file of [
    ".env.example",
    "setup.sh",
    "setup.ps1",
    "docs/configuration/environment-variables.mdx",
  ]) {
    const source = read(file);
    assert.ok(source.includes(packageSpec), `${file} must document ${packageSpec}`);
  }
  assert.doesNotMatch(read(".env.example"), /openclaw@latest/);
  assert.doesNotMatch(read("docs/configuration/environment-variables.mdx"), /openclaw@latest/);
  assert.doesNotMatch(
    read("setup.sh"),
    /read_env_value[^\n]+"openclaw@latest"\)/,
    "setup.sh must not restore a floating package default",
  );
  assert.doesNotMatch(
    read("setup.ps1"),
    /Read-EnvValue[^\n]+-Default "openclaw@latest"/,
    "setup.ps1 must not restore a floating package default",
  );
});

test("NemoClaw image replaces inherited npm globals before reinstalling", () => {
  const dockerfile = read("agent-runtime/Dockerfile.nemoclaw-agent");
  const installCommand = shellLogicalLines(dockerfile)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(
      (line) =>
        line.startsWith("RUN ") &&
        line.includes('npm install -g "tsx@${TSX_VERSION}" "openclaw@${OPENCLAW_VERSION}"'),
    );
  assert.ok(installCommand, "NemoClaw Dockerfile must expose the global install command");

  const treeRemoval = "rm -rf /usr/lib/node_modules/openclaw /usr/lib/node_modules/tsx";
  const binRemoval = "rm -f /usr/bin/openclaw /usr/bin/tsx";
  const install = 'npm install -g "tsx@${TSX_VERSION}" "openclaw@${OPENCLAW_VERSION}"';
  const installIndex = installCommand.indexOf(install);

  for (const removal of [treeRemoval, binRemoval]) {
    const removalIndex = installCommand.indexOf(removal);
    assert.notEqual(removalIndex, -1, `NemoClaw Dockerfile must run: ${removal}`);
    assert.ok(removalIndex < installIndex, `${removal} must run before npm install -g`);
  }

  assert.equal(
    (installCommand.match(/test "\$\(npm config get prefix\)" = "\/usr"/g) || []).length,
    2,
    "NemoClaw must verify the /usr npm prefix before and after installation",
  );
  assert.equal(
    (installCommand.match(/test "\$\(npm root -g\)" = "\/usr\/lib\/node_modules"/g) || []).length,
    2,
    "NemoClaw must verify the /usr global root before and after installation",
  );
  assert.doesNotMatch(
    installCommand,
    /(?:NPM_CONFIG_PREFIX|npm config set prefix|npm install\b[^;&]*--prefix(?:=|\s))/,
    "NemoClaw must replace the inherited /usr tree instead of leaving it beside a second prefix",
  );
  assert.match(
    installCommand,
    /test "\$\(node -p 'require\("\/usr\/lib\/node_modules\/openclaw\/package\.json"\)\.version'\)" = "\$\{OPENCLAW_VERSION\}"/,
  );
  assert.match(
    installCommand,
    /test "\$\(node -p 'require\("\/usr\/lib\/node_modules\/tsx\/package\.json"\)\.version'\)" = "\$\{TSX_VERSION\}"/,
  );
  for (const binary of ["openclaw", "tsx"]) {
    assert.match(installCommand, new RegExp(`test -x /usr/bin/${binary}`));
    assert.match(installCommand, new RegExp(`/usr/bin/${binary} --version`));
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

test("worker images cache bounded backend dependency installs before source copies", () => {
  for (const file of [
    "workers/provisioner/Dockerfile",
    "workers/provisioner/Dockerfile.prod",
    "workers/backup/Dockerfile",
    "workers/backup/Dockerfile.prod",
  ]) {
    const source = read(file);
    const manifestCopy =
      "COPY backend-api/package.json backend-api/package-lock.json* /backend-api/";
    const backendInstall = shellLogicalLines(source).find(
      (line) => line.startsWith("RUN ") && line.includes("cd /backend-api;"),
    );
    const sourceCopy = "COPY backend-api /backend-api";
    const manifestCopyIndex = source.indexOf(manifestCopy);
    const backendInstallIndex = source.indexOf("cd /backend-api;", manifestCopyIndex);
    const sourceCopyIndex = source.indexOf(sourceCopy, backendInstallIndex);

    assert.notEqual(manifestCopyIndex, -1, `${file} must copy backend manifests first`);
    assert.ok(backendInstall, `${file} must install backend runtime dependencies`);
    assert.notEqual(sourceCopyIndex, -1, `${file} must copy the full backend source`);
    assert.ok(
      manifestCopyIndex < backendInstallIndex,
      `${file} must copy backend manifests before installing dependencies`,
    );
    assert.ok(
      backendInstallIndex < sourceCopyIndex,
      `${file} must install backend dependencies before copying source`,
    );
    assert.match(source, /^ARG NPM_INSTALL_TIMEOUT_SECONDS=900$/m);

    const dependencyInstalls = shellLogicalLines(source).filter(
      (line) => line.startsWith("RUN ") && line.includes("npm ci --omit=dev"),
    );
    assert.equal(dependencyInstalls.length, 2, `${file} must install both dependency trees`);
    for (const install of dependencyInstalls) {
      assert.match(
        install,
        /timeout -k 30 "\$NPM_INSTALL_TIMEOUT_SECONDS" npm ci --omit=dev/,
        `${file} must bound npm ci`,
      );
      assert.match(
        install,
        /case "\$status" in 124\|137\|143\) exit "\$status"/,
        `${file} must not fall back after a timed-out npm ci`,
      );
      assert.match(
        install,
        /timeout -k 30 "\$NPM_INSTALL_TIMEOUT_SECONDS" npm install --omit=dev/,
        `${file} must bound the npm install fallback`,
      );
    }
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

// #409: OpenClaw was forced into ENABLED_RUNTIME_FAMILIES with no way to
// decline, and its agent image was built unconditionally — so an operator who
// only wanted Hermes still had to build and enable a runtime they never asked
// for. NemoClaw, by contrast, had an explicit opt-out, which is the
// inconsistency the report named.
test("setup lets both runtime families be declined, in bash and PowerShell", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");

  // The list starts empty and is built from both flags. (OpenClaw still appears
  // as the no-runtime fallback further down, which is why this checks the
  // initial declaration rather than asserting the string never occurs — the
  // executable test below is what pins the actual behaviour.)
  assert.match(bashSetup, /enabled_runtime_families=\(\)/);
  assert.match(powershellSetup, /\$enabledRuntimeFamilies = @\(\)/);

  // Both installers ask about OpenClaw, defaulting to keeping it on.
  assert.match(bashSetup, /Keep OpenClaw runtime family enabled\? \[Y\/n\]/);
  assert.match(powershellSetup, /Keep OpenClaw runtime family enabled\? \[Y\/n\]/);

  // The agent image build is gated on the family actually being enabled.
  assert.match(bashSetup, /csv_value_is_enabled "\$\{ENABLED_RUNTIME_FAMILIES:-\}" "openclaw"/);
  assert.match(
    powershellSetup,
    /Test-CommaSeparatedValue -List \$ENABLED_RUNTIME_FAMILIES -Value "openclaw"/,
  );

  // NemoClaw sandboxes OpenClaw agents, so it must not survive OpenClaw being
  // off — the contradictory pair should be unreachable, not reconciled later.
  assert.match(bashSetup, /NemoClaw sandboxes OpenClaw agents/);
  assert.match(powershellSetup, /NemoClaw sandboxes OpenClaw agents/);
});

test("setup never writes a runtime-family list that cannot deploy anything", () => {
  // Executed rather than asserted on source: the guard only matters if it
  // actually produces a usable list for every combination of answers.
  const cases = [
    { openclaw: "true", hermes: "false", expected: "openclaw" },
    { openclaw: "false", hermes: "true", expected: "hermes" },
    { openclaw: "true", hermes: "true", expected: "openclaw,hermes" },
    // Declining both must fall back rather than write an empty list.
    { openclaw: "false", hermes: "false", expected: "openclaw" },
  ];

  for (const { openclaw, hermes, expected } of cases) {
    const stdout = runChecked("bash", [
      "-c",
      `set -euo pipefail
       warn() { :; }
       OPENCLAW_RUNTIME_ENABLED=${openclaw}
       HERMES_RUNTIME_ENABLED=${hermes}
       source <(awk '/^enabled_runtime_families=\\(\\)/,/^ENABLED_RUNTIME_FAMILIES=/' setup.sh)
       printf '%s' "$ENABLED_RUNTIME_FAMILIES"`,
    ]);
    assert.equal(
      stdout,
      expected,
      `openclaw=${openclaw} hermes=${hermes} should yield "${expected}"`,
    );
  }
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

test("setup applies immutable-aware NemoClaw image policy", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");

  assert.match(bashSetup, /^nemoclaw_image_ref_is_mutable\(\)/m);
  assert.match(bashSetup, /^csv_value_is_enabled\(\)/m);
  assert.match(bashSetup, /\[Ll\]\[Aa\]\[Tt\]\[Ee\]\[Ss\]\[Tt\]/);
  assert.doesNotMatch(bashSetup, /\$\{[^}]+,,\}/, "setup.sh must remain compatible with Bash 3.2");
  assert.match(bashSetup, /^ensure_nemoclaw_sandbox_image\(\)/m);
  assert.match(bashSetup, /docker image inspect "\$image"/);
  assert.match(bashSetup, /ensure_nemoclaw_sandbox_image "\$NEMOCLAW_SANDBOX_IMAGE"/);
  assert.match(bashSetup, /csv_value_is_enabled "\$\{ENABLED_SANDBOX_PROFILES:-\}" "nemoclaw"/);
  assert.doesNotMatch(bashSetup, /grep -Eq '\^NEMOCLAW_SANDBOX_IMAGE=nora-nemoclaw-agent:local\$'/);
  assert.match(powershellSetup, /function Test-NemoClawImageReferenceMutable/);
  assert.match(powershellSetup, /function Test-CommaSeparatedValue/);
  assert.match(powershellSetup, /function Ensure-NemoClawSandboxImage/);
  assert.match(powershellSetup, /docker image inspect \$imageRef/);
  assert.match(powershellSetup, /Ensure-NemoClawSandboxImage -Image \$NEMOCLAW_SANDBOX_IMAGE/);
  assert.doesNotMatch(powershellSetup, /Select-String[^\n]+NEMOCLAW_SANDBOX_IMAGE/);

  runChecked("bash", [
    "-c",
    `set -euo pipefail
     info() { :; }
     ok() { :; }
     error() { :; }
     source <(awk '/^nemoclaw_image_ref_is_mutable\\(\\)/,/^}/' setup.sh)
     source <(awk '/^csv_value_is_enabled\\(\\)/,/^}/' setup.sh)
     source <(awk '/^ensure_nemoclaw_sandbox_image\\(\\)/,/^}/' setup.sh)
     fixture_dir="$(mktemp -d /tmp/nora-nemoclaw-image-policy.XXXXXX)"
     docker_log="$fixture_dir/docker.log"
     trap 'rm -rf "$fixture_dir"' EXIT
     docker() {
       printf '%s\n' "$*" >> "$docker_log"
       case "$1" in
         image)
           case "$3" in
             registry.example/missing:*|registry.example/unavailable:*) return 1 ;;
             *) return 0 ;;
           esac
           ;;
         pull)
           [ "$2" != "registry.example/unavailable:1.0" ]
           ;;
         build) return 0 ;;
       esac
     }
     reset_log() { : > "$docker_log"; }
     assert_no_pull() { ! grep -q '^pull ' "$docker_log"; }

     csv_value_is_enabled 'standard, nemoclaw' nemoclaw
     csv_value_is_enabled ' standard ,  nemoclaw  ' nemoclaw
     ! csv_value_is_enabled 'standard,strict' nemoclaw

     reset_log
     ensure_nemoclaw_sandbox_image nora-nemoclaw-agent:local
     grep -Fq 'build -f agent-runtime/Dockerfile.nemoclaw-agent -t nora-nemoclaw-agent:local agent-runtime/' "$docker_log"
     assert_no_pull

     for immutable in registry.example/nemoclaw:local registry.example/nemoclaw:1.2.3 registry.example/nemoclaw@sha256:abc123; do
       reset_log
       ensure_nemoclaw_sandbox_image "$immutable"
       grep -Fq "image inspect $immutable" "$docker_log"
       assert_no_pull
     done

     for mutable in registry.example/nemoclaw registry.example/nemoclaw:latest; do
       reset_log
       ensure_nemoclaw_sandbox_image "$mutable"
       grep -Fq "image inspect $mutable" "$docker_log"
       grep -Fq "pull $mutable" "$docker_log"
     done

     reset_log
     ensure_nemoclaw_sandbox_image registry.example/missing:2.0
     grep -Fq 'image inspect registry.example/missing:2.0' "$docker_log"
     grep -Fq 'pull registry.example/missing:2.0' "$docker_log"

     reset_log
     ! ensure_nemoclaw_sandbox_image registry.example/unavailable:1.0
     grep -Fq 'pull registry.example/unavailable:1.0' "$docker_log"`,
  ]);
});

test("production deploy reads NemoClaw settings without sourcing the env file", () => {
  const workflow = read(".github/workflows/deploy-production.yml");
  const functionMatch = workflow.match(/ {10}read_deploy_env_value\(\) \{\n[\s\S]*?\n {10}\}/);
  assert.ok(functionMatch, "deploy workflow must expose the safe env reader");
  const functionSource = functionMatch[0].replace(/^ {10}/gm, "");
  assert.doesNotMatch(functionSource, /(?:^|\n)\s*(?:source|\.)\s+/);

  const fixtureDir = mkdtempSync(path.join(tmpdir(), "nora-deploy-env-reader-"));
  const envFile = path.join(fixtureDir, ".env");
  try {
    writeFileSync(
      envFile,
      [
        'ENABLED_SANDBOX_PROFILES = "standard, nemoclaw"',
        "NEMOCLAW_SANDBOX_IMAGE='nora-nemoclaw-agent:local'",
        "JWT_SECRET=must-not-be-printed",
      ].join("\n") + "\n",
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${functionSource}
test "$(read_deploy_env_value "$1" ENABLED_SANDBOX_PROFILES "")" = "standard, nemoclaw"
test "$(read_deploy_env_value "$1" NEMOCLAW_SANDBOX_IMAGE "")" = "nora-nemoclaw-agent:local"`,
        "nora-deploy-env-reader",
        envFile,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("production deploy rejects PaaS without complete signup bot protection", () => {
  const workflow = read(".github/workflows/deploy-production.yml");
  const validator = path.join(repoRoot, "scripts", "validate-paas-signup-protection.sh");
  assert.match(workflow, /bash scripts\/validate-paas-signup-protection\.sh "\$DEPLOY_ENV_FILE"/);

  const fixtureDir = mkdtempSync(path.join(tmpdir(), "nora-paas-signup-protection-"));
  const envFile = path.join(fixtureDir, ".env");
  const run = (lines) => {
    writeFileSync(envFile, `${lines.join("\n")}\n`);
    return spawnSync("bash", [validator, envFile], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  };

  try {
    assert.equal(run(["PLATFORM_MODE=selfhosted"]).status, 0);

    const disabled = run(["PLATFORM_MODE=paas", "SIGNUP_BOT_PROTECTION_PROVIDER=none"]);
    assert.notEqual(disabled.status, 0);
    assert.match(disabled.stderr, /requires SIGNUP_BOT_PROTECTION_PROVIDER=turnstile or recaptcha/);

    const incomplete = run([
      "PLATFORM_MODE=paas",
      "SIGNUP_BOT_PROTECTION_PROVIDER=turnstile",
      "SIGNUP_TURNSTILE_SITE_KEY=site-key",
      "SIGNUP_TURNSTILE_SECRET= # server-only",
    ]);
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /requires both the public site key and server secret/);

    const turnstile = run([
      "PLATFORM_MODE=paas",
      "SIGNUP_BOT_PROTECTION_PROVIDER=turnstile",
      "SIGNUP_TURNSTILE_SITE_KEY=site-key",
      "SIGNUP_TURNSTILE_SECRET=secret",
    ]);
    assert.equal(turnstile.status, 0, turnstile.stderr || turnstile.stdout);

    const recaptchaAliases = run([
      "PLATFORM_MODE=PAAS",
      "NEXT_PUBLIC_SIGNUP_BOT_PROTECTION_PROVIDER=recaptcha",
      "NEXT_PUBLIC_SIGNUP_RECAPTCHA_SITE_KEY=site-key",
      "SIGNUP_RECAPTCHA_SECRET=secret",
    ]);
    assert.equal(recaptchaAliases.status, 0, recaptchaAliases.stderr || recaptchaAliases.stdout);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
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
     source <(awk '/^decode_compose_env_literal\\(\\)/,/^}/' setup.sh)
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
  "PowerShell setup applies immutable-aware NemoClaw image policy",
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
foreach ($name in @("Test-NemoClawImageReferenceMutable", "Test-CommaSeparatedValue", "Ensure-NemoClawSandboxImage")) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression $definition.Extent.Text
}
function Write-Info { param([string]$Message) }
function Write-Ok { param([string]$Message) }
function Write-Err { param([string]$Message) }
$script:PresentImages = @(
  "registry.example/nemoclaw:local",
  "registry.example/nemoclaw:1.2.3",
  "registry.example/nemoclaw@sha256:abc123",
  "registry.example/nemoclaw",
  "registry.example/nemoclaw:latest"
)
$script:DockerLog = New-Object System.Collections.Generic.List[string]
function docker {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$DockerArgs)
  $parts = @($DockerArgs | ForEach-Object { [string]$_ })
  $script:DockerLog.Add(($parts -join " "))
  if ($parts[0] -eq "image" -and $parts[1] -eq "inspect") {
    $global:LASTEXITCODE = if ($script:PresentImages -contains $parts[2]) { 0 } else { 1 }
    return
  }
  if ($parts[0] -eq "pull") {
    $global:LASTEXITCODE = if ($parts[1] -eq "registry.example/unavailable:1.0") { 1 } else { 0 }
    return
  }
  $global:LASTEXITCODE = 0
}
function Reset-DockerLog { $script:DockerLog.Clear() }
function Assert-NoPull {
  if ($script:DockerLog | Where-Object { $_ -like "pull *" }) { throw "Unexpected pull" }
}

if (-not (Test-NemoClawImageReferenceMutable -Image "registry.example/nemoclaw")) { throw "Untagged ref must be mutable" }
if (-not (Test-NemoClawImageReferenceMutable -Image "registry.example/nemoclaw:latest")) { throw "latest must be mutable" }
foreach ($immutable in @("registry.example/nemoclaw:local", "registry.example/nemoclaw:1.2.3", "registry.example/nemoclaw@sha256:abc123")) {
  if (Test-NemoClawImageReferenceMutable -Image $immutable) { throw "$immutable must be immutable" }
}
if (-not (Test-CommaSeparatedValue -List "standard, nemoclaw" -Value "nemoclaw")) { throw "Whitespace profile was not enabled" }
if (-not (Test-CommaSeparatedValue -List " standard ,  nemoclaw  " -Value "nemoclaw")) { throw "Trimmed profile was not enabled" }
if (Test-CommaSeparatedValue -List "standard,strict" -Value "nemoclaw") { throw "Missing profile was enabled" }

Reset-DockerLog
Ensure-NemoClawSandboxImage -Image "nora-nemoclaw-agent:local"
if (-not ($script:DockerLog | Where-Object { $_ -like "build *Dockerfile.nemoclaw-agent*" })) { throw "Exact local ref was not built" }
Assert-NoPull

foreach ($immutable in @("registry.example/nemoclaw:local", "registry.example/nemoclaw:1.2.3", "registry.example/nemoclaw@sha256:abc123")) {
  Reset-DockerLog
  Ensure-NemoClawSandboxImage -Image $immutable
  Assert-NoPull
}
foreach ($mutable in @("registry.example/nemoclaw", "registry.example/nemoclaw:latest")) {
  Reset-DockerLog
  Ensure-NemoClawSandboxImage -Image $mutable
  if (-not ($script:DockerLog -contains "pull $mutable")) { throw "$mutable was not refreshed" }
}
Reset-DockerLog
Ensure-NemoClawSandboxImage -Image "registry.example/missing:2.0"
if (-not ($script:DockerLog -contains "pull registry.example/missing:2.0")) { throw "Missing ref was not pulled" }
Reset-DockerLog
$failedClosed = $false
try { Ensure-NemoClawSandboxImage -Image "registry.example/unavailable:1.0" } catch { $failedClosed = $true }
if (-not $failedClosed) { throw "Unavailable ref did not fail closed" }
`,
    });
  },
);

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

test("Proxmox non-root offline staging stays wired through setup and the hardware gate", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");
  const proxmoxWorkflow = read(".github/workflows/proxmox-real-hardware.yml");

  assert.match(
    bashSetup,
    /PROXMOX_OFFLINE_STAGE_COMMAND="\$\(read_env_value "\$ENV_FILE" "PROXMOX_OFFLINE_STAGE_COMMAND" ""\)"/,
  );
  assert.match(bashSetup, /^PROXMOX_OFFLINE_STAGE_COMMAND=\$\{PROXMOX_OFFLINE_STAGE_COMMAND\}$/m);
  assert.match(
    powershellSetup,
    /\$PROXMOX_OFFLINE_STAGE_COMMAND = Read-EnvValue .* -Name "PROXMOX_OFFLINE_STAGE_COMMAND" -Default ""/,
  );
  assert.match(powershellSetup, /^PROXMOX_OFFLINE_STAGE_COMMAND=\$PROXMOX_OFFLINE_STAGE_COMMAND$/m);
  assert.match(
    proxmoxWorkflow,
    /PROXMOX_OFFLINE_STAGE_COMMAND: \$\{\{ vars\.PROXMOX_OFFLINE_STAGE_COMMAND \}\}/,
  );
  assert.match(proxmoxWorkflow, /if \[ "\$PROXMOX_SSH_USER" != "root" \]; then/);
  assert.match(proxmoxWorkflow, /required\+=\(PROXMOX_OFFLINE_STAGE_COMMAND\)/);
  assert.match(
    proxmoxWorkflow,
    /PROXMOX_OFFLINE_STAGE_COMMAND must be one absolute helper path without arguments or traversal/,
  );
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

test("bootstrap admin validation is aligned across setup and backend startup", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");
  const bootstrapPolicy = read("backend-api/bootstrapAdmin.ts");
  const server = read("backend-api/server.ts");
  const authRoutes = read("backend-api/routes/auth.ts");

  assert.match(bashSetup, /bootstrap_admin_email_is_valid/);
  assert.match(bashSetup, /bootstrap_admin_password_is_forbidden/);
  assert.match(powershellSetup, /function Test-BootstrapAdminEmail/);
  assert.match(powershellSetup, /function Test-BootstrapAdminPasswordForbidden/);
  assert.match(powershellSetup, /Read-Host \$Prompt -AsSecureString/);
  assert.match(bootstrapPolicy, /looksLikePlaceholderSecret\(password\)/);
  assert.match(bootstrapPolicy, /reason: "invalid_email"/);
  assert.match(bootstrapPolicy, /allowsFirstAdminSignupClaim/);
  assert.match(server, /BOOTSTRAP_ADMIN_CONFIGURATION_INVALID/);
  assert.match(server, /PAAS_BOOTSTRAP_ADMIN_REQUIRED/);
  assert.match(server, /if \(!allowsFirstAdminSignupClaim\(\)\)/);
  assert.match(server, /await seedBootstrapAdminAccount\(\);\s*\n\s*const server = app\.listen/);
  assert.match(authRoutes, /if \(!allowsFirstAdminSignupClaim\(\)\)/);
  assert.match(authRoutes, /PAAS_BOOTSTRAP_ADMIN_REQUIRED/);
  assert.match(bashSetup, /Bootstrap Admin Account \(Required for PaaS\)/);
  assert.match(powershellSetup, /Bootstrap Admin Account \(Required for PaaS\)/);

  runChecked("bash", [
    "-c",
    `set -euo pipefail
     source <(awk '/^bootstrap_admin_email_is_valid\\(\\)/,/^}/' setup.sh)
     source <(awk '/^bootstrap_admin_password_is_forbidden\\(\\)/,/^}/' setup.sh)
     bootstrap_admin_email_is_valid 'operator@example.com'
     ! bootstrap_admin_email_is_valid '<REPLACE_WITH_BOOTSTRAP_ADMIN_EMAIL>'
     ! bootstrap_admin_email_is_valid 'not-an-email'
     ! bootstrap_admin_password_is_forbidden 'StrongRandomPassword-2026!'
     bootstrap_admin_password_is_forbidden 'Admin123-secure'
     bootstrap_admin_password_is_forbidden '🔥Admin123-secure'
     bootstrap_admin_password_is_forbidden '<REPLACE_WITH_STRONG_BOOTSTRAP_PASSWORD>'`,
  ]);
});

test("bootstrap admin dotenv serialization round-trips Compose-sensitive characters", () => {
  const bashSetup = read("setup.sh");
  const powershellSetup = read("setup.ps1");
  assert.match(bashSetup, /compose_env_literal/);
  assert.match(bashSetup, /DEFAULT_ADMIN_PASSWORD=\$\{DEFAULT_ADMIN_PASSWORD_ENV\}/);
  assert.match(powershellSetup, /function ConvertTo-ComposeEnvLiteral/);
  assert.match(powershellSetup, /DEFAULT_ADMIN_PASSWORD=\$DEFAULT_ADMIN_PASSWORD_ENV/);

  const fixtureDir = mkdtempSync(path.join(tmpdir(), "nora-bootstrap-env-"));
  const email = "operator+promo@example.com";
  const passwords = [
    "Strong${MISSING} pa#ss'word\\tail",
    "Strong${MISSING} trailing\\",
    "Strong${MISSING} slash\\'quote",
  ];
  try {
    for (const [index, password] of passwords.entries()) {
      const caseEnvFile = path.join(fixtureDir, `.env.${index}`);
      const caseComposeFile = path.join(fixtureDir, `compose.${index}.yml`);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
error() { printf '%s\\n' "$*" >&2; }
source <(awk '/^compose_env_literal\\(\\)/,/^}/' setup.sh)
source <(awk '/^decode_compose_env_literal\\(\\)/,/^}/' setup.sh)
source <(awk '/^read_env_value\\(\\)/,/^}/' setup.sh)
printf 'DEFAULT_ADMIN_EMAIL=%s\\nDEFAULT_ADMIN_PASSWORD=%s\\n' \
  "$(compose_env_literal "$1")" "$(compose_env_literal "$2")" > "$3"
test "$(read_env_value "$3" DEFAULT_ADMIN_EMAIL '')" = "$1"
test "$(read_env_value "$3" DEFAULT_ADMIN_PASSWORD '')" = "$2"
source <(awk '/^decode_compose_env_literal\\(\\)/,/^}/' scripts/materialize-compose-secrets.sh)
source <(awk '/^read_env_value\\(\\)/,/^}/' scripts/materialize-compose-secrets.sh)
test "$(read_env_value "$3" DEFAULT_ADMIN_PASSWORD '')" = "$2"`,
          "nora-bootstrap-env",
          email,
          password,
          caseEnvFile,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      writeFileSync(
        caseComposeFile,
        [
          "services:",
          "  probe:",
          "    image: alpine:3.20",
          "    env_file:",
          `      - ${path.basename(caseEnvFile)}`,
        ].join("\n") + "\n",
      );
      const compose = spawnSync(
        "docker",
        ["compose", "-f", caseComposeFile, "config", "--format", "json"],
        {
          cwd: fixtureDir,
          encoding: "utf8",
        },
      );
      assert.equal(compose.status, 0, compose.stderr || compose.stdout);
      const rendered = JSON.parse(compose.stdout);
      assert.equal(
        rendered.services.probe.environment.DEFAULT_ADMIN_EMAIL.replaceAll("$$", "$"),
        email,
      );
      assert.equal(
        rendered.services.probe.environment.DEFAULT_ADMIN_PASSWORD.replaceAll("$$", "$"),
        password,
      );
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test(
  "PowerShell bootstrap admin validation rejects placeholders and hides password input",
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
foreach ($name in @("Test-BootstrapAdminEmail", "Test-BootstrapAdminPasswordForbidden", "Read-SecretText", "ConvertTo-ComposeEnvLiteral", "ConvertFrom-ComposeEnvLiteral", "Read-EnvValue")) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (-not $definition) { throw "Missing function $name" }
  Invoke-Expression $definition.Extent.Text
}
if (-not (Test-BootstrapAdminEmail -Value "operator@example.com")) { throw "Valid email rejected" }
if (Test-BootstrapAdminEmail -Value "<REPLACE_WITH_BOOTSTRAP_ADMIN_EMAIL>") { throw "Placeholder email accepted" }
if (-not (Test-BootstrapAdminPasswordForbidden -Value "Admin123-secure")) { throw "Default-derived password accepted" }
if (-not (Test-BootstrapAdminPasswordForbidden -Value "<REPLACE_WITH_STRONG_BOOTSTRAP_PASSWORD>")) { throw "Placeholder password accepted" }
if (Test-BootstrapAdminPasswordForbidden -Value "StrongRandomPassword-2026!") { throw "Strong password rejected" }
if ((Get-Content setup.ps1 -Raw) -notmatch 'Read-Host \\$Prompt -AsSecureString') { throw "Password prompt is not hidden" }
$passwords = @(
  $env:NORA_TEST_BOOTSTRAP_PASSWORD,
  $env:NORA_TEST_BOOTSTRAP_TRAILING_SLASH,
  $env:NORA_TEST_BOOTSTRAP_SLASH_QUOTE
)
foreach ($password in $passwords) {
  $fixture = Join-Path $env:TEMP ("nora-bootstrap-env-" + [guid]::NewGuid().ToString("N") + ".env")
  try {
    @(
      "DEFAULT_ADMIN_EMAIL=$(ConvertTo-ComposeEnvLiteral -Value 'operator+promo@example.com')",
      "DEFAULT_ADMIN_PASSWORD=$(ConvertTo-ComposeEnvLiteral -Value $password)"
    ) | Set-Content -LiteralPath $fixture -Encoding utf8NoBOM
    if ((Read-EnvValue -EnvPath $fixture -Name 'DEFAULT_ADMIN_PASSWORD' -Default '') -cne $password) {
      throw "Compose dotenv password did not round-trip"
    }
  } finally {
    Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue
  }
}`,
      env: {
        ...process.env,
        NORA_TEST_BOOTSTRAP_PASSWORD: "Strong${MISSING} pa#ss'word\\tail",
        NORA_TEST_BOOTSTRAP_TRAILING_SLASH: "Strong${MISSING} trailing\\",
        NORA_TEST_BOOTSTRAP_SLASH_QUOTE: "Strong${MISSING} slash\\'quote",
      },
    });
  },
);

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
    /docker build \\\s*\n\s*-f agent-runtime\/Dockerfile\.openclaw-agent \\\s*\n\s*-t nora-openclaw-agent:local \\\s*\n\s*agent-runtime\//,
    "production deploys must refresh the pinned standard OpenClaw image",
  );
  assert.match(deployWorkflow, /read_deploy_env_value\(\)/);
  assert.match(
    deployWorkflow,
    /enabled_sandbox_profiles="\$\(read_deploy_env_value "\$DEPLOY_ENV_FILE" ENABLED_SANDBOX_PROFILES ""\)"/,
  );
  assert.match(
    deployWorkflow,
    /nemoclaw_sandbox_image="\$\(read_deploy_env_value "\$DEPLOY_ENV_FILE" NEMOCLAW_SANDBOX_IMAGE "ghcr\.io\/solomon2773\/nora-nemoclaw-agent:latest"\)"/,
  );
  assert.doesNotMatch(deployWorkflow, /(?:^|\n)\s*(?:source|\.)\s+"?\$DEPLOY_ENV_FILE"?/);
  const deployNemoBuild = deployWorkflow.match(
    /if \[ "\$nemoclaw_sandbox_image" = "nora-nemoclaw-agent:local" \]; then([\s\S]*?)\n\s*fi/,
  );
  assert.ok(deployNemoBuild, "production deploy must gate the local NemoClaw build exactly");
  assert.match(deployNemoBuild[1], /agent-runtime\/Dockerfile\.nemoclaw-agent/);
  assert.equal(
    (deployWorkflow.match(/agent-runtime\/Dockerfile\.nemoclaw-agent/g) || []).length,
    1,
    "production deploy must not rebuild custom or pinned NemoClaw refs",
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
  const directUpgradeBlock = releaseUpgrade.match(
    /if \[ ! -f setup\.sh \] \|\| \[ "\$\{NORA_UPGRADE_USE_SETUP:-true\}" = "false" \]; then([\s\S]*?)\n\s*fi/,
  );
  assert.ok(directUpgradeBlock, "direct upgrade fallback must remain explicit");
  assert.match(directUpgradeBlock[1], /agent-runtime\/Dockerfile\.openclaw-agent/);
  assert.match(directUpgradeBlock[1], /read_env_setting "\$env_file" ENABLED_SANDBOX_PROFILES/);
  assert.match(directUpgradeBlock[1], /read_env_setting "\$env_file" NEMOCLAW_SANDBOX_IMAGE/);
  assert.match(
    directUpgradeBlock[1],
    /if \[ "\$nemoclaw_sandbox_image" = "nora-nemoclaw-agent:local" \]; then[\s\S]*?agent-runtime\/Dockerfile\.nemoclaw-agent/,
  );
  assert.equal(
    (releaseUpgrade.match(/agent-runtime\/Dockerfile\.nemoclaw-agent/g) || []).length,
    1,
    "direct upgrade must not rebuild custom or pinned NemoClaw refs",
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

test("community response automation acknowledges and escalates every public thread type", () => {
  const workflow = read(".github/workflows/community-response.yml");
  const script = read(".github/workflows/scripts/community-response.mjs");
  const support = read("SUPPORT.md");
  const contributing = read("CONTRIBUTING.md");

  for (const trigger of ["issues:", "pull_request_target:", "discussion:", "schedule:"]) {
    assert.match(workflow, new RegExp(`^  ${trigger}$`, "m"));
  }
  assert.match(workflow, /^ {2}discussions: write$/m);
  assert.match(workflow, /^ {2}issues: write$/m);
  assert.match(workflow, /^ {2}pull-requests: write$/m);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /community-response\.mjs acknowledge/);
  assert.match(workflow, /community-response\.mjs audit/);
  assert.match(script, /nora-community-ack:v1/);
  assert.match(script, /nora-community-reminder:v1/);
  assert.match(script, /REMINDER_AFTER_MS = 12 \* DAY_MS/);
  assert.match(script, /OVERDUE_AFTER_MS = 14 \* DAY_MS/);
  assert.match(script, /addDiscussionComment/);
  assert.match(script, /states: \[OPEN\]/);
  assert.match(script, /pullRequestResponseStart/);
  assert.match(script, /ready_for_review/);
  assert.match(script, /thread\.draft === true/);
  assert.match(script, /issues\/\$\{issue\.number\}\/timeline/);
  assert.match(script, /query NoraDiscussionReplies/);
  assert.match(script, /replies\(first: 100, after: \$cursor\)/);
  assert.match(script, /OWNER", "MEMBER", "COLLABORATOR/);
  assert.match(support, /automated\s+acknowledgement/i);
  assert.match(support, /twelve days/i);
  assert.match(contributing, /automated queue acknowledgement/i);
  assert.match(contributing, /Draft pull requests enter the\s+response queue/i);
  assert.match(contributing, /fourteen-day target/i);
});

test("release image publication is pinned to one resolved commit", () => {
  const workflow = read(".github/workflows/release-docker.yml");
  const workflowHeader = workflow.split("\njobs:", 1)[0];
  const resolveJob = workflow.match(
    /\n {2}resolve-target:\n([\s\S]*?)(?=\n {2}verify-required-ci:\n)/,
  )?.[1];
  const verifyJob = workflow.match(
    /\n {2}verify-required-ci:\n([\s\S]*?)(?=\n {2}publish-images:\n)/,
  )?.[1];
  const publishJob = workflow.match(
    /\n {2}publish-images:\n([\s\S]*?)(?=\n {2}promote-latest:\n)/,
  )?.[1];
  const promoteJob = workflow.match(/\n {2}promote-latest:\n([\s\S]*)$/)?.[1];

  assert.ok(resolveJob, "release workflow must define the target resolution job");
  assert.ok(verifyJob, "release workflow must define the CI verification job");
  assert.ok(publishJob, "release workflow must define the image publication job");
  assert.ok(promoteJob, "release workflow must define the latest-promotion job");
  assert.match(workflowHeader, /^ {2}cancel-in-progress: false$/m);
  assert.doesNotMatch(
    workflowHeader,
    /^ {2}packages: write$/m,
    "package write access must not be granted to every release job",
  );
  assert.doesNotMatch(resolveJob, /^ {6}packages: write$/m);
  assert.doesNotMatch(verifyJob, /^ {6}packages: write$/m);
  assert.match(
    publishJob,
    /^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m,
    "only image publication should receive package write access",
  );
  assert.match(publishJob, /^ {4}environment: container-publish$/m);
  assert.match(
    promoteJob,
    /^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m,
    "latest promotion needs package write access without broadening earlier jobs",
  );
  assert.match(promoteJob, /^ {4}environment: container-publish$/m);
  assert.match(resolveJob, /TARGET_REF: \$\{\{ github\.event\.inputs\.ref \|\| github\.sha \}\}/);
  assert.doesNotMatch(
    resolveJob,
    /run: \|[\s\S]*\$\{\{ github\.event\.inputs\.ref/,
    "workflow-dispatch refs must enter shell only through an environment variable",
  );
  assert.match(resolveJob, /target_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(
    resolveJob,
    /git merge-base --is-ancestor "\$\{target_sha\}" "origin\/\$\{DEFAULT_BRANCH\}"/,
    "tag and manual image publications must remain on default-branch history",
  );
  assert.doesNotMatch(
    resolveJob,
    /run: \|[\s\S]*\$\{\{\s*github\.ref/,
    "event ref data must enter shell only through environment variables",
  );
  assert.match(
    resolveJob,
    /EVENT_TAG: \$\{\{ github\.ref_type == 'tag' && github\.ref_name \|\| '' \}\}/,
  );
  assert.doesNotMatch(resolveJob, /publish_latest/);
  assert.match(
    verifyJob,
    /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: \$\{\{ github\.workflow_sha \}\}/,
    "the CI gate helper must come from the immutable workflow commit",
  );
  assert.doesNotMatch(
    verifyJob,
    /ref: \$\{\{ needs\.resolve-target\.outputs\.ref \}\}/,
    "the CI gate must not reload a moving publish ref",
  );
  assert.match(
    publishJob,
    /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: \$\{\{ needs\.resolve-target\.outputs\.sha \}\}/,
    "image builds must check out the CI-gated target SHA",
  );
  assert.doesNotMatch(
    publishJob,
    /ref: \$\{\{ needs\.resolve-target\.outputs\.ref \}\}/,
    "image builds must not reload a moving publish ref",
  );
  assert.match(
    publishJob,
    /type=raw,value=sha-\$\{\{ needs\.resolve-target\.outputs\.sha \}\}/,
    "the immutable image tag must describe the resolved target SHA",
  );
  assert.match(
    publishJob,
    /org\.opencontainers\.image\.revision=\$\{\{ needs\.resolve-target\.outputs\.sha \}\}/,
    "the image provenance label must describe the resolved target SHA",
  );
  assert.match(resolveJob, /tag: \$\{\{ steps\.sha\.outputs\.tag \}\}/);
  assert.match(publishJob, /Revalidate target provenance before registry write/);
  assert.match(
    publishJob,
    /git fetch --no-tags --force origin[\s\S]*refs\/tags\/\$\{TARGET_TAG\}:refs\/tags\/__nora_publish_target/,
    "semantic image tags must be re-fetched before package write",
  );
  assert.match(
    publishJob,
    /current_tag_sha="\$\(git rev-parse 'refs\/tags\/__nora_publish_target\^\{commit\}'\)"/,
  );
  assert.doesNotMatch(publishJob, /value=latest/);
  assert.doesNotMatch(publishJob, /\{\{is_default_branch\}\}/);
  assert.doesNotMatch(
    publishJob,
    /type=sha(?:,|$)/m,
    "metadata-action must not derive the SHA tag from the workflow event commit",
  );
  assert.match(promoteJob, /^ {4}concurrency:\n {6}group: release-docker-latest$/m);
  assert.match(
    promoteJob,
    /git fetch --no-tags origin[\s\S]*refs\/heads\/\$\{DEFAULT_BRANCH\}:refs\/remotes\/origin\/\$\{DEFAULT_BRANCH\}/,
  );
  assert.match(promoteJob, /default_sha="\$\(git rev-parse "origin\/\$\{DEFAULT_BRANCH\}"\)"/);
  assert.match(promoteJob, /if \[ "\$TARGET_SHA" != "\$default_sha" \]/);
  assert.match(
    promoteJob,
    /docker buildx imagetools create[\s\S]*sha-\$\{TARGET_SHA\}/,
    "latest must be promoted from the already-published immutable SHA tag",
  );
  assert.doesNotMatch(promoteJob, /docker\/build-push-action/);
});

test("release and security workflows pin kubeconform before execution", () => {
  const securityWorkflow = read(".github/workflows/ci-security.yml");
  const helmWorkflow = read(".github/workflows/release-helm.yml");

  for (const [label, workflow] of [
    ["CI Security", securityWorkflow],
    ["Helm release", helmWorkflow],
  ]) {
    assert.match(workflow, /^ {2}KUBECONFORM_VERSION: v0\.7\.0$/m, `${label} pins version`);
    assert.match(
      workflow,
      /^ {2}KUBECONFORM_CHECKSUMS_SHA256: [a-f0-9]{64}$/m,
      `${label} pins the checksum manifest`,
    );
    assert.match(workflow, /curl --retry 3 --retry-all-errors -fsSLo/);
    assert.match(
      workflow,
      /printf '%s[ ]{2}%s\\n' "\$\{KUBECONFORM_CHECKSUMS_SHA256\}"[\s\S]*sha256sum -c -/,
      `${label} verifies the pinned checksum manifest before trusting it`,
    );
    assert.match(workflow, /sha256sum -c -[\s\S]*tar -xzf/);
    assert.match(
      workflow,
      /expected="\$\(awk -v name="\$\{archive\}"[\s\S]*printf '%s[ ]{2}%s\\n' "\$\{expected\}" "\$\{install_dir\}\/\$\{archive\}" \| sha256sum -c -/,
      `${label} verifies the downloaded archive by its absolute install path`,
    );
    assert.doesNotMatch(workflow, /curl[^\n]*\|\s*tar/);
  }

  assert.match(helmWorkflow, /Require the release commit on the default branch/);
  assert.match(
    helmWorkflow,
    /git merge-base --is-ancestor "\$\{TARGET_SHA\}" "origin\/\$\{DEFAULT_BRANCH\}"/,
  );
  assert.match(helmWorkflow, /^ {4}environment: release-publish$/m);
  const helmPublishJob = helmWorkflow.match(/\n {2}publish-chart:\n([\s\S]*)$/)?.[1];
  assert.ok(helmPublishJob, "Helm workflow must define its privileged publisher job");
  assert.match(helmPublishJob, /^ {6}- resolve-target$/m);
  assert.match(helmPublishJob, /^ {6}contents: read$/m);
  assert.match(helmPublishJob, /Revalidate release provenance after environment approval/);
  assert.match(helmPublishJob, /EXPECTED_SHA: \$\{\{ needs\.resolve-target\.outputs\.sha \}\}/);
  assert.match(helmPublishJob, /EXPECTED_TAG: \$\{\{ needs\.resolve-target\.outputs\.tag \}\}/);
});

test("package release workflows gate immutable artifacts before privileged publication", () => {
  const npmWorkflow = read(".github/workflows/release-npm.yml");
  const mcpWorkflow = read(".github/workflows/release-mcp-registry.yml");
  const verifier = read(".github/workflows/scripts/verify-release-target.mjs");
  const qualityWorkflow = read(".github/workflows/ci-quality.yml");
  const npmPublishJob = npmWorkflow.match(/\n {2}publish:\n([\s\S]*)$/)?.[1];
  const mcpPublishJob = mcpWorkflow.match(/\n {2}publish-mcp-registry:\n([\s\S]*)$/)?.[1];
  const installStep = mcpWorkflow.match(
    /- name: Install checksum-verified mcp-publisher\n([\s\S]*?)(?=\n {6}- name: Authenticate to the MCP Registry)/,
  )?.[1];

  assert.ok(npmPublishJob, "npm workflow must define its final publisher job");
  assert.ok(mcpPublishJob, "MCP workflow must define its final publisher job");
  assert.ok(installStep, "MCP Registry workflow must define its publisher install step");
  for (const [label, workflow, publisher] of [
    ["npm", npmWorkflow, npmPublishJob],
    ["MCP", mcpWorkflow, mcpPublishJob],
  ]) {
    const workflowHeader = workflow.split("\njobs:", 1)[0];
    assert.match(workflowHeader, /^ {2}contents: read$/m);
    assert.doesNotMatch(workflowHeader, /id-token: write/);
    assert.match(workflowHeader, /^ {2}cancel-in-progress: false$/m);
    assert.match(workflow, /verify-release-target\.mjs resolve-release/);
    assert.match(workflow, /Wait for required workflows on the exact release SHA/);
    assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.match(workflow, /ref: \$\{\{ needs\.resolve-target\.outputs\.sha \}\}/);
    assert.match(publisher, /^ {4}environment: release-publish$/m);
    assert.match(publisher, /^ {6}id-token: write$/m);
    assert.match(publisher, /Revalidate release provenance after environment approval/);
    assert.match(publisher, /EXPECTED_SHA: \$\{\{ needs\.resolve-target\.outputs\.sha \}\}/);
    assert.match(publisher, /EXPECTED_TAG: \$\{\{ needs\.resolve-target\.outputs\.tag \}\}/);
    assert.match(
      publisher,
      /actions\/download-artifact@[0-9a-f]{40}/,
      `${label} publisher must consume a previously validated artifact`,
    );
  }

  assert.match(npmWorkflow, /npm pack "\$\{package_source\}" --ignore-scripts/);
  assert.match(npmPublishJob, /npm publish "\$\{PACKAGE_TARBALL\}" --ignore-scripts --provenance/);
  assert.doesNotMatch(npmPublishJob, /release-target\//);

  assert.match(mcpWorkflow, /^ {2}MCP_PUBLISHER_VERSION: v1\.7\.9$/m);
  assert.match(
    mcpWorkflow,
    /^ {2}MCP_PUBLISHER_CHECKSUMS_SHA256: [a-f0-9]{64}$/m,
    "the upstream checksum manifest must itself be pinned",
  );
  assert.match(
    installStep,
    /curl --retry 3 --retry-all-errors -fsSLo "\$\{INSTALL_DIR\}\/\$\{archive\}"/,
  );
  assert.match(
    installStep,
    /curl --retry 3 --retry-all-errors -fsSLo "\$\{INSTALL_DIR\}\/\$\{checksums\}"/,
  );
  assert.match(
    installStep,
    /printf '%s[ ]{2}%s\\n' "\$\{MCP_PUBLISHER_CHECKSUMS_SHA256\}"[\s\S]*sha256sum -c -/,
  );
  assert.match(
    installStep,
    /awk -v name="\$\{archive\}"[\s\S]*'\$2 == name \{ print; found=1 \} END \{ if \(!found\) exit 1 \}'[\s\S]*sha256sum -c -/,
    "the selected archive must match one exact checksum-manifest entry",
  );
  assert.match(installStep, /tar -xzf "\$\{archive\}" mcp-publisher/);
  assert.doesNotMatch(installStep, /curl[^\n]*\|\s*tar/);
  assert.ok(
    installStep.indexOf("sha256sum -c -") < installStep.indexOf('tar -xzf "${archive}"'),
    "integrity verification must complete before extraction",
  );

  assert.match(verifier, /releases\/tags\/\$\{encodeURIComponent\(tag\)\}/);
  assert.match(verifier, /branch\.protected !== true/);
  assert.match(verifier, /compare\/\$\{sha\}\.\.\.\$\{defaultBranchSha\}/);
  assert.match(verifier, /EXPECTED_NPM_PACKAGES/);
  assert.match(verifier, /EXPECTED_MCP_NAME = "io\.github\.solomon2773\/nora"/);
  assert.match(
    qualityWorkflow,
    /- "\.github\/workflows\/release-npm\.yml"/,
    "npm release workflow changes must trigger the quality gate",
  );
  assert.match(qualityWorkflow, /- "\.github\/workflows\/release-mcp-registry\.yml"/);
  assert.match(
    qualityWorkflow,
    /node --test \.github\/workflows\/scripts\/verify-release-target\.test\.mjs/,
  );
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
  assert.match(workflow, /^ {2}deployment-policy:$/m);
  assert.match(workflow, /^ {4}needs: deployment-policy$/m);
  assert.match(workflow, /needs\.deployment-policy\.outputs\.should_deploy == 'true'/);
  assert.match(workflow, /Require an exact release tag for automatic deployment/);
  assert.match(workflow, /Revalidate target provenance after approval/);
  assert.match(
    workflow,
    /Deployment target .* is not reachable from \$DEFAULT_BRANCH/,
    "manual and automatic targets must remain on the protected default-branch history",
  );
  assert.match(
    workflow,
    /Automatic deployment target no longer has an exact Nora product release tag/,
  );
  assert.match(workflow, /should_deploy=false/);
  assert.match(workflow, /has no exact Nora product release tag/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.doesNotMatch(workflow, /workflow_run\.head_branch == 'master'/);
  assert.match(
    workflow,
    /refs\/heads\/\$\{DEFAULT_BRANCH\}:refs\/remotes\/origin\/\$\{DEFAULT_BRANCH\}/,
  );
  assert.match(workflow, /git merge-base --is-ancestor HEAD "origin\/\$DEFAULT_BRANCH"/);
  assert.match(workflow, /is not reachable from \$DEFAULT_BRANCH/);
  assert.match(workflow, /remote_version_commit/);
  assert.match(
    workflow,
    /Release tag \$TARGET_VERSION no longer points at target commit \$TARGET_COMMIT/,
  );
  assert.match(workflow, /git checkout --detach "\$TARGET_COMMIT"/);
  assert.match(workflow, /Remote checkout does not match validated target commit \$TARGET_COMMIT/);
  assert.doesNotMatch(workflow, /git pull --ff-only origin "\$DEPLOY_REF"/);
  assert.doesNotMatch(workflow, /DEPLOY_REF/);
  assert.doesNotMatch(workflow, /steps\.target\.outputs\.ref/);
  assert.doesNotMatch(
    workflow,
    /run: \|[\s\S]{0,500}\$\{\{ github\.event\.inputs\.ref/,
    "workflow-dispatch refs must not be interpolated directly into shell",
  );
  const trustedCheckoutIndex = workflow.indexOf("ref: ${{ github.workflow_sha }}");
  const inspectTargetIndex = workflow.indexOf(
    "Inspect the requested deploy target without trusting its scripts",
  );
  const gateIndex = workflow.indexOf(
    "run: node .github/workflows/scripts/require-workflow-success.mjs",
  );
  const sourceCheckoutIndex = workflow.indexOf("Check out the CI-gated deploy source");
  assert.ok(trustedCheckoutIndex >= 0, "deploy gate helper must come from the workflow commit");
  assert.ok(inspectTargetIndex > trustedCheckoutIndex);
  assert.ok(gateIndex > inspectTargetIndex);
  assert.ok(sourceCheckoutIndex > gateIndex);
  assert.match(workflow, /path: \.deploy-target/);
  assert.match(workflow, /working-directory: \.deploy-target/);
  assert.match(
    workflow,
    /Check out the CI-gated deploy source[\s\S]*ref: \$\{\{ steps\.release_meta\.outputs\.commit \}\}/,
  );
  assert.match(workflow, /Version override must be an exact Nora product tag/);
  assert.match(workflow, /Version override must name an existing Nora product tag/);
  assert.match(workflow, /does not point at target commit/);
  assert.doesNotMatch(workflow, /git merge-base --is-ancestor "\$version_commit" HEAD/);
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

    const exactManualProductVersion = runMetadata("v1.16.0");
    assert.equal(
      exactManualProductVersion.result.status,
      0,
      exactManualProductVersion.result.stderr,
    );
    assert.match(exactManualProductVersion.output, /^version=v1\.16\.0$/m);

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
    assert.notEqual(manualProductVersion.result.status, 0);
    assert.match(
      `${manualProductVersion.result.stderr}${manualProductVersion.result.stdout}`,
      /does not point at target commit/,
    );

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
      /does not point at target commit/,
    );
  } finally {
    rmSync(fixtureRepo, { recursive: true, force: true });
  }
});

test("production deploy transports remote configuration as encoded arguments", () => {
  const workflow = read(".github/workflows/deploy-production.yml");
  const deployStepIndex = workflow.indexOf("- name: Deploy on remote host");
  assert.ok(deployStepIndex >= 0, "deploy workflow must define the remote deployment step");
  const deployStep = workflow.slice(deployStepIndex);
  const transported = [
    "DEPLOY_PATH",
    "DEPLOY_ENV_FILE",
    "DEPLOY_COMPOSE_FILES",
    "TARGET_VERSION",
    "TARGET_COMMIT",
    "AUTOMATIC_DEPLOYMENT",
    "DEFAULT_BRANCH",
    "NORA_GITHUB_REPO",
  ];

  assert.match(deployStep, /encode_remote_arg\(\)/);
  assert.match(deployStep, /decode_remote_arg\(\)/);
  assert.match(deployStep, /base64 -w 0/);
  assert.match(deployStep, /base64 --decode/);
  assert.match(deployStep, /if \[ "\$#" -ne 8 \]/);
  for (const name of transported) {
    assert.match(deployStep, new RegExp(`${name}_B64=`));
    assert.match(deployStep, new RegExp(`'\\$${name}_B64'`));
    assert.match(deployStep, new RegExp(`${name}="\\$\\(decode_remote_arg`));
    assert.doesNotMatch(
      deployStep,
      new RegExp(`${name}='\\$${name}'`),
      `${name} must not be interpolated into the remote shell command`,
    );
  }

  const fixture = mkdtempSync(path.join(tmpdir(), "nora-deploy-encoding-"));
  try {
    const marker = path.join(fixture, "injected");
    const hostile = `deploy'; touch ${marker}; #`;
    const encoded = Buffer.from(hostile, "utf8").toString("base64");
    const decoded = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
decoded="$(printf '%s' "$1" | base64 --decode)"
printf '%s' "$decoded"`,
        "nora-deploy-decode",
        encoded,
      ],
      { encoding: "utf8" },
    );
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.equal(decoded.stdout, hostile);
    assert.notEqual(spawnSync("test", ["-e", marker]).status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
