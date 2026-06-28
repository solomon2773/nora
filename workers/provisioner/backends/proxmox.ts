// @ts-nocheck
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const { Client } = require("ssh2");
const { PassThrough } = require("stream");
const { URL } = require("url");
const ProvisionerBackend = require("./interface");
const {
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawInstallCommand,
  buildOpenClawConfigMergeScript,
  buildOpenClawCustomProviders,
  buildIntegrationToolWrapperScript,
  buildRuntimeBootstrapFiles,
  buildRuntimeEnv,
  buildTemplatePayloadBootstrapFiles,
} = require("../../../agent-runtime/lib/runtimeBootstrap");
const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
  HERMES_DASHBOARD_PORT,
} = require("../../../agent-runtime/lib/contracts");
const { shellSingleQuote } = require("../../../agent-runtime/lib/containerCommand");
const { isProxmoxApiTokenId } = require("../../../agent-runtime/lib/backendCatalog");
const { getNemoClawDefaultModel } = require("../../../agent-runtime/lib/nemoclawDefaults");
const {
  buildTelemetry,
  buildUnavailableTelemetry,
  PROXMOX_DEFAULT_CAPABILITIES,
  bytesToMegabytes,
  roundMetric,
  toFiniteInteger,
} = require("./telemetry");

const HERMES_RUNTIME_PORT = 8642;
const HERMES_HOME = "/opt/data";
const HERMES_WORKSPACE = `${HERMES_HOME}/workspace`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeHostname(name, fallback) {
  return (
    String(name || fallback || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63) || fallback
  );
}

function systemdEnvironmentLines(env = {}) {
  return Object.entries(env || {})
    .filter(([key, value]) => key && value != null)
    .map(([key, value]) => `Environment=${key}=${JSON.stringify(String(value))}`)
    .join("\n");
}

