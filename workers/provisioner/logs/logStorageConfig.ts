// @ts-nocheck
// workers/provisioner/logs/logStorageConfig.ts — resolves the platform-wide
// log segment storage destination, mirroring backend-api/backups.ts's
// backupStorageConfig()/backupStorageConfigForBackup() pattern (Phase 3 item
// 19; see the logging-control-plane manifest's "Destination is
// platform-wide, and changeable after setup" section).
//
// Two things this module deliberately does NOT do yet:
//
//   1. It does not add columns to `platform_settings`. That migration, plus
//      the `GET`/`PUT /admin/log-storage` mutation surface, is Phase 5's
//      job (see the implementation plan's Phase 5 changes list). Until that
//      migration lands, `readPlatformLogStorageRow()` below queries for
//      columns that do not exist yet and treats "column doesn't exist" the
//      same as "no settings row" — i.e. it falls back to the NORA_LOG_* env
//      block, which is exactly the fallback behaviour item 19 asks for
//      anyway. Once Phase 5 adds the columns, this starts reading them with
//      zero changes at this call site.
//   2. It does not decrypt credentials — the platform_settings columns this
//      will read (once Phase 5 adds them) follow the same
//      encrypted-under-ENCRYPTION_KEY convention as
//      backup_s3_secret_access_key_encrypted etc., and decryption is
//      deferred to that same future migration's reader, matching how
//      backupStorageConfig() only exists once the backup columns exist.
//
// Platform-wide only: this module takes no workspace argument anywhere, per
// Design Decision 2b (one destination per installation).

const objectStorage = require("../../../agent-runtime/lib/objectStorage.ts");

// Lazy: backend-api/db.ts's own internal requires (./lib/connectionConfig,
// etc.) resolve fine under `tsx worker.ts` (production) but not under plain
// `node --test` (this package's actual test runner — see package.json),
// which has no extensionless-.ts resolution for a THIRD module's internal
// requires the way it does for a directly-required file. Requiring db.ts
// lazily, only when readPlatformLogStorageRow() is actually invoked (never
// hit by tests, which inject their own `db`/`logStorageConfig` deps),
// keeps this module importable under both runners.
let _db = null;
function getDb() {
  if (!_db) _db = require("../../../backend-api/db.ts");
  return _db;
}

// Postgres "undefined_column" — thrown when Phase 5's platform_settings
// migration hasn't landed yet. Anything else is a real failure and should
// propagate.
const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";

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

/**
 * Build the storage config implied by the NORA_LOG_* env block. This is the
 * fallback used whenever no platform_settings row/columns exist yet (today,
 * always — see the module comment above).
 */
function resolveEnvLogStorageConfig(env = process.env) {
  return {
    storageBackend: String(env.NORA_LOG_STORAGE || "local").trim().toLowerCase() || "local",
    localPath: env.NORA_LOG_DIR || "/var/lib/nora-logs",
    bucket: env.NORA_LOG_S3_BUCKET || env.NORA_LOG_R2_BUCKET || "",
    region: env.NORA_LOG_S3_REGION || env.NORA_LOG_R2_REGION || "",
    endpoint: env.NORA_LOG_S3_ENDPOINT || env.NORA_LOG_R2_ENDPOINT || "",
    accessKeyId: env.NORA_LOG_S3_ACCESS_KEY_ID || env.NORA_LOG_R2_ACCESS_KEY_ID || "",
    secretAccessKey: env.NORA_LOG_S3_SECRET_ACCESS_KEY || env.NORA_LOG_R2_SECRET_ACCESS_KEY || "",
    sessionToken: env.NORA_LOG_S3_SESSION_TOKEN || env.NORA_LOG_R2_SESSION_TOKEN || "",
    sshHost: env.NORA_LOG_SSH_HOST || "",
    sshPort: env.NORA_LOG_SSH_PORT ? Number(env.NORA_LOG_SSH_PORT) : 22,
    sshUsername: env.NORA_LOG_SSH_USERNAME || "",
    sshPrivateKey: env.NORA_LOG_SSH_PRIVATE_KEY || "",
    sshPassword: env.NORA_LOG_SSH_PASSWORD || "",
    sshRemotePath: env.NORA_LOG_SSH_REMOTE_PATH || "",
  };
}

/**
 * Attempt to read a platform-wide log storage destination row. Returns
 * `null` when no such row/columns exist — either because the operator never
 * changed the destination (a real "unset" state Phase 5 will also produce)
 * or, today, because Phase 5's migration hasn't landed at all.
 */
