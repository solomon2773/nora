// @ts-nocheck
const fs = require("fs");
const path = require("path");
const {
  encodeContentBase64,
  normalizeTemplatePayload,
} = require("./agentPayloads");
const { getDefaultAgentImage } = require("../agent-runtime/lib/agentImages");
const { getDefaultBackend } = require("../agent-runtime/lib/backendCatalog");

const TEMPLATES_DIR = path.join(__dirname, "marketplace-templates");
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

function textFile(filePath, content) {
  return {
    path: filePath,
    contentBase64: encodeContentBase64(content.trim() + "\n"),
  };
}

function buildStarterPayload(coreFiles, metadata = {}) {
  return normalizeTemplatePayload({
    files: coreFiles,
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

function loadTemplatesFromDisk() {
  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  const templates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(TEMPLATES_DIR, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { templateKey, name, description, price, category, starterType } = manifest;
    if (!templateKey) continue;

    const coreFiles = CORE_FILES
      .filter((f) => fs.existsSync(path.join(dir, f)))
      .map((f) => textFile(f, fs.readFileSync(path.join(dir, f), "utf8")));

    const payload = buildStarterPayload(coreFiles, { starterType });

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
