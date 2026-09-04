// @ts-nocheck
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { gzip, createGzip } = require("zlib");

const tar = require("tar-stream");
const { Client: SshClient } = require("ssh2");

const db = require("./db");
const billing = require("./billing");
const { addBackupJob, addDeploymentJob, cancelDeploymentJobsForAgent } = require("./redisQueue");
const containerManager = require("./containerManager");
const { getBackupSettings, getBackupStorageConfig } = require("./platformSettings");
const {
  buildMigrationManifestFromAgent,
  createMigrationDraft,
  materializeManagedMigrationState,
  packMigrationBundle,
  parseUploadedMigrationBuffer,
  persistMigrationManifestForAgent,
} = require("./agentMigrations");
const {
  createEmptyTemplatePayload,
  materializeTemplateWiring,
  resolveContainerName,
  serializeAgent,
} = require("./agentPayloads");
const { getDefaultAgentImage } = require("../agent-runtime/lib/agentImages");
const { getRuntimeSelectionStatus } = require("../agent-runtime/lib/backendCatalog");
const { assertKubernetesExecutionTargetAvailable } = require("./kubernetesClusters");
const {
  assertRemoteHostAgentUse,
  assertRemoteHostExecutionTargetAvailable,
  isRemoteDockerAgent,
  toPublicRemoteHostAuthorizationError,
} = require("./remoteHosts");
const { buildAgentRuntimeFields, resolveRequestedRuntimeFields } = require("./agentRuntimeFields");
const { acquireAgentProvisionLock } = require("./agentProvisionLock");
const { buildPostgresCliConfig } = require("./lib/connectionConfig");

const gzipAsync = promisify(gzip);

const BACKUP_ENCRYPTION_MAGIC = "NORA-BACKUP-ENC-v1";
const BACKUP_ARCHIVE_FORMAT = "nora-backup-archive/v1";
const READY_STATUSES = new Set(["ready", "ready_with_warnings"]);
const BACKUP_SCHEDULE_FREQUENCIES = new Set(["hourly", "daily", "weekly"]);
const BACKUP_KINDS = new Set(["agent", "installation"]);
const REMOTE_HOST_AUTH_RECHECK_MS = Math.max(
  250,
  Number.parseInt(process.env.REMOTE_HOST_AUTH_RECHECK_MS || "1000", 10) || 1000,
);

// Shared normalization and serialization

function createHttpError(message, statusCode = 400, code = null, options = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  error.expose = options.expose ?? statusCode < 500;
  return error;
}

function normalizeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return typeof value === "object" ? value : fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeFrequency(value, fallback = "daily") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return BACKUP_SCHEDULE_FREQUENCIES.has(normalized) ? normalized : fallback;
}

/**
 * Compute the first hourly, daily, or weekly backup occurrence after a UTC timestamp.
 *
 * @param {Object} [schedule={}] - Frequency and UTC schedule fields.
 * @param {Date} [from=new Date()] - Exclusive starting point.
 * @returns {Date} Next scheduled run.
 */
function computeNextRunAt(schedule = {}, from = new Date()) {
  const frequency = normalizeFrequency(schedule.frequency, "daily");
  const hour = clampInteger(parseInteger(schedule.hour_utc ?? schedule.hourUtc, 2), 0, 23);
  const dayOfWeek = clampInteger(parseInteger(schedule.day_of_week ?? schedule.dayOfWeek, 0), 0, 6);
  const base = new Date(from);

  if (frequency === "hourly") {
    const next = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        base.getUTCHours() + 1,
        0,
        0,
        0,
      ),
    );
    return next;
  }

  const candidate = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, 0, 0, 0),
  );

  if (frequency === "daily") {
    if (candidate <= base) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate;
  }

  const daysUntilTarget = (dayOfWeek - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilTarget);
  if (candidate <= base) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate;
}

function serializeSchedule(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled === true,
    name: row.name || null,
    user_id: row.user_id || null,
    agent_id: row.agent_id || null,
    frequency: row.frequency || "daily",
    hour_utc: Number(row.hour_utc ?? 2),
    day_of_week: Number(row.day_of_week ?? 0),
    next_run_at: row.next_run_at || null,
    last_run_at: row.last_run_at || null,
    last_backup_id: row.last_backup_id || null,
    last_error: row.last_error || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function serializeBackup(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    name: row.name,
    agent_id: row.agent_id,
    user_id: row.user_id,
    storage_backend: row.storage_backend || null,
    size_bytes: Number(row.size_bytes || 0),
    checksum_sha256: row.checksum_sha256 || null,
    content_type: row.content_type || "application/gzip",
    format: row.format || BACKUP_ARCHIVE_FORMAT,
    scope: normalizeJson(row.scope, {}),
    summary: normalizeJson(row.summary, {}),
    warnings: normalizeJson(row.warnings, []),
    error: row.error || null,
    expires_at: row.expires_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

// Encryption and local storage

function requireBackupEncryptionKey() {
  const rawKey = String(process.env.NORA_BACKUP_ENCRYPTION_KEY || "")
    .split("#")[0]
    .trim();
  if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw createHttpError(
      "Managed backup storage requires NORA_BACKUP_ENCRYPTION_KEY to be configured with a valid 64-char hex key",
      503,
      "BACKUP_ENCRYPTION_NOT_CONFIGURED",
      { expose: true },
    );
  }
  return Buffer.from(rawKey, "hex");
}

/**
 * Encrypt an archive with the configured AES-256-GCM key and Nora framing metadata.
 *
 * @param {Buffer} buffer - Plain backup archive.
 * @returns {Buffer} Framed encrypted bytes suitable for managed storage.
 */
function encryptBackupBuffer(buffer) {
  const key = requireBackupEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from(
    `${BACKUP_ENCRYPTION_MAGIC}\n${iv.toString("hex")}:${tag.toString("hex")}\n`,
    "utf8",
  );
  return Buffer.concat([header, encrypted]);
}

/**
 * Authenticate and decrypt an archive in Nora's managed backup format.
 *
 * @param {Buffer} buffer - Framed encrypted backup bytes.
 * @returns {Buffer} Plain backup archive.
 */
function decryptBackupBuffer(buffer) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 256));
  if (!text.startsWith(`${BACKUP_ENCRYPTION_MAGIC}\n`)) {
    throw createHttpError("Backup archive is not encrypted with the expected Nora format", 500);
  }
  const firstNewline = buffer.indexOf(0x0a);
  const secondNewline = buffer.indexOf(0x0a, firstNewline + 1);
  const meta = buffer.toString("utf8", firstNewline + 1, secondNewline);
  const [ivHex, tagHex] = meta.split(":");
  const key = requireBackupEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(buffer.slice(secondNewline + 1)), decipher.final()]);
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertLocalStoragePath(storageKey, config = {}) {
  const root = path.resolve(config.localPath || "/var/lib/nora-backups");
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw createHttpError("Invalid backup storage key", 500);
  }
  return resolved;
}

function throwIfAborted(signal, where = "operation") {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error(`${where} aborted`);
    if (!reason.statusCode) reason.statusCode = 499;
    throw reason;
  }
}

async function putLocalObject(storageKey, buffer, config = {}, { signal } = {}) {
  throwIfAborted(signal, "backup write");
  const target = assertLocalStoragePath(storageKey, config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { mode: 0o600, signal });
}

async function getLocalObject(storageKey, config = {}, { signal } = {}) {
  throwIfAborted(signal, "backup read");
  return fs.readFile(assertLocalStoragePath(storageKey, config), { signal });
}

