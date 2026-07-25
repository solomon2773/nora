// @ts-nocheck
const fs = require("fs");
const path = require("path");
const { AGENT_RUNTIME_PORT, OPENCLAW_GATEWAY_PORT } = require("./contracts");
const {
  NORA_INTEGRATION_TOOL_COMMAND,
  NORA_INTEGRATIONS_SKILL_FILE,
  NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
  NORA_SYNC_INTEGRATIONS_DIR,
  buildIntegrationSkillMarkdown,
  buildSplitIntegrationManifest,
} = require("./integrationTools");
const { DEFAULT_OPENCLAW_PACKAGE_SPEC } = require("./openclawDefaults");

const TSX_PACKAGE_SPEC = process.env.OPENCLAW_TSX_PACKAGE || "tsx@4.21.0";

function runtimeSourcePath(relPath) {
  return path.resolve(__dirname, relPath);
}

function readRuntimeSource(relPath) {
  return fs.readFileSync(runtimeSourcePath(relPath), "utf8");
}

const RUNTIME_FILES = [
  "containerCommand.ts",
  "contracts.ts",
  "openclawDefaults.ts",
  "runtimeBootstrap.ts",
  // Required by runtimeBootstrap's require("./mcpServersConfig") — every module
  // runtimeBootstrap imports relatively must ship into the container with it,
  // or the in-container runtime server fails at load.
  "mcpServersConfig.ts",
  "execEndpoint.ts",
  "integrationTools.ts",
  "integrationToolCli.ts",
  "server.ts",
  "agent.ts",
].map((relPath) => ({
  relPath,
  source: readRuntimeSource(relPath),
  sourceB64: Buffer.from(readRuntimeSource(relPath)).toString("base64"),
}));

const INTEGRATION_TOOL_WRAPPER_SOURCE = [
  "#!/usr/bin/env sh",
  'TSX_BIN="${OPENCLAW_TSX_BIN:-$(command -v tsx 2>/dev/null || true)}"',
  '[ -n "$TSX_BIN" ] || TSX_BIN="tsx"',
  'exec "$TSX_BIN" /opt/openclaw-runtime/lib/integrationToolCli.ts "$@"',
  "",
].join("\n");
const INTEGRATION_TOOL_WRAPPER_B64 = Buffer.from(INTEGRATION_TOOL_WRAPPER_SOURCE, "utf8").toString(
  "base64",
);
const MCP_SERVER_WRAPPER_SOURCE = [
  "#!/usr/bin/env sh",
  "set -eu",
  'if [ "$#" -ne 1 ]; then echo "usage: nora-mcp-server <config-b64>" >&2; exit 64; fi',
  "exec node - \"$1\" <<'__NORA_MCP_SERVER_WRAPPER__'",
  'const { spawn } = require("node:child_process");',
  "const payload = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));",
  "if (!payload || typeof payload.npmPackage !== 'string' || !payload.npmPackage.trim()) process.exit(64);",
  "const args = Array.isArray(payload.args) ? payload.args.map(String) : [];",
  "const aliases = payload.envAliases && typeof payload.envAliases === 'object' && !Array.isArray(payload.envAliases) ? payload.envAliases : {};",
  "const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;",
  "const env = { ...process.env };",
  "for (const [target, alias] of Object.entries(aliases)) {",
  "  if (!validName.test(target) || !validName.test(String(alias))) throw new Error('Invalid MCP environment alias');",
  "  if (Object.prototype.hasOwnProperty.call(process.env, alias)) env[target] = process.env[alias];",
  "  else delete env[target];",
  "}",
  "const child = spawn('npx', ['-y', payload.npmPackage, ...args], { env, stdio: 'inherit' });",
  "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));",
  "child.on('error', (error) => { console.error(error.message); process.exit(1); });",
  "child.on('exit', (code, signal) => {",
  "  if (signal) { process.kill(process.pid, signal); return; }",
  "  process.exit(Number.isInteger(code) ? code : 1);",
  "});",
  "__NORA_MCP_SERVER_WRAPPER__",
  "",
].join("\n");
const MCP_SERVER_WRAPPER_B64 = Buffer.from(MCP_SERVER_WRAPPER_SOURCE, "utf8").toString("base64");

const OPENCLAW_WORKSPACE_ROOT = "/root/.openclaw/workspace";
const OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT = "/root/.openclaw/agents/main/agent";
const OPENCLAW_AUTH_PROFILES_PATH = `${OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT}/auth-profiles.json`;
const NORA_INTEGRATIONS_CONTEXT_FILE = "integrations/NORA_INTEGRATIONS.md";
const NORA_INTEGRATIONS_PROMPT_BEGIN = "<!-- NORA_INTEGRATIONS_BEGIN -->";
const NORA_INTEGRATIONS_PROMPT_END = "<!-- NORA_INTEGRATIONS_END -->";

