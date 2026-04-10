const path = require("path");
const db = require("./db");
const integrations = require("./integrations");
const channels = require("./channels");
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const { NORA_INTEGRATIONS_CONTEXT_FILE } = require("../agent-runtime/lib/runtimeBootstrap");
const { NORA_INTEGRATIONS_SKILL_FILE } = require("../agent-runtime/lib/integrationTools");
const {
  isKnownBackend,
  normalizeBackendName,
  sandboxForBackend,
} = require("../agent-runtime/lib/backendCatalog");

const CLONE_MODES = new Set([
  "files_only",
  "files_plus_memory",
  "full_clone",
]);

const OPENCLAW_CORE_FILE_SPECS = Object.freeze([
  { path: "AGENTS.md", label: "Agents", required: true },
  { path: "SOUL.md", label: "Soul", required: true },
  { path: "TOOLS.md", label: "Tools", required: true },
  { path: "IDENTITY.md", label: "Identity", required: true },
  { path: "USER.md", label: "User", required: true },
  { path: "HEARTBEAT.md", label: "Heartbeat", required: true },
  { path: "MEMORY.md", label: "Memory", required: true },
  { path: "BOOTSTRAP.md", label: "Bootstrap", required: false },
]);

const OPENCLAW_REQUIRED_CORE_PATHS = OPENCLAW_CORE_FILE_SPECS
  .filter((spec) => spec.required)
  .map((spec) => spec.path);

const OPENCLAW_CORE_FILE_ALIASES = Object.freeze({
  "AGENTS.md": ["AGENT.md"],
});

const OPENCLAW_WORKSPACE_ROOT = "/root/.openclaw/workspace";
const OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT = "/root/.openclaw/agents/main/agent";

function encodeContentBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function decodeMaybeString(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

function normalizeRelativePath(value) {
  const rawValue = String(value || "").trim().replace(/\\/g, "/");
  if (!rawValue) return null;

  const normalized = path.posix.normalize(rawValue).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return null;
  }

  return normalized;
}

function normalizePayloadEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const normalizedPath = normalizeRelativePath(entry.path);
  if (!normalizedPath) return null;

  let contentBase64 = "";
  if (typeof entry.contentBase64 === "string") {
    contentBase64 = entry.contentBase64;
  } else if (typeof entry.content === "string") {
    contentBase64 = encodeContentBase64(entry.content);
  } else {
    return null;
  }

  return {
    path: normalizedPath,
    contentBase64,
    mode: Number.isInteger(entry.mode) ? entry.mode : 0o644,
  };
}