async function deleteLocalObject(storageKey, config = {}, { signal } = {}) {
  throwIfAborted(signal, "backup delete");
  try {
    await fs.unlink(assertLocalStoragePath(storageKey, config));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// S3-compatible storage

function hmac(key, value, encoding = null) {
  const digest = crypto.createHmac("sha256", key).update(value, "utf8");
  return encoding ? digest.digest(encoding) : digest.digest();
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function s3Config(config = {}) {
  const bucket = config.s3Bucket;
  const region =
    config.storageBackend === "r2" && (!config.s3Region || config.s3Region === "us-east-1")
      ? "auto"
      : config.s3Region || "us-east-1";
  const accessKeyId = config.s3AccessKeyId;
  const secretAccessKey = config.s3SecretAccessKey;
  const sessionToken = config.s3SessionToken;
  const endpoint = String(config.s3Endpoint || "").replace(/\/+$/, "");
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw createHttpError(
      "S3 backup storage is not fully configured",
      503,
      "BACKUP_S3_NOT_CONFIGURED",
      {
        expose: true,
      },
    );
  }
  return { bucket, region, accessKeyId, secretAccessKey, sessionToken, endpoint };
}

function encodeS3Key(key) {
  return String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function s3Request(method, storageKey, body = null, rawConfig = {}, { signal } = {}) {
  throwIfAborted(signal, "S3 request");
  const config = s3Config(rawConfig);
  const payload = body || Buffer.alloc(0);
  const encodedKey = encodeS3Key(storageKey);
  const pathStyle = Boolean(config.endpoint);
  const baseUrl = config.endpoint || `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  const parsedBase = new URL(baseUrl);
  const canonicalUri = pathStyle ? `/${config.bucket}/${encodedKey}` : `/${encodedKey}`;
  const url = new URL(canonicalUri, baseUrl);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers = {
    host: parsedBase.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  if (method === "PUT") headers["content-type"] = "application/octet-stream";

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method,
    headers,
    signal,
    ...(method === "PUT" ? { body: payload } : {}),
  });
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    const message = await response.text().catch(() => "");
    throw createHttpError(
      message || `S3 backup storage request failed with ${response.status}`,
      502,
    );
  }
  if (method === "GET") return Buffer.from(await response.arrayBuffer());
  return null;
}

// SSH/SFTP storage

function sshRemoteObjectPath(config = {}, storageKey = "") {
  const base = path.posix.normalize(
    String(config.sshRemotePath || "/backups/nora").replace(/\/+$/, ""),
  );
  const normalizedKey = String(storageKey).replace(/^\/+/, "");
  const resolved = path.posix.normalize(path.posix.join(base, normalizedKey));
  if (base !== "/" && !resolved.startsWith(`${base}/`)) {
    throw createHttpError("Invalid backup storage key", 500);
  }
  return resolved;
}

function connectSsh(config = {}, { signal } = {}) {
  if (!config.sshHost || !config.sshUsername) {
    throw createHttpError(
      "SSH backup storage requires a host and username",
      503,
      "BACKUP_SSH_NOT_CONFIGURED",
      {
        expose: true,
      },
    );
  }
  if (!config.sshPrivateKey && !config.sshPassword) {
    throw createHttpError(
      "SSH backup storage requires a private key or password",
      503,
      "BACKUP_SSH_NOT_CONFIGURED",
      { expose: true },
    );
  }
  throwIfAborted(signal, "SSH connect");

  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let onAbort;
    if (signal) {
      onAbort = () => {
        try {
          client.end();
        } catch {
          /* best effort */
        }
        const reason = signal.reason instanceof Error ? signal.reason : new Error("SSH aborted");
        if (!reason.statusCode) reason.statusCode = 499;
        reject(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const settle = (fn) => (arg) => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };
    client
      .once("ready", () => settle(resolve)(client))
      .once("error", settle(reject))
      .connect({
        host: config.sshHost,
        port: config.sshPort || 22,
        username: config.sshUsername,
        ...(config.sshPrivateKey ? { privateKey: config.sshPrivateKey } : {}),
        ...(config.sshPassword ? { password: config.sshPassword } : {}),
        readyTimeout: 30000,
      });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error);
      resolve(sftp);
    });
  });
}

function sftpMkdir(sftp, directory) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(directory, { mode: 0o700 }, (error) => {
      if (error && error.code !== 4) return reject(error);
      resolve();
    });
  });
}

async function ensureSftpDirectory(sftp, directory) {
  const normalized = path.posix.normalize(directory);
  const parts = normalized.split("/").filter(Boolean);
  let current = normalized.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    await sftpMkdir(sftp, current).catch(() => {});
  }
}

function sftpWriteFile(sftp, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, buffer, { mode: 0o600 }, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function sftpReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) return reject(error);
      resolve(Buffer.from(data));
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error && error.code !== 2) return reject(error);
      resolve();
    });
  });
}

async function withSftp(config, callback, { signal } = {}) {
  const client = await connectSsh(config, { signal });
  let onAbort;
  if (signal) {
    onAbort = () => {
      try {
        client.end();
      } catch {
        /* best effort */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const sftp = await openSftp(client);
    return await callback(sftp);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    client.end();
  }
}

async function putSshObject(storageKey, buffer, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  await withSftp(
    config,
    async (sftp) => {
      await ensureSftpDirectory(sftp, path.posix.dirname(remotePath));
      await sftpWriteFile(sftp, remotePath, buffer);
    },
    { signal },
  );
}

async function getSshObject(storageKey, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  return withSftp(config, (sftp) => sftpReadFile(sftp, remotePath), { signal });
}

async function deleteSshObject(storageKey, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  return withSftp(config, (sftp) => sftpUnlink(sftp, remotePath), { signal });
}

// Storage backend selection

async function backupStorageConfig() {
  return getBackupStorageConfig();
}

function backupStorageConfigSnapshot(config = {}) {
  return {
    storageBackend: config.storageBackend || "local",
    localPath: config.localPath || "",
    s3Bucket: config.s3Bucket || "",
    s3Region: config.s3Region || "",
    s3Endpoint: config.s3Endpoint || "",
    sshHost: config.sshHost || "",
    sshPort: config.sshPort || 22,
    sshUsername: config.sshUsername || "",
    sshRemotePath: config.sshRemotePath || "",
  };
}

/**
 * Rehydrate a backup's captured storage location with the current secret credentials.
 *
 * @param {Object} [backup={}] - Backup row with backend and non-secret config snapshot.
 * @returns {Promise<Object>} Storage config capable of reading or deleting the object.
 */
async function backupStorageConfigForBackup(backup = {}) {
  const config = await backupStorageConfig();
  const snapshot = normalizeJson(backup.storage_config, {});
  return {
    ...config,
    ...snapshot,
    storageBackend: backup.storage_backend || snapshot.storageBackend || config.storageBackend,
    s3AccessKeyId: config.s3AccessKeyId,
    s3SecretAccessKey: config.s3SecretAccessKey,
    s3SessionToken: config.s3SessionToken,
    sshPrivateKey: config.sshPrivateKey,
    sshPassword: config.sshPassword,
  };
}

async function putStorageObject(storageKey, buffer, config = null, { signal } = {}) {
  const resolved = config || (await backupStorageConfig());
  if (resolved.storageBackend === "s3" || resolved.storageBackend === "r2") {
    return s3Request("PUT", storageKey, buffer, resolved, { signal });
  }
  if (resolved.storageBackend === "ssh")
    return putSshObject(storageKey, buffer, resolved, { signal });
  return putLocalObject(storageKey, buffer, resolved, { signal });
}

async function getStorageObject(storageKey, config = null, { signal } = {}) {
  const resolved = config || (await backupStorageConfig());
  if (resolved.storageBackend === "s3" || resolved.storageBackend === "r2") {
    return s3Request("GET", storageKey, null, resolved, { signal });
  }
  if (resolved.storageBackend === "ssh") return getSshObject(storageKey, resolved, { signal });
  return getLocalObject(storageKey, resolved, { signal });
}

async function deleteStorageObject(storageKey, config = null, { signal } = {}) {
  if (!storageKey) return;
  const resolved = config || (await backupStorageConfig());
  if (resolved.storageBackend === "s3" || resolved.storageBackend === "r2") {
    return s3Request("DELETE", storageKey, null, resolved, { signal });
  }
  if (resolved.storageBackend === "ssh") return deleteSshObject(storageKey, resolved, { signal });
  return deleteLocalObject(storageKey, resolved, { signal });
}

// Backup records and schedules

async function loadOwnedAgent(agentId, userId) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    agentId,
    userId,
  ]);
  return result.rows[0] || null;
}

/**
 * Load a backup with optional owner and agent constraints, excluding soft-deleted rows by default.
 *
 * @param {string} backupId - Backup identifier.
 * @param {Object} [options={}] - Optional ownership, agent, and deletion filters.
 * @returns {Promise<Object|null>} Matching backup row.
 */
async function loadBackup(
  backupId,
  { userId = null, agentId = null, includeDeleted = false } = {},
) {
  const params = [backupId];
  let userClause = "";
  if (userId) {
    params.push(userId);
    userClause = `AND user_id = $${params.length}`;
  }
  let agentClause = "";
  if (agentId) {
    params.push(agentId);
    agentClause = `AND agent_id = $${params.length}`;
  }
  const deletedClause = includeDeleted ? "" : "AND status <> 'deleted'";
  const result = await db.query(
    `SELECT *
       FROM backups
      WHERE id = $1
        ${userClause}
        ${agentClause}
        ${deletedClause}
      LIMIT 1`,
    params,
  );
  return result.rows[0] || null;
}

function expiresAtForSubscription(subscription = {}) {
  const days = Number.parseInt(subscription.backup_retention_days, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 86400000);
}

/**
 * Validate ownership, entitlement, and encryption before creating a queued agent backup.
 *
 * This function persists the backup record but leaves queue submission to its caller.
 *
 * @param {Object} input - Owner, agent, actor, and optional backup name.
 * @returns {Promise<Object>} Serialized queued backup.
 */
async function createAgentBackup({ userId, agentId, actorId = userId, name = "" } = {}) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);

  // Reject before persisting/queueing a backup. The archive path may use live
  // runtime HTTP or Docker-over-SSH, both of which require the current host
  // owner's positive grant rather than stale agent ownership alone.
  await assertRemoteHostAgentUse(agent, { includeProfile: false });

  const limits = await billing.enforceBackupLimits(userId, { agentId });
  if (!limits.allowed) {
    const error = createHttpError(limits.error, 402);
    error.subscription = limits.subscription;
    throw error;
  }

  requireBackupEncryptionKey();
  const storageConfig = await backupStorageConfig();
  const runtimeFields = buildAgentRuntimeFields(agent);
  const requestedName = String(name || "").trim();
  const backupName = requestedName || `${agent.name || "Agent"} backup`;
  const result = await db.query(
    `INSERT INTO backups(
       user_id,
       agent_id,
       kind,
       status,
       name,
       storage_backend,
       content_type,
       format,
       scope,
       summary,
       warnings,
       created_by,
       expires_at
     )
     VALUES($1, $2, 'agent', 'queued', $3, $4, 'application/gzip', $5, $6, '{}', '[]', $7, $8)
     RETURNING *`,
    [
      userId,
      agent.id,
      backupName.slice(0, 160),
      storageConfig.storageBackend,
      BACKUP_ARCHIVE_FORMAT,
      JSON.stringify({
        agent: {
          id: agent.id,
          name: agent.name,
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          executionTargetId: runtimeFields.execution_target_id,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
      actorId,
      expiresAtForSubscription(limits.subscription),
    ],
  );
  return serializeBackup(result.rows[0]);
}

/**
 * Create a queued installation backup using the currently selected storage backend.
 *
 * Authorization and queue submission remain the caller's responsibility.
 *
 * @param {Object} input - Actor and optional backup name.
 * @returns {Promise<Object>} Serialized queued backup.
 */
async function createInstallationBackup({ actorId, name = "" } = {}) {
  requireBackupEncryptionKey();
  const storageConfig = await backupStorageConfig();
  const backupName = String(name || "").trim() || "Installation backup";
  const result = await db.query(
    `INSERT INTO backups(
       user_id,
       kind,
       status,
       name,
       storage_backend,
       content_type,
       format,
       scope,
       summary,
       warnings,
       created_by
     )
     VALUES($1, 'installation', 'queued', $2, $3, 'application/gzip', $4, $5, '{}', '[]', $1)
     RETURNING *`,
    [
      actorId,
      backupName.slice(0, 160),
      storageConfig.storageBackend,
      BACKUP_ARCHIVE_FORMAT,
      JSON.stringify({ installation: true }),
    ],
  );
  return serializeBackup(result.rows[0]);
}

async function listAgentBackups(userId, agentId) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);
  const [rows, subscription, usage] = await Promise.all([
    db.query(
      `SELECT *
         FROM backups
        WHERE user_id = $1
          AND agent_id = $2
          AND kind = 'agent'
          AND status <> 'deleted'
        ORDER BY created_at DESC`,
      [userId, agentId],
    ),
    billing.getSubscription(userId),
    billing.getBackupUsage(userId, { agentId }),
  ]);
  return {
    backups: rows.rows.map(serializeBackup),
    entitlement: subscription,
    usage,
  };
}

/**
 * List every agent backup a user owns, including backups whose source agent has
 * been deleted.
 *
 * listAgentBackups() resolves the agent first and 404s when it is gone, which
 * made backups unreachable in exactly the disaster-recovery case the feature
 * exists for (#338). This resolves by owner instead, and LEFT JOINs agents so
 * callers can tell an orphaned backup from a live one rather than guessing.
 *
 * @param {string} userId - Backup owner.
 * @returns {Promise<Object>} Owned agent backups, entitlement, and usage.
 */
async function listUserBackups(userId) {
  const [rows, subscription, usage] = await Promise.all([
    db.query(
      `SELECT b.*, a.name AS agent_name, (a.id IS NOT NULL) AS agent_exists
         FROM backups b
         LEFT JOIN agents a ON a.id = b.agent_id AND a.user_id = b.user_id
        WHERE b.user_id = $1
          AND b.kind = 'agent'
          AND b.status <> 'deleted'
        ORDER BY b.created_at DESC`,
      [userId],
    ),
    billing.getSubscription(userId),
    billing.getBackupUsage(userId, {}),
  ]);
  return {
    backups: rows.rows.map((row) => ({
      ...serializeBackup(row),
      agent_name: row.agent_name || null,
      // Restoring an orphaned backup provisions a fresh agent; the UI needs to
      // say so rather than implying it restores into something still running.
      agent_exists: row.agent_exists === true,
    })),
    entitlement: subscription,
    usage,
  };
}

async function listAdminBackups() {
  const result = await db.query(
    `SELECT b.*, u.email AS owner_email, a.name AS agent_name
       FROM backups b
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN agents a ON a.id = b.agent_id
      WHERE b.status <> 'deleted'
      ORDER BY b.created_at DESC
      LIMIT 200`,
  );
  return result.rows.map((row) => ({
    ...serializeBackup(row),
    owner_email: row.owner_email || null,
    agent_name: row.agent_name || null,
  }));
}

async function getAgentBackupSchedule(userId, agentId) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);
  const [scheduleResult, subscription] = await Promise.all([
    db.query(
      `SELECT *
         FROM backup_schedules
        WHERE kind = 'agent'
          AND user_id = $1
          AND agent_id = $2
        LIMIT 1`,
      [userId, agentId],
    ),
    billing.getSubscription(userId),
  ]);
  return {
    schedule: serializeSchedule(scheduleResult.rows[0]) || {
      kind: "agent",
      enabled: false,
      frequency: "daily",
      hour_utc: 2,
      day_of_week: 0,
      user_id: userId,
      agent_id: agentId,
    },
    entitlement: subscription,
  };
}

/**
 * Upsert an agent backup schedule after enforcing ownership and managed-backup entitlement.
 *
 * @param {string} userId - Agent owner.
 * @param {string} agentId - Scheduled agent.
 * @param {Object} [input={}] - Enabled state and UTC cadence fields.
 * @returns {Promise<Object>} Updated schedule and entitlement.
 */
async function updateAgentBackupSchedule(userId, agentId, input = {}) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);

  const subscription = await billing.getSubscription(userId);
  const enabled = parseBoolean(input.enabled, false);
  if (enabled && !subscription.managed_backups_enabled) {
    throw createHttpError("Scheduled managed backups are not available on your current plan.", 402);
  }

  const frequency = normalizeFrequency(input.frequency, "daily");
  const hourUtc = clampInteger(parseInteger(input.hour_utc ?? input.hourUtc, 2), 0, 23);
  const dayOfWeek = clampInteger(parseInteger(input.day_of_week ?? input.dayOfWeek, 0), 0, 6);
  const nextRunAt = enabled
    ? computeNextRunAt({ frequency, hour_utc: hourUtc, day_of_week: dayOfWeek })
    : null;

  const result = await db.query(
    `INSERT INTO backup_schedules(
       schedule_key,
       kind,
       user_id,
       agent_id,
       enabled,
       name,
       frequency,
       hour_utc,
       day_of_week,
       next_run_at,
       created_by,
       updated_at
     )
     VALUES($1, 'agent', $2, $3, $4, $5, $6, $7, $8, $9, $2, NOW())
     ON CONFLICT (schedule_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       name = EXCLUDED.name,
       frequency = EXCLUDED.frequency,
       hour_utc = EXCLUDED.hour_utc,
       day_of_week = EXCLUDED.day_of_week,
       next_run_at = EXCLUDED.next_run_at,
       last_error = NULL,
       updated_at = NOW()
     RETURNING *`,
    [
      `agent:${agentId}`,
      userId,
      agentId,
      enabled,
      String(input.name || `${agent.name || "Agent"} scheduled backup`).slice(0, 160),
      frequency,
      hourUtc,
      dayOfWeek,
      nextRunAt,
    ],
  );

  return {
    schedule: serializeSchedule(result.rows[0]),
    entitlement: subscription,
  };
}

/**
 * Mirror installation backup settings into the scheduler row without needlessly shifting its run.
 *
 * @param {string|null} [actorId=null] - Actor recorded when the row is first created.
 * @returns {Promise<Object>} Serialized installation schedule.
 */
async function syncInstallationScheduleFromSettings(actorId = null) {
  const settings = await getBackupSettings();
  const enabled = settings.installationScheduleEnabled === true;
  const frequency = normalizeFrequency(settings.installationScheduleFrequency, "daily");
  const hourUtc = clampInteger(parseInteger(settings.installationScheduleHourUtc, 2), 0, 23);
  const dayOfWeek = clampInteger(parseInteger(settings.installationScheduleDayOfWeek, 0), 0, 6);
  const nextRunAt = enabled
    ? computeNextRunAt({ frequency, hour_utc: hourUtc, day_of_week: dayOfWeek })
    : null;

  const result = await db.query(
    `INSERT INTO backup_schedules(
       schedule_key,
       kind,
       enabled,
       name,
       frequency,
       hour_utc,
       day_of_week,
       next_run_at,
       created_by,
       updated_at
     )
     VALUES('installation', 'installation', $1, 'Installation backup schedule', $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (schedule_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       frequency = EXCLUDED.frequency,
       hour_utc = EXCLUDED.hour_utc,
       day_of_week = EXCLUDED.day_of_week,
       next_run_at = CASE
         WHEN EXCLUDED.enabled = false THEN NULL
         WHEN backup_schedules.enabled IS DISTINCT FROM EXCLUDED.enabled
           OR backup_schedules.frequency IS DISTINCT FROM EXCLUDED.frequency
           OR backup_schedules.hour_utc IS DISTINCT FROM EXCLUDED.hour_utc
           OR backup_schedules.day_of_week IS DISTINCT FROM EXCLUDED.day_of_week
         THEN EXCLUDED.next_run_at
         ELSE backup_schedules.next_run_at
       END,
       updated_at = NOW()
     RETURNING *`,
    [enabled, frequency, hourUtc, dayOfWeek, nextRunAt, actorId],
  );
  return serializeSchedule(result.rows[0]);
}

/**
 * Claim due schedules, create their backup records, and enqueue each job independently.
 *
 * @param {Object} [options={}] - Maximum number of due rows to inspect.
 * @returns {Promise<Object[]>} Per-schedule queued or failed outcomes.
 */
async function processDueSchedules({ limit = 20 } = {}) {
  await syncInstallationScheduleFromSettings();
  const due = await db.query(
    `SELECT *
       FROM backup_schedules
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= NOW()
      ORDER BY next_run_at ASC
      LIMIT $1`,
    [limit],
  );

  const results = [];
  for (const schedule of due.rows) {
    const nextRunAt = computeNextRunAt(schedule);
    const claimed = await db.query(
      `UPDATE backup_schedules
          SET last_run_at = NOW(),
              next_run_at = $2,
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND enabled = true
          AND next_run_at <= NOW()
        RETURNING *`,
      [schedule.id, nextRunAt],
    );
    const row = claimed.rows[0];
    if (!row) continue;

    try {
      const backup =
        row.kind === "installation"
          ? await createInstallationBackup({
              actorId: row.created_by || row.user_id,
              name: "Scheduled installation backup",
            })
          : await createAgentBackup({
              userId: row.user_id,
              agentId: row.agent_id,
              actorId: row.created_by || row.user_id,
              name: "Scheduled agent backup",
            });
      await addBackupJob({ backupId: backup.id, scheduleId: row.id });
      await db.query(
        `UPDATE backup_schedules
            SET last_backup_id = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, backup.id],
      );
      results.push({ scheduleId: row.id, backupId: backup.id, status: "queued" });
    } catch (error) {
      await db.query(
        `UPDATE backup_schedules
            SET last_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, String(error.message || error).slice(0, 2000)],
      );
      results.push({ scheduleId: row.id, status: "failed", error: error.message });
    }
  }

  return results;
}

// Archive construction and job execution

/**
 * Derive a storage key only for allowlisted backup kinds.
 *
 * @param {Object} backup - Backup row with an ID and kind.
 * @returns {string} Backend-neutral encrypted object key.
 */
function storageKeyForBackup(backup) {
  if (!BACKUP_KINDS.has(backup?.kind)) {
    throw createHttpError(`Invalid backup kind: ${backup?.kind}`, 500);
  }
  return `${backup.kind}/${backup.id}.tgz.enc`;
}

async function markBackupFailed(backupId, error) {
  await db.query(
    `UPDATE backups
        SET status = 'failed',
            error = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [backupId, String(error?.message || error || "Backup failed").slice(0, 2000)],
  );
}

async function updateBackupRunning(backupId) {
  await db.query(
    `UPDATE backups
        SET status = 'running',
            error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [backupId],
  );
}

/**
 * Encrypt, upload, and finalize a running backup while retaining cleanup metadata on failure.
 *
 * @param {Object} backup - Running backup row.
 * @param {Buffer} archiveBuffer - Plain archive bytes.
 * @param {Object} [options={}] - Summary, warnings, and cancellation signal.
 * @returns {Promise<Object>} Serialized completed backup.
 */
async function completeBackup(backup, archiveBuffer, { summary = {}, warnings = [], signal } = {}) {
  throwIfAborted(signal, "backup completion");
  await enforceBackupStorageCapacity(backup, archiveBuffer);
  const storageConfig = await backupStorageConfig();
  const storageKey = storageKeyForBackup(backup);

  // Two-phase commit: claim the storage_key on the row before uploading so
  // pruneExpiredBackups can find the bytes if anything between here and the
  // final transition fails. The row also won't get re-uploaded by an admin
  // hitting an already-completed backup id (`status = 'running'` guard).
  const claim = await db.query(
    `UPDATE backups
        SET storage_backend = $2,
            storage_key = $3,
            storage_config = $4,
            updated_at = NOW()
      WHERE id = $1 AND status = 'running'
      RETURNING id`,
    [
      backup.id,
      storageConfig.storageBackend,
      storageKey,
      JSON.stringify(backupStorageConfigSnapshot(storageConfig)),
    ],
  );
  if (claim.rowCount === 0) {
    throw createHttpError(`Backup ${backup.id} is not in 'running' state`, 409);
  }

  throwIfAborted(signal, "backup upload");
  const encrypted = encryptBackupBuffer(archiveBuffer);
  await putStorageObject(storageKey, encrypted, storageConfig, { signal });

  const status = warnings.length > 0 ? "ready_with_warnings" : "ready";
  const result = await db.query(
    `UPDATE backups
        SET status = $2,
            size_bytes = $3,
            checksum_sha256 = $4,
            summary = $5,
            warnings = $6,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      backup.id,
      status,
      archiveBuffer.length,
      sha256Hex(archiveBuffer),
      JSON.stringify(summary),
      JSON.stringify(warnings),
    ],
  );
  return serializeBackup(result.rows[0]);
}

async function enforceBackupStorageCapacity(backup, archiveBuffer) {
  if (backup.kind !== "agent" || !backup.user_id) return;
  const subscription = await billing.getSubscription(backup.user_id);
  if (billing.IS_PAAS && billing.BILLING_ENABLED && subscription.status !== "active") {
    throw createHttpError("Subscription is not active", 402);
  }
  if (!subscription.managed_backups_enabled) {
    throw createHttpError("Managed backups are not available on your current plan.", 402);
  }

  const storageLimitBytes = Number.isInteger(subscription.backup_storage_mb)
    ? subscription.backup_storage_mb * 1024 * 1024
    : null;
  if (storageLimitBytes == null) return;

  const usage = await billing.getBackupUsage(backup.user_id, { agentId: backup.agent_id });
  if (usage.backup_storage_used_bytes + archiveBuffer.length > storageLimitBytes) {
    throw createHttpError(
      "Backup storage limit reached. Delete old backups or contact your administrator.",
      402,
    );
  }
}

function backupAgentMetadata(agent = {}) {
  const runtimeFields = buildAgentRuntimeFields(agent);
  return {
    id: agent.id,
    name: agent.name,
    runtime_family: runtimeFields.runtime_family,
    deploy_target: runtimeFields.deploy_target,
    execution_target_id: runtimeFields.execution_target_id,
    sandbox_profile: runtimeFields.sandbox_profile,
    backend_type: runtimeFields.backend_type,
    sandbox_type: runtimeFields.sandbox_type,
    image: agent.image || null,
    vcpu: agent.vcpu || null,
    ram_mb: agent.ram_mb || null,
    disk_gb: agent.disk_gb || null,
    container_name: agent.container_name || null,
  };
}

function isRemoteHostAuthorizationError(error) {
  const code = String(error?.code || "");
  return (
    code === "REMOTE_HOST_ACCESS_REVOKED" ||
    code === "REMOTE_HOST_RETEST_REQUIRED" ||
    code.endsWith("AUTH_CHECK_FAILED")
  );
}

async function withRemoteHostCaptureAuthorization(
  agent,
  { signal, authorizationRecheckMs = REMOTE_HOST_AUTH_RECHECK_MS } = {},
  capture,
) {
  throwIfAborted(signal, "agent archive build");
  if (!isRemoteDockerAgent(agent)) return capture(signal);

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
    if (captureSettled || authorizationInFlight || authorizationError) {
      return authorizationInFlight;
    }
    authorizationInFlight = Promise.resolve()
      .then(() => assertRemoteHostAgentUse(agent, { includeProfile: false }))
      .catch((error) => {
        authorizationError = toPublicRemoteHostAuthorizationError(error);
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
    throwIfAborted(controller.signal, "agent archive build");

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
      if (authorizationError) throw authorizationError;
      throwIfAborted(controller.signal, "agent archive build");
      throw error;
    }

    // Stop scheduling checks, wait for one that raced completion, then require
    // one final positive grant before accepting the fully packed archive.
    captureSettled = true;
    clearInterval(authorizationTimer);
    authorizationTimer = null;
    const pendingAuthorization = authorizationInFlight;
    if (pendingAuthorization) await pendingAuthorization;
    if (authorizationError) throw authorizationError;
    throwIfAborted(signal, "agent archive build");
    try {
      await assertRemoteHostAgentUse(agent, { includeProfile: false });
    } catch (error) {
      throw toPublicRemoteHostAuthorizationError(error);
    }
    throwIfAborted(signal, "agent archive build");
    return captured;
  } finally {
    captureSettled = true;
    if (authorizationTimer) clearInterval(authorizationTimer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function captureAgentArchive(
  agent,
  backup,
  sourceKind,
  { signal, authorizationRecheckMs } = {},
) {
  return withRemoteHostCaptureAuthorization(
    agent,
    { signal, authorizationRecheckMs },
    async (captureSignal) => {
      throwIfAborted(captureSignal, "agent archive build");
      const manifest = await buildMigrationManifestFromAgent(agent, {
        userId: agent.user_id,
        signal: captureSignal,
      });
      manifest.source = {
        ...(manifest.source || {}),
        kind: sourceKind,
        backup: {
          backupId: backup.id,
          capturedAt: new Date().toISOString(),
          agent: backupAgentMetadata(agent),
        },
      };
      const buffer = await packMigrationBundle(manifest);
      throwIfAborted(captureSignal, "agent archive build");
      return { manifest, buffer };
    },
  );
}

/**
 * Build a portable agent migration bundle for later encrypted storage.
 *
 * @param {Object} backup - Agent backup row.
 * @param {Object} [options={}] - Cancellation and capture-authorization options.
 * @returns {Promise<Object>} Plain bundle, summary, and migration warnings.
 */
async function buildAgentBackupArchive(backup, { signal, authorizationRecheckMs } = {}) {
  throwIfAborted(signal, "agent archive build");
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    backup.agent_id,
    backup.user_id,
  ]);
  const agent = result.rows[0];
  if (!agent) throw createHttpError("Agent not found", 404);

  const { manifest, buffer } = await captureAgentArchive(agent, backup, "nora-backup", {
    signal,
    authorizationRecheckMs,
  });

  return {
    buffer,
    summary: {
      runtimeFamily: manifest.runtimeFamily,
      sourceAgentId: agent.id,
      sourceAgentName: agent.name,
      ...(manifest.summary || {}),
    },
    warnings: Array.isArray(manifest.warnings) ? manifest.warnings : [],
  };
}

/**
 * Stream `pg_dump` through gzip with cancellation while buffering stderr without a size cap.
 *
 * Only the failure detail surfaced from that buffer is truncated.
 *
 * @param {Object} [options={}] - Optional cancellation signal.
 * @returns {Promise<Buffer>} Compressed database dump.
 */
async function buildPostgresDump({ signal } = {}) {
  throwIfAborted(signal, "pg_dump");
  const dumpConfig = buildPostgresCliConfig(process.env);
  let tlsDirectory = null;
  const cleanupTls = async () => {
    if (!tlsDirectory) return;
    await fs.rm(tlsDirectory, { recursive: true, force: true });
    tlsDirectory = null;
  };
  try {
    if (dumpConfig.tlsFiles.length > 0) {
      tlsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "nora-pg-dump-"));
      for (const file of dumpConfig.tlsFiles) {
        const filePath = path.join(tlsDirectory, file.filename);
        await fs.writeFile(filePath, file.contents, { mode: 0o600 });
        dumpConfig.env[file.envKey] = filePath;
      }
    }
  } catch (error) {
    await cleanupTls();
    throw error;
  }

  // Stream pg_dump stdout straight into gzip so we don't buffer the raw SQL
  // dump in memory. Real installations exceeded the prior 1 GiB execFile cap.
  return new Promise((resolve, reject) => {
    // Node's `spawn` natively supports AbortSignal — when the signal fires,
    // the child receives SIGTERM automatically. We still set up our own
    // settle-error path so callers see the abort reason rather than a
    // generic "Command failed" message.
    const child = spawn("pg_dump", dumpConfig.args, {
      env: {
        ...process.env,
        ...dumpConfig.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    const gzipStream = createGzip();
    const compressedChunks = [];
    const stderrChunks = [];
    let exitCode = null;
    let exitSignal = null;
    let gzipDone = false;
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) {
        // Clean up the subprocess on the error path. pg_dump usually exits
        // on EPIPE when stdout closes, but a hung connection (e.g., DB
        // hang during query) won't, and would otherwise outlive the worker.
        try {
          if (!child.killed) child.kill("SIGTERM");
        } catch {
          /* ignore — best effort */
        }
      }
      cleanupTls()
        .catch((cleanupError) => {
          console.warn(
            `[backups] failed to remove temporary PostgreSQL TLS files: ${cleanupError.message}`,
          );
        })
        .finally(() => (err ? reject(err) : resolve(value)));
    };

    const tryFinish = () => {
      if (exitCode === null || !gzipDone) return;
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 1000);
        const detail = stderr || `signal=${exitSignal || "unknown"}`;
        return settle(new Error(`pg_dump failed (exit ${exitCode}): ${detail}`));
      }
      settle(null, Buffer.concat(compressedChunks));
    };

    child.on("error", (err) => settle(err));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("exit", (code, signal) => {
      exitCode = code ?? -1;
      exitSignal = signal;
      tryFinish();
    });

    gzipStream.on("data", (chunk) => compressedChunks.push(chunk));
    gzipStream.on("end", () => {
      gzipDone = true;
      tryFinish();
    });
    gzipStream.on("error", (err) => settle(err));

    child.stdout.on("error", (err) => settle(err));
    child.stdout.pipe(gzipStream);
  });
}

async function packInstallationArchive({ manifest, databaseDump, agentArchives }) {
  const pack = tar.pack();
  const chunks = [];
  const archivePromise = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });

  async function addEntry(name, content, mode = 0o600) {
    await new Promise((resolve, reject) => {
      pack.entry({ name, mode }, content, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });
  }

  await addEntry("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)), 0o644);
  await addEntry("database.sql.gz", databaseDump);
  for (const entry of agentArchives) {
    await addEntry(`agents/${entry.agentId}.nora-backup.tgz`, entry.buffer);
  }
  pack.finalize();
  const tarBuffer = await archivePromise;
  return gzipAsync(tarBuffer);
}

/**
 * Build an installation archive, retaining per-agent capture failures as warnings.
 *
 * @param {Object} backup - Installation backup row.
 * @param {Object} [options={}] - Dump builder, cancellation, and authorization options.
 * @returns {Promise<Object>} Plain installation archive, summary, and warnings.
 */
async function buildInstallationBackupArchive(
  backup,
  {
    signal,
    databaseDumpBuilder = buildPostgresDump,
    authorizationRecheckMs = REMOTE_HOST_AUTH_RECHECK_MS,
  } = {},
) {
  throwIfAborted(signal, "installation archive build");
  const [databaseDump, agentsResult] = await Promise.all([
    databaseDumpBuilder({ signal }),
    db.query("SELECT * FROM agents ORDER BY created_at ASC"),
  ]);
  const warnings = [];
  const agentArchives = [];
  for (const agent of agentsResult.rows) {
    throwIfAborted(signal, "installation archive build");
    try {
      // Installation backups may complete partially, but Remote Docker
      // authorization remains live for the entire capture. Revocation or a
      // fail-closed auth-check error omits the agent instead of silently using
      // stale stored-template state.
      const captured = await captureAgentArchive(agent, backup, "nora-installation-backup", {
        signal,
        authorizationRecheckMs,
      });
      agentArchives.push({
        agentId: agent.id,
        buffer: captured.buffer,
      });
    } catch (error) {
      throwIfAborted(signal, "installation archive build");
      const remoteAccessRevoked = error?.code === "REMOTE_HOST_ACCESS_REVOKED";
      const remoteAuthorizationFailed = isRemoteHostAuthorizationError(error);
      warnings.push({
        code: remoteAccessRevoked
          ? "agent_backup_remote_host_access_revoked"
          : remoteAuthorizationFailed
            ? "agent_backup_remote_host_auth_check_failed"
            : "agent_backup_failed",
        agentId: agent.id,
        agentName: agent.name,
        message: remoteAccessRevoked
          ? "Remote Docker access was revoked before live state could be captured; this agent archive was omitted from the installation backup."
          : remoteAuthorizationFailed
            ? "Remote Docker authorization could not be verified through live capture; this agent archive was omitted from the installation backup."
            : error.message || "Agent backup failed",
      });
    }
  }

  const manifest = {
    format: BACKUP_ARCHIVE_FORMAT,
    kind: "installation",
    version: 1,
    backupId: backup.id,
    capturedAt: new Date().toISOString(),
    database: { file: "database.sql.gz" },
    agents: agentArchives.map((entry) => ({
      agentId: entry.agentId,
      file: `agents/${entry.agentId}.nora-backup.tgz`,
    })),
    warnings,
  };

  return {
    buffer: await packInstallationArchive({ manifest, databaseDump, agentArchives }),
    summary: {
      databaseDumpBytes: databaseDump.length,
      agentCount: agentsResult.rows.length,
      agentBackupCount: agentArchives.length,
      warningCount: warnings.length,
    },
    warnings,
  };
}

/**
 * Run a queued or failed backup through archive creation, upload, and status transitions.
 *
 * Backups in any other status are returned unchanged. Failures after the running transition mark
 * the row failed; transition failures escape without that marking attempt.
 *
 * @param {string} backupId - Backup identifier.
 * @param {Object} [options={}] - Optional cancellation signal.
 * @returns {Promise<Object>} Serialized current or completed backup.
 */
async function runBackupJob(backupId, { signal } = {}) {
  const backup = await loadBackup(backupId);
  if (!backup) throw createHttpError("Backup not found", 404);
  if (!["queued", "failed"].includes(backup.status)) {
    return serializeBackup(backup);
  }

  await updateBackupRunning(backup.id);
  try {
    const result =
      backup.kind === "installation"
        ? await buildInstallationBackupArchive(backup, { signal })
        : await buildAgentBackupArchive(backup, { signal });
    return await completeBackup(backup, result.buffer, {
      summary: result.summary,
      warnings: result.warnings,
      signal,
    });
  } catch (error) {
    await markBackupFailed(backup.id, error);
    throw error;
  }
}

// Download, deletion, and restore

/**
 * Read and decrypt a ready backup using its captured storage location.
 *
 * @param {Object} backup - Ready backup row.
 * @returns {Promise<Buffer>} Plain archive bytes.
 */
async function readBackupArchive(backup) {
  if (!READY_STATUSES.has(backup.status)) {
    throw createHttpError("Backup is not ready", 409);
  }
  if (!backup.storage_key) {
    throw createHttpError("Backup storage object is missing", 500);
  }
  const encrypted = await getStorageObject(
    backup.storage_key,
    await backupStorageConfigForBackup(backup),
  );
  return decryptBackupBuffer(encrypted);
}

/**
 * Load a backup under caller-supplied tenant constraints and return its decrypted download.
 *
 * @param {Object} input - Backup ID plus tenant filters or a caller-authorized admin override.
 * @returns {Promise<Object>} Serialized backup, plain archive buffer, and filename.
 */
async function getBackupDownload({
  backupId,
  userId = null,
  agentId = null,
  isAdmin = false,
} = {}) {
  const backup = await loadBackup(backupId, {
    userId: isAdmin ? null : userId,
    agentId: isAdmin ? null : agentId,
  });
  if (!backup) throw createHttpError("Backup not found", 404);
  const buffer = await readBackupArchive(backup);
  const seed = (backup.name || "nora-backup")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return {
    backup: serializeBackup(backup),
    buffer,
    filename: `${seed || "nora-backup"}.${backup.kind === "installation" ? "nora-installation-backup" : "nora-backup"}.tgz`,
  };
}

/**
 * Delete a backup's storage object before soft-deleting its database row.
 *
 * @param {Object} input - Backup ID plus tenant filters or a caller-authorized admin override.
 * @returns {Promise<Object>} Success result after both operations complete.
 */
async function deleteBackup({ backupId, userId = null, agentId = null, isAdmin = false } = {}) {
  const backup = await loadBackup(backupId, {
    userId: isAdmin ? null : userId,
    agentId: isAdmin ? null : agentId,
  });
  if (!backup) throw createHttpError("Backup not found", 404);
  await deleteStorageObject(backup.storage_key, await backupStorageConfigForBackup(backup));
  await db.query(
    `UPDATE backups
        SET status = 'deleted',
            storage_key = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [backup.id],
  );
  return { success: true };
}

/**
 * Convert an owned agent backup into an encrypted migration draft for copy restore.
 *
 * @param {Object} input - Backup, owner, and optional source-agent identifiers.
 * @returns {Promise<Object>} Migration preview and deployment defaults for a new agent.
 */
async function createRestoreDraft({ backupId, userId, agentId = null }) {
  const backup = await loadBackup(backupId, { userId, agentId });
  if (!backup || backup.kind !== "agent") throw createHttpError("Backup not found", 404);
  const subscription = await billing.getSubscription(userId);
  if (billing.IS_PAAS && billing.BILLING_ENABLED && subscription.status !== "active") {
    throw createHttpError("Subscription is not active", 402);
  }
  if (!subscription.managed_backups_enabled) {
    throw createHttpError("Managed backup restore is not available on your current plan.", 402);
  }
  const buffer = await readBackupArchive(backup);
  const manifest = await parseUploadedMigrationBuffer(buffer, `${backup.id}.nora-backup.tgz`, {
    maxBytes: null,
  });
  const restoredName = `${manifest.name || backup.name || "Restored Agent"} Restore`;
  manifest.name = restoredName.slice(0, 100);
  manifest.source = {
    ...(manifest.source || {}),
    restore: {
      backupId: backup.id,
      restoredAt: new Date().toISOString(),
      mode: "copy",
    },
  };
  const draft = await createMigrationDraft({
    userId,
    manifest,
    sourceKind: "backup",
    sourceTransport: "managed-backup",
  });
  const agentMeta = manifest.source?.backup?.agent || {};
  const runtimeFields = buildAgentRuntimeFields({
    runtime_family: manifest.runtimeFamily,
    ...agentMeta,
  });
  return {
    draft: draft.preview,
    deployDraft: {
      name: draft.preview.name,
      containerName: "",
      runtimeFamily: runtimeFields.runtime_family,
      deployTarget: runtimeFields.execution_target_id || runtimeFields.deploy_target,
      sandboxProfile: runtimeFields.sandbox_profile,
      model: "",
      deploymentMode: "migrate",
      migrationMethod: "backup",
      migrationDraft: draft.preview,
      migrationSource: {
        transport: "backup",
        backupId: backup.id,
        name: backup.name,
      },
      vcpu: agentMeta.vcpu || 1,
      ramMb: agentMeta.ram_mb || 1024,
      diskGb: agentMeta.disk_gb || 10,
      clawhubSkills: [],
    },
  };
}

function assertRuntimeSelectionAvailable(runtimeFields) {
  const status = getRuntimeSelectionStatus(runtimeFields);
  if (!status.enabled || !status.configured) {
    throw createHttpError(
      status.issue || "Runtime selection is not enabled for this Nora control plane.",
      400,
    );
  }
}

async function persistRestoreTerminalRuntimeState(
  agentId,
  { queryable = db, returning = false, status = "stopped" } = {},
) {
  const result = await queryable.query(
    `UPDATE agents
        SET status = $2,
            container_id = NULL,
            host = NULL,
            runtime_host = NULL,
            runtime_port = NULL,
            gateway_host = NULL,
            gateway_port = NULL,
            gateway_host_port = NULL,
            gateway_token = NULL,
            dashboard_port = NULL
      WHERE id = $1${returning ? " RETURNING *" : ""}`,
    [agentId, status],
  );
  return returning ? result.rows[0] || null : null;
}

function createRestoreCompensationError(agentId, phase, cause) {
  const error = new Error(
    `Restore compensation could not safely fence agent ${agentId} during ${phase}`,
  );
  error.code = "RESTORE_COMPENSATION_FAILED";
  error.statusCode = 500;
  error.cause = cause;
  return error;
}

async function compensateRestoreFailure(
  agentId,
  {
    backupId = null,
    previousRestoreMetadata = null,
    restoreBackupMetadata = false,
    restoreTransitionStarted = false,
    deploymentEnqueueAttempted = false,
    provisionLock = null,
  } = {},
) {
  const activeProvisionLock =
    provisionLock ||
    (await acquireAgentProvisionLock(agentId, {
      applicationName: "nora-backend-restore-lock",
    }));
  const ownsProvisionLock = !provisionLock;

  try {
    // addDeploymentJob may fail after Redis accepted the job. Re-cancel while
    // holding the provisioner lock. Active jobs cannot be removed by BullMQ,
    // so the stopped/warning status persisted below is also a durable fence:
    // the provisioner rejects those states before it can create a runtime.
    try {
      const canceledJobs = await cancelDeploymentJobsForAgent(agentId);
      if (canceledJobs.active > 0) {
        console.warn(
          `[backups] restore compensation fenced ${canceledJobs.active} BullMQ-active deployment job(s) for agent ${agentId}`,
        );
      }
    } catch (error) {
      console.error(
        `[backups] failed to cancel restore deployment work for agent ${agentId}; durable status fencing will still be applied: ${error?.message || error}`,
      );
    }

    let runtimeCleanupError = null;
    if (restoreTransitionStarted || deploymentEnqueueAttempted) {
      const currentResult = await activeProvisionLock.query("SELECT * FROM agents WHERE id = $1", [
        agentId,
      ]);
      const currentAgent = currentResult.rows[0];
      const hasRuntimeIdentity = Boolean(
        currentAgent?.container_id ||
        currentAgent?.host ||
        currentAgent?.runtime_host ||
        currentAgent?.gateway_host ||
        currentAgent?.dashboard_port,
      );
      if (hasRuntimeIdentity && containerManager.canDestroy(currentAgent)) {
        try {
          await containerManager.destroy(currentAgent);
        } catch (error) {
          runtimeCleanupError = error;
          console.error(
            `[backups] failed to destroy runtime during restore compensation for agent ${agentId}: ${error?.message || error}`,
          );
        }
      }
    }

    try {
      let fencedAgent;
      if (runtimeCleanupError) {
        const result = await activeProvisionLock.query(
          "UPDATE agents SET status = 'warning' WHERE id = $1 RETURNING id",
          [agentId],
        );
        fencedAgent = result.rows[0];
      } else {
        fencedAgent = await persistRestoreTerminalRuntimeState(agentId, {
          queryable: activeProvisionLock,
          returning: true,
          status: "stopped",
        });
      }
      if (!fencedAgent) {
        throw new Error(`Agent ${agentId} disappeared during restore compensation`);
      }
    } catch (error) {
      throw createRestoreCompensationError(agentId, "agent status fencing", error);
    }

    try {
      await activeProvisionLock.query(
        "UPDATE deployments SET status = 'failed' WHERE agent_id = $1 AND status IN ('queued', 'deploying')",
        [agentId],
      );
    } catch (error) {
      throw createRestoreCompensationError(agentId, "deployment status fencing", error);
    }

    if (restoreBackupMetadata && backupId) {
      try {
        await activeProvisionLock.query(
          `UPDATE backups
              SET restore_metadata = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [backupId, previousRestoreMetadata],
        );
      } catch (error) {
        console.error(
          `[backups] failed to roll back restore metadata for backup ${backupId}: ${error?.message || error}`,
        );
      }
    }
  } finally {
    if (ownsProvisionLock) await activeProvisionLock.release();
  }
}