function stripGeneratedIntegrationPromptBlock(content) {
  const raw = typeof content === "string" ? content : "";
  const pattern = new RegExp(
    `\\n?${NORA_INTEGRATIONS_PROMPT_BEGIN}[\\s\\S]*?${NORA_INTEGRATIONS_PROMPT_END}\\n?`,
    "g",
  );
  return raw
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function buildIntegrationPromptPointerMarkdown() {
  return [
    NORA_INTEGRATIONS_PROMPT_BEGIN,
    "",
    "## Nora Integrations",
    "",
    "- Connected integrations for this agent are generated in `integrations/`.",
    "- Check `integrations/NORA_INTEGRATIONS.md` before saying no integration is connected.",
    "- Use `nora-integration-tool --list` to list executable tools.",
    "- Use `nora-integration-tool <tool_name> '<json input>'` to invoke supported provider tools.",
    "- Never print credential values; provider detail files are private runtime config.",
    "",
    NORA_INTEGRATIONS_PROMPT_END,
  ].join("\n");
}

function upsertGeneratedIntegrationPromptBlock(content) {
  const cleaned = stripGeneratedIntegrationPromptBlock(content);
  return `${cleaned.trimEnd()}\n\n${buildIntegrationPromptPointerMarkdown()}\n`.trimStart();
}

function buildEmptyIntegrationContextMarkdown() {
  return [
    "# Nora Integrations",
    "",
    "This file is generated by Nora from the active integrations connected to this agent.",
    "Use only the providers listed here.",
    `Machine-readable integration metadata is available in \`${NORA_SYNC_INTEGRATIONS_DIR}\` on OpenClaw. Start with \`${NORA_SYNC_INTEGRATIONS_CATALOG_FILE}\`, then follow each \`detailsFile\` only when credential/tool details are needed.`,
    "When a connected tool shows runtime execution below, use the generated `nora-integrations` skill and `nora-integration-tool` command through the exec tool.",
    "",
    "No active Nora integrations are currently synced to this agent.",
    "",
  ].join("\n");
}

function buildRuntimeBootstrapFiles() {
  return RUNTIME_FILES.map(({ relPath, source }) => ({ relPath, source }));
}

function buildIntegrationToolWrapperScript() {
  return INTEGRATION_TOOL_WRAPPER_SOURCE;
}

function buildMcpServerWrapperScript() {
  return MCP_SERVER_WRAPPER_SOURCE;
}

function buildOpenClawGatewayPairingCommand(options = {}) {
  const defaultHome = String(options.defaultHome || "/root");
  return [
    "node <<'__NORA_OPENCLAW_GATEWAY_IDENTITY__'",
    "const crypto = require('crypto');",
    "const fs = require('fs');",
    "const path = require('path');",
    `const defaultHome = ${JSON.stringify(defaultHome)};`,
    "const gatewayToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();",
    "if (!gatewayToken) throw new Error('OPENCLAW_GATEWAY_TOKEN is required');",
    "const home = String(process.env.HOME || defaultHome);",
    "const stateRoot = path.join(home, '.openclaw');",
    "const configPath = path.join(stateRoot, 'openclaw.json');",
    "const devicesDir = path.join(stateRoot, 'devices');",
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
    "function writeJsonAtomic(targetPath, value) {",
    "  fs.mkdirSync(path.dirname(targetPath), { recursive: true });",
    "  const temporaryPath = `${targetPath}.nora-${process.pid}-${Date.now()}.tmp`;",
    "  try {",
    "    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 });",
    "    fs.chmodSync(temporaryPath, 0o600);",
    "    fs.renameSync(temporaryPath, targetPath);",
    "  } finally { try { fs.rmSync(temporaryPath, { force: true }); } catch {} }",
    "}",
    "let config = {};",
    "try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { config = {}; }",
    "if (!isPlainObject(config)) config = {};",
    "if (!isPlainObject(config.gateway)) config.gateway = {};",
    "if (!isPlainObject(config.gateway.auth)) config.gateway.auth = {};",
    "config.gateway.auth.password = gatewayToken;",
    "writeJsonAtomic(configPath, config);",
    "const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');",
    "const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');",
    "const seed = crypto.createHash('sha256').update(`openclaw-device:${gatewayToken}`).digest();",
    "const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });",
    "const rawPublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length);",
    "const deviceId = crypto.createHash('sha256').update(rawPublicKey).digest('hex');",
    "const publicKey = rawPublicKey.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');",
    "const operatorToken = crypto.createHmac('sha256', gatewayToken).update('nora-openclaw-operator-token').digest('hex');",
    "const scopes = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'];",
    "const now = Date.now();",
    "writeJsonAtomic(path.join(devicesDir, 'paired.json'), {",
    "  [deviceId]: {",
    "    deviceId, publicKey, platform: 'linux', clientId: 'gateway-client', clientMode: 'backend',",
    "    role: 'operator', roles: ['operator'], scopes, approvedScopes: scopes,",
    "    tokens: { operator: { token: operatorToken, role: 'operator', scopes, createdAtMs: now } },",
    "    createdAtMs: now, approvedAtMs: now,",
    "  },",
    "});",
    "writeJsonAtomic(path.join(devicesDir, 'pending.json'), {});",
    "__NORA_OPENCLAW_GATEWAY_IDENTITY__",
  ].join("\n");
}

// Allowlist: alphanumerics, dot, underscore, dash, and forward slash only.
// Blocks shell metacharacters ($, `, \, ", ', ;, newline, whitespace, etc.)
// so bootstrap paths cannot break out of their quoted context and execute
// command substitution when interpolated into `sh -c` strings.
const SAFE_TEMPLATE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

function normalizeTemplateEntry(entry, baseDir) {
  if (!entry || typeof entry !== "object") return null;
  const rawPath = String(entry.path || "")
    .trim()
    .replace(/\\/g, "/");
  if (!rawPath) return null;

  const normalizedPath = path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (!normalizedPath || normalizedPath === "." || normalizedPath.startsWith("../")) {
    return null;
  }
  if (!SAFE_TEMPLATE_PATH_RE.test(normalizedPath)) {
    return null;
  }

  let contentBuffer;
  if (typeof entry.contentBase64 === "string" && entry.contentBase64) {
    try {
      contentBuffer = Buffer.from(entry.contentBase64, "base64");
    } catch {
      return null;
    }
  } else if (typeof entry.content === "string") {
    contentBuffer = Buffer.from(entry.content, "utf8");
  } else {
    return null;
  }

  return {
    targetPath: path.posix.join(baseDir, normalizedPath),
    contentBuffer,
    mode: Number.isInteger(entry.mode) ? entry.mode : 0o644,
  };
}

function normalizeTemplatePayloadEntries(templatePayload = {}) {
  const files = Array.isArray(templatePayload.files) ? templatePayload.files : [];
  const memoryFiles = Array.isArray(templatePayload.memoryFiles) ? templatePayload.memoryFiles : [];

  const entries = [
    ...files
      .flatMap((entry) => [
        normalizeTemplateEntry(entry, OPENCLAW_WORKSPACE_ROOT),
        normalizeTemplateEntry(entry, OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT),
      ])
      .filter(Boolean),
    ...memoryFiles.map((entry) => normalizeTemplateEntry(entry, "/root/.openclaw")).filter(Boolean),
  ];

  return withIntegrationBootstrapEntries(entries);
}

function isGeneratedIntegrationTarget(targetPath) {
  const relativeWorkspacePath = targetPath.startsWith(`${OPENCLAW_WORKSPACE_ROOT}/`)
    ? targetPath.slice(OPENCLAW_WORKSPACE_ROOT.length + 1)
    : "";
  if (!relativeWorkspacePath) return false;
  return (
    relativeWorkspacePath === NORA_INTEGRATIONS_CONTEXT_FILE ||
    relativeWorkspacePath === NORA_INTEGRATIONS_SKILL_FILE ||
    relativeWorkspacePath === "integrations/integrations.json" ||
    relativeWorkspacePath.startsWith("integrations/integrations.")
  );
}

function isTemplateToolsPath(targetPath, rootDir) {
  return targetPath === path.posix.join(rootDir, "TOOLS.md");
}

function withIntegrationBootstrapEntries(entries = []) {
  const nextEntries = [];
  let hasWorkspaceTools = false;
  let hasLegacyTools = false;

  for (const entry of entries) {
    if (!entry || isGeneratedIntegrationTarget(entry.targetPath)) continue;

    if (isTemplateToolsPath(entry.targetPath, OPENCLAW_WORKSPACE_ROOT)) {
      hasWorkspaceTools = true;
      nextEntries.push({
        ...entry,
        contentBuffer: Buffer.from(
          upsertGeneratedIntegrationPromptBlock(entry.contentBuffer.toString("utf8")),
          "utf8",
        ),
      });
      continue;
    }

    if (isTemplateToolsPath(entry.targetPath, OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT)) {
      hasLegacyTools = true;
      nextEntries.push({
        ...entry,
        contentBuffer: Buffer.from(
          upsertGeneratedIntegrationPromptBlock(entry.contentBuffer.toString("utf8")),
          "utf8",
        ),
      });
      continue;
    }

    nextEntries.push(entry);
  }

  const defaultToolsContent = "## Tools\n\n";
  if (!hasWorkspaceTools) {
    nextEntries.push({
      targetPath: path.posix.join(OPENCLAW_WORKSPACE_ROOT, "TOOLS.md"),
      contentBuffer: Buffer.from(
        upsertGeneratedIntegrationPromptBlock(defaultToolsContent),
        "utf8",
      ),
      mode: 0o644,
    });
  }
  if (!hasLegacyTools) {
    nextEntries.push({
      targetPath: path.posix.join(OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT, "TOOLS.md"),
      contentBuffer: Buffer.from(
        upsertGeneratedIntegrationPromptBlock(defaultToolsContent),
        "utf8",
      ),
      mode: 0o644,
    });
  }

  const emptyManifest = buildSplitIntegrationManifest([]);
  nextEntries.push(
    {
      targetPath: NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
      contentBuffer: Buffer.from(`${JSON.stringify(emptyManifest.catalog, null, 2)}\n`, "utf8"),
      mode: 0o644,
    },
    {
      targetPath: path.posix.join(OPENCLAW_WORKSPACE_ROOT, NORA_INTEGRATIONS_CONTEXT_FILE),
      contentBuffer: Buffer.from(buildEmptyIntegrationContextMarkdown(), "utf8"),
      mode: 0o644,
    },
    {
      targetPath: path.posix.join(OPENCLAW_WORKSPACE_ROOT, NORA_INTEGRATIONS_SKILL_FILE),
      contentBuffer: Buffer.from(`${buildIntegrationSkillMarkdown([])}\n`, "utf8"),
      mode: 0o644,
    },
  );

  return nextEntries;
}

function buildTemplatePayloadBootstrapFiles(templatePayload = {}) {
  return normalizeTemplatePayloadEntries(templatePayload).map((entry) => ({
    name: entry.targetPath.replace(/^\/+/, ""),
    content: entry.contentBuffer,
    mode: entry.mode,
  }));
}

const { shellSingleQuote } = require("./containerCommand");

function buildTemplatePayloadBootstrapCommand(templatePayload = {}) {
  const entries = normalizeTemplatePayloadEntries(templatePayload);
  if (entries.length === 0) return "";

  return entries
    .map(({ targetPath, contentBuffer, mode }) => {
      const quotedDir = shellSingleQuote(path.posix.dirname(targetPath));
      const quotedPath = shellSingleQuote(targetPath);
      return (
        `mkdir -p ${quotedDir} && ` +
        `printf '%s' '${contentBuffer.toString("base64")}' | base64 -d > ${quotedPath} && ` +
        `chmod ${mode.toString(8)} ${quotedPath} && `
      );
    })
    .join("");
}

// OpenClaw provider id used when registering Microsoft Foundry / Azure
// OpenAI in openclaw.json. Nora's internal provider id ("microsoft-foundry")
// is the UI/DB label; OpenClaw needs the id the integration guide uses
// (https://techcommunity.microsoft.com/blog/educatordeveloperblog/integrating-microsoft-foundry-with-openclaw-step-by-step-model-configuration/4495586),
// which is `azure-openai-responses`. Model strings handed to OpenClaw must
// be prefixed with this id, not "microsoft-foundry/".
const FOUNDRY_OPENCLAW_PROVIDER_ID = "azure-openai-responses";

// Common Foundry deployment ids surfaced in the Nora wizard. OpenClaw's
// custom-provider resolver will accept any deployment name via its catch-all
// path, but listing models here adds metadata (cost, context window, compat)
// that OpenClaw uses for cost tracking and correct request shape. The key
// compat flag is `supportsStore: false` — Azure rejects `store: true`, which
// is OpenClaw's default for Responses API.
const FOUNDRY_DEFAULT_MODELS = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5 (Azure)",
    reasoning: true,
    contextWindow: 400000,
    maxTokens: 16384,
  },
  {
    id: "gpt-5.5-mini",
    name: "GPT-5.5 Mini (Azure)",
    reasoning: true,
    contextWindow: 400000,
    maxTokens: 16384,
  },
  {
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro (Azure)",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex (Azure)",
    reasoning: true,
    contextWindow: 400000,
    maxTokens: 16384,
  },
  { id: "o3", name: "o3 (Azure)", reasoning: true, contextWindow: 200000, maxTokens: 100000 },
];

