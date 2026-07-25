// @ts-nocheck
const path = require("path");
const db = require("./db");
const integrations = require("./integrations");
const channels = require("./channels");
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const { runtimeAuthHeaders } = require("./runtimeAuth");
const remoteHosts = require("./remoteHosts");
const { NORA_INTEGRATIONS_CONTEXT_FILE } = require("../agent-runtime/lib/runtimeBootstrap");
const { NORA_INTEGRATIONS_SKILL_FILE } = require("../agent-runtime/lib/integrationTools");
const {
  normalizeBackendName,
  normalizeExecutionTargetId,
} = require("../agent-runtime/lib/backendCatalog");
const { buildAgentRuntimeFields, parseSandboxProfile } = require("./agentRuntimeFields");

const CLONE_MODES = new Set(["files_only", "files_plus_memory", "full_clone"]);
const LEGACY_BACKEND_TYPE_ALIASES = new Set(["hermes", "nemoclaw"]);
const INTERNAL_TEMPLATE_METADATA_KEYS = new Set(["activation"]);

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

const OPENCLAW_REQUIRED_CORE_PATHS = OPENCLAW_CORE_FILE_SPECS.filter((spec) => spec.required).map(
  (spec) => spec.path,
);

const OPENCLAW_CORE_FILE_ALIASES = Object.freeze({
  "AGENTS.md": ["AGENT.md"],
});

const OPENCLAW_WORKSPACE_ROOT = "/root/.openclaw/workspace";
const OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT = "/root/.openclaw/agents/main/agent";
const REMOTE_HOST_AUTH_RECHECK_MS = Math.max(
  250,
  Number.parseInt(process.env.REMOTE_HOST_AUTH_RECHECK_MS || "1000", 10) || 1000,
);

// Payload encoding and normalization

function encodeContentBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function decodeContentBase64(value) {
  try {
    return Buffer.from(String(value || ""), "base64").toString("utf8");
  } catch {
    return "";
  }
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

// Allowlist to ensure paths are safe when interpolated into shell bootstrap
// commands downstream. Keep in sync with SAFE_TEMPLATE_PATH_RE in
// agent-runtime/lib/runtimeBootstrap.ts.
const SAFE_PAYLOAD_PATH_RE = /^[A-Za-z0-9._/-]+$/;

function normalizeRelativePath(value) {
  const rawValue = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (!rawValue) return null;

  const normalized = path.posix.normalize(rawValue).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return null;
  }
  if (!SAFE_PAYLOAD_PATH_RE.test(normalized)) {
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

/**
 * Normalize arbitrary stored or user-supplied template payload data into Nora's
 * canonical template payload shape.
 *
 * @param {Object} [rawPayload={}] - Template payload candidate from the DB, runtime export, or request body.
 * @returns {Object} Normalized payload with stable `files`, `memoryFiles`, `wiring`, and `metadata` fields.
 */
function normalizeTemplatePayload(rawPayload = {}) {
  const payload = decodeMaybeString(rawPayload);
  return {
    version: 1,
    files: normalizePayloadEntries(payload.files),
    memoryFiles: normalizePayloadEntries(payload.memoryFiles),
    wiring: normalizeWiringBlueprint(payload.wiring),
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
  };
}

// Metadata that identifies a control-plane-owned agent must never cross a
// duplicate, migration, backup, or Agent Hub boundary. Otherwise a copied
// payload could be mistaken for the original durable control-plane record.
function stripInternalTemplateMetadata(rawPayload = {}) {
  const payload = normalizeTemplatePayload(rawPayload);
  const metadata = { ...payload.metadata };
  for (const key of INTERNAL_TEMPLATE_METADATA_KEYS) {
    delete metadata[key];
  }
  return { ...payload, metadata };
}

function createEmptyTemplatePayload(metadata = {}) {
  return normalizeTemplatePayload({ metadata });
}

// Core template files

function buildCoreFileDefaultContent(filePath, context = {}) {
  const name = String(context.name || "OpenClaw Agent").trim() || "OpenClaw Agent";
  const description =
    String(context.description || "").trim() || "Reusable Nora Agent Hub template.";
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

/**
 * Ensure a template payload contains Nora's required core OpenClaw files,
 * backfilling missing entries from aliases or generated defaults.
 *
 * @param {Object} [rawPayload={}] - Template payload to validate and repair.
 * @param {Object} [context={}] - Template metadata used when generating default file content.
 * @returns {Object} Normalized payload that includes the required core files.
 */
function ensureCoreTemplateFiles(rawPayload = {}, context = {}) {
  const payload = normalizeTemplatePayload(rawPayload);
  const fileByPath = new Map(payload.files.map((entry) => [entry.path, entry]));
  const includeBootstrap = context.includeBootstrap === true || fileByPath.has("BOOTSTRAP.md");
  const nextFiles = [...payload.files];

  for (const spec of OPENCLAW_CORE_FILE_SPECS) {
    if (!spec.required && !includeBootstrap) {
      continue;
    }
    if (fileByPath.has(spec.path)) {
      continue;
    }

    const aliasPath = (OPENCLAW_CORE_FILE_ALIASES[spec.path] || []).find((candidate) =>
      fileByPath.has(candidate),
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
        buildCoreFileDefaultContent(spec.path, context).trim() + "\n",
      ),
      mode: 0o644,
    });
  }

  return normalizeTemplatePayload({
    ...payload,
    files: nextFiles,
  });
}

// Payload summaries, edits, and clone modes

/**
 * Build a UI-friendly summary of a template payload, including core-file
 * presence, previews, and file counts.
 *
 * @param {Object} [rawPayload={}] - Template payload to summarize.
 * @param {Object} [options={}] - Summary options such as whether to include full decoded content.
 * @returns {Object} Summary object describing the payload and its files.
 */
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
      bytes: entry ? Buffer.from(String(entry.contentBase64 || ""), "base64").length : 0,
      lineCount: content ? content.split(/\r?\n/).length : 0,
      preview: content.split(/\r?\n/).slice(0, 4).join("\n").trim(),
      ...(includeContent && entry ? { content } : {}),
    };
  });

  const missingRequiredCoreFiles = OPENCLAW_REQUIRED_CORE_PATHS.filter(
    (filePath) => !fileByPath.has(filePath),
  );

  return {
    payload,
    fileCount: payload.files.length,
    memoryFileCount: payload.memoryFiles.length,
    integrationCount: payload.wiring.integrations.length,
    channelCount: payload.wiring.channels.length,
    requiredCoreCount: OPENCLAW_REQUIRED_CORE_PATHS.length,
    presentRequiredCoreCount: OPENCLAW_REQUIRED_CORE_PATHS.length - missingRequiredCoreFiles.length,
    missingRequiredCoreFiles,
    hasBootstrap: fileByPath.has("BOOTSTRAP.md"),
    extraFilesCount: payload.files.filter(
      (entry) => !OPENCLAW_CORE_FILE_SPECS.some((spec) => spec.path === entry.path),
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
    context,
  );
}

/**
 * Trim a template payload down to the data allowed for the requested clone mode.
 *
 * @param {Object} rawPayload - Template payload being prepared for cloning or export.
 * @param {string} [cloneMode="files_only"] - `files_only` keeps files,
 *   `files_plus_memory` adds memory, and `full_clone` also includes wiring.
 * @returns {Object} Payload filtered to the files, memory, and wiring allowed by that mode.
 */
function cloneTemplatePayloadForMode(rawPayload, cloneMode = "files_only") {
  const payload = stripInternalTemplateMetadata(rawPayload);
  const normalizedMode = CLONE_MODES.has(cloneMode) ? cloneMode : "files_only";

  return {
    ...payload,
    memoryFiles: normalizedMode === "files_only" ? [] : payload.memoryFiles,
    wiring: normalizedMode === "full_clone" ? payload.wiring : { channels: [], integrations: [] },
  };
}

