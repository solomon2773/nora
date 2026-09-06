// @ts-nocheck
// backend-api/routes/observability.ts — logging control plane HTTP surface.
//
// This file is deliberately small and structured by concern rather than a
// flat dump, because it is NOT complete after Phase 5 — later phases (5b's
// storage-migration progress endpoints, 6, 7, 12, 13, per the implementation
// plan) extend this same file rather than creating parallel ones. Known
// inconsistency, resolved per the Phase 5 task brief: the plan's Phase 5
// "Files" list only mentions retentionSweeper.ts/platformSettings.ts, but
// its "Changes"/"Functions" sections require GET/PUT /admin/log-storage and
// item 7b's DELETE /logs, and Phase 5b's spec already refers to
// "routes/observability.ts (PUT /admin/log-storage extended)" as if it
// exists by then — so this file is created now, in Phase 5, as the home for
// all of it.
//
// Mounted at "/" in server.ts (after the global `authenticateToken`
// middleware), so `req.user` is always populated below.
//
// ── Section map ───────────────────────────────────────────────────────────
//   1. Manual log deletion         — DELETE /logs                  (item 7b)
//   2. Platform storage settings   — GET/PUT /admin/log-storage    (item 7a-ii)

const express = require("express");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("../crypto");
const monitoring = require("../monitoring");
const { requireAdmin } = require("../middleware/auth");
const { findAccessibleAgentForActor } = require("../middleware/ownership");
const { asyncHandler } = require("../middleware/errorHandler");
const objectStorage = require("../../agent-runtime/lib/objectStorage.ts");
const { getEnabledBackends } = require("../../agent-runtime/lib/backendCatalog.ts");
const retentionSweeper = require("../../workers/provisioner/logs/retentionSweeper.ts");
const logStorageConfigModule = require("../../workers/provisioner/logs/logStorageConfig.ts");
const storageMigration = require("../../workers/provisioner/logs/storageMigration.ts");
const db = require("../db");

const router = express.Router();

// Scope guards to this router's actual prefixes, matching adminMembers.ts's
// convention, so an unrelated /admin/* request continues past this router to
// routes/admin.ts rather than being intercepted by a mount-wide guard.
router.use("/admin/log-storage", requireAdmin);

// ─── 1. Manual log deletion (item 7b) ──────────────────────────────────────

/**
 * DELETE /logs
 * Body: { agentId, from, to }
 *
 * Removes matching `log_segments` (and their objects) plus any
 * `log_segment_legacy_copies` in range, scoped to a workspace the actor has
 * editor-or-above role in — `findAccessibleAgentForActor` (already used
 * throughout the codebase for exactly this workspace-role check, e.g.
 * `middleware/ownership.ts`'s `requireAccessibleAgent`) is reused here
 * rather than reinventing workspace-role checking, per the task brief. This
 * is the only way an operator reclaims local disk space short of raising
 * the cap — there is no automatic eviction, by design (see the manifest's
 * "no-automatic-eviction" decision).
 */
