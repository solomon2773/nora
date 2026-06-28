// @ts-nocheck
const fs = require("fs");
const path = require("path");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const NORA_SYNC_INTEGRATIONS_DIR = "/root/.openclaw/workspace/integrations";
const NORA_SYNC_INTEGRATIONS_CATALOG_FILE = `${NORA_SYNC_INTEGRATIONS_DIR}/integrations.json`;
const NORA_SYNC_INTEGRATIONS_FILE = NORA_SYNC_INTEGRATIONS_CATALOG_FILE;
const NORA_SYNC_INTEGRATIONS_CONFIG_FILE = NORA_SYNC_INTEGRATIONS_CATALOG_FILE;
const NORA_SYNC_INTEGRATIONS_LEGACY_FILE = "/opt/openclaw/integrations.json";
const NORA_SYNC_INTEGRATIONS_LEGACY_CONFIG_FILE = "/opt/openclaw/integrations.config";
const NORA_SYNC_INTEGRATIONS_LEGACY_CONFIG_JSON_FILE = "/opt/openclaw/integrations.config.json";
const NORA_SYNC_INTEGRATIONS_FILES = Object.freeze([
  NORA_SYNC_INTEGRATIONS_DIR,
  NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
  NORA_SYNC_INTEGRATIONS_LEGACY_FILE,
  NORA_SYNC_INTEGRATIONS_LEGACY_CONFIG_JSON_FILE,
  NORA_SYNC_INTEGRATIONS_LEGACY_CONFIG_FILE,
]);
const NORA_INTEGRATIONS_SKILL_NAME = "nora-integrations";
const NORA_INTEGRATIONS_SKILL_FILE = `skills/${NORA_INTEGRATIONS_SKILL_NAME}/SKILL.md`;
const NORA_INTEGRATION_TOOL_COMMAND = "nora-integration-tool";
const INTEGRATION_MANIFEST_INSPECT_OPERATION = "manifest.inspect";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_GITHUB_FILE_CONTENT_CHARS = 120000;
const DEFAULT_TWITTER_API_BASE_URL = "https://api.x.com/2";
const DEFAULT_LINKEDIN_API_BASE_URL = "https://api.linkedin.com";
const NORA_AGENT_STATE_ROOT = "/mnt/nora-agent-state";
const OPENCLAW_AGENT_LOG_FILE = "/var/log/openclaw-agent.log";
const OPENCLAW_CONFIG_FILE = "/root/.openclaw/openclaw.json";
const OPENCLAW_CLI =
  typeof process.env.OPENCLAW_CLI_PATH === "string" && process.env.OPENCLAW_CLI_PATH.trim()
    ? process.env.OPENCLAW_CLI_PATH.trim()
    : "/usr/local/bin/openclaw";
const OPENCLAW_GATEWAY_PORT = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT || "19611", 10);
const OPENCLAW_GATEWAY_MIN_PROTOCOL_VERSION = 3;
const OPENCLAW_GATEWAY_MAX_PROTOCOL_VERSION = 4;
const OPENCLAW_SESSIONS_ROOT = "/root/.openclaw/agents/main/sessions";
const OPENCLAW_GATEWAY_TOKEN =
  typeof process.env.OPENCLAW_GATEWAY_TOKEN === "string"
    ? process.env.OPENCLAW_GATEWAY_TOKEN.trim()
    : "";
const SENSITIVE_CONFIG_KEY_RE =
  /(token|secret|password|api[_-]?key|private[_-]?key|service[_-]?account|credentials?)/i;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
let sanitizeHtmlLib = null;

function loadModuleFromKnownRoots(moduleName, extraPaths = []) {
  const searchPaths = [__dirname, process.cwd(), path.resolve(__dirname, ".."), ...extraPaths];
  return require(require.resolve(moduleName, { paths: searchPaths }));
}

function getSanitizeHtml() {
  if (!sanitizeHtmlLib) {
    sanitizeHtmlLib = loadModuleFromKnownRoots("sanitize-html", [
      path.resolve(__dirname, "../../backend-api"),
      path.resolve(__dirname, "../.."),
    ]);
  }
  return sanitizeHtmlLib;
}

const SUPPORTED_INTEGRATION_TOOL_OPERATIONS = Object.freeze({
  github: new Set(["repos.list", "repos.contents.get", "pulls.list", "issues.create"]),
  twitter: new Set(["users.me", "users.tweets.list", "tweets.create"]),
  linkedin: new Set(["userinfo", "ugcPosts.create"]),
  email: new Set([]),
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function deriveGatewayDeviceIdentity(gatewayToken = "") {
  const seed = crypto.createHash("sha256").update(`openclaw-device:${gatewayToken}`).digest();
  const privateDer = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = spki.subarray(ED25519_SPKI_PREFIX.length);
  return {
    deviceId: crypto.createHash("sha256").update(rawPublicKey).digest("hex"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyB64: base64UrlEncode(rawPublicKey),
  };
}

function signGatewayPayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function buildGatewayConnectDevice(identity, nonce) {
  const signedAtMs = Date.now();
  const role = "operator";
  const scopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
  ];
  const payload = [
    "v3",
    identity.deviceId,
    "gateway-client",
    "backend",
    role,
    scopes.join(","),
    String(signedAtMs),
    "",
    nonce,
    process.platform,
    "",
  ].join("|");
  return {
    role,
    scopes,
    device: {
      id: identity.deviceId,
      publicKey: identity.publicKeyB64,
      signature: signGatewayPayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce,
    },
  };
}

function sanitizeIntegrationFilePart(value, fallback = "integration") {
  const candidate = normalizeString(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return candidate || fallback;
}

function normalizeIntegrationToolInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return {};
}

function isSensitiveIntegrationConfigKey(key) {
  return SENSITIVE_CONFIG_KEY_RE.test(String(key || ""));
}

function integrationDetailsFileName(integration = {}, usedNames = new Set()) {
  const provider =
    integrationProviderId(integration) ||
    sanitizeIntegrationFilePart(integration.name || integration.id || "integration");
  const base = sanitizeIntegrationFilePart(provider);
  let fileName = `integrations.${base}.json`;
  let suffix = 2;

  while (usedNames.has(fileName)) {
    fileName = `integrations.${base}-${suffix}.json`;
    suffix += 1;
  }

  usedNames.add(fileName);
  return fileName;
}

function pickIntegrationTimestamp(integration = {}, keys = []) {
  for (const key of keys) {
    const value = integration[key];
    if (value) return value;
  }
  const config =
    integration.config && typeof integration.config === "object" ? integration.config : {};
  for (const key of keys) {
    const value = config[key];
    if (value) return value;
  }
  return null;
}

function buildIntegrationCatalogEntry(integration = {}, detailsFile) {
  const provider = integrationProviderId(integration) || "integration";
  const status = normalizeString(integration.status) || "active";
  const enabled = !["disabled", "disconnected", "revoked", "expired"].includes(
    status.toLowerCase(),
  );
  return {
    provider,
    name: normalizeString(integration.name) || provider,
    category: normalizeString(integration.category) || "unknown",
    status,
    enabled,
    activatedAt:
      pickIntegrationTimestamp(integration, [
        "activatedAt",
        "activated_at",
        "connectedAt",
        "connected_at",
        "createdAt",
        "created_at",
      ]) || null,
    expiresAt:
      pickIntegrationTimestamp(integration, [
        "expiresAt",
        "expires_at",
        "tokenExpiresAt",
        "token_expires_at",
      ]) || null,
    detailsFile,
  };
}

function buildSplitIntegrationManifest(integrations = []) {
  const syncedIntegrations = Array.isArray(integrations) ? integrations : [];
  const usedNames = new Set();
  const details = syncedIntegrations.map((integration) => {
    const fileName = integrationDetailsFileName(integration, usedNames);
    return {
      fileName,
      integration,
      catalogEntry: buildIntegrationCatalogEntry(integration, fileName),
    };
  });

  return {
    catalog: {
      version: 1,
      generatedAt: new Date().toISOString(),
      integrations: details.map((entry) => entry.catalogEntry),
    },
    details: details.map(({ fileName, integration }) => ({ fileName, integration })),
  };
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readIntegrationDetailsFromCatalog(raw, catalogPath) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.integrations)) return null;
  const baseDir = path.dirname(catalogPath);
  const loaded = [];
  let sawDetailsFile = false;

  for (const entry of raw.integrations) {
    if (!entry || typeof entry !== "object" || !entry.detailsFile) continue;
    sawDetailsFile = true;
    const detailPath = path.isAbsolute(entry.detailsFile)
      ? entry.detailsFile
      : path.join(baseDir, entry.detailsFile);
    const detail = readJsonFile(detailPath);
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      loaded.push(
        detail.integration && typeof detail.integration === "object" ? detail.integration : detail,
      );
    }
  }

  return sawDetailsFile ? loaded : raw.integrations;
}

function readSyncedIntegrationsDirectory(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return null;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return null;
  } catch {
    return null;
  }
  return readSyncedIntegrationsFile(path.join(dirPath, "integrations.json"));
}

function readSyncedIntegrationsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    if (fs.statSync(filePath).isDirectory()) {
      return readSyncedIntegrationsDirectory(filePath);
    }
  } catch {
    return null;
  }

  const raw = readJsonFile(filePath);
  if (Array.isArray(raw)) return raw;
  return readIntegrationDetailsFromCatalog(raw, filePath);
}

function integrationManifestCandidates(filePath) {
  if (Array.isArray(filePath)) {
    return filePath.map((candidate) => normalizeString(candidate)).filter(Boolean);
  }

  if (!filePath || filePath === NORA_SYNC_INTEGRATIONS_FILE) {
    return [
      normalizeString(process.env.NORA_INTEGRATIONS_DIR),
      normalizeString(process.env.NORA_INTEGRATIONS_CONFIG),
      ...NORA_SYNC_INTEGRATIONS_FILES,
    ].filter(Boolean);
  }

  return [filePath];
}

function loadSyncedIntegrations(filePath = NORA_SYNC_INTEGRATIONS_FILE) {
  for (const candidate of integrationManifestCandidates(filePath)) {
    const integrations = readSyncedIntegrationsFile(candidate);
    if (integrations) return integrations;
  }
  return [];
}

function buildExampleValueFromSchema(schema = {}) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  switch (schema.type) {
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return `<${normalizeString(schema.description) || "value"}>`;
  }
}

function buildInvocationExample(spec = {}) {
  const schema =
    spec.inputSchema && typeof spec.inputSchema === "object"
      ? spec.inputSchema
      : spec.parameters && typeof spec.parameters === "object"
        ? spec.parameters
        : {};
  const properties =
    schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  const input = {};

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (required.has(key)) {
      input[key] = buildExampleValueFromSchema(propertySchema);
    }
  }

  if (Object.keys(input).length > 0) {
    return input;
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    input[key] = buildExampleValueFromSchema(propertySchema);
    break;
  }

  return input;
}

