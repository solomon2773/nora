// @ts-nocheck
const ProvisionerBackend = require("./interface");
const { demuxDockerExecStream } = require("./dockerExecStream");
const crypto = require("crypto");
const path = require("path");
const {
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawGatewayPairingCommand,
  buildOpenClawInstallCommand,
  buildOpenClawConfigMergeScript,
  buildOpenClawManagedConfigEnvPruneCommand,
  buildOpenClawManagedMcpServersCommand,
  buildOpenClawManagedProviderStateCommand,
  buildOpenClawCustomProviders,
  buildIntegrationToolWrapperScript,
  buildMcpServerWrapperScript,
  buildRuntimeBootstrapFiles,
  buildTemplatePayloadBootstrapFiles,
  buildRuntimeEnv,
  decodeOpenClawManagedMcpServers,
  OPENCLAW_MANAGED_MCP_SERVERS_ENV,
} = require("../../../agent-runtime/lib/runtimeBootstrap");
const {
  OPENCLAW_GATEWAY_PORT,
  AGENT_RUNTIME_PORT,
} = require("../../../agent-runtime/lib/contracts");
const {
  getStandardDockerAgentImage,
  getStandardDockerPackageSpec,
} = require("../../../agent-runtime/lib/agentImages");
const {
  buildDockerTelemetry,
  buildUnavailableTelemetry,
  DOCKER_CAPABILITIES,
  uptimeFromContainerInfo,
} = require("./telemetry");
const { isDockerPortBindConflict } = require("./dockerPublishedPorts");

const pendingImageBuilds = new Map();
const DEFAULT_AGENT_PIDS_LIMIT = 512;
const DEFAULT_LOCAL_PUBLISH_HOST_IP = "127.0.0.1";
const MANAGED_ENV_ROOT = "/opt/nora-managed-env";
const MANAGED_ENV_STATE_PATH = `${MANAGED_ENV_ROOT}/state.json`;
const MANAGED_ENV_APPLY_PATH = `${MANAGED_ENV_ROOT}/apply.sh`;
const MANAGED_ENV_OPENCLAW_RECONCILE_PATH = `${MANAGED_ENV_ROOT}/reconcile-openclaw.sh`;
const MANAGED_ENV_HERMES_PROFILE_PATH = "/etc/profile.d/nora-managed-env.sh";
const OPENCLAW_STARTUP_PATH = "/opt/openclaw-runtime/start.sh";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPENCLAW_MANAGED_MODEL_PROVIDER_IDS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
  "deepseek",
  "openrouter",
  "together",
  "cohere",
  "xai",
  "moonshot",
  "zai",
  "ollama",
  "minimax",
  "github-copilot",
  "huggingface",
  "cerebras",
  "nvidia",
  "azure-openai-responses",
  "nora-demo",
]);

const MANAGED_ENV_APPLY_BLOCK = Object.freeze([
  "# >>> NORA MANAGED ENV APPLY >>>",
  `if [ -r ${MANAGED_ENV_APPLY_PATH} ]; then . ${MANAGED_ENV_APPLY_PATH} || exit $?; fi`,
  "# <<< NORA MANAGED ENV APPLY <<<",
]);
const MANAGED_ENV_OPENCLAW_RECONCILE_BLOCK = Object.freeze([
  "# >>> NORA MANAGED RUNTIME RECONCILE >>>",
  `if [ -x ${MANAGED_ENV_OPENCLAW_RECONCILE_PATH} ]; then ${MANAGED_ENV_OPENCLAW_RECONCILE_PATH} || exit $?; fi`,
  "# <<< NORA MANAGED RUNTIME RECONCILE <<<",
]);

function normalizeManagedEnvNames(names = []) {
  const normalized = [];
  for (const rawName of Array.isArray(names) ? names : []) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid managed runtime environment variable name: ${name}`);
    }
    if (!normalized.includes(name)) normalized.push(name);
  }
  return normalized;
}

function normalizeManagedEnvValues(envVars = {}) {
  const normalized = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(envVars || {})) {
    const name = String(rawName || "").trim();
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid runtime environment variable name: ${rawName}`);
    }
    const value = String(rawValue ?? "");
    if (value.includes("\0")) {
      throw new Error(`Runtime environment variable ${name} contains a NUL byte`);
    }
    normalized[name] = value;
  }
  return normalized;
}

function normalizeManagedEnvState(value = {}) {
  const managedNames = normalizeManagedEnvNames(value?.managedNames);
  const values = normalizeManagedEnvValues(value?.values);
  return {
    version: 1,
    managedNames: [...new Set(managedNames)].sort(),
    values,
  };
}

function stripCustomProviderSecrets(customProviders = {}) {
  return Object.fromEntries(
    Object.entries(customProviders || {}).map(([providerId, providerConfig]) => {
      const sanitized = { ...(providerConfig || {}) };
      delete sanitized.apiKey;
      delete sanitized.api_key;
      return [providerId, sanitized];
    }),
  );
}

function sanitizeBootstrapGatewayConfig(gatewayConfig = {}) {
  const sanitized = JSON.parse(JSON.stringify(gatewayConfig || {}));
  delete sanitized.env;
  if (sanitized.gateway?.auth && typeof sanitized.gateway.auth === "object") {
    delete sanitized.gateway.auth.password;
    delete sanitized.gateway.auth.token;
  }
  if (sanitized.models?.providers && typeof sanitized.models.providers === "object") {
    for (const provider of Object.values(sanitized.models.providers)) {
      if (provider && typeof provider === "object") delete provider.apiKey;
    }
  }
  if (sanitized.mcpServers && typeof sanitized.mcpServers === "object") {
    for (const server of Object.values(sanitized.mcpServers)) {
      if (server && typeof server === "object") delete server.env;
    }
  }
  return sanitized;
}

