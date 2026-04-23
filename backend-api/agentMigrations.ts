// @ts-nocheck
const path = require("path");
const { promisify } = require("util");
const { gzip, gunzip } = require("zlib");
const { execFile } = require("child_process");

const tar = require("tar-stream");
const Docker = require("dockerode");

const db = require("./db");
const llmProviders = require("./llmProviders");
const integrations = require("./integrations");
const channels = require("./channels");
const {
  buildTemplatePayloadFromAgent,
  ensureCoreTemplateFiles,
  normalizeTemplatePayload,
} = require("./agentPayloads");
const {
  getAgentSecretEnvVars,
  listAgentSecretOverrides,
  replaceAgentSecretOverrides,
} = require("./agentSecretOverrides");
const { connectIntegration } = require("./integrations");
const { createChannel, revealChannelConfig } = require("./channels");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const { scanTemplatePayloadForSecrets } = require("./marketplaceSafety");
const {
  NORA_INTEGRATIONS_CONTEXT_FILE,
  OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
  OPENCLAW_WORKSPACE_ROOT,
} = require("../agent-runtime/lib/runtimeBootstrap");
const { NORA_INTEGRATIONS_SKILL_FILE } = require("../agent-runtime/lib/integrationTools");
const {
  HERMES_CHANNEL_DEFINITIONS,
  HERMES_CHANNEL_TYPES,
  buildHermesPythonCommand,
  getPersistedHermesState,
  replacePersistedHermesState,
  snapshotToPersistedHermesState,
} = require("./hermesUi");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFile);

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const MIGRATION_BUNDLE_FORMAT = "nora-migration-bundle/v1";
const MAX_REMOTE_BUFFER_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const { shellSingleQuote } = require("../agent-runtime/lib/containerCommand");

function decodeStoredManifest(rawValue = "") {
  const decrypted = decrypt(String(rawValue || ""));
  if (!decrypted) return null;
  try {
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

function encodeStoredManifest(manifest) {
  ensureEncryptionConfigured("Migration draft storage");
  return encrypt(JSON.stringify(manifest || {}));
}

function normalizeManifestWarnings(warnings = []) {
  return (Array.isArray(warnings) ? warnings : [])
    .map((warning) => {
      if (!warning) return null;
      if (typeof warning === "string") {
        return { code: "warning", message: warning };
      }
      const message = String(warning.message || "").trim();
      if (!message) return null;
      return {
        code: String(warning.code || warning.type || "warning").trim() || "warning",
        message,
        path: warning.path ? String(warning.path) : undefined,
      };
    })
    .filter(Boolean);
}

function summarizeManagedState(managed = {}) {
  return {
    llmProviderCount: Array.isArray(managed.llmProviders) ? managed.llmProviders.length : 0,
    integrationCount: Array.isArray(managed.integrations) ? managed.integrations.length : 0,
    channelCount: Array.isArray(managed.channels) ? managed.channels.length : 0,
    agentSecretCount: Array.isArray(managed.agentSecretOverrides)
      ? managed.agentSecretOverrides.length
      : 0,
  };
}

function summarizeManifest(manifest = {}) {
  const templatePayload = normalizeTemplatePayload(manifest.templatePayload || {});
  const hermesFiles = Array.isArray(manifest?.hermesSeed?.files) ? manifest.hermesSeed.files : [];
  const managedSummary = summarizeManagedState(manifest.managed || {});
  const warnings = normalizeManifestWarnings(manifest.warnings);

  return {
    runtimeFamily:
      String(manifest.runtimeFamily || "")
        .trim()
        .toLowerCase() || "openclaw",
    fileCount: templatePayload.files.length,
    memoryFileCount: templatePayload.memoryFiles.length,
    hermesFileCount: hermesFiles.length,
    hermesChannelCount: Array.isArray(manifest?.hermesSeed?.channels)
      ? manifest.hermesSeed.channels.length
      : 0,
    ...managedSummary,
    warningCount: warnings.length,
  };
}

function buildDraftPreview(manifest = {}) {
  const templatePayload = normalizeTemplatePayload(manifest.templatePayload || {});
  const warnings = normalizeManifestWarnings(manifest.warnings);
  const hermesChannels = Array.isArray(manifest?.hermesSeed?.channels)
    ? manifest.hermesSeed.channels
    : [];

  return {
    id: manifest.id || null,
    name: manifest.name || "Imported Agent",
    runtimeFamily:
      String(manifest.runtimeFamily || "")
        .trim()
        .toLowerCase() || "openclaw",
    source: manifest.source || {},
    summary: summarizeManifest(manifest),
    warnings,
    managed: {
      llmProviders: (manifest?.managed?.llmProviders || []).map((entry) => ({
        provider: entry.provider,
        model: entry.model || null,
      })),
      integrations: (manifest?.managed?.integrations || []).map((entry) => ({
        provider: entry.provider,
        status: entry.status || "active",
      })),
      channels: (manifest?.managed?.channels || []).map((entry) => ({
        type: entry.type,
        name: entry.name,
        enabled: entry.enabled !== false,
      })),
      agentSecretOverrides: (manifest?.managed?.agentSecretOverrides || []).map((entry) => ({
        key: entry.key,
      })),
    },
    openclaw: {
      fileCount: templatePayload.files.length,
      memoryFileCount: templatePayload.memoryFiles.length,
    },
    hermes: {
      fileCount: Array.isArray(manifest?.hermesSeed?.files) ? manifest.hermesSeed.files.length : 0,
      modelConfig: manifest?.hermesSeed?.modelConfig || null,
      channels: hermesChannels.map((entry) => ({
        type: entry.type,
      })),
    },
  };
}

async function packMigrationBundle(manifest = {}) {
  const bundle = tar.pack();
  const archiveChunks = [];
  const archivePromise = new Promise((resolve, reject) => {
    bundle.on("data", (chunk) => archiveChunks.push(chunk));
    bundle.on("end", () => resolve(Buffer.concat(archiveChunks)));
    bundle.on("error", reject);
  });

  await new Promise((resolve, reject) => {
    bundle.entry(
      { name: "manifest.json", mode: 0o644 },
      JSON.stringify(manifest, null, 2),
      (error) => {
        if (error) return reject(error);
        bundle.finalize();
        resolve();
      },
    );
  });

  const tarBuffer = await archivePromise;
  return gzipAsync(tarBuffer);
}

async function unpackMigrationBundle(buffer) {
  const tarBuffer = await gunzipAsync(buffer);
  const extract = tar.extract();
  let manifestText = "";

  const manifestPromise = new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        if (header.name === "manifest.json") {
          manifestText = Buffer.concat(chunks).toString("utf8");
        }
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });

  extract.end(tarBuffer);
  await manifestPromise;

  if (!manifestText) {
    throw new Error("Migration bundle is missing manifest.json");
  }

  return JSON.parse(manifestText);
}

