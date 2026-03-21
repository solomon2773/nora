const Docker = require("dockerode");
const ProvisionerBackend = require("./interface");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

class DockerBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
    this._composeNetwork = null; // cached
  }

  /**
   * Find the Docker Compose-managed network so agent containers can communicate
   * with backend-api and other platform services.
   */
  async _findComposeNetwork() {
    if (this._composeNetwork) return this._composeNetwork;
    const networks = await this.docker.listNetworks();
    // Compose v2 names networks: <project>_default
    const net = networks.find(n =>
      n.Name.includes("openclaw") && n.Name.includes("default")
    );
    if (net) {
      this._composeNetwork = net.Name;
      console.log(`[docker] Using Compose network: ${net.Name}`);
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

    // Convert env object to array of KEY=VALUE + inject gateway token
    const envArray = env
      ? Object.entries(env).map(([k, v]) => `${k}=${v}`)
      : [];
    envArray.push(`OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`);

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

    // After gateway starts, set the model via CLI (runs in background after a delay).
    // Validate defaultModel against the known hardcoded map to prevent injection.
    // Uses a nested `sh -c '... &'` to background the model-set without the `&` breaking
    // the outer && chain (bare `&` acts as a command separator, causing later commands
    // to run unconditionally even if earlier steps like npm install failed).
    const safeDefaultModel = defaultModel && /^[a-zA-Z0-9_\-/.]+$/.test(defaultModel) ? defaultModel : null;
    const setModelCmd = safeDefaultModel
      ? `sh -c 'sleep 10 && openclaw models set ${safeDefaultModel} 2>/dev/null &' && `
      : "";

    // CMD: install openclaw (only if not already present), configure gateway, write auth profiles, and start it.
    // The `which openclaw` guard means restarts after a successful first boot skip the slow
    // apt-get + npm install steps entirely, preventing crash loops when the npm registry is unreachable.
    const startCmd = [
      "sh", "-c",
      '(which openclaw > /dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1 && npm install -g openclaw@latest 2>&1)) && ' +
      'mkdir -p ~/.openclaw/devices && ' +
      'echo \'' + JSON.stringify(JSON.parse('{"gateway":{"port":18789,"bind":"lan","mode":"local"}}')) + '\' > ~/.openclaw/openclaw.json && ' +
      "echo '" + pairedJson.replace(/'/g, "'\\''") + "' > ~/.openclaw/devices/paired.json && " +
      'echo \'{}\' > ~/.openclaw/devices/pending.json && ' +
      authProfilesCmd +
      setModelCmd +
      `openclaw gateway --port 18789 --password ${gatewayToken}`
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
      ExposedPorts: { "18789/tcp": {} },
      HostConfig: {
        // CPU: vcpu cores -> NanoCPUs
        NanoCpus: (vcpu || 2) * 1e9,
        // Memory in bytes
        Memory: (ram_mb || 2048) * 1024 * 1024,
        // Restart policy
        RestartPolicy: { Name: "unless-stopped" },
        // DNS servers for internet access from within the container
        Dns: ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
      },
      NetworkingConfig: composeNetwork ? {
        EndpointsConfig: networkingConfig,
      } : undefined,
      Labels: {
        "openclaw.agent.id": String(id),
        "openclaw.agent.name": name || "",
        "openclaw.gateway.port": "18789",
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

    console.log(`[docker] Container ${container.id} started at ${host} (gateway port 18789)`);
    return { containerId: container.id, host, gatewayToken, containerName };
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