function normalizeToolName(rawName, fallback) {
  const candidate = normalizeString(rawName || fallback || "tool")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return candidate || "tool";
}

function integrationProviderId(integration = {}) {
  return normalizeString(
    integration.provider || integration.catalog_id || integration.id,
  ).toLowerCase();
}

function buildIntegrationManifestToolSpec(integration = {}) {
  const provider = integrationProviderId(integration) || "integration";
  const providerName = normalizeString(integration.name) || provider;
  const toolName = normalizeToolName(`nora_${provider}_integration`, "nora_integration");

  return {
    name: toolName,
    description: `Inspect the connected ${providerName} integration manifest, credential env vars, synced defaults, API metadata, and available runtime tools.`,
    operation: INTEGRATION_MANIFEST_INSPECT_OPERATION,
    inputSchema: {
      type: "object",
      properties: {},
    },
    noraGenerated: true,
  };
}

function getIntegrationToolSpecs(integration = {}) {
  const declaredToolSpecs = Array.isArray(integration.toolSpecs)
    ? integration.toolSpecs.filter(Boolean)
    : [];
  const manifestTool = buildIntegrationManifestToolSpec(integration);
  const hasManifestTool = declaredToolSpecs.some(
    (spec) => normalizeString(spec?.name) === manifestTool.name,
  );
  return hasManifestTool ? declaredToolSpecs : [manifestTool, ...declaredToolSpecs];
}

function isIntegrationToolExecutable(integration = {}, spec = {}) {
  const provider = integrationProviderId(integration);
  const operation = normalizeString(spec.operation);
  if (operation === INTEGRATION_MANIFEST_INSPECT_OPERATION) return true;
  const supported = SUPPORTED_INTEGRATION_TOOL_OPERATIONS[provider];
  return Boolean(supported && operation && supported.has(operation));
}

function buildIntegrationToolExecutionMetadata(integration = {}, spec = {}) {
  const runtimeToolName = normalizeString(spec.name) || "tool";
  const executable = isIntegrationToolExecutable(integration, spec);
  const exampleInput = buildInvocationExample(spec);

  return {
    executable,
    executionState: executable ? "runtime_skill" : "manifest_only",
    executionSurface: executable ? "exec" : "manifest_only",
    executor: executable ? NORA_INTEGRATION_TOOL_COMMAND : null,
    runtimeToolName,
    exampleInput,
    invokeCommand: executable
      ? `${NORA_INTEGRATION_TOOL_COMMAND} ${runtimeToolName} '${JSON.stringify(exampleInput)}'`
      : null,
  };
}

function getExecutableIntegrationTools(integrations = []) {
  const executableTools = [];

  for (const integration of Array.isArray(integrations) ? integrations : []) {
    const toolSpecs = getIntegrationToolSpecs(integration);

    for (const spec of toolSpecs) {
      const execution = buildIntegrationToolExecutionMetadata(integration, spec);
      if (!execution.executable) continue;
      executableTools.push({ integration, spec, execution });
    }
  }

  return executableTools;
}

function buildIntegrationSkillMarkdown(integrations = [], options = {}) {
  const syncedIntegrations = Array.isArray(integrations) ? integrations : [];
  const executableTools = getExecutableIntegrationTools(integrations);
  const includeFrontmatter = options.frontmatter !== false;
  const lines = [];

  if (includeFrontmatter) {
    lines.push(
      "---",
      "name: nora-integrations",
      "description: Inspect and use Nora-connected integrations for this agent. Use when the operator asks about connected integrations, connected accounts, integration status, integration credentials, provider tools, Twitter/X, GitHub, or posting/reading through a connected provider.",
      "---",
      "",
    );
  }

  lines.push(
    "# Nora Integrations",
    "",
    "Use this skill when the operator asks you to work with a provider that Nora connected to this agent.",
    "The connected credentials belong only to this agent. Do not assume another agent has the same accounts or permissions.",
    "Never print, echo, commit, or otherwise reveal credential values. Use environment variables and synced config only to make provider API calls.",
    "",
    "## Workflow",
    "",
    "1. Check `integrations/NORA_INTEGRATIONS.md` to confirm the provider and tool are connected.",
    `2. On OpenClaw, read \`${NORA_SYNC_INTEGRATIONS_CATALOG_FILE}\` to see the connected integration catalog. On Hermes, read \`/opt/data/workspace/integrations/integrations.json\`. Use \`$NORA_INTEGRATIONS_CONFIG\` only if that file exists. Follow each \`detailsFile\` only when credential/tool details are needed.`,
    "3. Prefer an executable Nora integration tool when one is listed.",
    `4. Run \`${NORA_INTEGRATION_TOOL_COMMAND} --list\` if you need executable tool names.`,
    `5. Execute a supported tool with JSON input: \`${NORA_INTEGRATION_TOOL_COMMAND} <tool_name> '{"key":"value"}'\`.`,
    "6. If no executable tool exists, call the provider API or SDK directly with the credential env vars listed below.",
    "7. Summarize the result for the operator instead of pasting large raw payloads unless they asked for full output.",
    "",
    "## Notes",
    "",
    "- If the requested provider or tool is not listed, say the integration is not connected to this agent.",
    "- Prefer synced defaults like org, repo, channel, workspace, or default username when the operator does not specify a target.",
    "- For large file reads, summarize first and quote only the portion the operator asked for.",
    "- If an API returns 401 or 403, explain that the connected credential may not have the required provider scope instead of retrying blindly.",
    "",
  );

  if (syncedIntegrations.length === 0) {
    lines.push("No active Nora integrations are currently synced to this agent.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Connected Credentials");
  lines.push("");

  for (const integration of syncedIntegrations) {
    const provider = normalizeString(
      integration.provider || integration.catalog_id || integration.id,
    );
    const providerName = normalizeString(integration.name) || provider || "Integration";
    const capabilities = Array.isArray(integration.capabilities) ? integration.capabilities : [];
    const credentialEnv =
      integration.credentialEnv && typeof integration.credentialEnv === "object"
        ? integration.credentialEnv
        : {};
    const configEnv =
      credentialEnv.config && typeof credentialEnv.config === "object" ? credentialEnv.config : {};
    const config =
      integration.config && typeof integration.config === "object" ? integration.config : {};
    const redactedConfig =
      integration.redactedConfig && typeof integration.redactedConfig === "object"
        ? integration.redactedConfig
        : {};
    const api = integration.api && typeof integration.api === "object" ? integration.api : null;
    const usageHints = Array.isArray(integration.usageHints) ? integration.usageHints : [];
    const toolSpecs = getIntegrationToolSpecs(integration);
    const executableForIntegration = [];

    for (const spec of toolSpecs) {
      const execution = buildIntegrationToolExecutionMetadata(integration, spec);
      if (execution.executable) executableForIntegration.push({ spec, execution });
    }

    lines.push(`### ${providerName}`);
    lines.push("");
    lines.push(`- Provider id: ${provider || providerName}`);
    if (capabilities.length > 0) lines.push(`- Capabilities: ${capabilities.join(", ")}`);
    if (credentialEnv.primary) {
      lines.push(`- Primary credential env: \`${credentialEnv.primary}\``);
    } else if (api?.authEnv) {
      lines.push(`- Primary credential env: \`${api.authEnv}\``);
    } else {
      lines.push(
        "- Primary credential env: not declared; inspect `integrations/NORA_INTEGRATIONS.md` for synced config fields.",
      );
    }

    const configEnvEntries = Object.entries(configEnv).filter(([, envName]) =>
      normalizeString(envName),
    );
    if (configEnvEntries.length > 0) {
      lines.push("- Config env vars:");
      for (const [key, envName] of configEnvEntries) {
        lines.push(`  - ${key}: \`${envName}\``);
      }
    }

    const nonSecretConfigEntries = Object.entries(config)
      .filter(([, value]) => {
        if (value == null || value === "") return false;
        if (typeof value === "string" && value.length > 120) return false;
        return true;
      })
      .filter(([key]) => {
        if (isSensitiveIntegrationConfigKey(key)) return false;
        if (redactedConfig[key] === "[REDACTED]") return false;
        return true;
      });
    if (nonSecretConfigEntries.length > 0) {
      lines.push("- Synced config defaults:");
      for (const [key, value] of nonSecretConfigEntries) {
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        lines.push(`  - ${key}: ${rendered}`);
      }
    }

    if (api) {
      const apiSummary = [api.type || "api", api.baseUrl || ""].filter(Boolean).join(" ");
      lines.push(`- API: ${apiSummary || "declared"}`);
      if (api.docsUrl) lines.push(`- API docs: ${api.docsUrl}`);
    }

    if (executableForIntegration.length > 0) {
      lines.push("- Executable tools:");
      for (const { spec, execution } of executableForIntegration) {
        lines.push(
          `  - \`${execution.runtimeToolName}\`: ${normalizeString(spec.description) || "No description provided."}`,
        );
        lines.push(`    Example: \`${execution.invokeCommand}\``);
      }
    } else {
      lines.push("- Executable tools: none; use the provider API or SDK with the listed env vars.");
    }

    if (usageHints.length > 0) {
      lines.push("- Usage hints:");
      for (const hint of usageHints) {
        lines.push(`  - ${hint}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function findIntegrationTool(integrations = [], toolName) {
  const normalizedToolName = normalizeString(toolName);
  if (!normalizedToolName) return null;

  for (const integration of Array.isArray(integrations) ? integrations : []) {
    const toolSpecs = getIntegrationToolSpecs(integration);

    for (const spec of toolSpecs) {
      if (normalizeString(spec.name) !== normalizedToolName) continue;
      return {
        integration,
        spec,
        execution: buildIntegrationToolExecutionMetadata(integration, spec),
      };
    }
  }

  return null;
}

function assertRuntimeFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof fetch === "function") return fetch;
  throw new Error("Fetch is not available in this runtime");
}

function clampInteger(value, { fallback, min = 1, max = 100 }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeIntegrationConfig(integration = {}) {
  return integration.config && typeof integration.config === "object" ? integration.config : {};
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildSafeIntegrationConfig(integration = {}) {
  const config = normalizeObject(integration.config);
  const redactedConfig = normalizeObject(integration.redactedConfig);
  const keys = new Set([...Object.keys(config), ...Object.keys(redactedConfig)]);
  const safeConfig = {};

  for (const key of keys) {
    if (redactedConfig[key] === "[REDACTED]" || isSensitiveIntegrationConfigKey(key)) {
      safeConfig[key] = "[REDACTED]";
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(redactedConfig, key)) {
      safeConfig[key] = redactedConfig[key];
      continue;
    }
    safeConfig[key] = config[key];
  }

  return safeConfig;
}

function buildSafeIntegrationSummary(integration = {}) {
  const toolSpecs = getIntegrationToolSpecs(integration).map((spec) => {
    const execution = buildIntegrationToolExecutionMetadata(integration, spec);
    return {
      name: normalizeString(spec.name) || execution.runtimeToolName,
      description: normalizeString(spec.description),
      operation: normalizeString(spec.operation) || null,
      executable: execution.executable,
      executionState: execution.executionState,
      executor: execution.executor,
      invokeCommand: execution.invokeCommand,
      inputSchema: spec.inputSchema || spec.parameters || null,
      noraGenerated: spec.noraGenerated === true,
    };
  });

  return {
    id: integration.id || null,
    provider: integration.provider || integration.catalog_id || integration.id || null,
    name: integration.name || integration.provider || null,
    category: integration.category || "unknown",
    authType: integration.authType || null,
    activatedAt: integration.activatedAt || integration.activated_at || null,
    expiresAt: integration.expiresAt || integration.expires_at || null,
    status: integration.status || "active",
    capabilities: Array.isArray(integration.capabilities) ? integration.capabilities : [],
    credentialEnv: normalizeObject(integration.credentialEnv),
    config: buildSafeIntegrationConfig(integration),
    api: normalizeObject(integration.api),
    mcp: integration.mcp || null,
    usageHints: Array.isArray(integration.usageHints) ? integration.usageHints : [],
    tools: toolSpecs,
  };
}

function getGitHubToken(integration = {}) {
  const config = normalizeIntegrationConfig(integration);
  return (
    normalizeString(config.personal_access_token) ||
    normalizeString(config.access_token) ||
    normalizeString(config.token) ||
    normalizeString(process.env.GITHUB_TOKEN)
  );
}

function getGitHubBaseUrl(integration = {}) {
  const configuredBaseUrl =
    normalizeString(integration?.api?.baseUrl) ||
    normalizeString(normalizeIntegrationConfig(integration).base_url) ||
    DEFAULT_GITHUB_API_BASE_URL;
  const url = new URL(configuredBaseUrl);

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Unsupported GitHub API protocol: ${url.protocol}`);
  }

  return url;
}

function getTwitterToken(integration = {}) {
  const config = normalizeIntegrationConfig(integration);
  return (
    normalizeString(config.bearer_token) ||
    normalizeString(config.access_token) ||
    normalizeString(config.token) ||
    normalizeString(process.env.TWITTER_ACCESS_TOKEN) ||
    normalizeString(process.env.TWITTER_BEARER_TOKEN)
  );
}

function getTwitterBaseUrl(integration = {}) {
  const configuredBaseUrl =
    normalizeString(integration?.api?.baseUrl) ||
    normalizeString(normalizeIntegrationConfig(integration).base_url) ||
    DEFAULT_TWITTER_API_BASE_URL;
  const url = new URL(configuredBaseUrl);

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Unsupported Twitter/X API protocol: ${url.protocol}`);
  }

  return url;
}

function getLinkedInToken(integration = {}) {
  const config = normalizeIntegrationConfig(integration);
  return (
    normalizeString(config.access_token) ||
    normalizeString(config.token) ||
    normalizeString(process.env.LINKEDIN_ACCESS_TOKEN)
  );
}

function getLinkedInBaseUrl(integration = {}) {
  const configuredBaseUrl =
    normalizeString(integration?.api?.baseUrl) ||
    normalizeString(normalizeIntegrationConfig(integration).base_url) ||
    DEFAULT_LINKEDIN_API_BASE_URL;
  const url = new URL(configuredBaseUrl);

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Unsupported LinkedIn API protocol: ${url.protocol}`);
  }

  return url;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean);
  }
  const single = normalizeString(value);
  if (!single) return [];
  return single
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getEmailConfig(integration = {}) {
  const config = normalizeIntegrationConfig(integration);
  const auth = normalizeObject(config.auth);
  const imap = normalizeObject(config.imap);
  const smtp = normalizeObject(config.smtp);

  return {
    auth: {
      mode: normalizeString(auth.mode) || "basic",
      username: normalizeString(auth.username),
      password: normalizeString(auth.password) || normalizeString(process.env.EMAIL_PASSWORD),
      accessToken:
        normalizeString(auth.accessToken) || normalizeString(process.env.EMAIL_ACCESS_TOKEN),
    },
    imap: {
      host: normalizeString(imap.host),
      port: numberValue(imap.port, 993),
      secure: normalizeBoolean(imap.secure, true),
    },
    smtp: {
      host: normalizeString(smtp.host),
      port: numberValue(smtp.port, 465),
      secure: normalizeBoolean(smtp.secure, false),
      fromAddress: normalizeString(smtp.fromAddress),
      fromName: normalizeString(smtp.fromName),
    },
    mailboxScope: {
      mode: normalizeString(config?.mailboxScope?.mode) || "INBOX",
    },
  };
}