// Agent and container naming

function stripAsciiControlCharacters(value) {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

function sanitizeAgentName(rawName, fallbackLabel = "OpenClaw-Agent") {
  const value = typeof rawName === "string" ? stripAsciiControlCharacters(rawName).trim() : "";
  return value || `${fallbackLabel}-${Math.floor(Math.random() * 1000)}`;
}

const GENERATED_CONTAINER_NAME_PREFIXES = Object.freeze([
  "nora-oclaw",
  "nora-hermes",
  "oclaw-agent",
  "oclaw-nemoclaw",
  "hermes-agent",
]);

function containerNamePrefixForRuntime(runtimeSelection = {}) {
  const runtimeFields = buildAgentRuntimeFields(runtimeSelection);
  if (runtimeFields.runtime_family === "hermes") {
    return "nora-hermes";
  }
  return "nora-oclaw";
}

function isGeneratedContainerName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return GENERATED_CONTAINER_NAME_PREFIXES.some((prefix) => normalized.startsWith(`${prefix}-`));
}

function buildContainerName(name, runtimeSelection = {}) {
  const prefix = containerNamePrefixForRuntime(runtimeSelection);
  const suffix = Date.now().toString(36);
  const maxSlugLength = Math.max(16, 63 - prefix.length - suffix.length - 2);
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, maxSlugLength);
  return `${prefix}-${slug || "agent"}-${suffix}`;
}

/**
 * Pick the container/deployment name Nora should persist for a new or updated
 * agent, preserving explicit names while regenerating stale auto-names when the
 * runtime family changes.
 *
 * @param {Object} [options={}] - Requested, current, and runtime-derived naming inputs.
 * @returns {string} Container name Nora should save for the agent.
 */
function resolveContainerName({
  requestedName,
  currentName,
  agentName,
  runtimeSelection = {},
} = {}) {
  const explicitRequestedName = typeof requestedName === "string" ? requestedName.trim() : "";
  if (explicitRequestedName) return explicitRequestedName;

  const normalizedCurrentName = typeof currentName === "string" ? currentName.trim() : "";
  if (!normalizedCurrentName) {
    return buildContainerName(agentName, runtimeSelection);
  }

  const expectedPrefix = `${containerNamePrefixForRuntime(runtimeSelection)}-`;
  if (
    !isGeneratedContainerName(normalizedCurrentName) ||
    normalizedCurrentName.toLowerCase().startsWith(expectedPrefix)
  ) {
    return normalizedCurrentName;
  }

  return buildContainerName(agentName, runtimeSelection);
}

function serializeAgent(agent) {
  if (!agent) return agent;
  const { template_payload, gateway_token, network_policy_status, ...rest } = agent;
  return {
    ...rest,
    networkPolicyStatus:
      network_policy_status == null ? null : decodeMaybeString(network_policy_status),
    ...buildAgentRuntimeFields(rest),
  };
}

// Runtime template export

function isCaptureAuthorizationError(error) {
  const code = String(error?.code || "");
  return (
    code === "REMOTE_HOST_ACCESS_REVOKED" ||
    code === "REMOTE_HOST_RETEST_REQUIRED" ||
    code.endsWith("AUTH_CHECK_FAILED")
  );
}

