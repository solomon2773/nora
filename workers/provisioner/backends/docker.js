const Docker = require("dockerode");
const ProvisionerBackend = require("./interface");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { buildRuntimeBootstrapCommand, buildRuntimeEnv } = require("../runtimeBootstrap");
const { OPENCLAW_GATEWAY_PORT, AGENT_RUNTIME_PORT } = require("../../../agent-runtime/lib/contracts");

class DockerBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
    this._composeNetwork = null; // cached
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
      const hostname = (process.env.HOSTNAME || "").trim() ||
        fs.readFileSync("/etc/hostname", "utf8").trim();
      if (hostname) {
        const self = this.docker.getContainer(hostname);
        const info = await self.inspect();
        const nets = info.NetworkSettings?.Networks || {};
        const composeName = Object.keys(nets).find(n => n.endsWith("_default"));
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
        filters: { label: ["com.docker.compose.service=worker-provisioner"] }
      });
      if (containers.length > 0) {
        const info = await this.docker.getContainer(containers[0].Id).inspect();
        const nets = info.NetworkSettings?.Networks || {};
        const composeName = Object.keys(nets).find(n => n.endsWith("_default"));
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
      const net = networks.find(n =>
        n.Name.endsWith("_default") &&
        n.Labels?.["com.docker.compose.network"] === "default"
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

  async create(config) {
    const { id, name, image, vcpu, ram_mb, disk_gb, env, container_name } = config;
    const containerName = container_name || `oclaw-agent-${id}`;

    const imgName = image || "node:22-slim";
    console.log(`[docker] Creating container ${containerName} from ${imgName}`);

    // Pull the image if not already available locally
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

    // Remove any existing container with the same name (orphaned from prior deploy)
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      console.log(`[docker] Removing orphaned container ${info.Id.slice(0, 12)} (${containerName})`);
      try { await existing.stop({ t: 5 }); } catch { /* already stopped */ }
      await existing.remove({ force: true });
    } catch {
      // No existing container — expected path
    }

    // Generate per-agent Gateway auth token (32 bytes = 256 bits of entropy)
    const gatewayToken = crypto.randomBytes(32).toString("hex");

    // Derive deterministic Ed25519 device identity from gatewayToken —
    // same derivation used by gatewayProxy.js so both sides share the keypair.
    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
    const seed = crypto.createHash("sha256").update("openclaw-device:" + gatewayToken).digest();
    const privateDer = Buffer.concat([PKCS8_PREFIX, seed]);
    const privateKey = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    const publicKey = crypto.createPublicKey(privateKey);
    const spki = publicKey.export({ type: "spki", format: "der" });
    const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
    const deviceId = crypto.createHash("sha256").update(rawPub).digest("hex");
    const pubB64 = rawPub.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");

    // Pre-approved device pairing JSON — gateway reads this on startup so the
    // proxy's first connect (using the same deterministic identity) is already
    // paired and receives full operator scopes.
    const allScopes = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
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
          }
        },
        createdAtMs: nowMs,
        approvedAtMs: nowMs,
      }
    });

    // Convert env object to array of KEY=VALUE + inject runtime/gateway contract vars.
    const envArray = Object.entries({
      ...(env || {}),
      ...buildRuntimeEnv(),
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
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
    };
    // Build auth-profiles at CREATION TIME to determine the default model for setModelCmd.
    // This is only used for model selection — the actual auth-profiles.json on disk is
    // written dynamically at startup via authProfilesCmd below, so it stays correct
    // on every container restart without baking in stale or missing keys.
    const authProfiles = {};
    if (env) {
      for (const [envKey, provider] of Object.entries(llmKeyMap)) {
        if (env[envKey]) {
          authProfiles[provider] = { apiKey: env[envKey] };
        }
      }
    }
    // Dynamic auth-profiles builder: a node script (base64-encoded to avoid shell escaping)
    // that reads the CURRENT container env vars at startup and writes auth-profiles.json.
    // Because it reads env vars at runtime (not creation time), it is correct on every
    // container restart — even after keys were injected post-creation via Docker exec sync.
    const buildAuthScript =
      `var m=${JSON.stringify(llmKeyMap)},p={};` +
      `Object.entries(m).forEach(function(e){` +
        `if(process.env[e[0]])p[e[1]]={apiKey:process.env[e[0]]};` +
      `});` +
      `require("fs").mkdirSync("/root/.openclaw/agents/main/agent",{recursive:true});` +
      `require("fs").writeFileSync("/root/.openclaw/agents/main/agent/auth-profiles.json",JSON.stringify(p));`;
    const buildAuthScriptB64 = Buffer.from(buildAuthScript).toString("base64");
    // On first start: no auth-profiles.json exists → node script runs → writes from env vars.
    // On restart after live sync: auth-profiles.json exists (written by Docker exec) →
    //   script is skipped → gateway reads the exec-written file with up-to-date keys.
    // On container recreate: file gone → script runs → writes from creation-time env vars.
    const authProfilesCmd =
      `mkdir -p /root/.openclaw/agents/main/agent && ` +
      `printf '%s' '${buildAuthScriptB64}' | base64 -d > /tmp/_build_auth.js && ` +
      `(test -f /root/.openclaw/agents/main/agent/auth-profiles.json || node /tmp/_build_auth.js) && `;

    // Determine default model from the first auth profile provider
    const providerModelDefaults = {
      anthropic: "anthropic/claude-sonnet-4-5",
      openai: "openai/gpt-5.4",
      google: "google/gemini-3-flash-preview",
      groq: "groq/llama-3.3-70b-versatile",
      mistral: "mistral/mistral-large-latest",
      deepseek: "deepseek/deepseek-chat",
      cohere: "cohere/command-r-plus",
      xai: "xai/grok-2",
      nvidia: "nvidia/nemotron-3-super-120b-a12b",
      moonshot: "moonshot/kimi-k2.5",
      zai: "zai/glm-5",
    };
    const firstProvider = Object.keys(authProfiles)[0];
    const defaultModel = firstProvider ? providerModelDefaults[firstProvider] : undefined;

    // Set default model in the config file BEFORE gateway starts (not via background CLI after).
    // Writing it into openclaw.json pre-launch avoids the config-change file watcher triggering
    // a SIGUSR1 restart loop when `openclaw models set` rewrites the config post-boot.
    const safeDefaultModel = defaultModel && /^[a-zA-Z0-9_\-/.]+$/.test(defaultModel) ? defaultModel : null;

    // Derive the deterministic host port for this agent to include in allowedOrigins
    const hostPort = 19000 + (parseInt(id.replace(/\D/g, '').slice(0, 4)) || 0) % 1000;

    const gatewayConfig = {
      gateway: {
        bind: "lan",
        mode: "local",
        reload: { mode: "hot" },
        auth: {
          password: gatewayToken,
        },
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: {
          allowedOrigins: [
            "http://localhost:8080", "http://127.0.0.1:8080", "https://localhost:8080",
            "http://localhost:18789", "http://127.0.0.1:18789",
            "http://localhost:3000", "http://127.0.0.1:3000",
            "http://localhost:4000", "http://127.0.0.1:4000",
            `http://localhost:${hostPort}`, `http://127.0.0.1:${hostPort}`,
          ],
        },
      },
    };
    if (safeDefaultModel) {
      gatewayConfig.agents = { defaults: { model: safeDefaultModel } };
    }

    const runtimeBootstrapCmd = buildRuntimeBootstrapCommand();

    // CMD: install openclaw (only if not already present), configure gateway, start the
    // agent runtime on port 9090, write auth profiles, and launch the gateway.
    // The `which openclaw` guard means restarts after a successful first boot skip the slow
    // apt-get + npm install steps entirely, preventing crash loops when the npm registry is unreachable.
    const startCmd = [
      "sh", "-c",
      '(which openclaw > /dev/null 2>&1 || ((apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1 || true) && npm install -g openclaw@latest 2>&1)) && ' +
      'mkdir -p ~/.openclaw/devices && ' +
      'echo \'' + JSON.stringify(gatewayConfig) + '\' > ~/.openclaw/openclaw.json && ' +
      "echo '" + pairedJson.replace(/'/g, "'\\''") + "' > ~/.openclaw/devices/paired.json && " +
      'echo \'{}\' > ~/.openclaw/devices/pending.json && ' +
      runtimeBootstrapCmd +
      authProfilesCmd +
      `openclaw gateway --port ${OPENCLAW_GATEWAY_PORT}`
    ];

    // Resolve the Compose network for cross-service communication
    const composeNetwork = await this._findComposeNetwork();
    const networkingConfig = {};
    if (composeNetwork) {
      networkingConfig[composeNetwork] = {};
    }

    // Derive a DNS-safe hostname from the agent name (lowercase, alphanumeric + hyphens, max 63 chars).
    // This controls the container's /etc/hostname and avoids Bonjour name-conflict warnings
    // (e.g. "gateway hostname conflict resolved") when multiple agents run on the same host.
    const safeHostname = (name || containerName)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63) || `agent-${id}`;

    const container = await this.docker.createContainer({
      Image: imgName,
      name: containerName,
      Hostname: safeHostname,
      Env: envArray,
      Cmd: startCmd,
      WorkingDir: "/root",
      ExposedPorts: { "18789/tcp": {}, "9090/tcp": {} },
      HostConfig: {
        // CPU: vcpu cores -> NanoCPUs
        NanoCpus: (vcpu || 2) * 1e9,
        // Memory in bytes
        Memory: (ram_mb || 2048) * 1024 * 1024,
        // Restart policy
        RestartPolicy: { Name: "unless-stopped" },
        // Publish gateway port for direct browser access (control UI).
        // Use a deterministic port based on agent ID to survive container restarts.
        PortBindings: { "18789/tcp": [{ HostPort: String(hostPort) }] },
        // DNS servers for internet access from within the container
        Dns: ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
      },
      NetworkingConfig: composeNetwork ? {
        EndpointsConfig: networkingConfig,
      } : undefined,
      Labels: {
        "openclaw.agent.id": String(id),
        "openclaw.agent.name": name || "",
        "openclaw.gateway.port": String(OPENCLAW_GATEWAY_PORT),
        "openclaw.runtime.port": String(AGENT_RUNTIME_PORT),
      },
    });

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

    console.log(`[docker] Container ${container.id} started at ${host} (gateway port 18789, host port ${gatewayHostPort || 'none'})`);
    return { containerId: container.id, host, gatewayToken, containerName, gatewayHostPort };
  }

  async destroy(containerId) {
    console.log(`[docker] Destroying container ${containerId}`);
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: 10 });
    } catch (e) {
      // Already stopped
    }
    await container.remove({ force: true });
    console.log(`[docker] Container ${containerId} removed`);
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
}

module.exports = DockerBackend;