function getEmailStateDbPath(integration = {}) {
  const id = sanitizeIntegrationFilePart(
    integration.id || integrationProviderId(integration) || "email",
  );
  return path.join(NORA_AGENT_STATE_ROOT, `email_${id}.sqlite`);
}

function getEmailPollLogPath(integration = {}) {
  const id = sanitizeIntegrationFilePart(
    integration.id || integrationProviderId(integration) || "email",
  );
  return path.join(NORA_AGENT_STATE_ROOT, `email_${id}.poll.jsonl`);
}

function appendEmailPollLog(integration = {}, entry = {}) {
  try {
    fs.mkdirSync(NORA_AGENT_STATE_ROOT, { recursive: true });
    const payload = {
      ts: new Date().toISOString(),
      integrationId: normalizeString(integration.id) || null,
      provider: normalizeString(integration.provider) || "email",
      ...entry,
    };
    fs.appendFileSync(getEmailPollLogPath(integration), `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // Best-effort logging only.
  }
}

function appendEmailPollContainerLog(entry = {}) {
  try {
    const line = `${new Date().toISOString()} [EMAIL_POLL] ${JSON.stringify(entry)}`;
    process.stderr.write(`${line}\n`);
    fs.appendFileSync(OPENCLAW_AGENT_LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // Best-effort logging only.
  }
}

function openEmailStateDb(integration = {}) {
  fs.mkdirSync(NORA_AGENT_STATE_ROOT, { recursive: true });
  const db = new DatabaseSync(getEmailStateDbPath(integration));
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_checkpoint (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mailbox TEXT NOT NULL,
      uid_validity TEXT,
      last_seen_uid INTEGER NOT NULL DEFAULT 0,
      initialized_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      uid INTEGER PRIMARY KEY,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'processed',
      processed_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_messages_message_id
      ON processed_messages(message_id)
      WHERE message_id IS NOT NULL AND message_id != '';
  `);
  return db;
}

function emailStateGetCheckpoint(db) {
  return (
    db
      .prepare(
        `SELECT mailbox, uid_validity, last_seen_uid, initialized_at, updated_at
           FROM mailbox_checkpoint
          WHERE id = 1`,
      )
      .get() || null
  );
}

function emailStateUpsertCheckpoint(
  db,
  { mailbox = "INBOX", uidValidity = "", lastSeenUid = 0, initializedAt = null },
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mailbox_checkpoint(id, mailbox, uid_validity, last_seen_uid, initialized_at, updated_at)
     VALUES(1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mailbox = excluded.mailbox,
       uid_validity = excluded.uid_validity,
       last_seen_uid = excluded.last_seen_uid,
       updated_at = excluded.updated_at`,
  ).run(mailbox, uidValidity || null, lastSeenUid, initializedAt || now, now);
}

function emailStateHasProcessed(db, uid, messageId = "") {
  const row = db
    .prepare(
      `SELECT uid, message_id
         FROM processed_messages
        WHERE uid = ? OR (message_id IS NOT NULL AND message_id != '' AND message_id = ?)
        LIMIT 1`,
    )
    .get(uid, messageId || "");
  return Boolean(row);
}

function emailStateMarkProcessed(db, { uid, messageId = "", status = "processed" }) {
  db.prepare(
    `INSERT INTO processed_messages(uid, message_id, status, processed_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       message_id = excluded.message_id,
       status = excluded.status,
       processed_at = excluded.processed_at`,
  ).run(uid, messageId || null, status, new Date().toISOString());
}

function escapeImapString(value) {
  return `"${String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function smtpBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function buildSmtpMessageId(fromAddress) {
  const domain = String(fromAddress || "localhost").split("@")[1] || "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

function parseHeaderBlock(rawHeaders = "") {
  const lines = String(rawHeaders || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const headers = {};
  let currentKey = "";

  for (const line of lines) {
    if (!line) continue;
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`.trim();
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    currentKey = line.slice(0, separator).trim().toLowerCase();
    headers[currentKey] = line.slice(separator + 1).trim();
  }

  return headers;
}

function splitRawMessage(rawMessage = "") {
  const marker = rawMessage.indexOf("\r\n\r\n");
  if (marker >= 0) {
    return {
      headers: rawMessage.slice(0, marker),
      body: rawMessage.slice(marker + 4),
    };
  }
  const alt = rawMessage.indexOf("\n\n");
  if (alt >= 0) {
    return {
      headers: rawMessage.slice(0, alt),
      body: rawMessage.slice(alt + 2),
    };
  }
  return { headers: rawMessage, body: "" };
}

function normalizeEmailBody(rawBody = "") {
  return String(rawBody || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHeaderValue(value = "") {
  const raw = String(value || "");
  if (!raw.includes("=?")) return raw;
  return raw.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, _charset, encoding, content) => {
    try {
      if (String(encoding).toUpperCase() === "B") {
        return Buffer.from(content, "base64").toString("utf8");
      }
      return content
        .replace(/_/g, " ")
        .replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    } catch {
      return raw;
    }
  });
}

function parseEmailAddresses(value = "") {
  const raw = normalizeString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.*)<([^>]+)>$/);
      if (match) {
        return {
          name: match[1].replace(/"/g, "").trim(),
          address: match[2].trim(),
          raw: entry,
        };
      }
      const address = entry.replace(/[<>]/g, "").trim();
      return { name: "", address, raw: entry };
    });
}

function parseFetchLiteral(responseText = "") {
  const literalMatch = responseText.match(/\{(\d+)\}\r?\n([\s\S]*)$/);
  if (!literalMatch) return "";
  const size = Number.parseInt(literalMatch[1], 10);
  const after = literalMatch[2] || "";
  return after.slice(0, size);
}

async function openImapSession(integration = {}) {
  const email = getEmailConfig(integration);
  const { host, port, secure } = email.imap;
  const username = email.auth.username;
  const password = email.auth.password;

  if (!host || !username || !password) {
    throw new Error("Email IMAP host, username, and password are required");
  }

  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port });

  let buffer = "";
  let tagCounter = 0;
  let current = null;

  const readReady = new Promise((resolve, reject) => {
    socket.setTimeout(15000, () => reject(new Error("IMAP connection timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n") && !current && /\* OK/i.test(buffer)) {
        resolve();
      }
      if (current && new RegExp(`^${current.tag} (OK|NO|BAD)\\b`, "im").test(buffer)) {
        const response = buffer;
        const ok = new RegExp(`^${current.tag} OK\\b`, "im").test(response);
        const rejectFn = current.reject;
        const resolveFn = current.resolve;
        current = null;
        buffer = "";
        if (ok) resolveFn(response);
        else rejectFn(new Error(response.trim()));
      }
    });
  });

  await readReady;

  async function command(commandText) {
    if (current) throw new Error("IMAP command already in flight");
    const tag = `a${++tagCounter}`;
    return await new Promise((resolve, reject) => {
      current = { tag, resolve, reject };
      buffer = "";
      socket.write(`${tag} ${commandText}\r\n`);
    });
  }

  await command(`LOGIN ${escapeImapString(username)} ${escapeImapString(password)}`);
  const selectResponse = await command(
    `SELECT ${escapeImapString(email.mailboxScope.mode || "INBOX")}`,
  );
  const uidValidityMatch = selectResponse.match(/\[UIDVALIDITY\s+([^\]\s]+)\]/i);
  const existsMatch = selectResponse.match(/\*\s+(\d+)\s+EXISTS/i);
  const mailboxStatus = {
    mailbox: email.mailboxScope.mode || "INBOX",
    uidValidity: uidValidityMatch ? uidValidityMatch[1] : "",
    exists: existsMatch ? Number.parseInt(existsMatch[1], 10) : 0,
  };

  return {
    getMailboxStatus() {
      return { ...mailboxStatus };
    },
    async searchAll(limit = 100) {
      const response = await command("UID SEARCH ALL");
      const match = response.match(/\* SEARCH([^\r\n]*)/i);
      const uids = (match?.[1] || "")
        .trim()
        .split(/\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((entry) => Number.isFinite(entry));
      return uids.slice(Math.max(0, uids.length - limit));
    },
    async searchAfterUid(lastSeenUid, limit = 100) {
      const floor = Math.max(0, Number.parseInt(String(lastSeenUid || 0), 10));
      const response = await command(`UID SEARCH UID ${floor + 1}:*`);
      const match = response.match(/\* SEARCH([^\r\n]*)/i);
      const uids = (match?.[1] || "")
        .trim()
        .split(/\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((entry) => Number.isFinite(entry));
      return uids.slice(0, limit);
    },
    async searchNew(limit = 10) {
      const response = await command("UID SEARCH UNSEEN");
      const match = response.match(/\* SEARCH([^\r\n]*)/i);
      const uids = (match?.[1] || "")
        .trim()
        .split(/\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((entry) => Number.isFinite(entry));
      return uids.slice(Math.max(0, uids.length - limit));
    },
    async fetchHeaders(uid) {
      const response = await command(
        `UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC DATE MESSAGE-ID IN-REPLY-TO REFERENCES REPLY-TO)])`,
      );
      const headers = parseHeaderBlock(parseFetchLiteral(response));
      const uidMatch = response.match(/\bUID\s+(\d+)\b/i);
      const sizeMatch = response.match(/\bRFC822\.SIZE\s+(\d+)\b/i);
      return {
        uid: uidMatch ? Number.parseInt(uidMatch[1], 10) : uid,
        size: sizeMatch ? Number.parseInt(sizeMatch[1], 10) : null,
        headers,
      };
    },
    async fetchRawMessage(uid) {
      const response = await command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
      return {
        uid,
        raw: parseFetchLiteral(response),
      };
    },
    async close() {
      try {
        await command("LOGOUT");
      } catch {
        // ignore logout failures
      }
      socket.destroy();
    },
  };
}

async function runSmtpSession(integration = {}, message = {}) {
  const email = getEmailConfig(integration);
  const { host, port, secure, fromAddress, fromName } = email.smtp;
  const username = email.auth.username;
  const password = email.auth.password;
  const to = normalizeStringArray(message.to);
  const cc = normalizeStringArray(message.cc);
  const bcc = normalizeStringArray(message.bcc);
  const recipients = [...to, ...cc, ...bcc];

  if (!host || !username || !password || !fromAddress) {
    throw new Error("Email SMTP host, username, password, and from address are required");
  }
  if (!recipients.length) {
    throw new Error("At least one recipient is required");
  }

  let socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port });
  let buffer = "";
  const waitFor = (patterns, { timeoutMs = 15000 } = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP command timed out")), timeoutMs);
      const onError = (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/).filter(Boolean);
        const lastLine = lines[lines.length - 1] || "";
        if (!/^\d{3} /.test(lastLine)) return;
        cleanup();
        resolve(lastLine);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off("data", onData);
      };
      socket.on("error", onError);
      socket.on("data", onData);
    }).then((line) => {
      const ok = patterns.some((pattern) => pattern.test(String(line)));
      if (!ok) throw new Error(String(line).trim());
      buffer = "";
      return line;
    });

  const sendLine = async (line, patterns) => {
    socket.write(`${line}\r\n`);
    return await waitFor(patterns);
  };

  await waitFor([/^220\b/]);
  await sendLine("EHLO nora-agent", [/^250\b/]);

  if (!secure) {
    await sendLine("STARTTLS", [/^220\b/]);
    socket = tls.connect({
      socket,
      servername: host,
      rejectUnauthorized: true,
    });
    buffer = "";
    await waitFor([/^220\b/, /^250\b/]).catch(() => null);
    await sendLine("EHLO nora-agent", [/^250\b/]);
  }

  await sendLine("AUTH LOGIN", [/^334\b/]);
  await sendLine(smtpBase64(username), [/^334\b/]);
  await sendLine(smtpBase64(password), [/^235\b/]);
  await sendLine(`MAIL FROM:<${fromAddress}>`, [/^250\b/]);
  for (const recipient of recipients) {
    await sendLine(`RCPT TO:<${recipient}>`, [/^250\b/, /^251\b/]);
  }
  await sendLine("DATA", [/^354\b/]);

  const subject = normalizeString(message.subject);
  const text = normalizeString(message.text);
  const messageId = normalizeString(message.messageId) || buildSmtpMessageId(fromAddress);
  const headers = [
    `From: ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(normalizeString(message.inReplyTo)
      ? [`In-Reply-To: ${normalizeString(message.inReplyTo)}`]
      : []),
    ...(normalizeString(message.references)
      ? [`References: ${normalizeString(message.references)}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  socket.write(`${headers.join("\r\n")}\r\n\r\n${text.replace(/\r?\n/g, "\r\n")}\r\n.\r\n`);
  await waitFor([/^250\b/], { timeoutMs: 20000 });
  await sendLine("QUIT", [/^221\b/]).catch(() => null);
  socket.destroy();

  return {
    accepted: recipients,
    from: fromAddress,
    subject,
    messageId,
  };
}

function parseMimeParts(rawMessage = "") {
  const { headers: topHeaders, body: topBody } = splitRawMessage(rawMessage);
  const contentType = String(parseHeaderBlock(topHeaders)["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary="?([^";\r\n]+)"?/i);

  if (!boundaryMatch) {
    return { textBody: topBody, htmlBody: "", attachments: [] };
  }

  const boundary = boundaryMatch[1].trim();
  const parts = topBody
    .split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`, "g"))
    .slice(1)
    .filter((part) => part && !part.match(/^--\s*$/));

  let textBody = "";
  let htmlBody = "";
  const attachments = [];

  for (const part of parts) {
    const { headers: partHeaders, body: partBody } = splitRawMessage(part.replace(/^\r?\n/, ""));
    const parsed = parseHeaderBlock(partHeaders);
    const partContentType = String(parsed["content-type"] || "").toLowerCase();
    const disposition = String(parsed["content-disposition"] || "").toLowerCase();
    const encoding = String(parsed["content-transfer-encoding"] || "")
      .trim()
      .toLowerCase();

    const decode = (raw) => {
      if (encoding === "base64")
        return Buffer.from(raw.replace(/\s/g, ""), "base64").toString("utf8");
      if (encoding === "quoted-printable") {
        return raw
          .replace(/=\r?\n/g, "")
          .replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
      }
      return raw;
    };

    const filenameMatch = (parsed["content-disposition"] || parsed["content-type"] || "").match(
      /(?:filename|name)="?([^";\r\n]+)"?/i,
    );
    const filename = filenameMatch ? filenameMatch[1].trim() : "";

    if (disposition.includes("attachment") || (filename && !partContentType.startsWith("text/"))) {
      attachments.push({
        filename,
        contentType: partContentType.split(";")[0].trim(),
        size: partBody.replace(/\s/g, "").length,
      });
    } else if (partContentType.startsWith("text/html")) {
      htmlBody = normalizeEmailBody(decode(partBody));
    } else if (partContentType.startsWith("text/plain") || (!textBody && !partContentType)) {
      textBody = normalizeEmailBody(decode(partBody));
    }
  }

  return { textBody, htmlBody, attachments };
}

function sanitizeHtmlBody(html = "") {
  const sanitizeHtml = getSanitizeHtml();
  return sanitizeHtml(String(html || ""), {
    disallowedTagsMode: "discard",
    allowedTags: (sanitizeHtml.defaults.allowedTags || []).filter((tag) => tag !== "style"),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": (sanitizeHtml.defaults.allowedAttributes?.["*"] || []).filter(
        (attr) => !/^on/i.test(String(attr || "")),
      ),
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  }).trim();
}