// Azure deployment names are arbitrary per resource (e.g. "gpt-5.5-1"), so the
// real deployment is supplied via MICROSOFT_FOUNDRY_DEPLOYMENT (sourced from the
// saved provider's model/config). Fall back to the canonical "gpt-5.5" when
// unset so existing single-deployment setups keep working.
const FOUNDRY_FALLBACK_DEPLOYMENT = "gpt-5.5";
const FOUNDRY_MODEL_PROVIDER_PREFIXES = Object.freeze([
  FOUNDRY_OPENCLAW_PROVIDER_ID,
  "microsoft-foundry",
  "openai",
  "openai-responses",
]);

function normalizeFoundryDeployment(value) {
  let deployment = String(value || "").trim();
  for (const providerId of FOUNDRY_MODEL_PROVIDER_PREFIXES) {
    const providerPrefix = `${providerId}/`;
    if (deployment.startsWith(providerPrefix)) {
      deployment = deployment.slice(providerPrefix.length).trim();
      break;
    }
  }
  return deployment && !deployment.includes("/") ? deployment : "";
}

function resolveFoundryDeployment(env = {}) {
  const configured = normalizeFoundryDeployment(
    env.MICROSOFT_FOUNDRY_DEPLOYMENT || env.NORA_DEFAULT_OPENCLAW_MODEL,
  );
  return configured || FOUNDRY_FALLBACK_DEPLOYMENT;
}

// The default model string OpenClaw should boot with for Foundry, e.g.
// "azure-openai-responses/gpt-5.5-1".
function foundryDefaultModel(env = {}) {
  return `${FOUNDRY_OPENCLAW_PROVIDER_ID}/${resolveFoundryDeployment(env)}`;
}

function buildFoundryModelEntries(env = {}) {
  // Ensure the actually-configured deployment is registered even if it isn't
  // one of the well-known ids below — otherwise OpenClaw throws "Unknown model"
  // for the very deployment we set as default.
  const deployment = resolveFoundryDeployment(env);
  const seen = new Set();
  const models = FOUNDRY_DEFAULT_MODELS.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).map((entry) => ({
    id: entry.id,
    name: entry.name,
    api: "azure-openai-responses",
    reasoning: entry.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { supportsStore: false, supportsReasoningEffort: true },
  }));
  if (!deployment || models.some((model) => model.id === deployment)) return models;

  const baseModelId = deployment.replace(/-\d+$/, "");
  const template =
    models.find((model) => model.id === baseModelId) ||
    models.find((model) => model.id === "gpt-5.5") ||
    models[0];
  return [
    {
      ...template,
      id: deployment,
      name: `${deployment} (Azure deployment)`,
    },
    ...models,
  ];
}

// Builds the `models.providers.*` map injected into openclaw.json for
// providers OpenClaw doesn't ship in its native registry. Registering a
// provider here unlocks OpenClaw's custom-provider resolution path so
// `<provider>/<deployment>` model strings resolve instead of throwing
// "Unknown model" (the upstream check at openclaw's resolveModelWithRegistry).
//
// Microsoft Foundry: the underlying inference SDK (`@mariozechner/pi-ai`)
// ships a dedicated `azure-openai-responses` API
// (node_modules/@mariozechner/pi-ai/dist/providers/azure-openai-responses.js)
// that uses `new AzureOpenAI({apiKey, baseURL, apiVersion: "v1"})`. This is
// the right route — the SDK natively sends the `api-key` header that Azure
// requires, so we do NOT need the `authHeader: false` + manual
// `headers["api-key"]` workaround from the Microsoft community blog (which
// routes through the wrong API and forces a workaround).
//
// Required fields:
//   - provider id (key): `azure-openai-responses` — matches pi-ai's API name
//     AND OpenClaw's hardcoded OPENAI_RESPONSES_PROVIDERS allowlist
//   - `api: "azure-openai-responses"` — routes to streamAzureOpenAIResponses
//   - `baseUrl: <per-resource v1 URL, no trailing slash>` — pi-ai's
//     resolveAzureConfig consumes this via `model.baseUrl`
//   - `apiKey: <decrypted key>` — passed to the AzureOpenAI constructor
//   - `models[].compat.supportsStore: false` — Azure rejects `store: true`
//
// The baseUrl + key are required — without them the registration is omitted
// (caller hits the original "Unknown model" error, which correctly signals
// the user to configure the provider before retrying).
function buildOpenClawCustomProviders(env = {}) {
  const providers = {};
  const foundryKey = env.MICROSOFT_FOUNDRY_API_KEY;
  const foundryBaseUrlRaw = env.MICROSOFT_FOUNDRY_BASE_URL;
  if (foundryKey && foundryBaseUrlRaw) {
    // Strip trailing slash to match Azure's documented v1 URL shape
    // (https://<resource>.openai.azure.com/openai/v1 or
    // https://<resource>.cognitiveservices.azure.com/openai/v1).
    const foundryBaseUrl = String(foundryBaseUrlRaw).replace(/\/+$/, "");
    providers[FOUNDRY_OPENCLAW_PROVIDER_ID] = {
      api: "azure-openai-responses",
      baseUrl: foundryBaseUrl,
      apiKey: foundryKey,
      models: buildFoundryModelEntries(env),
    };
  }
  // Nora's zero-key demo provider: an OpenAI-compatible stub served by the
  // control plane itself. The worker injects the derived token plus the
  // in-network base URL (sister env var, same mechanism as Foundry's).
  const demoToken = env.NORA_DEMO_LLM_TOKEN;
  const demoBaseUrl = env.NORA_DEMO_LLM_BASE_URL;
  if (demoToken && demoBaseUrl) {
    providers[DEMO_OPENCLAW_PROVIDER_ID] = {
      api: "openai-completions",
      baseUrl: String(demoBaseUrl).replace(/\/+$/, ""),
      apiKey: demoToken,
      models: [
        {
          id: DEMO_OPENCLAW_MODEL_ID,
          name: "Nora Demo (deterministic stub)",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ],
    };
  }
  return providers;
}

// OpenClaw-side ids for the zero-key demo provider. Distinct from Nora's
// internal "demo" id so a future builtin OpenClaw provider can't collide.
const DEMO_OPENCLAW_PROVIDER_ID = "nora-demo";
const DEMO_OPENCLAW_MODEL_ID = "nora-demo-1";
const OPENCLAW_MANAGED_CUSTOM_PROVIDER_IDS = Object.freeze([
  FOUNDRY_OPENCLAW_PROVIDER_ID,
  DEMO_OPENCLAW_PROVIDER_ID,
]);

// Maps Nora's internal LLM provider id to the OpenClaw provider id that
// must appear in model strings (e.g. `<provider>/<deployment>`). Only Foundry
// and the demo stub need translation; everything else passes through unchanged.
const NORA_TO_OPENCLAW_PROVIDER_ID = Object.freeze({
  "microsoft-foundry": FOUNDRY_OPENCLAW_PROVIDER_ID,
  demo: DEMO_OPENCLAW_PROVIDER_ID,
});

// Nora reserves `<provider>:default` for profiles projected from its provider
// catalog. Other profile ids (for example `<provider>:manual`) belong to the
// operator and must survive managed-state reconciliation.
const OPENCLAW_MANAGED_AUTH_PROVIDER_IDS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
  "deepseek",
  "openrouter",
  "together",
  "cohere",
  "xai",
  "moonshot",
  "zai",
  "ollama",
  "minimax",
  "github-copilot",
  "huggingface",
  "cerebras",
  "nvidia",
  "microsoft-foundry",
  FOUNDRY_OPENCLAW_PROVIDER_ID,
  "demo",
  DEMO_OPENCLAW_PROVIDER_ID,
]);

function mapNoraProviderIdToOpenClaw(noraProviderId) {
  if (!noraProviderId) return noraProviderId;
  return NORA_TO_OPENCLAW_PROVIDER_ID[noraProviderId] || noraProviderId;
}

function buildOpenClawModelForProvider(noraProviderId, modelId) {
  const providerId = String(noraProviderId || "").trim();
  const rawModelId = String(modelId || "").trim();
  if (!providerId || !rawModelId) return null;

  if (providerId === "microsoft-foundry") {
    const deployment = normalizeFoundryDeployment(rawModelId);
    return deployment ? `${FOUNDRY_OPENCLAW_PROVIDER_ID}/${deployment}` : null;
  }

  const openclawProvider = mapNoraProviderIdToOpenClaw(providerId);
  return rawModelId.includes("/") ? rawModelId : `${openclawProvider}/${rawModelId}`;
}