function buildManagedEnvApplyScript() {
  return [
    "#!/bin/sh",
    "# Source this file; it intentionally changes only Nora's managed names.",
    `export NORA_MANAGED_ENV_STATE=${JSON.stringify(MANAGED_ENV_STATE_PATH)}`,
    'if [ ! -r "$NORA_MANAGED_ENV_STATE" ]; then unset NORA_MANAGED_ENV_STATE; return 0 2>/dev/null || exit 0; fi',
    // Render into a temp file first rather than piping this heredoc straight into
    // `node <<'EOF' ... EOF)`: nesting a heredoc inside `$(...)` trips the lexer on
    // some /bin/sh implementations (observed: bash 3.2), which misparses quotes in
    // the heredoc body and fails with "unexpected EOF while looking for matching '".
    'nora_managed_env_render="$(mktemp)" || return $?',
    "cat <<'__NORA_RENDER_MANAGED_ENV__' > \"$nora_managed_env_render\"",
    "const fs = require('fs');",
    "const statePath = process.env.NORA_MANAGED_ENV_STATE;",
    "const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));",
    "const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;",
    "const names = Array.isArray(state.managedNames) ? state.managedNames : [];",
    "const values = state && state.values && typeof state.values === 'object' && !Array.isArray(state.values) ? state.values : {};",
    'const quote = (value) => "\'" + String(value).replace(/\'/g, "\'\\"\'\\"\'") + "\'";',
    "for (const name of names) {",
    "  if (!validName.test(String(name))) throw new Error('Invalid Nora managed environment name');",
    "  process.stdout.write('unset ' + name + '\\n');",
    "}",
    "for (const [name, value] of Object.entries(values)) {",
    "  if (!validName.test(name)) throw new Error('Invalid Nora managed environment name');",
    "  process.stdout.write('export ' + name + '=' + quote(value) + '\\n');",
    "}",
    "__NORA_RENDER_MANAGED_ENV__",
    'nora_managed_env_commands="$(node "$nora_managed_env_render")" || { rm -f "$nora_managed_env_render"; return $?; }',
    'rm -f "$nora_managed_env_render"',
    'eval "$nora_managed_env_commands"',
    "unset nora_managed_env_commands NORA_MANAGED_ENV_STATE nora_managed_env_render",
    "",
  ].join("\n");
}

function ensureOpenClawManagedStartupHooks(source) {
  let script = String(source || "");
  if (!script.trim()) throw new Error("OpenClaw startup script is empty");

  if (!script.includes(MANAGED_ENV_APPLY_BLOCK[0])) {
    const firstNewline = script.indexOf("\n");
    const insertion = `${MANAGED_ENV_APPLY_BLOCK.join("\n")}\n`;
    script =
      firstNewline >= 0
        ? `${script.slice(0, firstNewline + 1)}${insertion}${script.slice(firstNewline + 1)}`
        : `${script}\n${insertion}`;
  }

  if (!script.includes(MANAGED_ENV_OPENCLAW_RECONCILE_BLOCK[0])) {
    const lines = script.split("\n");
    let index = lines.findIndex((line) => line.includes("/opt/openclaw-runtime/lib/agent.ts"));
    if (index < 0) {
      index = lines.findIndex((line) => /exec .*gateway/.test(line));
    }
    if (index < 0) {
      throw new Error("Could not locate the OpenClaw launch boundary for managed reconciliation");
    }
    lines.splice(index, 0, ...MANAGED_ENV_OPENCLAW_RECONCILE_BLOCK);
    script = lines.join("\n");
  }

  return script;
}

function loadDockerCtor() {
  return require(
    require.resolve("dockerode", {
      paths: [__dirname, process.cwd(), path.resolve(__dirname, "../../../backend-api")],
    }),
  );
}

function loadTarStream() {
  return require(
    require.resolve("tar-stream", {
      paths: [__dirname, process.cwd(), path.resolve(__dirname, "../../../backend-api")],
    }),
  );
}

function throwIfAborted(abortSignal, stage = "docker create") {
  if (!abortSignal?.aborted) return;
  const reason =
    abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error(
          typeof abortSignal.reason === "string" && abortSignal.reason
            ? abortSignal.reason
            : `${stage} aborted`,
        );
  throw reason;
}

function isDockerNotFound(error) {
  return (
    error?.statusCode === 404 || /no such container|not found/i.test(String(error?.message || ""))
  );
}

function safeContainerName(prefix, name, id) {
  const suffix =
    String(id || Date.now().toString(36))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(-12) || "agent";
  const maxSlugLength = Math.max(8, 63 - prefix.length - suffix.length - 2);
  const slug =
    String(name || "agent")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, maxSlugLength) || "agent";
  return `${prefix}-${slug}-${suffix}`;
}

class DockerBackend extends ProvisionerBackend {
  constructor() {
    super();
    const Docker = loadDockerCtor();
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
    this._composeNetwork = null; // cached
  }

  // Local Docker ports are intentionally host-loopback-only by default. An
  // operator can opt into another concrete host interface for a standalone
  // install, while remote Docker overrides this hook because its published
  // ports must be reachable across the registered host network.
  _publishedPortHostIp() {
    const configured = String(process.env.DOCKER_AGENT_BIND_IP || "").trim();
    if (!configured) return DEFAULT_LOCAL_PUBLISH_HOST_IP;

    const net = require("node:net");
    if (net.isIP(configured)) return configured;

    console.warn(
      `[docker] Ignoring invalid DOCKER_AGENT_BIND_IP=${configured}; using ${DEFAULT_LOCAL_PUBLISH_HOST_IP}`,
    );
    return DEFAULT_LOCAL_PUBLISH_HOST_IP;
  }

  async isHostPortBound(port, { ignoreContainerName } = {}) {
    const candidate = Number(port);
    if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) return false;

