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
  buildOpenClawGatewayPairingCommand,
  buildOpenClawInstallCommand,
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServersConfig,
  buildMcpServerWrapperScript,
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
  normalizeProxmoxHostExecutable,
  normalizeProxmoxSudoCommand,
} = require("../../../agent-runtime/lib/backendCatalog");
const { getStandardDockerPackageSpec } = require("../../../agent-runtime/lib/agentImages");
const {
  HERMES_MANAGED_ENV_ENV,
  buildHermesManagedEnvBlock,
  buildHermesRuntimeConfigBootstrapCommand,
} = require("../../../agent-runtime/lib/hermesRuntimeBootstrap");
const {
  deriveHermesDashboardBasicAuth,
} = require("../../../agent-runtime/lib/hermesDashboardAuth");
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
const OPENCLAW_PROVIDER_BOOTSTRAP_FILE = "/etc/nora/openclaw-provider-bootstrap.sh";
const OPENCLAW_MANAGED_ENV_NAMES_FILE = "/etc/nora/openclaw-managed-env-names";
const OPENCLAW_PRESTART_FILE = "/etc/nora/openclaw-prestart.sh";
const OPENCLAW_PRESTART_RECONCILER_FILE =
  "/opt/openclaw-runtime/lib/nora-proxmox-prestart-reconcile.js";
const OPENCLAW_MCP_WRAPPER_FILE = "/usr/local/bin/nora-mcp-server";
const OPENCLAW_PRESTART_DROPIN_DIR = "/etc/systemd/system/nora-openclaw.service.d";
const OPENCLAW_PRESTART_DROPIN_FILE = `${OPENCLAW_PRESTART_DROPIN_DIR}/10-nora-managed-state.conf`;
const HERMES_ENV_FILE = `${HERMES_HOME}/.nora-system-env.b64`;
const HERMES_MANAGED_ENV_NAMES_FILE = `${HERMES_HOME}/.nora-managed-env-names`;
const HERMES_PRESTART_FILE = `${HERMES_HOME}/.nora-prestart.sh`;
const HERMES_PRESTART_DROPIN_DIR = "/etc/systemd/system/nora-hermes.service.d";
const HERMES_PRESTART_DROPIN_FILE = `${HERMES_PRESTART_DROPIN_DIR}/10-nora-managed-state.conf`;
const PROXMOX_OFFLINE_STAGE_HELPER_ENV = "PROXMOX_OFFLINE_STAGE_COMMAND";
const PROXMOX_NEMOCLAW_UNSUPPORTED =
  "NemoClaw on Proxmox is not supported: writing a policy file inside an LXC does not provide the enforced OpenShell sandbox contract.";
const PROXMOX_AGENT_OWNERSHIP_MARKER_PREFIX = "nora-agent:";
const PROXMOX_CREATE_OWNERSHIP_MARKER_PREFIX = "nora-owner:";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROXMOX_TEMPLATE_RE = /^[A-Za-z0-9_.-]+:vztmpl\/[A-Za-z0-9._+~-]+\.tar\.zst$/;
const SAFE_HOST_HELPER_RE = /^\/[A-Za-z0-9_./-]+$/;

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

function buildOpenClawAuthBuilderScript() {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const authPath = '/root/.openclaw/agents/main/agent/auth-profiles.json';",
    "const providers = {",
    "  ANTHROPIC_API_KEY: { provider: 'anthropic' },",
    "  OPENAI_API_KEY: { provider: 'openai' },",
    "  GEMINI_API_KEY: { provider: 'google' },",
    "  GROQ_API_KEY: { provider: 'groq' },",
    "  MISTRAL_API_KEY: { provider: 'mistral' },",
    "  DEEPSEEK_API_KEY: { provider: 'deepseek' },",
    "  OPENROUTER_API_KEY: { provider: 'openrouter' },",
    "  TOGETHER_API_KEY: { provider: 'together' },",
    "  COHERE_API_KEY: { provider: 'cohere' },",
    "  XAI_API_KEY: { provider: 'xai' },",
    "  MOONSHOT_API_KEY: { provider: 'moonshot' },",
    "  ZAI_API_KEY: { provider: 'zai' },",
    "  OLLAMA_API_KEY: { provider: 'ollama' },",
    "  MINIMAX_API_KEY: { provider: 'minimax' },",
    "  COPILOT_GITHUB_TOKEN: { provider: 'github-copilot' },",
    "  HF_TOKEN: { provider: 'huggingface' },",
    "  CEREBRAS_API_KEY: { provider: 'cerebras' },",
    "  NVIDIA_API_KEY: { provider: 'nvidia', defaultEndpoint: 'https://integrate.api.nvidia.com/v1' },",
    "  MICROSOFT_FOUNDRY_API_KEY: { provider: 'azure-openai-responses' },",
    "  NORA_DEMO_LLM_TOKEN: { provider: 'nora-demo', baseUrlEnv: 'NORA_DEMO_LLM_BASE_URL' },",
    "};",
    "const auth = { version: 1, profiles: {}, order: {}, lastGood: {} };",
    "for (const [envName, spec] of Object.entries(providers)) {",
    "  const key = String(process.env[envName] || '');",
    "  if (!key) continue;",
    "  const profileId = `${spec.provider}:default`;",
    "  const baseName = envName.replace(/_API_KEY$|_TOKEN$/, '');",
    "  const endpoint = String(",
    "    process.env[spec.baseUrlEnv || `${baseName}_BASE_URL`] || spec.defaultEndpoint || '',",
    "  ).trim();",
    "  const apiVersion = String(process.env[`${baseName}_API_VERSION`] || '').trim();",
    "  auth.profiles[profileId] = {",
    "    type: 'api_key',",
    "    provider: spec.provider,",
    "    key,",
    "    ...(endpoint ? { endpoint } : {}),",
    "    ...(apiVersion ? { api_version: apiVersion } : {}),",
    "  };",
    "  auth.order[spec.provider] = [profileId];",
    "  auth.lastGood[spec.provider] = profileId;",
    "}",
    "if (Object.keys(auth.order).length === 0) delete auth.order;",
    "if (Object.keys(auth.lastGood).length === 0) delete auth.lastGood;",
    "fs.mkdirSync(path.dirname(authPath), { recursive: true });",
    "const temporaryPath = `${authPath}.nora-${process.pid}-${Date.now()}.tmp`;",
    "try {",
    "  fs.writeFileSync(temporaryPath, JSON.stringify(auth));",
    "  fs.chmodSync(temporaryPath, 0o600);",
    "  fs.renameSync(temporaryPath, authPath);",
    "} finally {",
    "  try { fs.rmSync(temporaryPath, { force: true }); } catch {}",
    "}",
    "",
  ].join("\n");
}