router.delete(
  "/logs",
  asyncHandler(async (req, res) => {
    const { agentId, from, to } = req.body || {};
    if (!agentId || !from || !to) {
      return res.status(400).json({ error: "agentId, from, and to are required" });
    }

    try {
      const result = await retentionSweeper.deleteLogsByAgentAndRange(
        agentId,
        from,
        to,
        req.user,
      );
      res.json(result);
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }),
);

// ─── 2. Platform storage destination setting (item 7a-ii) ──────────────────

const LOG_STORAGE_BACKENDS = new Set(["local", "s3", "r2", "ssh"]);

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maskSecret(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (normalized.length <= 12) return `${normalized.slice(0, 4)}...`;
  return `${normalized.slice(0, 10)}...${normalized.slice(-4)}`;
}

async function readLogStorageRow() {
  const result = await db.query(
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
  return result.rows[0] || {};
}

/**
 * Admin-safe log storage settings payload — masked credential status, never
 * decrypted secrets, mirroring `resolveBackupSettingsPayload`'s shape.
 */
function resolveLogStoragePayload(row) {
  const envBackend = normalizeText(process.env.NORA_LOG_STORAGE);
  const storageBackend = row.log_storage_backend || envBackend || "local";
  let storedS3KeyMasked = "";
  let storedS3SecretMasked = "";
  let storedSshPrivateKeyMasked = "";
  let storedSshPasswordMasked = "";
  try {
    if (row.log_storage_s3_access_key_id_encrypted)
      storedS3KeyMasked = maskSecret(decrypt(row.log_storage_s3_access_key_id_encrypted));
    if (row.log_storage_s3_secret_access_key_encrypted)
      storedS3SecretMasked = maskSecret(decrypt(row.log_storage_s3_secret_access_key_encrypted));
    if (row.log_storage_ssh_private_key_encrypted) storedSshPrivateKeyMasked = "Configured";
    if (row.log_storage_ssh_password_encrypted)
      storedSshPasswordMasked = maskSecret(decrypt(row.log_storage_ssh_password_encrypted));
  } catch {
    storedS3KeyMasked = storedS3KeyMasked || "unreadable";
  }

  return {
    storageBackend,
    storageBackendSource: row.log_storage_backend ? "database" : envBackend ? "env" : "default",
    localPath: row.log_storage_local_path || process.env.NORA_LOG_DIR || "/var/lib/nora-logs",
    s3Bucket: row.log_storage_s3_bucket || process.env.NORA_LOG_S3_BUCKET || "",
    s3Region: row.log_storage_s3_region || process.env.NORA_LOG_S3_REGION || "",
    s3Endpoint: row.log_storage_s3_endpoint || process.env.NORA_LOG_S3_ENDPOINT || "",
    s3AccessKeyConfigured: Boolean(row.log_storage_s3_access_key_id_encrypted),
    s3AccessKeyMasked: storedS3KeyMasked,
    s3SecretConfigured: Boolean(row.log_storage_s3_secret_access_key_encrypted),
    s3SecretMasked: storedS3SecretMasked,
    sshHost: row.log_storage_ssh_host || "",
    sshPort: row.log_storage_ssh_port || 22,
    sshUsername: row.log_storage_ssh_username || "",
    sshRemotePath: row.log_storage_ssh_remote_path || "",
    sshPrivateKeyConfigured: Boolean(row.log_storage_ssh_private_key_encrypted),
    sshPrivateKeyMasked: storedSshPrivateKeyMasked,
    sshPasswordConfigured: Boolean(row.log_storage_ssh_password_encrypted),
    sshPasswordMasked: storedSshPasswordMasked,
  };
}

/**
 * GET /admin/log-storage
 * Current platform-wide log segment storage destination (masked
 * credentials), plus the current capacity status so the admin UI can show
 * both together.
 */
router.get(
  "/admin/log-storage",
  asyncHandler(async (_req, res) => {
    const row = await readLogStorageRow();
    const capacity = await retentionSweeper.getCapacityStatus();
    res.json({ ...resolveLogStoragePayload(row), capacity });
  }),
);

/**
 * PUT /admin/log-storage
 * Body: { storageBackend, localPath?, s3Bucket?, s3Region?, s3Endpoint?,
 *   s3AccessKeyId?, s3SecretAccessKey?, clearS3AccessKey?, clearS3SecretAccessKey?,
 *   sshHost?, sshPort?, sshUsername?, sshRemotePath?, sshPrivateKey?, sshPassword?,
 *   clearSshPrivateKey?, clearSshPassword? }
 *
 * Two hard rules (item 7a-ii):
 *   - Selecting `local` while `k8s` is an enabled deploy target
 *     (ENABLED_BACKENDS) is REJECTED here with a validation error — not
 *     merely warned about, since this is now a runtime-changeable setting
 *     and there is no boot-time restart left at which a warning would ever
 *     be seen (Design Decision 2d).
 *   - Every change writes an `events` row via `monitoring.logEvent` — it's
 *     an operator action that changes what other people can see.
 *
 * Changing the destination moves no data in this phase: new segments go to
 * the new destination; existing ones stay readable via their recorded
 * `storage_backend`/`storage_config` (Phase 1/3). The background migration
 * of existing segments is Phase 5b, not built here.
 */
router.put(
  "/admin/log-storage",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const storageBackend = normalizeText(body.storageBackend).toLowerCase();
    if (!LOG_STORAGE_BACKENDS.has(storageBackend)) {
      return res.status(400).json({ error: "storageBackend must be local, s3, r2, or ssh" });
    }

    if (storageBackend === "local") {
      const enabledBackends = getEnabledBackends(process.env);
      if (enabledBackends.includes("k8s")) {
        return res.status(400).json({
          error:
            "storageBackend cannot be local while k8s is an enabled deploy target " +
            "(ENABLED_BACKENDS includes k8s) — the local driver is unsupported on Kubernetes. " +
            "Choose s3 or r2 instead.",
          code: "local_unsupported_with_k8s",
        });
      }
    }

    // Phase 5b item 7: the previous destination's credentials must stay
    // configured for the life of any migration job that still references it,
    // and — when kept — until every legacy copy referencing it has expired.
    // Reject a request to CLEAR those specific credential fields outright,
    // before any other validation or side effect, while either condition
    // holds. S3 and R2 share the same credential columns (R2 is
    // S3-compatible), so clearing either protects both backend names.
    const clearingS3Credentials = Boolean(body.clearS3AccessKey || body.clearS3SecretAccessKey);
    const clearingSshCredentials = Boolean(body.clearSshPrivateKey || body.clearSshPassword);
    if (clearingS3Credentials || clearingSshCredentials) {
      const protectedBackends = await storageMigration.backendsRequiringRetainedCredentials({ db });
      if (clearingS3Credentials && (protectedBackends.has("s3") || protectedBackends.has("r2"))) {
        return res.status(409).json({
          error:
            "Cannot clear S3/R2 credentials while a storage migration or a kept legacy copy still " +
            "references that destination — its objects must remain readable until the migration " +
            "completes or the legacy copy expires.",
          code: "log_storage_credentials_in_use",
        });
      }
      if (clearingSshCredentials && protectedBackends.has("ssh")) {
        return res.status(409).json({
          error:
            "Cannot clear SSH credentials while a storage migration or a kept legacy copy still " +
            "references that destination — its objects must remain readable until the migration " +
            "completes or the legacy copy expires.",
          code: "log_storage_credentials_in_use",
        });
      }
    }

    const current = await readLogStorageRow();
    const previous = resolveLogStoragePayload(current);
    const keepSourceCopies = Boolean(body.keepSourceCopies);
    const backendIsChanging = storageBackend !== previous.storageBackend;

    // Phase 5b items 1/8: a destination change kicks off an async migration
    // of every previously-written segment. Reject the whole request, with NO
    // side effects at all, up front when either an overlapping migration is
    // already in flight or (when the new destination is local) there isn't
    // real capacity for the exact bytes about to be migrated — this must
    // happen BEFORE the settings row is written below.
    if (backendIsChanging) {
      const activeJob = await db.query(
        `SELECT id FROM storage_migration_jobs WHERE status IN ('running','paused') LIMIT 1`,
      );
      if (activeJob.rows[0]) {
        return res.status(409).json({
          error:
            "A storage migration is already in progress; wait for it to complete before changing " +
            "the destination again",
          code: "log_storage_migration_in_progress",
        });
      }

      if (storageBackend === "local") {
        const usedBytes = await retentionSweeper.localStorageUsage();
        const bytesResult = await db.query(
          `SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes FROM log_segments WHERE storage_backend = $1`,
          [previous.storageBackend],
        );
        const bytesToMigrate = Number(bytesResult.rows[0]?.bytes || 0);
        const limitBytes = Number(process.env.NORA_LOG_LOCAL_MAX_BYTES) || Infinity;
        if (Number.isFinite(limitBytes) && usedBytes + bytesToMigrate > limitBytes) {
          return res.status(400).json({
            error:
              `Migrating ${bytesToMigrate} byte(s) currently on "${previous.storageBackend}" to local ` +
              `storage would exceed the configured cap (${usedBytes} already used + ${bytesToMigrate} ` +
              `to migrate > ${limitBytes} byte limit). Raise NORA_LOG_LOCAL_MAX_BYTES or free space first.`,
            code: "log_storage_capacity_exceeded",
          });
        }
      }
    }

    let s3AccessKeyIdEncrypted = current.log_storage_s3_access_key_id_encrypted || null;
    let s3SecretAccessKeyEncrypted = current.log_storage_s3_secret_access_key_encrypted || null;
    let sshPrivateKeyEncrypted = current.log_storage_ssh_private_key_encrypted || null;
    let sshPasswordEncrypted = current.log_storage_ssh_password_encrypted || null;

    if (body.clearS3AccessKey) {
      s3AccessKeyIdEncrypted = null;
    } else if (body.s3AccessKeyId !== undefined && body.s3AccessKeyId !== null) {
      const value = normalizeText(body.s3AccessKeyId);
      if (value) {
        ensureEncryptionConfigured("Log storage credential storage");
        s3AccessKeyIdEncrypted = encrypt(value);
      }
    }
    if (body.clearS3SecretAccessKey) {
      s3SecretAccessKeyEncrypted = null;
    } else if (body.s3SecretAccessKey !== undefined && body.s3SecretAccessKey !== null) {
      const value = normalizeText(body.s3SecretAccessKey);
      if (value) {
        ensureEncryptionConfigured("Log storage credential storage");
        s3SecretAccessKeyEncrypted = encrypt(value);
      }
    }
    if (body.clearSshPrivateKey) {
      sshPrivateKeyEncrypted = null;
    } else if (body.sshPrivateKey !== undefined && body.sshPrivateKey !== null) {
      const value = String(body.sshPrivateKey).trim();
      if (value) {
        ensureEncryptionConfigured("Log storage credential storage");
        sshPrivateKeyEncrypted = encrypt(value);
      }
    }
    if (body.clearSshPassword) {
      sshPasswordEncrypted = null;
    } else if (body.sshPassword !== undefined && body.sshPassword !== null) {
      const value = String(body.sshPassword);
      if (value) {
        ensureEncryptionConfigured("Log storage credential storage");
        sshPasswordEncrypted = encrypt(value);
      }
    }

    const localPath = normalizeText(body.localPath) || current.log_storage_local_path || "/var/lib/nora-logs";
    const s3Bucket = normalizeText(body.s3Bucket) || current.log_storage_s3_bucket || "";
    const s3Region = normalizeText(body.s3Region) || current.log_storage_s3_region || "";
    const s3Endpoint = normalizeText(body.s3Endpoint) || current.log_storage_s3_endpoint || "";
    const sshHost = normalizeText(body.sshHost) || current.log_storage_ssh_host || "";
    const sshPort = Number.isFinite(Number(body.sshPort))
      ? Number(body.sshPort)
      : current.log_storage_ssh_port || 22;
    const sshUsername = normalizeText(body.sshUsername) || current.log_storage_ssh_username || "";
    const sshRemotePath =
      normalizeText(body.sshRemotePath) || current.log_storage_ssh_remote_path || "";

    const result = await db.query(
      `INSERT INTO platform_settings(
         singleton,
         log_storage_backend,
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
         log_storage_ssh_password_encrypted,
         updated_at
       )
       VALUES(TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (singleton) DO UPDATE SET
         log_storage_backend = EXCLUDED.log_storage_backend,
         log_storage_local_path = EXCLUDED.log_storage_local_path,
         log_storage_s3_bucket = EXCLUDED.log_storage_s3_bucket,
         log_storage_s3_region = EXCLUDED.log_storage_s3_region,
         log_storage_s3_endpoint = EXCLUDED.log_storage_s3_endpoint,
         log_storage_s3_access_key_id_encrypted = EXCLUDED.log_storage_s3_access_key_id_encrypted,
         log_storage_s3_secret_access_key_encrypted = EXCLUDED.log_storage_s3_secret_access_key_encrypted,
         log_storage_ssh_host = EXCLUDED.log_storage_ssh_host,
         log_storage_ssh_port = EXCLUDED.log_storage_ssh_port,
         log_storage_ssh_username = EXCLUDED.log_storage_ssh_username,
         log_storage_ssh_remote_path = EXCLUDED.log_storage_ssh_remote_path,
         log_storage_ssh_private_key_encrypted = EXCLUDED.log_storage_ssh_private_key_encrypted,
         log_storage_ssh_password_encrypted = EXCLUDED.log_storage_ssh_password_encrypted,
         updated_at = NOW()
       RETURNING
         log_storage_backend, log_storage_local_path, log_storage_s3_bucket,
         log_storage_s3_region, log_storage_s3_endpoint,
         log_storage_s3_access_key_id_encrypted, log_storage_s3_secret_access_key_encrypted,
         log_storage_ssh_host, log_storage_ssh_port, log_storage_ssh_username,
         log_storage_ssh_remote_path, log_storage_ssh_private_key_encrypted,
         log_storage_ssh_password_encrypted`,
      [
        storageBackend,
        localPath,
        s3Bucket,
        s3Region,
        s3Endpoint,
        s3AccessKeyIdEncrypted,
        s3SecretAccessKeyEncrypted,
        sshHost,
        sshPort,
        sshUsername,
        sshRemotePath,
        sshPrivateKeyEncrypted,
        sshPasswordEncrypted,
      ],
    );

    // Invalidate the segment writer's cached destination (Phase 3's
    // logStorageConfig() caches across calls) so the very next flush picks
    // up the new destination rather than the process's stale cache.
    logStorageConfigModule.invalidateLogStorageConfigCache();

    const nextSettings = resolveLogStoragePayload(result.rows[0] || {});

    // Every change writes an events row (item 7a-ii) — this is an operator
    // action that changes what other people can see.
    await monitoring.logEvent(
      "admin_log_storage_settings_updated",
      `Admin updated log storage destination to ${nextSettings.storageBackend}`,
      {
        actorId: req.user?.id,
        settings: { kind: "log_storage", previous, next: nextSettings },
      },
    );

    // Phase 5b item 1: the resolved config has already flipped above (the
    // cache invalidation call), so new writes go to the new destination
    // immediately. Now kick off the async migration of every
    // previously-written segment, if the destination actually changed.
    let migration = null;
    if (backendIsChanging) {
      try {
        const started = await storageMigration.startStorageMigration(
          { storageBackend: previous.storageBackend },
          { storageBackend: nextSettings.storageBackend },
          keepSourceCopies,
        );
        migration = { jobId: started.jobId, segmentsTotal: started.segmentsTotal, status: "running" };
      } catch (error) {
        // The pre-flight checks above should make this unreachable in
        // practice, but never let a race here silently drop the migration —
        // surface it as part of the response rather than throwing after the
        // settings row (and the operator-visible destination) already
        // changed.
        migration = { error: error.message, code: error.code };
      }
    }

    res.json({ ...nextSettings, migration });
  }),
);

// ─── 3. Storage migration progress (Phase 5b item 6) ───────────────────────

/**
 * GET /admin/log-storage/migration
 * The current or most-recent migration job's progress:
 * `segments_migrated`/`segments_total` and `status` (`running` | `paused` |
 * `completed` | `failed`), for the admin settings UI to poll.
 */
router.get(
  "/admin/log-storage/migration",
  asyncHandler(async (_req, res) => {
    const status = await storageMigration.getMigrationStatus({ db });
    res.json(status);
  }),
);

module.exports = router;