// OpenClaw ≥2026.6 resolves embedded-agent auth exclusively from the
// per-agent SQLite store — the inline `apiKey` on a custom provider in
// openclaw.json is not consulted for agent turns. Custom-provider profiles
// therefore MUST be imported too, translated to the OpenClaw provider id
// they are registered under (skipping them leaves the store empty and every
// turn fails with missing-provider-auth). Their import is best-effort: the
// registration may legitimately be absent (e.g. Foundry key without a base
// URL), and a failed paste must not abort the builtin-provider imports.
const OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES = NORA_TO_OPENCLAW_PROVIDER_ID;
const OPENCLAW_SQLITE_AUTH_BEST_EFFORT_PROVIDERS = Object.freeze([
  ...Object.keys(NORA_TO_OPENCLAW_PROVIDER_ID),
  ...Object.values(NORA_TO_OPENCLAW_PROVIDER_ID),
]);

function remapOpenClawAuthProfileId(profileId, rawProvider, provider) {
  const value = String(profileId || "");
  if (!rawProvider || rawProvider === provider) return value;

  const rawPrefix = `${rawProvider}:`;
  return value.startsWith(rawPrefix) ? `${provider}:${value.slice(rawPrefix.length)}` : value;
}

// OpenClaw 2026.4.x reads auth-profiles.json directly and does not expose the
// non-interactive paste-api-key command. Normalize custom-provider ids in the
// file itself so those releases can resolve credentials without a CLI import;
// newer releases then import the same normalized profiles into their runtime
// auth store below.
function normalizeOpenClawAuthProfiles(authProfiles = {}) {
  const source =
    authProfiles && typeof authProfiles === "object" && !Array.isArray(authProfiles)
      ? authProfiles
      : {};
  const sourceProfiles =
    source.profiles && typeof source.profiles === "object" && !Array.isArray(source.profiles)
      ? source.profiles
      : {};
  const profiles = {};

  for (const [profileId, profile] of Object.entries(sourceProfiles)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      profiles[profileId] = profile;
      continue;
    }
    const rawProvider = String(profile.provider || "").trim();
    const provider = OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES[rawProvider] || rawProvider;
    const normalizedProfileId = remapOpenClawAuthProfileId(profileId, rawProvider, provider);
    profiles[normalizedProfileId] =
      provider && provider !== rawProvider ? { ...profile, provider } : { ...profile };
  }

  const normalized = {
    ...source,
    version: source.version || 1,
    profiles,
  };

  if (source.order && typeof source.order === "object" && !Array.isArray(source.order)) {
    normalized.order = Object.fromEntries(
      Object.entries(source.order).map(([rawProvider, profileIds]) => {
        const provider = OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES[rawProvider] || rawProvider;
        const normalizedProfileIds = Array.isArray(profileIds)
          ? profileIds.map((profileId) =>
              remapOpenClawAuthProfileId(profileId, rawProvider, provider),
            )
          : profileIds;
        return [provider, normalizedProfileIds];
      }),
    );
  }

  if (source.lastGood && typeof source.lastGood === "object" && !Array.isArray(source.lastGood)) {
    normalized.lastGood = Object.fromEntries(
      Object.entries(source.lastGood).map(([rawProvider, profileId]) => {
        const provider = OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES[rawProvider] || rawProvider;
        return [provider, remapOpenClawAuthProfileId(profileId, rawProvider, provider)];
      }),
    );
  }

  return normalized;
}

function normalizeManagedOpenClawAuthProfileId(profileId) {
  const value = String(profileId || "").trim();
  if (!value.endsWith(":default")) return "";

  const rawProvider = value.slice(0, -":default".length).trim();
  if (!rawProvider) return "";

  return `${rawProvider}:default`;
}

function expandManagedOpenClawAuthProfileIds(profileId) {
  const normalizedProfileId = normalizeManagedOpenClawAuthProfileId(profileId);
  if (!normalizedProfileId) return [];

  const rawProvider = normalizedProfileId.slice(0, -":default".length);
  const provider = OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES[rawProvider] || rawProvider;
  const legacyAliasProfileIds = Object.entries(OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES)
    .filter(([, openClawProvider]) => openClawProvider === provider)
    .map(([noraProvider]) => `${noraProvider}:default`);
  return [...new Set([normalizedProfileId, `${provider}:default`, ...legacyAliasProfileIds])];
}

function resolveManagedOpenClawAuthProfileIds(authProfiles = {}, options = {}) {
  const profiles =
    authProfiles.profiles &&
    typeof authProfiles.profiles === "object" &&
    !Array.isArray(authProfiles.profiles)
      ? authProfiles.profiles
      : {};
  const hasExplicitManagedScope =
    Array.isArray(options.managedProfileIds) || Array.isArray(options.managedProviderIds);
  const configuredProfileIds = Array.isArray(options.managedProfileIds)
    ? options.managedProfileIds
    : [];
  const configuredProviderIds = (
    Array.isArray(options.managedProviderIds)
      ? options.managedProviderIds
      : hasExplicitManagedScope
        ? []
        : OPENCLAW_MANAGED_AUTH_PROVIDER_IDS
  ).map((providerId) => `${providerId}:default`);

  return [
    ...new Set(
      [...configuredProfileIds, ...configuredProviderIds, ...Object.keys(profiles)]
        .flatMap(expandManagedOpenClawAuthProfileIds)
        .filter(Boolean),
    ),
  ];
}

