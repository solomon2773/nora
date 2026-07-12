// @ts-nocheck
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const { Client } = require("ssh2");
const { PassThrough } = require("stream");
const { URL } = require("url");
const ProvisionerBackend = require("./interface");
const {
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawInstallCommand,
  buildMcpServersConfig,
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
const {
  getProxmoxConfigIssue,
  getProxmoxProductionSecurityIssue,
} = require("../../../agent-runtime/lib/backendCatalog");
const {
  HERMES_MANAGED_ENV_ENV,
  buildHermesManagedEnvBlock,
  buildHermesRuntimeConfigBootstrapCommand,
} = require("../../../agent-runtime/lib/hermesRuntimeBootstrap");
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
const OPENCLAW_ENV_FILE = "/etc/nora/openclaw.env.b64";
const OPENCLAW_GATEWAY_CONFIG_FILE = "/etc/nora/openclaw-gateway-config.json";
const OPENCLAW_CUSTOM_PROVIDERS_FILE = "/etc/nora/openclaw-custom-providers.json";
const HERMES_ENV_FILE = `${HERMES_HOME}/.nora-system-env.b64`;
const PROXMOX_NEMOCLAW_UNSUPPORTED =
  "NemoClaw on Proxmox is not supported: writing a policy file inside an LXC does not provide the enforced OpenShell sandbox contract.";
const PROXMOX_AGENT_OWNERSHIP_MARKER_PREFIX = "nora-agent:";
const PROXMOX_CREATE_OWNERSHIP_MARKER_PREFIX = "nora-owner:";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROXMOX_TEMPLATE_RE = /^[A-Za-z0-9_.-]+:vztmpl\/[A-Za-z0-9._+~-]+\.tar\.zst$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(signal, stage = "Proxmox operation") {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        typeof signal.reason === "string" && signal.reason ? signal.reason : `${stage} aborted`,
      );
}

function throwIfAborted(signal, stage) {
  const error = abortError(signal, stage);
  if (error) throw error;
}

function abortableSleep(ms, signal, stage) {
  throwIfAborted(signal, stage);
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal, stage));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function normalizeVmid(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error("Proxmox VMID must be numeric");
  const vmid = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999999999) {
    throw new Error("Proxmox VMID must be between 100 and 999999999");
  }
  return String(vmid);
}

function normalizeTail(value) {
  const parsed = Number.parseInt(String(value ?? "100"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10000) : 100;
}

function normalizeEnv(env = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!ENV_NAME_RE.test(String(key))) {
      throw new Error(`Invalid runtime environment variable name: ${key}`);
    }
    const stringValue = String(value ?? "");
    if (stringValue.includes("\0")) {
      throw new Error(`Runtime environment variable ${key} contains a NUL byte`);
    }
    normalized[String(key)] = stringValue;
  }
  return normalized;
}

function serializeEnvironment(env = {}) {
  return `${Object.entries(normalizeEnv(env))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${Buffer.from(value, "utf8").toString("base64")}`)
    .join("\n")}\n`;
}

function environmentLoaderLines(filePath) {
  return [
    `NORA_ENV_FILE=${shellSingleQuote(filePath)}`,
    'if [ -f "$NORA_ENV_FILE" ]; then',
    "  while IFS='=' read -r nora_key nora_value_b64; do",
    '    [ -n "$nora_key" ] || continue',
    '    case "$nora_key" in *[!A-Za-z0-9_]*|[0-9]*) echo "Invalid Nora env key" >&2; exit 1;; esac',
    '    nora_value="$(printf \'%s\' "$nora_value_b64" | base64 -d)"',
    '    export "$nora_key=$nora_value"',
    '  done < "$NORA_ENV_FILE"',
    "fi",
    "unset nora_key nora_value_b64 nora_value NORA_ENV_FILE",
  ];
}

function openClawManagedConfigMergeLines(filePath, { removeAfter = false, replaceKeys = [] } = {}) {
  const normalizedReplaceKeys = Array.isArray(replaceKeys)
    ? replaceKeys.map((key) => String(key)).filter(Boolean)
    : [];
  return [
    `if [ -f ${shellSingleQuote(filePath)} ]; then`,
    "node <<'__NORA_PROXMOX_MANAGED_CONFIG__'",
    "const fs = require('fs');",
    "const path = require('path');",
    "const configPath = '/root/.openclaw/openclaw.json';",
    `const managedPath = ${JSON.stringify(filePath)};`,
    `const replaceKeys = new Set(${JSON.stringify(normalizedReplaceKeys)});`,
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
    "function mergeConfig(current, managed) {",
    "  if (!isPlainObject(managed)) return managed;",
    "  const next = isPlainObject(current) ? { ...current } : {};",
    "  for (const [key, value] of Object.entries(managed)) {",
    "    if (replaceKeys.has(key)) {",
    "      if (isPlainObject(value) && Object.keys(value).length === 0) delete next[key];",
    "      else next[key] = value;",
    "      continue;",
    "    }",
    "    next[key] = isPlainObject(value) ? mergeConfig(next[key], value) : value;",
    "  }",
    "  return next;",
    "}",
    "let current = {};",
    "try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}",
    "const managed = JSON.parse(fs.readFileSync(managedPath, 'utf8'));",
    "const next = mergeConfig(current, managed);",
    "fs.mkdirSync(path.dirname(configPath), { recursive: true });",
    "fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\\n');",
    "fs.chmodSync(configPath, 0o600);",
    "__NORA_PROXMOX_MANAGED_CONFIG__",
    ...(removeAfter ? [`rm -f ${shellSingleQuote(filePath)}`] : []),
    "fi",
  ];
}

function normalizeFingerprint(value) {
  return String(value || "")
    .trim()
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "");
}

function keyFingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isProxmoxTemplateRef(value) {
  return PROXMOX_TEMPLATE_RE.test(String(value || "").trim());
}

function isMissingResourceError(error) {
  return (
    error?.statusCode === 404 ||
    /(?:does not exist|no such|not found|unable to find configuration file)/i.test(
      String(error?.message || ""),
    )
  );
}

function isDefinitiveCreateRejection(error) {
  const statusCode = Number(error?.statusCode);
  return (
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500 &&
    ![408, 425, 429].includes(statusCode)
  );
}

function normalizeAgentId(value) {
  const agentId = String(value ?? "").trim();
  if (!agentId) {
    const error = new Error("Proxmox operations require a non-empty agentId ownership option");
    error.code = "PROXMOX_AGENT_ID_REQUIRED";
    error.statusCode = 400;
    throw error;
  }
  return agentId;
}

function buildAgentOwnershipMarker(agentId) {
  const digest = crypto
    .createHash("sha256")
    .update(`nora:proxmox:agent:${normalizeAgentId(agentId)}`, "utf8")
    .digest("hex");
  return `${PROXMOX_AGENT_OWNERSHIP_MARKER_PREFIX}v1:${digest}`;
}

function buildCreateOwnershipMarker() {
  return `${PROXMOX_CREATE_OWNERSHIP_MARKER_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
}

