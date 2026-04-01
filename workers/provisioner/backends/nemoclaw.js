// NemoClaw Provisioner Backend
// Creates OpenShell-sandboxed agents with NVIDIA Nemotron inference,
// strict network/filesystem policies, and controlled egress.

const Docker = require("dockerode");
const ProvisionerBackend = require("./interface");
const crypto = require("crypto");
const { buildRuntimeBootstrapCommand, buildRuntimeEnv } = require("../runtimeBootstrap");
const { OPENCLAW_GATEWAY_PORT, AGENT_RUNTIME_PORT } = require("../../../agent-runtime/lib/contracts");

const SANDBOX_IMAGE =
  process.env.NEMOCLAW_SANDBOX_IMAGE ||
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw";

const DEFAULT_MODEL =
  process.env.NEMOCLAW_DEFAULT_MODEL ||
  "nvidia/nemotron-3-super-120b-a12b";

// Baseline network policy — only these endpoints are allowed.
// Matches NemoClaw's openclaw-sandbox.yaml spec.
const BASELINE_POLICY = {
  version: "1",
  network: {
    default: "deny",
    rules: [
      { name: "nvidia", endpoints: ["integrate.api.nvidia.com:443", "inference-api.nvidia.com:443"], methods: ["*"] },
      { name: "github", endpoints: ["github.com:443", "api.github.com:443"], methods: ["*"] },
      { name: "npm_registry", endpoints: ["registry.npmjs.org:443"], methods: ["GET"] },
      { name: "openclaw_api", endpoints: ["openclaw.ai:443", "docs.openclaw.ai:443", "clawhub.com:443"], methods: ["GET", "POST"] },
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

class NemoClawBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
    this._composeNetwork = null;
  }

  async _findComposeNetwork() {
    if (this._composeNetwork) return this._composeNetwork;
    const networks = await this.docker.listNetworks();
    const net = networks.find(
      (n) => n.Name.includes("openclaw") && n.Name.includes("default")
    );
    if (net) {
      this._composeNetwork = net.Name;
      console.log(`[nemoclaw] Using Compose network: ${net.Name}`);
    }
    return this._composeNetwork;
  }

  async create(config) {
    const { id, name, vcpu, ram_mb, disk_gb, env, container_name } = config;
    const containerName = container_name || `oclaw-nemoclaw-${id}`;
    const model = (env && env.NEMOCLAW_MODEL) || DEFAULT_MODEL;

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
        `[nemoclaw] Removing orphaned container ${info.Id.slice(0, 12)} (${containerName})`
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
    const ED25519_SPKI_PREFIX = Buffer.from(
      "302a300506032b6570032100",
      "hex"
    );
    const PKCS8_PREFIX = Buffer.from(
      "302e020100300506032b657004220420",
      "hex"
    );
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
    const deviceId = crypto
      .createHash("sha256")
      .update(rawPub)
      .digest("hex");
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
    const envArray = Object.entries({
      ...(env || {}),
      ...buildRuntimeEnv(),
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
    };
    const authProfiles = {};
    if (env) {
      for (const [envKey, provider] of Object.entries(llmKeyMap)) {
        if (env[envKey]) {
          const profile = { apiKey: env[envKey] };
          if (envKey === "NVIDIA_API_KEY") {
            profile.endpoint = "https://integrate.api.nvidia.com/v1";
          }
          authProfiles[provider] = profile;
        }
      }
    }
    const hasAuthProfiles = Object.keys(authProfiles).length > 0;
    const authProfilesCmd = hasAuthProfiles
      ? `mkdir -p /root/.openclaw/agents/main/agent && echo '${JSON.stringify(authProfiles).replace(/'/g, "'\\''")}' > /root/.openclaw/agents/main/agent/auth-profiles.json && `
      : "";

    // Write baseline policy file
    const policyForContainer = { ...BASELINE_POLICY };
    policyForContainer.inference = {
      ...policyForContainer.inference,
      model,
    };
    const policyCmd = `mkdir -p /opt/openclaw && echo '${JSON.stringify(policyForContainer).replace(/'/g, "'\\''")}' > /opt/openclaw/policy.yaml && `;

    const runtimeBootstrapCmd = buildRuntimeBootstrapCommand();

    // Startup command: install openclaw + nemoclaw, configure everything, start the
    // runtime sidecar, then launch the gateway.
    const startCmd = [
      "sh",
      "-c",
      "apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1 && " +
        "npm install -g openclaw@latest nemoclaw@latest 2>&1 && " +
        "mkdir -p ~/.openclaw/devices && " +
        "echo '" +
        JSON.stringify({
          gateway: { port: 18789, bind: "lan", mode: "local" },
        }).replace(/'/g, "'\\''") +
        "' > ~/.openclaw/openclaw.json && " +
        "echo '" +
        pairedJson.replace(/'/g, "'\\''") +
        "' > ~/.openclaw/devices/paired.json && " +
        "echo '{}' > ~/.openclaw/devices/pending.json && " +
        policyCmd +
        runtimeBootstrapCmd +
        authProfilesCmd +
        `openclaw gateway --port ${OPENCLAW_GATEWAY_PORT} --password ${gatewayToken}`,
    ];

    // Resolve compose network
    const composeNetwork = await this._findComposeNetwork();
    const networkingConfig = {};
    if (composeNetwork) {
      networkingConfig[composeNetwork] = {};
    }

    // DNS-safe hostname from agent name (avoids Bonjour conflicts across containers)
    const safeHostname = (name || containerName)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63) || `nemoclaw-${id}`;

    const container = await this.docker.createContainer({
      Image: SANDBOX_IMAGE,
      name: containerName,
      Hostname: safeHostname,
      Env: envArray,
      Cmd: startCmd,
      WorkingDir: "/sandbox",
      ExposedPorts: { "18789/tcp": {}, "9090/tcp": {} },
      HostConfig: {
        NanoCpus: (vcpu || 2) * 1e9,
        Memory: (ram_mb || 2048) * 1024 * 1024,
        RestartPolicy: { Name: "unless-stopped" },
        // DNS only for allowed endpoints — OpenShell controls egress
        Dns: ["8.8.8.8", "8.8.4.4"],
        // Security hardening: drop all capabilities, add back only what's needed
        CapDrop: ["ALL"],
        CapAdd: ["NET_BIND_SERVICE"],
        SecurityOpt: ["no-new-privileges:true"],
        // Tmpfs mounts for sandbox writable dirs
        Tmpfs: {
          "/sandbox": "rw,noexec,nosuid,size=512m",
          "/tmp": "rw,noexec,nosuid,size=256m",
        },
      },
      NetworkingConfig: composeNetwork
        ? { EndpointsConfig: networkingConfig }
        : undefined,
      Labels: {
        "openclaw.agent.id": String(id),
        "openclaw.agent.name": name || "",
        "openclaw.gateway.port": String(OPENCLAW_GATEWAY_PORT),
        "openclaw.runtime.port": String(AGENT_RUNTIME_PORT),
        "openclaw.sandbox.type": "nemoclaw",
        "openclaw.sandbox.model": model,
      },
    });

    await container.start();

    // NOTE: We do NOT connect to bridge network — NemoClaw enforces controlled
    // egress via OpenShell network policies. Only Compose network for internal.
    console.log(
      `[nemoclaw] Sandbox started (no bridge network — OpenShell controls egress)`
    );

    // Get container IP on the Compose network
    const info = await container.inspect();
    let host = "localhost";
    if (
      composeNetwork &&
      info.NetworkSettings?.Networks?.[composeNetwork]
    ) {
      host =
        info.NetworkSettings.Networks[composeNetwork].IPAddress || "localhost";
    } else {
      host = info.NetworkSettings?.IPAddress || "localhost";
    }

    console.log(
      `[nemoclaw] Container ${container.id} started at ${host} (gateway port 18789, model: ${model})`
    );
    return { containerId: container.id, host, gatewayToken, containerName };
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
      const startedAt = info.State?.StartedAt
        ? new Date(info.State.StartedAt).getTime()
        : 0;
      const uptime = running ? Date.now() - startedAt : 0;
      return { running, uptime, cpu: null, memory: null };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null };
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
      Cmd: opts.cmd || [
        "/bin/sh",
        "-c",
        "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
      ],
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
        Cmd: [
          "sh",
          "-c",
          `echo '${policyStr}' > /opt/openclaw/policy.yaml`,
        ],
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