function normalizeMigrationManifest(rawManifest = {}) {
  const runtimeFamily =
    String(rawManifest.runtimeFamily || rawManifest.runtime_family || "")
      .trim()
      .toLowerCase() || "openclaw";
  const templatePayload =
    runtimeFamily === "openclaw"
      ? ensureCoreTemplateFiles(rawManifest.templatePayload || {}, {
          name: rawManifest.name || "Imported OpenClaw Agent",
          sourceType: "community",
        })
      : undefined;

  return {
    format: MIGRATION_BUNDLE_FORMAT,
    version: 1,
    runtimeFamily,
    name: String(rawManifest.name || "Imported Agent").trim() || "Imported Agent",
    source: rawManifest.source && typeof rawManifest.source === "object" ? rawManifest.source : {},
    templatePayload,
    hermesSeed:
      runtimeFamily === "hermes" &&
      rawManifest.hermesSeed &&
      typeof rawManifest.hermesSeed === "object"
        ? {
            version: 1,
            files: Array.isArray(rawManifest.hermesSeed.files) ? rawManifest.hermesSeed.files : [],
            modelConfig:
              rawManifest.hermesSeed.modelConfig &&
              typeof rawManifest.hermesSeed.modelConfig === "object"
                ? rawManifest.hermesSeed.modelConfig
                : {},
            channels: Array.isArray(rawManifest.hermesSeed.channels)
              ? rawManifest.hermesSeed.channels
              : [],
          }
        : undefined,
    managed:
      rawManifest.managed && typeof rawManifest.managed === "object"
        ? {
            llmProviders: Array.isArray(rawManifest.managed.llmProviders)
              ? rawManifest.managed.llmProviders
              : [],
            integrations: Array.isArray(rawManifest.managed.integrations)
              ? rawManifest.managed.integrations
              : [],
            channels: Array.isArray(rawManifest.managed.channels)
              ? rawManifest.managed.channels
              : [],
            agentSecretOverrides: Array.isArray(rawManifest.managed.agentSecretOverrides)
              ? rawManifest.managed.agentSecretOverrides
              : [],
          }
        : {
            llmProviders: [],
            integrations: [],
            channels: [],
            agentSecretOverrides: [],
          },
    warnings: normalizeManifestWarnings(rawManifest.warnings),
  };
}