function buildOpenClawPrestartReconcilerScript() {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const configPath = '/root/.openclaw/openclaw.json';",
    "const markerPath = '/root/.openclaw/.nora-managed-default-model';",
    `const managedEnvNamesPath = ${JSON.stringify(OPENCLAW_MANAGED_ENV_NAMES_FILE)};`,
    "const managedProviderIds = new Set(['azure-openai-responses', 'nora-demo']);",
    "const foundryDefaults = [",
    "  { id: 'gpt-5.5', name: 'GPT-5.5 (Azure)', reasoning: true, contextWindow: 400000, maxTokens: 16384 },",
    "  { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini (Azure)', reasoning: true, contextWindow: 400000, maxTokens: 16384 },",
    "  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro (Azure)', reasoning: true, contextWindow: 200000, maxTokens: 128000 },",
    "  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (Azure)', reasoning: true, contextWindow: 400000, maxTokens: 16384 },",
    "  { id: 'o3', name: 'o3 (Azure)', reasoning: true, contextWindow: 200000, maxTokens: 100000 },",
    "];",
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
    "function foundryDeployment() {",
    "  let value = String(process.env.MICROSOFT_FOUNDRY_DEPLOYMENT || process.env.NORA_DEFAULT_OPENCLAW_MODEL || '').trim();",
    "  for (const prefix of ['azure-openai-responses/', 'microsoft-foundry/', 'openai/', 'openai-responses/']) {",
    "    if (value.startsWith(prefix)) { value = value.slice(prefix.length).trim(); break; }",
    "  }",
    "  return value && !value.includes('/') ? value : 'gpt-5.5';",
    "}",
    "function foundryModels() {",
    "  const models = foundryDefaults.map((entry) => ({",
    "    ...entry,",
    "    api: 'azure-openai-responses',",
    "    input: ['text', 'image'],",
    "    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },",
    "    compat: { supportsStore: false, supportsReasoningEffort: true },",
    "  }));",
    "  const deployment = foundryDeployment();",
    "  if (models.some((model) => model.id === deployment)) return models;",
    "  const baseId = deployment.replace(/-\\d+$/, '');",
    "  const template = models.find((model) => model.id === baseId) || models[0];",
    "  return [{ ...template, id: deployment, name: `${deployment} (Azure deployment)` }, ...models];",
    "}",
    "function buildDesiredProviders() {",
    "  const desired = {};",
    "  const foundryKey = String(process.env.MICROSOFT_FOUNDRY_API_KEY || '');",
    "  const foundryBaseUrl = String(process.env.MICROSOFT_FOUNDRY_BASE_URL || '').replace(/\\/+$/, '');",
    "  if (foundryKey && foundryBaseUrl) {",
    "    desired['azure-openai-responses'] = {",
    "      api: 'azure-openai-responses',",
    "      baseUrl: foundryBaseUrl,",
    "      apiKey: foundryKey,",
    "      models: foundryModels(),",
    "    };",
    "  }",
    "  const demoToken = String(process.env.NORA_DEMO_LLM_TOKEN || '');",
    "  const demoBaseUrl = String(process.env.NORA_DEMO_LLM_BASE_URL || '').replace(/\\/+$/, '');",
    "  if (demoToken && demoBaseUrl) {",
    "    desired['nora-demo'] = {",
    "      api: 'openai-completions',",
    "      baseUrl: demoBaseUrl,",
    "      apiKey: demoToken,",
    "      models: [{",
    "        id: 'nora-demo-1', name: 'Nora Demo (deterministic stub)', api: 'openai-completions',",
    "        reasoning: false, input: ['text'],",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },",
    "        contextWindow: 32768, maxTokens: 4096,",
    "      }],",
    "    };",
    "  }",
    "  return desired;",
    "}",
    "function readConfig() {",
    "  if (!fs.existsSync(configPath)) return {};",
    "  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "  if (!isPlainObject(parsed)) throw new Error('OpenClaw config must contain a JSON object');",
    "  return parsed;",
    "}",
    "function writeConfig(config) {",
    "  fs.mkdirSync(path.dirname(configPath), { recursive: true });",
    "  const temporaryPath = `${configPath}.nora-${process.pid}-${Date.now()}.tmp`;",
    "  try {",
    "    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + '\\n');",
    "    fs.chmodSync(temporaryPath, 0o600);",
    "    fs.renameSync(temporaryPath, configPath);",
    "  } finally {",
    "    try { fs.rmSync(temporaryPath, { force: true }); } catch {}",
    "  }",
    "}",
    "const current = readConfig();",
    "const managedEnvNames = new Set();",
    "try {",
    "  for (const line of fs.readFileSync(managedEnvNamesPath, 'utf8').split(/\\r?\\n/)) {",
    "    const name = String(line || '').trim();",
    "    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) managedEnvNames.add(name);",
    "  }",
    "} catch (error) {",
    "  if (error?.code !== 'ENOENT') throw error;",
    "}",
    "if (current.env !== undefined && !isPlainObject(current.env)) throw new Error('OpenClaw env config must be an object');",
    "if (isPlainObject(current.env)) {",
    "  const configEnv = { ...current.env };",
    "  for (const name of managedEnvNames) delete configEnv[name];",
    "  if (Object.keys(configEnv).length > 0) current.env = configEnv;",
    "  else delete current.env;",
    "}",
    "if (current.models !== undefined && !isPlainObject(current.models)) {",
    "  throw new Error('OpenClaw models config must be an object');",
    "}",
    "const models = { ...(current.models || {}) };",
    "if (models.providers !== undefined && !isPlainObject(models.providers)) {",
    "  throw new Error('OpenClaw custom providers config must be an object');",
    "}",
    "const providers = { ...(models.providers || {}) };",
    "for (const providerId of managedProviderIds) delete providers[providerId];",
    "for (const [providerId, providerConfig] of Object.entries(buildDesiredProviders())) {",
    "  if (managedProviderIds.has(providerId)) providers[providerId] = providerConfig;",
    "}",
    "if (Object.keys(providers).length > 0) models.providers = providers;",
    "else delete models.providers;",
    "if (Object.keys(models).length > 0) current.models = models;",
    "else delete current.models;",
    "const desiredDefaultModel = String(process.env.NORA_DEFAULT_OPENCLAW_MODEL || '').trim();",
    "if (current.agents !== undefined && !isPlainObject(current.agents)) throw new Error('OpenClaw agents config must be an object');",
    "const agents = isPlainObject(current.agents) ? { ...current.agents } : {};",
    "if (agents.defaults !== undefined && !isPlainObject(agents.defaults)) throw new Error('OpenClaw agent defaults config must be an object');",
    "const defaults = isPlainObject(agents.defaults) ? { ...agents.defaults } : {};",
    "if (defaults.model !== undefined && !isPlainObject(defaults.model)) throw new Error('OpenClaw default model config must be an object');",
    "if (defaults.models !== undefined && !isPlainObject(defaults.models)) throw new Error('OpenClaw allowed models config must be an object');",
    "const model = isPlainObject(defaults.model) ? { ...defaults.model } : {};",
    "const allowedModels = isPlainObject(defaults.models) ? { ...defaults.models } : {};",
    "const currentPrimary = String(model.primary || '').trim();",
    "let previousManagedModel = '';",
    "try { previousManagedModel = String(fs.readFileSync(markerPath, 'utf8') || '').trim(); } catch {}",
    "if (previousManagedModel) delete allowedModels[previousManagedModel];",
    "if (desiredDefaultModel) {",
    "  model.primary = desiredDefaultModel;",
    "  if (!isPlainObject(allowedModels[desiredDefaultModel])) allowedModels[desiredDefaultModel] = {};",
    "} else if (previousManagedModel && currentPrimary === previousManagedModel) {",
    "  delete model.primary;",
    "}",
    "if (Object.keys(model).length > 0) defaults.model = model;",
    "else delete defaults.model;",
    "if (Object.keys(allowedModels).length > 0) defaults.models = allowedModels;",
    "else delete defaults.models;",
    "if (Object.keys(defaults).length > 0) agents.defaults = defaults;",
    "else delete agents.defaults;",
    "if (Object.keys(agents).length > 0) current.agents = agents;",
    "else delete current.agents;",
    "writeConfig(current);",
    "if (desiredDefaultModel) {",
    "  fs.mkdirSync(path.dirname(markerPath), { recursive: true });",
    "  fs.writeFileSync(markerPath, desiredDefaultModel + '\\n');",
    "  fs.chmodSync(markerPath, 0o600);",
    "} else {",
    "  try { fs.rmSync(markerPath, { force: true }); } catch {}",
    "}",
    "",
  ].join("\n");
}

