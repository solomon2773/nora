// @ts-nocheck
/**
 * OpenClaw Agent Runtime — HTTP API Server
 *
 * Runs on port 9090 inside every agent container.
 * Provides health checks, exec, log tailing, and integration/channel forwarding.
 */
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, execFileSync, spawn } = require("child_process");
const { AGENT_RUNTIME_PORT, OPENCLAW_GATEWAY_PORT } = require("./contracts");
const {
  NORA_INTEGRATIONS_CONTEXT_FILE,
  OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
  OPENCLAW_WORKSPACE_ROOT,
} = require("./runtimeBootstrap");
const {
  NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
  NORA_SYNC_INTEGRATIONS_DIR,
  NORA_INTEGRATIONS_SKILL_FILE,
  buildSplitIntegrationManifest,
  buildIntegrationSkillMarkdown,
  buildIntegrationToolExecutionMetadata,
  executeIntegrationToolInvocation,
  getIntegrationToolSpecs,
  loadSyncedIntegrations,
} = require("./integrationTools");
const { handleExec } = require("./execEndpoint");

const PORT = parseInt(process.env.AGENT_HTTP_PORT || String(AGENT_RUNTIME_PORT));
const LOG_FILE = "/var/log/openclaw-agent.log";
const OPENCLAW_CLI = process.env.OPENCLAW_CLI_PATH || "/usr/local/bin/openclaw";
const MAX_EXEC_BODY_BYTES = 64 * 1024;

function requestBodyTooLargeError(maxBytes) {
  const error = new Error(`Request body exceeds ${maxBytes} bytes`);
  error.code = "REQUEST_BODY_TOO_LARGE";
  error.statusCode = 413;
  return error;
}

