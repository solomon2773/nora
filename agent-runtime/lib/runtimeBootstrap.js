const fs = require("fs");
const path = require("path");
const {
  AGENT_RUNTIME_PORT,
  OPENCLAW_GATEWAY_PORT,
} = require("./contracts");
const { NORA_INTEGRATION_TOOL_COMMAND } = require("./integrationTools");

function runtimeSourcePath(relPath) {
  return path.resolve(__dirname, relPath);
}

function readRuntimeSource(relPath) {
  return fs.readFileSync(runtimeSourcePath(relPath), "utf8");
}

const RUNTIME_FILES = [
  "contracts.js",
  "runtimeBootstrap.js",
  "integrationTools.js",
  "integrationToolCli.js",
  "server.js",
  "agent.js",
].map((relPath) => ({
  relPath,
  source: readRuntimeSource(relPath),
  sourceB64: Buffer.from(readRuntimeSource(relPath)).toString("base64"),
}));

const INTEGRATION_TOOL_WRAPPER_B64 = Buffer.from(
  [
    "#!/usr/bin/env sh",
    'exec node /opt/openclaw-runtime/lib/integrationToolCli.js "$@"',
    "",
  ].join("\n"),
  "utf8"
).toString("base64");

const OPENCLAW_WORKSPACE_ROOT = "/root/.openclaw/workspace";
const OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT =
  "/root/.openclaw/agents/main/agent";
const NORA_INTEGRATIONS_CONTEXT_FILE = "NORA_INTEGRATIONS.md";

function buildRuntimeBootstrapFiles() {
  return RUNTIME_FILES.map(({ relPath, source }) => ({ relPath, source }));
}

function normalizeTemplateEntry(entry, baseDir) {
  if (!entry || typeof entry !== "object") return null;
  const rawPath = String(entry.path || "").trim().replace(/\\/g, "/");
  if (!rawPath) return null;

  const normalizedPath = path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (!normalizedPath || normalizedPath === "." || normalizedPath.startsWith("../")) {
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
  const memoryFiles = Array.isArray(templatePayload.memoryFiles)
    ? templatePayload.memoryFiles
    : [];

  return [
    ...files
      .flatMap((entry) => [
        normalizeTemplateEntry(entry, OPENCLAW_WORKSPACE_ROOT),
        normalizeTemplateEntry(entry, OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT),
      ])
      .filter(Boolean),
    ...memoryFiles
      .map((entry) => normalizeTemplateEntry(entry, "/root/.openclaw"))
      .filter(Boolean),
  ];
}

function buildTemplatePayloadBootstrapFiles(templatePayload = {}) {
  return normalizeTemplatePayloadEntries(templatePayload).map((entry) => ({
    name: entry.targetPath.replace(/^\/+/, ""),
    content: entry.contentBuffer,
    mode: entry.mode,
  }));
}

function buildTemplatePayloadBootstrapCommand(templatePayload = {}) {
  const entries = normalizeTemplatePayloadEntries(templatePayload);
  if (entries.length === 0) return "";

  return entries
    .map(
      ({ targetPath, contentBuffer, mode }) =>
        `mkdir -p ${JSON.stringify(path.posix.dirname(targetPath))} && ` +
        `printf '%s' '${contentBuffer.toString("base64")}' | base64 -d > ${JSON.stringify(targetPath)} && ` +
        `chmod ${mode.toString(8)} ${JSON.stringify(targetPath)} && `
    )
    .join("");
}

function buildRuntimeBootstrapCommand() {
  return [
    "mkdir -p /opt/openclaw-runtime/lib /var/log && ",
    ...RUNTIME_FILES.map(
      ({ relPath, sourceB64 }) =>
        `printf '%s' '${sourceB64}' | base64 -d > /opt/openclaw-runtime/lib/${relPath} && `
    ),
    `printf '%s' '${INTEGRATION_TOOL_WRAPPER_B64}' | base64 -d > /usr/local/bin/${NORA_INTEGRATION_TOOL_COMMAND} && `,
    `chmod 755 /usr/local/bin/${NORA_INTEGRATION_TOOL_COMMAND} && `,
    "touch /var/log/openclaw-agent.log && ",
    "node /opt/openclaw-runtime/lib/agent.js >> /var/log/openclaw-agent.log 2>&1 & ",
  ].join("");
}

function buildOpenClawInstallCommand(packages = ["openclaw@latest"]) {
  const normalizedPackages = (Array.isArray(packages) ? packages : [packages])
    .map((pkg) => String(pkg || "").trim())
    .filter(Boolean);

  if (normalizedPackages.length === 0) {
    throw new Error("buildOpenClawInstallCommand requires at least one package");
  }

  const invalidPackage = normalizedPackages.find(
    (pkg) => !/^[a-zA-Z0-9@._+/\-]+$/.test(pkg)
  );
  if (invalidPackage) {
    throw new Error(`Invalid package spec: ${invalidPackage}`);
  }

  const packageList = normalizedPackages.join(" ");

  return [
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"; ',
    'DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; ',
    'if [ -n "$DETECTED_OPENCLAW_BIN" ] && [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$DETECTED_OPENCLAW_BIN"; fi; ',
    'if ! ([ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] && "$OPENCLAW_BIN" --version >/dev/null 2>&1); then ',
    '  rm -f "${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"; ',
    "  rm -rf /usr/local/lib/node_modules/openclaw; ",
    "  npm uninstall -g openclaw >/dev/null 2>&1 || true; ",
    "  (apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 || true); ",
    `  if ! npm install -g ${packageList} >/tmp/openclaw-install.log 2>&1; then cat /tmp/openclaw-install.log >&2; exit 1; fi; `,
    "  hash -r 2>/dev/null || true; ",
    '  DETECTED_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; ',
    '  if [ -n "${OPENCLAW_CLI_PATH:-}" ] && [ -n "$DETECTED_OPENCLAW_BIN" ] && [ "$DETECTED_OPENCLAW_BIN" != "$OPENCLAW_CLI_PATH" ]; then ',
    '    ln -sf "$DETECTED_OPENCLAW_BIN" "$OPENCLAW_CLI_PATH"; ',
    '    OPENCLAW_BIN="$OPENCLAW_CLI_PATH"; ',
    "  else ",
    '    OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-$DETECTED_OPENCLAW_BIN}"; ',
    "  fi; ",
    '  if ! ([ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ] && "$OPENCLAW_BIN" --version >/dev/null 2>&1); then cat /tmp/openclaw-install.log >&2; exit 1; fi; ',
    "fi; ",
    'export OPENCLAW_CLI_PATH="$OPENCLAW_BIN"; ',
    "true && ",
  ].join("");
}

function buildRuntimeEnv() {
  return {
    AGENT_HTTP_PORT: String(AGENT_RUNTIME_PORT),
    OPENCLAW_GATEWAY_PORT: String(OPENCLAW_GATEWAY_PORT),
    OPENCLAW_CLI_PATH:
      process.env.OPENCLAW_CLI_PATH ||
      "/usr/local/bin/openclaw",
    BACKEND_API_URL:
      process.env.AGENT_RUNTIME_BACKEND_API_URL ||
      process.env.BACKEND_API_URL ||
      "http://backend-api:4000",
  };
}

module.exports = {
  NORA_INTEGRATIONS_CONTEXT_FILE,
  OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
  OPENCLAW_WORKSPACE_ROOT,
  buildOpenClawInstallCommand,
  buildRuntimeBootstrapCommand,
  buildRuntimeBootstrapFiles,
  buildTemplatePayloadBootstrapCommand,
  buildTemplatePayloadBootstrapFiles,
  buildRuntimeEnv,
};