function buildOpenClawAuthSqliteReconcileCommand({ authPath, agentDir, managedProfileIds }) {
  const normalizedManagedProfileIds = [
    ...new Set(
      (Array.isArray(managedProfileIds) ? managedProfileIds : [])
        .flatMap(expandManagedOpenClawAuthProfileIds)
        .filter(Boolean),
    ),
  ];
  if (normalizedManagedProfileIds.length === 0) return "";

  return [
    "node <<'__NORA_OPENCLAW_AUTH_SQLITE_RECONCILE__'",
    "const fs = require('fs');",
    "const path = require('path');",
    `const authPath = ${JSON.stringify(authPath)};`,
    `const agentDir = ${JSON.stringify(agentDir)};`,
    `const managedProfileIds = new Set(${JSON.stringify(normalizedManagedProfileIds)});`,
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
    "function parsePayload(raw, label, fallback) {",
    "  if (raw == null) return fallback;",
    "  let parsed;",
    "  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }",
    "  if (!isPlainObject(parsed)) throw new Error(`${label} must contain a JSON object`);",
    "  return parsed;",
    "}",
    "function pruneManagedStateReferences(payload) {",
    "  if (payload.order !== undefined) {",
    "    if (!isPlainObject(payload.order)) throw new Error('OpenClaw auth order must be an object');",
    "    const order = {};",
    "    for (const [provider, profileIds] of Object.entries(payload.order)) {",
    "      if (!Array.isArray(profileIds)) throw new Error(`OpenClaw auth order for ${provider} must be an array`);",
    "      const kept = profileIds.map(String).filter((profileId) => !managedProfileIds.has(profileId));",
    "      if (kept.length > 0) order[provider] = kept;",
    "    }",
    "    if (Object.keys(order).length > 0) payload.order = order;",
    "    else delete payload.order;",
    "  }",
    "  if (payload.lastGood !== undefined) {",
    "    if (!isPlainObject(payload.lastGood)) throw new Error('OpenClaw auth lastGood must be an object');",
    "    const lastGood = Object.fromEntries(",
    "      Object.entries(payload.lastGood).filter(([, profileId]) => !managedProfileIds.has(String(profileId))),",
    "    );",
    "    if (Object.keys(lastGood).length > 0) payload.lastGood = lastGood;",
    "    else delete payload.lastGood;",
    "  }",
    "  if (payload.usageStats !== undefined) {",
    "    if (!isPlainObject(payload.usageStats)) throw new Error('OpenClaw auth usageStats must be an object');",
    "    const usageStats = Object.fromEntries(",
    "      Object.entries(payload.usageStats).filter(([profileId]) => !managedProfileIds.has(profileId)),",
    "    );",
    "    if (Object.keys(usageStats).length > 0) payload.usageStats = usageStats;",
    "    else delete payload.usageStats;",
    "  }",
    "}",
    "function mergeDesiredState(state, auth, desiredProfiles) {",
    "  if (isPlainObject(auth.order)) {",
    "    for (const [provider, profileIds] of Object.entries(auth.order)) {",
    "      if (!Array.isArray(profileIds)) continue;",
    "      const desired = profileIds",
    "        .map(String)",
    "        .filter((profileId) => managedProfileIds.has(profileId) && desiredProfiles[profileId]);",
    "      if (desired.length === 0) continue;",
    "      const existing = Array.isArray(state.order?.[provider]) ? state.order[provider] : [];",
    "      state.order = state.order || {};",
    "      state.order[provider] = [...new Set([...desired, ...existing])];",
    "    }",
    "  }",
    "  if (isPlainObject(auth.lastGood)) {",
    "    for (const [provider, profileIdValue] of Object.entries(auth.lastGood)) {",
    "      const profileId = String(profileIdValue);",
    "      if (!managedProfileIds.has(profileId) || !desiredProfiles[profileId]) continue;",
    "      state.lastGood = state.lastGood || {};",
    "      if (!state.lastGood[provider]) state.lastGood[provider] = profileId;",
    "    }",
    "  }",
    "}",
    "const databasePath = path.join(agentDir, 'openclaw-agent.sqlite');",
    "let DatabaseSync;",
    "try { ({ DatabaseSync } = require('node:sqlite')); } catch (error) {",
    "  if (fs.existsSync(databasePath)) throw new Error(`Existing OpenClaw SQLite auth store cannot be reconciled because node:sqlite is unavailable: ${error.message}`);",
    "  process.stderr.write('node:sqlite unavailable and no SQLite auth store exists; using normalized auth-profiles.json fallback\\n');",
    "  process.exit(0);",
    "}",
    "if (!fs.existsSync(databasePath)) process.exit(0);",
    "const auth = parsePayload(fs.readFileSync(authPath, 'utf8'), 'Nora auth profile file', {});",
    "const sourceProfiles = isPlainObject(auth.profiles) ? auth.profiles : {};",
    "const desiredProfiles = Object.fromEntries(",
    "  Object.entries(sourceProfiles).filter(([profileId, profile]) => managedProfileIds.has(profileId) && isPlainObject(profile)),",
    ");",
    "const database = new DatabaseSync(databasePath);",
    "try {",
    "  database.exec('PRAGMA busy_timeout = 15000;');",
    "  const tables = new Set(",
    "    database",
    "      .prepare(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_profile_store', 'auth_profile_state')\")",
    "      .all()",
    "      .map((row) => row.name),",
    "  );",
    "  if (!tables.has('auth_profile_store') || !tables.has('auth_profile_state')) {",
    "    throw new Error('Existing OpenClaw SQLite auth schema is missing the managed auth tables');",
    "  }",
    "  database.exec('BEGIN IMMEDIATE;');",
    "  try {",
    "    const storeRow = database",
    "      .prepare(\"SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'\")",
    "      .get();",
    "    const stateRow = database",
    "      .prepare(\"SELECT state_json FROM auth_profile_state WHERE state_key = 'primary'\")",
    "      .get();",
    "    const store = parsePayload(storeRow?.store_json, 'OpenClaw auth profile store', { version: 1, profiles: {} });",
    "    const state = parsePayload(stateRow?.state_json, 'OpenClaw auth profile state', { version: 1 });",
    "    if (!isPlainObject(store.profiles)) throw new Error('OpenClaw auth profile store profiles must be an object');",
    "    const profiles = { ...store.profiles };",
    "    for (const profileId of managedProfileIds) delete profiles[profileId];",
    "    Object.assign(profiles, desiredProfiles);",
    "    store.version = Number(store.version) > 0 ? Number(store.version) : 1;",
    "    store.profiles = profiles;",
    "    pruneManagedStateReferences(store);",
    "    pruneManagedStateReferences(state);",
    "    mergeDesiredState(state, auth, desiredProfiles);",
    "    const now = Date.now();",
    "    if (storeRow || Object.keys(desiredProfiles).length > 0) {",
    "      database",
    "        .prepare(\"INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES ('primary', ?, ?) ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at\")",
    "        .run(JSON.stringify(store), now);",
    "    }",
    "    const stateKeys = Object.keys(state).filter((key) => key !== 'version');",
    "    if (stateKeys.length > 0) {",
    "      state.version = Number(state.version) > 0 ? Number(state.version) : 1;",
    "      database",
    "        .prepare(\"INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at\")",
    "        .run(JSON.stringify(state), now);",
    "    } else if (stateRow) {",
    "      database.prepare(\"DELETE FROM auth_profile_state WHERE state_key = 'primary'\").run();",
    "    }",
    "    database.exec('COMMIT;');",
    "  } catch (error) {",
    "    try { database.exec('ROLLBACK;'); } catch {}",
    "    throw error;",
    "  }",
    "} finally {",
    "  database.close();",
    "}",
    "__NORA_OPENCLAW_AUTH_SQLITE_RECONCILE__",
  ].join("\n");
}

