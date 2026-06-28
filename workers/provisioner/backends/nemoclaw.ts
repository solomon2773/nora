// @ts-nocheck
// NemoClaw Provisioner Backend
// Creates OpenShell-sandboxed agents with NVIDIA Nemotron inference,
// strict network/filesystem policies, and controlled egress.

const Docker = require("dockerode");
const ProvisionerBackend = require("./interface");
const crypto = require("crypto");
const path = require("path");
const {
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawInstallCommand,
  buildTemplatePayloadBootstrapCommand,
  buildRuntimeBootstrapFiles,
  buildIntegrationToolWrapperScript,
  buildRuntimeEnv,
} = require("../../../agent-runtime/lib/runtimeBootstrap");
const {
  OPENCLAW_GATEWAY_PORT,
  AGENT_RUNTIME_PORT,
} = require("../../../agent-runtime/lib/contracts");
const {
  getNemoClawDefaultModel,
  getNemoClawSandboxImage,
} = require("../../../agent-runtime/lib/nemoclawDefaults");
const {
  buildDockerTelemetry,
  buildUnavailableTelemetry,
  DOCKER_CAPABILITIES,
  uptimeFromContainerInfo,
} = require("./telemetry");

// Default to the Nora-built GHCR image (OpenShell sandbox base + tsx prebaked).
// Set NEMOCLAW_SANDBOX_IMAGE=nora-nemoclaw-agent:local to use a preloaded local
// image on offline Docker/k3s nodes.
const SANDBOX_IMAGE = getNemoClawSandboxImage(process.env);

const DEFAULT_MODEL = getNemoClawDefaultModel(process.env);

// Baseline network policy — only these endpoints are allowed.
// Matches NemoClaw's openclaw-sandbox.yaml spec.
const BASELINE_POLICY = {
  version: "1",
  network: {
    default: "deny",
    rules: [
      {
        name: "nvidia",
        endpoints: ["integrate.api.nvidia.com:443", "inference-api.nvidia.com:443"],
        methods: ["*"],
      },
      { name: "github", endpoints: ["github.com:443", "api.github.com:443"], methods: ["*"] },
      { name: "npm_registry", endpoints: ["registry.npmjs.org:443"], methods: ["GET"] },
      {
        name: "openclaw_api",
        endpoints: ["openclaw.ai:443", "docs.openclaw.ai:443", "clawhub.com:443"],
        methods: ["GET", "POST"],
      },
    ],
  },
  filesystem: {
    readwrite: ["/sandbox", "/tmp", "/dev/null"],
    readonly: ["/usr", "/lib", "/proc", "/dev/urandom", "/app", "/etc", "/var/log"],
  },
  inference: {
    provider: "nvidia-nim",
    endpoint: "https://integrate.api.nvidia.com/v1",
    model: DEFAULT_MODEL,
  },
};

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

class NemoClawBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
    this._composeNetwork = null;
  }

  async _findComposeNetwork() {
    if (this._composeNetwork) return this._composeNetwork;

    try {
      const fs = require("fs");
      const hostname =
        (process.env.HOSTNAME || "").trim() || fs.readFileSync("/etc/hostname", "utf8").trim();
      if (hostname) {
        const self = this.docker.getContainer(hostname);
        const info = await self.inspect();
        const nets = info.NetworkSettings?.Networks || {};
        const composeName = Object.keys(nets).find((name) => name.endsWith("_default"));
        if (composeName) {
          this._composeNetwork = composeName;
          console.log(`[nemoclaw] Using Compose network (self-inspect): ${composeName}`);
          return this._composeNetwork;
        }
      }
    } catch {
      // Not running inside Docker or can't self-inspect.
    }

    try {
      const containers = await this.docker.listContainers({
        filters: { label: ["com.docker.compose.service=worker-provisioner"] },
      });
      if (containers.length > 0) {
        const info = await this.docker.getContainer(containers[0].Id).inspect();
        const nets = info.NetworkSettings?.Networks || {};
        const composeName = Object.keys(nets).find((name) => name.endsWith("_default"));
        if (composeName) {
          this._composeNetwork = composeName;
          console.log(`[nemoclaw] Using Compose network (service label): ${composeName}`);
          return this._composeNetwork;
        }
      }
    } catch {
      // Docker API error.
    }

    try {
      const networks = await this.docker.listNetworks();
      const net = networks.find(
        (network) =>
          network.Name.endsWith("_default") &&
          network.Labels?.["com.docker.compose.network"] === "default",
      );
      if (net) {
        this._composeNetwork = net.Name;
        console.log(`[nemoclaw] Using Compose network (label scan): ${net.Name}`);
      }
    } catch {
      console.warn("[nemoclaw] Failed to scan networks");
    }

    return this._composeNetwork;
  }

  _buildBootstrapFiles({ pairedJson, buildAuthScript, policyJson, templatePayload, gatewayToken }) {
    const runtimeFiles = buildRuntimeBootstrapFiles().map(({ relPath, source }) => ({
      name: `opt/openclaw-runtime/lib/${relPath}`,
      content: source,
      mode: 0o644,
    }));
    const templateBootstrapCmd = buildTemplatePayloadBootstrapCommand(templatePayload);
    const policyJsonB64 = Buffer.from(policyJson).toString("base64");

    const startupScript = [
      "#!/bin/sh",
      "set -eu",
      buildOpenClawInstallCommand(["openclaw@latest", "nemoclaw@latest"]),
      "mkdir -p ~/.openclaw/devices",
      "cat <<'__NORA_GATEWAY_CONFIG__' > ~/.openclaw/openclaw.json",
      JSON.stringify({ gateway: { port: OPENCLAW_GATEWAY_PORT, bind: "lan", mode: "local" } }),
      "__NORA_GATEWAY_CONFIG__",
      "chmod 0600 ~/.openclaw/openclaw.json",
      "cat <<'__NORA_PAIRED_DEVICES__' > ~/.openclaw/devices/paired.json",
      pairedJson,
      "__NORA_PAIRED_DEVICES__",
      "chmod 0600 ~/.openclaw/devices/paired.json",
      "printf '{}' > ~/.openclaw/devices/pending.json",
      "mkdir -p /opt/openclaw",
      `printf '%s' '${policyJsonB64}' | base64 -d > /opt/openclaw/policy.yaml`,
      templateBootstrapCmd ? `${templateBootstrapCmd}true` : "true",
      "mkdir -p /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent",
      "touch /var/log/openclaw-agent.log",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 &',
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/build-auth.js',
      buildOpenClawAuthImportFromFileCommand({ requireCli: true }),
      `exec "$OPENCLAW_BIN" gateway --port ${OPENCLAW_GATEWAY_PORT} --password ${gatewayToken}`,
      "",
    ].join("\n");

    return [
      ...runtimeFiles,
      {
        name: "usr/local/bin/nora-integration-tool",
        content: buildIntegrationToolWrapperScript(),
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
    const tar = require("tar-stream");
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
      await addEntry({ name: file.name, mode: file.mode || 0o644 }, file.content);
    }

    pack.finalize();
    const archive = await archivePromise;
    await container.putArchive(archive, { path: "/" });
  }

  async create(config) {
    const {
      id,
      name,
      vcpu,
      ram_mb,
      disk_gb,
      env,
      container_name,
      templatePayload,
      gatewayHostPort: allocatedGatewayPort,
      runtimeHostPort: allocatedRuntimePort,
    } = config;
    const containerName = container_name || safeContainerName("nora-oclaw", name, id);
    const model = (env && env.NEMOCLAW_MODEL) || DEFAULT_MODEL;
    let container = null;

    console.log(`[nemoclaw] Creating sandbox ${containerName} from ${SANDBOX_IMAGE}`);

    // Pull the sandbox image
    try {
      await this.docker.getImage(SANDBOX_IMAGE).inspect();
      console.log(`[nemoclaw] Image ${SANDBOX_IMAGE} already present`);
    } catch {
      console.log(`[nemoclaw] Pulling image ${SANDBOX_IMAGE}...`);
      await new Promise((resolve, reject) => {
        this.docker.pull(SANDBOX_IMAGE, (err, stream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (err) => {
            if (err) return reject(err);
            console.log(`[nemoclaw] Image ${SANDBOX_IMAGE} pulled successfully`);
            resolve();
          });
        });
      });
    }

    // Remove orphaned containers
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      console.log(
        `[nemoclaw] Removing orphaned container ${info.Id.slice(0, 12)} (${containerName})`,
      );
      try {
        await existing.stop({ t: 5 });
      } catch {
        /* already stopped */
      }
      await existing.remove({ force: true });
    } catch {
      // No existing container
    }

    // Generate per-agent Gateway auth token + Ed25519 device identity
    const gatewayToken = crypto.randomBytes(16).toString("hex");
    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
    const seed = crypto
      .createHash("sha256")
      .update("openclaw-device:" + gatewayToken)
      .digest();
    const privateDer = Buffer.concat([PKCS8_PREFIX, seed]);
    const privateKey = crypto.createPrivateKey({
      key: privateDer,
      format: "der",
      type: "pkcs8",
    });
    const publicKey = crypto.createPublicKey(privateKey);
    const spki = publicKey.export({ type: "spki", format: "der" });
    const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
    const deviceId = crypto.createHash("sha256").update(rawPub).digest("hex");
    const pubB64 = rawPub
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/g, "");

    const allScopes = [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ];
    const nowMs = Date.now();
    const pairedJson = JSON.stringify({
      [deviceId]: {
        deviceId,
        publicKey: pubB64,
        platform: "linux",
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        roles: ["operator"],
        scopes: allScopes,
        approvedScopes: allScopes,
        tokens: {
          operator: {
            token: crypto.randomBytes(32).toString("hex"),
            role: "operator",
            scopes: allScopes,
            createdAtMs: nowMs,
          },
        },
        createdAtMs: nowMs,
        approvedAtMs: nowMs,
      },
    });

    // Build env array — inject runtime/gateway contract vars + NemoClaw model.
    // The OpenShell sandbox image installs openclaw + tsx under /usr/bin (npm
    // global prefix is `/usr`, not `/usr/local`). Dockerode's Env: replaces
    // the image's ENV rather than merging, so the bootstrap's fast-path check
    // can't rely on the image-level ENV alone — we must re-declare the paths
    // here so `$OPENCLAW_CLI_PATH` / `$OPENCLAW_TSX_BIN` resolve correctly.
    //
    // HOME is likewise derived at container-start from /etc/passwd, but only
    // when Env is empty; a non-empty Env list disables that derivation, so we
    // set it explicitly to the sandbox user's home. OpenClaw's gateway reads
    // $HOME to locate ~/.openclaw for its setup files.
    const envArray = Object.entries({
      ...(env || {}),
      ...buildRuntimeEnv(),
      HOME: "/sandbox",
      OPENCLAW_CLI_PATH: "/usr/bin/openclaw",
      OPENCLAW_TSX_BIN: "/usr/bin/tsx",
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      NEMOCLAW_MODEL: model,
    }).map(([k, v]) => `${k}=${v}`);
    // Ensure NVIDIA_API_KEY is present
    if (env && env.NVIDIA_API_KEY) {
      // already in envArray
    } else if (process.env.NVIDIA_API_KEY) {
      envArray.push(`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`);
    }

    // Build auth-profiles with NVIDIA endpoint
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
    };
    const buildAuthScript =
      `var m=${JSON.stringify(llmKeyMap)},e={NVIDIA_API_KEY:"https://integrate.api.nvidia.com/v1"},f={MICROSOFT_FOUNDRY_API_KEY:"MICROSOFT_FOUNDRY_BASE_URL"},av={MICROSOFT_FOUNDRY_API_KEY:"MICROSOFT_FOUNDRY_API_VERSION"},s={version:1,profiles:{},order:{},lastGood:{}};` +
      `Object.entries(m).forEach(function(x){` +
      `var envKey=x[0],provider=x[1],key=process.env[envKey];` +
      `if(!key)return;` +
      `var profileId=provider+":default";` +
      `s.profiles[profileId]=Object.assign({type:"api_key",provider:provider,key:key},e[envKey]?{endpoint:e[envKey]}:{});` +
      `if(f[envKey]&&process.env[f[envKey]])s.profiles[profileId].endpoint=process.env[f[envKey]];` +
      `if(av[envKey]&&process.env[av[envKey]])s.profiles[profileId].api_version=process.env[av[envKey]];` +
      `s.order[provider]=[profileId];` +
      `s.lastGood[provider]=profileId;` +
      `});` +
      `require("fs").mkdirSync("/root/.openclaw/agents/main/agent",{recursive:true});` +
      `require("fs").writeFileSync("/root/.openclaw/agents/main/agent/auth-profiles.json",JSON.stringify(s));` +
      `require("fs").chmodSync("/root/.openclaw/agents/main/agent/auth-profiles.json",0o600);`;

    // Write baseline policy file
    const policyForContainer = { ...BASELINE_POLICY };
    policyForContainer.inference = {
      ...policyForContainer.inference,
      model,
    };
    const bootstrapFiles = this._buildBootstrapFiles({
      pairedJson,
      buildAuthScript,
      policyJson: JSON.stringify(policyForContainer),
      templatePayload,
      gatewayToken,
    });
    const launch = {
      Entrypoint: ["/bin/sh"],
      Cmd: ["/opt/openclaw-runtime/start.sh"],
    };

    // Resolve compose network
    const composeNetwork = await this._findComposeNetwork();
    const networkingConfig = {};
    if (composeNetwork) {
      networkingConfig[composeNetwork] = {};
    }
    const requestedHostPort = Number(allocatedGatewayPort);
    const gatewayPortBinding =
      !composeNetwork &&
      Number.isInteger(requestedHostPort) &&
      requestedHostPort >= 1 &&
      requestedHostPort <= 65535
        ? { "18789/tcp": [{ HostPort: String(requestedHostPort) }] }
        : undefined;
    const requestedRuntimeHostPort = Number(allocatedRuntimePort);
    const runtimePortBinding =
      !composeNetwork &&
      Number.isInteger(requestedRuntimeHostPort) &&
      requestedRuntimeHostPort >= 1 &&
      requestedRuntimeHostPort <= 65535
        ? { "9090/tcp": [{ HostPort: String(requestedRuntimeHostPort) }] }
        : undefined;

    // DNS-safe hostname from agent name (avoids Bonjour conflicts across containers)
    const safeHostname =
      (name || containerName)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 63) || `nemoclaw-${id}`;

    try {
      container = await this.docker.createContainer({
        Image: SANDBOX_IMAGE,
        name: containerName,
        Hostname: safeHostname,
        Env: envArray,
        ...launch,
        WorkingDir: "/sandbox",
        ExposedPorts: { "18789/tcp": {}, "9090/tcp": {} },
        HostConfig: {
          NanoCpus: (vcpu || 2) * 1e9,
          Memory: (ram_mb || 2048) * 1024 * 1024,
          RestartPolicy: { Name: "unless-stopped" },
          ...(gatewayPortBinding || runtimePortBinding
            ? { PortBindings: { ...(gatewayPortBinding || {}), ...(runtimePortBinding || {}) } }
            : {}),
          // DNS only for allowed endpoints — OpenShell controls egress
          Dns: ["8.8.8.8", "8.8.4.4"],
          // Security hardening: drop all capabilities, add back only what's needed
          CapDrop: ["ALL"],
          CapAdd: ["NET_BIND_SERVICE"],
          SecurityOpt: ["no-new-privileges:true"],
          // Tmpfs mounts for sandbox writable dirs. The OpenShell sandbox user
          // is UID 998 (gid 998) — we must set uid/gid on the tmpfs mount or
          // the fresh empty tmpfs comes up root-owned and the sandbox user
          // can't mkdir `~/.openclaw` in its own home. `mode=0755` keeps it
          // sandbox-owned but world-readable so openclaw's log forwarders can
          // still peek if needed.
          Tmpfs: {
            "/sandbox": "rw,noexec,nosuid,size=512m,uid=998,gid=998,mode=0755",
            "/tmp": "rw,noexec,nosuid,size=256m,mode=1777",
          },
        },
        NetworkingConfig: composeNetwork ? { EndpointsConfig: networkingConfig } : undefined,
        Labels: {
          "openclaw.agent.id": String(id),
          "openclaw.agent.name": name || "",
          "openclaw.gateway.port": String(OPENCLAW_GATEWAY_PORT),
          "openclaw.runtime.port": String(AGENT_RUNTIME_PORT),
          "openclaw.sandbox.type": "nemoclaw",
          "openclaw.sandbox.model": model,
        },
      });

      await this._putBootstrapFiles(container, bootstrapFiles);
      await container.start();

      // NOTE: We do NOT connect to bridge network — NemoClaw enforces controlled
      // egress via OpenShell network policies. Only Compose network for internal.
      console.log(`[nemoclaw] Sandbox started (no bridge network — OpenShell controls egress)`);

      // Get container IP on the Compose network
      const info = await container.inspect();
      let host = "localhost";
      if (composeNetwork && info.NetworkSettings?.Networks?.[composeNetwork]) {
        host = info.NetworkSettings.Networks[composeNetwork].IPAddress || "localhost";
      } else {
        host = info.NetworkSettings?.IPAddress || "localhost";
      }
      const portBindings = info.NetworkSettings?.Ports?.["18789/tcp"];
      const gatewayHostPort = portBindings?.[0]?.HostPort || null;
      const runtimePortBindings = info.NetworkSettings?.Ports?.["9090/tcp"];
      const runtimeHostPort = runtimePortBindings?.[0]?.HostPort || null;

      console.log(
        `[nemoclaw] Container ${containerName} (${container.id}) started at ${host} (gateway port 18789, host port ${gatewayHostPort || "none"}, runtime host port ${runtimeHostPort || "none"}, model: ${model})`,
      );
      return {
        containerId: containerName,
        host,
        gatewayToken,
        containerName,
        gatewayHostPort,
        runtimeHostPort,
      };
    } catch (error) {
      if (container) {
        try {
          await container.remove({ force: true });
        } catch {
          // Best effort cleanup only.
        }
      }
      throw error;
    }
  }

  async destroy(containerId) {
    console.log(`[nemoclaw] Destroying sandbox ${containerId}`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: 10 });
    } catch {
      // Already stopped
    }
    await container.remove({ force: true });
    console.log(`[nemoclaw] Sandbox ${containerId} removed`);
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
    console.log(`[nemoclaw] Stopping sandbox ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.stop({ t: 10 });
    console.log(`[nemoclaw] Sandbox ${containerId} stopped`);
  }

  async start(containerId) {
    console.log(`[nemoclaw] Starting sandbox ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.start();
    console.log(`[nemoclaw] Sandbox ${containerId} started`);
  }

  async restart(containerId) {
    console.log(`[nemoclaw] Restarting sandbox ${containerId}`);
    const container = this.docker.getContainer(containerId);
    await container.restart({ t: 10 });
    console.log(`[nemoclaw] Sandbox ${containerId} restarted`);
  }

  async logs(containerId, opts = {}) {
    const container = this.docker.getContainer(containerId);
    return await container.logs({
      follow: opts.follow !== false,
      stdout: true,
      stderr: true,
      tail: opts.tail || 100,
      timestamps: opts.timestamps !== false,
    });
  }

  async exec(containerId, opts = {}) {
    const container = this.docker.getContainer(containerId);
    const execInstance = await container.exec({
      Cmd: opts.cmd || ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: opts.tty !== false,
      Env: opts.env || ["TERM=xterm-256color"],
    });
    const stream = await execInstance.start({
      hijack: true,
      stdin: true,
      Tty: opts.tty !== false,
    });
    return { exec: execInstance, stream };
  }

  /**
   * Read or update the NemoClaw network policy on a running container.
   * @param {string} containerId
   * @param {"get"|"set"} action
   * @param {Object} [data] - New policy data (for "set" action)
   */
  async policy(containerId, action, data) {
    const container = this.docker.getContainer(containerId);
    if (action === "get") {
      const exec = await container.exec({
        Cmd: ["cat", "/opt/openclaw/policy.yaml"],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start();
      return new Promise((resolve) => {
        let output = "";
        stream.on("data", (chunk) => (output += chunk.toString()));
        stream.on("end", () => {
          try {
            resolve(JSON.parse(output.trim()));
          } catch {
            resolve({ raw: output.trim() });
          }
        });
      });
    } else if (action === "set" && data) {
      const policyStr = JSON.stringify(data).replace(/'/g, "'\\''");
      const exec = await container.exec({
        Cmd: ["sh", "-c", `echo '${policyStr}' > /opt/openclaw/policy.yaml`],
        AttachStdout: true,
        AttachStderr: true,
      });
      await exec.start();
      return { updated: true };
    }
    throw new Error(`Unknown policy action: ${action}`);
  }
}

module.exports = NemoClawBackend;