function normalizeEmailMessage(uid, rawMessage = "", fallbackHeaders = {}) {
  const { headers: rawHeaders, body } = splitRawMessage(rawMessage);
  const headers = {
    ...fallbackHeaders,
    ...parseHeaderBlock(rawHeaders),
  };
  const from = parseEmailAddresses(headers.from);
  const to = parseEmailAddresses(headers.to);
  const cc = parseEmailAddresses(headers.cc);
  const replyTo = parseEmailAddresses(headers["reply-to"]);
  const messageId = decodeHeaderValue(headers["message-id"] || headers["messageid"] || "");
  const inReplyTo = decodeHeaderValue(headers["in-reply-to"] || "");
  const references = decodeHeaderValue(headers.references || "");

  const contentType = String(headers["content-type"] || "").toLowerCase();
  let textBody = "";
  let htmlBody = "";
  let attachments = [];

  if (contentType.includes("multipart/")) {
    const parts = parseMimeParts(rawMessage);
    textBody = parts.textBody;
    htmlBody = sanitizeHtmlBody(parts.htmlBody);
    attachments = parts.attachments;
  } else if (contentType.startsWith("text/html")) {
    htmlBody = sanitizeHtmlBody(normalizeEmailBody(body));
  } else {
    textBody = normalizeEmailBody(body);
  }

  return {
    uid,
    messageId,
    subject: decodeHeaderValue(headers.subject || ""),
    date: decodeHeaderValue(headers.date || ""),
    from,
    to,
    cc,
    replyTo,
    inReplyTo,
    references,
    textBody,
    htmlBody,
    attachments,
    rawHeaders,
  };
}

async function readResponseBody(response) {
  const rawText = await response.text();
  if (!rawText) return { rawText: "", data: null };

  try {
    return { rawText, data: JSON.parse(rawText) };
  } catch {
    return { rawText, data: null };
  }
}