function descriptionHasUniqueMarker(description, marker, prefix) {
  const markers = String(description || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  return markers.length === 1 && timingSafeEqualText(markers[0], marker);
}

function descriptionHasOwnershipMarkers(
  description,
  agentOwnershipMarker,
  createOwnershipMarker = null,
) {
  const hasAgentMarker = descriptionHasUniqueMarker(
    description,
    agentOwnershipMarker,
    PROXMOX_AGENT_OWNERSHIP_MARKER_PREFIX,
  );
  if (!hasAgentMarker || !createOwnershipMarker) return hasAgentMarker;
  return descriptionHasUniqueMarker(
    description,
    createOwnershipMarker,
    PROXMOX_CREATE_OWNERSHIP_MARKER_PREFIX,
  );
}

function ownershipMismatchError(vmid, agentId, operation) {
  const error = new Error(
    `Refusing to ${operation} Proxmox LXC ${vmid}: Nora ownership does not match agent ${agentId}`,
  );
  error.code = "PROXMOX_RUNTIME_OWNERSHIP_MISMATCH";
  error.statusCode = 409;
  error.containerId = String(vmid);
  return error;
}

function missingLxcError(vmid, operation) {
  const error = new Error(`Cannot ${operation} Proxmox LXC ${vmid}: the LXC does not exist`);
  error.code = "PROXMOX_RUNTIME_NOT_FOUND";
  error.statusCode = 404;
  error.containerId = String(vmid);
  return error;
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
    this.rootfsStorage = process.env.PROXMOX_ROOTFS_STORAGE || "local-lvm";
    this.bridge = process.env.PROXMOX_BRIDGE || "vmbr0";
    this.timeoutMs = 60000;
    this.sshHost = process.env.PROXMOX_SSH_HOST;
    this.sshUser = process.env.PROXMOX_SSH_USER;
    this.sshPort = Number(process.env.PROXMOX_SSH_PORT || "22");
    this.pctCommand = process.env.PROXMOX_PCT_COMMAND || "pct";
    this.sudoPrefix = process.env.PROXMOX_SUDO || (this.sshUser === "root" ? "" : "sudo -n ");
  }

  _apiBaseUrl() {
    const productionSecurityIssue = getProxmoxProductionSecurityIssue(process.env);
    if (productionSecurityIssue) throw new Error(productionSecurityIssue);
    let url;
    try {
      url = new URL(String(this.baseUrl || ""));
    } catch {
      throw new Error("PROXMOX_API_URL must be a valid URL");
    }
    const allowHttp = process.env.PROXMOX_ALLOW_INSECURE_HTTP === "true";
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
      throw new Error(
        "PROXMOX_API_URL must use HTTPS (set PROXMOX_ALLOW_INSECURE_HTTP=true only for an isolated test environment)",
      );
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        "PROXMOX_API_URL must not contain credentials, query parameters, or a fragment",
      );
    }
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath) {
      url.pathname = "/api2/json/";
    } else if (normalizedPath === "/api2/json") {
      url.pathname = "/api2/json/";
    } else {
      throw new Error("PROXMOX_API_URL must point to the Proxmox origin or end in /api2/json");
    }
    return url;
  }

  _readOptionalFile(inlineValue, filePath, label) {
    if (inlineValue) return String(inlineValue).replace(/\\n/g, "\n");
    if (!filePath) return null;
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`${label} could not be read: ${error.message}`);
    }
  }

  _tlsOptions() {
    const productionSecurityIssue = getProxmoxProductionSecurityIssue(process.env);
    if (productionSecurityIssue) throw new Error(productionSecurityIssue);
    const verifyTls = String(process.env.PROXMOX_VERIFY_TLS || "true").toLowerCase() !== "false";
    const ca = this._readOptionalFile(
      process.env.PROXMOX_CA_CERT,
      process.env.PROXMOX_CA_CERT_PATH,
      "Proxmox CA certificate",
    );
    return {
      rejectUnauthorized: verifyTls,
      ...(ca ? { ca } : {}),
    };
  }

  _assertConfigured() {
    const issue = getProxmoxConfigIssue(process.env, { readFileSync: fs.readFileSync });
    if (issue) throw new Error(issue);
    this._apiBaseUrl();
  }

  _sshConfig() {
    const productionSecurityIssue = getProxmoxProductionSecurityIssue(process.env);
    if (productionSecurityIssue) throw new Error(productionSecurityIssue);
    const config = {
      host: this.sshHost,
      port: this.sshPort,
      username: this.sshUser,
      readyTimeout: this.timeoutMs,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };
    if (process.env.PROXMOX_SSH_PRIVATE_KEY || process.env.PROXMOX_SSH_PRIVATE_KEY_PATH) {
      config.privateKey = this._readOptionalFile(
        process.env.PROXMOX_SSH_PRIVATE_KEY,
        process.env.PROXMOX_SSH_PRIVATE_KEY_PATH,
        "Proxmox SSH private key",
      );
      if (process.env.PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE) {
        config.passphrase = process.env.PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE;
      }
    } else if (process.env.PROXMOX_SSH_PASSWORD) {
      config.password = process.env.PROXMOX_SSH_PASSWORD;
    }
    const expectedFingerprint = normalizeFingerprint(process.env.PROXMOX_SSH_HOST_FINGERPRINT);
    if (expectedFingerprint) {
      config.hostVerifier = (key) => timingSafeEqualText(keyFingerprint(key), expectedFingerprint);
    }
    return config;
  }

  async _request(method, requestPath, payload, options = {}) {
    if (!this.baseUrl || !this.tokenId || !this.tokenSecret) {
      throw new Error("Proxmox API is not configured");
    }
    const base = this._apiBaseUrl();
    const url = new URL(requestPath.replace(/^\//, ""), base);
    const body =
      payload == null
        ? null
        : new URLSearchParams(
            Object.entries(payload).map(([key, value]) => [key, String(value)]),
          ).toString();
    const headers = {
      Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
    };

    if (body != null) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const transport = url.protocol === "http:" ? http : https;
    const tlsOptions = url.protocol === "https:" ? this._tlsOptions() : {};

    return new Promise((resolve, reject) => {
      throwIfAborted(options.signal, `Proxmox API ${method} ${requestPath}`);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const req = transport.request(
        url,
        {
          method,
          headers,
          ...tlsOptions,
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
                finish(reject, new Error(`Invalid Proxmox response: ${error.message}`));
                return;
              }
            }
            const statusCode = res.statusCode || 500;
            if (statusCode < 200 || statusCode >= 300) {
              const detail = parsed?.errors
                ? JSON.stringify(parsed.errors)
                : parsed?.message || raw || `HTTP ${statusCode}`;
              if (statusCode === 401 || statusCode === 403) {
                const error = new Error(proxmoxAuthErrorMessage(statusCode));
                error.statusCode = statusCode;
                finish(reject, error);
                return;
              }
              const error = new Error(detail);
              error.statusCode = statusCode;
              finish(reject, error);
              return;
            }
            finish(resolve, parsed);
          });
        },
      );
      const onAbort = () =>
        req.destroy(abortError(options.signal, `Proxmox API ${method} ${requestPath}`));
      req.on("timeout", () => req.destroy(new Error("Proxmox API timeout")));
      req.on("error", (error) => finish(reject, error));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      if (body != null) req.write(body);
      req.end();
    });
  }

  async _requestData(method, requestPath, payload, options = {}) {
    const response = await this._request(method, requestPath, payload, options);
    return response?.data;
  }

  async _getNextVmid(options = {}) {
    return normalizeVmid(await this._requestData("GET", "/cluster/nextid", null, options));
  }

  async _waitForTask(upid, options = {}) {
    if (!upid) return;
    for (let i = 0; i < 120; i++) {
      const status = await this._requestData(
        "GET",
        `/nodes/${this.node}/tasks/${encodeURIComponent(upid)}/status`,
        null,
        options,
      );
      if (status?.status === "stopped") {
        if (status.exitstatus && status.exitstatus !== "OK") {
          throw new Error(`Proxmox task failed: ${status.exitstatus}`);
        }
        return;
      }
      await abortableSleep(1000, options.signal, "waiting for Proxmox task");
    }
    throw new Error("Timed out waiting for Proxmox task");
  }

  _sshExec(command, { timeout = 120000, signal, input = null } = {}) {
    this._assertConfigured();
    return new Promise((resolve, reject) => {
      throwIfAborted(signal, "Proxmox SSH command");
      const conn = new Client();
      let timer = null;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        conn.end();
        callback(value);
      };
      const onAbort = () => finish(reject, abortError(signal, "Proxmox SSH command"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      conn
        .on("ready", () => {
          timer = setTimeout(() => {
            finish(reject, new Error(`SSH command timed out after ${timeout}ms`));
          }, timeout);
          conn.exec(command, (err, stream) => {
            if (err) {
              finish(reject, err);
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
              if (code !== 0) {
                finish(
                  reject,
                  new Error(stderr.trim() || stdout.trim() || `SSH command exited with ${code}`),
                );
                return;
              }
              finish(resolve, { stdout, stderr, code });
            });
            if (input != null) {
              stream.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input)));
            }
          });
        })
        .on("error", (error) => finish(reject, error))
        .connect(this._sshConfig());
    });
  }

  _pctExec(vmid, command, options = {}) {
    const normalizedVmid = normalizeVmid(vmid);
    return this._sshExec(
      `${this.sudoPrefix}${this.pctCommand} exec ${normalizedVmid} -- /bin/sh -lc ${shellSingleQuote(command)}`,
      options,
    );
  }

  async _writeFile(vmid, targetPath, content, mode = "0644", options = {}) {
    if (!/^[0-7]{3,4}$/.test(String(mode))) {
      throw new Error(`Invalid file mode: ${mode}`);
    }
    const temporaryPath = `${targetPath}.nora-${crypto.randomBytes(8).toString("hex")}.tmp`;
    await this._pctExec(
      vmid,
      `mkdir -p ${shellSingleQuote(path.posix.dirname(targetPath))} && ` +
        `temporary=${shellSingleQuote(temporaryPath)} && ` +
        `trap 'rm -f "$temporary"' EXIT && ` +
        `umask 077 && cat > "$temporary" && ` +
        `chmod ${mode} "$temporary" && ` +
        `mv -f "$temporary" ${shellSingleQuote(targetPath)} && ` +
        `trap - EXIT`,
      {
        ...options,
        input: Buffer.isBuffer(content) ? content : Buffer.from(String(content)),
      },
    );
  }

  _templateFor(runtimeFamily, sandboxProfile, image) {
    if (sandboxProfile === "nemoclaw") {
      throw new Error(PROXMOX_NEMOCLAW_UNSUPPORTED);
    }
    if (!["openclaw", "hermes"].includes(runtimeFamily)) {
      throw new Error(`Unsupported Proxmox runtime family: ${runtimeFamily}`);
    }
    const configuredTemplate = runtimeFamily === "hermes" ? this.hermesTemplate : this.template;
    const template = String(image || configuredTemplate || "").trim();
    if (runtimeFamily === "hermes" && !template) {
      throw new Error("Hermes on Proxmox requires PROXMOX_HERMES_TEMPLATE");
    }
    if (!isProxmoxTemplateRef(template)) {
      throw new Error(
        `Invalid Proxmox LXC template reference: ${template || "(empty)"}. Expected storage:vztmpl/template.tar.zst.`,
      );
    }
    return template;
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
      mcpServers,
      runtimeFamily = "openclaw",
      sandboxProfile = "standard",
      abortSignal,
      onRuntimeIdentity,
    } = config;
    this._assertConfigured();
    throwIfAborted(abortSignal, "Proxmox create");
    const normalizedRuntimeFamily = String(runtimeFamily || "openclaw")
      .trim()
      .toLowerCase();
    const normalizedSandboxProfile = String(sandboxProfile || "standard")
      .trim()
      .toLowerCase();
    const template = this._templateFor(normalizedRuntimeFamily, normalizedSandboxProfile, image);
    const vmid = await this._getNextVmid({ signal: abortSignal });
    const hostname = safeHostname(container_name || name, `nora-${runtimeFamily}-${id}`);
    const rootfsSize = Math.max(1, Number.parseInt(disk_gb || "20", 10) || 20);
    const agentOwnershipMarker = buildAgentOwnershipMarker(id);
    const createOwnershipMarker = buildCreateOwnershipMarker();
    const description = [
      `Nora ${normalizedRuntimeFamily} agent ${name || id}`,
      agentOwnershipMarker,
      createOwnershipMarker,
    ].join("\n");

    console.log(`[proxmox] Creating LXC ${hostname} (vmid=${vmid}) on node ${this.node}`);
    let createAttempted = false;
    let createTaskAccepted = false;
    let createTaskCompleted = false;
    let ownershipConfirmed = false;
    try {
      createAttempted = true;
      const createTask = await this._requestData(
        "POST",
        `/nodes/${this.node}/lxc`,
        {
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
          description,
        },
        { signal: abortSignal },
      );
      createTaskAccepted = true;
      await this._waitForTask(createTask, { signal: abortSignal });
      createTaskCompleted = true;
      ownershipConfirmed = await this._ownsCreatedLxc(String(vmid), agentOwnershipMarker, {
        createOwnershipMarker,
        signal: abortSignal,
      });
      if (!ownershipConfirmed) {
        throw new Error(
          `Proxmox LXC ${vmid} was created but its Nora ownership marker could not be verified`,
        );
      }
      if (typeof onRuntimeIdentity === "function") {
        await onRuntimeIdentity({
          containerId: String(vmid),
          containerName: hostname,
        });
      }
      throwIfAborted(abortSignal, "Proxmox create");
      const startTask = await this._requestData(
        "POST",
        `/nodes/${this.node}/lxc/${vmid}/status/start`,
        null,
        { signal: abortSignal },
      );
      await this._waitForTask(startTask, { signal: abortSignal });
      const host = await this._waitForIp(vmid, { signal: abortSignal });
      const result =
        normalizedRuntimeFamily === "hermes"
          ? await this._bootstrapHermes(vmid, { id, env, signal: abortSignal })
          : await this._bootstrapOpenClaw(vmid, {
              id,
              env,
              templatePayload,
              mcpServers,
              signal: abortSignal,
            });
      console.log(`[proxmox] LXC ${vmid} started at ${host}`);
      return {
        containerId: String(vmid),
        containerName: hostname,
        host,
        runtimeHost: host,
        ...result,
      };
    } catch (error) {
      if (createAttempted) {
        const createOutcomeAmbiguous = createTaskAccepted || !isDefinitiveCreateRejection(error);
        try {
          const cleanup = await this._cleanupFailedCreate(String(vmid), id, createOwnershipMarker, {
            missingIsUnresolved: createOutcomeAmbiguous,
          });
          if ((createTaskCompleted || createOutcomeAmbiguous) && !cleanup.destroyed) {
            const cleanupError = new Error(
              cleanup.reason === "missing-unverified"
                ? `Proxmox create outcome for LXC ${vmid} is ambiguous; refusing to retry without operator reconciliation`
                : `Refusing to delete Proxmox LXC ${vmid} because its Nora ownership marker is no longer present`,
            );
            cleanupError.code = "PROXMOX_RUNTIME_OWNERSHIP_UNVERIFIED";
            cleanupError.containerId = String(vmid);
            cleanupError.runtimeIdentity = {
              containerId: String(vmid),
              destroyAllowed: false,
              persistIdentity: true,
            };
            cleanupError.cause = error;
            throw cleanupError;
          }
        } catch (cleanupError) {
          console.warn(
            `[proxmox] Failed to clean up LXC ${vmid} after create error: ${cleanupError.message}`,
          );
          if (cleanupError?.runtimeIdentity) throw cleanupError;
          const unresolvedError = new Error(
            `Proxmox LXC ${vmid} may still exist after provisioning failed: ${cleanupError.message}`,
          );
          unresolvedError.code = "PROXMOX_RUNTIME_CLEANUP_FAILED";
          unresolvedError.containerId = String(vmid);
          unresolvedError.runtimeIdentity = {
            containerId: String(vmid),
            destroyAllowed: cleanupError?.proxmoxOwnershipVerified === true,
            persistIdentity: createOutcomeAmbiguous || ownershipConfirmed || createTaskCompleted,
          };
          unresolvedError.cause = error;
          unresolvedError.cleanupError = cleanupError;
          throw unresolvedError;
        }
      }
      throw error;
    }
  }

  async _getOwnershipState(vmid, agentOwnershipMarker, options = {}) {
    const normalizedVmid = normalizeVmid(vmid);
    try {
      const config = await this._requestData(
        "GET",
        `/nodes/${this.node}/lxc/${normalizedVmid}/config`,
        null,
        options,
      );
      return descriptionHasOwnershipMarkers(
        config?.description,
        agentOwnershipMarker,
        options.createOwnershipMarker,
      )
        ? "owned"
        : "mismatch";
    } catch (error) {
      if (isMissingResourceError(error)) return "missing";
      throw error;
    }
  }

  async _ownsCreatedLxc(vmid, agentOwnershipMarker, options = {}) {
    return (await this._getOwnershipState(vmid, agentOwnershipMarker, options)) === "owned";
  }

  async _assertOwnedLxc(vmid, options = {}, { allowMissing = false, operation = "access" } = {}) {
    const normalizedVmid = normalizeVmid(vmid);
    const agentId = normalizeAgentId(options.agentId);
    const agentOwnershipMarker = buildAgentOwnershipMarker(agentId);
    const state = await this._getOwnershipState(normalizedVmid, agentOwnershipMarker, {
      ...(options.createOwnershipMarker
        ? { createOwnershipMarker: options.createOwnershipMarker }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (state === "owned") return true;
    if (state === "missing") {
      if (allowMissing) return false;
      throw missingLxcError(normalizedVmid, operation);
    }
    throw ownershipMismatchError(normalizedVmid, agentId, operation);
  }

  async _cleanupFailedCreate(vmid, agentId, createOwnershipMarker, options = {}) {
    let ownershipState;
    try {
      ownershipState = await this._getOwnershipState(vmid, buildAgentOwnershipMarker(agentId), {
        createOwnershipMarker,
      });
    } catch (error) {
      error.proxmoxOwnershipVerified = false;
      throw error;
    }
    if (ownershipState === "missing") {
      if (options.missingIsUnresolved) {
        return { destroyed: false, reason: "missing-unverified" };
      }
      return { destroyed: true, reason: "missing" };
    }
    if (ownershipState !== "owned") {
      return { destroyed: false, reason: "not-owned" };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.destroy(vmid, { agentId, createOwnershipMarker });
        return { destroyed: true };
      } catch (error) {
        // The create nonce is intentionally not persisted in the control plane.
        // If nonce-bound cleanup cannot finish here, later retries that only know
        // the agent id must not be authorized to destroy a possibly reused VMID.
        error.proxmoxOwnershipVerified = false;
        lastError = error;
        if (
          error?.code === "PROXMOX_RUNTIME_OWNERSHIP_MISMATCH" ||
          error?.statusCode === 401 ||
          error?.statusCode === 403
        ) {
          throw error;
        }
        if (attempt < 5) await sleep(2000);
      }
    }
    throw lastError || new Error(`Failed to clean up Proxmox LXC ${vmid}`);
  }

  async _waitForIp(vmid, options = {}) {
    const normalizedVmid = normalizeVmid(vmid);
    for (let i = 0; i < 60; i++) {
      throwIfAborted(options.signal, `waiting for LXC ${normalizedVmid} address`);
      try {
        const interfaces = await this._requestData(
          "GET",
          `/nodes/${this.node}/lxc/${normalizedVmid}/interfaces`,
          null,
          options,
        );
        const eth0 = (interfaces || []).find((iface) => iface.name === "eth0");
        const inet = eth0?.inet || eth0?.["inet"];
        if (inet) return String(inet).split("/")[0];
      } catch (error) {
        if (error?.statusCode === 401 || error?.statusCode === 403) throw error;
        throwIfAborted(options.signal, `waiting for LXC ${normalizedVmid} address`);
        // Guest agent interface endpoint may not be ready yet.
      }
      await abortableSleep(2000, options.signal, `waiting for LXC ${normalizedVmid} address`);
    }
    throw new Error(`Timed out waiting for LXC ${normalizedVmid} DHCP address`);
  }

  async _prepareOpenClawBase(vmid, options = {}) {
    const nodeMajor = Math.max(
      24,
      Number.parseInt(process.env.PROXMOX_NODE_MAJOR || "24", 10) || 24,
    );
    const command = [
      "set -eu",
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -qq",
      "apt-get install -y -qq ca-certificates curl git gnupg",
      `if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= ${nodeMajor} ? 0 : 1)' >/dev/null 2>&1; then`,
      "  install -m 0755 -d /etc/apt/keyrings",
      "  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource-repo.gpg.key",
      "  gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource-repo.gpg.key",
      "  rm -f /tmp/nodesource-repo.gpg.key",
      `  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${nodeMajor}.x nodistro main' > /etc/apt/sources.list.d/nodesource.list`,
      "  apt-get update -qq",
      "  apt-get install -y -qq nodejs",
      "fi",
      `node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < ${nodeMajor}) { throw new Error("Node ${nodeMajor}+ is required") }'`,
      "command -v npm >/dev/null",
      "command -v systemctl >/dev/null",
    ].join("\n");
    await this._pctExec(vmid, command, { timeout: 300000, signal: options.signal });
  }

  async _bootstrapOpenClaw(
    vmid,
    { id, env = {}, templatePayload = {}, mcpServers = [], signal } = {},
  ) {
    await this._prepareOpenClawBase(vmid, { signal });
    throwIfAborted(signal, "OpenClaw Proxmox bootstrap");
    const gatewayToken = crypto.randomBytes(32).toString("hex");
    const pairedJson = derivePairedDevice(gatewayToken);
    const managedMcpServers = buildMcpServersConfig(mcpServers);
    const runtimeEnv = normalizeEnv({
      ...(env || {}),
      ...buildRuntimeEnv(),
      OPENCLAW_CLI_PATH: "/usr/local/bin/openclaw",
      OPENCLAW_TSX_BIN: "/usr/local/bin/tsx",
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    });
    await this._writeFile(vmid, OPENCLAW_ENV_FILE, serializeEnvironment(runtimeEnv), "0600", {
      signal,
    });
    await this._writeFile(
      vmid,
      OPENCLAW_GATEWAY_CONFIG_FILE,
      `${JSON.stringify(
        {
          gateway: {
            port: OPENCLAW_GATEWAY_PORT,
            bind: "lan",
            mode: "local",
            reload: { mode: "hot" },
            auth: { password: gatewayToken },
          },
          // Nora owns this block. An empty object deliberately removes MCP
          // entries baked into a prepared template; a populated object is the
          // worker's credential-resolved per-agent selection.
          mcpServers: managedMcpServers,
        },
        null,
        2,
      )}\n`,
      "0600",
      { signal },
    );
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
      throwIfAborted(signal, "OpenClaw Proxmox bootstrap");
      await this._writeFile(vmid, file.path, file.content, file.mode, { signal });
    }
    await this._writeFile(
      vmid,
      "/usr/local/bin/nora-integration-tool",
      buildIntegrationToolWrapperScript(),
      "0755",
      { signal },
    );
    await this._writeFile(vmid, "/root/.openclaw/devices/paired.json", pairedJson, "0600", {
      signal,
    });
    await this._writeFile(vmid, "/root/.openclaw/devices/pending.json", "{}\n", "0600", { signal });
    const buildAuthScript =
      "var m={ANTHROPIC_API_KEY:'anthropic',OPENAI_API_KEY:'openai',GEMINI_API_KEY:'google',GROQ_API_KEY:'groq',MISTRAL_API_KEY:'mistral',DEEPSEEK_API_KEY:'deepseek',OPENROUTER_API_KEY:'openrouter',TOGETHER_API_KEY:'together',COHERE_API_KEY:'cohere',XAI_API_KEY:'xai',MOONSHOT_API_KEY:'moonshot',ZAI_API_KEY:'zai',OLLAMA_API_KEY:'ollama',MINIMAX_API_KEY:'minimax',COPILOT_GITHUB_TOKEN:'github-copilot',HF_TOKEN:'huggingface',CEREBRAS_API_KEY:'cerebras',NVIDIA_API_KEY:'nvidia',MICROSOFT_FOUNDRY_API_KEY:'microsoft-foundry'},e={NVIDIA_API_KEY:'https://integrate.api.nvidia.com/v1'},f={MICROSOFT_FOUNDRY_API_KEY:'MICROSOFT_FOUNDRY_BASE_URL'},av={MICROSOFT_FOUNDRY_API_KEY:'MICROSOFT_FOUNDRY_API_VERSION'},s={version:1,profiles:{},order:{},lastGood:{}};Object.entries(m).forEach(function(x){var k=x[0],p=x[1],v=process.env[k];if(!v)return;var id=p+':default';s.profiles[id]={type:'api_key',provider:p,key:v};if(e[k])s.profiles[id].endpoint=e[k];if(f[k]&&process.env[f[k]])s.profiles[id].endpoint=process.env[f[k]];if(av[k]&&process.env[av[k]])s.profiles[id].api_version=process.env[av[k]];s.order[p]=[id];s.lastGood[p]=id;});require('fs').mkdirSync('/root/.openclaw/agents/main/agent',{recursive:true});require('fs').writeFileSync('/root/.openclaw/agents/main/agent/auth-profiles.json',JSON.stringify(s));require('fs').chmodSync('/root/.openclaw/agents/main/agent/auth-profiles.json',0o600);";
    await this._writeFile(
      vmid,
      "/opt/openclaw-runtime/lib/build-auth.js",
      buildAuthScript,
      "0600",
      { signal },
    );
    const openClawPackage =
      process.env.PROXMOX_OPENCLAW_PACKAGE ||
      process.env.OPENCLAW_DOCKER_PACKAGE ||
      "openclaw@latest";
    const customProviders = buildOpenClawCustomProviders(env || {});
    if (Object.keys(customProviders).length > 0) {
      await this._writeFile(
        vmid,
        OPENCLAW_CUSTOM_PROVIDERS_FILE,
        `${JSON.stringify({ models: { providers: customProviders } }, null, 2)}\n`,
        "0600",
        { signal },
      );
    }
    const startupScript = [
      "#!/bin/sh",
      "set -eu",
      ...environmentLoaderLines(OPENCLAW_ENV_FILE),
      buildOpenClawInstallCommand([openClawPackage]),
      "mkdir -p ~/.openclaw/devices /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent",
      ...openClawManagedConfigMergeLines(OPENCLAW_GATEWAY_CONFIG_FILE, {
        replaceKeys: ["mcpServers"],
      }),
      "if [ ! -f /root/.openclaw/.nora-proxmox-bootstrap-complete ]; then",
      // Register provision-time custom providers once. Live auth sync owns
      // later provider changes; replaying the original env on every restart
      // would overwrite a rotated Foundry endpoint or deployment.
      ...(Object.keys(customProviders).length > 0
        ? openClawManagedConfigMergeLines(OPENCLAW_CUSTOM_PROVIDERS_FILE, {
            removeAfter: true,
          })
        : []),
      "  touch /root/.openclaw/.nora-proxmox-bootstrap-complete",
      "fi",
      "touch /var/log/openclaw-agent.log",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 &',
      'if [ ! -f /root/.openclaw/agents/main/agent/auth-profiles.json ]; then "$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/build-auth.js; fi',
      buildOpenClawAuthImportFromFileCommand({ requireCli: true }),
      `exec "$OPENCLAW_CLI_PATH" gateway --port ${OPENCLAW_GATEWAY_PORT}`,
      "",
    ].join("\n");
    await this._writeFile(vmid, "/opt/openclaw-runtime/start.sh", startupScript, "0700", {
      signal,
    });
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
        "UMask=0077",
        "NoNewPrivileges=true",
        "TimeoutStopSec=30",
        "ExecStart=/opt/openclaw-runtime/start.sh",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n"),
      "0644",
      { signal },
    );
    await this._pctExec(
      vmid,
      "systemctl daemon-reload && systemctl enable --now nora-openclaw.service",
      { timeout: 180000, signal },
    );
    return {
      gatewayToken,
      runtimePort: AGENT_RUNTIME_PORT,
      gatewayHost: null,
      gatewayPort: OPENCLAW_GATEWAY_PORT,
    };
  }

  async _prepareHermesBase(vmid, hermesBin, options = {}) {
    await this._pctExec(
      vmid,
      [
        "set -eu",
        "command -v systemctl >/dev/null",
        "command -v base64 >/dev/null",
        "id hermes >/dev/null 2>&1",
        `test -x ${shellSingleQuote(hermesBin)} || command -v hermes >/dev/null`,
        `install -d -m 0750 -o hermes -g hermes ${HERMES_HOME} ${HERMES_HOME}/home ${HERMES_WORKSPACE} /var/log/nora`,
      ].join("\n"),
      { timeout: 120000, signal: options.signal },
    );
  }

  async _bootstrapHermes(vmid, { id, env = {}, signal } = {}) {
    const apiServerKey = crypto.randomBytes(32).toString("hex");
    const hermesBin = process.env.PROXMOX_HERMES_BIN || "/opt/hermes/.venv/bin/hermes";
    await this._prepareHermesBase(vmid, hermesBin, { signal });
    const inputEnv = normalizeEnv(env || {});
    const managedEnv = Object.fromEntries(
      Object.entries(inputEnv).filter(([key]) => !key.startsWith("NORA_HERMES_")),
    );
    const managedBlock = buildHermesManagedEnvBlock(managedEnv);
    const runtimeEnv = normalizeEnv({
      HERMES_HOME,
      HOME: `${HERMES_HOME}/home`,
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "0.0.0.0",
      API_SERVER_PORT: String(HERMES_RUNTIME_PORT),
      API_SERVER_KEY: apiServerKey,
      GATEWAY_HEALTH_URL: `http://127.0.0.1:${HERMES_RUNTIME_PORT}`,
      MESSAGING_CWD: HERMES_WORKSPACE,
      TERMINAL_CWD: HERMES_WORKSPACE,
      ...(inputEnv.NORA_HERMES_MODEL_CONFIG_B64
        ? { NORA_HERMES_MODEL_CONFIG_B64: inputEnv.NORA_HERMES_MODEL_CONFIG_B64 }
        : {}),
      ...(managedBlock
        ? { [HERMES_MANAGED_ENV_ENV]: Buffer.from(managedBlock, "utf8").toString("base64") }
        : inputEnv[HERMES_MANAGED_ENV_ENV]
          ? { [HERMES_MANAGED_ENV_ENV]: inputEnv[HERMES_MANAGED_ENV_ENV] }
          : {}),
    });
    await this._writeFile(vmid, HERMES_ENV_FILE, serializeEnvironment(runtimeEnv), "0600", {
      signal,
    });
    const dashboardEnabled = process.env.PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD === "true";
    const dashboardHost = dashboardEnabled ? "0.0.0.0" : "127.0.0.1";
    const startupScript = [
      "#!/bin/sh",
      "set -eu",
      ...environmentLoaderLines(HERMES_ENV_FILE),
      `HERMES_BIN=${shellSingleQuote(hermesBin)}`,
      '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes)"',
      `mkdir -p ${HERMES_WORKSPACE} ${HERMES_HOME}/home /var/log/nora`,
      `if [ ! -f ${HERMES_HOME}/.nora-bootstrap-complete ]; then`,
      buildHermesRuntimeConfigBootstrapCommand(),
      `  touch ${HERMES_HOME}/.nora-bootstrap-complete`,
      "fi",
      `nohup "$HERMES_BIN" dashboard --host ${dashboardHost} --insecure --no-open >> /var/log/nora/hermes-dashboard.log 2>&1 &`,
      'exec "$HERMES_BIN" gateway run',
      "",
    ].join("\n");
    await this._writeFile(vmid, "/opt/nora-hermes/start.sh", startupScript, "0750", {
      signal,
    });
    await this._pctExec(
      vmid,
      `chown hermes:hermes ${shellSingleQuote(HERMES_ENV_FILE)} && chown root:hermes /opt/nora-hermes/start.sh`,
      { signal },
    );
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
        "User=hermes",
        "Group=hermes",
        `WorkingDirectory=${HERMES_HOME}`,
        "Restart=always",
        "RestartSec=5",
        "UMask=0077",
        "NoNewPrivileges=true",
        "TimeoutStopSec=30",
        "ExecStart=/opt/nora-hermes/start.sh",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
      "0644",
      { signal },
    );
    await this._pctExec(
      vmid,
      "systemctl daemon-reload && systemctl enable --now nora-hermes.service",
      { timeout: 180000, signal },
    );
    return {
      gatewayToken: apiServerKey,
      runtimePort: HERMES_RUNTIME_PORT,
      dashboardPort: dashboardEnabled ? HERMES_DASHBOARD_PORT : null,
    };
  }

  async destroy(containerId, options = {}) {
    this._assertConfigured();
    const vmid = normalizeVmid(containerId);
    const exists = await this._assertOwnedLxc(vmid, options, {
      allowMissing: true,
      operation: "destroy",
    });
    if (!exists) return;
    console.log(`[proxmox] Destroying LXC ${vmid}`);
    try {
      const stopTask = await this._requestData(
        "POST",
        `/nodes/${this.node}/lxc/${vmid}/status/stop`,
      );
      await this._waitForTask(stopTask);
    } catch (error) {
      if (error?.statusCode === 401 || error?.statusCode === 403) throw error;
      // Already stopped or missing.
    }
    const stillExists = await this._assertOwnedLxc(vmid, options, {
      allowMissing: true,
      operation: "destroy",
    });
    if (!stillExists) return;
    try {
      await this._waitForTask(await this._requestData("DELETE", `/nodes/${this.node}/lxc/${vmid}`));
    } catch (error) {
      if (!isMissingResourceError(error)) throw error;
    }
    console.log(`[proxmox] LXC ${vmid} deleted`);
  }

  async status(containerId, options = {}) {
    this._assertConfigured();
    const vmid = normalizeVmid(containerId);
    const exists = await this._assertOwnedLxc(vmid, options, {
      allowMissing: true,
      operation: "inspect",
    });
    if (!exists) return { running: false, uptime: 0, cpu: null, memory: null };
    try {
      const data = await this._requestData("GET", `/nodes/${this.node}/lxc/${vmid}/status/current`);
      return {
        running: data.status === "running",
        uptime: data.uptime || 0,
        cpu: data.cpu || 0,
        memory: data.mem || 0,
      };
    } catch (error) {
      if (!isMissingResourceError(error)) throw error;
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
  }

  async stats(containerId, options = {}) {
    const vmid = normalizeVmid(containerId);
    try {
      this._assertConfigured();
      const exists = await this._assertOwnedLxc(vmid, options, {
        allowMissing: true,
        operation: "inspect metrics for",
      });
      if (!exists) {
        return buildUnavailableTelemetry({
          backendType: "proxmox",
          running: false,
          capabilities: PROXMOX_DEFAULT_CAPABILITIES,
        });
      }
      const data = await this._requestData("GET", `/nodes/${this.node}/lxc/${vmid}/status/current`);
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
    } catch (error) {
      if (
        error?.code === "PROXMOX_AGENT_ID_REQUIRED" ||
        error?.code === "PROXMOX_RUNTIME_OWNERSHIP_MISMATCH" ||
        error?.statusCode === 401 ||
        error?.statusCode === 403
      ) {
        throw error;
      }
      return buildUnavailableTelemetry({
        backendType: "proxmox",
        running: false,
        capabilities: PROXMOX_DEFAULT_CAPABILITIES,
      });
    }
  }

  async stop(containerId, options = {}) {
    const vmid = normalizeVmid(containerId);
    const current = await this.status(vmid, options);
    if (!current.running) return;
    await this._assertOwnedLxc(vmid, options, { operation: "stop" });
    console.log(`[proxmox] Stopping LXC ${vmid}`);
    await this._waitForTask(
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/shutdown`, {
        timeout: 30,
      }),
    );
  }

  async start(containerId, options = {}) {
    const vmid = normalizeVmid(containerId);
    const current = await this.status(vmid, options);
    if (current.running) {
      await this._assertOwnedLxc(vmid, options, { operation: "read the address of" });
      const host = await this._waitForIp(vmid);
      return { host, runtimeHost: host };
    }
    await this._assertOwnedLxc(vmid, options, { operation: "start" });
    console.log(`[proxmox] Starting LXC ${vmid}`);
    await this._waitForTask(
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/start`),
    );
    await this._assertOwnedLxc(vmid, options, { operation: "read the address of" });
    const host = await this._waitForIp(vmid);
    return { host, runtimeHost: host };
  }

  async restart(containerId, options = {}) {
    const vmid = normalizeVmid(containerId);
    const current = await this.status(vmid, options);
    if (!current.running) return this.start(vmid, options);
    await this._assertOwnedLxc(vmid, options, { operation: "restart" });
    console.log(`[proxmox] Restarting LXC ${vmid}`);
    await this._waitForTask(
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/reboot`),
    );
    await this._assertOwnedLxc(vmid, options, { operation: "read the address of" });
    const host = await this._waitForIp(vmid);
    return { host, runtimeHost: host };
  }

  async updateEnv(containerId, envVars = {}, options = {}) {
    const vmid = normalizeVmid(containerId);
    const entries = normalizeEnv(envVars);
    if (Object.keys(entries).length === 0) return;
    await this._assertOwnedLxc(vmid, options, { operation: "update the environment of" });
    const envFile = options.runtimeFamily === "hermes" ? HERMES_ENV_FILE : OPENCLAW_ENV_FILE;
    const resetHermesBootstrap =
      options.runtimeFamily === "hermes" &&
      Object.keys(entries).some((key) => key.startsWith("NORA_HERMES_"));
    const patchFile = `/tmp/nora-env-${crypto.randomBytes(8).toString("hex")}.patch`;
    await this._writeFile(vmid, patchFile, serializeEnvironment(entries), "0600");
    try {
      await this._pctExec(
        vmid,
        [
          "set -eu",
          `current=${shellSingleQuote(envFile)}`,
          `patch=${shellSingleQuote(patchFile)}`,
          'mkdir -p "$(dirname "$current")"',
          'touch "$current"',
          'tmp="$(mktemp)"',
          'awk -F= \'NR==FNR { keys[$1]=1; next } !($1 in keys)\' "$patch" "$current" > "$tmp"',
          'cat "$patch" >> "$tmp"',
          'install -m 0600 "$tmp" "$current"',
          options.runtimeFamily === "hermes" ? 'chown hermes:hermes "$current"' : "true",
          resetHermesBootstrap
            ? `rm -f ${shellSingleQuote(`${HERMES_HOME}/.nora-bootstrap-complete`)}`
            : "true",
          'rm -f "$tmp" "$patch"',
        ].join("\n"),
      );
    } catch (error) {
      try {
        await this._pctExec(vmid, `rm -f ${shellSingleQuote(patchFile)}`);
      } catch {
        // Best-effort removal of a secret-bearing patch file.
      }
      throw error;
    }
  }

  async logs(containerId, opts = {}) {
    const vmid = normalizeVmid(containerId);
    await this._assertOwnedLxc(vmid, opts, { operation: "read logs from" });
    const tail = normalizeTail(opts.tail);
    const follow = opts.follow !== false ? "-f" : "";
    const command = `${this.sudoPrefix}${this.pctCommand} exec ${vmid} -- journalctl -u nora-openclaw.service -u nora-hermes.service -n ${tail} ${follow} --no-pager`;
    return this._openSshStream(command).stream;
  }

  _openSshStream(command, { interactive = false, tty = false, signal } = {}) {
    this._assertConfigured();
    throwIfAborted(signal, "Proxmox SSH stream");
    const output = new PassThrough();
    const input = interactive ? new PassThrough() : null;
    const conn = new Client();
    let remoteStream = null;
    let running = true;
    let exitCode = null;
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const finish = (code = 0) => {
      if (!running) return;
      running = false;
      exitCode = Number.isInteger(code) ? code : code == null ? 0 : 1;
      signal?.removeEventListener("abort", onAbort);
      resolveExit({ Running: false, ExitCode: exitCode });
      if (!output.destroyed) output.end();
      conn.end();
    };
    const fail = (error) => {
      if (running) {
        running = false;
        exitCode = 1;
        signal?.removeEventListener("abort", onAbort);
        resolveExit({ Running: false, ExitCode: 1 });
      }
      if (!output.destroyed) output.destroy(error);
      conn.end();
    };
    const onAbort = () => fail(abortError(signal, "Proxmox SSH stream"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!running) {
      return {
        stream: output,
        stdin: input,
        inspect: async () => ({ Running: false, ExitCode: exitCode }),
        resize: async () => {},
      };
    }
    conn
      .on("ready", () => {
        const callback = (err, stream) => {
          if (err) {
            fail(err);
            return;
          }
          remoteStream = stream;
          stream.on("data", (chunk) => output.write(chunk));
          stream.stderr.on("data", (chunk) => output.write(chunk));
          stream.on("close", (code) => finish(code));
          stream.on("error", fail);
          if (input) {
            input.on("data", (chunk) => {
              if (remoteStream?.writable) remoteStream.write(chunk);
            });
            input.on("end", () => {
              if (remoteStream?.writable) remoteStream.end();
            });
          }
        };
        if (tty) {
          conn.exec(
            command,
            { pty: { term: "xterm-256color", cols: 120, rows: 30, width: 0, height: 0 } },
            callback,
          );
        } else {
          conn.exec(command, callback);
        }
      })
      .on("error", fail)
      .connect(this._sshConfig());
    const originalDestroy = output.destroy.bind(output);
    output.destroy = (...args) => {
      try {
        remoteStream?.close();
      } catch {
        // The remote stream may already be closed.
      }
      if (running) {
        running = false;
        exitCode = 130;
        signal?.removeEventListener("abort", onAbort);
        resolveExit({ Running: false, ExitCode: 130 });
      }
      conn.end();
      return originalDestroy(...args);
    };
    return {
      stream: output,
      stdin: input,
      inspect: async () => {
        if (running) {
          await Promise.race([exitPromise, sleep(1000)]);
        }
        return { Running: running, ExitCode: exitCode };
      },
      resize: async ({ h, w } = {}) => {
        if (!remoteStream || typeof remoteStream.setWindow !== "function") return;
        remoteStream.setWindow(
          Math.max(1, Number.parseInt(h, 10) || 30),
          Math.max(1, Number.parseInt(w, 10) || 120),
          0,
          0,
        );
      },
    };
  }

  async exec(containerId, opts = {}) {
    this._assertConfigured();
    const vmid = normalizeVmid(containerId);
    await this._assertOwnedLxc(vmid, opts, { operation: "execute commands in" });
    const cmd = opts.cmd || [
      "/bin/sh",
      "-lc",
      "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
    ];
    const shellCommand = Array.isArray(cmd)
      ? cmd.map((arg) => shellSingleQuote(arg)).join(" ")
      : `/bin/sh -lc ${shellSingleQuote(String(cmd))}`;
    const rawEnv = Array.isArray(opts.env)
      ? opts.env
      : opts.env && typeof opts.env === "object"
        ? Object.entries(opts.env).map(([key, value]) => `${key}=${value}`)
        : opts.cmd
          ? []
          : ["TERM=xterm-256color"];
    const envArgs = rawEnv.map((entry) => {
      const separator = String(entry).indexOf("=");
      const key = separator >= 0 ? String(entry).slice(0, separator) : String(entry);
      const value = separator >= 0 ? String(entry).slice(separator + 1) : "";
      if (!ENV_NAME_RE.test(key)) throw new Error(`Invalid exec environment variable: ${key}`);
      return shellSingleQuote(`${key}=${value}`);
    });
    const guestCommand = envArgs.length ? `env ${envArgs.join(" ")} ${shellCommand}` : shellCommand;
    const command = `${this.sudoPrefix}${this.pctCommand} exec ${vmid} -- ${guestCommand}`;
    const session = this._openSshStream(command, {
      interactive: !opts.cmd,
      tty: opts.tty !== false,
      signal: opts.signal,
    });
    return {
      exec: {
        inspect: session.inspect,
        resize: session.resize,
      },
      stream: session.stream,
      stdin: session.stdin,
    };
  }
}

module.exports = ProxmoxBackend;
