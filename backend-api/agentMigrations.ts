// @ts-nocheck
const path = require("path");
const { promisify } = require("util");
const { gzip, gunzip } = require("zlib");

const tar = require("tar-stream");
const Docker = require("dockerode");

const db = require("./db");
const llmProviders = require("./llmProviders");
const integrations = require("./integrations");
const channels = require("./channels");
const containerManager = require("./containerManager");
const {
  buildTemplatePayloadFromAgent,
  ensureCoreTemplateFiles,
  normalizeTemplatePayload,
  stripInternalTemplateMetadata,
} = require("./agentPayloads");
const {
  getAgentSecretEnvVars,
  listAgentSecretOverrides,
  replaceAgentSecretOverrides,
} = require("./agentSecretOverrides");
const { connectIntegration } = require("./integrations");
const { createChannel, revealChannelConfig } = require("./channels");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const { scanTemplatePayloadForSecrets } = require("./agentHubSafety");
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
  replacePersistedHermesState,
  snapshotToPersistedHermesState,
} = require("./hermesUi");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const MIGRATION_BUNDLE_FORMAT = "nora-migration-bundle/v1";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function captureAbortReason(signal, fallbackError = null) {
  if (!signal?.aborted) return null;
  if (signal.reason instanceof Error) return signal.reason;
  if (fallbackError instanceof Error) return fallbackError;
  const error = new Error("Agent migration capture was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfCaptureAborted(signal) {
  const error = captureAbortReason(signal);
  if (error) throw error;
}

function isCaptureAuthorizationError(error) {
  const code = String(error?.code || "");
  return (
    code === "REMOTE_HOST_ACCESS_REVOKED" ||
    code === "REMOTE_HOST_RETEST_REQUIRED" ||
    code.endsWith("AUTH_CHECK_FAILED")
  );
}

function rethrowCaptureAbortOrAuthorization(error, signal) {
  const abortReason = captureAbortReason(signal, error);
  if (abortReason) throw abortReason;
  if (isCaptureAuthorizationError(error)) throw error;
}

function raceWithCaptureAbort(promise, signal, onLateValue = null) {
  if (!signal) return Promise.resolve(promise);
  throwIfCaptureAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(captureAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          if (signal.aborted && typeof onLateValue === "function") onLateValue(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          if (typeof onLateValue === "function") onLateValue(value);
          reject(captureAbortReason(signal));
          return;
        }
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(captureAbortReason(signal, error) || error);
      },
    );
  });
}

// Manifest storage and presentation

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

/**
 * Build a migration preview that omits managed credential values from API responses.
 *
 * @param {Object} [manifest={}] - Normalized migration manifest.
 * @returns {Object} Counts, resource identifiers, source metadata, and Hermes model settings.
 */
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

// Bundle parsing and compatibility

/**
 * Package a migration manifest as Nora's gzipped tar bundle format.
 *
 * @param {Object} [manifest={}] - Manifest to store as `manifest.json`.
 * @returns {Promise<Buffer>} Compressed migration bundle.
 */
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

function normalizeHermesSeedFileEntry(entry, index = 0) {
  const rawPath = String(entry?.path || "");
  const portablePath = rawPath.replace(/\\/g, "/");
  const pathSegments = portablePath.split("/");
  const unsafe =
    !rawPath.trim() ||
    rawPath.includes("\0") ||
    path.posix.isAbsolute(portablePath) ||
    path.win32.isAbsolute(rawPath) ||
    pathSegments.some((segment) => segment === "..");
  if (unsafe) {
    const error = new Error(`Hermes seed file ${index + 1} has an unsafe path`);
    error.code = "UNSAFE_HERMES_SEED_PATH";
    throw error;
  }

  const normalizedPath = path.posix.normalize(portablePath).replace(/^\.\/+/, "");
  if (!normalizedPath || normalizedPath === ".") {
    const error = new Error(`Hermes seed file ${index + 1} has an empty path`);
    error.code = "UNSAFE_HERMES_SEED_PATH";
    throw error;
  }

  const requestedMode = Number.isInteger(entry?.mode) ? entry.mode : 0o644;
  return {
    path: normalizedPath,
    contentBase64: String(entry?.contentBase64 || ""),
    // Preserve normal rwx permissions while stripping setuid, setgid, sticky,
    // and file-type bits from untrusted migration manifests.
    mode: requestedMode & 0o777,
  };
}