function buildGitHubRequestUrl(integration, requestPath, query = {}) {
  const baseUrl = getGitHubBaseUrl(integration);
  const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const basePath =
    baseUrl.pathname && baseUrl.pathname !== "/" ? baseUrl.pathname.replace(/\/+$/, "") : "";
  baseUrl.pathname = `${basePath}${normalizedPath}`;

  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    baseUrl.searchParams.set(key, String(value));
  }

  return baseUrl.toString();
}

async function gitHubRequest({
  integration,
  requestPath,
  query,
  method = "GET",
  body = null,
  fetchImpl,
}) {
  const token = getGitHubToken(integration);
  if (!token) {
    throw new Error("GitHub token is not configured for this agent");
  }

  const fetcher = assertRuntimeFetch(fetchImpl);
  const url = buildGitHubRequestUrl(integration, requestPath, query);
  const response = await fetcher(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Nora-Agent-Runtime",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const { rawText, data } = await readResponseBody(response);
  if (!response.ok) {
    const message =
      normalizeString(data?.message) ||
      normalizeString(rawText) ||
      `GitHub API returned ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }

  return data ?? rawText;
}

function buildTwitterRequestUrl(integration, requestPath, query = {}) {
  const baseUrl = getTwitterBaseUrl(integration);
  const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const basePath =
    baseUrl.pathname && baseUrl.pathname !== "/" ? baseUrl.pathname.replace(/\/+$/, "") : "";
  baseUrl.pathname = `${basePath}${normalizedPath}`;

  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => normalizeString(entry))
        .filter(Boolean)
        .join(",");
      if (joined) baseUrl.searchParams.set(key, joined);
      continue;
    }
    baseUrl.searchParams.set(key, String(value));
  }

  return baseUrl.toString();
}

function buildLinkedInRequestUrl(integration, requestPath, query = {}) {
  const baseUrl = getLinkedInBaseUrl(integration);
  const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const basePath =
    baseUrl.pathname && baseUrl.pathname !== "/" ? baseUrl.pathname.replace(/\/+$/, "") : "";
  baseUrl.pathname = `${basePath}${normalizedPath}`;

  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => normalizeString(entry))
        .filter(Boolean)
        .join(",");
      if (joined) baseUrl.searchParams.set(key, joined);
      continue;
    }
    baseUrl.searchParams.set(key, String(value));
  }

  return baseUrl.toString();
}

async function twitterRequest({
  integration,
  requestPath,
  query,
  method = "GET",
  body = null,
  fetchImpl,
}) {
  const token = getTwitterToken(integration);
  if (!token) {
    throw new Error("Twitter/X user access token is not configured for this agent");
  }

  const fetcher = assertRuntimeFetch(fetchImpl);
  const url = buildTwitterRequestUrl(integration, requestPath, query);
  const response = await fetcher(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Nora-Agent-Runtime",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const { rawText, data } = await readResponseBody(response);
  if (!response.ok) {
    const firstError = Array.isArray(data?.errors) ? data.errors[0] : null;
    const message =
      normalizeString(firstError?.detail) ||
      normalizeString(firstError?.message) ||
      normalizeString(data?.detail) ||
      normalizeString(data?.title) ||
      normalizeString(rawText) ||
      `Twitter/X API returned ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }

  return data ?? rawText;
}

async function linkedInRequest({
  integration,
  requestPath,
  query,
  method = "GET",
  body = null,
  fetchImpl,
}) {
  const token = getLinkedInToken(integration);
  if (!token) {
    throw new Error("LinkedIn access token is not configured for this agent");
  }

  const fetcher = assertRuntimeFetch(fetchImpl);
  const url = buildLinkedInRequestUrl(integration, requestPath, query);
  const response = await fetcher(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Nora-Agent-Runtime",
      ...(body
        ? {
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const { rawText, data } = await readResponseBody(response);
  if (!response.ok) {
    const message =
      normalizeString(data?.message) ||
      normalizeString(data?.error_description) ||
      normalizeString(data?.error) ||
      normalizeString(data?.serviceErrorCode) ||
      normalizeString(rawText) ||
      `LinkedIn API returned ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }

  return { data: data ?? rawText, response };
}

function mapGitHubRepository(repo = {}) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private === true,
    description: repo.description || "",
    default_branch: repo.default_branch || null,
    html_url: repo.html_url || null,
    language: repo.language || null,
    archived: repo.archived === true,
    fork: repo.fork === true,
    updated_at: repo.updated_at || null,
  };
}

function mapGitHubPullRequest(pr = {}) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft === true,
    html_url: pr.html_url || null,
    author: pr.user?.login || null,
    created_at: pr.created_at || null,
    updated_at: pr.updated_at || null,
    head: pr.head?.ref || null,
    base: pr.base?.ref || null,
  };
}

function mapGitHubIssue(issue = {}) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url || null,
    created_at: issue.created_at || null,
    updated_at: issue.updated_at || null,
  };
}

function mapTwitterUser(user = {}) {
  return {
    id: user.id,
    username: user.username || null,
    name: user.name || null,
    description: user.description || "",
    verified: user.verified === true,
    profile_image_url: user.profile_image_url || null,
    public_metrics: user.public_metrics || null,
  };
}

function mapTwitterTweet(tweet = {}) {
  return {
    id: tweet.id,
    text: tweet.text || "",
    author_id: tweet.author_id || null,
    conversation_id: tweet.conversation_id || null,
    created_at: tweet.created_at || null,
    edit_history_tweet_ids: Array.isArray(tweet.edit_history_tweet_ids)
      ? tweet.edit_history_tweet_ids
      : [],
    public_metrics: tweet.public_metrics || null,
  };
}

function mapLinkedInUser(profile = {}) {
  return {
    sub: profile.sub || null,
    name: profile.name || null,
    given_name: profile.given_name || null,
    family_name: profile.family_name || null,
    email: profile.email || null,
    picture: profile.picture || null,
  };
}

function normalizeLinkedInVisibility(value) {
  const normalized = normalizeString(value).toUpperCase();
  return normalized === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC";
}

function getResponseHeader(response, name) {
  if (!response?.headers) return "";
  if (typeof response.headers.get === "function") {
    return normalizeString(response.headers.get(name));
  }
  const lowerName = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (String(key).toLowerCase() === lowerName) return normalizeString(value);
  }
  return "";
}

async function resolveLinkedInAuthorUrn(integration, input, fetchImpl) {
  const directUrn = normalizeString(input.author_urn || input.authorUrn);
  if (directUrn) return directUrn;

  const config = normalizeIntegrationConfig(integration);
  const configuredUrn = normalizeString(config.author_urn || config.authorUrn || config.person_urn);
  if (configuredUrn) return configuredUrn;

  const configuredSub = normalizeString(config.sub || config.person_id || config.personId);
  if (configuredSub) return `urn:li:person:${configuredSub}`;

  const { data } = await linkedInRequest({
    integration,
    requestPath: "/v2/userinfo",
    fetchImpl,
  });
  const profileSub = normalizeString(data?.sub);
  if (profileSub) return `urn:li:person:${profileSub}`;

  throw new Error("LinkedIn person id could not be resolved");
}

async function resolveGitHubOwnerType(integration, owner, fetchImpl) {
  const data = await gitHubRequest({
    integration,
    requestPath: `/users/${encodeURIComponent(owner)}`,
    fetchImpl,
  });
  return data?.type === "Organization" ? "Organization" : "User";
}

async function resolveGitHubOwner(integration, input, fetchImpl) {
  const config = normalizeIntegrationConfig(integration);
  const explicitOwner = normalizeString(input.owner);
  if (explicitOwner) return explicitOwner;

  const configuredOrg = normalizeString(config.org);
  if (configuredOrg) return configuredOrg;

  const viewer = await gitHubRequest({
    integration,
    requestPath: "/user",
    fetchImpl,
  });
  if (!normalizeString(viewer?.login)) {
    throw new Error("Could not resolve a default GitHub owner");
  }
  return viewer.login;
}

function resolveGitHubRepo(integration, input) {
  const config = normalizeIntegrationConfig(integration);
  const repo = normalizeString(input.repo) || normalizeString(config.repo);
  if (!repo) {
    throw new Error("GitHub repository is required");
  }
  return repo;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean);
  }
  const normalized = normalizeString(value);
  if (!normalized) return [];
  return normalized
    .split(",")
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function normalizeTwitterUsername(value) {
  return normalizeString(value).replace(/^@+/, "");
}

function twitterUserFields(inputFields) {
  const fields = normalizeStringList(inputFields);
  if (fields.length > 0) return fields;
  return ["description", "profile_image_url", "public_metrics", "verified"];
}

function twitterTweetFields(inputFields) {
  const fields = normalizeStringList(inputFields);
  if (fields.length > 0) return fields;
  return ["author_id", "conversation_id", "created_at", "public_metrics"];
}

async function resolveTwitterUser(integration, input, fetchImpl) {
  const config = normalizeIntegrationConfig(integration);
  const explicitUserId = normalizeString(input.user_id);
  if (explicitUserId) {
    return {
      id: explicitUserId,
      username: normalizeTwitterUsername(input.username) || null,
      name: null,
    };
  }

  const username =
    normalizeTwitterUsername(input.username) ||
    normalizeTwitterUsername(config.default_username) ||
    normalizeTwitterUsername(config.username);

  if (username) {
    const data = await twitterRequest({
      integration,
      requestPath: `/users/by/username/${encodeURIComponent(username)}`,
      query: {
        "user.fields": twitterUserFields(input.user_fields),
      },
      fetchImpl,
    });
    return mapTwitterUser(data?.data || {});
  }

  const data = await twitterRequest({
    integration,
    requestPath: "/users/me",
    query: {
      "user.fields": twitterUserFields(input.user_fields),
    },
    fetchImpl,
  });
  return mapTwitterUser(data?.data || {});
}

function filterRepositoriesByVisibility(repositories = [], visibility = "all") {
  if (visibility === "public") {
    return repositories.filter((repo) => repo.private !== true);
  }
  if (visibility === "private") {
    return repositories.filter((repo) => repo.private === true);
  }
  return repositories;
}

function decodeGitHubFileContent(file = {}) {
  const encodedContent = normalizeString(file.content).replace(/\n/g, "");
  if (!encodedContent || file.encoding !== "base64") {
    return {
      content: normalizeString(file.content),
      truncated: false,
    };
  }

  const decoded = Buffer.from(encodedContent, "base64").toString("utf8");
  if (decoded.length <= MAX_GITHUB_FILE_CONTENT_CHARS) {
    return {
      content: decoded,
      truncated: false,
    };
  }

  return {
    content: decoded.slice(0, MAX_GITHUB_FILE_CONTENT_CHARS),
    truncated: true,
  };
}

async function executeGitHubOperation({ integration, spec, input, fetchImpl }) {
  const normalizedInput = normalizeIntegrationToolInput(input);
  const operation = normalizeString(spec.operation);

  switch (operation) {
    case "repos.list": {
      const perPage = clampInteger(normalizedInput.per_page, {
        fallback: 20,
        min: 1,
        max: 100,
      });
      const visibility = normalizeString(normalizedInput.visibility) || "all";
      const requestedOwner = normalizeString(normalizedInput.owner);

      if (requestedOwner || normalizeString(normalizeIntegrationConfig(integration).org)) {
        const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
        const ownerType = await resolveGitHubOwnerType(integration, owner, fetchImpl);
        const repositories = await gitHubRequest({
          integration,
          requestPath:
            ownerType === "Organization"
              ? `/orgs/${encodeURIComponent(owner)}/repos`
              : `/users/${encodeURIComponent(owner)}/repos`,
          query: {
            per_page: perPage,
            sort: "updated",
          },
          fetchImpl,
        });

        return {
          owner,
          ownerType,
          repositories: filterRepositoriesByVisibility(
            Array.isArray(repositories) ? repositories : [],
            visibility,
          ).map(mapGitHubRepository),
        };
      }

      const repositories = await gitHubRequest({
        integration,
        requestPath: "/user/repos",
        query: {
          per_page: perPage,
          sort: "updated",
          visibility,
          affiliation: "owner,organization_member,collaborator",
        },
        fetchImpl,
      });

      return {
        owner: null,
        ownerType: "AuthenticatedUser",
        repositories: (Array.isArray(repositories) ? repositories : []).map(mapGitHubRepository),
      };
    }

    case "repos.contents.get": {
      const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
      const repo = resolveGitHubRepo(integration, normalizedInput);
      const filePath = normalizeString(normalizedInput.path);
      if (!filePath) {
        throw new Error("GitHub file path is required");
      }

      const encodedPath = filePath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const data = await gitHubRequest({
        integration,
        requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
        query: {
          ref: normalizeString(normalizedInput.ref) || undefined,
        },
        fetchImpl,
      });

      if (Array.isArray(data)) {
        return {
          owner,
          repo,
          path: filePath,
          type: "directory",
          entries: data.map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size,
            html_url: entry.html_url || null,
          })),
        };
      }

      const decoded = decodeGitHubFileContent(data);
      return {
        owner,
        repo,
        path: data.path || filePath,
        type: data.type || "file",
        sha: data.sha || null,
        size: data.size || 0,
        encoding: data.encoding || null,
        download_url: data.download_url || null,
        html_url: data.html_url || null,
        content: decoded.content,
        truncated: decoded.truncated,
      };
    }

    case "pulls.list": {
      const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
      const repo = resolveGitHubRepo(integration, normalizedInput);
      const state = normalizeString(normalizedInput.state) || "open";
      const pulls = await gitHubRequest({
        integration,
        requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        query: { state },
        fetchImpl,
      });

      return {
        owner,
        repo,
        state,
        pullRequests: (Array.isArray(pulls) ? pulls : []).map(mapGitHubPullRequest),
      };
    }

    case "issues.create": {
      const owner = await resolveGitHubOwner(integration, normalizedInput, fetchImpl);
      const repo = resolveGitHubRepo(integration, normalizedInput);
      const title = normalizeString(normalizedInput.title);
      if (!title) {
        throw new Error("GitHub issue title is required");
      }

      const issue = await gitHubRequest({
        integration,
        requestPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        method: "POST",
        body: {
          title,
          body: normalizeString(normalizedInput.body) || undefined,
        },
        fetchImpl,
      });

      return {
        owner,
        repo,
        issue: mapGitHubIssue(issue),
      };
    }

    default:
      throw new Error(`Unsupported GitHub integration operation: ${operation}`);
  }
}

async function executeTwitterOperation({ integration, spec, input, fetchImpl }) {
  const normalizedInput = normalizeIntegrationToolInput(input);
  const operation = normalizeString(spec.operation);

  switch (operation) {
    case "users.me": {
      const data = await twitterRequest({
        integration,
        requestPath: "/users/me",
        query: {
          "user.fields": twitterUserFields(normalizedInput.user_fields),
        },
        fetchImpl,
      });
      return { user: mapTwitterUser(data?.data || {}) };
    }

    case "users.tweets.list": {
      const user = await resolveTwitterUser(integration, normalizedInput, fetchImpl);
      if (!normalizeString(user.id)) {
        throw new Error("Twitter/X user id could not be resolved");
      }

      const maxResults = clampInteger(normalizedInput.max_results, {
        fallback: 10,
        min: 5,
        max: 100,
      });
      const data = await twitterRequest({
        integration,
        requestPath: `/users/${encodeURIComponent(user.id)}/tweets`,
        query: {
          max_results: maxResults,
          pagination_token: normalizeString(normalizedInput.pagination_token) || undefined,
          exclude: normalizeStringList(normalizedInput.exclude),
          "tweet.fields": twitterTweetFields(normalizedInput.tweet_fields),
        },
        fetchImpl,
      });

      return {
        user,
        tweets: (Array.isArray(data?.data) ? data.data : []).map(mapTwitterTweet),
        meta: data?.meta || {},
      };
    }

    case "tweets.create": {
      const text = normalizeString(normalizedInput.text);
      if (!text) {
        throw new Error("Tweet text is required");
      }

      const body = { text };
      const replyToTweetId = normalizeString(normalizedInput.reply_to_tweet_id);
      const quoteTweetId = normalizeString(normalizedInput.quote_tweet_id);
      if (replyToTweetId) {
        body.reply = { in_reply_to_tweet_id: replyToTweetId };
      }
      if (quoteTweetId) {
        body.quote_tweet_id = quoteTweetId;
      }

      const data = await twitterRequest({
        integration,
        requestPath: "/tweets",
        method: "POST",
        body,
        fetchImpl,
      });

      return {
        tweet: mapTwitterTweet(data?.data || {}),
      };
    }

    default:
      throw new Error(`Unsupported Twitter/X integration operation: ${operation}`);
  }
}

async function executeLinkedInOperation({ integration, spec, input, fetchImpl }) {
  const normalizedInput = normalizeIntegrationToolInput(input);
  const operation = normalizeString(spec.operation);

  switch (operation) {
    case "userinfo": {
      const { data } = await linkedInRequest({
        integration,
        requestPath: "/v2/userinfo",
        fetchImpl,
      });
      return { user: mapLinkedInUser(data || {}) };
    }

    case "ugcPosts.create": {
      const text = normalizeString(normalizedInput.text);
      if (!text) {
        throw new Error("LinkedIn post text is required");
      }

      const visibility = normalizeLinkedInVisibility(normalizedInput.visibility);
      const author = await resolveLinkedInAuthorUrn(integration, normalizedInput, fetchImpl);
      const body = {
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": visibility,
        },
      };

      const { data, response } = await linkedInRequest({
        integration,
        requestPath: "/v2/ugcPosts",
        method: "POST",
        body,
        fetchImpl,
      });

      return {
        share: {
          id:
            normalizeString(data?.id) ||
            getResponseHeader(response, "x-restli-id") ||
            getResponseHeader(response, "X-RestLi-Id") ||
            null,
          author,
          text,
          visibility,
          raw: data && typeof data === "object" ? data : null,
        },
      };
    }

    default:
      throw new Error(`Unsupported LinkedIn integration operation: ${operation}`);
  }
}

function resolveEmailUid(input = {}) {
  const uid = Number.parseInt(input.uid, 10);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error("Email message uid is required");
  }
  return uid;
}

function emailAddressString(address = {}) {
  const name = normalizeString(address?.name);
  const value = normalizeString(address?.address);
  if (!value) return "";
  return name ? `${name} <${value}>` : value;
}

function formatInboundEmailDispatchMessage(message = {}) {
  const from = (Array.isArray(message.from) ? message.from : [])
    .map(emailAddressString)
    .filter(Boolean)
    .join(", ");
  const to = (Array.isArray(message.to) ? message.to : [])
    .map(emailAddressString)
    .filter(Boolean)
    .join(", ");
  const replyTo = (Array.isArray(message.replyTo) ? message.replyTo : [])
    .map(emailAddressString)
    .filter(Boolean)
    .join(", ");
  const body = normalizeString(message.textBody || message.htmlBody || "");
  const compactBody = body.replace(/\s+/g, " ").trim();
  const snippet = compactBody.length > 400 ? `${compactBody.slice(0, 397)}...` : compactBody;

  return [
    "New inbound email received in your connected inbox.",
    "",
    `UID: ${message.uid}`,
    `Message-ID: ${message.messageId || ""}`,
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${message.subject || ""}`,
    `Date: ${message.date || ""}`,
    "",
    "Summary:",
    snippet || "(No preview available)",
    "",
    "Use the email integration tools if you want to inspect the message, reply, or mark it processed.",
  ].join("\n");
}

function formatInboundEmailMainNotification(message = {}) {
  const from = (Array.isArray(message.from) ? message.from : [])
    .map(emailAddressString)
    .filter(Boolean)
    .join(", ");
  const subject = normalizeString(message.subject);
  const date = normalizeString(message.date);
  return [
    from ? `New email received from ${from}.` : "New email received in your connected inbox.",
    subject ? `Subject: ${subject}` : "Subject: (No subject)",
    date ? `Date: ${date}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAssistantSessionEntry(text, parentId = null) {
  const timestamp = new Date().toISOString();
  return {
    type: "message",
    id: crypto.randomBytes(4).toString("hex"),
    parentId: parentId || null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function findCurrentMainSessionFile() {
  if (!fs.existsSync(OPENCLAW_SESSIONS_ROOT)) return null;
  const files = fs
    .readdirSync(OPENCLAW_SESSIONS_ROOT)
    .filter((name) => name.endsWith(".trajectory.jsonl"))
    .map((name) => {
      const absPath = path.join(OPENCLAW_SESSIONS_ROOT, name);
      const stat = fs.statSync(absPath);
      return {
        name,
        absPath,
        mtimeMs: Number(stat?.mtimeMs || 0),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.absPath, "utf8");
      if (!content.includes('"sessionKey":"agent:main:main"')) continue;
      const sessionId = file.name.replace(/\.trajectory\.jsonl$/u, "");
      const sessionFile = path.join(OPENCLAW_SESSIONS_ROOT, `${sessionId}.jsonl`);
      if (!fs.existsSync(sessionFile)) continue;
      return { sessionId, sessionFile, trajectoryFile: file.absPath };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function appendAssistantNotificationToMainSession(message = {}) {
  const sessionRef = findCurrentMainSessionFile();
  if (!sessionRef?.sessionFile) {
    throw new Error("Unable to locate the current main session file");
  }

  const notificationText = normalizeString(message);
  if (!notificationText) {
    throw new Error("Notification text is required");
  }

  const raw = fs.readFileSync(sessionRef.sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  let parentId = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed?.id) {
        parentId = parsed.id;
        break;
      }
    } catch {
      // Ignore malformed trailing lines and keep scanning backward.
    }
  }

  const entry = buildAssistantSessionEntry(notificationText, parentId);
  fs.appendFileSync(sessionRef.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  return {
    ok: true,
    sessionId: sessionRef.sessionId,
    sessionFile: sessionRef.sessionFile,
    entryId: entry.id,
  };
}

function loadOpenClawConfig() {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_FILE)) return {};
    const raw = fs.readFileSync(OPENCLAW_CONFIG_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function parseNotificationRecipient(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex <= 0) return null;
  const channel = normalizeString(raw.slice(0, separatorIndex)).toLowerCase();
  const target = normalizeString(raw.slice(separatorIndex + 1));
  if (!channel || !target) return null;
  return { channel, target };
}

function resolveConfiguredNotificationTargets() {
  const config = loadOpenClawConfig();
  const channelsConfig =
    config?.channels && typeof config.channels === "object" ? config.channels : {};
  const ownerAllowFrom = Array.isArray(config?.commands?.ownerAllowFrom)
    ? config.commands.ownerAllowFrom
    : [];
  const targets = [];
  const seen = new Set();

  for (const rawRecipient of ownerAllowFrom) {
    const parsed = parseNotificationRecipient(rawRecipient);
    if (!parsed) continue;
    const channelConfig =
      channelsConfig?.[parsed.channel] && typeof channelsConfig[parsed.channel] === "object"
        ? channelsConfig[parsed.channel]
        : null;
    if (channelConfig?.enabled === false) continue;
    const accounts =
      channelConfig?.accounts && typeof channelConfig.accounts === "object"
        ? channelConfig.accounts
        : null;
    const enabledAccountId =
      Object.entries(accounts || {}).find(([, value]) => value && value.enabled !== false)?.[0] ||
      "default";
    const dedupeKey = `${parsed.channel}:${enabledAccountId}:${parsed.target}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    targets.push({
      channel: parsed.channel,
      accountId: enabledAccountId,
      target: parsed.target,
      source: "ownerAllowFrom",
    });
  }

  return targets;
}

function sendChannelNotification({ channel, accountId, target, message } = {}) {
  const safeChannel = normalizeString(channel).toLowerCase();
  const safeAccountId = normalizeString(accountId) || "default";
  const safeTarget = normalizeString(target);
  const safeMessage = normalizeString(message);
  if (!safeChannel || !safeTarget || !safeMessage) {
    throw new Error("Channel, target, and message are required");
  }

  const argv = [
    "message",
    "send",
    "--channel",
    safeChannel,
    "--account",
    safeAccountId,
    "--target",
    safeTarget,
    "--message",
    safeMessage,
    "--json",
  ];
  const raw = execFileSync(OPENCLAW_CLI, argv, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trimmed = normalizeString(raw);
  let parsed = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = { raw: trimmed };
    }
  }
  return {
    ok: true,
    channel: safeChannel,
    accountId: safeAccountId,
    target: safeTarget,
    result: parsed,
  };
}

function deliverNotificationToConfiguredChannels(message = {}) {
  const notificationText = normalizeString(message);
  if (!notificationText) {
    return {
      ok: true,
      attempted: 0,
      delivered: 0,
      skipped: 1,
      deliveries: [],
      errors: [],
    };
  }

  const targets = resolveConfiguredNotificationTargets();
  const deliveries = [];
  const errors = [];

  for (const target of targets) {
    try {
      deliveries.push(
        sendChannelNotification({
          channel: target.channel,
          accountId: target.accountId,
          target: target.target,
          message: notificationText,
        }),
      );
    } catch (error) {
      const entry = {
        channel: target.channel,
        accountId: target.accountId,
        target: target.target,
        error: error?.message || "Unknown notification delivery failure",
      };
      errors.push(entry);
      appendEmailPollContainerLog({
        notificationDispatch: "channel_failed",
        ...entry,
      });
    }
  }

  return {
    ok: errors.length === 0,
    attempted: targets.length,
    delivered: deliveries.length,
    skipped: targets.length === 0 ? 1 : 0,
    deliveries,
    errors,
  };
}

async function sendGatewayChatMessage({ sessionKey, message } = {}) {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") {
    throw new Error("WebSocket is not available in this runtime");
  }

  const gatewayUrl = `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`;
  const identity = deriveGatewayDeviceIdentity(OPENCLAW_GATEWAY_TOKEN || "");
  const idempotencyKey = crypto.randomUUID();
  const safeSessionKey = normalizeString(sessionKey) || "main";
  const outboundMessage = normalizeString(message);
  if (!outboundMessage) {
    throw new Error("Gateway message content is required");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let requestId = 0;
    let sendRequestId = "";
    const ws = new WebSocketImpl(gatewayUrl);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Gateway dispatch timed out"));
    }, 120000);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore close failures
      }
    };

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        const { role, scopes, device } = buildGatewayConnectDevice(
          identity,
          msg.payload?.nonce || "",
        );
        ws.send(
          JSON.stringify({
            type: "req",
            id: "__connect__",
            method: "connect",
            params: {
              minProtocol: OPENCLAW_GATEWAY_MIN_PROTOCOL_VERSION,
              maxProtocol: OPENCLAW_GATEWAY_MAX_PROTOCOL_VERSION,
              client: {
                id: "gateway-client",
                version: "1.0.0",
                platform: "linux",
                mode: "backend",
              },
              role,
              scopes,
              caps: ["thinking-events"],
              commands: [],
              auth: OPENCLAW_GATEWAY_TOKEN ? { password: OPENCLAW_GATEWAY_TOKEN } : {},
              device,
            },
          }),
        );
        return;
      }

      if (msg.id === "__connect__") {
        if (!msg.ok) {
          cleanup();
          reject(new Error(msg.error?.message || "Gateway connect failed"));
          return;
        }
        const sendId = `r${++requestId}`;
        sendRequestId = sendId;
        ws.send(
          JSON.stringify({
            type: "req",
            id: sendId,
            method: "chat.send",
            params: {
              sessionKey: safeSessionKey,
              idempotencyKey,
              message: outboundMessage,
            },
          }),
        );
        return;
      }

      if (msg.id === sendRequestId) {
        if (!msg.ok) {
          cleanup();
          reject(new Error(msg.error?.message || "Gateway chat.send failed"));
          return;
        }
        cleanup();
        resolve({
          ok: true,
          sessionKey: safeSessionKey,
          idempotencyKey,
          accepted: true,
        });
        return;
      }

      if (msg.id && msg.ok === false) {
        cleanup();
        reject(new Error(msg.error?.message || "Gateway RPC failed"));
      }
    });

    ws.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(event?.message || "Gateway WebSocket error"));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        cleanup();
        reject(new Error("Gateway connection closed during dispatch"));
      }
    });
  });
}