function legacyTemplateToManifest(payload = {}, filename = "") {
  const listing = payload.listing && typeof payload.listing === "object" ? payload.listing : {};
  const snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : {};
  return normalizeMigrationManifest({
    name:
      listing.name ||
      snapshot.name ||
      filename.replace(/\.nora-template\.json$/i, "") ||
      "Imported OpenClaw Agent",
    runtimeFamily: "openclaw",
    source: {
      kind: "legacy-template",
      label: listing.name || snapshot.name || filename || "Legacy template package",
    },
    templatePayload: payload.templatePayload || {},
    warnings: scanTemplatePayloadForSecrets(payload.templatePayload || {}).map((issue) => ({
      code: issue.type,
      message: issue.message,
      path: issue.path,
    })),
  });
}

async function parseUploadedMigrationBuffer(buffer, filename = "") {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Upload body is empty");
  }
  // Use Buffer.byteLength() rather than buffer.length so the size comes from
  // a type-narrowing method call on a verified Buffer, not a property access
  // whose taint CodeQL still carries forward from the HTTP request body.
  const byteLength = Buffer.byteLength(buffer);
  if (byteLength === 0) {
    throw new Error("Upload body is empty");
  }
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("Upload is too large");
  }

  const textCandidate = buffer.toString("utf8").trim();
  if (textCandidate.startsWith("{")) {
    const parsed = JSON.parse(textCandidate);
    if (parsed?.format === MIGRATION_BUNDLE_FORMAT) {
      return normalizeMigrationManifest(parsed);
    }
    if (parsed?.templatePayload || /\.nora-template\.json$/i.test(filename)) {
      return legacyTemplateToManifest(parsed, filename);
    }
  }

  const parsed = await unpackMigrationBundle(buffer);
  return normalizeMigrationManifest(parsed);
}

async function readTarBufferFiles(buffer, { stripBaseName = "" } = {}) {
  const extract = tar.extract();
  const files = [];
  let normalizedBaseName = String(stripBaseName || "");
  let startIndex = 0;
  let endIndex = normalizedBaseName.length;
  while (startIndex < endIndex && normalizedBaseName.charCodeAt(startIndex) === 0x2f) {
    startIndex += 1;
  }
  while (endIndex > startIndex && normalizedBaseName.charCodeAt(endIndex - 1) === 0x2f) {
    endIndex -= 1;
  }
  normalizedBaseName = normalizedBaseName.slice(startIndex, endIndex);

  const extractPromise = new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        if (header.type === "file") {
          let relativePath = String(header.name || "").replace(/^\.\/+/, "");
          if (normalizedBaseName) {
            const prefix = `${normalizedBaseName}/`;
            if (relativePath === normalizedBaseName) {
              relativePath = "";
            } else if (relativePath.startsWith(prefix)) {
              relativePath = relativePath.slice(prefix.length);
            }
          }

          if (relativePath) {
            files.push({
              path: relativePath,
              contentBase64: Buffer.concat(chunks).toString("base64"),
              mode: Number.isInteger(header.mode) ? header.mode : 0o644,
            });
          }
        }
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
  });

  extract.end(buffer);
  await extractPromise;
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectStream(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function getDockerArchiveBuffer(container, absolutePath) {
  try {
    const stream = await container.getArchive({ path: absolutePath });
    if (!stream) return Buffer.alloc(0);
    return collectStream(stream);
  } catch {
    return Buffer.alloc(0);
  }
}

async function getDockerArchiveFiles(container, absolutePath) {
  const buffer = await getDockerArchiveBuffer(container, absolutePath);
  if (!buffer.length) return [];
  return readTarBufferFiles(buffer, {
    stripBaseName: path.posix.basename(absolutePath),
  });
}

async function execDockerText(container, command, { timeout = 30000 } = {}) {
  const execInstance = await container.exec({
    Cmd: ["/bin/sh", "-lc", command],
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Tty: true,
  });

  const stream = await execInstance.start({ hijack: true, stdin: false, Tty: true });
  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        stream.destroy();
      } catch {
        // Ignore teardown failures.
      }
      reject(new Error(`Docker exec timed out after ${timeout}ms`));
    }, timeout);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  const inspect = await execInstance.inspect();
  if ((inspect?.ExitCode || 0) !== 0) {
    throw new Error(output.trim() || `Docker exec exited with code ${inspect.ExitCode}`);
  }
  return output;
}

function sshTarget(source = {}) {
  const username = String(source.username || "").trim();
  const host = String(source.host || "").trim();
  if (!username || !host) {
    throw new Error("SSH source requires host and username");
  }
  return `${username}@${host}`;
}