async function readPlatformLogStorageRow() {
  try {
    const result = await getDb().query(
      `SELECT log_storage_backend,
              log_storage_local_path,
              log_storage_s3_bucket,
              log_storage_s3_region,
              log_storage_s3_endpoint,
              log_storage_s3_access_key_id_encrypted,
              log_storage_s3_secret_access_key_encrypted,
              log_storage_ssh_host,
              log_storage_ssh_port,
              log_storage_ssh_username,
              log_storage_ssh_remote_path,
              log_storage_ssh_private_key_encrypted,
              log_storage_ssh_password_encrypted
         FROM platform_settings
        WHERE singleton = TRUE
        LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row || !row.log_storage_backend) return null;
    // Decryption of the *_encrypted columns is intentionally left to
    // whatever Phase 5 lands, alongside the migration that creates them —
    // see crypto.ts's decrypt() convention used by getBackupStorageConfig().
    // We surface only what we can already resolve without guessing at that
    // shape, and callers fall back to secrets from env when this returns
    // fields we can't decrypt yet.
    return row;
  } catch (error) {
    if (error && (error.code === UNDEFINED_COLUMN || error.code === UNDEFINED_TABLE)) {
      return null;
    }
    throw error;
  }
}

let cachedConfigPromise = null;

/**
 * Resolve the platform-wide log segment storage destination: platform
 * settings row when one exists (once Phase 5 lands it), the NORA_LOG_* env
 * block otherwise. Cached across calls; invalidate with
 * `invalidateLogStorageConfigCache()` whenever the destination changes
 * (Phase 5b's mutation endpoint calls this).
 */
async function logStorageConfig() {
  if (!cachedConfigPromise) {
    cachedConfigPromise = (async () => {
      const row = await readPlatformLogStorageRow();
      const envConfig = resolveEnvLogStorageConfig();
      const raw = row
        ? {
            storageBackend: row.log_storage_backend || envConfig.storageBackend,
            localPath: row.log_storage_local_path || envConfig.localPath,
            bucket: row.log_storage_s3_bucket || envConfig.bucket,
            region: row.log_storage_s3_region || envConfig.region,
            endpoint: row.log_storage_s3_endpoint || envConfig.endpoint,
            sshHost: row.log_storage_ssh_host || envConfig.sshHost,
            sshPort: row.log_storage_ssh_port || envConfig.sshPort,
            sshUsername: row.log_storage_ssh_username || envConfig.sshUsername,
            sshRemotePath: row.log_storage_ssh_remote_path || envConfig.sshRemotePath,
            // Secrets: env always wins over an unreadable *_encrypted column
            // until Phase 5 wires up decrypt() for these columns.
            accessKeyId: envConfig.accessKeyId,
            secretAccessKey: envConfig.secretAccessKey,
            sessionToken: envConfig.sessionToken,
            sshPrivateKey: envConfig.sshPrivateKey,
            sshPassword: envConfig.sshPassword,
          }
        : envConfig;
      return objectStorage.normalizeStorageConfig(raw);
    })().catch((error) => {
      // Don't cache a rejected promise — a transient DB hiccup shouldn't
      // permanently wedge every future flush onto a failure.
      cachedConfigPromise = null;
      throw error;
    });
  }
  return cachedConfigPromise;
}

/**
 * Invalidate the cached destination. Call after any change to the resolved
 * destination — today that's only ever an env change (requires a process
 * restart to pick up anyway), but this is the explicit hook Phase 5b's
 * `PUT /admin/log-storage` will call once it exists.
 */
function invalidateLogStorageConfigCache() {
  cachedConfigPromise = null;
}

/**
 * Rehydrate a `log_segments` row's recorded `storage_backend`/`storage_config`
 * with current credentials, so a segment written under a previous
 * destination stays readable after the platform-wide destination changes.
 * Directly mirrors `backupStorageConfigForBackup()` in backend-api/backups.ts.
 *
 * Note (same caveat that pattern already carries for backups): this merges
 * the *old* location's non-secret snapshot (bucket/localPath/etc.) with the
 * *current* config's secrets. That's only correct if the previous driver's
 * credentials are still the ones configured — which the manifest states as
 * an explicit operator obligation during a destination migration ("the
 * previous driver's credentials must remain configured until its last
 * segment expires"). This module doesn't invent a fix beyond what the
 * backup path already does; a real multi-destination credential store is
 * out of scope here.
 */
async function storageConfigForSegment(row = {}) {
  const config = await logStorageConfig();
  const snapshot = objectStorage.normalizeStorageConfig(normalizeJson(row.storage_config, {}));
  return {
    ...config,
    ...snapshot,
    storageBackend: row.storage_backend || snapshot.storageBackend || config.storageBackend,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    sshPrivateKey: config.sshPrivateKey,
    sshPassword: config.sshPassword,
  };
}

/**
 * A non-secret snapshot of `config` suitable for storing on a `log_segments`
 * row's `storage_config` column — mirrors backups.ts's
 * `backupStorageConfigSnapshot()`.
 */
function logStorageConfigSnapshot(config = {}) {
  return {
    storageBackend: config.storageBackend || "local",
    localPath: config.localPath || "",
    bucket: config.bucket || "",
    region: config.region || "",
    endpoint: config.endpoint || "",
    sshHost: config.sshHost || "",
    sshPort: config.sshPort || 22,
    sshUsername: config.sshUsername || "",
    sshRemotePath: config.sshRemotePath || "",
  };
}

/**
 * Boot-time validation (Phase 3 item 20): warn — never fail boot — when the
 * `local` driver is selected but Kubernetes is an enabled deploy target,
 * since local storage only exists on the Docker host and Kubernetes agents'
 * logs would silently never be collected.
 *
 * Returns `true` when the combination is supported, `false` when the
 * warning was emitted, so callers/tests can assert on the outcome without
 * scraping console output.
 */
function assertDriverSupportsTargets(driver, enabledBackends = [], { warn = console.warn } = {}) {
  const normalizedDriver = String(driver || "local").trim().toLowerCase();
  const includesK8s = Array.isArray(enabledBackends) && enabledBackends.includes("k8s");
  if (normalizedDriver === "local" && includesK8s) {
    warn(
      "[logStorageConfig] NORA_LOG_STORAGE=local while ENABLED_BACKENDS includes k8s: " +
        "Kubernetes agents will not have logs collected (the local driver is unsupported on " +
        "Kubernetes — see Design Decision 2d). Configure NORA_LOG_STORAGE=s3 or =r2, or an " +
        "admin-configured destination once available, for Kubernetes log collection to work. " +
        "Docker/Proxmox agents on this installation are unaffected.",
    );
    return false;
  }
  return true;
}

module.exports = {
  resolveEnvLogStorageConfig,
  readPlatformLogStorageRow,
  logStorageConfig,
  invalidateLogStorageConfigCache,
  storageConfigForSegment,
  logStorageConfigSnapshot,
  assertDriverSupportsTargets,
};