function normalizePayloadEntries(entries) {
  const byPath = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizePayloadEntry(entry);
    if (normalized) {
      byPath.set(normalized.path, normalized);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeWiringBlueprint(wiring = {}) {
  return {
    channels: Array.isArray(wiring.channels) ? wiring.channels : [],
    integrations: Array.isArray(wiring.integrations) ? wiring.integrations : [],
  };
}

function normalizeTemplatePayload(rawPayload = {}) {
  const payload = decodeMaybeString(rawPayload);
  return {
    version: 1,
    files: normalizePayloadEntries(payload.files),
    memoryFiles: normalizePayloadEntries(payload.memoryFiles),
    wiring: normalizeWiringBlueprint(payload.wiring),
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? payload.metadata
        : {},
  };
}

function decodeContentBase64(value) {
  try {
    return Buffer.from(String(value || ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function buildCoreFileDefaultContent(filePath, context = {}) {
  const name = String(context.name || "OpenClaw Agent").trim() || "OpenClaw Agent";
  const description =
    String(context.description || "").trim() ||
    "Reusable Nora marketplace template.";
  const category = String(context.category || "General").trim() || "General";
  const sourceLabel =
    context.sourceType === "platform"
      ? "Platform preset"
      : context.sourceType === "community"
        ? "Community template"
        : "Agent template";
  const ownerLabel = String(context.ownerName || "Nora").trim() || "Nora";
  const templateKey = String(context.templateKey || "").trim();

  switch (filePath) {
    case "AGENTS.md":
      return `# ${name}

${description}

## Mission

- Operate as a reusable ${category.toLowerCase()} OpenClaw agent template.
- Preserve the behavior described across the core files in this template.
- Prefer explicit reasoning, safe defaults, and concise execution updates.

## Source

- ${sourceLabel}
- Publisher: ${ownerLabel}
${templateKey ? `- Template key: ${templateKey}` : ""}`.trim();
    case "SOUL.md":
      return `## Soul

- Stay calm, precise, and operationally useful.
- Reduce noise instead of adding more process.
- When context is incomplete, state the gap instead of pretending certainty.
- Protect trust, secrets, and user intent in every response.`;
    case "TOOLS.md":
      return `## Tools

- Use tools only when they materially improve accuracy or execution.
- Prefer the shortest path that preserves correctness.
- Summarize tool outcomes clearly so the operator can verify what changed.
- Never exfiltrate secrets or take destructive actions without approval.`;
    case "IDENTITY.md":
      return `## Identity

- Name: ${name}
- Category: ${category}
- Source: ${sourceLabel}
- Publisher: ${ownerLabel}
- Primary role: ${description}`;
    case "USER.md":
      return `## User

- Default to helping the current operator make faster, clearer decisions.
- Match the user's preferred level of detail and pace.
- Ask follow-up questions only when the missing information changes the outcome.`;
    case "HEARTBEAT.md":
      return `## Heartbeat

- On entry, read the core files before acting.
- During execution, keep the next action aligned with the current objective.
- Before responding, verify facts, call out blockers, and summarize the state clearly.`;
    case "MEMORY.md":
      return `## Memory

- Persistent identity: ${name}
- Category: ${category}
- Source: ${sourceLabel}
${templateKey ? `- Template key: ${templateKey}` : ""}

Track durable facts, preferences, operating constraints, and open loops here.`.trim();
    case "BOOTSTRAP.md":
      return `## Bootstrap

1. Read \`AGENTS.md\`, \`SOUL.md\`, \`TOOLS.md\`, \`IDENTITY.md\`, \`USER.md\`, \`HEARTBEAT.md\`, and \`MEMORY.md\`.
2. Restate the mission, boundaries, and expected outputs for ${name}.
3. Preserve template-specific behavior before taking any action.
4. Remove or refresh this bootstrap guide only after the template is fully internalized.`;
    default:
      return "";
  }
}

function ensureCoreTemplateFiles(rawPayload = {}, context = {}) {
  const payload = normalizeTemplatePayload(rawPayload);
  const fileByPath = new Map(payload.files.map((entry) => [entry.path, entry]));
  const includeBootstrap =
    context.includeBootstrap === true || fileByPath.has("BOOTSTRAP.md");
  const nextFiles = [...payload.files];

  for (const spec of OPENCLAW_CORE_FILE_SPECS) {
    if (!spec.required && !includeBootstrap) {
      continue;
    }
    if (fileByPath.has(spec.path)) {
      continue;
    }

    const aliasPath = (OPENCLAW_CORE_FILE_ALIASES[spec.path] || []).find((candidate) =>
      fileByPath.has(candidate)
    );
    if (aliasPath) {
      const aliasEntry = fileByPath.get(aliasPath);
      nextFiles.push({
        path: spec.path,
        contentBase64: aliasEntry.contentBase64,
        mode: aliasEntry.mode,
      });
      continue;
    }

    nextFiles.push({
      path: spec.path,
      contentBase64: encodeContentBase64(
        buildCoreFileDefaultContent(spec.path, context).trim() + "\n"
      ),
      mode: 0o644,
    });
  }

  return normalizeTemplatePayload({
    ...payload,
    files: nextFiles,
  });
}

function summarizeTemplatePayload(rawPayload = {}, options = {}) {
  const includeContent = options.includeContent === true;
  const payload = ensureCoreTemplateFiles(rawPayload, options.context || {});
  const fileByPath = new Map(payload.files.map((entry) => [entry.path, entry]));
  const files = payload.files.map((entry) => {
    const spec = OPENCLAW_CORE_FILE_SPECS.find((candidate) => candidate.path === entry.path);
    const content = decodeContentBase64(entry.contentBase64);
    return {
      path: entry.path,
      label: spec?.label || entry.path,
      isCore: Boolean(spec),
      requiredCore: spec?.required === true,
      bytes: Buffer.from(String(entry.contentBase64 || ""), "base64").length,
      lineCount: content ? content.split(/\r?\n/).length : 0,
      preview: content.split(/\r?\n/).slice(0, 4).join("\n").trim(),
      ...(includeContent ? { content } : {}),
    };
  });

  const coreFiles = OPENCLAW_CORE_FILE_SPECS.map((spec) => {
    const entry = fileByPath.get(spec.path) || null;
    const content = entry ? decodeContentBase64(entry.contentBase64) : "";
    return {
      path: spec.path,
      label: spec.label,
      required: spec.required,
      present: Boolean(entry),
      bytes: entry
        ? Buffer.from(String(entry.contentBase64 || ""), "base64").length
        : 0,
      lineCount: content ? content.split(/\r?\n/).length : 0,
      preview: content.split(/\r?\n/).slice(0, 4).join("\n").trim(),
      ...(includeContent && entry ? { content } : {}),
    };
  });

  const missingRequiredCoreFiles = OPENCLAW_REQUIRED_CORE_PATHS.filter(
    (filePath) => !fileByPath.has(filePath)
  );

  return {
    payload,
    fileCount: payload.files.length,
    memoryFileCount: payload.memoryFiles.length,
    integrationCount: payload.wiring.integrations.length,
    channelCount: payload.wiring.channels.length,
    requiredCoreCount: OPENCLAW_REQUIRED_CORE_PATHS.length,
    presentRequiredCoreCount:
      OPENCLAW_REQUIRED_CORE_PATHS.length - missingRequiredCoreFiles.length,
    missingRequiredCoreFiles,
    hasBootstrap: fileByPath.has("BOOTSTRAP.md"),
    extraFilesCount: payload.files.filter(
      (entry) =>
        !OPENCLAW_CORE_FILE_SPECS.some((spec) => spec.path === entry.path)
    ).length,
    coreFiles,
    files,
    memoryFiles: payload.memoryFiles.map((entry) => {
      const content = decodeContentBase64(entry.contentBase64);
      return {
        path: entry.path,
        bytes: Buffer.from(String(entry.contentBase64 || ""), "base64").length,
        lineCount: content ? content.split(/\r?\n/).length : 0,
        preview: content.split(/\r?\n/).slice(0, 4).join("\n").trim(),
        ...(includeContent ? { content } : {}),
      };
    }),
  };
}

function applyTemplateFileEdits(rawPayload = {}, nextFiles = null, context = {}) {
  const payload = normalizeTemplatePayload(rawPayload);
  const files =
    Array.isArray(nextFiles) && nextFiles.length > 0
      ? nextFiles.map((entry) => ({
          path: entry?.path,
          content:
            typeof entry?.content === "string"
              ? entry.content
              : decodeContentBase64(entry?.contentBase64),
        }))
      : payload.files;

  return ensureCoreTemplateFiles(
    {
      ...payload,
      files,
    },
    context
  );
}

function createEmptyTemplatePayload(metadata = {}) {
  return normalizeTemplatePayload({ metadata });
}

function cloneTemplatePayloadForMode(rawPayload, cloneMode = "files_only") {
  const payload = normalizeTemplatePayload(rawPayload);
  const normalizedMode = CLONE_MODES.has(cloneMode) ? cloneMode : "files_only";

  return {
    ...payload,
    memoryFiles:
      normalizedMode === "files_only" ? [] : payload.memoryFiles,
    wiring:
      normalizedMode === "full_clone"
        ? payload.wiring
        : { channels: [], integrations: [] },
  };
}

function sanitizeAgentName(rawName, fallbackLabel = "OpenClaw-Agent") {
  const value =
    typeof rawName === "string"
      ? rawName.replace(/[\x00-\x1f\x7f]/g, "").trim()
      : "";
  return (
    value ||
    `${fallbackLabel}-${Math.floor(Math.random() * 1000)}`
  );
}

function buildContainerName(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
  return `oclaw-agent-${slug || "agent"}-${Date.now().toString(36)}`;
}

function serializeAgent(agent) {
  if (!agent) return agent;
  const { template_payload, gateway_token, ...rest } = agent;
  return rest;
}

async function fetchTemplateExportViaRuntime(agent, includeMemory) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/template/export");
  if (!runtimeUrl) {
    throw new Error("runtime endpoint unavailable");
  }

  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeMemory }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `runtime export returned ${response.status}`);
  }

  return normalizeTemplatePayload(await response.json());
}

async function fetchTemplateExportViaExec(agent, includeMemory) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("runtime exec unavailable");
  }

const exportScript = `
const fs = require("fs");
const generatedExcludes = new Set(["auth-profiles.json", ${JSON.stringify(NORA_INTEGRATIONS_CONTEXT_FILE)}, ${JSON.stringify(NORA_INTEGRATIONS_SKILL_FILE)}]);
function collectFiles(root, prefix = "", exclude = new Set()) {
  const files = [];
  function walk(currentRoot, currentPrefix = "") {
    if (!fs.existsSync(currentRoot)) return;
    for (const entry of fs.readdirSync(currentRoot, { withFileTypes: true })) {
      const abs = currentRoot + "/" + entry.name;
      const rel = currentPrefix ? currentPrefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (generatedExcludes.has(entry.name) || generatedExcludes.has(rel)) continue;
      if (exclude.has(rel) || exclude.has(entry.name)) continue;
      files.push({
        path: prefix ? prefix + "/" + rel : rel,
        contentBase64: fs.readFileSync(abs).toString("base64"),
      });
    }
  }
  walk(root, "");
  return files;
}
const mergedFiles = new Map();
for (const entry of collectFiles(${JSON.stringify(OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT)}, "", new Set(["auth-profiles.json", ${JSON.stringify(NORA_INTEGRATIONS_CONTEXT_FILE)}, ${JSON.stringify(NORA_INTEGRATIONS_SKILL_FILE)}]))) {
  mergedFiles.set(entry.path, entry);
}
for (const entry of collectFiles(${JSON.stringify(OPENCLAW_WORKSPACE_ROOT)})) {
  mergedFiles.set(entry.path, entry);
}
const templatePaths = new Set([...mergedFiles.keys()]);
const roots = [
  ...(process.argv[1] === "1"
    ? [
        {
          kind: "memoryFiles",
          root: ${JSON.stringify(OPENCLAW_WORKSPACE_ROOT)},
          prefix: "workspace",
          exclude: new Set(),
          excludeTemplatePaths: true,
        },
        {
          kind: "memoryFiles",
          root: "/root/.openclaw/agents/main/sessions",
          prefix: "agents/main/sessions",
          exclude: new Set(),
          excludeTemplatePaths: false,
        },
      ]
    : []),
];
const result = { version: 1, files: [...mergedFiles.values()], memoryFiles: [] };
function walk(kind, root, prefix, exclude, excludeTemplatePaths) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = root + "/" + entry.name;
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      walk(kind, abs, rel, exclude, excludeTemplatePaths);
      continue;
    }
    if (!entry.isFile()) continue;
    if (exclude.has(rel) || exclude.has(entry.name)) continue;
    const relativeTemplatePath =
      prefix === "workspace" && rel.startsWith("workspace/")
        ? rel.slice("workspace/".length)
        : rel;
    if (excludeTemplatePaths && templatePaths.has(relativeTemplatePath)) continue;
    result[kind].push({
      path: rel,
      contentBase64: fs.readFileSync(abs).toString("base64"),
    });
  }
}
for (const { kind, root, prefix, exclude, excludeTemplatePaths } of roots) {
  walk(kind, root, prefix, exclude, excludeTemplatePaths);
}
process.stdout.write(JSON.stringify(result));
`.trim();

  const command =
    `node -e ${JSON.stringify(exportScript)} ${includeMemory ? "1" : "0"}`;
  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command,
      timeout: 120000,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `runtime exec export returned ${response.status}`);
  }

  const execResult = await response.json();
  if (execResult.exitCode !== 0) {
    throw new Error(execResult.stderr || execResult.stdout || "template export failed");
  }

  return normalizeTemplatePayload(execResult.stdout || "{}");
}