function normalizeHermesSeedFiles(files = []) {
  return (Array.isArray(files) ? files : []).map(normalizeHermesSeedFileEntry);
}

/**
 * Canonicalize uploaded, live, or agent-derived state into the current manifest shape.
 *
 * @param {Object} [rawManifest={}] - Manifest-like input from a supported source.
 * @returns {Object} Versioned manifest with normalized runtime and managed state.
 */
function normalizeMigrationManifest(rawManifest = {}) {
  const runtimeFamily =
    String(rawManifest.runtimeFamily || rawManifest.runtime_family || "")
      .trim()
      .toLowerCase() || "openclaw";
  const templatePayload =
    runtimeFamily === "openclaw"
      ? ensureCoreTemplateFiles(stripInternalTemplateMetadata(rawManifest.templatePayload || {}), {
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
            files: normalizeHermesSeedFiles(rawManifest.hermesSeed.files),
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

/**
 * Parse a current-format JSON manifest, legacy template JSON, or gzipped
 * migration bundle within the configured size limit.
 *
 * @param {Buffer} buffer - Raw upload body.
 * @param {string} [filename=""] - Filename used to recognize legacy template packages.
 * @param {Object} [options={}] - Parsing limits; set `maxBytes` to `null` for trusted archives.
 * @returns {Promise<Object>} Normalized migration manifest.
 */
async function parseUploadedMigrationBuffer(buffer, filename = "", options = {}) {
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
  const maxBytes =
    options.maxBytes === null || options.maxBytes === Infinity
      ? null
      : Number.parseInt(options.maxBytes ?? MAX_UPLOAD_BYTES, 10);
  if (maxBytes != null && byteLength > maxBytes) {
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

// Live-source collection

/**
 * Decode regular files from a tar archive while rejecting paths that escape its base.
 *
 * @param {Buffer} buffer - Tar archive bytes.
 * @param {Object} [options={}] - Optional archive root name to strip.
 * @returns {Promise<Object[]>} Sorted files with Base64 content and modes.
 */
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
            // Zip-slip guard: reject absolute paths and any entry whose
            // normalized form escapes the implicit base. Downstream consumers
            // join `path` onto an agent's filesystem prefix; without this
            // check a tar entry like `../../etc/passwd` or `/etc/shadow`
            // would write outside the agent's directory.
            const isUnsafe =
              path.isAbsolute(relativePath) ||
              relativePath.includes("\0") ||
              path
                .normalize(relativePath)
                .split(/[\\/]/)
                .some((segment) => segment === "..");
            if (isUnsafe) {
              reject(new Error(`Refusing tar entry with unsafe path: ${header.name}`));
              return;
            }
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

async function collectStream(stream, { signal } = {}) {
  throwIfCaptureAborted(signal);
  const chunks = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    let ended = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      try {
        stream.destroy();
      } catch {
        // Best-effort transport teardown; the authorization error still wins.
      }
      settle(captureAbortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      ended = true;
      settle(null, Buffer.concat(chunks));
    });
    stream.on("close", () => {
      if (signal?.aborted) {
        settle(captureAbortReason(signal));
      } else if (!ended) {
        const error = new Error("Docker archive stream closed before end");
        error.code = "DOCKER_ARCHIVE_STREAM_TRUNCATED";
        settle(error);
      }
    });
    stream.on("error", (error) => settle(captureAbortReason(signal, error) || error));
    if (signal?.aborted) onAbort();
  });
}

function isDockerArchivePathMissingError(error) {
  const statusCode = Number(error?.statusCode || error?.status);
  if (statusCode !== 404) return false;
  const detail = [error?.message, error?.reason, error?.json?.message].filter(Boolean).join(" ");
  return /could not find the file .* in container|no such file or directory/i.test(detail);
}

async function getDockerArchiveBuffer(container, absolutePath, { signal } = {}) {
  try {
    throwIfCaptureAborted(signal);
    const stream = await raceWithCaptureAbort(
      container.getArchive({ path: absolutePath }),
      signal,
      (lateStream) => lateStream?.destroy?.(),
    );
    if (!stream) {
      const error = new Error("Docker archive request returned no stream");
      error.code = "DOCKER_ARCHIVE_STREAM_MISSING";
      throw error;
    }
    return await collectStream(stream, { signal });
  } catch (error) {
    rethrowCaptureAbortOrAuthorization(error, signal);
    if (isDockerArchivePathMissingError(error)) return Buffer.alloc(0);
    throw error;
  }
}

async function getDockerArchiveFiles(container, absolutePath, { signal } = {}) {
  const buffer = await getDockerArchiveBuffer(container, absolutePath, { signal });
  if (!buffer.length) return [];
  throwIfCaptureAborted(signal);
  return readTarBufferFiles(buffer, {
    stripBaseName: path.posix.basename(absolutePath),
  });
}

function createDockerExecCompletionError(message, cause = null) {
  const error = new Error(message);
  error.code = "DOCKER_EXEC_COMPLETION_UNCONFIRMED";
  if (cause) error.cause = cause;
  return error;
}

function isIgnorableDirectDockerStopError(error) {
  const statusCode = Number(error?.statusCode || error?.status);
  return (
    statusCode === 304 ||
    statusCode === 404 ||
    /already stopped|not running|no such container/i.test(String(error?.message || ""))
  );
}

async function stopDirectDockerContainerSafely(container) {
  try {
    await container.stop({ t: 10 });
  } catch (error) {
    if (!isIgnorableDirectDockerStopError(error)) throw error;
  }
}

async function stopManagedAgentAfterUnconfirmedDockerExec(agent) {
  try {
    await containerManager.stop(agent);
  } catch (error) {
    if (!containerManager.isIgnorableStopError?.(error)) throw error;
  }

  if (agent?.id) {
    await db.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [agent.id]);
    agent.status = "stopped";
  }
}

async function execDockerText(
  container,
  command,
  { timeout = 30000, signal, onUnconfirmedTermination = null } = {},
) {
  throwIfCaptureAborted(signal);
  let cleanupPromise = null;
  const ensureFailSafeCleanup = (cause) => {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve()
        .then(() => onUnconfirmedTermination?.(cause))
        .catch((cleanupError) => {
          cause.cleanupError = cleanupError;
        });
    }
    return cleanupPromise;
  };
  const execInstance = await raceWithCaptureAbort(
    container.exec({
      Cmd: ["/bin/sh", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: true,
    }),
    signal,
  );

  let stream;
  try {
    stream = await raceWithCaptureAbort(
      execInstance.start({ hijack: true, stdin: false, Tty: true }),
      signal,
      (lateStream) => lateStream?.destroy?.(),
    );
  } catch (error) {
    await ensureFailSafeCleanup(error);
    throw error;
  }
  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let ended = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const rejectUnconfirmed = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        stream.destroy();
      } catch {
        // Fail-safe cleanup below remains authoritative.
      }
      void ensureFailSafeCleanup(error).then(() => reject(error));
    };
    const onAbort = () => {
      rejectUnconfirmed(captureAbortReason(signal));
    };
    const timer = setTimeout(() => {
      rejectUnconfirmed(
        createDockerExecCompletionError(`Docker exec timed out after ${timeout}ms`),
      );
    }, timeout);
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      ended = true;
      if (signal?.aborted) {
        rejectUnconfirmed(captureAbortReason(signal));
        return;
      }
      settle(null, Buffer.concat(chunks).toString("utf8"));
    };

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.on("end", finish);
    stream.on("close", () => {
      if (!ended) {
        rejectUnconfirmed(createDockerExecCompletionError("Docker exec stream closed before end"));
      }
    });
    stream.on("error", (error) => {
      rejectUnconfirmed(
        captureAbortReason(signal, error) ||
          createDockerExecCompletionError("Docker exec stream failed", error),
      );
    });
    if (signal?.aborted) onAbort();
  });

  let inspect;
  try {
    throwIfCaptureAborted(signal);
    inspect = await raceWithCaptureAbort(execInstance.inspect(), signal);
  } catch (error) {
    await ensureFailSafeCleanup(error);
    throw error;
  }
  if (inspect?.Running !== false || !Number.isInteger(inspect?.ExitCode)) {
    const error = createDockerExecCompletionError(
      `Docker exec completion could not be confirmed (running=${String(inspect?.Running)}, exitCode=${String(inspect?.ExitCode)})`,
    );
    await ensureFailSafeCleanup(error);
    throw error;
  }
  if (inspect.ExitCode !== 0) {
    throw new Error(output.trim() || `Docker exec exited with code ${inspect.ExitCode}`);
  }
  return output;
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

