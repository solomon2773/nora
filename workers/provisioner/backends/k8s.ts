// @ts-nocheck
const k8s = require("@kubernetes/client-node");
const crypto = require("crypto");
const ProvisionerBackend = require("./interface");
const {
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawGatewayPairingCommand,
  buildOpenClawInstallCommand,
  buildOpenClawManagedConfigEnvPruneCommand,
  buildRuntimeBootstrapCommand,
  buildTemplatePayloadBootstrapCommand,
  buildRuntimeEnv,
  encodeOpenClawManagedMcpServers,
  OPENCLAW_MANAGED_MCP_SERVERS_ENV,
} = require("../../../agent-runtime/lib/runtimeBootstrap");
const {
  OPENCLAW_GATEWAY_PORT,
  AGENT_RUNTIME_PORT,
  HERMES_DASHBOARD_PORT,
} = require("../../../agent-runtime/lib/contracts");
const {
  getHermesDockerAgentImage,
  getStandardDockerPackageSpec,
} = require("../../../agent-runtime/lib/agentImages");
const { getNemoClawDefaultModel } = require("../../../agent-runtime/lib/nemoclawDefaults");
const { buildContainerBootstrap } = require("../../../agent-runtime/lib/containerCommand");
const {
  HERMES_MANAGED_ENV_ENV,
  HERMES_MODEL_CONFIG_ENV,
  buildHermesRuntimeConfigBootstrapCommand,
} = require("../../../agent-runtime/lib/hermesRuntimeBootstrap");
const {
  deriveHermesDashboardBasicAuth,
} = require("../../../agent-runtime/lib/hermesDashboardAuth");
const {
  buildTelemetry,
  buildUnavailableTelemetry,
  bytesToMegabytes,
  roundMetric,
} = require("./telemetry");

const HERMES_RUNTIME_PORT = 8642;
const HERMES_HOME = "/opt/data";
const HERMES_WORKSPACE = `${HERMES_HOME}/workspace`;
const HERMES_DASHBOARD_LOG = `${HERMES_HOME}/hermes-dashboard.log`;
const HERMES_BIN = "/opt/hermes/.venv/bin/hermes";
const HERMES_INIT_CAPABILITIES = Object.freeze([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "SETGID",
  "SETUID",
]);
const BOOTSTRAP_CONFIGMAP_KEY = "bootstrap.sh";
const BOOTSTRAP_MOUNT_PATH = "/opt/nora-bootstrap";
const BOOTSTRAP_SCRIPT_PATH = `${BOOTSTRAP_MOUNT_PATH}/${BOOTSTRAP_CONFIGMAP_KEY}`;
const K8S_POLICY_STATUS_SUPPORTED = "supported";
const K8S_POLICY_STATUS_DEGRADED = "degraded";
const K8S_METRICS_CAPABILITIES = Object.freeze({
  cpu: true,
  memory: true,
  network: false,
  disk: false,
  pids: false,
});
const K8S_UNAVAILABLE_CAPABILITIES = Object.freeze({
  cpu: false,
  memory: false,
  network: false,
  disk: false,
  pids: false,
});
const OPERATOR_POLICY_FAMILIES = Object.freeze(["openclaw", "hermes"]);
const MANAGED_ENV_NAMES_ANNOTATION = "nora.solomontsao.com/managed-env-names";
const K8S_MANAGED_ENV_STATE_ENV = "NORA_K8S_MANAGED_ENV_B64";
const SENSITIVE_ENV_PATTERNS = Object.freeze([
  /API_KEY/i,
  /TOKEN/i,
  /PASSWORD/i,
  /_PASS$/i,
  /SECRET/i,
  /PRIVATE_KEY/i,
  /PASSPHRASE/i,
  /CREDENTIAL/i,
  /SERVICE_ACCOUNT/i,
  /KUBECONFIG/i,
  /^PGPASSWORD$/i,
  /^API_SERVER_KEY$/i,
  /^OPENCLAW_GATEWAY_TOKEN$/i,
  // Hermes bootstrap blobs carry decrypted provider keys / channel tokens.
  /^NORA_HERMES_MANAGED_ENV_B64$/i,
  /^NORA_HERMES_MODEL_CONFIG_B64$/i,
]);
const RUNTIME_IDENTITY_SECRET_ENV_NAMES = new Set(["API_SERVER_KEY", "OPENCLAW_GATEWAY_TOKEN"]);

function parseK8sCpuCores(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)(n|u|m)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  switch (match[2]) {
    case "n":
      return amount / 1_000_000_000;
    case "u":
      return amount / 1_000_000;
    case "m":
      return amount / 1_000;
    default:
      return amount;
  }
}

function parseK8sMemoryBytes(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const match = raw.match(/^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)([a-zA-Z]+)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const suffix = match[2] || "";
  const multipliers = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
    k: 1000,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
    m: 1 / 1000,
  };

  return amount * (multipliers[suffix] || 1);
}

function formatKubeconfigLoadError(profile, executionTargetId, error) {
  const label = profile.label || executionTargetId || "Kubernetes cluster";
  const kubeconfigPath = String(profile.kubeconfigPath || "").trim();
  if (kubeconfigPath && error?.code === "ENOENT") {
    return `${label} mounted kubeconfig file was not found at ${kubeconfigPath}. Make sure NORA_KUBECONFIGS_DIR is mounted with docker-compose.kubernetes.yml and contains this file, or update the Admin Kubeconfig path to the file visible inside the Nora containers.`;
  }
  if (kubeconfigPath && error?.code === "EACCES") {
    return `${label} mounted kubeconfig file is not readable at ${kubeconfigPath}. Make sure the file is readable by the backend-api and worker-provisioner containers.`;
  }
  if (kubeconfigPath) {
    return `${label} mounted kubeconfig file at ${kubeconfigPath} could not be loaded: ${error?.message || "unknown error"}`;
  }
  return error?.message || "Kubernetes kubeconfig could not be loaded.";
}