async function exportTemplatePayloadFromAgent(agent, cloneMode = "files_only") {
  const includeMemory = cloneMode !== "files_only";

  try {
    return cloneTemplatePayloadForMode(
      await fetchTemplateExportViaRuntime(agent, includeMemory),
      cloneMode
    );
  } catch (primaryError) {
    try {
      return cloneTemplatePayloadForMode(
        await fetchTemplateExportViaExec(agent, includeMemory),
        cloneMode
      );
    } catch (fallbackError) {
      // Fall back to the payload stored on the agent record. This keeps
      // duplicate/install flows working for stopped agents, blank agents, and
      // template-instantiated agents even when runtime export is unavailable.
      return cloneTemplatePayloadForMode(agent.template_payload, cloneMode);
    }
  }
}

async function buildAgentWiringBlueprint(agentId) {
  const [integrationRows, channelRows] = await Promise.all([
    db.query(
      "SELECT provider, catalog_id, access_token, config, status FROM integrations WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId]
    ),
    db.query(
      "SELECT type, name, config, enabled FROM channels WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId]
    ),
  ]);

  return {
    integrations: integrationRows.rows.map((row) =>
      integrations.buildCloneableIntegration(row)
    ),
    channels: channelRows.rows.map((row) =>
      channels.buildCloneableChannel(row)
    ),
  };
}