    const ignoredName = String(ignoreContainerName || "").trim();
    const containers = await this.docker.listContainers({ all: false });
    return containers.some((container) => {
      const names = Array.isArray(container?.Names)
        ? container.Names.map((name) => String(name || "").replace(/^\//, ""))
        : [];
      if (ignoredName && names.includes(ignoredName)) return false;
      return Array.isArray(container?.Ports)
        ? container.Ports.some((binding) => Number(binding?.PublicPort) === candidate)
        : false;
    });
  }

  /**
   * Find the Docker Compose-managed network so agent containers can communicate
   * with backend-api and other platform services.
   *
   * Three strategies tried in order — the first match wins:
   *   1. Self-inspect via HOSTNAME / /etc/hostname (container ID)
   *   2. Find worker-provisioner container via Compose service label
   *   3. Scan all networks for a Compose-labelled *_default network
   */
  async _findComposeNetwork() {
    if (this._composeNetwork) return this._composeNetwork;

    // Strategy 1: self-inspect via container ID from hostname
    try {
      const fs = require("fs");
      const hostname =
        (process.env.HOSTNAME || "").trim() || fs.readFileSync("/etc/hostname", "utf8").trim();
      if (hostname) {
        const self = this.docker.getContainer(hostname);
        const info = await self.inspect();
        const nets = info.NetworkSettings?.Networks || {};
        const composeName = Object.keys(nets).find((n) => n.endsWith("_default"));
        if (composeName) {
          this._composeNetwork = composeName;
          console.log(`[docker] Using Compose network (self-inspect): ${composeName}`);
          return this._composeNetwork;
        }
      }
    } catch {
      // Not running inside Docker or can't self-inspect — fall through
    }

    // Strategy 2: find our own container via Compose service label
    try {
      const containers = await this.docker.listContainers({
        filters: { label: ["com.docker.compose.service=worker-provisioner"] },
      });
      if (containers.length > 0) {
        const info = await this.docker.getContainer(containers[0].Id).inspect();
        const nets = info.NetworkSettings?.Networks || {};
        const composeName = Object.keys(nets).find((n) => n.endsWith("_default"));
        if (composeName) {
          this._composeNetwork = composeName;
          console.log(`[docker] Using Compose network (service label): ${composeName}`);
          return this._composeNetwork;
        }
      }
    } catch {
      // Docker API error — fall through
    }

    // Strategy 3: scan all networks for a Compose-labelled *_default network
    try {
      const networks = await this.docker.listNetworks();
      const net = networks.find(
        (n) =>
          n.Name.endsWith("_default") && n.Labels?.["com.docker.compose.network"] === "default",
      );
      if (net) {
        this._composeNetwork = net.Name;
        console.log(`[docker] Using Compose network (label scan): ${net.Name}`);
      }
    } catch {
      console.warn("[docker] Failed to scan networks");
    }
    return this._composeNetwork;
  }

  async _ensureDefaultAgentImage(imgName, { abortSignal } = {}) {
    try {
      await this.docker.getImage(imgName).inspect();
      console.log(`[docker] Image ${imgName} already present`);
      return;
    } catch {
      // Build the local Nora image on demand the first time a standard Docker
      // agent is provisioned.
    }

    if (pendingImageBuilds.has(imgName)) {
      console.log(`[docker] Awaiting in-progress build for ${imgName}`);
      await pendingImageBuilds.get(imgName);
      throwIfAborted(abortSignal, `image build for ${imgName}`);
      return;
    }

    console.log(`[docker] Building prebaked Nora agent image ${imgName}...`);
    const buildPromise = (async () => {
      const tar = require("tar-stream");
      const pack = tar.pack();
      const dockerfile = [
        "FROM node:24-slim",
        "RUN apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null 2>&1 && \\",
        `    npm install -g ${getStandardDockerPackageSpec()} tsx@4.21.0 >/tmp/openclaw-install.log 2>&1 && \\`,
        "    /usr/local/bin/openclaw --version >/dev/null 2>&1 && \\",
        "    rm -f /tmp/openclaw-install.log && \\",
        "    apt-get clean && rm -rf /var/lib/apt/lists/*",
        "ENV OPENCLAW_CLI_PATH=/usr/local/bin/openclaw",
        "ENV OPENCLAW_TSX_BIN=/usr/local/bin/tsx",
        "WORKDIR /root",
        'CMD ["openclaw", "--version"]',
        "",
      ].join("\n");

      const buildContext = await new Promise((resolve, reject) => {
        const chunks = [];
        pack.on("data", (chunk) => chunks.push(chunk));
        pack.on("end", () => resolve(Buffer.concat(chunks)));
        pack.on("error", reject);
        pack.entry({ name: "Dockerfile", mode: 0o644 }, dockerfile, (err) => {
          if (err) return reject(err);
          pack.finalize();
        });
      });

      const stream = await this.docker.buildImage(buildContext, {
        t: imgName,
        dockerfile: "Dockerfile",
        pull: true,
      });

      await new Promise((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err) => (err ? reject(err) : resolve()),
          (event) => {
            if (event?.stream) {
              const line = String(event.stream).trim();
              if (line) console.log(`[docker-build] ${line}`);
            }
          },
        );
      });
    })();