async function dispatchEmailMessageToGateway(message = {}) {
  const processingMessage = formatInboundEmailDispatchMessage(message);
  const notificationMessage = formatInboundEmailMainNotification(message);
  const processingResult = await sendGatewayChatMessage({
    sessionKey: "email:inbox",
    message: processingMessage,
  });
  const notificationResult = appendAssistantNotificationToMainSession(notificationMessage);
  const channelNotificationResult = deliverNotificationToConfiguredChannels(notificationMessage);
  return {
    ok: true,
    processing: processingResult,
    notification: notificationResult,
    channels: channelNotificationResult,
  };
}

function resolveEmailIntegrationForPoll(integrations = [], input = {}) {
  const requestedId = normalizeString(input.integrationId);
  const emailIntegrations = (Array.isArray(integrations) ? integrations : []).filter(
    (entry) => integrationProviderId(entry) === "email",
  );
  if (requestedId) {
    const match = emailIntegrations.find((entry) => normalizeString(entry.id) === requestedId);
    if (!match) {
      throw new Error(`Email integration "${requestedId}" is not synced to this agent`);
    }
    return match;
  }
  if (emailIntegrations.length === 1) return emailIntegrations[0];
  if (!emailIntegrations.length) {
    throw new Error("No Email integration is synced to this agent");
  }
  throw new Error("Multiple Email integrations are synced; integrationId is required");
}