function buildOpenClawPrestartScript() {
  return [
    "#!/bin/sh",
    "set -eu",
    ...environmentLoaderLines(OPENCLAW_ENV_FILE),
    "node /opt/openclaw-runtime/lib/build-auth.js",
    buildOpenClawGatewayPairingCommand(),
    `node ${OPENCLAW_PRESTART_RECONCILER_FILE}`,
    buildOpenClawAuthImportFromFileCommand({ requireCli: false }),
    "",
  ].join("\n");
}

function buildHermesPrestartScript() {
  return [
    "#!/bin/sh",
    "set -eu",
    ...environmentLoaderLines(HERMES_ENV_FILE),
    buildHermesRuntimeConfigBootstrapCommand(),
    `touch ${shellSingleQuote(`${HERMES_HOME}/.nora-bootstrap-complete`)}`,
    `chmod 0600 ${shellSingleQuote(`${HERMES_HOME}/.nora-bootstrap-complete`)}`,
    "",
  ].join("\n");
}

function buildSystemdPrestartDropin(prestartPath) {
  return ["[Service]", `ExecStartPre=${prestartPath}`, ""].join("\n");
}

function buildNoopProviderBootstrapScript() {
  return "#!/bin/sh\nset -eu\n# Provider state is reconciled by the secret-free systemd prestart hook.\n";
}

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
  return normalized.sort();
}

