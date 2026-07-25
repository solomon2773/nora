const fs = require("fs");
const path = require("path");
const { encodeContentBase64, normalizeTemplatePayload } = require("./agentPayloads");
const { getDefaultAgentImage } = require("../agent-runtime/lib/agentImages");
const { getDefaultBackend } = require("../agent-runtime/lib/backendCatalog");

const TEMPLATES_DIR = path.join(__dirname, "agent-hub-templates");
const CORE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
];
const CORE_FILE_SET = new Set(CORE_FILES);
const RESERVED_FILENAMES = new Set(["manifest.json"]);

function textFile(filePath, content) {
  return {
    path: filePath,
    contentBase64: encodeContentBase64(content.trim() + "\n"),
  };
}

/**
 * Normalize manifest-declared extra files while rejecting traversal, reserved
 * manifest names, duplicate entries, and core files loaded separately.
 *
 * @param {Array} [value=[]] - Manifest file paths.
 * @returns {Array} Safe unique relative paths.
 */
function normalizeManifestFileList(value = []) {
  const files = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== "string") continue;
    const normalized = path.posix.normalize(entry.trim().replace(/\\/g, "/")).replace(/^\/+/, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("../") ||
      RESERVED_FILENAMES.has(normalized) ||
      CORE_FILE_SET.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    files.push(normalized);
  }
  return files;
}

function readTemplateFiles(dir, filePaths = []) {
  return filePaths
    .filter((filePath) => fs.existsSync(path.join(dir, filePath)))
    .map((filePath) => textFile(filePath, fs.readFileSync(path.join(dir, filePath), "utf8")));
}

function buildStarterPayload(templateFiles, metadata = {}) {
  return normalizeTemplatePayload({
    files: templateFiles,
    memoryFiles: [],
    wiring: { channels: [], integrations: [] },
    metadata,
  });
}

function buildSnapshotConfig(templateKey, payload, defaults = {}) {
  const backend = defaults.backend || getDefaultBackend(process.env, { sandbox: "standard" });
  return {
    kind: "starter-template",
    templateKey,
    builtIn: true,
    defaults: {
      backend,
      sandbox: "standard",
      vcpu: 2,
      ram_mb: 2048,
      disk_gb: 20,
      image:
        defaults.image ||
        getDefaultAgentImage({
          sandbox: "standard",
          backend,
        }),
    },
    templatePayload: payload,
  };
}

/**
 * Load on-disk starter manifests and declared files, skipping directories
 * without a manifest or template key; malformed JSON and read errors propagate.
 *
 * @returns {Array} Built-in starter template definitions.
 */
function loadTemplatesFromDisk() {
  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  const templates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(TEMPLATES_DIR, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const {
      templateKey,
      name,
      description,
      price,
      category,
      starterType,
      extraFiles = [],
    } = manifest;
    if (!templateKey) continue;

    const templateFiles = readTemplateFiles(dir, [
      ...CORE_FILES,
      ...normalizeManifestFileList(extraFiles),
    ]);

    const payload = buildStarterPayload(templateFiles, { starterType });

    templates.push({
      templateKey,
      name,
      description,
      price,
      category,
      payload,
      snapshotConfig: buildSnapshotConfig(templateKey, payload),
    });
  }

  return templates;
}

const STARTER_TEMPLATES = loadTemplatesFromDisk();

module.exports = {
  STARTER_TEMPLATES,
};