    pendingImageBuilds.set(imgName, buildPromise);
    try {
      await buildPromise;
      throwIfAborted(abortSignal, `image build for ${imgName}`);
    } finally {
      if (pendingImageBuilds.get(imgName) === buildPromise) {
        pendingImageBuilds.delete(imgName);
      }
    }
  }

  _buildBootstrapFiles({ gatewayConfig, buildAuthScript, templatePayload }) {
    const sanitizedGatewayConfig = sanitizeBootstrapGatewayConfig(gatewayConfig);
    const runtimeFiles = buildRuntimeBootstrapFiles().map(({ relPath, source }) => ({
      name: `opt/openclaw-runtime/lib/${relPath}`,
      content: source,
      mode: 0o644,
    }));
    const templateFiles = buildTemplatePayloadBootstrapFiles(templatePayload);

    const startupScript = [
      "#!/bin/sh",
      ...MANAGED_ENV_APPLY_BLOCK,
      "set -eu",
      buildOpenClawInstallCommand([getStandardDockerPackageSpec()]),
      "mkdir -p ~/.openclaw/devices",
      ...buildOpenClawConfigMergeScript(sanitizedGatewayConfig),
      buildOpenClawGatewayPairingCommand(),
      "mkdir -p /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent",
      "touch /var/log/openclaw-agent.log",
      ...MANAGED_ENV_OPENCLAW_RECONCILE_BLOCK,
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 &',
      "if [ ! -f /root/.openclaw/agents/main/agent/auth-profiles.json ]; then",
      '  "$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/build-auth.js',
      "fi",
      buildOpenClawAuthImportFromFileCommand({ requireCli: true }),
      `exec "$OPENCLAW_BIN" gateway --port ${OPENCLAW_GATEWAY_PORT}`,
      "",
    ].join("\n");

    return [
      ...runtimeFiles,
      ...templateFiles,
      {
        name: "usr/local/bin/nora-integration-tool",
        content: buildIntegrationToolWrapperScript(),
        mode: 0o755,
      },
      {
        name: "usr/local/bin/nora-mcp-server",
        content: buildMcpServerWrapperScript(),
        mode: 0o755,
      },
      {
        name: "opt/openclaw-runtime/lib/build-auth.js",
        content: buildAuthScript,
        mode: 0o644,
      },
      {
        name: "opt/openclaw-runtime/start.sh",
        content: startupScript,
        mode: 0o755,
      },
    ];
  }

  async _putBootstrapFiles(container, files) {
    const tar = loadTarStream();
    const pack = tar.pack();
    const directories = new Set(["opt", "opt/openclaw-runtime", "opt/openclaw-runtime/lib"]);

    for (const file of files) {
      let currentDir = path.posix.dirname(file.name);
      while (currentDir && currentDir !== "." && currentDir !== "/") {
        directories.add(currentDir);
        currentDir = path.posix.dirname(currentDir);
        if (currentDir === ".") break;
      }
    }

    const chunks = [];
    const archivePromise = new Promise((resolve, reject) => {
      pack.on("data", (chunk) => chunks.push(chunk));
      pack.on("end", () => resolve(Buffer.concat(chunks)));
      pack.on("error", reject);
    });
    const addEntry = (header, content) =>
      new Promise((resolve, reject) => {
        const done = (err) => (err ? reject(err) : resolve());
        if (typeof content === "undefined") {
          pack.entry(header, done);
          return;
        }
        pack.entry(header, content, done);
      });

    for (const dir of [...directories].sort((a, b) => a.length - b.length)) {
      await addEntry({ name: dir, type: "directory", mode: 0o755 });
    }

    for (const file of files) {
      await addEntry(
        {
          name: file.name,
          mode: file.mode || 0o644,
          ...(Number.isInteger(file.uid) ? { uid: file.uid } : {}),
          ...(Number.isInteger(file.gid) ? { gid: file.gid } : {}),
        },
        file.content,
      );
    }

    pack.finalize();
    const archive = await archivePromise;
    await container.putArchive(archive, { path: "/" });
  }

  async _readContainerFile(container, filePath) {
    const archive = await container.getArchive({ path: filePath });
    const tar = loadTarStream();
    const extract = tar.extract();
    return new Promise((resolve, reject) => {
      let found = false;
      extract.on("entry", (header, stream, next) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("error", reject);
        stream.on("end", () => {
          if (!found && header?.type !== "directory") {
            found = true;
            resolve(Buffer.concat(chunks).toString("utf8"));
          }
          next();
        });
        stream.resume();
      });
      extract.on("finish", () => {
        if (!found) reject(new Error(`Container file ${filePath} was not present in its archive`));
      });
      extract.on("error", reject);
      archive.on("error", reject);
      archive.pipe(extract);
    });
  }

  async _readManagedEnvState(container) {
    try {
      const source = await this._readContainerFile(container, MANAGED_ENV_STATE_PATH);
      return normalizeManagedEnvState(JSON.parse(source));
    } catch (error) {
      if (
        isDockerNotFound(error) ||
        /not present|no such file/i.test(String(error?.message || ""))
      ) {
        return normalizeManagedEnvState();
      }
      throw error;
    }
  }

  _managedOpenClawConfigPaths() {
    return {
      configPath: "/root/.openclaw/openclaw.json",
      markerPath: "/root/.openclaw/.nora-managed-default-model",
    };
  }

  async _managedEnvFileOwnership(_container) {
    return {};
  }

  async _initialManagedEnvFileOwnership(_container) {
    return {};
  }

  async _containerUserOwnership(container, username) {
    const passwd = await this._readContainerFile(container, "/etc/passwd");
    const fields = passwd
      .split("\n")
      .find((line) => line.startsWith(`${username}:`))
      ?.split(":");
    const uid = Number(fields?.[2]);
    const gid = Number(fields?.[3]);
    if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
      throw new Error(`Container image is missing the required ${username} runtime user`);
    }
    return { uid, gid };
  }

  _buildOpenClawManagedReconcileScript(state) {
    const { configPath, markerPath } = this._managedOpenClawConfigPaths();
    const managedNames = new Set(state.managedNames);
    const shouldManageProviderConfig = [
      "MICROSOFT_FOUNDRY_API_KEY",
      "MICROSOFT_FOUNDRY_BASE_URL",
      "MICROSOFT_FOUNDRY_API_VERSION",
      "MICROSOFT_FOUNDRY_DEPLOYMENT",
      "NORA_DEMO_LLM_TOKEN",
      "NORA_DEMO_LLM_BASE_URL",
      "NORA_DEFAULT_OPENCLAW_MODEL",
    ].some((name) => managedNames.has(name));
    const providerStateCommand = shouldManageProviderConfig
      ? buildOpenClawManagedProviderStateCommand({
          customProviders: stripCustomProviderSecrets(buildOpenClawCustomProviders(state.values)),
          defaultModel: state.values.NORA_DEFAULT_OPENCLAW_MODEL || null,
          managedModelProviderIds: OPENCLAW_MANAGED_MODEL_PROVIDER_IDS,
          configPath,
          markerPath,
        })
      : "true";
    const mcpStateCommand = managedNames.has(OPENCLAW_MANAGED_MCP_SERVERS_ENV)
      ? buildOpenClawManagedMcpServersCommand(
          decodeOpenClawManagedMcpServers(state.values[OPENCLAW_MANAGED_MCP_SERVERS_ENV] || ""),
          { configPath },
        )
      : "true";

    return [
      "#!/bin/sh",
      "set -eu",
      buildOpenClawManagedConfigEnvPruneCommand([...state.managedNames, "OPENCLAW_GATEWAY_TOKEN"], {
        configPath,
      }),
      providerStateCommand,
      mcpStateCommand,
      "if [ -f /opt/openclaw-runtime/lib/build-auth.js ]; then",
      '  "$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/build-auth.js',
      "fi",
      "",
    ].join("\n");
  }

  async updateEnv(containerId, envVars = {}, options = {}) {
    const entries = normalizeManagedEnvValues(envVars);
    const requestedManagedNames = normalizeManagedEnvNames(options?.managedEnvNames);
    if (Object.keys(entries).length === 0 && requestedManagedNames.length === 0) return;

    const container = this.docker.getContainer(containerId);
    // create() calls this after uploading the bootstrap archive but before the
    // container's first start. No prior managed state can exist on that path,
    // and the uploaded startup script already contains the managed hooks, so
    // avoid reading either file back over Docker (or Remote Docker over SSH).
    const initializeManagedState = options?.initializeManagedState === true;
    const previous = initializeManagedState
      ? normalizeManagedEnvState()
      : await this._readManagedEnvState(container);
    const replaceManagedState = options?.replaceManagedState === true;
    const managedNames = new Set(previous.managedNames);
    const values = Object.assign(Object.create(null), previous.values);

    for (const name of requestedManagedNames) {
      managedNames.add(name);
      if (replaceManagedState) delete values[name];
    }
    for (const [name, value] of Object.entries(entries)) {
      values[name] = value;
    }

    const state = normalizeManagedEnvState({ managedNames: [...managedNames], values });
    const managedFileOwnership = initializeManagedState
      ? await this._initialManagedEnvFileOwnership(container)
      : await this._managedEnvFileOwnership(container);
    const files = [
      {
        name: MANAGED_ENV_STATE_PATH.replace(/^\//, ""),
        content: `${JSON.stringify(state)}\n`,
        mode: 0o600,
        ...managedFileOwnership,
      },
      {
        name: MANAGED_ENV_APPLY_PATH.replace(/^\//, ""),
        content: buildManagedEnvApplyScript(),
        mode: 0o700,
        ...managedFileOwnership,
      },
    ];

    if (String(options?.runtimeFamily || "openclaw").toLowerCase() === "hermes") {
      files.push({
        name: MANAGED_ENV_HERMES_PROFILE_PATH.replace(/^\//, ""),
        content: [
          "# Nora exact managed environment replacement for Hermes login startup.",
          `if [ -r ${MANAGED_ENV_APPLY_PATH} ]; then . ${MANAGED_ENV_APPLY_PATH} || return $?; fi`,
          "",
        ].join("\n"),
        mode: 0o644,
      });
    } else {
      files.push({
        name: MANAGED_ENV_OPENCLAW_RECONCILE_PATH.replace(/^\//, ""),
        content: this._buildOpenClawManagedReconcileScript(state),
        mode: 0o700,
        ...managedFileOwnership,
      });
      if (!initializeManagedState) {
        const currentStartup = await this._readContainerFile(container, OPENCLAW_STARTUP_PATH);
        files.push({
          name: OPENCLAW_STARTUP_PATH.replace(/^\//, ""),
          content: ensureOpenClawManagedStartupHooks(currentStartup),
          mode: 0o755,
          ...managedFileOwnership,
        });
      }
    }

    await this._putBootstrapFiles(container, files);
    console.log(
      `[docker] Replaced ${requestedManagedNames.length} managed env name(s) for container ${containerId}`,
    );
  }

  async create(config) {
    const {
      id,
      name,
      image,
      vcpu,
      ram_mb,
      disk_gb,
      env,
      container_name,
      templatePayload,
      credentialManagedEnvNames = [],
      abortSignal,
      gatewayHostPort: allocatedGatewayPort,
      runtimeHostPort: allocatedRuntimePort,
    } = config;
    const containerName = container_name || safeContainerName("nora-oclaw", name, id);
    let container = null;

    const defaultImage = getStandardDockerAgentImage();
    const imgName = image || defaultImage;
    console.log(`[docker] Creating container ${containerName} from ${imgName}`);
    throwIfAborted(abortSignal, `docker create for ${containerName}`);

    if (imgName === defaultImage) {
      await this._ensureDefaultAgentImage(imgName, { abortSignal });
    } else {
      // Pull explicit images if they are not already present locally.
      try {
        await this.docker.getImage(imgName).inspect();
        console.log(`[docker] Image ${imgName} already present`);
      } catch {
        console.log(`[docker] Pulling image ${imgName}...`);
        await new Promise((resolve, reject) => {
          this.docker.pull(imgName, (err, stream) => {
            if (err) return reject(err);
            this.docker.modem.followProgress(stream, (err) => {
              if (err) return reject(err);
              console.log(`[docker] Image ${imgName} pulled successfully`);
              resolve();
            });
          });
        });
      }
    }
    throwIfAborted(abortSignal, `docker create for ${containerName}`);

    // Remove any existing container with the same name (orphaned from prior deploy)
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      console.log(
        `[docker] Removing orphaned container ${info.Id.slice(0, 12)} (${containerName})`,
      );
      try {
        await existing.stop({ t: 5 });
      } catch {
        /* already stopped */
      }
      await existing.remove({ force: true });
    } catch {
      // No existing container — expected path
    }

    // Generate per-agent Gateway auth token (32 bytes = 256 bits of entropy)
    const gatewayToken = crypto.randomBytes(32).toString("hex");

    // Convert env object to array of KEY=VALUE + inject runtime/gateway contract vars.
    // Dockerode's `Env:` replaces the image's ENV rather than merging, so we
    // always declare the openclaw + tsx binary paths explicitly — the bootstrap
    // fast-path check won't find them otherwise. The Nora OpenClaw agent image
    // installs under `/usr/local/bin` (npm global prefix of node:24-slim).
    const envArray = Object.entries({
      ...buildRuntimeEnv(),
      OPENCLAW_CLI_PATH: "/usr/local/bin/openclaw",
      OPENCLAW_TSX_BIN: "/usr/local/bin/tsx",
    }).map(([k, v]) => `${k}=${v}`);

    // Build auth-profiles.json from any LLM API keys in env
    const llmKeyMap = {
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      GEMINI_API_KEY: "google",
      GROQ_API_KEY: "groq",
      MISTRAL_API_KEY: "mistral",
      DEEPSEEK_API_KEY: "deepseek",
      OPENROUTER_API_KEY: "openrouter",
      TOGETHER_API_KEY: "together",
      COHERE_API_KEY: "cohere",
      XAI_API_KEY: "xai",
      MOONSHOT_API_KEY: "moonshot",
      ZAI_API_KEY: "zai",
      OLLAMA_API_KEY: "ollama",
      MINIMAX_API_KEY: "minimax",
      COPILOT_GITHUB_TOKEN: "github-copilot",
      HF_TOKEN: "huggingface",
      CEREBRAS_API_KEY: "cerebras",
      NVIDIA_API_KEY: "nvidia",
      MICROSOFT_FOUNDRY_API_KEY: "microsoft-foundry",
      // Zero-key demo stub (custom provider nora-demo). Deliberately LAST so a
      // real provider key wins the first-configured default-model heuristic.
      NORA_DEMO_LLM_TOKEN: "nora-demo",
    };
    // Dynamic auth-profiles builder: a node script written into the container
    // before first boot. Because it reads env vars at runtime (not creation time),
    // it stays correct on every restart — even after keys were injected post-creation.
    const buildAuthScript =
      `var m=${JSON.stringify(llmKeyMap)},f={MICROSOFT_FOUNDRY_API_KEY:"MICROSOFT_FOUNDRY_BASE_URL"},av={MICROSOFT_FOUNDRY_API_KEY:"MICROSOFT_FOUNDRY_API_VERSION"},s={version:1,profiles:{},order:{},lastGood:{}};` +
      `Object.entries(m).forEach(function(e){` +
      `var envKey=e[0],provider=e[1],key=process.env[envKey];` +
      `if(!key)return;` +
      `var profileId=provider+":default";` +
      `s.profiles[profileId]={type:"api_key",provider:provider,key:key};` +
      `if(f[envKey]&&process.env[f[envKey]])s.profiles[profileId].endpoint=process.env[f[envKey]];` +
      `if(av[envKey]&&process.env[av[envKey]])s.profiles[profileId].api_version=process.env[av[envKey]];` +
      `s.order[provider]=[profileId];` +
      `s.lastGood[provider]=profileId;` +
      `});` +
      `require("fs").mkdirSync("/root/.openclaw/agents/main/agent",{recursive:true});` +
      `require("fs").writeFileSync("/root/.openclaw/agents/main/agent/auth-profiles.json",JSON.stringify(s));` +
      `require("fs").chmodSync("/root/.openclaw/agents/main/agent/auth-profiles.json",0o600);`;

    // Use the port the worker reserved for this agent's host (collision-safe,
    // BYOC Phase B). Fall back to the legacy deterministic hash only if no
    // allocation was passed (older callers / safety net).
    const allocatedPort = Number(allocatedGatewayPort);
    const hostPort =
      Number.isInteger(allocatedPort) && allocatedPort >= 1 && allocatedPort <= 65535
        ? allocatedPort
        : 19000 + ((parseInt(id.replace(/\D/g, "").slice(0, 4)) || 0) % 1000);
    const allocatedRuntimePortNumber = Number(allocatedRuntimePort);
    const runtimeHostPort =
      Number.isInteger(allocatedRuntimePortNumber) &&
      allocatedRuntimePortNumber >= 1 &&
      allocatedRuntimePortNumber <= 65535
        ? allocatedRuntimePortNumber
        : null;
    const publishedPortHostIp = this._publishedPortHostIp(config);
    const allowedOrigins = new Set([
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "https://localhost:8080",
      "http://localhost:18789",
      "http://127.0.0.1:18789",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      `http://localhost:${hostPort}`,
      `http://127.0.0.1:${hostPort}`,
    ]);

    const addAllowedOrigin = (value) => {
      if (!value) return;
      try {
        allowedOrigins.add(new URL(value).origin);
      } catch (_) {
        // Ignore malformed values in optional public URL env vars.
      }
    };

    addAllowedOrigin(process.env.NEXTAUTH_URL);
    for (const origin of (process.env.CORS_ORIGINS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      addAllowedOrigin(origin);
    }

    const gatewayConfig = {
      gateway: {
        bind: "lan",
        mode: "local",
        reload: { mode: "hot" },
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: {
          allowedOrigins: [...allowedOrigins],
        },
      },
    };
    const bootstrapFiles = this._buildBootstrapFiles({
      gatewayConfig,
      buildAuthScript,
      templatePayload,
    });
    // Pin Entrypoint + Cmd so a future base-image that adds ENTRYPOINT can't
    // prepend a second interpreter (see agent-runtime/lib/containerCommand.ts
    // for the nemoclaw/k8s/hermes variants of the same contract).
    const launch = {
      Entrypoint: ["/bin/sh"],
      Cmd: ["/opt/openclaw-runtime/start.sh"],
    };

    // Docker agents now boot through an injected startup script instead of a
    // giant inline shell string. That keeps bootstrap semantics predictable and
    // avoids losing the install step inside long `sh -c` command payloads.

    // Resolve the Compose network for cross-service communication
    const composeNetwork = await this._findComposeNetwork();
    const networkingConfig = {};
    if (composeNetwork) {
      networkingConfig[composeNetwork] = {};
    }

    // Derive a DNS-safe hostname from the agent name (lowercase, alphanumeric + hyphens, max 63 chars).
    // This controls the container's /etc/hostname and avoids Bonjour name-conflict warnings
    // (e.g. "gateway hostname conflict resolved") when multiple agents run on the same host.
    const safeHostname =
      (name || containerName)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 63) || `agent-${id}`;

    const volumeName = `nora_agent_state_${id}`;
    // The agent's real state root. Without this, /root/.openclaw lives on the
    // container writable layer and is lost whenever the container is
    // recreated (image update, redeploy) — the /mnt volume only covers the
    // integration-tool state dir.
    const homeVolumeName = `nora_agent_home_${id}`;
    for (const volume of [volumeName, homeVolumeName]) {
      try {
        await this.docker.createVolume({ Name: volume });
      } catch (e) {
        if (!String(e.message).includes("already exists")) throw e;
      }
    }

    try {
      throwIfAborted(abortSignal, `docker create for ${containerName}`);
      container = await this.docker.createContainer({
        Image: imgName,
        name: containerName,
        Hostname: safeHostname,
        Env: envArray,
        ...launch,
        WorkingDir: "/root",
        ExposedPorts: { "18789/tcp": {}, "9090/tcp": {} },
        HostConfig: {
          // CPU: vcpu cores -> NanoCPUs
          NanoCpus: (vcpu || 2) * 1e9,
          // Memory in bytes
          Memory: (ram_mb || 2048) * 1024 * 1024,
          // Restart policy
          RestartPolicy: { Name: "unless-stopped" },
          // Standard agents do not need ambient Linux capabilities. Bound the
          // process tree as well so a runaway tool cannot exhaust host PIDs.
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: DEFAULT_AGENT_PIDS_LIMIT,
          // Publish gateway port for direct browser access (control UI).
          // Use a deterministic port based on agent ID to survive container restarts.
          PortBindings: {
            "18789/tcp": [{ HostIp: publishedPortHostIp, HostPort: String(hostPort) }],
            ...(runtimeHostPort
              ? {
                  "9090/tcp": [{ HostIp: publishedPortHostIp, HostPort: String(runtimeHostPort) }],
                }
              : {}),
          },
          // DNS servers for internet access from within the container
          Dns: ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
          Binds: [`${volumeName}:/mnt/nora-agent-state`, `${homeVolumeName}:/root/.openclaw`],
        },
        NetworkingConfig: composeNetwork
          ? {
              EndpointsConfig: networkingConfig,
            }
          : undefined,
        Labels: {
          "openclaw.agent.id": String(id),
          "openclaw.agent.name": name || "",
          "openclaw.gateway.port": String(OPENCLAW_GATEWAY_PORT),
          "openclaw.runtime.port": String(AGENT_RUNTIME_PORT),
        },
      });

      throwIfAborted(abortSignal, `docker bootstrap for ${containerName}`);
      await this._putBootstrapFiles(container, bootstrapFiles);
      // User/provider/integration values must never enter immutable Docker
      // Config.Env. Stage them in Nora's owner-only managed state while the
      // container is still stopped; the startup hook applies the exact set
      // before auth/config bootstrap and gateway launch.
      await this.updateEnv(
        container.id,
        { ...(env || {}), OPENCLAW_GATEWAY_TOKEN: gatewayToken },
        {
          managedEnvNames: credentialManagedEnvNames,
          replaceManagedState: true,
          initializeManagedState: true,
          runtimeFamily: "openclaw",
        },
      );
      throwIfAborted(abortSignal, `docker start for ${containerName}`);
      await container.start();

      // Connect to bridge network for internet access (in addition to compose network)
      try {
        const bridgeNet = this.docker.getNetwork("bridge");
        await bridgeNet.connect({ Container: container.id });
        console.log(`[docker] Connected container to bridge network for internet access`);
      } catch (e) {
        console.warn(`[docker] Could not connect to bridge network: ${e.message}`);
      }

      // Get the IP on the Compose network (preferred) or default bridge
      const info = await container.inspect();
      let host = "localhost";
      if (composeNetwork && info.NetworkSettings?.Networks?.[composeNetwork]) {
        host = info.NetworkSettings.Networks[composeNetwork].IPAddress || "localhost";
      } else {
        host = info.NetworkSettings?.IPAddress || "localhost";
      }

      // Get the published host port for the gateway (for direct browser access to control UI)
      const portBindings = info.NetworkSettings?.Ports?.["18789/tcp"];
      const gatewayHostPort = portBindings?.[0]?.HostPort || null;
      const runtimePortBindings = info.NetworkSettings?.Ports?.["9090/tcp"];
      const publishedRuntimeHostPort = runtimePortBindings?.[0]?.HostPort || null;

      console.log(
        `[docker] Container ${containerName} (${container.id}) started at ${host} (gateway port 18789, host port ${gatewayHostPort || "none"}, runtime host port ${publishedRuntimeHostPort || "none"})`,
      );
      return {
        containerId: containerName,
        host,
        gatewayToken,
        containerName,
        gatewayHostPort,
        // Keep control-plane and worker traffic on the container network even
        // though the optional direct browser port is host-loopback-only.
        gatewayHost: host,
        gatewayPort: OPENCLAW_GATEWAY_PORT,
        runtimeHostPort: publishedRuntimeHostPort,
      };
    } catch (error) {
      if (container) {
        try {
          await container.remove({ force: true });
        } catch {
          // Best effort cleanup only.
        }
      }
      // A bind conflict is recoverable locally: the worker can persist a
      // replacement reservation and retry create(). Keep named volumes on every
      // bind conflict, including remote Docker failures, so a port collision
      // never erases durable agent state while the operator resolves it.
      if (!isDockerPortBindConflict(error)) {
        for (const volume of [volumeName, homeVolumeName]) {
          try {
            await this.docker.getVolume(volume).remove({ force: true });
          } catch {
            // Best effort cleanup only.
          }
        }
      }
      throw error;
    }
  }

  async destroy(containerId, { agentId: requestedAgentId } = {}) {
    console.log(`[docker] Destroying container ${containerId}`);
    const container = this.docker.getContainer(containerId);

    let agentId = requestedAgentId || null;
    let containerExists = true;
    try {
      const info = await container.inspect();
      agentId = info.Config?.Labels?.["openclaw.agent.id"] || agentId;
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      containerExists = false;
    }

    if (containerExists) {
      try {
        await container.stop({ t: 10 });
      } catch (e) {
        // Already stopped
      }
      try {
        await container.remove({ force: true });
        console.log(`[docker] Container ${containerId} removed`);
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    } else {
      console.log(`[docker] Container ${containerId} already absent`);
    }

    if (agentId) {
      const volumeCleanupFailures = [];
      for (const volume of [`nora_agent_state_${agentId}`, `nora_agent_home_${agentId}`]) {
        try {
          await this.docker.getVolume(volume).remove({ force: true });
          console.log(`[docker] Volume ${volume} removed`);
        } catch (error) {
          if (isDockerNotFound(error)) {
            console.log(`[docker] Volume ${volume} already absent`);
            continue;
          }
          console.warn(
            `[docker] Could not remove volume ${volume} for agent ${agentId}: ${error.message}`,
          );
          volumeCleanupFailures.push({ volume, error });
        }
      }
      if (volumeCleanupFailures.length > 0) {
        const failedVolumes = volumeCleanupFailures.map(({ volume }) => volume);
        const error = new Error(
          `Failed to remove Nora-managed Docker ${failedVolumes.length === 1 ? "volume" : "volumes"} ` +
            `${failedVolumes.join(", ")} for agent ${agentId}. The container is absent, but durable ` +
            "state may remain; retry deletion after correcting Docker volume access.",
        );
        error.code = "DOCKER_VOLUME_CLEANUP_FAILED";
        error.volumeNames = failedVolumes;
        error.cause = volumeCleanupFailures[0].error;
        throw error;
      }
    }
  }

  async status(containerId) {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      const running = info.State?.Running || false;
      const startedAt = info.State?.StartedAt ? new Date(info.State.StartedAt).getTime() : 0;
      const uptime = running ? Date.now() - startedAt : 0;

      return { running, uptime, cpu: null, memory: null };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
  }

  async inspectEnv(containerId, { envNames = [] } = {}) {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();
    const allowed = new Set(
      (Array.isArray(envNames) ? envNames : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    );
    const env = {};
    for (const entry of Array.isArray(info?.Config?.Env) ? info.Config.Env : []) {
      const separator = String(entry).indexOf("=");
      const key = separator >= 0 ? String(entry).slice(0, separator) : String(entry);
      if (!key || (allowed.size > 0 && !allowed.has(key))) continue;
      env[key] = separator >= 0 ? String(entry).slice(separator + 1) : "";
    }
    const managedState = await this._readManagedEnvState(container);
    for (const name of managedState.managedNames) {
      if (allowed.size > 0 && !allowed.has(name)) continue;
      env[name] = Object.prototype.hasOwnProperty.call(managedState.values, name)
        ? managedState.values[name]
        : "";
    }
    return env;
  }

  async stats(containerId) {
    let info = null;

    try {
      const container = this.docker.getContainer(containerId);
      info = await container.inspect();

      if (!info.State?.Running) {
        return buildUnavailableTelemetry({
          backendType: "docker",
          running: false,
          uptime_seconds: uptimeFromContainerInfo(info),
          capabilities: DOCKER_CAPABILITIES,
        });
      }

      const stats = await container.stats({ stream: false });
      return buildDockerTelemetry({ stats, info, backendType: "docker" });
    } catch {
      return buildUnavailableTelemetry({
        backendType: "docker",
        running: Boolean(info?.State?.Running),
        uptime_seconds: uptimeFromContainerInfo(info),
        capabilities: DOCKER_CAPABILITIES,
      });
    }
  }

  async stop(containerId) {
    console.log(`[docker] Stopping container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: 10 });
    console.log(`[docker] Container ${containerId} stopped`);
  }

  async start(containerId) {
    console.log(`[docker] Starting container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.start();
    console.log(`[docker] Container ${containerId} started`);
  }

  async restart(containerId) {
    console.log(`[docker] Restarting container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.restart({ t: 10 });
    console.log(`[docker] Container ${containerId} restarted`);
  }

  async logs(containerId, opts = {}) {
    const container = this.docker.getContainer(containerId);
    const stream = await container.logs({
      follow: opts.follow !== false,
      stdout: true,
      stderr: true,
      tail: opts.tail || 100,
      timestamps: opts.timestamps !== false,
    });
    return stream;
  }

  async exec(containerId, opts = {}) {
    const container = this.docker.getContainer(containerId);
    const tty = opts.tty !== false;
    const execInstance = await container.exec({
      Cmd: opts.cmd || ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      Env: opts.env || ["TERM=xterm-256color"],
    });
    const rawStream = await execInstance.start({
      hijack: true,
      stdin: true,
      Tty: tty,
    });
    if (tty) return { exec: execInstance, stream: rawStream };

    // Docker multiplexes stdout/stderr behind 8-byte frame headers whenever
    // TTY is disabled. Demux at the adapter boundary so command consumers see
    // the same plain byte stream as Kubernetes and Proxmox adapters.
    return { exec: execInstance, stream: demuxDockerExecStream(this.docker, rawStream) };
  }
}

module.exports = DockerBackend;
module.exports.buildManagedEnvApplyScript = buildManagedEnvApplyScript;
module.exports.ensureOpenClawManagedStartupHooks = ensureOpenClawManagedStartupHooks;