function parseHermesSnapshotOutput(output) {
  const normalizedOutput = String(output || "").trim();
  if (!normalizedOutput) {
    const error = new Error("Hermes snapshot command returned empty output");
    error.code = "HERMES_SNAPSHOT_EMPTY";
    throw error;
  }
  return JSON.parse(normalizedOutput);
}

async function readHermesSnapshotFromDocker(
  container,
  { signal, onUnconfirmedTermination = null } = {},
) {
  const output = await execDockerText(container, buildHermesSnapshotCommand(), {
    timeout: 30000,
    signal,
    onUnconfirmedTermination,
  });
  throwIfCaptureAborted(signal);
  return parseHermesSnapshotOutput(output);
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

function createInvalidAuthProfilesError(message, cause = null) {
  const error = new Error(`Invalid source auth-profiles.json: ${message}`);
  error.code = "MIGRATION_AUTH_PROFILES_INVALID";
  error.statusCode = 400;
  if (cause) error.cause = cause;
  return error;
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function migrationProviderFromAuthProfile(profileId, config, { modern = false } = {}) {
  if (!isObjectRecord(config)) {
    throw createInvalidAuthProfilesError(`profile "${profileId}" must be an object`);
  }

  const profileType = String(config.type || "").trim();
  if (modern && profileType && profileType !== "api_key") return null;

  const provider = String(config.provider || (modern ? profileId.split(":")[0] : profileId)).trim();
  const apiKey = String(config.key || config.apiKey || "").trim();
  if (!provider) {
    throw createInvalidAuthProfilesError(`profile "${profileId}" is missing its provider`);
  }
  if (!apiKey) {
    throw createInvalidAuthProfilesError(`API-key profile "${profileId}" is missing its key`);
  }

  const endpoint = String(config.endpoint || "").trim();
  const apiVersion = String(config.api_version || config.apiVersion || "").trim();
  return {
    provider,
    apiKey,
    config: {
      ...(endpoint ? { endpoint } : {}),
      ...(apiVersion ? { api_version: apiVersion } : {}),
    },
  };
}

function llmProvidersFromAuthProfiles(rawContent = "") {
  const content = String(rawContent || "").trim();
  if (!content) return [];

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw createInvalidAuthProfilesError("file is not valid JSON", cause);
  }

  if (!isObjectRecord(parsed)) {
    throw createInvalidAuthProfilesError("top-level value must be an object");
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "profiles")) {
    if (!isObjectRecord(parsed.profiles)) {
      throw createInvalidAuthProfilesError('"profiles" must be an object');
    }
    return Object.entries(parsed.profiles)
      .map(([profileId, config]) =>
        migrationProviderFromAuthProfile(profileId, config, { modern: true }),
      )
      .filter(Boolean);
  }

  return Object.entries(parsed).map(([provider, config]) =>
    migrationProviderFromAuthProfile(provider, config),
  );
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

async function resolveHermesDockerContainer(
  agent,
  backendResolver = containerManager.backendFor,
  { signal } = {},
) {
  const backend = await raceWithCaptureAbort(backendResolver(agent), signal);
  if (!backend?.docker || typeof backend.docker.getContainer !== "function") {
    const err = new Error(
      `Hermes migration capture is not supported by the ${agent?.deploy_target || agent?.backend_type || "selected"} backend`,
    );
    err.statusCode = 409;
    err.code = "MIGRATION_CAPTURE_UNSUPPORTED";
    throw err;
  }
  return backend.docker.getContainer(agent.container_id);
}

function requireDockerLiveMigrationTransport(input = {}) {
  const transport = String(input.transport || "")
    .trim()
    .toLowerCase();
  if (transport !== "docker") {
    const error = new Error("Live migration inspection requires the local Docker transport");
    error.code = "LIVE_MIGRATION_DOCKER_ONLY";
    error.statusCode = 400;
    throw error;
  }
  return transport;
}

function requireDockerLiveMigrationContainer(input = {}) {
  const containerRef = String(input.container_id || input.container || "").trim();
  if (!containerRef) {
    const error = new Error("Docker live migration requires a container id or name");
    error.code = "MIGRATION_DOCKER_SOURCE_REQUIRED";
    error.statusCode = 400;
    throw error;
  }
  return containerRef;
}

/**
 * Inspect a local Docker source and convert its runtime files and managed credentials to a
 * manifest.
 *
 * @param {Object} [input={}] - Runtime family and local Docker source details.
 * @returns {Promise<Object>} Normalized secret-bearing migration manifest.
 */
async function buildLiveMigrationManifest(input = {}) {
  const runtimeFamily =
    String(input.runtime_family || input.runtimeFamily || "")
      .trim()
      .toLowerCase() || "openclaw";
  const transport = requireDockerLiveMigrationTransport(input);
  const containerRef = requireDockerLiveMigrationContainer(input);
  const container = docker.getContainer(containerRef);

  if (runtimeFamily === "openclaw") {
    const [agentFiles, workspaceFiles, sessionFiles, authProfilesBuffer] = await Promise.all([
      getDockerArchiveFiles(container, OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT),
      getDockerArchiveFiles(container, OPENCLAW_WORKSPACE_ROOT),
      getDockerArchiveFiles(container, "/root/.openclaw/agents/main/sessions"),
      getDockerArchiveBuffer(
        container,
        `${OPENCLAW_LEGACY_AGENT_TEMPLATE_ROOT}/auth-profiles.json`,
      ),
    ]);

    const authFiles = authProfilesBuffer.length ? await readTarBufferFiles(authProfilesBuffer) : [];
    const authProfileEntry = authFiles.find((entry) => entry.path === "auth-profiles.json");

    return manifestFromOpenClawSource({
      name: String(input.name || "").trim() || `Imported OpenClaw ${containerRef.slice(0, 12)}`,
      files: [...agentFiles, ...workspaceFiles].filter(
        (entry) =>
          entry.path !== "auth-profiles.json" &&
          entry.path !== "NORA_INTEGRATIONS.md" &&
          entry.path !== NORA_INTEGRATIONS_CONTEXT_FILE &&
          entry.path !== NORA_INTEGRATIONS_SKILL_FILE &&
          !entry.path.startsWith("integrations/"),
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

  const [workspaceFiles, snapshot] = await Promise.all([
    getDockerArchiveFiles(container, input.workspace_root || "/opt/data/workspace"),
    readHermesSnapshotFromDocker(container, {
      onUnconfirmedTermination: () => stopDirectDockerContainerSafely(container),
    }),
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

// Nora agent export and draft persistence

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

/**
 * Capture an agent's portable runtime state, including decrypted managed credentials.
 *
 * @param {Object} agent - Agent row to export.
 * @param {Object} [options={}] - Export owner and optional cancellation signal.
 * @returns {Promise<Object>} Normalized secret-bearing migration manifest.
 */
async function buildMigrationManifestFromAgent(agent, { userId, signal } = {}) {
  throwIfCaptureAborted(signal);
  const runtimeFamily =
    String(agent?.runtime_family || "")
      .trim()
      .toLowerCase() || "openclaw";

  if (runtimeFamily === "openclaw") {
    const [templatePayload, providerEntries, integrationEntries, channelEntries, overrideMap] =
      await Promise.all([
        buildTemplatePayloadFromAgent(agent, "files_plus_memory", { signal }),
        listUserRawLlmProviders(userId),
        listAgentIntegrationSecrets(agent.id),
        listAgentChannelSecrets(agent.id),
        getAgentSecretEnvVars(agent.id),
      ]);
    throwIfCaptureAborted(signal);

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

  if (typeof agent?.container_id !== "string" || agent.container_id.length === 0) {
    const err = new Error(
      "Cannot build Hermes migration manifest: agent has no container_id (still provisioning or destroyed)",
    );
    err.statusCode = 409;
    err.code = "NO_CONTAINER";
    throw err;
  }
  const container = await resolveHermesDockerContainer(agent, containerManager.backendFor, {
    signal,
  });
  const [workspaceFiles, providerEntries, overrideMap, liveSnapshot] = await Promise.all([
    getDockerArchiveFiles(container, "/opt/data/workspace", { signal }),
    listUserRawLlmProviders(userId),
    getAgentSecretEnvVars(agent.id),
    readHermesSnapshotFromDocker(container, {
      signal,
      onUnconfirmedTermination: () => stopManagedAgentAfterUnconfirmedDockerExec(agent),
    }),
  ]);
  throwIfCaptureAborted(signal);

  const state = snapshotToPersistedHermesState(liveSnapshot);

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
    warnings: hermesChannelsFromSnapshot(liveSnapshot).warnings,
  });
}

/**
 * Encrypt and persist a user-owned migration draft that expires after 24 hours.
 *
 * @param {Object} input - Owner, manifest, and source metadata.
 * @returns {Promise<Object>} Stored draft with its normalized manifest and safe preview.
 */
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

async function persistMigrationManifestForAgent({
  userId,
  agentId,
  manifest,
  sourceKind = "backup",
  sourceTransport = "managed-backup",
} = {}) {
  if (!userId || !agentId) {
    throw new Error("userId and agentId are required to persist an agent migration manifest");
  }

  const normalizedManifest = normalizeMigrationManifest(manifest);
  const result = await db.query(
    `INSERT INTO agent_migrations(
       user_id,
       deployed_agent_id,
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
     VALUES($1, $2, $3, $4, $5, $6, 'ready', $7, $8, $9, NULL)
     RETURNING id, user_id, deployed_agent_id, name, runtime_family, source_kind,
               source_transport, status, summary, warnings, created_at, expires_at`,
    [
      userId,
      agentId,
      normalizedManifest.name,
      normalizedManifest.runtimeFamily,
      sourceKind,
      sourceTransport || null,
      JSON.stringify(summarizeManifest(normalizedManifest)),
      JSON.stringify(normalizeManifestWarnings(normalizedManifest.warnings)),
      encodeStoredManifest(normalizedManifest),
    ],
  );

  return {
    ...result.rows[0],
    manifest: normalizedManifest,
  };
}

/**
 * Load and decrypt a migration draft only when it belongs to the requested user.
 *
 * @param {string} draftId - Draft identifier.
 * @param {string} userId - Expected owner identifier.
 * @returns {Promise<Object|null>} Draft, or `null` when absent or its plaintext is invalid JSON.
 * @throws {Error} Authenticated decryption failure for corrupted or mismatched-key data.
 */
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

/**
 * Load the latest migration manifest attached to a deployed agent for provisioning.
 *
 * @param {string} agentId - Deployed agent identifier.
 * @returns {Promise<Object|null>} Decrypted manifest when one is attached and valid JSON.
 * @throws {Error} Authenticated decryption failure for corrupted or mismatched-key data.
 */
async function getMigrationManifestForAgent(agentId) {
  const result = await db.query(
    `SELECT encrypted_manifest
       FROM agent_migrations
      WHERE deployed_agent_id = $1
      ORDER BY created_at DESC, id DESC
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

/**
 * Attach a draft to its deployed agent and remove its automatic expiration.
 *
 * @param {string} draftId - Migration draft identifier.
 * @param {string} agentId - Deployed agent identifier.
 * @returns {Promise<void>}
 */
async function attachDraftToAgent(draftId, agentId) {
  await db.query(
    `UPDATE agent_migrations
        SET deployed_agent_id = $2,
            expires_at = NULL
      WHERE id = $1`,
    [draftId, agentId],
  );
}

// Imported state materialization and Hermes seeding

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

/**
 * Apply imported providers, integrations, channels, overrides, and Hermes state to an agent.
 *
 * Existing LLM providers are preserved. Writes are not transactional, so a later failure may
 * leave earlier managed resources materialized.
 *
 * @param {string} userId - Owner receiving any missing LLM providers.
 * @param {string} agentId - Agent receiving imported managed state.
 * @param {Object} [manifest={}] - Normalized migration manifest.
 * @returns {Promise<void>}
 */
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
  return normalizeHermesSeedFiles(manifest?.hermesSeed?.files || [])
    .map((entry) => {
      return {
        name: path.posix.join("opt/data/workspace", entry.path),
        content: Buffer.from(String(entry.contentBase64 || ""), "base64"),
        mode: entry.mode,
      };
    })
    .filter(Boolean);
}

/**
 * Build a container-rooted tar archive for imported Hermes workspace files.
 *
 * @param {Object} [manifest={}] - Manifest containing Hermes seed files.
 * @returns {Promise<Buffer|null>} Tar archive, or `null` when there are no files.
 */
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
  persistMigrationManifestForAgent,
  resolveHermesDockerContainer,
  summarizeManifest,
  __test: Object.freeze({
    execDockerText,
    getDockerArchiveFiles,
    llmProvidersFromAuthProfiles,
    parseHermesSnapshotOutput,
    readHermesSnapshotFromDocker,
  }),
};
