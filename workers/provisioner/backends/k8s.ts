// @ts-nocheck
const k8s = require("@kubernetes/client-node");
const crypto = require("crypto");
const ProvisionerBackend = require("./interface");
const {
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawInstallCommand,
  buildRuntimeBootstrapCommand,
  buildTemplatePayloadBootstrapCommand,
  buildRuntimeEnv,
} = require("../../../agent-runtime/lib/runtimeBootstrap");
const {
  OPENCLAW_GATEWAY_PORT,
  AGENT_RUNTIME_PORT,
  HERMES_DASHBOARD_PORT,
} = require("../../../agent-runtime/lib/contracts");
const { getHermesDockerAgentImage } = require("../../../agent-runtime/lib/agentImages");
const { getNemoClawDefaultModel } = require("../../../agent-runtime/lib/nemoclawDefaults");
const { buildContainerBootstrap } = require("../../../agent-runtime/lib/containerCommand");
const {
  HERMES_MANAGED_ENV_ENV,
  HERMES_MODEL_CONFIG_ENV,
  buildHermesRuntimeConfigBootstrapCommand,
} = require("../../../agent-runtime/lib/hermesRuntimeBootstrap");
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
const BOOTSTRAP_CONFIGMAP_KEY = "bootstrap.sh";
const BOOTSTRAP_MOUNT_PATH = "/opt/nora-bootstrap";
const BOOTSTRAP_SCRIPT_PATH = `${BOOTSTRAP_MOUNT_PATH}/${BOOTSTRAP_CONFIGMAP_KEY}`;
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
]);

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

function safeK8sName(name, fallback) {
  return safeHostname(name, fallback).slice(0, 63) || fallback;
}

function isSensitiveEnvName(name) {
  return SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(String(name || "")));
}

function buildEnvEntries(envMap = {}, secretName = "") {
  const env = [];
  const stringData = {};
  for (const [key, value] of Object.entries(envMap || {})) {
    if (!key || value == null) continue;
    if (isSensitiveEnvName(key)) {
      stringData[key] = String(value);
      env.push({
        name: key,
        valueFrom: {
          secretKeyRef: {
            name: secretName,
            key,
          },
        },
      });
      continue;
    }
    env.push({ name: key, value: String(value) });
  }
  return { env, stringData };
}

function defaultDeployNameForRuntime(runtimeFamily, id, name) {
  const prefix = runtimeFamily === "hermes" ? "nora-hermes" : "nora-oclaw";
  return safeK8sName(`${prefix}-${name || "agent"}-${id}`, `${prefix}-${id}`);
}