function podUptimeSeconds(pod) {
  const startedAt =
    pod?.status?.containerStatuses?.find((status) => status?.state?.running?.startedAt)?.state
      ?.running?.startedAt || pod?.status?.startTime;
  const started = startedAt ? new Date(startedAt).getTime() : 0;
  if (!started || Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
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

function podSecurityContext() {
  return {
    seccompProfile: { type: "RuntimeDefault" },
  };
}

function containerSecurityContext({ hermesInit = false } = {}) {
  const capabilities = { drop: ["ALL"] };
  if (hermesInit) capabilities.add = [...HERMES_INIT_CAPABILITIES];

  return {
    allowPrivilegeEscalation: false,
    capabilities,
  };
}

function safeK8sName(name, fallback) {
  return safeHostname(name, fallback).slice(0, 63) || fallback;
}

function isSensitiveEnvName(name) {
  return SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(String(name || "")));
}

function parseManagedEnvNamesAnnotation(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((name) => String(name || "").trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function managedEnvNamesAnnotation(names = []) {
  return JSON.stringify(
    [...new Set((Array.isArray(names) ? names : []).map(String).map((name) => name.trim()))]
      .filter(Boolean)
      .sort(),
  );
}

function buildEnvEntries(envMap = {}, secretName = "", { forceSecretNames = [] } = {}) {
  const env = [];
  const stringData = {};
  const forced = new Set((forceSecretNames || []).map((name) => String(name || "").trim()));
  for (const [key, value] of Object.entries(envMap || {})) {
    if (!key || value == null) continue;
    if (forced.has(key) || isSensitiveEnvName(key)) {
      stringData[key] = String(value);
      env.push({
        name: key,
        valueFrom: {
          secretKeyRef: {
            name: secretName,
            key,
            optional: true,
          },
        },
      });
      continue;
    }
    env.push({ name: key, value: String(value) });
  }
  return { env, stringData };
}

function ensureManagedSecretEnvEntries(env = [], managedNames = [], secretName = "") {
  const next = [...env];
  const existing = new Set(next.map((entry) => String(entry?.name || "")).filter(Boolean));
  for (const rawName of managedNames || []) {
    const name = String(rawName || "").trim();
    if (!name || existing.has(name)) continue;
    next.push({
      name,
      valueFrom: { secretKeyRef: { name: secretName, key: name, optional: true } },
    });
    existing.add(name);
  }
  return next;
}

function encodeKubernetesManagedEnvState(managedNames = [], values = {}) {
  return Buffer.from(
    JSON.stringify({
      managedNames: [...new Set((managedNames || []).map(String).filter(Boolean))].sort(),
      values: Object.fromEntries(
        Object.entries(values || {}).map(([name, value]) => [String(name), String(value ?? "")]),
      ),
    }),
    "utf8",
  ).toString("base64");
}

function buildKubernetesManagedEnvApplyCommand() {
  return [
    `if [ -n "\${${K8S_MANAGED_ENV_STATE_ENV}:-}" ]; then`,
    "  nora_k8s_managed_env_commands=\"$(node <<'__NORA_K8S_MANAGED_ENV__'",
    `const encoded = String(process.env.${K8S_MANAGED_ENV_STATE_ENV} || '');`,
    "const state = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));",
    "const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;",
    "const names = Array.isArray(state.managedNames) ? state.managedNames : [];",
    "const values = state && state.values && typeof state.values === 'object' && !Array.isArray(state.values) ? state.values : {};",
    "const quote = (value) => `'${String(value).replace(/'/g, `'\\\"'\\\"'`)}'`;",
    "for (const name of names) { if (!validName.test(String(name))) throw new Error('Invalid managed env name'); process.stdout.write(`unset ${name}\\n`); }",
    "for (const [name, value] of Object.entries(values)) { if (!validName.test(name)) throw new Error('Invalid managed env name'); process.stdout.write(`export ${name}=${quote(value)}\\n`); }",
    "__NORA_K8S_MANAGED_ENV__",
    '  )"',
    '  eval "$nora_k8s_managed_env_commands"',
    "  unset nora_k8s_managed_env_commands",
    "fi",
  ].join("\n");
}

function defaultDeployNameForRuntime(runtimeFamily, id, name) {
  const prefix = runtimeFamily === "hermes" ? "nora-hermes" : "nora-oclaw";
  return safeK8sName(`${prefix}-${name || "agent"}-${id}`, `${prefix}-${id}`);
}

function buildHermesStartCommand() {
  // The Hermes pod launches args-only (no `command:` override), so the image
  // ENTRYPOINT — /init, s6-overlay running as PID 1 — stays intact and
  // supervises this script directly. Do NOT re-exec /init here: a second s6
  // init launched as a non-PID-1 child fatals with "s6-overlay-suexec: can
  // only run as pid 1" and exits the container before the gateway can bind
  // the runtime port for the startup probe (#297). Returning the runtime
  // command directly lets the image's PID-1 /init supervise it naturally.
  return [
    "set -eu",
    buildKubernetesManagedEnvApplyCommand(),
    buildHermesRuntimeConfigBootstrapCommand(),
    `HERMES_BIN="${HERMES_BIN}"`,
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes)"',
    `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open >> ${HERMES_DASHBOARD_LOG} 2>&1 &`,
    'exec "$HERMES_BIN" gateway run',
  ].join("\n");
}

function buildHermesPostStartCommand() {
  return [
    "set -eu",
    `if [ -z "\${${HERMES_MANAGED_ENV_ENV}:-}" ] && [ -z "\${${HERMES_MODEL_CONFIG_ENV}:-}" ]; then exit 0; fi`,
    // The Hermes image migrates/seeds config.yaml in s6 cont-init. Run after
    // that has had a short window, then use Hermes's own config helpers.
    'sleep "${NORA_HERMES_BOOTSTRAP_DELAY_SECONDS:-8}"',
    buildHermesRuntimeConfigBootstrapCommand(),
  ].join("\n");
}

function buildOpenClawRuntimeAuthBootstrapCommand() {
  const providerMap = {
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
  const endpointEnvMap = {
    MICROSOFT_FOUNDRY_API_KEY: "MICROSOFT_FOUNDRY_BASE_URL",
  };
  const staticEndpointMap = {
    GEMINI_API_KEY: "https://generativelanguage.googleapis.com/v1beta",
    NVIDIA_API_KEY: "https://integrate.api.nvidia.com/v1",
  };
  const apiVersionEnvMap = {
    MICROSOFT_FOUNDRY_API_KEY: "MICROSOFT_FOUNDRY_API_VERSION",
  };
  const foundryModels = [
    {
      id: "gpt-5.5",
      name: "GPT-5.5 (Azure)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 16384,
      compat: { supportsStore: false, supportsReasoningEffort: true },
    },
    {
      id: "gpt-5.5-mini",
      name: "GPT-5.5 Mini (Azure)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 16384,
      compat: { supportsStore: false, supportsReasoningEffort: true },
    },
    {
      id: "gpt-5.5-pro",
      name: "GPT-5.5 Pro (Azure)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 128000,
      compat: { supportsStore: false, supportsReasoningEffort: true },
    },
    {
      id: "gpt-5.2-codex",
      name: "GPT-5.2 Codex (Azure)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 16384,
      compat: { supportsStore: false, supportsReasoningEffort: true },
    },
    {
      id: "o3",
      name: "o3 (Azure)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 100000,
      compat: { supportsStore: false, supportsReasoningEffort: true },
    },
  ].map((entry) => ({ ...entry, api: "azure-openai-responses" }));

  return [
    "node <<'__NORA_OPENCLAW_AUTH_BOOTSTRAP__'",
    "const fs = require('fs');",
    `const providerMap = ${JSON.stringify(providerMap)};`,
    `const endpointEnvMap = ${JSON.stringify(endpointEnvMap)};`,
    `const staticEndpointMap = ${JSON.stringify(staticEndpointMap)};`,
    `const apiVersionEnvMap = ${JSON.stringify(apiVersionEnvMap)};`,
    `const foundryModels = ${JSON.stringify(foundryModels)};`,
    "const authPath = '/root/.openclaw/agents/main/agent/auth-profiles.json';",
    "const configPath = '/root/.openclaw/openclaw.json';",
    "const defaultModelMarkerPath = '/root/.openclaw/.nora-managed-default-model';",
    "const auth = { version: 1, profiles: {}, order: {}, lastGood: {} };",
    "for (const [envKey, provider] of Object.entries(providerMap)) {",
    "  const key = process.env[envKey];",
    "  if (!key) continue;",
    "  const profileId = `${provider}:default`;",
    "  const endpointEnv = endpointEnvMap[envKey];",
    "  const apiVersionEnv = apiVersionEnvMap[envKey];",
    "  const endpoint = (endpointEnv && process.env[endpointEnv]) || staticEndpointMap[envKey] || '';",
    "  const apiVersion = apiVersionEnv && process.env[apiVersionEnv] ? process.env[apiVersionEnv] : '';",
    "  auth.profiles[profileId] = { type: 'api_key', provider, key };",
    "  if (endpoint) auth.profiles[profileId].endpoint = endpoint;",
    "  if (apiVersion) auth.profiles[profileId].api_version = apiVersion;",
    "  auth.order[provider] = [profileId];",
    "  auth.lastGood[provider] = profileId;",
    "}",
    "fs.mkdirSync('/root/.openclaw/agents/main/agent', { recursive: true });",
    "fs.writeFileSync(authPath, JSON.stringify(auth));",
    "fs.chmodSync(authPath, 0o600);",
    "let config = {};",
    "try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { config = {}; }",
    "if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};",
    "const defaultModel = String(process.env.NORA_DEFAULT_OPENCLAW_MODEL || '').trim();",
    "const foundryDefaultPrefix = 'azure-openai-responses/';",
    "const defaultFoundryDeployment = defaultModel.startsWith(foundryDefaultPrefix) ? defaultModel.slice(foundryDefaultPrefix.length).trim() : '';",
    "function buildFoundryModelEntries() {",
    "  if (!defaultFoundryDeployment) return foundryModels;",
    "  const baseModelId = defaultFoundryDeployment.replace(/-\\d+$/, '');",
    "  const template = foundryModels.find((model) => model.id === defaultFoundryDeployment) || foundryModels.find((model) => model.id === baseModelId) || foundryModels[0] || {};",
    "  return [{",
    "    ...template,",
    "    id: defaultFoundryDeployment,",
    "    name: `${defaultFoundryDeployment} (Azure deployment)`,",
    "    api: 'azure-openai-responses',",
    "  }];",
    "}",
    "const foundryKey = process.env.MICROSOFT_FOUNDRY_API_KEY;",
    "const foundryBaseUrlRaw = process.env.MICROSOFT_FOUNDRY_BASE_URL;",
    "config.models = config.models && typeof config.models === 'object' && !Array.isArray(config.models) ? config.models : {};",
    "config.models.providers = config.models.providers && typeof config.models.providers === 'object' && !Array.isArray(config.models.providers) ? config.models.providers : {};",
    "delete config.models.providers['azure-openai-responses'];",
    "if (foundryKey && foundryBaseUrlRaw) {",
    "  config.models.providers['azure-openai-responses'] = {",
    "    api: 'azure-openai-responses',",
    "    baseUrl: String(foundryBaseUrlRaw).replace(/\\/+$/, ''),",
    "    models: buildFoundryModelEntries(),",
    "  };",
    "}",
    "if (Object.keys(config.models.providers).length === 0) delete config.models.providers;",
    "if (Object.keys(config.models).length === 0) delete config.models;",
    "let previousManagedModel = '';",
    "try { previousManagedModel = String(fs.readFileSync(defaultModelMarkerPath, 'utf8') || '').trim(); } catch {}",
    "config.agents = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents) ? config.agents : {};",
    "config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === 'object' && !Array.isArray(config.agents.defaults) ? config.agents.defaults : {};",
    "config.agents.defaults.model = config.agents.defaults.model && typeof config.agents.defaults.model === 'object' && !Array.isArray(config.agents.defaults.model) ? config.agents.defaults.model : {};",
    "config.agents.defaults.models = config.agents.defaults.models && typeof config.agents.defaults.models === 'object' && !Array.isArray(config.agents.defaults.models) ? config.agents.defaults.models : {};",
    "if (previousManagedModel) {",
    "  delete config.agents.defaults.models[previousManagedModel];",
    "  if (config.agents.defaults.model.primary === previousManagedModel) delete config.agents.defaults.model.primary;",
    "}",
    "if (defaultModel) {",
    "  config.agents.defaults.model.primary = defaultModel;",
    "  config.agents.defaults.models[defaultModel] = config.agents.defaults.models[defaultModel] || {};",
    "  fs.writeFileSync(defaultModelMarkerPath, `${defaultModel}\\n`, { mode: 0o600 });",
    "} else {",
    "  try { fs.rmSync(defaultModelMarkerPath, { force: true }); } catch {}",
    "}",
    "if (Object.keys(config.agents.defaults.model).length === 0) delete config.agents.defaults.model;",
    "if (Object.keys(config.agents.defaults.models).length === 0) delete config.agents.defaults.models;",
    "if (Object.keys(config.agents.defaults).length === 0) delete config.agents.defaults;",
    "if (Object.keys(config.agents).length === 0) delete config.agents;",
    `const managedMcpEncoded = String(process.env.${OPENCLAW_MANAGED_MCP_SERVERS_ENV} || '');`,
    "if (managedMcpEncoded) {",
    "  let desiredMcpServers = {};",
    "  try { desiredMcpServers = JSON.parse(Buffer.from(managedMcpEncoded, 'base64').toString('utf8')); } catch { throw new Error('Invalid managed MCP server configuration'); }",
    "  if (!desiredMcpServers || typeof desiredMcpServers !== 'object' || Array.isArray(desiredMcpServers)) throw new Error('Managed MCP server configuration must be an object');",
    "  for (const server of Object.values(desiredMcpServers)) { if (server && typeof server === 'object') delete server.env; }",
    "  if (Object.keys(desiredMcpServers).length > 0) config.mcpServers = desiredMcpServers;",
    "  else delete config.mcpServers;",
    "}",
    "fs.mkdirSync('/root/.openclaw', { recursive: true });",
    "fs.writeFileSync(configPath, JSON.stringify(config, null, 2));",
    "__NORA_OPENCLAW_AUTH_BOOTSTRAP__",
    buildOpenClawAuthImportFromFileCommand({ requireCli: true }),
    "",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class K8sBackend extends ProvisionerBackend {
  constructor(profile = null) {
    super();
    this.profile = profile || {};
    this.executionTargetId = String(this.profile.executionTargetId || "")
      .trim()
      .toLowerCase();
    if (!this.executionTargetId.startsWith("k8s:")) {
      throw new Error("Kubernetes backend requires an Admin-registered cluster profile.");
    }
    this.clusterId = this.profile.id || this.executionTargetId.slice(4);
    this.executionTargetLabelValue = safeK8sName(
      String(this.executionTargetId).replace(/:/g, "-"),
      this.clusterId,
    );
    this.kc = new k8s.KubeConfig();
    try {
      if (this.profile.kubeconfigContent) {
        this.kc.loadFromString(this.profile.kubeconfigContent);
      } else if (this.profile.kubeconfigPath) {
        this.kc.loadFromFile(this.profile.kubeconfigPath);
      } else {
        throw new Error(
          `${this.profile.label || this.executionTargetId} requires kubeconfig content or a mounted kubeconfig path.`,
        );
      }
    } catch (error) {
      throw new Error(formatKubeconfigLoadError(this.profile, this.executionTargetId, error), {
        cause: error,
      });
    }
    if (this.profile.kubeContext && typeof this.kc.setCurrentContext === "function") {
      this.kc.setCurrentContext(this.profile.kubeContext);
    }
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    try {
      this.networkingApi =
        k8s.NetworkingV1Api && typeof this.kc.makeApiClient === "function"
          ? this.kc.makeApiClient(k8s.NetworkingV1Api)
          : null;
    } catch {
      this.networkingApi = null;
    }
    try {
      this.metricsApi =
        k8s.CustomObjectsApi && typeof this.kc.makeApiClient === "function"
          ? this.kc.makeApiClient(k8s.CustomObjectsApi)
          : null;
    } catch {
      this.metricsApi = null;
    }
    this.namespace = this.profile.namespace || "openclaw-agents";
    this.runtimeNamespaces = {
      openclaw:
        this.profile.openclawNamespace ||
        this.profile.runtimeNamespaces?.openclaw ||
        this.namespace,
      hermes:
        this.profile.hermesNamespace || this.profile.runtimeNamespaces?.hermes || this.namespace,
    };
    this.exposureMode = this._normalizeExposureMode(this.profile.exposureMode);
    this.serviceAnnotations = this._parseServiceAnnotations(this.profile.serviceAnnotations);
    this.loadBalancerSourceRanges = Array.isArray(this.profile.loadBalancerSourceRanges)
      ? this.profile.loadBalancerSourceRanges
      : this._parseCsv(this.profile.loadBalancerSourceRanges);
    this.loadBalancerClass = String(this.profile.loadBalancerClass || "").trim();
    this.loadBalancerReadyTimeoutMs = this._normalizePositiveInt(
      this.profile.loadBalancerReadyTimeoutMs,
      600000,
    );
    this.loadBalancerReadyIntervalMs = this._normalizePositiveInt(
      this.profile.loadBalancerReadyIntervalMs,
      5000,
    );
    this.runtimeHost = String(this.profile.runtimeHost || "").trim();
    this.configuredGatewayNodePort = this._normalizePort(this.profile.gatewayNodePort);
    this.configuredRuntimeNodePort = this._normalizePort(this.profile.runtimeNodePort);
    this.supportsNetworkPolicy = this.profile.supportsNetworkPolicy === true;
    this.policyEngine = String(this.profile.policyEngine || "").trim();
  }

  _normalizeExposureMode(value) {
    const normalized = String(value || "cluster-ip")
      .trim()
      .toLowerCase();
    if (normalized === "loadbalancer") return "load-balancer";
    return normalized;
  }

  _namespaceForRuntimeFamily(runtimeFamily = "openclaw") {
    const normalizedRuntimeFamily = String(runtimeFamily || "openclaw")
      .trim()
      .toLowerCase();
    return this.runtimeNamespaces[normalizedRuntimeFamily] || this.namespace;
  }

  _namespaceForDeployName(deployName) {
    const normalizedDeployName = String(deployName || "")
      .trim()
      .toLowerCase();
    if (
      normalizedDeployName.startsWith("nora-hermes-") ||
      normalizedDeployName.startsWith("hermes-agent-")
    ) {
      return this._namespaceForRuntimeFamily("hermes");
    }
    return this._namespaceForRuntimeFamily("openclaw");
  }

  _namespaceFromClusterHost(host, deployName = "") {
    const normalizedHost = String(host || "").trim();
    if (!normalizedHost) return "";

    const escapedDeployName = String(deployName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const deployNameMatch = escapedDeployName
      ? normalizedHost.match(new RegExp(`^${escapedDeployName}\\.([^.]+)\\.svc(?:\\.|$)`))
      : null;
    if (deployNameMatch?.[1]) return deployNameMatch[1];

    return normalizedHost.match(/^[^.]+\.([^.]+)\.svc(?:\.|$)/)?.[1] || "";
  }

  _candidateNamespacesForDestroy(deployName, options = {}) {
    const namespaces = [];
    const add = (namespace) => {
      const value = String(namespace || "").trim();
      if (value && !namespaces.includes(value)) namespaces.push(value);
    };

    add(options.namespace);
    add(this._namespaceFromClusterHost(options.host, deployName));
    add(options.runtimeFamily ? this._namespaceForRuntimeFamily(options.runtimeFamily) : "");
    add(this._namespaceForDeployName(deployName));

    return namespaces;
  }

  _candidateNamespacesForRuntimeOperation(deployName, options = {}) {
    return this._candidateNamespacesForDestroy(deployName, options);
  }

  _normalizePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  _normalizePort(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  _parseCsv(value) {
    return String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  _parseServiceAnnotations(rawValue) {
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      return Object.fromEntries(
        Object.entries(rawValue).map(([key, value]) => [key, String(value)]),
      );
    }
    const raw = String(rawValue || "").trim();
    if (!raw) return {};

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Kubernetes service annotations must be valid JSON: ${error.message}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Kubernetes service annotations must be a JSON object");
    }

    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }

  _isNodePortExposure() {
    return this.exposureMode === "node-port";
  }

  _isLoadBalancerExposure() {
    return this.exposureMode === "load-balancer";
  }

  _serviceType() {
    if (this._isNodePortExposure()) return "NodePort";
    if (this._isLoadBalancerExposure()) return "LoadBalancer";
    return "ClusterIP";
  }

  _runtimePort(runtimeFamily = "openclaw") {
    return runtimeFamily === "hermes" ? HERMES_RUNTIME_PORT : AGENT_RUNTIME_PORT;
  }

  _secondaryPort(runtimeFamily = "openclaw") {
    return runtimeFamily === "hermes" ? HERMES_DASHBOARD_PORT : OPENCLAW_GATEWAY_PORT;
  }

  _secondaryPortName(runtimeFamily = "openclaw") {
    return runtimeFamily === "hermes" ? "dashboard" : "gateway";
  }

  _servicePorts(runtimeFamily = "openclaw") {
    const ports =
      runtimeFamily === "hermes"
        ? [
            { name: "runtime", port: HERMES_RUNTIME_PORT, targetPort: HERMES_RUNTIME_PORT },
            {
              name: "dashboard",
              port: HERMES_DASHBOARD_PORT,
              targetPort: HERMES_DASHBOARD_PORT,
            },
          ]
        : [
            { name: "gateway", port: OPENCLAW_GATEWAY_PORT, targetPort: OPENCLAW_GATEWAY_PORT },
            { name: "runtime", port: AGENT_RUNTIME_PORT, targetPort: AGENT_RUNTIME_PORT },
          ];

    if (!this._isNodePortExposure()) {
      return ports;
    }

    const configuredGatewayNodePort = this.configuredGatewayNodePort;
    const configuredRuntimeNodePort = this.configuredRuntimeNodePort;

    if (runtimeFamily !== "hermes" && configuredGatewayNodePort) {
      ports[0].nodePort = configuredGatewayNodePort;
    }
    if (configuredRuntimeNodePort) {
      const runtimePort = ports.find((port) => port.name === "runtime");
      if (runtimePort) runtimePort.nodePort = configuredRuntimeNodePort;
    }
    if (runtimeFamily === "hermes" && configuredGatewayNodePort) {
      const dashboardPort = ports.find((port) => port.name === "dashboard");
      if (dashboardPort) dashboardPort.nodePort = configuredGatewayNodePort;
    }

    return ports;
  }

  _servicePortsWithoutNodePorts(ports = []) {
    return ports.map(({ nodePort, ...port }) => ({ ...port }));
  }

  _sandboxProfileLabelValue(isNemoClaw) {
    return isNemoClaw ? "nemoclaw" : "standard";
  }

  _sandboxProfileLabelMap(isNemoClaw) {
    return { "nora.sandbox.profile": this._sandboxProfileLabelValue(isNemoClaw) };
  }

  _isIpAddress(value) {
    return (
      typeof value === "string" &&
      (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.trim()) || /^[0-9a-f:]+$/i.test(value.trim()))
    );
  }

  _hostToIpBlock(host) {
    const normalized = String(host || "").trim();
    if (!normalized || !this._isIpAddress(normalized)) return null;
    return normalized.includes(":") ? `${normalized}/128` : `${normalized}/32`;
  }

  _trustedIngressCidrs() {
    if (this.loadBalancerSourceRanges.length > 0) {
      return this.loadBalancerSourceRanges;
    }

    const runtimeHostBlock = this._hostToIpBlock(this.runtimeHost);
    return runtimeHostBlock ? [runtimeHostBlock] : [];
  }

  _policyFamilyConfig(runtimeFamily = "openclaw") {
    if (runtimeFamily === "hermes") {
      return {
        runtimeFamily: "hermes",
        selector: {
          app: "hermes-agent",
          "nora.kubernetes.cluster": String(this.clusterId),
        },
        ports: [
          { protocol: "TCP", port: HERMES_RUNTIME_PORT },
          { protocol: "TCP", port: HERMES_DASHBOARD_PORT },
        ],
        policyPrefix: "nora-hermes",
      };
    }

    return {
      runtimeFamily: "openclaw",
      selector: {
        app: "openclaw-agent",
        "nora.kubernetes.cluster": String(this.clusterId),
      },
      ports: [
        { protocol: "TCP", port: OPENCLAW_GATEWAY_PORT },
        { protocol: "TCP", port: AGENT_RUNTIME_PORT },
      ],
      policyPrefix: "nora-openclaw",
    };
  }

  _policyName(runtimeFamily, suffix) {
    const family = this._policyFamilyConfig(runtimeFamily);
    return safeK8sName(`${family.policyPrefix}-${suffix}`, `${family.policyPrefix}-${suffix}`);
  }

  _buildDefaultDenyIngressPolicy(runtimeFamily, namespace) {
    const family = this._policyFamilyConfig(runtimeFamily);
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this._policyName(runtimeFamily, "default-deny-ingress"),
        namespace,
        labels: {
          "nora.kubernetes.cluster": this.clusterId,
          "nora.runtime.family": runtimeFamily,
        },
      },
      spec: {
        podSelector: { matchLabels: family.selector },
        policyTypes: ["Ingress"],
      },
    };
  }

  _buildTrustedIngressPolicy(runtimeFamily, namespace, cidrs) {
    const family = this._policyFamilyConfig(runtimeFamily);
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this._policyName(runtimeFamily, "allow-trusted-ingress"),
        namespace,
        labels: {
          "nora.kubernetes.cluster": this.clusterId,
          "nora.runtime.family": runtimeFamily,
        },
      },
      spec: {
        podSelector: { matchLabels: family.selector },
        policyTypes: ["Ingress"],
        ingress: [
          {
            _from: cidrs.map((cidr) => ({ ipBlock: { cidr } })),
            ports: family.ports,
          },
        ],
      },
    };
  }

  _operatorPolicyName(runtimeFamily, suffix) {
    return this._policyName(runtimeFamily, suffix);
  }

  _buildOperatorIngressPeers(rules = []) {
    return rules.map((rule) => ({ ipBlock: { cidr: rule.cidr } }));
  }

  _buildOperatorIngressPorts(rules = []) {
    return rules.map((rule) => ({
      protocol: "TCP",
      port: rule,
    }));
  }

  _buildOperatorIngressPolicy(runtimeFamily, namespace, rules = []) {
    const family = this._policyFamilyConfig(runtimeFamily);
    const normalizedRules = Array.isArray(rules) ? rules : [];
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this._operatorPolicyName(runtimeFamily, "operator-allow-ingress"),
        namespace,
        labels: {
          "nora.kubernetes.cluster": this.clusterId,
          "nora.runtime.family": runtimeFamily,
          "nora.policy.owner": "operator",
          "nora.policy.kind": "operator-ingress",
        },
      },
      spec: {
        podSelector: { matchLabels: family.selector },
        policyTypes: ["Ingress"],
        ingress: normalizedRules.map((rule) => ({
          _from: [{ ipBlock: { cidr: rule.cidr } }],
          ports: this._buildOperatorIngressPorts(rule.ports),
        })),
      },
    };
  }

  _buildNemoclawDenyEgressPolicy(namespace) {
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this._policyName("openclaw", "nemoclaw-default-deny-egress"),
        namespace,
        labels: {
          "nora.kubernetes.cluster": this.clusterId,
          "nora.runtime.family": "openclaw",
          "nora.sandbox.profile": "nemoclaw",
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            ...this._policyFamilyConfig("openclaw").selector,
            "nora.sandbox.profile": "nemoclaw",
          },
        },
        policyTypes: ["Egress"],
      },
    };
  }

  _buildNemoclawDnsPolicy(namespace) {
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this._policyName("openclaw", "nemoclaw-allow-dns"),
        namespace,
        labels: {
          "nora.kubernetes.cluster": this.clusterId,
          "nora.runtime.family": "openclaw",
          "nora.sandbox.profile": "nemoclaw",
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            ...this._policyFamilyConfig("openclaw").selector,
            "nora.sandbox.profile": "nemoclaw",
          },
        },
        policyTypes: ["Egress"],
        egress: [
          {
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    };
  }

  _buildNemoclawExternalEgressPolicy(namespace) {
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this._policyName("openclaw", "nemoclaw-allow-external-web"),
        namespace,
        labels: {
          "nora.kubernetes.cluster": this.clusterId,
          "nora.runtime.family": "openclaw",
          "nora.sandbox.profile": "nemoclaw",
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            ...this._policyFamilyConfig("openclaw").selector,
            "nora.sandbox.profile": "nemoclaw",
          },
        },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
            ports: [
              { protocol: "TCP", port: 80 },
              { protocol: "TCP", port: 443 },
            ],
          },
        ],
      },
    };
  }

  _buildNetworkPolicies({ runtimeFamily = "openclaw", sandboxProfile = "standard", namespace }) {
    const trustedIngressCidrs = this._trustedIngressCidrs();
    if (trustedIngressCidrs.length === 0) {
      return {
        policies: [],
        status: {
          policyStatus: K8S_POLICY_STATUS_DEGRADED,
          policyBundleAttempted: false,
          policyBundleApplied: false,
          policyIssue:
            "Trusted ingress CIDRs could not be determined for this execution target, so Kubernetes NetworkPolicy enforcement was skipped.",
        },
      };
    }

    const policies = [
      this._buildDefaultDenyIngressPolicy(runtimeFamily, namespace),
      this._buildTrustedIngressPolicy(runtimeFamily, namespace, trustedIngressCidrs),
    ];

    if (runtimeFamily === "openclaw" && sandboxProfile === "nemoclaw") {
      policies.push(this._buildNemoclawDenyEgressPolicy(namespace));
      policies.push(this._buildNemoclawDnsPolicy(namespace));
      policies.push(this._buildNemoclawExternalEgressPolicy(namespace));
    }

    return {
      policies,
      status: {
        policyStatus: K8S_POLICY_STATUS_SUPPORTED,
        policyBundleAttempted: true,
        policyBundleApplied: true,
        policyIssue: null,
      },
    };
  }

  async _upsertNetworkPolicy(policy, namespace = this.namespace) {
    if (!this.networkingApi) {
      throw new Error("Kubernetes NetworkingV1Api client is not available.");
    }
    const name = policy?.metadata?.name;
    try {
      await this.networkingApi.createNamespacedNetworkPolicy({
        namespace,
        body: policy,
      });
    } catch (error) {
      if (!this._isAlreadyExistsError(error)) throw error;

      const current = this._serviceObject(
        await this.networkingApi.readNamespacedNetworkPolicy({
          name,
          namespace,
        }),
      );
      policy.metadata.resourceVersion = current?.metadata?.resourceVersion;
      await this.networkingApi.replaceNamespacedNetworkPolicy({
        name,
        namespace,
        body: policy,
      });
    }
  }

  async _deleteNetworkPolicyIfPresent(name, namespace = this.namespace) {
    if (!this.networkingApi) {
      throw new Error("Kubernetes NetworkingV1Api client is not available.");
    }
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({
        name,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (this._isNotFoundError(error)) return false;
      throw error;
    }

    await this._waitForDeleted("NetworkPolicy", name, namespace, () =>
      this.networkingApi.readNamespacedNetworkPolicy({ name, namespace }),
    );
    return true;
  }

  async _readNetworkPolicyIfPresent(name, namespace = this.namespace) {
    if (!this.networkingApi) {
      throw new Error("Kubernetes NetworkingV1Api client is not available.");
    }
    try {
      return this._serviceObject(
        await this.networkingApi.readNamespacedNetworkPolicy({
          name,
          namespace,
        }),
      );
    } catch (error) {
      if (this._isNotFoundError(error)) return null;
      throw error;
    }
  }

  async _reconcileNetworkPolicies({
    runtimeFamily = "openclaw",
    sandboxProfile = "standard",
    namespace,
  }) {
    if (!this.supportsNetworkPolicy || !this.networkingApi) {
      return {
        policyStatus: K8S_POLICY_STATUS_DEGRADED,
        policyBundleAttempted: false,
        policyBundleApplied: false,
        policyIssue:
          "Cluster does not currently advertise Kubernetes NetworkPolicy support. Nora deployed in degraded mode and skipped pod-level policy enforcement.",
      };
    }

    const { policies, status } = this._buildNetworkPolicies({
      runtimeFamily,
      sandboxProfile,
      namespace,
    });
    if (!status.policyBundleAttempted || policies.length === 0) {
      return status;
    }

    for (const policy of policies) {
      await this._upsertNetworkPolicy(policy, namespace);
    }

    return status;
  }

  async _reconcileOperatorIngressPolicies({ runtimeFamily = "openclaw", namespace, rules = [] }) {
    const name = this._operatorPolicyName(runtimeFamily, "operator-allow-ingress");
    if (!Array.isArray(rules) || rules.length === 0) {
      await this._deleteNetworkPolicyIfPresent(name, namespace);
      const current = await this._readNetworkPolicyIfPresent(name, namespace);
      if (current) {
        throw new Error(
          `Operator ingress policy ${name} still exists in ${namespace} after prune.`,
        );
      }
      return { namespace, name, applied: false, pruned: true };
    }

    const policy = this._buildOperatorIngressPolicy(runtimeFamily, namespace, rules);
    await this._upsertNetworkPolicy(policy, namespace);
    const current = await this._readNetworkPolicyIfPresent(name, namespace);
    if (!current?.metadata?.name) {
      throw new Error(`Operator ingress policy ${name} could not be read back from ${namespace}.`);
    }
    return { namespace, name, applied: true, pruned: false };
  }

  async _cleanupStaleOperatorIngressPolicies({
    runtimeFamily = "openclaw",
    currentNamespace,
    previousNamespaces = [],
  }) {
    const name = this._operatorPolicyName(runtimeFamily, "operator-allow-ingress");
    const namespaces = Array.from(
      new Set(
        (Array.isArray(previousNamespaces) ? previousNamespaces : [])
          .map((namespace) => String(namespace || "").trim())
          .filter(Boolean),
      ),
    ).filter((namespace) => namespace !== currentNamespace);

    for (const namespace of namespaces) {
      await this._deleteNetworkPolicyIfPresent(name, namespace);
      const current = await this._readNetworkPolicyIfPresent(name, namespace);
      if (current) {
        throw new Error(
          `Stale operator ingress policy ${name} still exists in ${namespace} after cleanup.`,
        );
      }
    }
  }

  async reconcilePolicySettings({ policySettings = null, policySettingsStatus = null } = {}) {
    if (!this.supportsNetworkPolicy || !this.networkingApi) {
      throw new Error(
        "Cluster does not currently advertise Kubernetes NetworkPolicy support for operator policy reconciliation.",
      );
    }

    const settings =
      policySettings && typeof policySettings === "object"
        ? policySettings
        : this.profile.policySettings;
    const status =
      policySettingsStatus && typeof policySettingsStatus === "object"
        ? policySettingsStatus
        : this.profile.policySettingsStatus || {};
    const ingressRules =
      settings?.ingressRules && typeof settings.ingressRules === "object"
        ? settings.ingressRules
        : {};
    const lastAppliedNamespaces =
      status?.lastAppliedNamespaces && typeof status.lastAppliedNamespaces === "object"
        ? status.lastAppliedNamespaces
        : {};

    const appliedNamespaces = {};
    for (const runtimeFamily of OPERATOR_POLICY_FAMILIES) {
      const namespace = this._namespaceForRuntimeFamily(runtimeFamily);
      const rules = Array.isArray(ingressRules[runtimeFamily]) ? ingressRules[runtimeFamily] : [];
      const previousNamespaces = Array.isArray(lastAppliedNamespaces[runtimeFamily])
        ? lastAppliedNamespaces[runtimeFamily]
        : [];

      await this._cleanupStaleOperatorIngressPolicies({
        runtimeFamily,
        currentNamespace: namespace,
        previousNamespaces,
      });
      await this._reconcileOperatorIngressPolicies({
        runtimeFamily,
        namespace,
        rules,
      });
      appliedNamespaces[runtimeFamily] = [namespace];
    }

    return {
      appliedNamespaces,
    };
  }

  _serviceObject(response) {
    return response?.body || response || {};
  }

  _loadBalancerAddress(service) {
    const ingress = service?.status?.loadBalancer?.ingress || [];
    const first = ingress.find((entry) => entry?.ip || entry?.hostname);
    return first?.ip || first?.hostname || null;
  }

  async _waitForLoadBalancerAddress(deployName, initialService, namespace = this.namespace) {
    const deadline = Date.now() + this.loadBalancerReadyTimeoutMs;
    const halfway = Date.now() + this.loadBalancerReadyTimeoutMs / 2;
    let warned = false;
    let service = this._serviceObject(initialService);

    while (Date.now() <= deadline) {
      const address = this._loadBalancerAddress(service);
      if (address) return address;

      if (!warned && Date.now() >= halfway) {
        warned = true;
        console.warn(
          `[k8s] Still waiting for a LoadBalancer address for ${deployName} — ` +
            `each agent gets its own cloud load balancer + public IP in this exposure mode, ` +
            `so slow allocation usually means an LB/IP quota is nearly exhausted.`,
        );
      }

      await sleep(this.loadBalancerReadyIntervalMs);
      service = this._serviceObject(
        await this.coreApi.readNamespacedService({
          name: deployName,
          namespace,
        }),
      );
    }

    throw new Error(
      `Timed out waiting for a LoadBalancer address for ${deployName} after ` +
        `${this.loadBalancerReadyTimeoutMs}ms. This cluster's exposure mode allocates one ` +
        `cloud load balancer + public IP PER AGENT — check the provider's LB/public-IP quota, ` +
        `or switch the cluster's exposure mode to node-port/cluster-ip in Admin → Kubernetes.`,
    );
  }

  _agentIdFromDeployName(deployName) {
    return String(deployName || "").replace(
      /^(oclaw-agent-|hermes-agent-|nora-oclaw-|nora-hermes-)/,
      "",
    );
  }

  _bootstrapConfigMapName(deployName) {
    return `${deployName}-bootstrap`;
  }

  _envSecretName(deployName) {
    return `${deployName}-env`;
  }

  _bootstrapLaunch(bootstrap) {
    const interpreter =
      Array.isArray(bootstrap?.interpreter) && bootstrap.interpreter.length > 0
        ? bootstrap.interpreter
        : ["/bin/sh", "-c"];
    return {
      command: interpreter,
      args: [`. ${BOOTSTRAP_SCRIPT_PATH}`],
    };
  }

  _bootstrapVolume(configMapName) {
    return {
      name: "nora-bootstrap",
      configMap: {
        name: configMapName,
        defaultMode: 365,
      },
    };
  }

  _bootstrapVolumeMount() {
    return {
      name: "nora-bootstrap",
      mountPath: BOOTSTRAP_MOUNT_PATH,
      readOnly: true,
    };
  }

  _stateVolumeClaimName(deployName) {
    return `${deployName}-state`;
  }

  _stateVolume(claimName) {
    return {
      name: "nora-agent-state",
      persistentVolumeClaim: { claimName },
    };
  }

  _stateVolumeMount(mountPath) {
    return {
      name: "nora-agent-state",
      mountPath,
    };
  }

  // Agent state (OpenClaw config/auth/sessions/workspace, Hermes /opt/data)
  // must survive pod replacement — a k8s restart is a rollout and the
  // container writable layer is reset on every kubelet restart. RWO is
  // sufficient because agent Deployments run a single replica with
  // strategy Recreate (old pod terminates before the new one mounts).
  async _upsertStateVolumeClaim(deployName, { sizeGi, labels = {}, namespace } = {}) {
    const name = this._stateVolumeClaimName(deployName);
    const storage = `${Math.max(1, Math.round(Number(sizeGi) || 10))}Gi`;
    const body = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        namespace,
        labels: {
          "nora.agent.id": this._agentIdFromDeployName(deployName),
          "nora.agent.state": "true",
          "nora.execution.target": this.executionTargetLabelValue,
          "nora.kubernetes.cluster": this.clusterId,
          ...labels,
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage } },
      },
    };

    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim({ namespace, body });
    } catch (error) {
      // PVC specs are immutable once bound (apart from expansion); reuse the
      // existing claim as-is so retried creates don't fail.
      if (!this._isAlreadyExistsError(error)) throw error;
    }

    return name;
  }

  async _deleteStateVolumeClaimIfExists(deployName, namespace) {
    const name = this._stateVolumeClaimName(deployName);
    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim({
        name,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (this._isNotFoundError(error)) return false;
      throw error;
    }

    await this._waitForDeleted("PersistentVolumeClaim", name, namespace, () =>
      this.coreApi.readNamespacedPersistentVolumeClaim({ name, namespace }),
    );
    return true;
  }

  async _upsertBootstrapConfigMap(deployName, script, labels = {}, namespace = this.namespace) {
    const name = this._bootstrapConfigMapName(deployName);
    const body = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name,
        namespace,
        labels: {
          "nora.agent.id": this._agentIdFromDeployName(deployName),
          "nora.bootstrap": "true",
          "nora.execution.target": this.executionTargetLabelValue,
          "nora.kubernetes.cluster": this.clusterId,
          ...labels,
        },
      },
      data: {
        [BOOTSTRAP_CONFIGMAP_KEY]: String(script || ""),
      },
    };

    try {
      await this.coreApi.createNamespacedConfigMap({
        namespace,
        body,
      });
    } catch (error) {
      if (!this._isAlreadyExistsError(error)) throw error;

      const current = this._serviceObject(
        await this.coreApi.readNamespacedConfigMap({
          name,
          namespace,
        }),
      );
      body.metadata.resourceVersion = current?.metadata?.resourceVersion;
      await this.coreApi.replaceNamespacedConfigMap({
        name,
        namespace,
        body,
      });
    }

    return name;
  }

  async _upsertEnvSecret(deployName, stringData = {}, labels = {}, namespace = this.namespace) {
    const name = this._envSecretName(deployName);
    const body = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace,
        labels: {
          "nora.agent.id": this._agentIdFromDeployName(deployName),
          "nora.env": "true",
          "nora.execution.target": this.executionTargetLabelValue,
          "nora.kubernetes.cluster": this.clusterId,
          ...labels,
        },
      },
      type: "Opaque",
      stringData,
    };

    try {
      await this.coreApi.createNamespacedSecret({
        namespace,
        body,
      });
    } catch (error) {
      if (!this._isAlreadyExistsError(error)) throw error;

      const current = this._serviceObject(
        await this.coreApi.readNamespacedSecret({
          name,
          namespace,
        }),
      );
      body.metadata.resourceVersion = current?.metadata?.resourceVersion;
      await this.coreApi.replaceNamespacedSecret({
        name,
        namespace,
        body,
      });
    }

    return name;
  }

  async _createOrReplaceDeployment(deployName, deployment, namespace = this.namespace) {
    try {
      await this.appsApi.createNamespacedDeployment({
        namespace,
        body: deployment,
      });
    } catch (error) {
      if (!this._isAlreadyExistsError(error)) throw error;

      console.warn(`[k8s] Deployment ${deployName} already exists; replacing on retry`);
      const current = this._serviceObject(
        await this.appsApi.readNamespacedDeployment({
          name: deployName,
          namespace,
        }),
      );
      deployment.metadata.resourceVersion = current?.metadata?.resourceVersion;
      await this.appsApi.replaceNamespacedDeployment({
        name: deployName,
        namespace,
        body: deployment,
      });
    }
  }

  _buildService(
    deployName,
    { runtimeFamily = "openclaw", agentId = null, namespace = this.namespace } = {},
  ) {
    const resolvedAgentId = agentId || this._agentIdFromDeployName(deployName);
    const metadata = {
      name: deployName,
      namespace,
      labels: {
        "nora.agent.id": String(resolvedAgentId),
        "nora.deployment.name": deployName,
        "nora.runtime.family": runtimeFamily,
        "nora.execution.target": this.executionTargetLabelValue,
        "nora.kubernetes.cluster": this.clusterId,
      },
    };
    if (Object.keys(this.serviceAnnotations).length > 0) {
      metadata.annotations = this.serviceAnnotations;
    }

    const spec = {
      selector: { "nora.agent.id": String(resolvedAgentId) },
      ports: this._servicePorts(runtimeFamily),
      type: this._serviceType(),
    };
    if (this._isLoadBalancerExposure()) {
      // Preserve the original client IP so Nora's CIDR-based ingress
      // NetworkPolicies match the caller rather than an intermediate node IP.
      spec.externalTrafficPolicy = "Local";
      if (this.loadBalancerSourceRanges.length > 0) {
        spec.loadBalancerSourceRanges = this.loadBalancerSourceRanges;
      }
      if (this.loadBalancerClass) {
        spec.loadBalancerClass = this.loadBalancerClass;
      }
    }

    return {
      apiVersion: "v1",
      kind: "Service",
      metadata,
      spec,
    };
  }

  async _createOrReadService(deployName, service, namespace = this.namespace) {
    try {
      return await this.coreApi.createNamespacedService({
        namespace,
        body: service,
      });
    } catch (error) {
      if (this._isAlreadyExistsError(error)) {
        return this.coreApi.readNamespacedService({
          name: deployName,
          namespace,
        });
      }
      if (
        this._isNodePortExposure() &&
        service.spec.ports.some((port) => port.nodePort != null) &&
        this._isNodePortConflictError(error)
      ) {
        console.warn(
          `[k8s] Fixed NodePort allocation unavailable for ${deployName}; retrying with dynamic NodePorts`,
        );
        const dynamicService = {
          ...service,
          spec: {
            ...service.spec,
            ports: this._servicePortsWithoutNodePorts(service.spec.ports),
          },
        };
        return this.coreApi.createNamespacedService({
          namespace,
          body: dynamicService,
        });
      }
      throw error;
    }
  }

  async _buildEndpointResult({
    deployName,
    serviceResp,
    service,
    runtimeFamily,
    gatewayToken,
    namespace = this.namespace,
    policyStatus = null,
  }) {
    const host = `${deployName}.${namespace}.svc.cluster.local`;
    const servicePorts =
      serviceResp?.spec?.ports || serviceResp?.body?.spec?.ports || service.spec.ports;
    const runtimePort = this._runtimePort(runtimeFamily);
    const secondaryPort = this._secondaryPort(runtimeFamily);
    const secondaryPortName = this._secondaryPortName(runtimeFamily);

    if (this._isLoadBalancerExposure()) {
      const loadBalancerHost = await this._waitForLoadBalancerAddress(
        deployName,
        serviceResp,
        namespace,
      );
      console.log(
        `[k8s] Deployment ${deployName} created -> ${host} ` +
          `(load balancer ${loadBalancerHost})`,
      );
      return {
        containerId: deployName,
        host,
        gatewayToken,
        runtimeHost: loadBalancerHost,
        runtimePort,
        gatewayHost: loadBalancerHost,
        gatewayPort: secondaryPort,
        ...(policyStatus || {}),
      };
    }

    if (this._isNodePortExposure()) {
      const runtimeNodePort = servicePorts.find((port) => port.name === "runtime")?.nodePort;
      const secondaryNodePort = servicePorts.find(
        (port) => port.name === secondaryPortName,
      )?.nodePort;
      if (!runtimeNodePort || !secondaryNodePort) {
        throw new Error(
          `K8s NodePort exposure requires runtime and ${secondaryPortName} node ports`,
        );
      }

      const nodePortHost = this.runtimeHost || "host.docker.internal";

      console.log(
        `[k8s] Deployment ${deployName} created -> ${host} ` +
          `(runtime nodePort ${runtimeNodePort}, ${secondaryPortName} nodePort ${secondaryNodePort})`,
      );
      const result = {
        containerId: deployName,
        host,
        gatewayToken,
        runtimeHost: nodePortHost,
        runtimePort: runtimeNodePort,
        gatewayHost: nodePortHost,
        ...(policyStatus || {}),
      };
      if (runtimeFamily === "hermes") {
        result.gatewayPort = secondaryNodePort;
      } else {
        result.gatewayHostPort = secondaryNodePort;
      }
      return result;
    }

    console.log(
      `[k8s] Deployment ${deployName} created -> ${host} ` +
        `(${secondaryPortName} ${secondaryPort}, runtime ${runtimePort})`,
    );
    return {
      containerId: deployName,
      host,
      gatewayToken,
      runtimeHost: host,
      runtimePort,
      gatewayHost: host,
      gatewayPort: secondaryPort,
      ...(policyStatus || {}),
    };
  }

  _errorBodyText(error) {
    // v1.x error bodies arrive as strings on `error.body` or `error.responseBody`;
    // some flows expose them on `error.cause.body`. Stringify whatever we find.
    return String(
      error?.body?.message ||
        error?.body ||
        error?.responseBody ||
        error?.cause?.body ||
        error?.message ||
        "",
    );
  }

  _errorStatus(error) {
    return error?.statusCode || error?.code || error?.response?.status || null;
  }

  _isNotFoundError(error) {
    const text = this._errorBodyText(error);
    return this._errorStatus(error) === 404 || /\b404\b|not found|NotFound/i.test(text);
  }

  _isAlreadyExistsError(error) {
    const text = this._errorBodyText(error);
    return this._errorStatus(error) === 409 || /\b409\b|already exists|AlreadyExists/i.test(text);
  }

  async _waitForDeleted(kind, name, namespace, readFn, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await readFn();
      } catch (error) {
        if (this._isNotFoundError(error)) return true;
        throw error;
      }
      await sleep(1000);
    }

    throw new Error(`Timed out waiting for K8s ${kind} ${name} in ${namespace} to be deleted`);
  }

  async _deleteDeploymentIfExists(deployName, namespace) {
    try {
      await this.appsApi.deleteNamespacedDeployment({
        name: deployName,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (this._isNotFoundError(error)) return false;
      throw error;
    }

    await this._waitForDeleted("Deployment", deployName, namespace, () =>
      this.appsApi.readNamespacedDeployment({ name: deployName, namespace }),
    );
    return true;
  }

  async _deleteServiceIfExists(deployName, namespace) {
    try {
      await this.coreApi.deleteNamespacedService({
        name: deployName,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (this._isNotFoundError(error)) return false;
      throw error;
    }

    await this._waitForDeleted("Service", deployName, namespace, () =>
      this.coreApi.readNamespacedService({ name: deployName, namespace }),
    );
    return true;
  }

  async _deleteBootstrapConfigMapIfExists(deployName, namespace) {
    const name = this._bootstrapConfigMapName(deployName);
    try {
      await this.coreApi.deleteNamespacedConfigMap({
        name,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (this._isNotFoundError(error)) return false;
      throw error;
    }

    await this._waitForDeleted("ConfigMap", name, namespace, () =>
      this.coreApi.readNamespacedConfigMap({ name, namespace }),
    );
    return true;
  }

  // Merge new keys into the env Secret without dropping existing ones.
  // Used by updateEnv so rotated sensitive values stay in the Secret instead
  // of being downgraded to plaintext pod-spec env.
  async _mergeEnvSecretData(deployName, stringData = {}, namespace = this.namespace) {
    const name = this._envSecretName(deployName);
    let current = null;
    try {
      current = this._serviceObject(await this.coreApi.readNamespacedSecret({ name, namespace }));
    } catch (error) {
      if (!this._isNotFoundError(error)) throw error;
    }

    if (!current) {
      return this._upsertEnvSecret(deployName, stringData, {}, namespace);
    }

    // stringData overlays data on write, so existing keys survive untouched.
    const body = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: current.metadata,
      type: current.type || "Opaque",
      data: current.data || {},
      stringData,
    };
    await this.coreApi.replaceNamespacedSecret({ name, namespace, body });
    return name;
  }

  async _replaceManagedEnvSecretData(
    deployName,
    stringData = {},
    managedNames = [],
    namespace = this.namespace,
  ) {
    const name = this._envSecretName(deployName);
    const managed = new Set((managedNames || []).map((entry) => String(entry || "").trim()));
    let current = null;
    try {
      current = this._serviceObject(await this.coreApi.readNamespacedSecret({ name, namespace }));
    } catch (error) {
      if (!this._isNotFoundError(error)) throw error;
    }

    if (!current) {
      if (Object.keys(stringData).length === 0) return name;
      return this._upsertEnvSecret(deployName, stringData, {}, namespace);
    }

    const data = Object.fromEntries(
      Object.entries(current.data || {}).filter(([key]) => !managed.has(key)),
    );
    const body = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: current.metadata,
      type: current.type || "Opaque",
      data,
      stringData,
    };
    await this.coreApi.replaceNamespacedSecret({ name, namespace, body });
    return name;
  }

  async _deleteEnvSecretIfExists(deployName, namespace) {
    const name = this._envSecretName(deployName);
    try {
      await this.coreApi.deleteNamespacedSecret({
        name,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (this._isNotFoundError(error)) return false;
      throw error;
    }

    await this._waitForDeleted("Secret", name, namespace, () =>
      this.coreApi.readNamespacedSecret({ name, namespace }),
    );
    return true;
  }

  _isNodePortConflictError(error) {
    const text = this._errorBodyText(error);
    const status = this._errorStatus(error);
    return (
      (status === 422 || /\b422\b|Invalid/i.test(text)) &&
      /nodeport|provided port is already allocated/i.test(text)
    );
  }

  async _ensureNamespace(namespace = this.namespace) {
    try {
      await this.coreApi.readNamespace({ name: namespace });
    } catch {
      await this.coreApi.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespace },
        },
      });
    }
  }

  async _createHermes(config, deployName) {
    const { id, name, image, vcpu, ram_mb, disk_gb, env } = config;
    const credentialManagedEnvNames = Array.isArray(config.credentialManagedEnvNames)
      ? config.credentialManagedEnvNames
      : [];
    const namespace = this._namespaceForRuntimeFamily("hermes");
    const imgName = image || getHermesDockerAgentImage();
    const apiServerKey = config.gatewayToken || crypto.randomBytes(32).toString("hex");
    const dashboardAuth = deriveHermesDashboardBasicAuth(apiServerKey);

    await this._ensureNamespace(namespace);
    const policyStatus = await this._reconcileNetworkPolicies({
      runtimeFamily: "hermes",
      sandboxProfile: "standard",
      namespace,
    });
    console.log(`[k8s] Creating Hermes deployment ${deployName}`);

    const hermesBootstrap = buildContainerBootstrap(buildHermesStartCommand(), {
      shell: "/bin/bash",
      login: true,
    });
    const bootstrapConfigMapName = await this._upsertBootstrapConfigMap(
      deployName,
      hermesBootstrap.script,
      {
        "nora.agent.id": String(id),
        "nora.deployment.name": deployName,
        "nora.runtime.family": "hermes",
      },
      namespace,
    );
    const hermesLaunchArgs = ["bash", "-lc", `. ${BOOTSTRAP_SCRIPT_PATH}`];

    const hermesEnvMap = {
      ...(env || {}),
      [K8S_MANAGED_ENV_STATE_ENV]: encodeKubernetesManagedEnvState(credentialManagedEnvNames, {}),
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
    };
    const hermesSecretName = this._envSecretName(deployName);
    const { env: baseEnvVars, stringData: hermesSecretData } = buildEnvEntries(
      hermesEnvMap,
      hermesSecretName,
      { forceSecretNames: [...credentialManagedEnvNames, K8S_MANAGED_ENV_STATE_ENV] },
    );
    const envVars = baseEnvVars;
    if (Object.keys(hermesSecretData).length > 0) {
      await this._upsertEnvSecret(
        deployName,
        hermesSecretData,
        {
          "nora.agent.id": String(id),
          "nora.deployment.name": deployName,
          "nora.runtime.family": "hermes",
        },
        namespace,
      );
    }

    const stateClaimName = await this._upsertStateVolumeClaim(deployName, {
      sizeGi: disk_gb,
      labels: {
        "nora.agent.id": String(id),
        "nora.deployment.name": deployName,
        "nora.runtime.family": "hermes",
      },
      namespace,
    });

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deployName,
        namespace,
        annotations: {
          [MANAGED_ENV_NAMES_ANNOTATION]: managedEnvNamesAnnotation(credentialManagedEnvNames),
        },
        labels: {
          app: "hermes-agent",
          "nora.agent.id": String(id),
          "nora.deployment.name": deployName,
          "nora.runtime.family": "hermes",
          "nora.execution.target": this.executionTargetLabelValue,
          "nora.kubernetes.cluster": this.clusterId,
        },
      },
      spec: {
        replicas: 1,
        // Recreate is required for the RWO state volume and lets restarts
        // complete on capacity-constrained clusters: RollingUpdate's surge pod
        // needs a second full Guaranteed-QoS reservation, which sticks Pending
        // forever on a full cluster while the old pod keeps serving stale
        // config.
        strategy: { type: "Recreate" },
        selector: {
          matchLabels: { "nora.agent.id": String(id) },
        },
        template: {
          metadata: {
            labels: {
              app: "hermes-agent",
              "nora.agent.id": String(id),
              "nora.deployment.name": deployName,
              "nora.runtime.family": "hermes",
              "nora.execution.target": this.executionTargetLabelValue,
              "nora.kubernetes.cluster": this.clusterId,
            },
          },
          spec: {
            hostname: safeHostname(name || deployName, `hermes-${id}`),
            securityContext: podSecurityContext(),
            containers: [
              {
                name: "agent",
                image: imgName,
                args: hermesLaunchArgs,
                workingDir: HERMES_HOME,
                env: envVars,
                securityContext: containerSecurityContext({ hermesInit: true }),
                lifecycle: {
                  postStart: {
                    exec: {
                      command: ["/bin/sh", "-lc", buildHermesPostStartCommand()],
                    },
                  },
                },
                volumeMounts: [this._bootstrapVolumeMount(), this._stateVolumeMount(HERMES_HOME)],
                ports: [
                  { name: "runtime", containerPort: HERMES_RUNTIME_PORT },
                  { name: "dashboard", containerPort: HERMES_DASHBOARD_PORT },
                ],
                // See the OpenClaw deployment below for probe rationale; the
                // Hermes image boots faster (prebaked), so a shorter startup
                // budget suffices.
                startupProbe: {
                  tcpSocket: { port: HERMES_RUNTIME_PORT },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  tcpSocket: { port: HERMES_RUNTIME_PORT },
                  periodSeconds: 10,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  tcpSocket: { port: HERMES_RUNTIME_PORT },
                  periodSeconds: 30,
                  failureThreshold: 4,
                },
                resources: {
                  requests: {
                    cpu: `${(vcpu || 2) * 1000}m`,
                    memory: `${ram_mb || 2048}Mi`,
                  },
                  limits: {
                    cpu: `${(vcpu || 2) * 1000}m`,
                    memory: `${ram_mb || 2048}Mi`,
                  },
                },
              },
            ],
            volumes: [
              this._bootstrapVolume(bootstrapConfigMapName),
              this._stateVolume(stateClaimName),
            ],
          },
        },
      },
    };

    await this._createOrReplaceDeployment(deployName, deployment, namespace);

    const service = this._buildService(deployName, {
      runtimeFamily: "hermes",
      agentId: id,
      namespace,
    });
    const serviceResp = await this._createOrReadService(deployName, service, namespace);
    return this._buildEndpointResult({
      deployName,
      serviceResp,
      service,
      runtimeFamily: "hermes",
      gatewayToken: apiServerKey,
      namespace,
      policyStatus,
    });
  }

  async create(config) {
    const { id, name, image, vcpu, ram_mb, disk_gb, env, templatePayload, sandboxProfile } = config;
    const runtimeFamily = String(config.runtimeFamily || "openclaw")
      .trim()
      .toLowerCase();
    const deployName = safeK8sName(
      config.container_name || defaultDeployNameForRuntime(runtimeFamily, id, name),
      defaultDeployNameForRuntime(runtimeFamily, id, name),
    );
    if (runtimeFamily === "hermes") {
      return this._createHermes(config, deployName);
    }
    const namespace = this._namespaceForRuntimeFamily("openclaw");
    const isNemoClaw = sandboxProfile === "nemoclaw";
    const credentialManagedEnvNames = Array.isArray(config.credentialManagedEnvNames)
      ? config.credentialManagedEnvNames
      : [];
    const sandboxLabelMap = this._sandboxProfileLabelMap(isNemoClaw);
    const nemoModel = env?.NEMOCLAW_MODEL || getNemoClawDefaultModel(process.env);

    await this._ensureNamespace(namespace);
    const policyStatus = await this._reconcileNetworkPolicies({
      runtimeFamily: "openclaw",
      sandboxProfile: this._sandboxProfileLabelValue(isNemoClaw),
      namespace,
    });

    console.log(`[k8s] Creating deployment ${deployName}`);

    // Generate per-agent Gateway auth token
    const gatewayToken = config.gatewayToken || crypto.randomBytes(16).toString("hex");

    const openClawEnvMap = {
      ...(env || {}),
      ...buildRuntimeEnv(),
      ...(isNemoClaw
        ? {
            HOME: "/sandbox",
            OPENCLAW_CLI_PATH: "/usr/bin/openclaw",
            OPENCLAW_TSX_BIN: "/usr/bin/tsx",
            NEMOCLAW_MODEL: nemoModel,
          }
        : {}),
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      [OPENCLAW_MANAGED_MCP_SERVERS_ENV]:
        env?.[OPENCLAW_MANAGED_MCP_SERVERS_ENV] || encodeOpenClawManagedMcpServers({}),
      [K8S_MANAGED_ENV_STATE_ENV]: encodeKubernetesManagedEnvState(credentialManagedEnvNames, {}),
    };
    const openClawSecretName = this._envSecretName(deployName);
    const { env: baseEnvVars, stringData: openClawSecretData } = buildEnvEntries(
      openClawEnvMap,
      openClawSecretName,
      { forceSecretNames: [...credentialManagedEnvNames, K8S_MANAGED_ENV_STATE_ENV] },
    );
    const envVars = baseEnvVars;
    if (Object.keys(openClawSecretData).length > 0) {
      await this._upsertEnvSecret(
        deployName,
        openClawSecretData,
        {
          "nora.agent.id": String(id),
          "nora.deployment.name": deployName,
          "nora.runtime.family": "openclaw",
          "nora.sandbox.profile": isNemoClaw ? "nemoclaw" : "standard",
        },
        namespace,
      );
    }

    // CMD: install openclaw, configure gateway with pre-paired device, start the
    // runtime sidecar, then launch the gateway.
    const runtimeBootstrapCmd = buildRuntimeBootstrapCommand();
    const templateBootstrapCmd = buildTemplatePayloadBootstrapCommand(templatePayload);
    // Same package spec as the docker backend (OPENCLAW_DOCKER_PACKAGE /
    // NEMOCLAW_PACKAGE env) — one fleet-wide pin knob. An unpinned @latest
    // here is a fleet-breakage lever: every fresh pod and every crash-restart
    // npm-installs it at boot.
    const openclawPackageSpec = getStandardDockerPackageSpec();
    const nemoclawPackageSpec = process.env.NEMOCLAW_PACKAGE || "nemoclaw@latest";
    const ensureOpenClawCmd = buildOpenClawInstallCommand(
      isNemoClaw ? [openclawPackageSpec, nemoclawPackageSpec] : [openclawPackageSpec],
    );
    const nemoPolicyCmd = isNemoClaw
      ? `mkdir -p /opt/openclaw && echo '${JSON.stringify({
          version: "1",
          network: {
            default: "deny",
            rules: [
              {
                name: "nvidia",
                endpoints: ["integrate.api.nvidia.com:443", "inference-api.nvidia.com:443"],
                methods: ["*"],
              },
              {
                name: "github",
                endpoints: ["github.com:443", "api.github.com:443"],
                methods: ["*"],
              },
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
            model: nemoModel,
          },
        }).replace(/'/g, "'\\''")}' > /opt/openclaw/policy.yaml && `
      : "";
    // openclaw.json is seeded only when absent: the pod's state volume outlives
    // pod replacement, and an unconditional write would wipe channel config,
    // provider registrations, and default-model changes accumulated since
    // provisioning. The auth bootstrap below MERGES into the existing file.
    const gatewayScript =
      "set -eu\n" +
      buildKubernetesManagedEnvApplyCommand() +
      "\n" +
      buildOpenClawManagedConfigEnvPruneCommand(
        [K8S_MANAGED_ENV_STATE_ENV, "OPENCLAW_GATEWAY_TOKEN"],
        {
          managedStateEnvName: K8S_MANAGED_ENV_STATE_ENV,
          defaultHome: isNemoClaw ? "/sandbox" : "/root",
        },
      ) +
      "\n" +
      ensureOpenClawCmd +
      "mkdir -p ~/.openclaw/devices && " +
      `[ -f ~/.openclaw/openclaw.json ] || echo '{"gateway":{"port":${OPENCLAW_GATEWAY_PORT},"bind":"lan","mode":"local"}}' > ~/.openclaw/openclaw.json && ` +
      buildOpenClawGatewayPairingCommand({ defaultHome: isNemoClaw ? "/sandbox" : "/root" }) +
      "\n" +
      nemoPolicyCmd +
      buildOpenClawRuntimeAuthBootstrapCommand() +
      templateBootstrapCmd +
      runtimeBootstrapCmd +
      '"$OPENCLAW_BIN" gateway --port ' +
      OPENCLAW_GATEWAY_PORT;
    const gatewayBootstrap = buildContainerBootstrap(gatewayScript);
    const bootstrapConfigMapName = await this._upsertBootstrapConfigMap(
      deployName,
      gatewayBootstrap.script,
      {
        "nora.agent.id": String(id),
        "nora.deployment.name": deployName,
        "nora.runtime.family": "openclaw",
        "nora.execution.target": this.executionTargetLabelValue,
        "nora.kubernetes.cluster": this.clusterId,
        "nora.sandbox.profile": isNemoClaw ? "nemoclaw" : "standard",
        "openclaw.agent.id": String(id),
        ...sandboxLabelMap,
      },
      namespace,
    );
    const gatewayLaunch = this._bootstrapLaunch(gatewayBootstrap);

    // NemoClaw runs with HOME=/sandbox, so its OpenClaw state root lives there.
    const stateMountPath = isNemoClaw ? "/sandbox" : "/root/.openclaw";
    const stateClaimName = await this._upsertStateVolumeClaim(deployName, {
      sizeGi: disk_gb,
      labels: {
        "nora.agent.id": String(id),
        "nora.deployment.name": deployName,
        "nora.runtime.family": "openclaw",
        "nora.sandbox.profile": isNemoClaw ? "nemoclaw" : "standard",
      },
      namespace,
    });

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deployName,
        namespace,
        annotations: {
          [MANAGED_ENV_NAMES_ANNOTATION]: managedEnvNamesAnnotation([...credentialManagedEnvNames]),
        },
        labels: {
          app: "openclaw-agent",
          "nora.agent.id": String(id),
          "nora.deployment.name": deployName,
          "nora.runtime.family": "openclaw",
          "nora.execution.target": this.executionTargetLabelValue,
          "nora.kubernetes.cluster": this.clusterId,
          "nora.sandbox.profile": isNemoClaw ? "nemoclaw" : "standard",
          "openclaw.agent.id": String(id),
          ...sandboxLabelMap,
        },
      },
      spec: {
        replicas: 1,
        // See the Hermes deployment above: Recreate is required for the RWO
        // state volume and prevents stuck RollingUpdate surge pods on full
        // clusters.
        strategy: { type: "Recreate" },
        selector: {
          matchLabels: { "openclaw.agent.id": String(id) },
        },
        template: {
          metadata: {
            labels: {
              app: "openclaw-agent",
              "nora.agent.id": String(id),
              "nora.deployment.name": deployName,
              "nora.runtime.family": "openclaw",
              "nora.execution.target": this.executionTargetLabelValue,
              "nora.kubernetes.cluster": this.clusterId,
              "nora.sandbox.profile": isNemoClaw ? "nemoclaw" : "standard",
              "openclaw.agent.id": String(id),
              ...sandboxLabelMap,
            },
          },
          spec: {
            // DNS-safe hostname from agent name (avoids Bonjour conflicts)
            hostname:
              (name || `agent-${id}`)
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 63) || `agent-${id}`,
            securityContext: podSecurityContext(),
            containers: [
              {
                name: "agent",
                image: image || "node:24-slim",
                command: gatewayLaunch.command,
                args: gatewayLaunch.args,
                workingDir: isNemoClaw ? "/sandbox" : undefined,
                env: envVars,
                securityContext: containerSecurityContext(),
                volumeMounts: [
                  this._bootstrapVolumeMount(),
                  this._stateVolumeMount(stateMountPath),
                ],
                ports: [
                  { name: "gateway", containerPort: OPENCLAW_GATEWAY_PORT },
                  { name: "runtime", containerPort: AGENT_RUNTIME_PORT },
                ],
                // Without probes the pod is Ready the instant /bin/sh starts —
                // long before the gateway listens — so status() reports running
                // prematurely and a hung gateway is never restarted. Cold boot
                // npm-installs the runtime (minutes on a fresh node); the
                // startup probe gives it a 10-minute budget before liveness
                // takes over.
                startupProbe: {
                  tcpSocket: { port: OPENCLAW_GATEWAY_PORT },
                  periodSeconds: 10,
                  failureThreshold: 60,
                },
                readinessProbe: {
                  tcpSocket: { port: OPENCLAW_GATEWAY_PORT },
                  periodSeconds: 10,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  tcpSocket: { port: OPENCLAW_GATEWAY_PORT },
                  periodSeconds: 30,
                  failureThreshold: 4,
                },
                resources: {
                  requests: {
                    cpu: `${(vcpu || 2) * 1000}m`,
                    memory: `${ram_mb || 2048}Mi`,
                  },
                  limits: {
                    cpu: `${(vcpu || 2) * 1000}m`,
                    memory: `${ram_mb || 2048}Mi`,
                  },
                },
              },
            ],
            volumes: [
              this._bootstrapVolume(bootstrapConfigMapName),
              this._stateVolume(stateClaimName),
            ],
          },
        },
      },
    };

    await this._createOrReplaceDeployment(deployName, deployment, namespace);

    // Create a service that exposes both the control-plane gateway and runtime
    // sidecar. ClusterIP is the in-cluster default, NodePort supports kind/local
    // verification, and LoadBalancer covers cloud-managed clusters.
    const service = this._buildService(deployName, {
      runtimeFamily: "openclaw",
      agentId: id,
      namespace,
    });
    const serviceResp = await this._createOrReadService(deployName, service, namespace);
    return this._buildEndpointResult({
      deployName,
      serviceResp,
      service,
      runtimeFamily: "openclaw",
      gatewayToken,
      namespace,
      policyStatus,
    });
  }

  async destroy(containerId, options = {}) {
    const deployName = containerId;
    if (!deployName) return;

    const namespaces = this._candidateNamespacesForDestroy(deployName, options);
    console.log(`[k8s] Destroying deployment ${deployName} in ${namespaces.join(", ")}`);

    let deletedAny = false;
    for (const namespace of namespaces) {
      const deletedDeployment = await this._deleteDeploymentIfExists(deployName, namespace);
      const deletedService = await this._deleteServiceIfExists(deployName, namespace);
      const deletedConfigMap = await this._deleteBootstrapConfigMapIfExists(deployName, namespace);
      const deletedSecret = await this._deleteEnvSecretIfExists(deployName, namespace);
      // Deployment deletion above is Foreground, so no pod holds the claim by
      // the time this runs.
      const deletedStateClaim = await this._deleteStateVolumeClaimIfExists(deployName, namespace);
      deletedAny =
        deletedAny ||
        deletedDeployment ||
        deletedService ||
        deletedConfigMap ||
        deletedSecret ||
        deletedStateClaim;
    }

    console.log(
      deletedAny
        ? `[k8s] Deployment ${deployName} deleted`
        : `[k8s] Deployment ${deployName} was already absent`,
    );
  }

  async status(containerId, options = {}) {
    const deployName = containerId;
    try {
      const { deployment } = await this._readDeploymentInCandidateNamespace(deployName, options);
      const replicas = this._deploymentReplicaSnapshot(deployment);
      const running = replicas.specReplicas > 0 && replicas.availableReplicas > 0;
      return { running, uptime: null, cpu: null, memory: null, replicas };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null, replicas: null };
    }
  }

  async stats(containerId, options = {}) {
    const deployName = containerId;
    let namespace = this._namespaceForDeployName(deployName);
    let deployment = null;
    let replicas = null;
    let running = false;
    let uptimeSeconds = 0;

    try {
      const deploymentRead = await this._readDeploymentInCandidateNamespace(deployName, options);
      deployment = deploymentRead.deployment;
      namespace = deploymentRead.namespace;
      replicas = this._deploymentReplicaSnapshot(deployment);
      running = replicas.specReplicas > 0 && replicas.availableReplicas > 0;
    } catch {
      // Keep the same best-effort behavior as status(); callers still get a stable payload.
    }

    let runningPod = null;
    try {
      runningPod = await this._findRunningPod(deployName, namespace);
      if (runningPod) {
        running = replicas ? replicas.specReplicas > 0 : true;
        uptimeSeconds = podUptimeSeconds(runningPod);
      }
    } catch {
      // Fall through to unavailable telemetry below.
    }

    if (!running || !runningPod) {
      const telemetry = buildUnavailableTelemetry({
        backendType: "k8s",
        running,
        uptime_seconds: uptimeSeconds,
        capabilities: K8S_UNAVAILABLE_CAPABILITIES,
      });
      telemetry.replicas = replicas;
      return telemetry;
    }

    try {
      const podMetrics = await this._readPodMetrics(runningPod.metadata.name, namespace);
      const current = this._buildK8sCurrentSample({
        deployment,
        podMetrics,
        running,
        uptimeSeconds,
      });

      const telemetry = buildTelemetry({
        backendType: "k8s",
        capabilities: {
          ...K8S_METRICS_CAPABILITIES,
          cpu: current.cpu_percent != null,
          memory: current.memory_usage_mb != null || current.memory_limit_mb != null,
        },
        current,
      });
      telemetry.replicas = replicas;
      return telemetry;
    } catch {
      const telemetry = buildUnavailableTelemetry({
        backendType: "k8s",
        running,
        uptime_seconds: uptimeSeconds,
        capabilities: K8S_UNAVAILABLE_CAPABILITIES,
      });
      telemetry.replicas = replicas;
      return telemetry;
    }
  }

  async _readPodMetrics(podName, namespace = this.namespace) {
    if (!this.metricsApi || typeof this.metricsApi.getNamespacedCustomObject !== "function") {
      throw new Error("Kubernetes metrics API is not available");
    }

    const res = await this.metricsApi.getNamespacedCustomObject({
      group: "metrics.k8s.io",
      version: "v1beta1",
      namespace,
      plural: "pods",
      name: podName,
    });
    return res?.body || res;
  }

  _buildK8sCurrentSample({ deployment, podMetrics, running, uptimeSeconds }) {
    const metricContainers = Array.isArray(podMetrics?.containers) ? podMetrics.containers : [];
    const metricContainerNames = new Set(
      metricContainers.map((container) => container?.name).filter(Boolean),
    );
    const usage = metricContainers.reduce(
      (acc, container) => {
        const cpu = parseK8sCpuCores(container?.usage?.cpu);
        const memory = parseK8sMemoryBytes(container?.usage?.memory);
        if (cpu != null) acc.cpuCores += cpu;
        if (memory != null) acc.memoryBytes += memory;
        return acc;
      },
      { cpuCores: 0, memoryBytes: 0 },
    );
    const hasCpuUsage = metricContainers.some(
      (container) => parseK8sCpuCores(container?.usage?.cpu) != null,
    );
    const hasMemoryUsage = metricContainers.some(
      (container) => parseK8sMemoryBytes(container?.usage?.memory) != null,
    );
    const limits = this._podResourceLimits(deployment, metricContainerNames);
    const cpuPercent =
      hasCpuUsage && limits.cpuCores > 0
        ? roundMetric((usage.cpuCores / limits.cpuCores) * 100)
        : null;
    const memoryUsageMb = hasMemoryUsage ? bytesToMegabytes(usage.memoryBytes, 0) : null;
    const memoryLimitMb = limits.memoryBytes > 0 ? bytesToMegabytes(limits.memoryBytes, 0) : null;
    const memoryPercent =
      hasMemoryUsage && limits.memoryBytes > 0
        ? roundMetric((usage.memoryBytes / limits.memoryBytes) * 100)
        : null;

    return {
      recorded_at: podMetrics?.timestamp || new Date().toISOString(),
      running,
      uptime_seconds: uptimeSeconds,
      cpu_percent: cpuPercent,
      memory_usage_mb: memoryUsageMb,
      memory_limit_mb: memoryLimitMb,
      memory_percent: memoryPercent,
    };
  }

  _podResourceLimits(deployment, metricContainerNames = new Set()) {
    const containers = deployment?.spec?.template?.spec?.containers || [];
    const relevantContainers =
      metricContainerNames.size > 0
        ? containers.filter((container) => metricContainerNames.has(container?.name))
        : containers;

    return relevantContainers.reduce(
      (acc, container) => {
        const limits = container?.resources?.limits || {};
        const requests = container?.resources?.requests || {};
        const cpu = parseK8sCpuCores(limits.cpu ?? requests.cpu);
        const memory = parseK8sMemoryBytes(limits.memory ?? requests.memory);
        if (cpu != null) acc.cpuCores += cpu;
        if (memory != null) acc.memoryBytes += memory;
        return acc;
      },
      { cpuCores: 0, memoryBytes: 0 },
    );
  }

  async _patchDeploymentReplicas(deployName, replicas, namespace) {
    await this.appsApi.patchNamespacedDeployment({
      name: deployName,
      namespace,
      body: [{ op: "replace", path: "/spec/replicas", value: replicas }],
    });
  }

  _deploymentReplicaSnapshot(deployment) {
    const body = deployment?.body || deployment || {};
    const specReplicas = Number(body?.spec?.replicas ?? 1);
    const status = body?.status || {};
    return {
      specReplicas,
      replicas: Number(status.replicas || 0),
      availableReplicas: Number(status.availableReplicas || 0),
      readyReplicas: Number(status.readyReplicas || 0),
      updatedReplicas: Number(status.updatedReplicas || 0),
    };
  }

  async _readDeploymentInCandidateNamespace(deployName, options = {}) {
    const namespaces = this._candidateNamespacesForRuntimeOperation(deployName, options);
    let lastNotFound = null;

    for (const namespace of namespaces) {
      try {
        const res = await this.appsApi.readNamespacedDeployment({
          name: deployName,
          namespace,
        });
        return { deployment: res?.body || res || {}, namespace };
      } catch (error) {
        if (this._isNotFoundError(error) && namespace !== namespaces[namespaces.length - 1]) {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }

    if (lastNotFound) throw lastNotFound;
    throw new Error(`Unable to read Kubernetes deployment ${deployName}`);
  }

  async _waitForDeploymentStopped(deployName, namespace, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      const deployment = await this.appsApi.readNamespacedDeployment({
        name: deployName,
        namespace,
      });
      const snapshot = this._deploymentReplicaSnapshot(deployment);
      lastSnapshot = snapshot;

      if (
        snapshot.specReplicas === 0 &&
        snapshot.replicas === 0 &&
        snapshot.availableReplicas === 0 &&
        snapshot.readyReplicas === 0
      ) {
        return snapshot;
      }

      await sleep(1000);
    }

    throw new Error(
      `Timed out waiting for K8s Deployment ${deployName} in ${namespace} to stop` +
        (lastSnapshot
          ? ` (spec=${lastSnapshot.specReplicas}, replicas=${lastSnapshot.replicas}, ready=${lastSnapshot.readyReplicas}, available=${lastSnapshot.availableReplicas})`
          : ""),
    );
  }

  async _patchDeploymentInCandidateNamespace(deployName, options, description, patchFn) {
    const namespaces = this._candidateNamespacesForRuntimeOperation(deployName, options);
    let lastNotFound = null;

    for (const namespace of namespaces) {
      try {
        await patchFn(namespace);
        return namespace;
      } catch (error) {
        if (this._isNotFoundError(error) && namespace !== namespaces[namespaces.length - 1]) {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }

    if (lastNotFound) throw lastNotFound;
    throw new Error(`Unable to ${description} Kubernetes deployment ${deployName}`);
  }

  async stop(containerId, options = {}) {
    const deployName = containerId;
    console.log(`[k8s] Stopping deployment ${deployName} (scaling to 0)`);
    // v1.x's auto-selected Content-Type for patch is application/json-patch+json,
    // so the body MUST be a JSON Patch ops array (RFC 6902), not a merge object.
    const namespace = await this._patchDeploymentInCandidateNamespace(
      deployName,
      options,
      "stop",
      (candidateNamespace) => this._patchDeploymentReplicas(deployName, 0, candidateNamespace),
    );
    await this._waitForDeploymentStopped(deployName, namespace);
    console.log(`[k8s] Deployment ${deployName} scaled to 0 in ${namespace}`);
  }

  async start(containerId, options = {}) {
    const deployName = containerId;
    console.log(`[k8s] Starting deployment ${deployName} (scaling to 1)`);
    const namespace = await this._patchDeploymentInCandidateNamespace(
      deployName,
      options,
      "start",
      (candidateNamespace) => this._patchDeploymentReplicas(deployName, 1, candidateNamespace),
    );
    console.log(`[k8s] Deployment ${deployName} scaled to 1 in ${namespace}`);
  }

  async restart(containerId, options = {}) {
    const deployName = containerId;
    console.log(`[k8s] Restarting deployment ${deployName}`);
    const namespace = await this._patchDeploymentInCandidateNamespace(
      deployName,
      options,
      "restart",
      (candidateNamespace) =>
        this.appsApi.patchNamespacedDeployment({
          name: deployName,
          namespace: candidateNamespace,
          body: [
            {
              op: "add",
              path: "/spec/template/metadata/annotations",
              value: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() },
            },
          ],
        }),
    );
    console.log(`[k8s] Deployment ${deployName} rollout restart triggered in ${namespace}`);
  }

  async updateEnv(containerId, envVars = {}, options = {}) {
    const deployName = containerId;
    const entries = Object.entries(envVars || {}).filter(([key]) => key);
    const managedEnvNames = new Set(
      (Array.isArray(options?.managedEnvNames) ? options.managedEnvNames : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    );
    if (entries.length === 0 && managedEnvNames.size === 0) return;

    const { deployment, namespace } = await this._readDeploymentInCandidateNamespace(
      deployName,
      options,
    );
    const previousManagedEnvNames = new Set(
      parseManagedEnvNamesAnnotation(
        deployment?.metadata?.annotations?.[MANAGED_ENV_NAMES_ANNOTATION],
      ),
    );
    const containers = deployment?.spec?.template?.spec?.containers || [];
    const containerIndex = containers.findIndex((container) => container?.name === "agent");
    const index = containerIndex >= 0 ? containerIndex : 0;
    const env = Array.isArray(containers[index]?.env) ? containers[index].env : [];
    if (options?.replaceManagedState === true && previousManagedEnvNames.size === 0) {
      // Upgrade path for Deployments created before the managed-name annotation
      // existed. Nora owns provider/integration credential env on these pods;
      // retain only runtime identity tokens that are managed by their own
      // lifecycle, not by provider reconciliation.
      for (const entry of env) {
        const name = String(entry?.name || "");
        if (isSensitiveEnvName(name) && !RUNTIME_IDENTITY_SECRET_ENV_NAMES.has(name)) {
          previousManagedEnvNames.add(name);
        }
      }
    }
    if (options?.replaceManagedState === true) {
      const nextManagedEnvNames = new Set([...previousManagedEnvNames, ...managedEnvNames]);
      const managedValues = Object.fromEntries(
        entries
          .map(([name, value]) => [String(name), String(value ?? "")])
          .filter(([name]) => nextManagedEnvNames.has(name)),
      );
      const secretName = this._envSecretName(deployName);
      await this._replaceManagedEnvSecretData(
        deployName,
        {
          [K8S_MANAGED_ENV_STATE_ENV]: encodeKubernetesManagedEnvState(
            [...nextManagedEnvNames],
            managedValues,
          ),
        },
        [...nextManagedEnvNames, K8S_MANAGED_ENV_STATE_ENV],
        namespace,
      );

      let nextEnv = env.filter((entry) => !nextManagedEnvNames.has(String(entry?.name || "")));
      nextEnv = ensureManagedSecretEnvEntries(nextEnv, [K8S_MANAGED_ENV_STATE_ENV], secretName);
      const nextAnnotations = {
        ...(deployment?.metadata?.annotations || {}),
        [MANAGED_ENV_NAMES_ANNOTATION]: managedEnvNamesAnnotation([...nextManagedEnvNames]),
      };
      const patch = [];
      if (JSON.stringify(nextEnv) !== JSON.stringify(env)) {
        patch.push({
          op: Array.isArray(containers[index]?.env) ? "replace" : "add",
          path: `/spec/template/spec/containers/${index}/env`,
          value: nextEnv,
        });
      }
      if (
        JSON.stringify(nextAnnotations) !== JSON.stringify(deployment?.metadata?.annotations || {})
      ) {
        patch.push({
          op: deployment?.metadata?.annotations ? "replace" : "add",
          path: "/metadata/annotations",
          value: nextAnnotations,
        });
      }
      if (patch.length > 0) {
        await this.appsApi.patchNamespacedDeployment({
          name: deployName,
          namespace,
          body: patch,
        });
      }
      console.log(`[k8s] Staged ${entries.length} managed env var(s) on deployment ${deployName}`);
      return;
    }
    const envPath = `/spec/template/spec/containers/${index}/env`;
    const patch = [];
    const replaceManagedState = false;

    if (options?.runtimeFamily === "hermes") {
      const lifecycle = {
        postStart: {
          exec: {
            command: ["/bin/sh", "-lc", buildHermesPostStartCommand()],
          },
        },
      };
      if (JSON.stringify(containers[index]?.lifecycle || null) !== JSON.stringify(lifecycle)) {
        patch.push({
          op: containers[index]?.lifecycle ? "replace" : "add",
          path: `/spec/template/spec/containers/${index}/lifecycle`,
          value: lifecycle,
        });
      }
    }

    // Sensitive values go into the env Secret and are referenced via
    // secretKeyRef — replacing an existing secretKeyRef entry with a literal
    // value would put the decrypted key into the pod spec (readable by
    // anyone with `get deployment`) and let the Secret drift.
    const secretName = this._envSecretName(deployName);
    const sensitiveData = {};
    const nextEntries = [];
    for (const [name, value] of entries) {
      const key = String(name);
      const stringValue = String(value ?? "");
      let nextEntry;
      if (replaceManagedState || managedEnvNames.has(key) || isSensitiveEnvName(key)) {
        sensitiveData[key] = stringValue;
        nextEntry = {
          name: key,
          valueFrom: { secretKeyRef: { name: secretName, key, optional: true } },
        };
      } else {
        nextEntry = { name: key, value: stringValue };
      }
      nextEntries.push(nextEntry);
    }

    const replacedNames = new Set([
      ...(replaceManagedState ? previousManagedEnvNames : []),
      ...managedEnvNames,
      ...entries.map(([name]) => String(name)),
    ]);
    let nextEnv = [
      ...env.filter((entry) => !replacedNames.has(String(entry?.name || ""))),
      ...nextEntries,
    ];
    if (replaceManagedState) {
      nextEnv = ensureManagedSecretEnvEntries(
        nextEnv,
        [...new Set([...previousManagedEnvNames, ...managedEnvNames])],
        secretName,
      );
    }
    if (JSON.stringify(nextEnv) !== JSON.stringify(env)) {
      patch.push({
        op: Array.isArray(containers[index]?.env) ? "replace" : "add",
        path: envPath,
        value: nextEnv,
      });
    }
    const nextManagedEnvNames = new Set([...previousManagedEnvNames, ...managedEnvNames]);
    const annotations = {
      ...(deployment?.metadata?.annotations || {}),
      [MANAGED_ENV_NAMES_ANNOTATION]: managedEnvNamesAnnotation([...nextManagedEnvNames]),
    };
    if (JSON.stringify(annotations) !== JSON.stringify(deployment?.metadata?.annotations || {})) {
      patch.push({
        op: deployment?.metadata?.annotations ? "replace" : "add",
        path: "/metadata/annotations",
        value: annotations,
      });
    }

    // Update the Secret before the Deployment so secretKeyRef entries resolve
    // as soon as the rollout (or the caller's explicit restart) starts pods.
    const managedSecretNames = replaceManagedState
      ? [...new Set([...previousManagedEnvNames, ...managedEnvNames])]
      : [...replacedNames].filter(isSensitiveEnvName);
    if (managedSecretNames.length > 0) {
      await this._replaceManagedEnvSecretData(
        deployName,
        sensitiveData,
        managedSecretNames,
        namespace,
      );
    } else if (Object.keys(sensitiveData).length > 0) {
      await this._mergeEnvSecretData(deployName, sensitiveData, namespace);
    }

    if (patch.length > 0) {
      await this.appsApi.patchNamespacedDeployment({
        name: deployName,
        namespace,
        body: patch,
      });
    }
    console.log(`[k8s] Updated ${entries.length} env var(s) on deployment ${deployName}`);
  }

  /**
   * Execute a command inside a pod of the deployment (for terminal).
   * Returns { exec, stream } compatible with the Docker backend.
   */
  async exec(containerId, opts = {}) {
    const deployName = containerId;
    const namespace = this._namespaceForDeployName(deployName);
    const execClient = new k8s.Exec(this.kc);

    // Find a running pod for this deployment
    const runningPod = await this._findRunningPod(deployName, namespace);
    if (!runningPod) return null;

    const { PassThrough } = require("stream");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = opts.cmd ? null : new PassThrough();
    const stream = stdout;
    stderr.on("data", (chunk) => stdout.write(chunk));

    let exitCode = 0;
    let statusSeen = false;
    let resolveStatus;
    const statusPromise = new Promise((resolve) => {
      resolveStatus = resolve;
    });
    const statusCallback = (status) => {
      statusSeen = true;
      exitCode = this._execExitCode(status);
      resolveStatus(status);
      stdout.end();
    };

    const ws = await execClient.exec(
      namespace,
      runningPod.metadata.name,
      "agent",
      opts.cmd || ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
      stdout,
      stderr,
      stdin,
      opts.tty !== false,
      statusCallback,
    );

    const originalDestroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => {
      try {
        ws.close();
      } catch {
        // Ignore already-closed sockets.
      }
      return originalDestroy(...args);
    };

    return {
      podName: runningPod.metadata.name,
      namespace,
      exec: {
        inspect: async () => {
          if (!statusSeen) {
            await Promise.race([
              statusPromise,
              new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
          }
          return { ExitCode: exitCode };
        },
        resize: async () => {},
      },
      stream,
      stdin,
    };
  }

  _execExitCode(status = {}) {
    if (status?.status === "Success") return 0;
    const causes = status?.details?.causes || [];
    const exitCodeCause = causes.find((cause) => cause?.reason === "ExitCode");
    const parsed = Number.parseInt(exitCodeCause?.message, 10);
    return Number.isFinite(parsed) ? parsed : 1;
  }

  async _findRunningPod(deployName, namespace = this._namespaceForDeployName(deployName)) {
    const agentId = this._agentIdFromDeployName(deployName);
    const selectors = [
      `nora.deployment.name=${deployName}`,
      `nora.agent.id=${agentId}`,
      `openclaw.agent.id=${agentId}`,
    ];
    for (const labelSelector of selectors) {
      const pods = await this.coreApi.listNamespacedPod({
        namespace,
        labelSelector,
      });
      const podItems = pods?.items || pods?.body?.items || [];
      const runningPod = podItems.find((p) => p.status?.phase === "Running");
      if (runningPod) return runningPod;
    }
    return null;
  }

  /**
   * Stream logs from a pod of the deployment.
   */
  async logs(containerId, opts = {}) {
    const deployName = containerId;
    const namespace = this._namespaceForDeployName(deployName);
    const log = new k8s.Log(this.kc);

    const runningPod = await this._findRunningPod(deployName, namespace);
    if (!runningPod) return null;

    const stream = new (require("stream").PassThrough)();
    await log.log(namespace, runningPod.metadata.name, "agent", stream, {
      follow: opts.follow !== false,
      tailLines: opts.tail || 100,
      timestamps: true,
    });
    return stream;
  }
}

module.exports = K8sBackend;