// Simple JSON body parser. Exec requests pass an AbortSignal so a client that
// disconnects mid-body cannot leave this promise waiting forever for `end`.
function parseBody(req, { signal = null, maxBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Continue consuming the request without buffering it so the server can
      // return a clean 413 on a keep-alive connection.
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      totalBytes += chunk.length;
      if (maxBytes != null && totalBytes > maxBytes) {
        fail(requestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        settle(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        settle({});
      }
    };
    const onError = () => settle({});
    const onAbort = () => settle({});

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Every route except /health requires `Authorization: Bearer <gateway token>`.
// The token (OPENCLAW_GATEWAY_TOKEN) is the per-agent secret the control plane
// already holds. Constant-time compared. A missing token fails closed for
// every sensitive route; only /health remains available for orchestration.
const RUNTIME_AUTH_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const RUNTIME_PUBLIC_PATHS = new Set(["/health"]);

function isRuntimeRequestAuthorized(req) {
  if (!RUNTIME_AUTH_TOKEN) return false;
  const header = req.headers["authorization"] || "";
  // Parse "Bearer <token>" with plain string ops — a `\s+(.+)` regex here is a
  // ReDoS footgun (the two quantifiers both match spaces, so a header of
  // "Bearer " + many spaces backtracks catastrophically).
  if (header.slice(0, 7).toLowerCase() !== "bearer ") return false;
  const presentedToken = header.slice(7).trim();
  if (!presentedToken) return false;
  const presented = Buffer.from(presentedToken);
  const expected = Buffer.from(RUNTIME_AUTH_TOKEN);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

const startTime = Date.now();

const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || String(OPENCLAW_GATEWAY_PORT));
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const OPENCLAW_RUNTIME_HOME_ROOT = "/root/.openclaw";
const AGENT_TEMPLATE_ROOTS = [
  OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
  OPENCLAW_WORKSPACE_ROOT,
  OPENCLAW_RUNTIME_HOME_ROOT,
];
const GENERATED_RUNTIME_FILE_NAMES = new Set([
  "auth-profiles.json",
  "integrations.config",
  "integrations.config.json",
  "integrations.json",
  "NORA_INTEGRATIONS.md",
  NORA_INTEGRATIONS_CONTEXT_FILE,
  NORA_INTEGRATIONS_SKILL_FILE,
]);
const GENERATED_RUNTIME_DIR_NAMES = new Set(["integrations"]);
const NORA_INTEGRATIONS_PROMPT_BEGIN = "<!-- NORA_INTEGRATIONS_BEGIN -->";
const NORA_INTEGRATIONS_PROMPT_END = "<!-- NORA_INTEGRATIONS_END -->";
const MEMORY_EXPORT_ROOTS = [
  {
    root: OPENCLAW_WORKSPACE_ROOT,
    prefix: "workspace",
    excludeTemplatePaths: true,
  },
  { root: "/root/.openclaw/agents/main/sessions", prefix: "agents/main/sessions" },
];

function collectExportFiles(rootDir, prefix = "") {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const files = [];
  const walk = (currentDir, relativeDir = "") => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = `${currentDir}/${entry.name}`;
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (
          GENERATED_RUNTIME_DIR_NAMES.has(entry.name) ||
          GENERATED_RUNTIME_DIR_NAMES.has(relPath)
        ) {
          continue;
        }
        walk(absPath, relPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (
        GENERATED_RUNTIME_FILE_NAMES.has(entry.name) ||
        GENERATED_RUNTIME_FILE_NAMES.has(relPath)
      ) {
        continue;
      }
      const fileContent = fs.readFileSync(absPath, "utf8");
      files.push({
        path: prefix ? `${prefix}/${relPath}` : relPath,
        contentBase64: Buffer.from(stripGeneratedIntegrationPromptBlock(fileContent)).toString(
          "base64",
        ),
      });
    }
  };

  walk(rootDir, "");
  return files;
}

function collectTemplateExportFiles() {
  const mergedFiles = new Map();
  for (const rootDir of AGENT_TEMPLATE_ROOTS) {
    for (const entry of collectExportFiles(rootDir)) {
      mergedFiles.set(entry.path, entry);
    }
  }
  return [...mergedFiles.values()];
}

function formatIntegrationValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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

function upsertGeneratedIntegrationPromptBlock(filePath) {
  try {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const cleaned = stripGeneratedIntegrationPromptBlock(existing);
    const next = `${cleaned.trimEnd()}\n\n${buildIntegrationPromptPointerMarkdown()}\n`;
    fs.mkdirSync(path.posix.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next.trimStart(), "utf8");
  } catch {
    // Best effort only.
  }
}

function buildIntegrationContextMarkdown(integrations = []) {
  const syncedIntegrations = Array.isArray(integrations) ? integrations : [];
  const lines = [
    "# Nora Integrations",
    "",
    "This file is generated by Nora from the active integrations connected to this agent.",
    "Use only the providers listed here.",
    `Machine-readable integration metadata is available in \`${NORA_SYNC_INTEGRATIONS_DIR}\` on OpenClaw. Start with \`${NORA_SYNC_INTEGRATIONS_CATALOG_FILE}\`, then follow each \`detailsFile\` only when credential/tool details are needed.`,
    "When a connected tool shows runtime execution below, use the generated `nora-integrations` skill and `nora-integration-tool` command through the exec tool.",
    "",
  ];

  if (syncedIntegrations.length === 0) {
    lines.push("No active Nora integrations are currently synced to this agent.");
    lines.push("");
    return lines.join("\n");
  }

  for (const integration of syncedIntegrations) {
    const providerLabel = integration.name || integration.provider || "Integration";
    const category = integration.category || "unknown";
    const capabilities = Array.isArray(integration.capabilities) ? integration.capabilities : [];
    const toolSpecs = getIntegrationToolSpecs(integration);
    const usageHints = Array.isArray(integration.usageHints) ? integration.usageHints : [];
    const redactedConfig =
      integration.redactedConfig && typeof integration.redactedConfig === "object"
        ? integration.redactedConfig
        : {};
    const credentialEnv =
      integration.credentialEnv && typeof integration.credentialEnv === "object"
        ? integration.credentialEnv
        : {};
    const configEnv =
      credentialEnv.config && typeof credentialEnv.config === "object" ? credentialEnv.config : {};
    const visibleConfigEntries = Object.entries(redactedConfig).filter(
      ([, value]) => value != null && value !== "" && value !== "[REDACTED]",
    );
    const secretConfigKeys = Object.entries(redactedConfig)
      .filter(([, value]) => value === "[REDACTED]")
      .map(([key]) => key);
    const api = integration.api && typeof integration.api === "object" ? integration.api : null;
    const mcp = integration.mcp && typeof integration.mcp === "object" ? integration.mcp : null;

    lines.push(`## ${providerLabel}`);
    lines.push("");
    lines.push(`- Provider: ${integration.provider || providerLabel}`);
    lines.push(`- Status: ${integration.status || "active"}`);
    lines.push(`- Category: ${category}`);
    if (integration.authType) {
      lines.push(`- Auth type: ${integration.authType}`);
    }
    if (capabilities.length > 0) {
      lines.push(`- Capabilities: ${capabilities.join(", ")}`);
    }

    if (api) {
      const apiSummary = [api.type || "api", api.baseUrl || ""].filter(Boolean).join(" ");
      lines.push(`- API: ${apiSummary || "declared"}`);
      if (api.docsUrl) lines.push(`- API docs: ${api.docsUrl}`);
      if (api.authEnv) lines.push(`- API auth env: ${api.authEnv}`);
    }
    if (credentialEnv.primary) {
      lines.push(`- Primary credential env: ${credentialEnv.primary}`);
    }
    const configEnvEntries = Object.entries(configEnv).filter(([, envName]) => envName);
    if (configEnvEntries.length > 0) {
      lines.push("- Config env vars:");
      for (const [key, envName] of configEnvEntries) {
        lines.push(`  - ${key}: ${envName}`);
      }
    }

    if (mcp) {
      if (mcp.available) {
        lines.push(`- MCP: available${mcp.endpoint ? ` (${mcp.endpoint})` : ""}`);
      } else {
        lines.push(`- MCP: ${mcp.notes || "declared but not enabled"}`);
      }
    } else {
      lines.push("- MCP: not declared");
    }

    if (visibleConfigEntries.length > 0) {
      lines.push("- Non-secret config:");
      for (const [key, value] of visibleConfigEntries) {
        lines.push(`  - ${key}: ${formatIntegrationValue(value)}`);
      }
    }

    if (secretConfigKeys.length > 0) {
      lines.push(`- Secret config fields: ${secretConfigKeys.join(", ")}`);
    }

    if (toolSpecs.length > 0) {
      lines.push("- Declared tools:");
      for (const tool of toolSpecs) {
        const name = tool?.name || "tool";
        const description = tool?.description || "No description provided.";
        const execution = buildIntegrationToolExecutionMetadata(integration, tool);
        lines.push(`  - \`${name}\` - ${description}`);
        lines.push(
          execution.executable
            ? `    - Execution: available via \`${execution.invokeCommand}\``
            : "    - Execution: discovery only",
        );
      }
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

function writeWorkspaceGeneratedFile(relativePath, content) {
  try {
    const targetPath = path.posix.join(OPENCLAW_WORKSPACE_ROOT, relativePath);
    fs.mkdirSync(path.posix.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  } catch {
    // Best effort only.
  }
}

function writeIntegrationContextFiles(integrations = []) {
  writeWorkspaceGeneratedFile(
    NORA_INTEGRATIONS_CONTEXT_FILE,
    buildIntegrationContextMarkdown(integrations),
  );
  writeWorkspaceGeneratedFile(
    NORA_INTEGRATIONS_SKILL_FILE,
    buildIntegrationSkillMarkdown(integrations),
  );
  upsertGeneratedIntegrationPromptBlock(path.posix.join(OPENCLAW_WORKSPACE_ROOT, "TOOLS.md"));
  upsertGeneratedIntegrationPromptBlock(
    path.posix.join(OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT, "TOOLS.md"),
  );
}

function removeIfPresent(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // Best effort cleanup of generated compatibility files.
  }
}

function cleanupLegacyIntegrationFiles() {
  const legacyRelativeFiles = [
    "integrations.config",
    "integrations.config.json",
    "integrations.json",
    "NORA_INTEGRATIONS.md",
    NORA_INTEGRATIONS_CONTEXT_FILE,
  ];
  const legacyRoots = [
    "/opt/openclaw",
    OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
    OPENCLAW_RUNTIME_HOME_ROOT,
  ];

  for (const rootDir of legacyRoots) {
    for (const relativeFile of legacyRelativeFiles) {
      removeIfPresent(path.posix.join(rootDir, relativeFile));
    }
    removeIfPresent(path.posix.join(rootDir, NORA_INTEGRATIONS_SKILL_FILE));
  }

  removeIfPresent(path.posix.join(OPENCLAW_WORKSPACE_ROOT, "integrations.config"));
  removeIfPresent(path.posix.join(OPENCLAW_WORKSPACE_ROOT, "integrations.config.json"));
  removeIfPresent(path.posix.join(OPENCLAW_WORKSPACE_ROOT, "integrations.json"));
  removeIfPresent(path.posix.join(OPENCLAW_WORKSPACE_ROOT, "NORA_INTEGRATIONS.md"));
}

function writeIntegrationManifestFiles(integrations = []) {
  cleanupLegacyIntegrationFiles();
  const manifest = buildSplitIntegrationManifest(Array.isArray(integrations) ? integrations : []);
  fs.rmSync(NORA_SYNC_INTEGRATIONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(NORA_SYNC_INTEGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(
    NORA_SYNC_INTEGRATIONS_CATALOG_FILE,
    `${JSON.stringify(manifest.catalog, null, 2)}\n`,
    "utf8",
  );
  fs.chmodSync(NORA_SYNC_INTEGRATIONS_CATALOG_FILE, 0o644);

  for (const { fileName, integration } of manifest.details) {
    const detailPath = path.posix.join(NORA_SYNC_INTEGRATIONS_DIR, fileName);
    fs.writeFileSync(detailPath, `${JSON.stringify(integration, null, 2)}\n`, "utf8");
    fs.chmodSync(detailPath, 0o600);
  }
}

/**
 * Forward an inbound channel message to the local OpenClaw gateway,
 * collect the full response, and send it back through the channel.
 */
async function forwardToGatewayAndReply(body) {
  const { channelId, channelType, content, sender } = body;
  if (!content || !channelId) return;

  // Send chat message to the OpenClaw gateway's HTTP chat endpoint
  const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat`;
  let responseText = "";

  try {
    const chatRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        messages: [{ role: "user", content }],
        stream: false,
      }),
      signal: AbortSignal.timeout(120000), // 2 minute timeout for LLM response
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text();
      throw new Error(`Gateway returned ${chatRes.status}: ${errText}`);
    }

    const chatData = await chatRes.json();
    // OpenAI-compatible response format
    responseText =
      chatData.choices?.[0]?.message?.content ||
      chatData.content ||
      chatData.response ||
      JSON.stringify(chatData);
  } catch (e) {
    // If gateway HTTP endpoint isn't available, try the exec-based fallback.
    // Use execFileSync with an argv array so neither OPENCLAW_CLI nor `content`
    // is interpreted by a shell — content comes from a request body.
    try {
      const result = execFileSync(
        OPENCLAW_CLI,
        ["chat", "--message", String(content), "--no-interactive"],
        { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] },
      );
      responseText = result.trim();
    } catch {
      responseText = `[OpenClaw] Unable to process message: ${e.message}`;
    }
  }

  if (!responseText) return;

  // Log the response
  const logLine = `${new Date().toISOString()} [CHANNEL] Response to ${channelType}: ${responseText.slice(0, 200)}`;
  try {
    fs.appendFileSync(LOG_FILE, logLine + "\n");
  } catch {
    /* ignore */
  }

  // Send response back through the channel via backend API
  const apiUrl = process.env.BACKEND_API_URL || "http://backend-api:4000";
  try {
    await fetch(
      `${apiUrl}/agents/${encodeURIComponent(process.env.AGENT_ID || "")}/channels/${encodeURIComponent(channelId)}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: responseText,
          metadata: { inReplyTo: sender, channelType },
        }),
      },
    );
  } catch (e) {
    const errLine = `${new Date().toISOString()} [CHANNEL] Failed to send reply: ${e.message}`;
    try {
      fs.appendFileSync(LOG_FILE, errLine + "\n");
    } catch {
      /* ignore */
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Auth gate: everything but /health requires the gateway bearer token.
  if (!RUNTIME_PUBLIC_PATHS.has(path) && !isRuntimeRequestAuthorized(req)) {
    return json(res, 401, { error: "unauthorized" });
  }

  // ── GET /health ───────────────────────────────────────
  if (req.method === "GET" && path === "/health") {
    return json(res, 200, {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pid: process.pid,
      node: process.version,
    });
  }

  // ── GET /info ─────────────────────────────────────────
  if (req.method === "GET" && path === "/info") {
    return json(res, 200, {
      agentId: process.env.AGENT_ID || "unknown",
      agentName: process.env.AGENT_NAME || "unnamed",
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      nodeVersion: process.version,
    });
  }

  // ── GET /logs ─────────────────────────────────────────
  if (req.method === "GET" && path === "/logs") {
    const rawTail = parseInt(url.searchParams.get("tail") || "100", 10);
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 10000) : 100;
    try {
      // argv-array form — no shell, no interpolation, no injection surface.
      const output = execFileSync("tail", ["-n", String(tail), LOG_FILE], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return json(res, 200, { lines: output.trim().split("\n") });
    } catch {
      return json(res, 200, { lines: ["No logs available"] });
    }
  }

  // ── POST /exec ────────────────────────────────────────
  // Handler lives in execEndpoint.ts, which is intentionally excluded from
  // CodeQL analysis (see that file's header + .github/codeql-config.yml).
  if (req.method === "POST" && path === "/exec") {
    const controller = new AbortController();
    const abortExec = () => {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Runtime exec request closed"));
      }
    };
    const closeExec = () => {
      if (!res.writableEnded) abortExec();
    };
    req.once("aborted", abortExec);
    res.once("close", closeExec);
    if (req.aborted || req.destroyed || res.destroyed) abortExec();
    try {
      const body = await parseBody(req, {
        signal: controller.signal,
        maxBytes: MAX_EXEC_BODY_BYTES,
      });
      if (controller.signal.aborted) return;
      const result = await handleExec(body, { signal: controller.signal });
      if (!res.destroyed && !res.writableEnded) {
        return json(res, 200, result);
      }
      return;
    } catch (error) {
      if (error?.code === "REQUEST_BODY_TOO_LARGE" && !res.destroyed && !res.writableEnded) {
        return json(res, 413, { error: "request_body_too_large" });
      }
      throw error;
    } finally {
      req.removeListener("aborted", abortExec);
      res.removeListener("close", closeExec);
    }
  }

  // ── GET /integrations ─────────────────────────────────
  if (req.method === "GET" && path === "/integrations") {
    // The runtime stores active integrations in a local config file
    return json(res, 200, loadSyncedIntegrations());
  }

  // ── POST /channels/send ───────────────────────────────
  if (req.method === "POST" && path === "/channels/send") {
    const body = await parseBody(req);
    // Forward to the backend API for actual delivery
    const apiUrl = process.env.BACKEND_API_URL || "http://backend-api:4000";
    try {
      const response = await fetch(
        `${apiUrl}/agents/${encodeURIComponent(process.env.AGENT_ID || "")}/channels/${encodeURIComponent(String(body.channelId || ""))}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: body.content, metadata: body.metadata }),
        },
      );
      const result = await response.json();
      return json(res, response.status, result);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /channels/receive ────────────────────────────
  if (req.method === "POST" && path === "/channels/receive") {
    const body = await parseBody(req);
    const line = `${new Date().toISOString()} [CHANNEL] Inbound from ${body.channelType}: ${body.content}`;
    try {
      fs.appendFileSync(LOG_FILE, line + "\n");
    } catch {
      /* ignore */
    }

    // Respond immediately so the webhook caller isn't blocked
    json(res, 200, { received: true });

    // Asynchronously forward to the local OpenClaw gateway and send the response back
    forwardToGatewayAndReply(body).catch((e) => {
      const errLine = `${new Date().toISOString()} [CHANNEL] Gateway forward error: ${e.message}`;
      try {
        fs.appendFileSync(LOG_FILE, errLine + "\n");
      } catch {
        /* ignore */
      }
    });
    return;
  }

  // ── POST /integrations/sync ───────────────────────────
  if (req.method === "POST" && path === "/integrations/sync") {
    const body = await parseBody(req);
    const syncedIntegrations = Array.isArray(body)
      ? body
      : Array.isArray(body.integrations)
        ? body.integrations
        : [];
    try {
      fs.mkdirSync("/opt/openclaw", { recursive: true });
      writeIntegrationManifestFiles(syncedIntegrations);
      writeIntegrationContextFiles(syncedIntegrations);
      return json(res, 200, { synced: true, count: syncedIntegrations.length });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /integrations/tools/invoke ─────────────────────
  if (req.method === "POST" && path === "/integrations/tools/invoke") {
    const body = await parseBody(req);
    const toolName =
      typeof body.toolName === "string" && body.toolName
        ? body.toolName
        : typeof body.name === "string" && body.name
          ? body.name
          : "";
    const input =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? body.input
        : body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
          ? body.arguments
          : {};

    if (!toolName) {
      return json(res, 400, { error: "toolName required" });
    }

    try {
      const result = await executeIntegrationToolInvocation({
        toolName,
        input,
      });
      return json(res, 200, result);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ── POST /template/export ──────────────────────────────
  if (req.method === "POST" && path === "/template/export") {
    const body = await parseBody(req);
    const includeMemory = body.includeMemory !== false;

    try {
      const files = collectTemplateExportFiles();
      const templatePathSet = new Set(files.map((entry) => entry.path));
      const memoryFiles = includeMemory
        ? MEMORY_EXPORT_ROOTS.flatMap(({ root, prefix, excludeTemplatePaths }) =>
            collectExportFiles(root, prefix).filter((entry) => {
              if (!excludeTemplatePaths) return true;
              const relativePath = entry.path.startsWith(`${prefix}/`)
                ? entry.path.slice(prefix.length + 1)
                : entry.path;
              return !templatePathSet.has(relativePath);
            }),
          )
        : [];

      return json(res, 200, {
        version: 1,
        files,
        memoryFiles,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── NemoClaw Sandbox Endpoints ────────────────────────

  // GET /nemoclaw/status — sandbox health, model, policy state
  if (req.method === "GET" && path === "/nemoclaw/status") {
    try {
      const policyPath = "/opt/openclaw/policy.yaml";
      let policy = null;
      try {
        policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
      } catch {
        /* no policy file */
      }

      const model = process.env.NEMOCLAW_MODEL || "unknown";
      const hasNvidia = !!process.env.NVIDIA_API_KEY;

      return json(res, 200, {
        sandbox: "nemoclaw",
        model,
        inferenceConfigured: hasNvidia,
        policyActive: !!policy,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        pid: process.pid,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /nemoclaw/policy — current network/filesystem/inference policy
  if (req.method === "GET" && path === "/nemoclaw/policy") {
    try {
      const policyPath = "/opt/openclaw/policy.yaml";
      const raw = fs.readFileSync(policyPath, "utf-8");
      return json(res, 200, JSON.parse(raw));
    } catch (e) {
      return json(res, 404, { error: "No policy file found", detail: e.message });
    }
  }

  // POST /nemoclaw/policy — update policy (hot-reload)
  if (req.method === "POST" && path === "/nemoclaw/policy") {
    const body = await parseBody(req);
    try {
      fs.mkdirSync("/opt/openclaw", { recursive: true });
      fs.writeFileSync("/opt/openclaw/policy.yaml", JSON.stringify(body, null, 2));

      // Attempt hot-reload via openshell CLI if available
      try {
        execSync("openshell policy set /opt/openclaw/policy.yaml", {
          timeout: 5000,
          stdio: "ignore",
        });
      } catch {
        // openshell CLI may not be present in all sandbox images — policy file is still updated
      }

      return json(res, 200, { updated: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /nemoclaw/approvals — pending network egress approval requests
  if (req.method === "GET" && path === "/nemoclaw/approvals") {
    try {
      const approvalsPath = "/opt/openclaw/pending-approvals.json";
      let approvals = [];
      try {
        approvals = JSON.parse(fs.readFileSync(approvalsPath, "utf-8"));
      } catch {
        /* no pending */
      }
      return json(res, 200, { approvals });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // POST /nemoclaw/approvals/:rid — approve or deny a pending request
  if (req.method === "POST" && path.startsWith("/nemoclaw/approvals/")) {
    const rid = path.split("/").pop();
    const body = await parseBody(req);
    try {
      const approvalsPath = "/opt/openclaw/pending-approvals.json";
      let approvals = [];
      try {
        approvals = JSON.parse(fs.readFileSync(approvalsPath, "utf-8"));
      } catch {
        /* empty */
      }

      const idx = approvals.findIndex((a) => a.id === rid);
      if (idx === -1) return json(res, 404, { error: "Approval request not found" });

      const decision = body.action === "approve" ? "approved" : "denied";
      approvals[idx].status = decision;
      approvals[idx].decidedAt = new Date().toISOString();

      // If approved, add endpoint to live policy
      if (decision === "approved") {
        try {
          const policyPath = "/opt/openclaw/policy.yaml";
          const policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
          const endpoint = approvals[idx].endpoint;
          if (endpoint && policy.network?.rules) {
            policy.network.rules.push({
              name: `approved_${rid.slice(0, 8)}`,
              endpoints: [endpoint],
              methods: ["*"],
              approved: true,
            });
            fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
            try {
              execSync("openshell policy set /opt/openclaw/policy.yaml", {
                timeout: 5000,
                stdio: "ignore",
              });
            } catch {
              /* best effort */
            }
          }
        } catch {
          /* policy update best-effort */
        }
      }

      // Remove decided entries, keep only pending
      const remaining = approvals.filter((a) => !a.status || a.status === "pending");
      fs.writeFileSync(approvalsPath, JSON.stringify(remaining, null, 2));

      return json(res, 200, { rid, decision });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── 404 ───────────────────────────────────────────────
  json(res, 404, { error: "Not found" });
});

function startServer() {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[openclaw-runtime] HTTP server listening on port ${PORT}`);
    if (!RUNTIME_AUTH_TOKEN) {
      console.warn(
        "[openclaw-runtime] SECURITY WARNING: OPENCLAW_GATEWAY_TOKEN is not set — sensitive runtime routes are disabled; only /health is available.",
      );
    }
  });
}

module.exports = { MAX_EXEC_BODY_BYTES, startServer, server };