function buildHermesStartCommand() {
  return [
    "set -eu",
    buildHermesRuntimeConfigBootstrapCommand(),
    `HERMES_BIN="${HERMES_BIN}"`,
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes)"',
    `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --insecure --no-open >> ${HERMES_DASHBOARD_LOG} 2>&1 &`,
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
      id: "gpt-5.5",
      name: "GPT-5.5 (Azure)",
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
    "if (foundryKey && foundryBaseUrlRaw) {",
    "  config.models = config.models && typeof config.models === 'object' ? config.models : {};",
    "  config.models.providers = config.models.providers && typeof config.models.providers === 'object' ? config.models.providers : {};",
    "  config.models.providers['azure-openai-responses'] = {",
    "    api: 'azure-openai-responses',",
    "    baseUrl: String(foundryBaseUrlRaw).replace(/\\/+$/, ''),",
    "    apiKey: foundryKey,",
    "    models: buildFoundryModelEntries(),",
    "  };",
    "}",
    "if (defaultModel) {",
    "  config.agents = config.agents && typeof config.agents === 'object' ? config.agents : {};",
    "  config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === 'object' ? config.agents.defaults : {};",
    "  config.agents.defaults.model = { primary: defaultModel };",
    "  config.agents.defaults.models = config.agents.defaults.models && typeof config.agents.defaults.models === 'object' ? config.agents.defaults.models : {};",
    "  config.agents.defaults.models[defaultModel] = config.agents.defaults.models[defaultModel] || {};",
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
    let service = this._serviceObject(initialService);

    while (Date.now() <= deadline) {
      const address = this._loadBalancerAddress(service);
      if (address) return address;

      await sleep(this.loadBalancerReadyIntervalMs);
      service = this._serviceObject(
        await this.coreApi.readNamespacedService({
          name: deployName,
          namespace,
        }),
      );
    }

    throw new Error(
      `Timed out waiting for K8s LoadBalancer address for ${deployName} after ` +
        `${this.loadBalancerReadyTimeoutMs}ms`,
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
    const { id, name, image, vcpu, ram_mb, env } = config;
    const namespace = this._namespaceForRuntimeFamily("hermes");
    const imgName = image || getHermesDockerAgentImage();
    const apiServerKey = config.gatewayToken || crypto.randomBytes(32).toString("hex");

    await this._ensureNamespace(namespace);
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
    const hermesSecretName = this._envSecretName(deployName);
    const { env: envVars, stringData: hermesSecretData } = buildEnvEntries(
      hermesEnvMap,
      hermesSecretName,
    );
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

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deployName,
        namespace,
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
            containers: [
              {
                name: "agent",
                image: imgName,
                args: hermesLaunchArgs,
                workingDir: HERMES_HOME,
                env: envVars,
                lifecycle: {
                  postStart: {
                    exec: {
                      command: ["/bin/sh", "-lc", buildHermesPostStartCommand()],
                    },
                  },
                },
                volumeMounts: [this._bootstrapVolumeMount()],
                ports: [
                  { name: "runtime", containerPort: HERMES_RUNTIME_PORT },
                  { name: "dashboard", containerPort: HERMES_DASHBOARD_PORT },
                ],
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
            volumes: [this._bootstrapVolume(bootstrapConfigMapName)],
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
    });
  }

  async create(config) {
    const { id, name, image, vcpu, ram_mb, env, templatePayload, sandboxProfile } = config;
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
    const nemoModel = env?.NEMOCLAW_MODEL || getNemoClawDefaultModel(process.env);

    await this._ensureNamespace(namespace);

    console.log(`[k8s] Creating deployment ${deployName}`);

    // Generate per-agent Gateway auth token
    const gatewayToken = config.gatewayToken || crypto.randomBytes(16).toString("hex");

    // Derive deterministic Ed25519 device identity from gatewayToken
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

    const openClawEnvMap = {
      ...(env || {}),
      ...buildRuntimeEnv(),
      ...(isNemoClaw
        ? {
            HOME: "/sandbox",
            OPENCLAW_CLI_PATH: "/usr/bin/openclaw",
            OPENCLAW_TSX_BIN: "/usr/bin/tsx",
            NEMOCLAW_MODEL: nemoModel,
            ...(process.env.NVIDIA_API_KEY && !env?.NVIDIA_API_KEY
              ? { NVIDIA_API_KEY: process.env.NVIDIA_API_KEY }
              : {}),
          }
        : {}),
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    };
    const openClawSecretName = this._envSecretName(deployName);
    const { env: envVars, stringData: openClawSecretData } = buildEnvEntries(
      openClawEnvMap,
      openClawSecretName,
    );
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
    const escapedPaired = pairedJson.replace(/'/g, "'\\''");
    const runtimeBootstrapCmd = buildRuntimeBootstrapCommand();
    const templateBootstrapCmd = buildTemplatePayloadBootstrapCommand(templatePayload);
    const ensureOpenClawCmd = buildOpenClawInstallCommand(
      isNemoClaw ? ["openclaw@latest", "nemoclaw@latest"] : ["openclaw@latest"],
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
    const gatewayScript =
      "set -eu\n" +
      ensureOpenClawCmd +
      "mkdir -p ~/.openclaw/devices && " +
      `echo '{"gateway":{"port":${OPENCLAW_GATEWAY_PORT},"bind":"lan","mode":"local"}}' > ~/.openclaw/openclaw.json && ` +
      `echo '${escapedPaired}' > ~/.openclaw/devices/paired.json && ` +
      `echo '{}' > ~/.openclaw/devices/pending.json && ` +
      nemoPolicyCmd +
      buildOpenClawRuntimeAuthBootstrapCommand() +
      templateBootstrapCmd +
      runtimeBootstrapCmd +
      '"$OPENCLAW_BIN" gateway --port ' +
      OPENCLAW_GATEWAY_PORT +
      ` --password ${gatewayToken}`;
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
      },
      namespace,
    );
    const gatewayLaunch = this._bootstrapLaunch(gatewayBootstrap);

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deployName,
        namespace,
        labels: {
          app: "openclaw-agent",
          "nora.agent.id": String(id),
          "nora.deployment.name": deployName,
          "nora.runtime.family": "openclaw",
          "nora.execution.target": this.executionTargetLabelValue,
          "nora.kubernetes.cluster": this.clusterId,
          "nora.sandbox.profile": isNemoClaw ? "nemoclaw" : "standard",
          "openclaw.agent.id": String(id),
        },
      },
      spec: {
        replicas: 1,
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
            containers: [
              {
                name: "agent",
                image: image || "node:24-slim",
                command: gatewayLaunch.command,
                args: gatewayLaunch.args,
                workingDir: isNemoClaw ? "/sandbox" : undefined,
                env: envVars,
                volumeMounts: [this._bootstrapVolumeMount()],
                ports: [
                  { name: "gateway", containerPort: OPENCLAW_GATEWAY_PORT },
                  { name: "runtime", containerPort: AGENT_RUNTIME_PORT },
                ],
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
            volumes: [this._bootstrapVolume(bootstrapConfigMapName)],
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
      deletedAny =
        deletedAny || deletedDeployment || deletedService || deletedConfigMap || deletedSecret;
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
    if (entries.length === 0) return;

    const { deployment, namespace } = await this._readDeploymentInCandidateNamespace(
      deployName,
      options,
    );
    const containers = deployment?.spec?.template?.spec?.containers || [];
    const containerIndex = containers.findIndex((container) => container?.name === "agent");
    const index = containerIndex >= 0 ? containerIndex : 0;
    const env = Array.isArray(containers[index]?.env) ? containers[index].env : [];
    const envIndexByName = new Map(env.map((entry, entryIndex) => [entry.name, entryIndex]));
    const envPath = `/spec/template/spec/containers/${index}/env`;
    const patch = [];

    if (options?.runtimeFamily === "hermes") {
      patch.push({
        op: containers[index]?.lifecycle ? "replace" : "add",
        path: `/spec/template/spec/containers/${index}/lifecycle`,
        value: {
          postStart: {
            exec: {
              command: ["/bin/sh", "-lc", buildHermesPostStartCommand()],
            },
          },
        },
      });
    }

    if (!Array.isArray(containers[index]?.env)) {
      patch.push({ op: "add", path: envPath, value: [] });
    }

    for (const [name, value] of entries) {
      const nextEntry = { name: String(name), value: String(value ?? "") };
      const existingIndex = envIndexByName.get(name);
      if (Number.isInteger(existingIndex)) {
        patch.push({ op: "replace", path: `${envPath}/${existingIndex}`, value: nextEntry });
      } else {
        patch.push({ op: "add", path: `${envPath}/-`, value: nextEntry });
      }
    }

    await this.appsApi.patchNamespacedDeployment({
      name: deployName,
      namespace,
      body: patch,
    });
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