async function executeEmailPoll({ integration, input }) {
  const normalizedInput = normalizeIntegrationToolInput(input);
  const startedAt = Date.now();
  const db = openEmailStateDb(integration);
  const session = await openImapSession(integration);
  try {
    const mailboxStatus = session.getMailboxStatus();
    const checkpoint = emailStateGetCheckpoint(db);
    const mailbox = mailboxStatus.mailbox || "INBOX";
    const uidValidity = mailboxStatus.uidValidity || "";
    const scanLimit = clampInteger(normalizedInput.limit, {
      fallback: 25,
      min: 1,
      max: 100,
    });
    appendEmailPollLog(integration, {
      event: "poll_started",
      mailbox,
      uidValidity,
      scanLimit,
      checkpointPresent: !!checkpoint,
      lastSeenUid: checkpoint?.last_seen_uid ?? null,
    });
    appendEmailPollContainerLog({
      event: "poll_started",
      integrationId: normalizeString(integration.id) || null,
      mailbox,
      uidValidity,
      scanLimit,
      checkpointPresent: !!checkpoint,
      lastSeenUid: checkpoint?.last_seen_uid ?? null,
    });

    if (!checkpoint) {
      const allUids = await session.searchAll(500);
      const lastSeenUid = allUids.length ? Math.max(...allUids) : 0;
      emailStateUpsertCheckpoint(db, {
        mailbox,
        uidValidity,
        lastSeenUid,
      });
      const result = {
        mailbox,
        initialized: true,
        initialSyncMode: "start_from_now",
        lastSeenUid,
        dispatched: 0,
        skippedHistorical: allUids.length,
      };
      appendEmailPollLog(integration, {
        event: "poll_initialized",
        mailbox,
        uidValidity,
        durationMs: Date.now() - startedAt,
        lastSeenUid,
        skippedHistorical: allUids.length,
      });
      appendEmailPollContainerLog({
        event: "poll_initialized",
        integrationId: normalizeString(integration.id) || null,
        mailbox,
        uidValidity,
        durationMs: Date.now() - startedAt,
        lastSeenUid,
        skippedHistorical: allUids.length,
      });
      return result;
    }

    if (checkpoint.uid_validity && uidValidity && checkpoint.uid_validity !== uidValidity) {
      const allUids = await session.searchAll(500);
      const lastSeenUid = allUids.length ? Math.max(...allUids) : 0;
      emailStateUpsertCheckpoint(db, {
        mailbox,
        uidValidity,
        lastSeenUid,
        initializedAt: checkpoint.initialized_at,
      });
      const result = {
        mailbox,
        checkpointReset: true,
        reason: "uidvalidity_changed",
        lastSeenUid,
        dispatched: 0,
      };
      appendEmailPollLog(integration, {
        event: "poll_checkpoint_reset",
        mailbox,
        uidValidity,
        durationMs: Date.now() - startedAt,
        reason: "uidvalidity_changed",
        lastSeenUid,
      });
      appendEmailPollContainerLog({
        event: "poll_checkpoint_reset",
        integrationId: normalizeString(integration.id) || null,
        mailbox,
        uidValidity,
        durationMs: Date.now() - startedAt,
        reason: "uidvalidity_changed",
        lastSeenUid,
      });
      return result;
    }

    const lastSeenUid = Number.parseInt(String(checkpoint.last_seen_uid || 0), 10) || 0;
    const candidateUids = await session.searchAfterUid(lastSeenUid, scanLimit);
    let newLastSeenUid = lastSeenUid;
    const dispatched = [];

    for (const uid of candidateUids) {
      const headerResult = await session.fetchHeaders(uid);
      const rawResult = await session.fetchRawMessage(uid);
      const message = normalizeEmailMessage(uid, rawResult.raw, headerResult.headers);
      if (emailStateHasProcessed(db, uid, message.messageId)) {
        newLastSeenUid = Math.max(newLastSeenUid, uid);
        continue;
      }
      const dispatchResult = await dispatchEmailMessageToGateway(message);
      emailStateMarkProcessed(db, {
        uid,
        messageId: message.messageId,
        status: "dispatched",
      });
      newLastSeenUid = Math.max(newLastSeenUid, uid);
      dispatched.push({
        uid,
        messageId: message.messageId,
        subject: message.subject,
        dispatch: dispatchResult,
      });
    }

    if (newLastSeenUid !== lastSeenUid) {
      emailStateUpsertCheckpoint(db, {
        mailbox,
        uidValidity,
        lastSeenUid: newLastSeenUid,
        initializedAt: checkpoint.initialized_at,
      });
    }

    const result = {
      mailbox,
      initialized: false,
      lastSeenUid: newLastSeenUid,
      scanned: candidateUids.length,
      dispatched: dispatched.length,
      messages: dispatched,
    };
    appendEmailPollLog(integration, {
      event: "poll_completed",
      mailbox,
      uidValidity,
      durationMs: Date.now() - startedAt,
      scanned: candidateUids.length,
      dispatched: dispatched.length,
      lastSeenUid: newLastSeenUid,
      messageUids: dispatched.map((entry) => entry.uid),
    });
    appendEmailPollContainerLog({
      event: "poll_completed",
      integrationId: normalizeString(integration.id) || null,
      mailbox,
      uidValidity,
      durationMs: Date.now() - startedAt,
      scanned: candidateUids.length,
      dispatched: dispatched.length,
      lastSeenUid: newLastSeenUid,
      messageUids: dispatched.map((entry) => entry.uid),
    });
    return result;
  } catch (error) {
    appendEmailPollLog(integration, {
      event: "poll_failed",
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error),
    });
    appendEmailPollContainerLog({
      event: "poll_failed",
      integrationId: normalizeString(integration.id) || null,
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error),
    });
    throw error;
  } finally {
    try {
      await session.close();
    } catch {
      // ignore close failures
    }
    db.close();
  }
}