/**
 * Destructively restore an agent backup under the per-agent provision lock.
 * Failures after confirmed cleanup invoke compensation to cancel deployment
 * work and fence durable status.
 *
 * @param {Object} input - Backup, target agent, confirmation name, and actor.
 * @returns {Promise<Object>} Serialized agent queued for redeployment.
 */
async function restoreBackupInPlace({ backupId, targetAgentId, confirmAgentName, actor } = {}) {
  const backup = await loadBackup(backupId);
  if (!backup || backup.kind !== "agent") throw createHttpError("Backup not found", 404);
  const targetResult = await db.query("SELECT * FROM agents WHERE id = $1", [
    targetAgentId || backup.agent_id,
  ]);
  const target = targetResult.rows[0];
  if (!target) throw createHttpError("Target agent not found", 404);
  if (backup.agent_id && target.id !== backup.agent_id) {
    throw createHttpError("In-place restore can only target the backed-up agent", 400);
  }
  // Defense-in-depth: routes/admin.ts gates this behind requireAdmin today,
  // but enforce ownership inside the helper too so a future tenant route
  // can't accidentally bypass it. Admins may restore across tenants;
  // non-admins must own both the backup and the target.
  const isAdmin = actor?.role === "admin";
  if (!isAdmin) {
    if (!actor?.id || target.user_id !== actor.id || backup.user_id !== actor.id) {
      throw createHttpError("Not authorized to restore this backup", 403);
    }
  }
  if (String(confirmAgentName || "") !== String(target.name || "")) {
    throw createHttpError("confirmAgentName must match the target agent name", 400);
  }

  const buffer = await readBackupArchive(backup);
  const manifest = await parseUploadedMigrationBuffer(buffer, `${backup.id}.nora-backup.tgz`, {
    maxBytes: null,
  });
  const targetRuntime = buildAgentRuntimeFields(target);
  if (manifest.runtimeFamily !== targetRuntime.runtime_family) {
    throw createHttpError(
      "In-place restore requires the same runtime family as the target agent",
      400,
    );
  }

  const sourceAgentMeta = manifest.source?.backup?.agent || {};
  const runtimeFields = resolveRequestedRuntimeFields({
    request: targetRuntime,
    fallback: targetRuntime,
  });
  assertRuntimeSelectionAvailable(runtimeFields);
  // Deep execution-target checks (parity with the deploy route): the cluster /
  // remote host must still exist + be connected. Owner-scoped to the target
  // agent's owner so an admin cross-tenant restore still validates against the
  // owner's registered host, not the admin actor.
  await assertKubernetesExecutionTargetAvailable(runtimeFields);
  await assertRemoteHostExecutionTargetAvailable(runtimeFields, { ownerUserId: target.user_id });
  let containerName = resolveContainerName({
    currentName: target.container_name,
    agentName: target.name,
    runtimeSelection: runtimeFields,
  });
  let image =
    target.image ||
    sourceAgentMeta.image ||
    getDefaultAgentImage({
      runtime_family: runtimeFields.runtime_family,
      sandbox_profile: runtimeFields.sandbox_profile,
    });
  const templatePayload =
    manifest.runtimeFamily === "openclaw"
      ? manifest.templatePayload || createEmptyTemplatePayload({ source: "backup-restore" })
      : createEmptyTemplatePayload({ source: "backup-restore", backupId: backup.id });
  const previousRestoreMetadata =
    backup.restore_metadata == null
      ? null
      : typeof backup.restore_metadata === "string"
        ? backup.restore_metadata
        : JSON.stringify(backup.restore_metadata);
  const restoreMetadata = JSON.stringify({
    mode: "in_place",
    targetAgentId: target.id,
    restoredAt: new Date().toISOString(),
    actorId: actor?.id || null,
  });

  // Serialize the entire destructive transition with the same advisory lock
  // used by the provisioner. The lock stays held through queue publication, so
  // no worker can create a runtime from partially restored control-plane state.
  const provisionLock = await acquireAgentProvisionLock(target.id, {
    applicationName: "nora-backend-restore-lock",
  });
  let agent = null;
  try {
    const canceledJobs = await cancelDeploymentJobsForAgent(target.id);
    if (canceledJobs.active > 0) {
      throw createHttpError(
        "An earlier deployment is still active for this agent. Try the restore again shortly.",
        409,
      );
    }

    // Refresh the row after taking the lock. A deployment that completed while
    // the request was reading/decrypting the backup may have changed identity;
    // cleanup must always target the latest durable runtime.
    const lockedTargetResult = await db.query("SELECT * FROM agents WHERE id = $1", [target.id]);
    const lockedTarget = lockedTargetResult.rows[0];
    if (!lockedTarget) throw createHttpError("Target agent disappeared during restore", 409);
    if (String(confirmAgentName || "") !== String(lockedTarget.name || "")) {
      throw createHttpError("Target agent changed while the restore was being prepared", 409);
    }
    const lockedRuntimeFields = buildAgentRuntimeFields(lockedTarget);
    const runtimeSelectionChanged = [
      "runtime_family",
      "deploy_target",
      "execution_target_id",
      "sandbox_profile",
    ].some((field) => lockedRuntimeFields[field] !== runtimeFields[field]);
    if (lockedTarget.user_id !== target.user_id || runtimeSelectionChanged) {
      throw createHttpError(
        "Target agent placement changed while the restore was being prepared",
        409,
      );
    }

    containerName = resolveContainerName({
      currentName: lockedTarget.container_name,
      agentName: lockedTarget.name,
      runtimeSelection: runtimeFields,
    });
    image =
      lockedTarget.image ||
      sourceAgentMeta.image ||
      getDefaultAgentImage({
        runtime_family: runtimeFields.runtime_family,
        sandbox_profile: runtimeFields.sandbox_profile,
      });

    const destroyableRuntime = containerManager.canDestroy(lockedTarget);
    let cleanupConfirmed = !destroyableRuntime;
    let restoreTransitionStarted = false;
    let restoreMetadataUpdated = false;
    let deploymentEnqueueAttempted = false;
    try {
      if (destroyableRuntime) {
        await containerManager.destroy(lockedTarget);
        cleanupConfirmed = true;
      }

      // Once cleanup is confirmed, immediately make the durable row truthful
      // and worker-ineligible. It becomes queued only after every backup state
      // component has been durably materialized.
      restoreTransitionStarted = true;
      const terminalAgent = await persistRestoreTerminalRuntimeState(lockedTarget.id, {
        returning: true,
        status: "stopped",
      });
      if (!terminalAgent) throw createHttpError("Target agent disappeared during restore", 409);

      await db.query("DELETE FROM integrations WHERE agent_id = $1", [lockedTarget.id]);
      await db.query("DELETE FROM channels WHERE agent_id = $1", [lockedTarget.id]);
      await materializeManagedMigrationState(lockedTarget.user_id, lockedTarget.id, manifest);

      if (manifest.runtimeFamily === "hermes") {
        // The provisioner already reads the newest attached agent_migrations
        // manifest when constructing a Hermes seed archive. Persist the backup
        // manifest into that durable handoff instead of queueing an unused id.
        await persistMigrationManifestForAgent({
          userId: lockedTarget.user_id,
          agentId: lockedTarget.id,
          manifest,
          sourceKind: "backup",
          sourceTransport: "managed-backup",
        });
      } else {
        const hasManagedWiring =
          (manifest.managed?.channels || []).length > 0 ||
          (manifest.managed?.integrations || []).length > 0;
        if (!hasManagedWiring) {
          await materializeTemplateWiring(lockedTarget.id, manifest.templatePayload || {});
        }
      }

      const updated = await db.query(
        `UPDATE agents
            SET status = 'queued',
                container_id = NULL,
                host = NULL,
                runtime_host = NULL,
                runtime_port = NULL,
                gateway_host = NULL,
                gateway_port = NULL,
                gateway_host_port = NULL,
                gateway_token = NULL,
                dashboard_port = NULL,
                template_payload = $2,
                container_name = $3,
                image = $4
          WHERE id = $1
          RETURNING *`,
        [lockedTarget.id, JSON.stringify(templatePayload), containerName, image],
      );
      agent = updated.rows[0];
      if (!agent) throw createHttpError("Target agent disappeared during restore", 409);

      await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);
      // Treat this write as ambiguous until compensation proves otherwise: a
      // connection can fail after PostgreSQL committed the metadata update.
      restoreMetadataUpdated = true;
      await db.query(
        `UPDATE backups
            SET restore_metadata = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [backup.id, restoreMetadata],
      );

      // Re-cancel any legacy or already-published work before publishing the
      // restored deployment. Current replacement producers share this lock;
      // an already-active job is fenced by compensation before unlock.
      const competingJobs = await cancelDeploymentJobsForAgent(lockedTarget.id);
      if (competingJobs.active > 0) {
        throw createHttpError(
          "A deployment raced the restore. The agent was left stopped; retry the restore.",
          409,
          "RESTORE_DEPLOYMENT_RACE",
        );
      }

      deploymentEnqueueAttempted = true;
      await addDeploymentJob({
        id: agent.id,
        name: agent.name,
        // Deployment credentials and Remote Docker grants belong to the durable
        // agent owner, never the admin/editor who initiated the restore.
        userId: lockedTarget.user_id,
        backend: runtimeFields.backend_type,
        runtime_family: runtimeFields.runtime_family,
        deploy_target: runtimeFields.deploy_target,
        execution_target_id: runtimeFields.execution_target_id,
        sandbox_profile: runtimeFields.sandbox_profile,
        sandbox: runtimeFields.sandbox_profile,
        specs: {
          vcpu: agent.vcpu || sourceAgentMeta.vcpu || 1,
          ram_mb: agent.ram_mb || sourceAgentMeta.ram_mb || 1024,
          disk_gb: agent.disk_gb || sourceAgentMeta.disk_gb || 10,
        },
        container_name: containerName,
        image,
      });
    } catch (error) {
      // Destroy failed means the old identity may still be live and must remain
      // available for cleanup. Every failure after confirmed cleanup is fenced
      // while this same provisioner lock is still held.
      if (cleanupConfirmed && restoreTransitionStarted) {
        try {
          await compensateRestoreFailure(lockedTarget.id, {
            backupId: backup.id,
            previousRestoreMetadata,
            restoreBackupMetadata: restoreMetadataUpdated,
            restoreTransitionStarted,
            deploymentEnqueueAttempted,
            provisionLock,
          });
        } catch (compensationError) {
          compensationError.restoreError = error;
          throw compensationError;
        }
      }
      throw error;
    }

    return serializeAgent(agent);
  } finally {
    await provisionLock.release();
  }
}

/**
 * Remove expired objects and failed objects left in storage for over 24 hours.
 *
 * Rows are soft-deleted only after storage succeeds; failures remain for a later retry.
 *
 * @returns {Promise<Object>} Counts of scanned and deleted backups.
 */
async function pruneExpiredBackups() {
  const result = await db.query(
    `SELECT *
       FROM backups
      WHERE storage_key IS NOT NULL
        AND status <> 'deleted'
        AND (
          (expires_at IS NOT NULL AND expires_at < NOW())
          OR (status = 'failed' AND updated_at < NOW() - INTERVAL '24 hours')
        )`,
  );

  let deleted = 0;
  for (const backup of result.rows) {
    let storageGone = false;
    try {
      await deleteStorageObject(backup.storage_key, await backupStorageConfigForBackup(backup));
      storageGone = true;
    } catch (error) {
      console.warn(
        `[backups] prune: failed to delete storage for backup=${backup.id} key=${backup.storage_key}: ${error?.message || error}`,
      );
    }

    if (!storageGone) continue;

    await db.query(
      `UPDATE backups
          SET status = 'deleted',
              storage_key = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [backup.id],
    );
    deleted += 1;
  }
  return { deleted, scanned: result.rows.length };
}

module.exports = {
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_KINDS,
  createAgentBackup,
  createInstallationBackup,
  createRestoreDraft,
  deleteBackup,
  getAgentBackupSchedule,
  getBackupDownload,
  listAdminBackups,
  listAgentBackups,
  listUserBackups,
  processDueSchedules,
  pruneExpiredBackups,
  runBackupJob,
  restoreBackupInPlace,
  serializeBackup,
  storageKeyForBackup,
  syncInstallationScheduleFromSettings,
  updateAgentBackupSchedule,
  __test: Object.freeze({ buildInstallationBackupArchive }),
};