async function buildTarArchive(files = []) {
  const tar = require("tar-stream");
  const pack = tar.pack();
  const chunks = [];
  const archive = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
  for (const file of files) {
    await new Promise((resolve, reject) => {
      pack.entry(
        {
          name: String(file.name),
          type: "file",
          mode: Number(file.mode || 0o600),
          uid: 0,
          gid: 0,
        },
        Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || "")),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  return archive;
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

function taskCompletionUnconfirmedError(message) {
  const error = new Error(message);
  error.code = "PROXMOX_TASK_COMPLETION_UNCONFIRMED";
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

function safeDescriptionLabel(value, fallback) {
  return (
    String(value || fallback || "agent")
      .replace(/[\r\n\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "agent"
  );
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
    this.pctCommand = normalizeProxmoxHostExecutable(
      process.env.PROXMOX_PCT_COMMAND,
      "PROXMOX_PCT_COMMAND",
      "pct",
    );
    this.sudoCommand = normalizeProxmoxSudoCommand(process.env.PROXMOX_SUDO, this.sshUser);
    this.offlineStageCommand = String(process.env[PROXMOX_OFFLINE_STAGE_HELPER_ENV] || "").trim();
  }

  _hostCommand(executable, args = []) {
    const command = normalizeProxmoxHostExecutable(
      executable,
      "Proxmox host executable",
      executable,
    );
    return [...this.sudoCommand, command, ...args.map((arg) => String(arg))]
      .map((token) => shellSingleQuote(token))
      .join(" ");
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

  _createSshClient() {
    return new Client();
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
    const taskId = typeof upid === "string" ? upid.trim() : "";
    if (!taskId) {
      throw taskCompletionUnconfirmedError(
        "Proxmox API did not return a task id; operation completion cannot be confirmed",
      );
    }
    for (let i = 0; i < 120; i++) {
      const status = await this._requestData(
        "GET",
        `/nodes/${this.node}/tasks/${encodeURIComponent(taskId)}/status`,
        null,
        options,
      );
      if (status?.status === "stopped") {
        const exitStatus = String(status.exitstatus || "").trim();
        if (!exitStatus) {
          throw taskCompletionUnconfirmedError(
            `Proxmox task ${taskId} stopped without a confirmed exit status`,
          );
        }
        if (exitStatus !== "OK") {
          throw new Error(`Proxmox task failed: ${exitStatus}`);
        }
        return;
      }
      await abortableSleep(1000, options.signal, "waiting for Proxmox task");
    }
    throw taskCompletionUnconfirmedError(`Timed out waiting for Proxmox task ${taskId}`);
  }

  _sshExec(command, { timeout = 120000, signal, input = null } = {}) {
    this._assertConfigured();
    return new Promise((resolve, reject) => {
      throwIfAborted(signal, "Proxmox SSH command");
      const conn = this._createSshClient();
      let remoteStream = null;
      let timer = null;
      let killTimer = null;
      let terminationTimer = null;
      let terminationReason = null;
      let observedExitCode = null;
      let commandRequested = false;
      let settled = false;
      const unconfirmedError = (message, cause = null) => {
        const error = new Error(message, cause ? { cause } : undefined);
        error.code = "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED";
        return error;
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        signal?.removeEventListener("abort", onAbort);
        try {
          conn.end();
        } catch {
          // The SSH transport may already be closed.
        }
        callback(value);
      };
      const requestTermination = (reason) => {
        if (settled || terminationReason) return;
        terminationReason = reason;
        if (!remoteStream) {
          finish(
            reject,
            commandRequested
              ? unconfirmedError(
                  `Proxmox SSH command termination could not be confirmed after dispatch: ${reason.message}`,
                  reason,
                )
              : reason,
          );
          return;
        }
        try {
          remoteStream.signal("TERM");
        } catch {
          // The SSH server may not support channel signals. Escalate below.
        }
        killTimer = setTimeout(() => {
          try {
            remoteStream.signal("KILL");
          } catch {
            // Missing signal support is reported as unconfirmed termination.
          }
          terminationTimer = setTimeout(() => {
            try {
              remoteStream.close();
            } catch {
              // The channel may already be closed.
            }
            finish(
              reject,
              unconfirmedError(
                `Proxmox SSH command termination could not be confirmed: ${reason.message}`,
                reason,
              ),
            );
          }, 500);
        }, 500);
      };
      const onAbort = () => requestTermination(abortError(signal, "Proxmox SSH command"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      conn
        .on("ready", () => {
          timer = setTimeout(() => {
            requestTermination(new Error(`SSH command timed out after ${timeout}ms`));
          }, timeout);
          commandRequested = true;
          conn.exec(command, (err, stream) => {
            if (err) {
              finish(reject, err);
              return;
            }
            if (settled) {
              try {
                stream.signal("TERM");
                stream.signal("KILL");
                stream.close();
              } catch {
                // The already-rejected operation remains explicitly unconfirmed.
              }
              return;
            }
            remoteStream = stream;
            let stdout = "";
            let stderr = "";
            stream.on("data", (chunk) => {
              stdout += chunk.toString();
            });
            stream.stderr.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            stream.on("exit", (code) => {
              if (Number.isInteger(code)) observedExitCode = code;
            });
            stream.on("error", (error) => {
              if (terminationReason && Number.isInteger(observedExitCode)) {
                finish(reject, terminationReason);
                return;
              }
              finish(
                reject,
                unconfirmedError(
                  `Proxmox SSH command stream failed before exit was confirmed: ${error.message}`,
                  terminationReason || error,
                ),
              );
            });
            stream.on("close", (code) => {
              const finalCode = Number.isInteger(code) ? code : observedExitCode;
              if (terminationReason) {
                finish(
                  reject,
                  Number.isInteger(finalCode)
                    ? terminationReason
                    : unconfirmedError(
                        `Proxmox SSH command termination could not be confirmed: ${terminationReason.message}`,
                        terminationReason,
                      ),
                );
                return;
              }
              if (!Number.isInteger(finalCode)) {
                finish(
                  reject,
                  unconfirmedError(
                    "Proxmox SSH channel closed without a confirmed remote command exit status",
                  ),
                );
                return;
              }
              if (finalCode !== 0) {
                finish(
                  reject,
                  new Error(
                    stderr.trim() || stdout.trim() || `SSH command exited with ${finalCode}`,
                  ),
                );
                return;
              }
              finish(resolve, { stdout, stderr, code: finalCode });
            });
            if (input != null) {
              stream.end(Buffer.isBuffer(input) ? input : Buffer.from(String(input)));
            }
          });
        })
        .on("error", (error) =>
          finish(
            reject,
            remoteStream || commandRequested
              ? unconfirmedError(
                  `Proxmox SSH transport failed before remote command exit was confirmed: ${error.message}`,
                  terminationReason || error,
                )
              : error,
          ),
        )
        .on("close", () => {
          if (!settled && (remoteStream || commandRequested)) {
            finish(
              reject,
              unconfirmedError(
                "Proxmox SSH transport closed before remote command exit was confirmed",
              ),
            );
          }
        })
        .connect(this._sshConfig());
    });
  }

  _pctExec(vmid, command, options = {}) {
    const normalizedVmid = normalizeVmid(vmid);
    return this._sshExec(
      this._hostCommand(this.pctCommand, ["exec", normalizedVmid, "--", "/bin/sh", "-lc", command]),
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

  _assertOfflineStagePrivilege() {
    if (this.sshUser === "root") return { mode: "root" };
    if (!this.offlineStageCommand) {
      const error = new Error(
        `Stopped Proxmox LXC reconciliation requires root SSH or a strict helper configured with ${PROXMOX_OFFLINE_STAGE_HELPER_ENV}`,
      );
      error.code = "PROXMOX_OFFLINE_STAGE_PRIVILEGE_REQUIRED";
      error.statusCode = 503;
      throw error;
    }
    if (!SAFE_HOST_HELPER_RE.test(this.offlineStageCommand)) {
      const error = new Error(
        `${PROXMOX_OFFLINE_STAGE_HELPER_ENV} must be a single absolute executable path`,
      );
      error.code = "PROXMOX_OFFLINE_STAGE_HELPER_INVALID";
      error.statusCode = 500;
      throw error;
    }
    return { mode: "helper", command: this.offlineStageCommand };
  }

  _buildOfflineStageHostScript(vmid, runtimeFamily, nonce, replaceManagedState) {
    const normalizedVmid = normalizeVmid(vmid);
    const hermes = runtimeFamily === "hermes";
    const envPath = hermes ? HERMES_ENV_FILE : OPENCLAW_ENV_FILE;
    const managedNamesPath = hermes
      ? HERMES_MANAGED_ENV_NAMES_FILE
      : OPENCLAW_MANAGED_ENV_NAMES_FILE;
    const dropinDir = hermes ? HERMES_PRESTART_DROPIN_DIR : OPENCLAW_PRESTART_DROPIN_DIR;
    const dropinFile = hermes ? HERMES_PRESTART_DROPIN_FILE : OPENCLAW_PRESTART_DROPIN_FILE;
    const serviceFile = hermes
      ? "/etc/systemd/system/nora-hermes.service"
      : "/etc/systemd/system/nora-openclaw.service";
    const extraInstalls = hermes
      ? [
          ["prestart.sh", HERMES_PRESTART_FILE, "0700", envPath],
          ["dropin.conf", dropinFile, "0644", serviceFile],
        ]
      : [
          ["build-auth.js", "/opt/openclaw-runtime/lib/build-auth.js", "0600", envPath],
          ["prestart.sh", OPENCLAW_PRESTART_FILE, "0700", envPath],
          [
            "prestart-reconcile.js",
            OPENCLAW_PRESTART_RECONCILER_FILE,
            "0600",
            "/opt/openclaw-runtime/lib/build-auth.js",
          ],
          ["provider-bootstrap.sh", OPENCLAW_PROVIDER_BOOTSTRAP_FILE, "0700", envPath],
          ["mcp-wrapper", OPENCLAW_MCP_WRAPPER_FILE, "0755", envPath],
          ["dropin.conf", dropinFile, "0644", serviceFile],
        ];

    return [
      "set -eu",
      `vmid=${shellSingleQuote(normalizedVmid)}`,
      `pct_cmd=${shellSingleQuote(this.pctCommand)}`,
      `nonce=${shellSingleQuote(nonce)}`,
      `replace_managed_state=${replaceManagedState ? "1" : "0"}`,
      'stage="$(mktemp -d /run/nora-proxmox-stage.XXXXXXXX)"',
      "mounted=0",
      "config_locked=0",
      "cleanup() {",
      "  rc=$?",
      "  set +e",
      '  rm -rf -- "$stage"',
      '  if [ "$config_locked" = 1 ]; then flock -u 9 || rc=125; config_locked=0; fi',
      '  if [ "$mounted" = 1 ]; then',
      "    cd /",
      '    "$pct_cmd" unmount "$vmid" >/dev/null 2>&1 || rc=125',
      "  fi",
      "  trap - EXIT HUP INT TERM",
      '  exit "$rc"',
      "}",
      "trap cleanup EXIT HUP INT TERM",
      "umask 077",
      'tar --extract --file=- --directory="$stage" --no-same-owner --no-same-permissions',
      'test -z "$(find "$stage" -mindepth 1 ! -type f -print -quit)"',
      'test "$("$pct_cmd" status "$vmid")" = "status: stopped"',
      '"$pct_cmd" mount "$vmid" >/dev/null',
      "mounted=1",
      'test "$("$pct_cmd" status "$vmid")" = "status: stopped"',
      'config_lock="/run/lock/lxc/pve-config-$vmid.lock"',
      'exec 9>"$config_lock"',
      "flock -x 9",
      "config_locked=1",
      'test "$("$pct_cmd" status "$vmid")" = "status: stopped"',
      'root="$(readlink -f -- "/var/lib/lxc/$vmid/rootfs")"',
      'test -n "$root" && test -d "$root"',
      "confined_parent() {",
      '  rel="$1"',
      '  case "$rel" in ""|/*|*".."*) return 64;; esac',
      '  parent_rel="${rel%/*}"',
      '  [ "$parent_rel" != "$rel" ] || parent_rel=.',
      '  parent="$(readlink -f -- "$root/$parent_rel")" || return 65',
      '  case "$parent/" in "$root/"*) printf \'%s\\n\' "$parent";; *) return 66;; esac',
      "}",
      "safe_existing() {",
      '  rel="$1"',
      '  parent="$(confined_parent "$rel")" || return $?',
      '  base="${rel##*/}"',
      '  target="$parent/$base"',
      '  [ ! -L "$target" ] && [ -e "$target" ] || return 67',
      "  printf '%s\\n' \"$target\"",
      "}",
      "ensure_dir() {",
      '  rel="$1"; reference_rel="$2"; mode="$3"',
      '  parent="$(confined_parent "$rel")" || return $?',
      '  base="${rel##*/}"',
      '  target="$parent/$base"',
      '  [ ! -L "$target" ] || return 68',
      '  reference="$(safe_existing "$reference_rel")" || return $?',
      '  if [ ! -d "$target" ]; then mkdir -- "$target"; fi',
      '  chown --reference="$reference" "$target"',
      '  chmod "$mode" "$target"',
      "}",
      "install_file() {",
      '  source_name="$1"; rel="$2"; mode="$3"; reference_rel="$4"',
      '  source="$stage/$source_name"',
      '  [ -f "$source" ] && [ ! -L "$source" ] || return 69',
      '  parent="$(confined_parent "$rel")" || return $?',
      '  base="${rel##*/}"',
      '  target="$parent/$base"',
      '  [ ! -L "$target" ] || return 70',
      '  reference="$(safe_existing "$reference_rel")" || return $?',
      '  temporary="$parent/.nora-stage-$nonce-$base"',
      '  rm -f -- "$temporary"',
      '  cp -- "$source" "$temporary"',
      '  chown --reference="$reference" "$temporary"',
      '  chmod "$mode" "$temporary"',
      '  mv -fT -- "$temporary" "$target"',
      "}",
      `env_rel=${shellSingleQuote(envPath.replace(/^\//, ""))}`,
      `names_rel=${shellSingleQuote(managedNamesPath.replace(/^\//, ""))}`,
      'current_env="$(safe_existing "$env_rel")"',
      'names_parent="$(confined_parent "$names_rel")"',
      'names_target="$names_parent/${names_rel##*/}"',
      'test ! -L "$names_target"',
      'cp -- "$stage/env.keys" "$stage/effective.keys"',
      'sort -u "$stage/effective.keys" -o "$stage/effective.keys"',
      'awk -F= \'NR==FNR { if ($1 != "") managed[$1]=1; next } !($1 in managed)\' "$stage/effective.keys" "$current_env" > "$stage/env.merged"',
      'awk \'NF { print }\' "$stage/env.patch" >> "$stage/env.merged"',
      '  : > "$stage/names.merged"',
      '  if [ -f "$names_target" ]; then cat -- "$names_target" >> "$stage/names.merged"; fi',
      '  cat -- "$stage/env.scope" >> "$stage/names.merged"',
      'sort -u "$stage/names.merged" -o "$stage/names.merged"',
      'install_file env.merged "$env_rel" 0600 "$env_rel"',
      'install_file names.merged "$names_rel" 0600 "$env_rel"',
      `ensure_dir ${shellSingleQuote(dropinDir.replace(/^\//, ""))} ${shellSingleQuote(
        path.posix.dirname(dropinDir).replace(/^\//, ""),
      )} 0755`,
      ...extraInstalls.map(
        ([source, target, mode, reference]) =>
          `install_file ${shellSingleQuote(source)} ${shellSingleQuote(
            target.replace(/^\//, ""),
          )} ${mode} ${shellSingleQuote(reference.replace(/^\//, ""))}`,
      ),
      "cd /",
      "flock -u 9",
      "config_locked=0",
      '"$pct_cmd" unmount "$vmid" >/dev/null',
      "mounted=0",
      'rm -rf -- "$stage"',
      "trap - EXIT HUP INT TERM",
      "",
    ].join("\n");
  }

  async _stageManagedStateWhileStopped(
    vmid,
    entries,
    replacementNames,
    { agentId, runtimeFamily = "openclaw", replaceManagedState = false, signal } = {},
  ) {
    const normalizedVmid = normalizeVmid(vmid);
    const normalizedRuntimeFamily = runtimeFamily === "hermes" ? "hermes" : "openclaw";
    const privilege = this._assertOfflineStagePrivilege();
    const nonce = crypto.randomBytes(12).toString("hex");
    const archiveFiles = [
      { name: "env.patch", content: serializeEnvironment(entries), mode: 0o600 },
      { name: "env.keys", content: `${replacementNames.join("\n")}\n`, mode: 0o600 },
      { name: "env.scope", content: `${replacementNames.join("\n")}\n`, mode: 0o600 },
    ];
    if (normalizedRuntimeFamily === "hermes") {
      archiveFiles.push(
        { name: "prestart.sh", content: buildHermesPrestartScript(), mode: 0o700 },
        {
          name: "dropin.conf",
          content: buildSystemdPrestartDropin(HERMES_PRESTART_FILE),
          mode: 0o644,
        },
      );
    } else {
      archiveFiles.push(
        { name: "build-auth.js", content: buildOpenClawAuthBuilderScript(), mode: 0o600 },
        { name: "prestart.sh", content: buildOpenClawPrestartScript(), mode: 0o700 },
        {
          name: "prestart-reconcile.js",
          content: buildOpenClawPrestartReconcilerScript(),
          mode: 0o600,
        },
        {
          name: "provider-bootstrap.sh",
          content: buildNoopProviderBootstrapScript(),
          mode: 0o700,
        },
        {
          name: "mcp-wrapper",
          content: buildMcpServerWrapperScript(),
          mode: 0o755,
        },
        {
          name: "dropin.conf",
          content: buildSystemdPrestartDropin(OPENCLAW_PRESTART_FILE),
          mode: 0o644,
        },
      );
    }
    const archive = await buildTarArchive(archiveFiles);
    const hostScript = this._buildOfflineStageHostScript(
      normalizedVmid,
      normalizedRuntimeFamily,
      nonce,
      replaceManagedState,
    );
    const command =
      privilege.mode === "root"
        ? this._hostCommand("/bin/sh", ["-lc", hostScript])
        : this._hostCommand(privilege.command, [
            normalizedVmid,
            normalizedRuntimeFamily,
            replaceManagedState ? "1" : "0",
          ]);

    try {
      await this._sshExec(command, { timeout: 180000, signal, input: archive });
    } catch (cause) {
      const error = new Error(
        `Stopped Proxmox LXC ${normalizedVmid} managed-state staging could not be confirmed: ${cause.message}`,
        { cause },
      );
      error.code = "PROXMOX_OFFLINE_STAGE_UNCONFIRMED";
      error.containerId = normalizedVmid;
      throw error;
    }

    let config;
    let current;
    try {
      config = await this._requestData(
        "GET",
        `/nodes/${this.node}/lxc/${normalizedVmid}/config`,
        null,
        signal ? { signal } : {},
      );
      current = await this._requestData(
        "GET",
        `/nodes/${this.node}/lxc/${normalizedVmid}/status/current`,
        null,
        signal ? { signal } : {},
      );
    } catch (cause) {
      const error = new Error(
        `Stopped Proxmox LXC ${normalizedVmid} post-stage state could not be verified: ${cause.message}`,
        { cause },
      );
      error.code = "PROXMOX_OFFLINE_STAGE_UNCONFIRMED";
      error.containerId = normalizedVmid;
      throw error;
    }
    const normalizedAgentId = normalizeAgentId(agentId);
    if (
      !descriptionHasOwnershipMarkers(
        config?.description,
        buildAgentOwnershipMarker(normalizedAgentId),
      )
    ) {
      throw ownershipMismatchError(normalizedVmid, normalizedAgentId, "verify offline staging for");
    }
    if (String(config?.lock || "").trim()) {
      const error = new Error(
        `Proxmox LXC ${normalizedVmid} remains locked after offline managed-state staging`,
      );
      error.code = "PROXMOX_OFFLINE_STAGE_LOCK_REMAINS";
      error.containerId = normalizedVmid;
      throw error;
    }
    if (current?.status !== "stopped") {
      const error = new Error(
        `Proxmox LXC ${normalizedVmid} is not confirmed stopped after managed-state staging`,
      );
      error.code = "PROXMOX_OFFLINE_STAGE_STATUS_UNCONFIRMED";
      error.containerId = normalizedVmid;
      throw error;
    }
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
      `Nora ${normalizedRuntimeFamily} agent ${safeDescriptionLabel(name, id)}`,
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
    const mcpManagedEnv = buildMcpManagedEnv(mcpServers);
    const mcpManagedEnvNames = buildMcpManagedEnvNames(mcpServers);
    const managedMcpServers = buildMcpServersConfig(mcpServers);
    const runtimeEnv = normalizeEnv({
      ...(env || {}),
      ...mcpManagedEnv,
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
      OPENCLAW_MANAGED_ENV_NAMES_FILE,
      `${mcpManagedEnvNames.join("\n")}${mcpManagedEnvNames.length > 0 ? "\n" : ""}`,
      "0600",
      { signal },
    );
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
    await this._writeFile(vmid, OPENCLAW_MCP_WRAPPER_FILE, buildMcpServerWrapperScript(), "0755", {
      signal,
    });
    const buildAuthScript = buildOpenClawAuthBuilderScript();
    await this._writeFile(
      vmid,
      "/opt/openclaw-runtime/lib/build-auth.js",
      buildAuthScript,
      "0600",
      { signal },
    );
    const openClawPackage = process.env.PROXMOX_OPENCLAW_PACKAGE || getStandardDockerPackageSpec();
    await this._writeFile(
      vmid,
      OPENCLAW_PROVIDER_BOOTSTRAP_FILE,
      buildNoopProviderBootstrapScript(),
      "0700",
      { signal },
    );
    await this._writeFile(
      vmid,
      OPENCLAW_PRESTART_RECONCILER_FILE,
      buildOpenClawPrestartReconcilerScript(),
      "0600",
      { signal },
    );
    await this._writeFile(vmid, OPENCLAW_PRESTART_FILE, buildOpenClawPrestartScript(), "0700", {
      signal,
    });
    await this._writeFile(
      vmid,
      OPENCLAW_PRESTART_DROPIN_FILE,
      buildSystemdPrestartDropin(OPENCLAW_PRESTART_FILE),
      "0644",
      { signal },
    );
    const startupScript = [
      "#!/bin/sh",
      "set -eu",
      ...environmentLoaderLines(OPENCLAW_ENV_FILE),
      buildOpenClawInstallCommand([openClawPackage]),
      "mkdir -p ~/.openclaw/devices /var/log /root/.openclaw/workspace /root/.openclaw/agents/main/agent",
      ...openClawManagedConfigMergeLines(OPENCLAW_GATEWAY_CONFIG_FILE, {
        replaceKeys: ["mcpServers"],
      }),
      "touch /var/log/openclaw-agent.log",
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/build-auth.js',
      buildOpenClawAuthImportFromFileCommand({ requireCli: true }),
      '"$OPENCLAW_TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 &',
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
    const dashboardAuth = deriveHermesDashboardBasicAuth(apiServerKey);
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
      // Hermes fail-closed dashboard auth (basic-auth provider); the embed proxy
      // re-derives the same credential from API_SERVER_KEY to log in.
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboardAuth.username,
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboardAuth.password,
      HERMES_DASHBOARD_BASIC_AUTH_SECRET: dashboardAuth.secret,
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
    await this._writeFile(vmid, HERMES_MANAGED_ENV_NAMES_FILE, "", "0600", { signal });
    await this._writeFile(vmid, HERMES_PRESTART_FILE, buildHermesPrestartScript(), "0700", {
      signal,
    });
    await this._writeFile(
      vmid,
      HERMES_PRESTART_DROPIN_FILE,
      buildSystemdPrestartDropin(HERMES_PRESTART_FILE),
      "0644",
      { signal },
    );
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
      `nohup "$HERMES_BIN" dashboard --host ${dashboardHost} --no-open >> /var/log/nora/hermes-dashboard.log 2>&1 &`,
      'exec "$HERMES_BIN" gateway run',
      "",
    ].join("\n");
    await this._writeFile(vmid, "/opt/nora-hermes/start.sh", startupScript, "0750", {
      signal,
    });
    await this._pctExec(
      vmid,
      [
        `chown hermes:hermes ${shellSingleQuote(HERMES_ENV_FILE)}`,
        `chown hermes:hermes ${shellSingleQuote(HERMES_MANAGED_ENV_NAMES_FILE)}`,
        `chown hermes:hermes ${shellSingleQuote(HERMES_PRESTART_FILE)}`,
        "chown root:hermes /opt/nora-hermes/start.sh",
      ].join(" && "),
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
    const managedEnvNames = normalizeManagedEnvNames(options.managedEnvNames);
    const replacementNames = [...new Set([...managedEnvNames, ...Object.keys(entries)])].sort();
    if (replacementNames.length === 0) return;
    await this._assertOwnedLxc(vmid, options, { operation: "update the environment of" });
    const runtimeFamily = options.runtimeFamily === "hermes" ? "hermes" : "openclaw";
    const current = await this._requestData(
      "GET",
      `/nodes/${this.node}/lxc/${vmid}/status/current`,
      null,
      options.signal ? { signal: options.signal } : {},
    );
    if (current?.status === "stopped") {
      return this._stageManagedStateWhileStopped(vmid, entries, replacementNames, {
        ...options,
        runtimeFamily,
        replaceManagedState: options.replaceManagedState === true,
      });
    }
    if (current?.status !== "running") {
      const error = new Error(
        `Proxmox LXC ${vmid} environment cannot be updated because its status is unconfirmed`,
      );
      error.code = "PROXMOX_RUNTIME_STATUS_UNCONFIRMED";
      throw error;
    }

    const envFile = runtimeFamily === "hermes" ? HERMES_ENV_FILE : OPENCLAW_ENV_FILE;
    const managedNamesFile =
      runtimeFamily === "hermes" ? HERMES_MANAGED_ENV_NAMES_FILE : OPENCLAW_MANAGED_ENV_NAMES_FILE;
    const nonce = crypto.randomBytes(8).toString("hex");
    const patchFile = `/tmp/nora-env-${nonce}.patch`;
    const keysFile = `/tmp/nora-env-${nonce}.keys`;
    const scopeFile = `/tmp/nora-env-${nonce}.scope`;
    try {
      await this._writeFile(vmid, patchFile, serializeEnvironment(entries), "0600", options);
      await this._writeFile(vmid, keysFile, `${replacementNames.join("\n")}\n`, "0600", options);
      await this._writeFile(vmid, scopeFile, `${replacementNames.join("\n")}\n`, "0600", options);
      await this._pctExec(
        vmid,
        [
          "set -eu",
          `current=${shellSingleQuote(envFile)}`,
          `patch=${shellSingleQuote(patchFile)}`,
          `keys=${shellSingleQuote(keysFile)}`,
          `scope=${shellSingleQuote(scopeFile)}`,
          `managed_names=${shellSingleQuote(managedNamesFile)}`,
          `replace_managed_state=${options.replaceManagedState === true ? "1" : "0"}`,
          'mkdir -p "$(dirname "$current")"',
          'touch "$current"',
          'touch "$managed_names"',
          'effective_keys="$(mktemp)"',
          'cat "$keys" > "$effective_keys"',
          'sort -u "$effective_keys" -o "$effective_keys"',
          'tmp="$(mktemp)"',
          'awk -F= \'NR==FNR { if ($1 != "") managed[$1]=1; next } !($1 in managed)\' "$effective_keys" "$current" > "$tmp"',
          'awk \'NF { print }\' "$patch" >> "$tmp"',
          'install -m 0600 "$tmp" "$current"',
          'names_tmp="$(mktemp)"',
          'cat "$managed_names" > "$names_tmp"',
          'cat "$scope" >> "$names_tmp"',
          'sort -u "$names_tmp" -o "$names_tmp"',
          'install -m 0600 "$names_tmp" "$managed_names"',
          runtimeFamily === "hermes" ? 'chown hermes:hermes "$current" "$managed_names"' : "true",
          'rm -f "$tmp" "$names_tmp" "$effective_keys" "$patch" "$keys" "$scope"',
        ].join("\n"),
        options,
      );

      if (runtimeFamily === "hermes") {
        await this._writeFile(
          vmid,
          HERMES_PRESTART_FILE,
          buildHermesPrestartScript(),
          "0700",
          options,
        );
        await this._writeFile(
          vmid,
          HERMES_PRESTART_DROPIN_FILE,
          buildSystemdPrestartDropin(HERMES_PRESTART_FILE),
          "0644",
          options,
        );
        await this._pctExec(
          vmid,
          `chown hermes:hermes ${shellSingleQuote(HERMES_PRESTART_FILE)} && systemctl daemon-reload`,
          options,
        );
      } else {
        await this._writeFile(
          vmid,
          "/opt/openclaw-runtime/lib/build-auth.js",
          buildOpenClawAuthBuilderScript(),
          "0600",
          options,
        );
        await this._writeFile(
          vmid,
          OPENCLAW_PRESTART_RECONCILER_FILE,
          buildOpenClawPrestartReconcilerScript(),
          "0600",
          options,
        );
        await this._writeFile(
          vmid,
          OPENCLAW_PRESTART_FILE,
          buildOpenClawPrestartScript(),
          "0700",
          options,
        );
        await this._writeFile(
          vmid,
          OPENCLAW_PROVIDER_BOOTSTRAP_FILE,
          buildNoopProviderBootstrapScript(),
          "0700",
          options,
        );
        await this._writeFile(
          vmid,
          OPENCLAW_MCP_WRAPPER_FILE,
          buildMcpServerWrapperScript(),
          "0755",
          options,
        );
        await this._writeFile(
          vmid,
          OPENCLAW_PRESTART_DROPIN_FILE,
          buildSystemdPrestartDropin(OPENCLAW_PRESTART_FILE),
          "0644",
          options,
        );
        await this._pctExec(vmid, "systemctl daemon-reload", options);
      }
    } catch (error) {
      try {
        await this._pctExec(
          vmid,
          `rm -f ${shellSingleQuote(patchFile)} ${shellSingleQuote(keysFile)} ${shellSingleQuote(scopeFile)}`,
          options,
        );
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
    const command = this._hostCommand(this.pctCommand, [
      "exec",
      vmid,
      "--",
      "journalctl",
      "-u",
      "nora-openclaw.service",
      "-u",
      "nora-hermes.service",
      "-n",
      String(tail),
      ...(opts.follow !== false ? ["-f"] : []),
      "--no-pager",
    ]);
    return this._openSshStream(command, {
      signal: opts.signal,
      requireSuccess: true,
    }).stream;
  }

  _openSshStream(
    command,
    { interactive = false, tty = false, signal, requireSuccess = false } = {},
  ) {
    this._assertConfigured();
    throwIfAborted(signal, "Proxmox SSH stream");
    const output = new PassThrough();
    const input = interactive ? new PassThrough() : null;
    const conn = this._createSshClient();
    let remoteStream = null;
    let running = true;
    let exitCode = null;
    let observedExitCode = null;
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const finish = (code = 0) => {
      if (!running) return;
      running = false;
      exitCode = Number.isInteger(code) ? code : null;
      signal?.removeEventListener("abort", onAbort);
      resolveExit({ Running: false, ExitCode: exitCode });
      if (!output.destroyed) {
        if (requireSuccess && exitCode !== 0) {
          const error = Number.isInteger(exitCode)
            ? new Error(`Proxmox SSH stream command exited with ${exitCode}`)
            : new Error("Proxmox SSH stream closed without a confirmed remote exit status");
          if (!Number.isInteger(exitCode)) {
            error.code = "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED";
          }
          output.destroy(error);
        } else {
          output.end();
        }
      }
      conn.end();
    };
    const fail = (error) => {
      if (!running) return;
      running = false;
      exitCode = null;
      signal?.removeEventListener("abort", onAbort);
      resolveExit({ Running: false, ExitCode: null });
      if (!output.destroyed) output.destroy(error);
      conn.end();
    };
    const onAbort = () => {
      try {
        remoteStream?.signal("TERM");
      } catch {
        // Worker commands use a second fixed cleanup exec to prove termination.
      }
      fail(abortError(signal, "Proxmox SSH stream"));
    };
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
          if (!running) {
            try {
              stream.signal("TERM");
              stream.close();
            } catch {
              // The caller already receives an unconfirmed exit state.
            }
            return;
          }
          remoteStream = stream;
          stream.on("data", (chunk) => output.write(chunk));
          stream.stderr.on("data", (chunk) => output.write(chunk));
          stream.on("exit", (code) => {
            if (Number.isInteger(code)) observedExitCode = code;
          });
          stream.on("close", (code) => finish(Number.isInteger(code) ? code : observedExitCode));
          stream.on("error", (error) => {
            const unconfirmed = new Error(
              `Proxmox SSH stream failed before exit was confirmed: ${error.message}`,
              { cause: error },
            );
            unconfirmed.code = "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED";
            fail(unconfirmed);
          });
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
      .on("error", (error) => {
        if (!remoteStream) {
          fail(error);
          return;
        }
        const unconfirmed = new Error(
          `Proxmox SSH transport failed before remote command exit was confirmed: ${error.message}`,
          { cause: error },
        );
        unconfirmed.code = "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED";
        fail(unconfirmed);
      })
      .on("close", () => {
        if (!running) return;
        const unconfirmed = new Error(
          "Proxmox SSH transport closed before remote command exit was confirmed",
        );
        unconfirmed.code = "PROXMOX_SSH_EXEC_TERMINATION_UNCONFIRMED";
        fail(unconfirmed);
      })
      .connect(this._sshConfig());
    const originalDestroy = output.destroy.bind(output);
    output.destroy = (...args) => {
      try {
        remoteStream?.signal("TERM");
      } catch {
        // The SSH server may not implement channel signals.
      }
      try {
        remoteStream?.close();
      } catch {
        // The remote stream may already be closed.
      }
      if (running) {
        running = false;
        exitCode = null;
        signal?.removeEventListener("abort", onAbort);
        resolveExit({ Running: false, ExitCode: null });
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
      : String(cmd);
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
    const command = this._hostCommand(this.pctCommand, [
      "exec",
      vmid,
      "--",
      "/bin/sh",
      "-lc",
      guestCommand,
    ]);
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