function captureAbortReason(signal, fallbackError = null) {
  if (!signal?.aborted) return null;
  if (signal.reason instanceof Error) return signal.reason;
  if (fallbackError instanceof Error) return fallbackError;
  const error = new Error("Agent template export was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfCaptureAborted(signal) {
  const error = captureAbortReason(signal);
  if (error) throw error;
}

function rethrowCaptureAuthorizationOrAbort(error, signal) {
  const abortReason = captureAbortReason(signal, error);
  if (abortReason) throw abortReason;
  if (isCaptureAuthorizationError(error)) throw error;
}

async function withRemoteHostCaptureAuthorization(
  agent,
  { signal, authorizationRecheckMs = REMOTE_HOST_AUTH_RECHECK_MS } = {},
  capture,
) {
  throwIfCaptureAborted(signal);
  if (!remoteHosts.isRemoteDockerAgent(agent)) return capture(signal);

  const controller = new AbortController();
  let authorizationTimer = null;
  let authorizationInFlight = null;
  let authorizationError = null;
  let captureSettled = false;

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (signal) {
    if (signal.aborted) abortFromParent();
    else {
      signal.addEventListener("abort", abortFromParent, { once: true });
      if (signal.aborted) abortFromParent();
    }
  }

  const checkAuthorization = () => {
    if (captureSettled || authorizationInFlight || authorizationError || signal?.aborted) {
      return authorizationInFlight;
    }
    authorizationInFlight = Promise.resolve()
      .then(() => remoteHosts.assertRemoteHostAgentUse(agent, { includeProfile: false }))
      .catch((error) => {
        if (signal?.aborted) return;
        authorizationError = remoteHosts.toPublicRemoteHostAuthorizationError(error);
        if (!controller.signal.aborted) controller.abort(authorizationError);
      })
      .finally(() => {
        authorizationInFlight = null;
      });
    return authorizationInFlight;
  };

  try {
    await checkAuthorization();
    if (authorizationError) throw authorizationError;
    throwIfCaptureAborted(controller.signal);

    authorizationTimer = setInterval(
      () => {
        void checkAuthorization();
      },
      Math.max(1, authorizationRecheckMs),
    );
    authorizationTimer.unref?.();

    let captured;
    try {
      captured = await capture(controller.signal);
    } catch (error) {
      if (signal?.aborted) throw captureAbortReason(signal, error);
      if (authorizationError) throw authorizationError;
      rethrowCaptureAuthorizationOrAbort(error, controller.signal);
      throw error;
    }

    // Do not accept a capture that raced a failed grant check. Stop scheduling
    // new work, drain the current check, and require one final positive grant.
    captureSettled = true;
    clearInterval(authorizationTimer);
    authorizationTimer = null;
    const pendingAuthorization = authorizationInFlight;
    if (pendingAuthorization) await pendingAuthorization;
    if (signal?.aborted) throw captureAbortReason(signal);
    if (authorizationError) throw authorizationError;
    try {
      await remoteHosts.assertRemoteHostAgentUse(agent, { includeProfile: false });
    } catch (error) {
      throw remoteHosts.toPublicRemoteHostAuthorizationError(error);
    }
    throwIfCaptureAborted(signal);
    return captured;
  } finally {
    captureSettled = true;
    if (authorizationTimer) clearInterval(authorizationTimer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function fetchTemplateExportViaRuntime(agent, includeMemory, { signal } = {}) {
  throwIfCaptureAborted(signal);
  const runtimeUrl = runtimeUrlForAgent(agent, "/template/export");
  if (!runtimeUrl) {
    throw new Error("runtime endpoint unavailable");
  }

  const headers = { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) };
  throwIfCaptureAborted(signal);
  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ includeMemory }),
    signal,
  });
  throwIfCaptureAborted(signal);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `runtime export returned ${response.status}`);
  }

  const payload = await response.json();
  throwIfCaptureAborted(signal);
  return normalizeTemplatePayload(payload);
}