function emailSummaryFromHeaders(uid, headerResult = {}) {
  const headers = normalizeObject(headerResult.headers);
  const from = parseEmailAddresses(headers.from);
  const to = parseEmailAddresses(headers.to);
  const cc = parseEmailAddresses(headers.cc);
  const replyTo = parseEmailAddresses(headers["reply-to"]);
  return {
    uid,
    size: headerResult.size || null,
    messageId: decodeHeaderValue(headers["message-id"] || headers["messageid"] || ""),
    subject: decodeHeaderValue(headers.subject || ""),
    date: decodeHeaderValue(headers.date || ""),
    from,
    to,
    cc,
    replyTo,
    inReplyTo: decodeHeaderValue(headers["in-reply-to"] || ""),
    references: decodeHeaderValue(headers.references || ""),
  };
}

async function executeEmailOperation({ integration, spec, input }) {
  const normalizedInput = normalizeIntegrationToolInput(input);
  const operation = normalizeString(spec.operation);

  switch (operation) {
    case "messages.list_new": {
      const db = openEmailStateDb(integration);
      const session = await openImapSession(integration);
      try {
        const limit = clampInteger(normalizedInput.limit, {
          fallback: 10,
          min: 1,
          max: 100,
        });
        const uids = await session.searchNew(limit);
        const messages = [];

        for (const uid of uids) {
          const headerResult = await session.fetchHeaders(uid);
          const summary = emailSummaryFromHeaders(uid, headerResult);
          const processed = emailStateHasProcessed(db, uid, summary.messageId);
          if (processed) continue;
          messages.push(summary);
        }

        return {
          mailbox: getEmailConfig(integration).mailboxScope.mode || "INBOX",
          messages,
        };
      } finally {
        try {
          await session.close();
        } catch {
          // ignore close failures
        }
        db.close();
      }
    }

    case "messages.get": {
      const session = await openImapSession(integration);
      try {
        const uid = resolveEmailUid(normalizedInput);
        const headerResult = await session.fetchHeaders(uid);
        const rawResult = await session.fetchRawMessage(uid);
        return {
          message: normalizeEmailMessage(uid, rawResult.raw, headerResult.headers),
        };
      } finally {
        try {
          await session.close();
        } catch {
          // ignore close failures
        }
      }
    }

    case "messages.send": {
      const subject = normalizeString(normalizedInput.subject);
      const text = normalizeString(normalizedInput.text);
      if (!subject) throw new Error("Email subject is required");
      if (!text) throw new Error("Email text is required");

      const sendResult = await runSmtpSession(integration, {
        to: normalizeStringArray(normalizedInput.to),
        cc: normalizeStringArray(normalizedInput.cc),
        bcc: normalizeStringArray(normalizedInput.bcc),
        subject,
        text,
      });

      return {
        delivery: sendResult,
      };
    }

    case "messages.reply": {
      const uid = resolveEmailUid(normalizedInput);
      const session = await openImapSession(integration);
      try {
        const headerResult = await session.fetchHeaders(uid);
        const rawResult = await session.fetchRawMessage(uid);
        const original = normalizeEmailMessage(uid, rawResult.raw, headerResult.headers);
        const replyText = normalizeString(normalizedInput.text);
        if (!replyText) {
          throw new Error("Reply text is required");
        }

        const preferredRecipients = original.replyTo.length > 0 ? original.replyTo : original.from;
        const to = preferredRecipients
          .map((entry) => normalizeString(entry.address))
          .filter(Boolean);
        if (!to.length) {
          throw new Error("Could not resolve a reply recipient");
        }

        const subject = /^re:/i.test(original.subject)
          ? original.subject
          : `Re: ${original.subject || "Message"}`;
        const references = [original.references, original.messageId]
          .map((value) => normalizeString(value))
          .filter(Boolean)
          .join(" ")
          .trim();

        const sendResult = await runSmtpSession(integration, {
          to,
          subject,
          text: replyText,
          inReplyTo: original.messageId,
          references,
        });

        return {
          original: {
            uid: original.uid,
            messageId: original.messageId,
            subject: original.subject,
            from: original.from.map(emailAddressString).filter(Boolean),
          },
          delivery: sendResult,
        };
      } finally {
        try {
          await session.close();
        } catch {
          // ignore close failures
        }
      }
    }

    case "messages.mark_processed": {
      const uid = resolveEmailUid(normalizedInput);
      const normalizedMessageId =
        normalizeString(normalizedInput.messageId) || normalizeString(normalizedInput.message_id);
      const db = openEmailStateDb(integration);
      try {
        emailStateMarkProcessed(db, {
          uid,
          messageId: normalizedMessageId,
          status: normalizeString(normalizedInput.status) || "processed",
        });
        return {
          uid,
          messageId: normalizedMessageId || null,
          status: normalizeString(normalizedInput.status) || "processed",
          recorded: true,
        };
      } finally {
        db.close();
      }
    }

    default:
      throw new Error(`Unsupported Email integration operation: ${operation}`);
  }
}

async function executeIntegrationToolInvocation({
  toolName,
  input = {},
  integrations = null,
  fetchImpl,
}) {
  const syncedIntegrations = Array.isArray(integrations) ? integrations : loadSyncedIntegrations();
  const normalizedToolName = normalizeString(toolName);

  const match = findIntegrationTool(syncedIntegrations, toolName);

  if (!match) {
    throw new Error(`Nora integration tool "${toolName}" is not synced to this agent`);
  }

  if (!match.execution.executable) {
    throw new Error(
      `Nora integration tool "${toolName}" is connected but not executable in this runtime`,
    );
  }

  let result;
  if (normalizeString(match.spec.operation) === INTEGRATION_MANIFEST_INSPECT_OPERATION) {
    result = {
      integration: buildSafeIntegrationSummary(match.integration),
    };
  } else {
    switch (normalizeString(match.integration.provider).toLowerCase()) {
      case "github":
        result = await executeGitHubOperation({
          integration: match.integration,
          spec: match.spec,
          input,
          fetchImpl,
        });
        break;
      case "twitter":
        result = await executeTwitterOperation({
          integration: match.integration,
          spec: match.spec,
          input,
          fetchImpl,
        });
        break;
      case "linkedin":
        result = await executeLinkedInOperation({
          integration: match.integration,
          spec: match.spec,
          input,
          fetchImpl,
        });
        break;
      case "email":
        result = await executeEmailOperation({
          integration: match.integration,
          spec: match.spec,
          input,
          fetchImpl,
        });
        break;
      default:
        throw new Error(
          `Nora integration provider "${match.integration.provider}" is not executable in this runtime`,
        );
    }
  }

  return {
    ok: true,
    toolName: match.spec.name,
    provider: match.integration.provider,
    providerName: match.integration.name || match.integration.provider,
    operation: match.spec.operation || null,
    input: normalizeIntegrationToolInput(input),
    result,
    executedAt: new Date().toISOString(),
  };
}

module.exports = {
  NORA_INTEGRATION_TOOL_COMMAND,
  NORA_INTEGRATIONS_SKILL_FILE,
  NORA_INTEGRATIONS_SKILL_NAME,
  NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
  NORA_SYNC_INTEGRATIONS_CONFIG_FILE,
  NORA_SYNC_INTEGRATIONS_DIR,
  NORA_SYNC_INTEGRATIONS_FILE,
  NORA_SYNC_INTEGRATIONS_FILES,
  NORA_SYNC_INTEGRATIONS_LEGACY_CONFIG_FILE,
  NORA_SYNC_INTEGRATIONS_LEGACY_CONFIG_JSON_FILE,
  NORA_SYNC_INTEGRATIONS_LEGACY_FILE,
  buildSplitIntegrationManifest,
  buildSafeIntegrationSummary,
  buildIntegrationSkillMarkdown,
  buildIntegrationToolExecutionMetadata,
  executeIntegrationToolInvocation,
  getExecutableIntegrationTools,
  getIntegrationToolSpecs,
  isIntegrationToolExecutable,
  loadSyncedIntegrations,
  normalizeEmailMessage,
  normalizeIntegrationToolInput,
};