async function buildTemplatePayloadFromAgent(agent, cloneMode = "files_only") {
  const basePayload = await exportTemplatePayloadFromAgent(agent, cloneMode);
  const nextPayload = cloneTemplatePayloadForMode(basePayload, cloneMode);

  if (cloneMode === "full_clone") {
    nextPayload.wiring = await buildAgentWiringBlueprint(agent.id);
  }

  return ensureCoreTemplateFiles(nextPayload, {
    name: agent?.name || "OpenClaw Agent",
    sourceType: "community",
    includeBootstrap:
      Array.isArray(nextPayload.files) &&
      nextPayload.files.some((entry) => entry?.path === "BOOTSTRAP.md"),
  });
}

async function materializeTemplateWiring(agentId, rawPayload = {}) {
  const payload = normalizeTemplatePayload(rawPayload);
  const wiring = normalizeWiringBlueprint(payload.wiring);

  for (const integration of wiring.integrations) {
    await db.query(
      `INSERT INTO integrations(agent_id, provider, catalog_id, access_token, config, status)
       VALUES($1, $2, $3, NULL, $4, $5)`,
      [
        agentId,
        integration.provider,
        integration.catalog_id || integration.provider,
        JSON.stringify(integration.config || {}),
        integration.status || "needs_reconnect",
      ]
    );
  }

  for (const channel of wiring.channels) {
    await db.query(
      `INSERT INTO channels(agent_id, type, name, config, enabled)
       VALUES($1, $2, $3, $4, $5)`,
      [
        agentId,
        channel.type,
        channel.name,
        JSON.stringify(channel.config || {}),
        channel.enabled === true,
      ]
    );
  }
}