async function fetchTemplateExportViaExec(agent, includeMemory, { signal } = {}) {
  throwIfCaptureAborted(signal);
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("runtime exec unavailable");
  }

  const exportScript = `
const fs = require("fs");
const generatedExcludes = new Set(["auth-profiles.json", "NORA_INTEGRATIONS.md", ${JSON.stringify(NORA_INTEGRATIONS_CONTEXT_FILE)}, ${JSON.stringify(NORA_INTEGRATIONS_SKILL_FILE)}]);
const generatedDirExcludes = new Set(["integrations"]);
function collectFiles(root, prefix = "", exclude = new Set()) {
  const files = [];
  function walk(currentRoot, currentPrefix = "") {
    if (!fs.existsSync(currentRoot)) return;
    for (const entry of fs.readdirSync(currentRoot, { withFileTypes: true })) {
      const abs = currentRoot + "/" + entry.name;
      const rel = currentPrefix ? currentPrefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (generatedDirExcludes.has(entry.name) || generatedDirExcludes.has(rel)) continue;
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
for (const entry of collectFiles(${JSON.stringify(OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT)}, "", new Set(["auth-profiles.json", "NORA_INTEGRATIONS.md", ${JSON.stringify(NORA_INTEGRATIONS_CONTEXT_FILE)}, ${JSON.stringify(NORA_INTEGRATIONS_SKILL_FILE)}]))) {
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

  const command = `node -e ${JSON.stringify(exportScript)} ${includeMemory ? "1" : "0"}`;
  const headers = { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) };
  throwIfCaptureAborted(signal);
  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command,
      timeout: 120000,
    }),
    signal,
  });
  throwIfCaptureAborted(signal);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `runtime exec export returned ${response.status}`);
  }

  const execResult = await response.json();
  throwIfCaptureAborted(signal);
  if (execResult.exitCode !== 0) {
    throw new Error(execResult.stderr || execResult.stdout || "template export failed");
  }

  return normalizeTemplatePayload(execResult.stdout || "{}");
}

/**
 * Export a template payload from a live agent runtime, falling back to the
 * stored payload for ordinary runtime failures while propagating authorization
 * and cancellation failures.
 *
 * @param {Object} agent - Agent row whose template content should be exported.
 * @param {string} [cloneMode="files_only"] - `files_only` keeps files,
 *   `files_plus_memory` adds memory, and `full_clone` also includes wiring.
 * @param {Object} [options={}] - Optional capture abort signal.
 * @returns {Promise<Object>} Exported payload normalized to the requested clone mode.
 */
async function exportTemplatePayloadFromAgent(agent, cloneMode = "files_only", { signal } = {}) {
  const includeMemory = cloneMode !== "files_only";

  try {
    return cloneTemplatePayloadForMode(
      await fetchTemplateExportViaRuntime(agent, includeMemory, { signal }),
      cloneMode,
    );
  } catch (primaryError) {
    // Remote-host revocation and fail-closed authorization errors must never
    // degrade into either a second live request or the stored-template
    // fallback. The shared capture wrapper keeps an authorization watcher
    // active while this request is in flight and aborts it with the public error.
    rethrowCaptureAuthorizationOrAbort(primaryError, signal);
    try {
      return cloneTemplatePayloadForMode(
        await fetchTemplateExportViaExec(agent, includeMemory, { signal }),
        cloneMode,
      );
    } catch (fallbackError) {
      rethrowCaptureAuthorizationOrAbort(fallbackError, signal);
      // Fall back to the payload stored on the agent record. This keeps
      // duplicate/install flows working for stopped agents, blank agents, and
      // template-instantiated agents even when runtime export is unavailable.
      return cloneTemplatePayloadForMode(agent.template_payload, cloneMode);
    }
  }
}

// Template wiring

/**
 * Read the integrations and channels that should travel with a full template
 * clone of an agent.
 *
 * @param {string} agentId - Agent whose cloneable wiring should be loaded.
 * @returns {Promise<Object>} Wiring blueprint containing cloneable integrations and channels.
 */
async function buildAgentWiringBlueprint(agentId) {
  const [integrationRows, channelRows] = await Promise.all([
    db.query(
      "SELECT provider, catalog_id, access_token, config, status FROM integrations WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId],
    ),
    db.query(
      "SELECT type, name, config, enabled FROM channels WHERE agent_id = $1 ORDER BY created_at ASC",
      [agentId],
    ),
  ]);

  return {
    integrations: integrationRows.rows.map((row) => integrations.buildCloneableIntegration(row)),
    channels: channelRows.rows.map((row) => channels.buildCloneableChannel(row)),
  };
}

/**
 * Build the reusable template payload Nora should expose for an agent,
 * optionally attaching runtime memory and cloneable wiring.
 *
 * @param {Object} agent - Agent row to export as a reusable template.
 * @param {string} [cloneMode="files_only"] - `files_only` keeps files,
 *   `files_plus_memory` adds memory, and `full_clone` also includes wiring.
 * @param {Object} [options={}] - Capture authorization and abort options.
 * @returns {Promise<Object>} Normalized template payload ready for duplication or publishing.
 */
async function buildTemplatePayloadFromAgent(agent, cloneMode = "files_only", options = {}) {
  const basePayload = await withRemoteHostCaptureAuthorization(agent, options, (signal) =>
    exportTemplatePayloadFromAgent(agent, cloneMode, { signal }),
  );
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

/**
 * Persist the wiring portion of a template payload onto a newly created agent.
 *
 * @param {string} agentId - Agent receiving the cloned integrations and channels.
 * @param {Object} [rawPayload={}] - Template payload whose wiring section should be materialized.
 * @returns {Promise<void>} Resolves after the cloneable integrations and channels are inserted.
 */
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
      ],
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
      ],
    );
  }
}

// Stored template snapshots

/**
 * Extract a normalized template payload from a saved template snapshot, filling
 * in required core files and source metadata.
 *
 * @param {Object} snapshot - Stored starter/community template snapshot.
 * @param {Object} [options={}] - Extraction options such as whether to force bootstrap inclusion.
 * @returns {Object} Template payload ready for previewing or instantiating.
 */
function extractTemplatePayloadFromSnapshot(snapshot, options = {}) {
  const config = decodeMaybeString(snapshot?.config);
  const builtIn = config?.builtIn === true || snapshot?.built_in === true;
  return ensureCoreTemplateFiles(stripInternalTemplateMetadata(config.templatePayload || {}), {
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

/**
 * Read the default runtime/deployment settings embedded in a template snapshot.
 *
 * @param {Object} snapshot - Stored template snapshot whose defaults should be parsed.
 * @returns {Object} Normalized backend, sizing, and image defaults for new agents.
 */
function extractTemplateDefaultsFromSnapshot(snapshot) {
  const config = decodeMaybeString(snapshot?.config);
  const defaults = config.defaults && typeof config.defaults === "object" ? config.defaults : {};
  const canonicalBackend = defaults.deploy_target ?? defaults.deployTarget;
  const legacyBackend = defaults.backend;
  const hasCanonicalBackend = String(canonicalBackend ?? "").trim() !== "";
  const hasLegacyBackend = String(legacyBackend ?? "").trim() !== "";
  const normalizedLegacyBackend = String(legacyBackend ?? "")
    .trim()
    .toLowerCase();
  const requestedBackend = hasCanonicalBackend ? canonicalBackend : legacyBackend;
  const backend = hasCanonicalBackend
    ? normalizeBackendName(canonicalBackend)
    : hasLegacyBackend && !LEGACY_BACKEND_TYPE_ALIASES.has(normalizedLegacyBackend)
      ? normalizeBackendName(legacyBackend)
      : null;
  const requestedExecutionTargetId = defaults.execution_target_id ?? defaults.executionTargetId;
  const normalizedExecutionTargetId = normalizeExecutionTargetId(requestedExecutionTargetId);
  if (String(requestedExecutionTargetId ?? "").trim() !== "" && !normalizedExecutionTargetId) {
    normalizeBackendName(requestedExecutionTargetId);
  }
  const executionTargetId =
    normalizedExecutionTargetId || normalizeExecutionTargetId(requestedBackend) || backend;
  const requestedSandbox = defaults.sandbox_profile ?? defaults.sandboxProfile ?? defaults.sandbox;
  const sandbox = parseSandboxProfile(requestedSandbox) || "standard";

  return {
    backend,
    executionTargetId,
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
  resolveContainerName,
  sanitizeAgentName,
  serializeAgent,
  stripInternalTemplateMetadata,
  summarizeTemplatePayload,
};