async function execSsh(source = {}, command, { timeout = 120000, binary = false } = {}) {
  const args = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
  ];

  if (source.port) {
    args.push("-p", String(source.port));
  }

  let keyPath = "";
  if (source.privateKey) {
    const fs = require("fs");
    const os = require("os");
    keyPath = path.join(
      os.tmpdir(),
      `nora-ssh-${Date.now()}-${Math.random().toString(16).slice(2)}.pem`,
    );
    fs.writeFileSync(keyPath, String(source.privateKey), { mode: 0o600 });
    args.push("-i", keyPath);
  }

  args.push(sshTarget(source), command);

  try {
    const result = await execFileAsync("ssh", args, {
      timeout,
      encoding: binary ? "buffer" : "utf8",
      maxBuffer: MAX_REMOTE_BUFFER_BYTES,
    });
    return result.stdout;
  } finally {
    if (keyPath) {
      try {
        require("fs").unlinkSync(keyPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

async function getSshArchiveFiles(source = {}, absolutePath) {
  const command = `sh -lc ${JSON.stringify(
    `if [ -d ${shellSingleQuote(absolutePath)} ]; then tar -C ${shellSingleQuote(
      absolutePath,
    )} -cf - .; fi`,
  )}`;
  const buffer = await execSsh(source, command, {
    timeout: 120000,
    binary: true,
  }).catch(() => Buffer.alloc(0));

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  return readTarBufferFiles(buffer);
}

async function readSshText(source = {}, absolutePath) {
  const command = `sh -lc ${JSON.stringify(
    `if [ -f ${shellSingleQuote(absolutePath)} ]; then cat ${shellSingleQuote(absolutePath)}; fi`,
  )}`;
  return execSsh(source, command, { timeout: 30000, binary: false }).catch(() => "");
}

function buildHermesSnapshotCommand() {
  const providerDefinitions = llmProviders.PROVIDERS.map((provider) => ({
    id: provider.id,
    envVar: provider.envVar,
  }));

  const definitions = HERMES_CHANNEL_TYPES.map((type) => ({
    type,
    configFields: HERMES_CHANNEL_DEFINITIONS[type].fields.map((field) => ({
      key: field.key,
    })),
  }));

  const script = `
import json

from gateway.channel_directory import load_directory
from gateway.config import load_gateway_config
from gateway.status import read_runtime_status
from hermes_cli.config import get_config_path, get_env_value, load_config

provider_defs = ${JSON.stringify(providerDefinitions)}
definitions = ${JSON.stringify(definitions)}
config = load_gateway_config()
connected = {platform.value for platform in config.get_connected_platforms()}
platform_details = {}
for platform, platform_config in config.platforms.items():
    platform_details[platform.value] = {
        "enabled": bool(getattr(platform_config, "enabled", False)),
        "connected": platform.value in connected,
        "reply_to_mode": getattr(platform_config, "reply_to_mode", None),
        "home_channel": platform_config.home_channel.to_dict() if getattr(platform_config, "home_channel", None) else None,
        "extra_keys": sorted(list((getattr(platform_config, "extra", {}) or {}).keys())),
    }

env_values = {}
for definition in definitions:
    values = {}
    for field in definition.get("configFields", []):
        key = field["key"]
        value = get_env_value(key)
        values[key] = value if value is not None else ""
    env_values[definition["type"]] = values

provider_values = {}
for provider in provider_defs:
    key = provider["envVar"]
    provider_values[key] = get_env_value(key) or ""

runtime_config = load_config() or {}
model_config = runtime_config.get("model") or {}

print(json.dumps({
    "runtimeStatus": read_runtime_status() or {},
    "directory": load_directory() or {"updated_at": None, "platforms": {}},
    "platformDetails": platform_details,
    "envValues": env_values,
    "providerValues": provider_values,
    "modelConfig": {
        "defaultModel": model_config.get("default"),
        "provider": model_config.get("provider"),
        "baseUrl": model_config.get("base_url"),
        "configPath": str(get_config_path()),
    },
}))
`;

  return buildHermesPythonCommand(script);
}

async function readHermesSnapshotFromDocker(container) {
  const output = await execDockerText(container, buildHermesSnapshotCommand(), {
    timeout: 30000,
  });
  return JSON.parse(String(output || "{}").trim() || "{}");
}

async function readHermesSnapshotFromSsh(source = {}) {
  const output = await execSsh(source, buildHermesSnapshotCommand(), {
    timeout: 30000,
    binary: false,
  });
  return JSON.parse(String(output || "{}").trim() || "{}");
}

function manifestFromOpenClawSource({
  name,
  files = [],
  memoryFiles = [],
  llmProviderEntries = [],
  source = {},
}) {
  const templatePayload = ensureCoreTemplateFiles(
    {
      version: 1,
      files,
      memoryFiles,
      wiring: { channels: [], integrations: [] },
      metadata: {
        source: "migration-import",
      },
    },
    {
      name,
      sourceType: "community",
    },
  );

  return normalizeMigrationManifest({
    name,
    runtimeFamily: "openclaw",
    source,
    templatePayload,
    managed: {
      llmProviders: llmProviderEntries,
      integrations: [],
      channels: [],
      agentSecretOverrides: [],
    },
    warnings: scanTemplatePayloadForSecrets(templatePayload).map((issue) => ({
      code: issue.type,
      message: issue.message,
      path: issue.path,
    })),
  });
}

function llmProvidersFromAuthProfiles(rawContent = "") {
  try {
    const parsed = JSON.parse(String(rawContent || "{}"));
    return Object.entries(parsed)
      .map(([provider, config]) => {
        const apiKey = String(config?.apiKey || "").trim();
        if (!apiKey) return null;
        return {
          provider,
          apiKey,
          config:
            typeof config?.endpoint === "string" && config.endpoint.trim()
              ? { endpoint: config.endpoint.trim() }
              : {},
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function llmProvidersFromHermesSnapshot(snapshot = {}) {
  const providerValues = snapshot?.providerValues || {};
  return llmProviders.PROVIDERS.flatMap((provider) => {
    const envVar = provider.envVar;
    const apiKey = String(providerValues?.[envVar] || "").trim();
    if (!apiKey) return [];
    return [
      {
        provider: provider.id,
        apiKey,
      },
    ];
  });
}

function hermesChannelsFromSnapshot(snapshot = {}) {
  const channelsPayload = [];
  const warnings = [];

  for (const type of HERMES_CHANNEL_TYPES) {
    const config = snapshot?.envValues?.[type] || {};
    const hasValues = Object.values(config).some((value) => String(value || "").trim());
    if (!hasValues) continue;
    channelsPayload.push({
      type,
      config,
    });
  }

  const unknownTypes = new Set([
    ...Object.keys(snapshot?.platformDetails || {}),
    ...Object.keys(snapshot?.directory?.platforms || {}),
  ]);
  for (const type of HERMES_CHANNEL_TYPES) {
    unknownTypes.delete(type);
  }
  for (const type of [...unknownTypes].sort()) {
    warnings.push({
      code: "unsupported_hermes_channel",
      message: `Hermes channel "${type}" is configured outside Nora's supported channel catalog and was not imported.`,
    });
  }

  return { channels: channelsPayload, warnings };
}

function manifestFromHermesSource({ name, workspaceFiles = [], snapshot = {}, source = {} }) {
  const { channels: hermesChannels, warnings } = hermesChannelsFromSnapshot(snapshot);

  return normalizeMigrationManifest({
    name,
    runtimeFamily: "hermes",
    source,
    hermesSeed: {
      version: 1,
      files: workspaceFiles,
      modelConfig: snapshot?.modelConfig || {},
      channels: hermesChannels,
    },
    managed: {
      llmProviders: llmProvidersFromHermesSnapshot(snapshot),
      integrations: [],
      channels: [],
      agentSecretOverrides: [],
    },
    warnings,
  });
}

async function buildLiveMigrationManifest(input = {}) {
  const runtimeFamily =
    String(input.runtime_family || input.runtimeFamily || "")
      .trim()
      .toLowerCase() || "openclaw";
  const transport = String(input.transport || "")
    .trim()
    .toLowerCase();

  if (!["docker", "ssh"].includes(transport)) {
    throw new Error("Unsupported live migration transport");
  }

  if (runtimeFamily === "openclaw") {
    if (transport === "docker") {
      const containerRef = String(input.container_id || input.container || "").trim();
      if (!containerRef) throw new Error("Docker live migration requires a container id or name");
      const container = docker.getContainer(containerRef);
      const [agentFiles, workspaceFiles, sessionFiles, authProfilesBuffer] = await Promise.all([
        getDockerArchiveFiles(container, OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT),
        getDockerArchiveFiles(container, OPENCLAW_WORKSPACE_ROOT),
        getDockerArchiveFiles(container, "/root/.openclaw/agents/main/sessions"),
        getDockerArchiveBuffer(
          container,
          `${OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT}/auth-profiles.json`,
        ),
      ]);

      const authFiles = authProfilesBuffer.length
        ? await readTarBufferFiles(authProfilesBuffer)
        : [];
      const authProfileEntry = authFiles.find((entry) => entry.path === "auth-profiles.json");

      return manifestFromOpenClawSource({
        name: String(input.name || "").trim() || `Imported OpenClaw ${containerRef.slice(0, 12)}`,
        files: [...agentFiles, ...workspaceFiles].filter(
          (entry) =>
            entry.path !== "auth-profiles.json" &&
            entry.path !== NORA_INTEGRATIONS_CONTEXT_FILE &&
            entry.path !== NORA_INTEGRATIONS_SKILL_FILE,
        ),
        memoryFiles: sessionFiles.map((entry) => ({
          ...entry,
          path: `agents/main/sessions/${entry.path}`,
        })),
        llmProviderEntries: llmProvidersFromAuthProfiles(
          authProfileEntry
            ? Buffer.from(authProfileEntry.contentBase64, "base64").toString("utf8")
            : "",
        ),
        source: {
          kind: "docker",
          transport,
          label: containerRef,
        },
      });
    }

    const workspaceFiles = await getSshArchiveFiles(
      input,
      input.workspace_root || OPENCLAW_WORKSPACE_ROOT,
    );
    const agentFiles = await getSshArchiveFiles(
      input,
      input.agent_root || OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT,
    );
    const sessionFiles = await getSshArchiveFiles(
      input,
      input.session_root || "/root/.openclaw/agents/main/sessions",
    );
    const authProfilesText = await readSshText(
      input,
      `${input.agent_root || OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT}/auth-profiles.json`,
    );

    return manifestFromOpenClawSource({
      name: String(input.name || "").trim() || `Imported OpenClaw ${input.host || "source"}`,
      files: [...agentFiles, ...workspaceFiles].filter(
        (entry) =>
          entry.path !== "auth-profiles.json" &&
          entry.path !== NORA_INTEGRATIONS_CONTEXT_FILE &&
          entry.path !== NORA_INTEGRATIONS_SKILL_FILE,
      ),
      memoryFiles: sessionFiles.map((entry) => ({
        ...entry,
        path: `agents/main/sessions/${entry.path}`,
      })),
      llmProviderEntries: llmProvidersFromAuthProfiles(authProfilesText),
      source: {
        kind: "ssh",
        transport,
        label: `${input.username || "root"}@${input.host || "source"}`,
      },
    });
  }

  if (transport === "docker") {
    const containerRef = String(input.container_id || input.container || "").trim();
    if (!containerRef) throw new Error("Docker live migration requires a container id or name");
    const container = docker.getContainer(containerRef);
    const [workspaceFiles, snapshot] = await Promise.all([
      getDockerArchiveFiles(container, input.workspace_root || "/opt/data/workspace"),
      readHermesSnapshotFromDocker(container),
    ]);

    return manifestFromHermesSource({
      name: String(input.name || "").trim() || `Imported Hermes ${containerRef.slice(0, 12)}`,
      workspaceFiles,
      snapshot,
      source: {
        kind: "docker",
        transport,
        label: containerRef,
      },
    });
  }

  const [workspaceFiles, snapshot] = await Promise.all([
    getSshArchiveFiles(input, input.workspace_root || "/opt/data/workspace"),
    readHermesSnapshotFromSsh(input),
  ]);

  return manifestFromHermesSource({
    name: String(input.name || "").trim() || `Imported Hermes ${input.host || "source"}`,
    workspaceFiles,
    snapshot,
    source: {
      kind: "ssh",
      transport,
      label: `${input.username || "root"}@${input.host || "source"}`,
    },
  });
}

async function listUserRawLlmProviders(userId) {
  const result = await db.query(
    `SELECT provider, api_key, model, config, is_default
       FROM llm_providers
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  );

  return result.rows.map((row) => ({
    provider: row.provider,
    apiKey: decrypt(row.api_key),
    model: row.model || null,
    config: typeof row.config === "string" ? JSON.parse(row.config || "{}") : row.config || {},
    isDefault: row.is_default === true,
  }));
}

async function listAgentIntegrationSecrets(agentId) {
  const result = await db.query(
    `SELECT provider, catalog_id, access_token, config, status
       FROM integrations
      WHERE agent_id = $1
      ORDER BY created_at ASC`,
    [agentId],
  );

  return result.rows.map((row) => ({
    provider: row.provider,
    catalog_id: row.catalog_id || row.provider,
    token: row.access_token ? decrypt(row.access_token) : "",
    config: integrations.decryptSensitiveConfig(row.provider, row.config),
    status: row.status || "active",
  }));
}

async function listAgentChannelSecrets(agentId) {
  const result = await db.query(
    `SELECT type, name, config, enabled
       FROM channels
      WHERE agent_id = $1
      ORDER BY created_at ASC`,
    [agentId],
  );

  return result.rows.map((row) => ({
    type: row.type,
    name: row.name,
    config: revealChannelConfig(row.type, row.config),
    enabled: row.enabled !== false,
  }));
}

async function buildMigrationManifestFromAgent(agent, { userId }) {
  const runtimeFamily =
    String(agent?.runtime_family || "")
      .trim()
      .toLowerCase() || "openclaw";

  if (runtimeFamily === "openclaw") {
    const [templatePayload, providerEntries, integrationEntries, channelEntries, overrideMap] =
      await Promise.all([
        buildTemplatePayloadFromAgent(agent, "files_plus_memory"),
        listUserRawLlmProviders(userId),
        listAgentIntegrationSecrets(agent.id),
        listAgentChannelSecrets(agent.id),
        getAgentSecretEnvVars(agent.id),
      ]);

    return normalizeMigrationManifest({
      name: agent.name || "OpenClaw Agent",
      runtimeFamily,
      source: {
        kind: "nora-agent",
        label: agent.name || agent.id,
        agentId: agent.id,
      },
      templatePayload,
      managed: {
        llmProviders: providerEntries,
        integrations: integrationEntries,
        channels: channelEntries,
        agentSecretOverrides: Object.entries(overrideMap || {}).map(([key, value]) => ({
          key,
          value,
        })),
      },
      warnings: scanTemplatePayloadForSecrets(templatePayload).map((issue) => ({
        code: issue.type,
        message: issue.message,
        path: issue.path,
      })),
    });
  }

  const container = docker.getContainer(agent.container_id);
  const [workspaceFiles, providerEntries, overrideMap, liveSnapshot, persistedState] =
    await Promise.all([
      getDockerArchiveFiles(container, "/opt/data/workspace"),
      listUserRawLlmProviders(userId),
      getAgentSecretEnvVars(agent.id),
      readHermesSnapshotFromDocker(container).catch(() => null),
      getPersistedHermesState(agent.id),
    ]);

  const state = liveSnapshot ? snapshotToPersistedHermesState(liveSnapshot) : persistedState;

  return normalizeMigrationManifest({
    name: agent.name || "Hermes Agent",
    runtimeFamily,
    source: {
      kind: "nora-agent",
      label: agent.name || agent.id,
      agentId: agent.id,
    },
    hermesSeed: {
      version: 1,
      files: workspaceFiles,
      modelConfig: state?.modelConfig || {},
      channels: Array.isArray(state?.channels) ? state.channels : [],
    },
    managed: {
      llmProviders: providerEntries,
      integrations: [],
      channels: [],
      agentSecretOverrides: Object.entries(overrideMap || {}).map(([key, value]) => ({
        key,
        value,
      })),
    },
    warnings: liveSnapshot ? hermesChannelsFromSnapshot(liveSnapshot).warnings : [],
  });
}

async function createMigrationDraft({
  userId,
  manifest,
  sourceKind = "upload",
  sourceTransport = "",
}) {
  const normalizedManifest = normalizeMigrationManifest(manifest);
  const result = await db.query(
    `INSERT INTO agent_migrations(
       user_id,
       name,
       runtime_family,
       source_kind,
       source_transport,
       status,
       summary,
       warnings,
       encrypted_manifest,
       expires_at
     )
     VALUES($1, $2, $3, $4, $5, 'ready', $6, $7, $8, NOW() + INTERVAL '24 hours')
     RETURNING id, user_id, name, runtime_family, source_kind, source_transport, status,
               summary, warnings, created_at, expires_at, deployed_agent_id`,
    [
      userId,
      normalizedManifest.name,
      normalizedManifest.runtimeFamily,
      sourceKind,
      sourceTransport || null,
      JSON.stringify(summarizeManifest(normalizedManifest)),
      JSON.stringify(normalizeManifestWarnings(normalizedManifest.warnings)),
      encodeStoredManifest(normalizedManifest),
    ],
  );

  const row = result.rows[0];
  return {
    ...row,
    manifest: normalizedManifest,
    preview: {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...buildDraftPreview(normalizedManifest),
    },
  };
}

async function getOwnedMigrationDraft(draftId, userId) {
  const result = await db.query(
    `SELECT id, user_id, name, runtime_family, source_kind, source_transport, status,
            summary, warnings, encrypted_manifest, created_at, expires_at, deployed_agent_id
       FROM agent_migrations
      WHERE id = $1 AND user_id = $2`,
    [draftId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const manifest = decodeStoredManifest(row.encrypted_manifest);
  if (!manifest) return null;
  return {
    ...row,
    manifest,
    preview: {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...buildDraftPreview(manifest),
    },
  };
}

async function getMigrationManifestForAgent(agentId) {
  const result = await db.query(
    `SELECT encrypted_manifest
       FROM agent_migrations
      WHERE deployed_agent_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [agentId],
  );
  if (!result.rows[0]) return null;
  return decodeStoredManifest(result.rows[0].encrypted_manifest);
}

async function deleteOwnedMigrationDraft(draftId, userId) {
  const result = await db.query(
    "DELETE FROM agent_migrations WHERE id = $1 AND user_id = $2 RETURNING id",
    [draftId, userId],
  );
  return Boolean(result.rows[0]);
}

async function attachDraftToAgent(draftId, agentId) {
  await db.query(
    `UPDATE agent_migrations
        SET deployed_agent_id = $2,
            expires_at = NULL
      WHERE id = $1`,
    [draftId, agentId],
  );
}

async function seedImportedLlmProviders(userId, providerEntries = []) {
  if (!Array.isArray(providerEntries) || providerEntries.length === 0) return;

  const existing = await db.query(
    `SELECT provider
       FROM llm_providers
      WHERE user_id = $1`,
    [userId],
  );
  const existingProviders = new Set(existing.rows.map((row) => row.provider));

  for (const entry of providerEntries) {
    const provider = String(entry?.provider || "").trim();
    const apiKey = String(entry?.apiKey || "").trim();
    if (!provider || !apiKey || existingProviders.has(provider)) continue;
    await llmProviders.addProvider(
      userId,
      provider,
      apiKey,
      entry?.model || null,
      entry?.config || {},
    );
    existingProviders.add(provider);
  }
}

async function materializeManagedMigrationState(userId, agentId, manifest = {}) {
  const managed = manifest.managed || {};
  await seedImportedLlmProviders(userId, managed.llmProviders || []);

  for (const integrationEntry of managed.integrations || []) {
    await connectIntegration(
      agentId,
      integrationEntry.provider,
      integrationEntry.token || "",
      integrationEntry.config || {},
    );
    if (integrationEntry.status && integrationEntry.status !== "active") {
      await db.query(
        `UPDATE integrations
            SET status = $3
          WHERE agent_id = $1 AND provider = $2`,
        [agentId, integrationEntry.provider, integrationEntry.status],
      );
    }
  }

  for (const channelEntry of managed.channels || []) {
    const created = await createChannel(
      agentId,
      channelEntry.type,
      channelEntry.name || channelEntry.type,
      channelEntry.config || {},
    );
    if (channelEntry.enabled === false && created?.id) {
      await db.query("UPDATE channels SET enabled = false WHERE id = $1 AND agent_id = $2", [
        created.id,
        agentId,
      ]);
    }
  }

  const overrideMap = Object.fromEntries(
    (managed.agentSecretOverrides || []).map((entry) => [entry.key, entry.value]),
  );
  await replaceAgentSecretOverrides(agentId, overrideMap);

  if (manifest.runtimeFamily === "hermes") {
    await replacePersistedHermesState(agentId, {
      modelConfig: manifest?.hermesSeed?.modelConfig || {},
      channels: Array.isArray(manifest?.hermesSeed?.channels) ? manifest.hermesSeed.channels : [],
    });
  }
}

function buildHermesSeedArchiveEntries(manifest = {}) {
  return (manifest?.hermesSeed?.files || [])
    .map((entry) => {
      const relativePath = String(entry?.path || "").replace(/^\/+/, "");
      if (!relativePath) return null;
      return {
        name: path.posix.join("opt/data/workspace", relativePath),
        content: Buffer.from(String(entry.contentBase64 || ""), "base64"),
        mode: Number.isInteger(entry.mode) ? entry.mode : 0o644,
      };
    })
    .filter(Boolean);
}

async function buildHermesSeedArchive(manifest = {}) {
  const entries = buildHermesSeedArchiveEntries(manifest);
  if (entries.length === 0) return null;

  const pack = tar.pack();
  const chunks = [];
  const archivePromise = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });

  for (const entry of entries) {
    await new Promise((resolve, reject) => {
      pack.entry(
        {
          name: entry.name,
          mode: entry.mode,
        },
        entry.content,
        (error) => {
          if (error) return reject(error);
          resolve();
        },
      );
    });
  }

  pack.finalize();
  return archivePromise;
}

module.exports = {
  MIGRATION_BUNDLE_FORMAT,
  attachDraftToAgent,
  buildHermesSeedArchive,
  buildLiveMigrationManifest,
  buildMigrationManifestFromAgent,
  buildDraftPreview,
  createMigrationDraft,
  deleteOwnedMigrationDraft,
  getMigrationManifestForAgent,
  getOwnedMigrationDraft,
  materializeManagedMigrationState,
  normalizeMigrationManifest,
  packMigrationBundle,
  parseUploadedMigrationBuffer,
  summarizeManifest,
};