function extractTemplatePayloadFromSnapshot(snapshot, options = {}) {
  const config = decodeMaybeString(snapshot?.config);
  const builtIn = config?.builtIn === true || snapshot?.built_in === true;
  return ensureCoreTemplateFiles(config.templatePayload || {}, {
    name: snapshot?.name || "OpenClaw Agent",
    description: snapshot?.description || "",
    templateKey: snapshot?.template_key || config?.templateKey || null,
    sourceType: builtIn ? "platform" : "community",
    includeBootstrap:
      options.includeBootstrap === true ||
      snapshot?.kind === "starter-template" ||
      snapshot?.kind === "community-template",
  });
}

function extractTemplateDefaultsFromSnapshot(snapshot) {
  const config = decodeMaybeString(snapshot?.config);
  const defaults =
    config.defaults && typeof config.defaults === "object" ? config.defaults : {};
  const backend = isKnownBackend(defaults.backend)
    ? normalizeBackendName(defaults.backend)
    : defaults.sandbox === "nemoclaw"
      ? "nemoclaw"
      : null;
  const sandbox = backend
    ? sandboxForBackend(backend)
    : defaults.sandbox === "nemoclaw"
      ? "nemoclaw"
      : "standard";

  return {
    backend,
    sandbox,
    vcpu: Number.parseInt(defaults.vcpu, 10) || 2,
    ram_mb: Number.parseInt(defaults.ram_mb, 10) || 2048,
    disk_gb: Number.parseInt(defaults.disk_gb, 10) || 20,
    image: defaults.image || null,
  };
}

module.exports = {
  CLONE_MODES,
  OPENCLAW_CORE_FILE_SPECS,
  OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
  OPENCLAW_WORKSPACE_ROOT,
  applyTemplateFileEdits,
  buildAgentWiringBlueprint,
  buildContainerName,
  buildTemplatePayloadFromAgent,
  cloneTemplatePayloadForMode,
  createEmptyTemplatePayload,
  decodeContentBase64,
  encodeContentBase64,
  ensureCoreTemplateFiles,
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
  materializeTemplateWiring,
  normalizeTemplatePayload,
  sanitizeAgentName,
  serializeAgent,
  summarizeTemplatePayload,
};