function derivePairedDevice(gatewayToken) {
  const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
  const seed = crypto
    .createHash("sha256")
    .update("openclaw-device:" + gatewayToken)
    .digest();
  const privateDer = Buffer.concat([PKCS8_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
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
  return JSON.stringify({
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
}

function proxmoxAuthErrorMessage(statusCode) {
  return (
    `Proxmox API authentication failed (HTTP ${statusCode}). ` +
    "Check PROXMOX_TOKEN_ID uses user@realm!tokenname, " +
    "PROXMOX_TOKEN_SECRET is the API token secret, and the token has VM/LXC privileges."
  );
}

class ProxmoxBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.baseUrl = process.env.PROXMOX_API_URL;
    this.tokenId = process.env.PROXMOX_TOKEN_ID;
    this.tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    this.node = process.env.PROXMOX_NODE || "pve";
    this.template =
      process.env.PROXMOX_TEMPLATE || "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst";
    this.hermesTemplate = process.env.PROXMOX_HERMES_TEMPLATE || "";
    this.nemoClawTemplate = process.env.PROXMOX_NEMOCLAW_TEMPLATE || "";
    this.rootfsStorage = process.env.PROXMOX_ROOTFS_STORAGE || "local-lvm";
    this.bridge = process.env.PROXMOX_BRIDGE || "vmbr0";
    this.timeoutMs = 60000;
    this.sshHost = process.env.PROXMOX_SSH_HOST;
    this.sshUser = process.env.PROXMOX_SSH_USER || "root";
    this.sshPort = Number.parseInt(process.env.PROXMOX_SSH_PORT || "22", 10);
    this.pctCommand = process.env.PROXMOX_PCT_COMMAND || "pct";
    this.sudoPrefix = process.env.PROXMOX_SUDO || (this.sshUser === "root" ? "" : "sudo -n ");
  }

  _assertConfigured() {
    if (!this.baseUrl || !this.tokenId || !this.tokenSecret) {
      throw new Error("Proxmox API is not configured");
    }
    if (!isProxmoxApiTokenId(this.tokenId)) {
      throw new Error(
        "Proxmox API token id must use API token format user@realm!tokenname. Set PROXMOX_TOKEN_ID to the token id, not just the user name.",
      );
    }
    if (!this.sshHost || !this.sshUser) {
      throw new Error("Proxmox SSH is not configured");
    }
    if (
      !process.env.PROXMOX_SSH_PRIVATE_KEY &&
      !process.env.PROXMOX_SSH_PRIVATE_KEY_PATH &&
      !process.env.PROXMOX_SSH_PASSWORD
    ) {
      throw new Error("Proxmox SSH authentication is not configured");
    }
  }

  _sshConfig() {
    const config = {
      host: this.sshHost,
      port: this.sshPort,
      username: this.sshUser,
      readyTimeout: this.timeoutMs,
    };
    if (process.env.PROXMOX_SSH_PRIVATE_KEY) {
      config.privateKey = process.env.PROXMOX_SSH_PRIVATE_KEY.replace(/\\n/g, "\n");
    } else if (process.env.PROXMOX_SSH_PRIVATE_KEY_PATH) {
      config.privateKey = fs.readFileSync(process.env.PROXMOX_SSH_PRIVATE_KEY_PATH, "utf8");
    } else if (process.env.PROXMOX_SSH_PASSWORD) {
      config.password = process.env.PROXMOX_SSH_PASSWORD;
    }
    return config;
  }

  async _request(method, path, payload) {
    if (!this.baseUrl || !this.tokenId || !this.tokenSecret) {
      throw new Error("Proxmox API is not configured");
    }

    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(path.replace(/^\//, ""), base);
    const body = payload == null ? null : JSON.stringify(payload);
    const headers = {
      Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
    };

    if (body != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const verifyTls = process.env.PROXMOX_VERIFY_TLS === "true";

    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          headers,
          rejectUnauthorized: verifyTls,
          timeout: this.timeoutMs,
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            let parsed = {};
            if (raw) {
              try {
                parsed = JSON.parse(raw);
              } catch (error) {
                reject(new Error(`Invalid Proxmox response: ${error.message}`));
                return;
              }
            }
            const statusCode = res.statusCode || 500;
            if (statusCode < 200 || statusCode >= 300) {
              const detail = parsed?.errors
                ? JSON.stringify(parsed.errors)
                : parsed?.message || raw || `HTTP ${statusCode}`;
              if (statusCode === 401 || statusCode === 403) {
                reject(new Error(proxmoxAuthErrorMessage(statusCode)));
                return;
              }
              reject(new Error(detail));
              return;
            }
            resolve(parsed);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("Proxmox API timeout")));
      req.on("error", reject);
      if (body != null) req.write(body);
      req.end();
    });
  }

  async _requestData(method, path, payload) {
    const response = await this._request(method, path, payload);
    return response?.data;
  }

  async _getNextVmid() {
    return this._requestData("GET", "/cluster/nextid");
  }

  async _waitForTask(upid) {
    if (!upid) return;
    for (let i = 0; i < 120; i++) {
      const status = await this._requestData(
        "GET",
        `/nodes/${this.node}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (status?.status === "stopped") {
        if (status.exitstatus && status.exitstatus !== "OK") {
          throw new Error(`Proxmox task failed: ${status.exitstatus}`);
        }
        return;
      }
      await sleep(1000);
    }
    throw new Error("Timed out waiting for Proxmox task");
  }

  _sshExec(command, { timeout = 120000 } = {}) {
    this._assertConfigured();
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let timer = null;
      conn
        .on("ready", () => {
          timer = setTimeout(() => {
            conn.end();
            reject(new Error(`SSH command timed out after ${timeout}ms`));
          }, timeout);
          conn.exec(command, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              conn.end();
              reject(err);
              return;
            }
            let stdout = "";
            let stderr = "";
            stream.on("data", (chunk) => {
              stdout += chunk.toString();
            });
            stream.stderr.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            stream.on("close", (code) => {
              clearTimeout(timer);
              conn.end();
              if (code !== 0) {
                reject(
                  new Error(stderr.trim() || stdout.trim() || `SSH command exited with ${code}`),
                );
                return;
              }
              resolve({ stdout, stderr, code });
            });
          });
        })
        .on("error", reject)
        .connect(this._sshConfig());
    });
  }

  _pctExec(vmid, command, options = {}) {
    return this._sshExec(
      `${this.sudoPrefix}${this.pctCommand} exec ${vmid} -- /bin/sh -lc ${shellSingleQuote(command)}`,
      options,
    );
  }

  async _writeFile(vmid, path, content, mode = "0644") {
    const encoded = Buffer.from(content).toString("base64");
    await this._pctExec(
      vmid,
      `mkdir -p ${shellSingleQuote(require("path").posix.dirname(path))} && ` +
        `printf '%s' ${shellSingleQuote(encoded)} | base64 -d > ${shellSingleQuote(path)} && ` +
        `chmod ${mode} ${shellSingleQuote(path)}`,
    );
  }

  _templateFor(runtimeFamily, sandboxProfile, image) {
    if (image && !String(image).startsWith("http")) return String(image);
    if (runtimeFamily === "hermes") {
      if (!this.hermesTemplate)
        throw new Error("Hermes on Proxmox requires PROXMOX_HERMES_TEMPLATE");
      return this.hermesTemplate;
    }
    if (sandboxProfile === "nemoclaw") {
      if (!this.nemoClawTemplate)
        throw new Error("NemoClaw on Proxmox requires PROXMOX_NEMOCLAW_TEMPLATE");
      return this.nemoClawTemplate;
    }
    return this.template;
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
      runtimeFamily = "openclaw",
      sandboxProfile = "standard",
    } = config;
    this._assertConfigured();
    const vmid = await this._getNextVmid();
    const hostname = safeHostname(container_name || name, `nora-${runtimeFamily}-${id}`);
    const template = this._templateFor(runtimeFamily, sandboxProfile, image);
    const rootfsSize = Math.max(1, Number.parseInt(disk_gb || "20", 10) || 20);

    console.log(`[proxmox] Creating LXC ${hostname} (vmid=${vmid}) on node ${this.node}`);
    const createTask = await this._requestData("POST", `/nodes/${this.node}/lxc`, {
      vmid,
      hostname,
      ostemplate: template,
      cores: vcpu || 2,
      memory: ram_mb || 2048,
      swap: 512,
      rootfs: `${this.rootfsStorage}:${rootfsSize}`,
      net0: `name=eth0,bridge=${this.bridge},ip=dhcp`,
      start: 0,
      unprivileged: 1,
      description: `Nora ${runtimeFamily} agent ${name || id}`,
    });
    await this._waitForTask(createTask);

    try {
      const startTask = await this._requestData(
        "POST",
        `/nodes/${this.node}/lxc/${vmid}/status/start`,
      );
      await this._waitForTask(startTask);
      const host = await this._waitForIp(vmid);
      const result =
        runtimeFamily === "hermes"
          ? await this._bootstrapHermes(vmid, { id, env })
          : await this._bootstrapOpenClaw(vmid, { id, env, templatePayload, sandboxProfile });
      console.log(`[proxmox] LXC ${vmid} started at ${host}`);
      return {
        containerId: String(vmid),
        containerName: hostname,
        host,
        runtimeHost: host,
        ...result,
      };
    } catch (error) {
      try {
        await this.destroy(String(vmid));
      } catch {
        // Best-effort cleanup only.
      }
      throw error;
    }
  }

  async _waitForIp(vmid) {
    for (let i = 0; i < 60; i++) {
      try {
        const interfaces = await this._requestData(
          "GET",
          `/nodes/${this.node}/lxc/${vmid}/interfaces`,
        );
        const eth0 = (interfaces || []).find((iface) => iface.name === "eth0");
        const inet = eth0?.inet || eth0?.["inet"];
        if (inet) return String(inet).split("/")[0];
      } catch {
        // Guest agent interface endpoint may not be ready yet.
      }
      await sleep(2000);
    }
    throw new Error(`Timed out waiting for LXC ${vmid} DHCP address`);
  }

  async _bootstrapOpenClaw(
    vmid,
    { id, env = {}, templatePayload = {}, sandboxProfile = "standard" },
  ) {
    const gatewayToken = crypto.randomBytes(32).toString("hex");
    const pairedJson = derivePairedDevice(gatewayToken);
    const isNemoClaw = sandboxProfile === "nemoclaw";
    const runtimeEnv = {
      ...(env || {}),
      ...buildRuntimeEnv(),
      OPENCLAW_CLI_PATH: isNemoClaw ? "/usr/bin/openclaw" : "/usr/local/bin/openclaw",
      OPENCLAW_TSX_BIN: isNemoClaw ? "/usr/bin/tsx" : "/usr/local/bin/tsx",
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      ...(isNemoClaw
        ? {
            HOME: "/sandbox",
            NEMOCLAW_MODEL: env.NEMOCLAW_MODEL || getNemoClawDefaultModel(process.env),
            ...(process.env.NVIDIA_API_KEY && !env.NVIDIA_API_KEY
              ? { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY }
              : {}),
          }
        : {}),
    };
    const runtimeFiles = buildRuntimeBootstrapFiles().map(({ relPath, source }) => ({
      path: `/opt/openclaw-runtime/lib/${relPath}`,
      content: source,
      mode: "0644",
    }));
    const templateFiles = buildTemplatePayloadBootstrapFiles(templatePayload).map((file) => ({
      path: `/${file.name}`,
      content: Buffer.isBuffer(file.content) ? file.content : String(file.content || ""),
      mode: (file.mode || 0o644).toString(8).padStart(4, "0"),
    }));
    for (const file of [...runtimeFiles, ...templateFiles]) {
      await this._writeFile(vmid, file.path, file.content, file.mode);
    }
    await this._writeFile(
      vmid,
      "/usr/local/bin/nora-integration-tool",
      buildIntegrationToolWrapperScript(),
      "0755",
    );
    const buildAuthScript =
      "var m={ANTHROPIC_API_KEY:'anthropic',OPENAI_API_KEY:'openai',GEMINI_API_KEY:'google',GROQ_API_KEY:'groq',MISTRAL_API_KEY:'mistral',DEEPSEEK_API_KEY:'deepseek',OPENROUTER_API_KEY:'openrouter',TOGETHER_API_KEY:'together',COHERE_API_KEY:'cohere',XAI_API_KEY:'xai',MOONSHOT_API_KEY:'moonshot',ZAI_API_KEY:'zai',OLLAMA_API_KEY:'ollama',MINIMAX_API_KEY:'minimax',COPILOT_GITHUB_TOKEN:'github-copilot',HF_TOKEN:'huggingface',CEREBRAS_API_KEY:'cerebras',NVIDIA_API_KEY:'nvidia',MICROSOFT_FOUNDRY_API_KEY:'microsoft-foundry'},e={NVIDIA_API_KEY:'https://integrate.api.nvidia.com/v1'},f={MICROSOFT_FOUNDRY_API_KEY:'MICROSOFT_FOUNDRY_BASE_URL'},av={MICROSOFT_FOUNDRY_API_KEY:'MICROSOFT_FOUNDRY_API_VERSION'},s={version:1,profiles:{},order:{},lastGood:{}};Object.entries(m).forEach(function(x){var k=x[0],p=x[1],v=process.env[k];if(!v)return;var id=p+':default';s.profiles[id]={type:'api_key',provider:p,key:v};if(e[k])s.profiles[id].endpoint=e[k];if(f[k]&&process.env[f[k]])s.profiles[id].endpoint=process.env[f[k]];if(av[k]&&process.env[av[k]])s.profiles[id].api_version=process.env[av[k]];s.order[p]=[id];s.lastGood[p]=id;});require('fs').mkdirSync('/root/.openclaw/agents/main/agent',{recursive:true});require('fs').writeFileSync('/root/.openclaw/agents/main/agent/auth-profiles.json',JSON.stringify(s));require('fs').chmodSync('/root/.openclaw/agents/main/agent/auth-profiles.json',0o600);";
    await this._writeFile(vmid, "/opt/openclaw-runtime/lib/build-auth.js", buildAuthScript, "0644");
    const nemoPolicy = isNemoClaw
      ? [
          "mkdir -p /opt/openclaw",
          `cat <<'__NORA_NEMO_POLICY__' > /opt/openclaw/policy.yaml`,
          JSON.stringify(
            {
              version: "1",
              network: { default: "deny", rules: [] },
              inference: {
                provider: "nvidia-nim",
                endpoint: "https://integrate.api.nvidia.com/v1",
                model: runtimeEnv.NEMOCLAW_MODEL,
              },
            },
            null,
            2,
          ),
          "__NORA_NEMO_POLICY__",
        ].join("\n")
      : "";
    const startupScript = [
      "#!/bin/sh",
      "set -eu",
      ...Object.entries(runtimeEnv).map(
        ([key, value]) => `export ${key}=${shellSingleQuote(value)}`,
      ),
      buildOpenClawInstallCommand(
        isNemoClaw ? ["openclaw@latest", "nemoclaw@latest"] : ["openclaw@latest"],
      ),
      "mkdir -p ~/.openclaw/devices /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent",
      ...buildOpenClawConfigMergeScript({
        gateway: {
          port: OPENCLAW_GATEWAY_PORT,
          bind: "lan",
          mode: "local",
          reload: { mode: "hot" },
          auth: { password: gatewayToken },
        },
        // Register custom OpenAI-compatible providers (Microsoft Foundry) so
        // openclaw resolves model strings like `microsoft-foundry/<deployment>`
        // instead of throwing "Unknown model".
        ...(Object.keys(buildOpenClawCustomProviders(env || {})).length > 0
          ? { models: { providers: buildOpenClawCustomProviders(env || {}) } }
          : {}),
      }),
      "cat <<'__NORA_PAIRED_DEVICES__' > ~/.openclaw/devices/paired.json",
      pairedJson,
      "__NORA_PAIRED_DEVICES__",
      "printf '{}' > ~/.openclaw/devices/pending.json",
      nemoPolicy,
      "touch /var/log/openclaw-agent.log",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 &',
      'if [ ! -f /root/.openclaw/agents/main/agent/auth-profiles.json ]; then "$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/build-auth.js; fi',
      buildOpenClawAuthImportFromFileCommand({ requireCli: true }),
      `exec "$OPENCLAW_CLI_PATH" gateway --port ${OPENCLAW_GATEWAY_PORT}`,
      "",
    ].join("\n");
    await this._writeFile(vmid, "/opt/openclaw-runtime/start.sh", startupScript, "0755");
    await this._writeFile(
      vmid,
      "/etc/systemd/system/nora-openclaw.service",
      [
        "[Unit]",
        "Description=Nora OpenClaw Runtime",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        "Restart=always",
        "RestartSec=5",
        "ExecStart=/opt/openclaw-runtime/start.sh",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n"),
      "0644",
    );
    await this._pctExec(
      vmid,
      "systemctl daemon-reload && systemctl enable --now nora-openclaw.service",
      { timeout: 180000 },
    );
    return {
      gatewayToken,
      runtimePort: AGENT_RUNTIME_PORT,
      gatewayHost: null,
      gatewayPort: OPENCLAW_GATEWAY_PORT,
    };
  }

  async _bootstrapHermes(vmid, { id, env = {} }) {
    const apiServerKey = crypto.randomBytes(32).toString("hex");
    const hermesBin = process.env.PROXMOX_HERMES_BIN || "/opt/hermes/.venv/bin/hermes";
    const runtimeEnv = {
      ...(env || {}),
      HERMES_HOME,
      HOME: `${HERMES_HOME}/home`,
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "0.0.0.0",
      API_SERVER_PORT: String(HERMES_RUNTIME_PORT),
      API_SERVER_KEY: apiServerKey,
      GATEWAY_HEALTH_URL: `http://127.0.0.1:${HERMES_RUNTIME_PORT}`,
      MESSAGING_CWD: HERMES_WORKSPACE,
      TERMINAL_CWD: HERMES_WORKSPACE,
    };
    const startupScript = [
      "#!/bin/sh",
      "set -eu",
      ...Object.entries(runtimeEnv).map(
        ([key, value]) => `export ${key}=${shellSingleQuote(value)}`,
      ),
      `HERMES_BIN=${shellSingleQuote(hermesBin)}`,
      '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes)"',
      `mkdir -p ${HERMES_WORKSPACE} ${HERMES_HOME}/home /var/log/nora`,
      `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --insecure --no-open >> /var/log/nora/hermes-dashboard.log 2>&1 &`,
      'exec "$HERMES_BIN" gateway run',
      "",
    ].join("\n");
    await this._writeFile(vmid, "/opt/nora-hermes/start.sh", startupScript, "0755");
    await this._writeFile(
      vmid,
      "/etc/systemd/system/nora-hermes.service",
      [
        "[Unit]",
        "Description=Nora Hermes Runtime",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        "Restart=always",
        "RestartSec=5",
        systemdEnvironmentLines(runtimeEnv),
        "ExecStart=/opt/nora-hermes/start.sh",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
      "0644",
    );
    await this._pctExec(
      vmid,
      "systemctl daemon-reload && systemctl enable --now nora-hermes.service",
      { timeout: 180000 },
    );
    return {
      gatewayToken: apiServerKey,
      runtimePort: HERMES_RUNTIME_PORT,
      dashboardPort: HERMES_DASHBOARD_PORT,
    };
  }

  async destroy(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Destroying LXC ${vmid}`);
    try {
      const stopTask = await this._requestData(
        "POST",
        `/nodes/${this.node}/lxc/${vmid}/status/stop`,
      );
      await this._waitForTask(stopTask);
    } catch {
      // Already stopped or missing.
    }
    await this._waitForTask(await this._requestData("DELETE", `/nodes/${this.node}/lxc/${vmid}`));
    console.log(`[proxmox] LXC ${vmid} deleted`);
  }

  async status(containerId) {
    const vmid = containerId;
    try {
      const data = await this._requestData("GET", `/nodes/${this.node}/lxc/${vmid}/status/current`);
      return {
        running: data.status === "running",
        uptime: data.uptime || 0,
        cpu: data.cpu || 0,
        memory: data.mem || 0,
      };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
  }

  async stats(containerId) {
    try {
      const data = await this._requestData(
        "GET",
        `/nodes/${this.node}/lxc/${containerId}/status/current`,
      );
      const cpuPercent = typeof data?.cpu === "number" ? roundMetric(data.cpu * 100) : null;
      const memoryUsageMb = bytesToMegabytes(data?.mem, 0);
      const memoryLimitMb = bytesToMegabytes(data?.maxmem, 0);
      const memoryPercent =
        typeof data?.mem === "number" && typeof data?.maxmem === "number" && data.maxmem > 0
          ? roundMetric((data.mem / data.maxmem) * 100)
          : null;
      return buildTelemetry({
        backendType: "proxmox",
        capabilities: {
          cpu: cpuPercent != null,
          memory: memoryUsageMb != null || memoryLimitMb != null,
          network: data?.netin != null || data?.netout != null,
          disk: data?.diskread != null || data?.diskwrite != null,
          pids: data?.pid != null || data?.pids != null,
        },
        current: {
          recorded_at: new Date().toISOString(),
          running: data?.status === "running",
          uptime_seconds: data?.status === "running" ? (toFiniteInteger(data?.uptime) ?? 0) : 0,
          cpu_percent: cpuPercent,
          memory_usage_mb: memoryUsageMb,
          memory_limit_mb: memoryLimitMb,
          memory_percent: memoryPercent,
          network_rx_mb: bytesToMegabytes(data?.netin),
          network_tx_mb: bytesToMegabytes(data?.netout),
          disk_read_mb: bytesToMegabytes(data?.diskread),
          disk_write_mb: bytesToMegabytes(data?.diskwrite),
          pids: toFiniteInteger(data?.pid ?? data?.pids),
        },
      });
    } catch {
      return buildUnavailableTelemetry({
        backendType: "proxmox",
        running: false,
        capabilities: PROXMOX_DEFAULT_CAPABILITIES,
      });
    }
  }

  async stop(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Stopping LXC ${vmid}`);
    await this._waitForTask(
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/shutdown`, {
        timeout: 30,
      }),
    );
  }

  async start(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Starting LXC ${vmid}`);
    await this._waitForTask(
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/start`),
    );
  }

  async restart(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Restarting LXC ${vmid}`);
    await this._waitForTask(
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/reboot`),
    );
  }

  async logs(containerId, opts = {}) {
    const tail = Number.parseInt(opts.tail || "100", 10) || 100;
    const follow = opts.follow !== false ? "-f" : "";
    const quotedId = shellSingleQuote(String(containerId));
    const command = `${this.sudoPrefix}${this.pctCommand} exec ${quotedId} -- journalctl -u nora-openclaw.service -u nora-hermes.service -n ${tail} ${follow} --no-pager`;
    return this._sshStream(command);
  }

  _sshStream(command) {
    this._assertConfigured();
    const output = new PassThrough();
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            output.destroy(err);
            conn.end();
            return;
          }
          stream.on("data", (chunk) => output.write(chunk));
          stream.stderr.on("data", (chunk) => output.write(chunk));
          stream.on("close", () => {
            output.end();
            conn.end();
          });
        });
      })
      .on("error", (error) => output.destroy(error))
      .connect(this._sshConfig());
    output.on("close", () => conn.end());
    return output;
  }

  async exec(containerId, opts = {}) {
    this._assertConfigured();
    const cmd = opts.cmd || [
      "/bin/sh",
      "-lc",
      "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
    ];
    const shellCommand = Array.isArray(cmd)
      ? cmd.map((arg) => shellSingleQuote(arg)).join(" ")
      : String(cmd);
    const command = `${this.sudoPrefix}${this.pctCommand} exec ${containerId} -- ${shellCommand}`;
    const stream = this._sshStream(command);
    const state = { Running: true, ExitCode: null };
    stream.on("end", () => {
      state.Running = false;
      if (state.ExitCode == null) state.ExitCode = 0;
    });
    stream.on("error", () => {
      state.Running = false;
      state.ExitCode = 1;
    });
    return {
      exec: {
        inspect: async () => state,
        resize: async () => {},
      },
      stream,
    };
  }
}

module.exports = ProxmoxBackend;