function buildOpenClawAuthImportFromFileCommand(options = {}) {
  const authPath = options.authPath || OPENCLAW_AUTH_PROFILES_PATH;
  const agentDir = options.agentDir || authPath.slice(0, authPath.lastIndexOf("/")) || ".";
  const agentId = options.agentId || "main";
  const requireCli = options.requireCli === true;
  const managedProfileIds = resolveManagedOpenClawAuthProfileIds({}, options);

  return [
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
    requireCli
      ? '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] || exit 127'
      : 'if [ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]; then',
    "export HOME=/root",
    "export OPENCLAW_BIN",
    "node <<'__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__'",
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    `const authPath = ${JSON.stringify(authPath)};`,
    `const agentId = ${JSON.stringify(agentId)};`,
    `const providerAliases = ${JSON.stringify(OPENCLAW_SQLITE_AUTH_PROVIDER_ALIASES)};`,
    `const bestEffortProviders = new Set(${JSON.stringify(OPENCLAW_SQLITE_AUTH_BEST_EFFORT_PROVIDERS)});`,
    "let auth = {};",
    "try { auth = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { process.exit(0); }",
    "const profiles = auth && auth.profiles && typeof auth.profiles === 'object' ? auth.profiles : {};",
    "for (const [profileId, profile] of Object.entries(profiles)) {",
    "  if (!profile || profile.type !== 'api_key' || !profile.key) continue;",
    "  const rawProvider = String(profile.provider || '').trim();",
    "  if (!rawProvider) continue;",
    "  const provider = providerAliases[rawProvider] || rawProvider;",
    "  const importProfileId = provider === rawProvider",
    "    ? String(profileId)",
    "    : String(profileId).replace(`${rawProvider}:`, `${provider}:`);",
    "  const result = spawnSync(process.env.OPENCLAW_BIN, [",
    "    'models',",
    "    'auth',",
    "    '--agent',",
    "    agentId,",
    "    'paste-api-key',",
    "    '--provider',",
    "    provider,",
    "    '--profile-id',",
    "    importProfileId,",
    "  ], {",
    "    input: `${String(profile.key)}\\n`,",
    "    encoding: 'utf8',",
    "    stdio: ['pipe', 'pipe', 'pipe'],",
    "    env: process.env,",
    "  });",
    "  const output = `${result.stderr || ''}\\n${result.stdout || ''}`;",
    "  if (result.status !== 0 && /unknown (?:command|option)|not a command/i.test(output)) {",
    "    process.stderr.write(`auth CLI import unavailable for ${provider}; using normalized auth-profiles.json\\n`);",
    "    continue;",
    "  }",
    "  if (result.status !== 0) {",
    "    if (result.stderr) process.stderr.write(result.stderr);",
    "    if (result.stdout) process.stderr.write(result.stdout);",
    "    if (bestEffortProviders.has(provider)) {",
    "      process.stderr.write(`auth import skipped for ${provider} (custom provider not registered?)\\n`);",
    "      continue;",
    "    }",
    "    process.exit(result.status || 1);",
    "  }",
    "}",
    "__NORA_OPENCLAW_AUTH_SQLITE_IMPORT__",
    requireCli ? "" : "fi",
    buildOpenClawAuthSqliteReconcileCommand({
      authPath,
      agentDir,
      managedProfileIds,
    }),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildOpenClawAuthProfilesWriteCommand(authProfiles, options = {}) {
  const authPath = options.authPath || OPENCLAW_AUTH_PROFILES_PATH;
  const authDir = authPath.slice(0, authPath.lastIndexOf("/")) || ".";
  const normalizedAuthProfiles = normalizeOpenClawAuthProfiles(authProfiles);
  const managedProfileIds = resolveManagedOpenClawAuthProfileIds(normalizedAuthProfiles, options);
  const authJsonB64 = Buffer.from(JSON.stringify(normalizedAuthProfiles)).toString("base64");

  return [
    "set -eu",
    `mkdir -p ${shellSingleQuote(authDir)}`,
    `printf '%s' '${authJsonB64}' | base64 -d > ${shellSingleQuote(authPath)}`,
    `chmod 0600 ${shellSingleQuote(authPath)}`,
    buildOpenClawAuthImportFromFileCommand({
      ...options,
      authPath,
      agentDir: options.agentDir || authDir,
      managedProfileIds,
    }),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildOpenClawConfigMergeScript(gatewayConfig) {
  return [
    "cat <<'__NORA_MANAGED_OPENCLAW_CONFIG__' > /tmp/nora-managed-openclaw.json",
    JSON.stringify(gatewayConfig || {}, null, 2),
    "__NORA_MANAGED_OPENCLAW_CONFIG__",
    "node <<'__NORA_MERGE_OPENCLAW_CONFIG__'",
    "const fs = require('fs');",
    "const path = require('path');",
    "const configPath = '/root/.openclaw/openclaw.json';",
    "const managedPath = '/tmp/nora-managed-openclaw.json';",
    "function isPlainObject(value) {",
    "  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);",
    "}",
    "function mergeConfig(current, managed) {",
    "  if (!isPlainObject(managed)) return managed;",
    "  const next = isPlainObject(current) ? { ...current } : {};",
    "  for (const [key, value] of Object.entries(managed)) {",
    "    next[key] = isPlainObject(value) ? mergeConfig(next[key], value) : value;",
    "  }",
    "  return next;",
    "}",
    "let current = {};",
    "try {",
    "  if (fs.existsSync(configPath)) {",
    "    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "  }",
    "} catch {",
    "  current = {};",
    "}",
    "const managed = JSON.parse(fs.readFileSync(managedPath, 'utf8'));",
    "const next = mergeConfig(current, managed);",
    "fs.mkdirSync(path.dirname(configPath), { recursive: true });",
    "fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\\n');",
    "fs.chmodSync(configPath, 0o600);",
    "__NORA_MERGE_OPENCLAW_CONFIG__",
    "rm -f /tmp/nora-managed-openclaw.json",
  ];
}

// Sync-time variant: returns a single shell command string suitable for
// runRuntimeCommand / docker exec that merges the given openclaw.json
// delta on a running container without restarting. Reuses the same
// merge semantics as the boot-time script so both paths agree.
function buildOpenClawConfigMergeCommand(configDelta) {
  return buildOpenClawConfigMergeScript(configDelta).join("\n");
}

// Default-model apply for sync flows. Deliberately NOT `openclaw models set`:
// OpenClaw ≥2026.6 canonicalizes the model ref against its builtin catalog,
// rewriting `azure-openai-responses/<deployment>` to `openai/<deployment>` —
// a provider the agent holds no credentials for. Writing the value straight
// into openclaw.json (the same shape the boot scripts use) keeps the
// custom-provider prefix intact; the gateway re-reads it on restart or via
// its config watcher.
function buildOpenClawDefaultModelCommand(fullModel) {
  const model = String(fullModel || "").trim();
  if (!model) return null;
  return buildOpenClawConfigMergeCommand({
    agents: { defaults: { model: { primary: model }, models: { [model]: {} } } },
  });
}

function buildOpenClawManagedCustomProvidersCommand(customProviders = {}, options = {}) {
  const configPath = options.configPath || "/root/.openclaw/openclaw.json";
  const managedProviderIds = [
    ...new Set(
      (Array.isArray(options.managedProviderIds)
        ? options.managedProviderIds
        : OPENCLAW_MANAGED_CUSTOM_PROVIDER_IDS
      )
        .map((providerId) => String(providerId || "").trim())
        .filter(Boolean),
    ),
  ];
  const managedProviderIdSet = new Set(managedProviderIds);
  const desiredProviders = Object.fromEntries(
    Object.entries(
      customProviders && typeof customProviders === "object" && !Array.isArray(customProviders)
        ? customProviders
        : {},
    ).filter(([providerId]) => managedProviderIdSet.has(providerId)),
  );

  return [
    "set -eu",
    "node <<'__NORA_RECONCILE_OPENCLAW_CUSTOM_PROVIDERS__'",
    "const fs = require('fs');",
    "const path = require('path');",
    `const configPath = ${JSON.stringify(configPath)};`,
    `const managedProviderIds = new Set(${JSON.stringify(managedProviderIds)});`,
    `const desiredProviders = ${JSON.stringify(desiredProviders)};`,
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
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
    "if (current.models !== undefined && !isPlainObject(current.models)) {",
    "  throw new Error('OpenClaw models config must be an object');",
    "}",
    "const models = { ...(current.models || {}) };",
    "if (models.providers !== undefined && !isPlainObject(models.providers)) {",
    "  throw new Error('OpenClaw custom providers config must be an object');",
    "}",
    "const providers = { ...(models.providers || {}) };",
    "for (const providerId of managedProviderIds) delete providers[providerId];",
    "for (const [providerId, providerConfig] of Object.entries(desiredProviders)) {",
    "  if (managedProviderIds.has(providerId)) providers[providerId] = providerConfig;",
    "}",
    "if (Object.keys(providers).length > 0) models.providers = providers;",
    "else delete models.providers;",
    "if (Object.keys(models).length > 0) current.models = models;",
    "else delete current.models;",
    "writeConfig(current);",
    "__NORA_RECONCILE_OPENCLAW_CUSTOM_PROVIDERS__",
  ].join("\n");
}

function buildOpenClawManagedDefaultModelCommand(fullModel, options = {}) {
  const desiredDefaultModel = String(fullModel || "").trim();
  const configPath = options.configPath || "/root/.openclaw/openclaw.json";
  const markerPath = options.markerPath || "/root/.openclaw/.nora-managed-default-model";
  const desiredProviderId = desiredDefaultModel.split("/", 1)[0] || "";
  const managedProviderIds = [
    ...new Set(
      [
        ...(Array.isArray(options.managedProviderIds)
          ? options.managedProviderIds
          : OPENCLAW_MANAGED_AUTH_PROVIDER_IDS),
        desiredProviderId,
      ]
        .map((providerId) => String(providerId || "").trim())
        .filter(Boolean),
    ),
  ];

  return [
    "set -eu",
    "node <<'__NORA_RECONCILE_OPENCLAW_DEFAULT_MODEL__'",
    "const fs = require('fs');",
    "const path = require('path');",
    `const configPath = ${JSON.stringify(configPath)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const desiredDefaultModel = ${JSON.stringify(desiredDefaultModel)};`,
    `const managedProviderIds = new Set(${JSON.stringify(managedProviderIds)});`,
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
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
    "function readOptionalObject(value, label) {",
    "  if (value === undefined) return {};",
    "  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);",
    "  return { ...value };",
    "}",
    "function deleteIfEmpty(parent, key) {",
    "  if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];",
    "}",
    "const current = readConfig();",
    "const agents = readOptionalObject(current.agents, 'OpenClaw agents config');",
    "const defaults = readOptionalObject(agents.defaults, 'OpenClaw agent defaults config');",
    "const model = readOptionalObject(defaults.model, 'OpenClaw default model config');",
    "const models = readOptionalObject(defaults.models, 'OpenClaw allowed models config');",
    "const currentPrimary = String(model.primary || '').trim();",
    "let previousManagedModel = '';",
    "try { previousManagedModel = String(fs.readFileSync(markerPath, 'utf8') || '').trim(); } catch {}",
    "if (previousManagedModel) delete models[previousManagedModel];",
    "if (desiredDefaultModel) {",
    "  model.primary = desiredDefaultModel;",
    "  if (!isPlainObject(models[desiredDefaultModel])) models[desiredDefaultModel] = {};",
    "} else if (previousManagedModel && currentPrimary === previousManagedModel) {",
    "  delete model.primary;",
    "}",
    "if (Object.keys(model).length > 0) defaults.model = model;",
    "else delete defaults.model;",
    "if (Object.keys(models).length > 0) defaults.models = models;",
    "else delete defaults.models;",
    "if (Object.keys(defaults).length > 0) agents.defaults = defaults;",
    "else delete agents.defaults;",
    "if (Object.keys(agents).length > 0) current.agents = agents;",
    "else delete current.agents;",
    "deleteIfEmpty(current, 'agents');",
    "writeConfig(current);",
    "if (desiredDefaultModel) {",
    "  fs.mkdirSync(path.dirname(markerPath), { recursive: true });",
    "  fs.writeFileSync(markerPath, desiredDefaultModel + '\\n');",
    "  fs.chmodSync(markerPath, 0o600);",
    "} else {",
    "  try { fs.rmSync(markerPath, { force: true }); } catch {}",
    "}",
    "__NORA_RECONCILE_OPENCLAW_DEFAULT_MODEL__",
  ].join("\n");
}

function buildOpenClawManagedProviderStateCommand({
  customProviders = {},
  defaultModel = null,
  managedProviderIds = [FOUNDRY_OPENCLAW_PROVIDER_ID, DEMO_OPENCLAW_PROVIDER_ID],
  managedModelProviderIds = OPENCLAW_MANAGED_AUTH_PROVIDER_IDS,
  configPath = "/root/.openclaw/openclaw.json",
  markerPath = "/root/.openclaw/.nora-managed-default-model",
} = {}) {
  return [
    buildOpenClawManagedCustomProvidersCommand(customProviders, {
      configPath,
      managedProviderIds,
    }),
    buildOpenClawManagedDefaultModelCommand(defaultModel, {
      configPath,
      markerPath,
      managedProviderIds: managedModelProviderIds,
    }),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildOpenClawManagedConfigEnvPruneCommand(managedNames = [], options = {}) {
  const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const normalizedManagedNames = [
    ...new Set(
      (Array.isArray(managedNames) ? managedNames : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    ),
  ].sort();
  for (const name of normalizedManagedNames) {
    if (!envNamePattern.test(name)) {
      throw new Error(`Invalid managed OpenClaw config env name: ${name}`);
    }
  }
  const managedStateEnvName = String(options.managedStateEnvName || "").trim();
  if (managedStateEnvName && !envNamePattern.test(managedStateEnvName)) {
    throw new Error(`Invalid managed OpenClaw state env name: ${managedStateEnvName}`);
  }
  const configPath = String(options.configPath || "").trim();
  const defaultHome = String(options.defaultHome || "/root");

  return [
    "set -eu",
    "node <<'__NORA_PRUNE_MANAGED_OPENCLAW_CONFIG_ENV__'",
    "const fs = require('fs');",
    "const path = require('path');",
    `const configuredNames = ${JSON.stringify(normalizedManagedNames)};`,
    `const managedStateEnvName = ${JSON.stringify(managedStateEnvName)};`,
    configPath
      ? `const configPath = ${JSON.stringify(configPath)};`
      : `const configPath = path.join(String(process.env.HOME || ${JSON.stringify(defaultHome)}), '.openclaw', 'openclaw.json');`,
    "const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;",
    "const managedNames = new Set(configuredNames);",
    "if (managedStateEnvName) {",
    "  const encoded = String(process.env[managedStateEnvName] || '');",
    "  if (encoded) {",
    "    let state;",
    "    try { state = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch (error) { throw new Error(`Invalid managed OpenClaw state: ${error.message}`); }",
    "    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Managed OpenClaw state must be an object');",
    "    if (!Array.isArray(state.managedNames)) throw new Error('Managed OpenClaw state names must be an array');",
    "    for (const name of state.managedNames) managedNames.add(String(name || '').trim());",
    "  }",
    "}",
    "for (const name of managedNames) { if (!validName.test(name)) throw new Error(`Invalid managed OpenClaw config env name: ${name}`); }",
    "if (managedNames.size === 0 || !fs.existsSync(configPath)) process.exit(0);",
    "let config;",
    "try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (error) { throw new Error(`OpenClaw config is not valid JSON: ${error.message}`); }",
    "if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OpenClaw config must contain a JSON object');",
    "if (config.env === undefined) process.exit(0);",
    "if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) throw new Error('OpenClaw config env must contain a JSON object');",
    "let changed = false;",
    "for (const name of managedNames) { if (Object.prototype.hasOwnProperty.call(config.env, name)) { delete config.env[name]; changed = true; } }",
    "if (!changed) process.exit(0);",
    "if (Object.keys(config.env).length === 0) delete config.env;",
    "fs.mkdirSync(path.dirname(configPath), { recursive: true });",
    "const temporaryPath = `${configPath}.nora-${process.pid}-${Date.now()}.tmp`;",
    "try {",
    "  fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 });",
    "  fs.chmodSync(temporaryPath, 0o600);",
    "  fs.renameSync(temporaryPath, configPath);",
    "} finally { try { fs.rmSync(temporaryPath, { force: true }); } catch {} }",
    "__NORA_PRUNE_MANAGED_OPENCLAW_CONFIG_ENV__",
  ].join("\n");
}

function sanitizeManagedMcpServers(desiredServers = {}) {
  if (!desiredServers || typeof desiredServers !== "object" || Array.isArray(desiredServers)) {
    return {};
  }
  const sanitized = {};
  for (const [rawName, rawServer] of Object.entries(desiredServers)) {
    const name = String(rawName || "").trim();
    if (!name || !rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    const command = String(rawServer.command || "").trim();
    if (!command) continue;
    sanitized[name] = {
      command,
      args: (Array.isArray(rawServer.args) ? rawServer.args : []).map((value) => String(value)),
    };
  }
  return sanitized;
}

const OPENCLAW_MANAGED_MCP_SERVERS_ENV = "NORA_MANAGED_MCP_SERVERS_B64";

function encodeOpenClawManagedMcpServers(desiredServers = {}) {
  return Buffer.from(JSON.stringify(sanitizeManagedMcpServers(desiredServers)), "utf8").toString(
    "base64",
  );
}

function decodeOpenClawManagedMcpServers(encoded = "") {
  if (!encoded) return {};
  try {
    return sanitizeManagedMcpServers(
      JSON.parse(Buffer.from(String(encoded), "base64").toString("utf8")),
    );
  } catch {
    throw new Error("Invalid managed MCP server configuration");
  }
}

function buildOpenClawManagedMcpServersCommand(desiredServers = {}, options = {}) {
  const configPath = options.configPath || "/root/.openclaw/openclaw.json";
  const sanitizedServers = sanitizeManagedMcpServers(desiredServers);
  return [
    "set -eu",
    "node <<'__NORA_RECONCILE_OPENCLAW_MCP_SERVERS__'",
    "const fs = require('fs');",
    "const path = require('path');",
    `const configPath = ${JSON.stringify(configPath)};`,
    `const desiredServers = ${JSON.stringify(sanitizedServers)};`,
    "function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }",
    "let config = {};",
    "try {",
    "  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "} catch { config = {}; }",
    "if (!isPlainObject(config)) throw new Error('OpenClaw config must contain a JSON object');",
    "if (Object.keys(desiredServers).length > 0) config.mcpServers = desiredServers;",
    "else delete config.mcpServers;",
    "fs.mkdirSync(path.dirname(configPath), { recursive: true });",
    "const temporaryPath = `${configPath}.nora-${process.pid}-${Date.now()}.tmp`;",
    "try {",
    "  fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 });",
    "  fs.chmodSync(temporaryPath, 0o600);",
    "  fs.renameSync(temporaryPath, configPath);",
    "} finally { try { fs.rmSync(temporaryPath, { force: true }); } catch {} }",
    "__NORA_RECONCILE_OPENCLAW_MCP_SERVERS__",
  ].join("\n");
}

// buildMcpServersConfig lives in its own dependency-free module so it can be
// unit-tested without loading the rest of the bootstrap; re-exported here for
// the worker/adapter consumers that already import from runtimeBootstrap.
const {
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServerEnvAlias,
  buildMcpServersConfig,
} = require("./mcpServersConfig");

function buildRuntimeBootstrapCommand() {
  return [
    "mkdir -p /opt/openclaw-runtime/lib /var/log && ",
    ...RUNTIME_FILES.map(
      ({ relPath, sourceB64 }) =>
        `printf '%s' '${sourceB64}' | base64 -d > /opt/openclaw-runtime/lib/${relPath} && `,
    ),
    `printf '%s' '${INTEGRATION_TOOL_WRAPPER_B64}' | base64 -d > /usr/local/bin/${NORA_INTEGRATION_TOOL_COMMAND} && `,
    `chmod 755 /usr/local/bin/${NORA_INTEGRATION_TOOL_COMMAND} && `,
    `printf '%s' '${MCP_SERVER_WRAPPER_B64}' | base64 -d > /usr/local/bin/nora-mcp-server && `,
    "chmod 755 /usr/local/bin/nora-mcp-server && ",
    "touch /var/log/openclaw-agent.log && ",
    'TSX_BIN="${OPENCLAW_TSX_BIN:-$(command -v tsx 2>/dev/null || true)}"; [ -n "$TSX_BIN" ] || TSX_BIN="tsx"; "$TSX_BIN" /opt/openclaw-runtime/lib/agent.ts >> /var/log/openclaw-agent.log 2>&1 & ',
  ].join("");
}

function buildOpenClawInstallCommand(packages = [DEFAULT_OPENCLAW_PACKAGE_SPEC]) {
  const normalizedPackages = (Array.isArray(packages) ? packages : [packages])
    .map((pkg) => String(pkg || "").trim())
    .filter(Boolean);

  if (normalizedPackages.length === 0) {
    throw new Error("buildOpenClawInstallCommand requires at least one package");
  }

  const invalidPackage = normalizedPackages.find((pkg) => !/^[a-zA-Z0-9@._+/-]+$/.test(pkg));
  if (invalidPackage) {
    throw new Error(`Invalid package spec: ${invalidPackage}`);
  }

  const packageList = [...normalizedPackages, TSX_PACKAGE_SPEC].join(" ");
  const exactOpenClawVersion = normalizedPackages
    .map((pkg) => pkg.match(/^openclaw@(\d{4}\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/)?.[1] || "")
    .find(Boolean);

  return [
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"; ',
    'OPENCLAW_TSX_BIN="${OPENCLAW_TSX_BIN:-/usr/local/bin/tsx}"; ',
    'DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; ',
    'DETECTED_OPENCLAW_TSX_BIN="$(command -v tsx 2>/dev/null || true)"; ',
    'if [ -n "$DETECTED_OPENCLAW_BIN" ] && [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$DETECTED_OPENCLAW_BIN"; fi; ',
    'if [ -n "$DETECTED_OPENCLAW_TSX_BIN" ] && [ ! -x "$OPENCLAW_TSX_BIN" ]; then OPENCLAW_TSX_BIN="$DETECTED_OPENCLAW_TSX_BIN"; fi; ',
    `EXPECTED_OPENCLAW_VERSION=${shellSingleQuote(exactOpenClawVersion || "")}; `,
    'OPENCLAW_VERSION_OUTPUT=""; OPENCLAW_VERSION_OK=1; ',
    'if [ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]; then OPENCLAW_VERSION_OUTPUT="$("$OPENCLAW_BIN" --version 2>/dev/null || true)"; fi; ',
    'if [ -n "$EXPECTED_OPENCLAW_VERSION" ]; then case "$OPENCLAW_VERSION_OUTPUT" in "OpenClaw $EXPECTED_OPENCLAW_VERSION"|"OpenClaw $EXPECTED_OPENCLAW_VERSION "*) ;; *) OPENCLAW_VERSION_OK=0;; esac; fi; ',
    'if ([ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] && [ "$OPENCLAW_VERSION_OK" = 1 ]) && ([ -n "$OPENCLAW_TSX_BIN" ] && [ -x "$OPENCLAW_TSX_BIN" ] && "$OPENCLAW_TSX_BIN" --version >/dev/null 2>&1); then ',
    "  true; ",
    "else ",
    '  rm -f "${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"; ',
    '  rm -f "${OPENCLAW_TSX_BIN:-/usr/local/bin/tsx}"; ',
    "  rm -rf /usr/local/lib/node_modules/openclaw; ",
    "  rm -rf /usr/local/lib/node_modules/tsx; ",
    "  npm uninstall -g openclaw tsx >/dev/null 2>&1 || true; ",
    "  (apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 || true); ",
    `  if ! npm install -g ${packageList} >/tmp/openclaw-install.log 2>&1; then cat /tmp/openclaw-install.log >&2; exit 1; fi; `,
    "  hash -r 2>/dev/null || true; ",
    '  DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; ',
    '  DETECTED_OPENCLAW_TSX_BIN="$(command -v tsx 2>/dev/null || true)"; ',
    '  if [ -n "${OPENCLAW_CLI_PATH:-}" ] && [ -n "$DETECTED_OPENCLAW_BIN" ] && [ "$DETECTED_OPENCLAW_BIN" != "$OPENCLAW_CLI_PATH" ]; then ',
    '    ln -sf "$DETECTED_OPENCLAW_BIN" "$OPENCLAW_CLI_PATH"; ',
    '    OPENCLAW_BIN="$OPENCLAW_CLI_PATH"; ',
    "  else ",
    '    OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-$DETECTED_OPENCLAW_BIN}"; ',
    "  fi; ",
    '  if [ -n "${OPENCLAW_TSX_BIN:-}" ] && [ -n "$DETECTED_OPENCLAW_TSX_BIN" ] && [ "$DETECTED_OPENCLAW_TSX_BIN" != "$OPENCLAW_TSX_BIN" ]; then ',
    '    ln -sf "$DETECTED_OPENCLAW_TSX_BIN" "$OPENCLAW_TSX_BIN"; ',
    '    OPENCLAW_TSX_BIN="${OPENCLAW_TSX_BIN:-$DETECTED_OPENCLAW_TSX_BIN}"; ',
    "  else ",
    '    OPENCLAW_TSX_BIN="${OPENCLAW_TSX_BIN:-$DETECTED_OPENCLAW_TSX_BIN}"; ',
    "  fi; ",
    '  if ! ([ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] && "$OPENCLAW_BIN" --version >/dev/null 2>&1); then cat /tmp/openclaw-install.log >&2; exit 1; fi; ',
    '  if [ -n "$EXPECTED_OPENCLAW_VERSION" ]; then OPENCLAW_VERSION_OUTPUT="$("$OPENCLAW_BIN" --version 2>/dev/null || true)"; case "$OPENCLAW_VERSION_OUTPUT" in "OpenClaw $EXPECTED_OPENCLAW_VERSION"|"OpenClaw $EXPECTED_OPENCLAW_VERSION "*) ;; *) cat /tmp/openclaw-install.log >&2; echo "Installed OpenClaw version does not match $EXPECTED_OPENCLAW_VERSION" >&2; exit 1;; esac; fi; ',
    '  if ! ([ -n "$OPENCLAW_TSX_BIN" ] && [ -x "$OPENCLAW_TSX_BIN" ] && "$OPENCLAW_TSX_BIN" --version >/dev/null 2>&1); then cat /tmp/openclaw-install.log >&2; exit 1; fi; ',
    "fi; ",
    'export OPENCLAW_CLI_PATH="$OPENCLAW_BIN"; ',
    'export OPENCLAW_TSX_BIN="$OPENCLAW_TSX_BIN"; ',
    "true && ",
  ].join("");
}

function buildRuntimeEnv() {
  const env = {
    AGENT_HTTP_PORT: String(AGENT_RUNTIME_PORT),
    OPENCLAW_GATEWAY_PORT: String(OPENCLAW_GATEWAY_PORT),
    // Nora reaches managed gateways through recorded endpoints; mDNS is noisy
    // in container networks.
    OPENCLAW_DISABLE_BONJOUR: process.env.OPENCLAW_DISABLE_BONJOUR || "1",
    BACKEND_API_URL:
      process.env.AGENT_RUNTIME_BACKEND_API_URL ||
      process.env.BACKEND_API_URL ||
      "http://backend-api:4000",
  };
  // Only forward OPENCLAW_CLI_PATH / OPENCLAW_TSX_BIN if the worker process
  // has them explicitly set — do NOT inject a default. The agent base image
  // sets these via `ENV` (see agent-runtime/Dockerfile.{openclaw,nemoclaw}-agent)
  // and different images install the binaries in different prefixes (the
  // OpenShell sandbox uses `/usr/bin`, the Nora OpenClaw image uses
  // `/usr/local/bin`). Blindly defaulting to `/usr/local/bin/openclaw` makes
  // the bootstrap fast-path check miss on the NemoClaw sandbox and fall
  // into the install branch, which then fails under the sandbox's UID-998
  // Landlock restrictions.
  if (process.env.OPENCLAW_CLI_PATH) {
    env.OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH;
  }
  if (process.env.OPENCLAW_TSX_BIN) {
    env.OPENCLAW_TSX_BIN = process.env.OPENCLAW_TSX_BIN;
  }
  return env;
}

module.exports = {
  NORA_INTEGRATIONS_CONTEXT_FILE,
  NORA_INTEGRATIONS_PROMPT_BEGIN,
  NORA_INTEGRATIONS_PROMPT_END,
  OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
  OPENCLAW_WORKSPACE_ROOT,
  buildIntegrationPromptPointerMarkdown,
  buildOpenClawInstallCommand,
  buildRuntimeBootstrapCommand,
  buildRuntimeBootstrapFiles,
  buildIntegrationToolWrapperScript,
  buildMcpServerWrapperScript,
  buildOpenClawGatewayPairingCommand,
  buildOpenClawConfigMergeScript,
  buildOpenClawConfigMergeCommand,
  buildOpenClawDefaultModelCommand,
  buildOpenClawManagedCustomProvidersCommand,
  buildOpenClawManagedDefaultModelCommand,
  buildOpenClawManagedProviderStateCommand,
  buildOpenClawManagedConfigEnvPruneCommand,
  buildOpenClawManagedMcpServersCommand,
  OPENCLAW_MANAGED_MCP_SERVERS_ENV,
  encodeOpenClawManagedMcpServers,
  decodeOpenClawManagedMcpServers,
  buildOpenClawAuthImportFromFileCommand,
  buildOpenClawAuthProfilesWriteCommand,
  buildMcpServersConfig,
  buildMcpManagedEnv,
  buildMcpManagedEnvNames,
  buildMcpServerEnvAlias,
  buildOpenClawCustomProviders,
  mapNoraProviderIdToOpenClaw,
  buildOpenClawModelForProvider,
  FOUNDRY_OPENCLAW_PROVIDER_ID,
  DEMO_OPENCLAW_PROVIDER_ID,
  DEMO_OPENCLAW_MODEL_ID,
  resolveFoundryDeployment,
  foundryDefaultModel,
  buildTemplatePayloadBootstrapCommand,
  buildTemplatePayloadBootstrapFiles,
  buildRuntimeEnv,
  stripGeneratedIntegrationPromptBlock,
  upsertGeneratedIntegrationPromptBlock,
};
