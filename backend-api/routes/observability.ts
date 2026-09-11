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
//   3. Storage migration progress  — GET /admin/log-storage/migration
//   4. Search                      — GET /logs/search              (Phase 6)
//   5. Export                      — GET /logs/export              (Phase 7)
//   6. Workspace log settings      — GET/PUT /workspaces/:id/log-settings (Phase 12)
//   7. Traces                      — GET /traces, GET /traces/:traceId (Phase 13)

const express = require("express");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("../crypto");
const monitoring = require("../monitoring");
const { requireAdmin, scopeByMethod } = require("../middleware/auth");
const {
  findAccessibleAgentForActor,
  apiKeyWorkspaceId,
  enforceApiKeyAgentScope,
  requireWorkspaceRole,
} = require("../middleware/ownership");
const { asyncHandler } = require("../middleware/errorHandler");
const objectStorage = require("../../agent-runtime/lib/objectStorage.ts");
const { getEnabledBackends } = require("../../agent-runtime/lib/backendCatalog.ts");
const retentionSweeper = require("../../workers/provisioner/logs/retentionSweeper.ts");
const logStorageConfigModule = require("../../workers/provisioner/logs/logStorageConfig.ts");
const storageMigration = require("../../workers/provisioner/logs/storageMigration.ts");
const logSearch = require("../logSearch.ts");
const agentTracing = require("../agentTracing.ts");
const traceQuery = require("../traceQuery.ts");
const db = require("../db");

const router = express.Router();

// Phase 6 item 9: logs:read gates both search and export for API-key
// callers. Session callers (browser dashboards) pass through unchanged —
// scopeByMethod only enforces scopes when `req.apiKey` is present.
router.use(["/logs/search", "/logs/export"], scopeByMethod("logs:read", null));

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

// Plain-language messages for the S3/R2 error codes an operator is actually
// likely to hit while setting up a destination (bad/mismatched keys, wrong
// bucket, wrong region) — AWS's own `Message` text for these is accurate
// but written for developers debugging a signing implementation, not for
// someone who just needs to know "your secret key is wrong." Anything not
// in this map still gets a real, specific message (objectStorage.ts's
// parsed `Code (Message)` form) — this only shortens the handful of common
// cases, never hides an error behind a generic one.
const FRIENDLY_S3_ERROR_MESSAGES = {
  SignatureDoesNotMatch: "Invalid access key ID or secret access key.",
  InvalidAccessKeyId: "Invalid access key ID.",
  AccessDenied: "Access denied — check the credentials' permissions on this bucket.",
  NoSuchBucket: "Bucket not found.",
};

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

    // Verify the destination actually works BEFORE committing to it — never
    // persist untested credentials as the active destination. Without this,
    // a typo'd secret key would get written to platform_settings and the
    // resolved-config cache flipped immediately (see the cache-invalidation
    // call below), meaning every live log flush from that moment on
    // silently starts failing against a destination nobody ever confirmed
    // works — not just the historical migration, which is the only thing
    // that visibly failed before this check existed.
    if (storageBackend !== "local") {
      const candidateConfig = {
        storageBackend,
        bucket: s3Bucket,
        region: s3Region,
        endpoint: s3Endpoint,
        accessKeyId: s3AccessKeyIdEncrypted ? decrypt(s3AccessKeyIdEncrypted) : "",
        secretAccessKey: s3SecretAccessKeyEncrypted ? decrypt(s3SecretAccessKeyEncrypted) : "",
        sshHost,
        sshPort,
        sshUsername,
        sshRemotePath,
        sshPrivateKey: sshPrivateKeyEncrypted ? decrypt(sshPrivateKeyEncrypted) : "",
        sshPassword: sshPasswordEncrypted ? decrypt(sshPasswordEncrypted) : "",
      };
      try {
        await objectStorage.probeStorageDestination(candidateConfig);
      } catch (error) {
        const message = FRIENDLY_S3_ERROR_MESSAGES[error.remoteCode] || error.message;
        return res.status(400).json({
          error: `Destination check failed: ${message}`,
          code: "log_storage_probe_failed",
        });
      }
    }

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

/**
 * POST /admin/log-storage/migration/retry
 *
 * Re-drives the most recent `failed` migration job from its checkpoint.
 * Exists because `PUT /admin/log-storage` only starts a new migration when
 * `storageBackend` actually changes — but that column is written before the
 * migration is attempted, so after a failure it already reads as the failed
 * migration's target. Simply fixing credentials and re-saving the same
 * destination looks like a no-op to that check, so it silently never
 * retries. This is the actual recovery path.
 */
router.post(
  "/admin/log-storage/migration/retry",
  asyncHandler(async (req, res) => {
    try {
      const result = await storageMigration.retryStorageMigration({ db });
      await monitoring.logEvent(
        "admin_log_storage_migration_retried",
        `Admin retried failed storage migration job ${result.jobId}`,
        { actorId: req.user?.id, jobId: result.jobId },
      );
      res.json({ status: "running", jobId: result.jobId });
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message, code: error.code });
    }
  }),
);

// ─── 4. Search (Phase 6) ────────────────────────────────────────────────

/**
 * Accepts either a single query value or Express's array-parsed
 * `?streams=a&streams=b` / `?streams[]=a` form, plus a comma-separated
 * single value (`?streams=runtime,gateway`), for convenience across CLI and
 * dashboard callers.
 */
function parseArrayParam(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.flatMap((entry) => String(entry).split(","));
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sendLogError(res, error) {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
}

/**
 * GET /logs/search
 * Query: workspaceId, agentId (required), streams[], levels[], from, to, q,
 * traceId, cursor, limit, order.
 *
 * `agentId` is singular and required (item 2) — this endpoint serves one
 * agent's timeline, never a merged cross-agent view (see the manifest's
 * Non-Goals).
 *
 * Workspace/agent scoping for a session caller runs through
 * `findAccessibleAgentForActor` plus `logSearch.enforceWorkspaceScope`
 * (items 8/8a/8b/8c). An API-key caller is scoped BEFORE any of that, by
 * `enforceApiKeyAgentScope` below — the same guard `requireAccessibleAgent`
 * uses elsewhere — and its bound workspace is threaded straight through
 * rather than trusting an arbitrary `workspaceId` query value.
 */
router.get(
  "/logs/search",
  asyncHandler(async (req, res) => {
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : "";
    if (!(await enforceApiKeyAgentScope(req, res, agentId))) return;

    const workspaceId = req.apiKey
      ? apiKeyWorkspaceId(req)
      : typeof req.query.workspaceId === "string"
        ? req.query.workspaceId.trim()
        : null;

    try {
      const result = await logSearch.searchLogs(
        {
          workspaceId,
          agentId,
          streams: parseArrayParam(req.query.streams),
          levels: parseArrayParam(req.query.levels),
          from: req.query.from,
          to: req.query.to,
          q: typeof req.query.q === "string" ? req.query.q : undefined,
          traceId: req.query.traceId,
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
          limit: req.query.limit,
          order: req.query.order,
        },
        req.user,
      );
      res.json(result);
    } catch (error) {
      sendLogError(res, error);
    }
  }),
);

// ─── 5. Export (Phase 7) ────────────────────────────────────────────────

/**
 * GET /logs/export
 * Same filters as /logs/search, without pagination. Streams NDJSON
 * (default) or CSV — pick with `?format=csv` or an `Accept: text/csv`
 * header; anything else (including no preference at all) streams NDJSON.
 * Requires `from`/`to` and rejects a range wider than the configured cap
 * (item 4) with an actionable `export_range_too_large` error.
 */
router.get(
  "/logs/export",
  asyncHandler(async (req, res) => {
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : "";
    if (!(await enforceApiKeyAgentScope(req, res, agentId))) return;

    const workspaceId = req.apiKey
      ? apiKeyWorkspaceId(req)
      : typeof req.query.workspaceId === "string"
        ? req.query.workspaceId.trim()
        : null;

    try {
      await logSearch.streamLogExport(
        {
          workspaceId,
          agentId,
          streams: parseArrayParam(req.query.streams),
          levels: parseArrayParam(req.query.levels),
          from: req.query.from,
          to: req.query.to,
          q: typeof req.query.q === "string" ? req.query.q : undefined,
          format: typeof req.query.format === "string" ? req.query.format : undefined,
          accept: req.headers.accept,
        },
        req.user,
        res,
      );
    } catch (error) {
      if (res.headersSent) {
        // Streaming had already started (headers/rows written) — there is
        // no clean way to downgrade to a JSON error mid-stream, so just end
        // the response after logging server-side.
        console.error(`[observability] /logs/export failed mid-stream: ${error.message}`);
        res.end();
        return;
      }
      sendLogError(res, error);
    }
  }),
);

// ─── 6. Workspace log settings (Phase 12 item 6) ───────────────────────────

const WORKSPACE_LOG_SETTINGS_COLUMNS = `
  runtime_retention_days, trace_retention_days,
  gateway_logs_enabled, traces_enabled, trace_sample_rate
`;

/**
 * Current effective workspace_log_settings row, or the same platform
 * defaults every other Phase 12/5 resolver falls back to when no row exists
 * yet (a workspace's row is created lazily, on first PUT).
 *
 * `trace_sample_rate` is included for visibility (the plan's Traces lens
 * eventually reads it) but is NOT accepted on PUT below — see item 3a.
 */
async function readWorkspaceLogSettingsRow(workspaceId) {
  const result = await db.query(
    `SELECT ${WORKSPACE_LOG_SETTINGS_COLUMNS} FROM workspace_log_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (row) {
    return {
      runtimeRetentionDays: row.runtime_retention_days,
      traceRetentionDays: row.trace_retention_days,
      gatewayLogsEnabled: row.gateway_logs_enabled,
      tracesEnabled: row.traces_enabled,
      traceSampleRate: Number(row.trace_sample_rate),
    };
  }
  return {
    runtimeRetentionDays: 30,
    traceRetentionDays: 30,
    gatewayLogsEnabled: agentTracing.PLATFORM_LOG_SETTINGS_DEFAULTS.gateway_logs_enabled,
    tracesEnabled: agentTracing.PLATFORM_LOG_SETTINGS_DEFAULTS.traces_enabled,
    traceSampleRate: agentTracing.PLATFORM_LOG_SETTINGS_DEFAULTS.trace_sample_rate,
  };
}

/**
 * GET /workspaces/:id/log-settings
 * Retention (Phase 5) and enablement (gateway_logs_enabled, traces_enabled)
 * together, so the settings UI has one call for the whole logging policy.
 * `traceSampleRate` is read-only here (item 3a) — no PUT field changes it.
 */
router.get(
  "/workspaces/:id/log-settings",
  requireWorkspaceRole("admin", "id"),
  asyncHandler(async (req, res) => {
    res.json(await readWorkspaceLogSettingsRow(req.params.id));
  }),
);

/**
 * PUT /workspaces/:id/log-settings
 * Body: { runtimeRetentionDays?, traceRetentionDays?, gatewayLogsEnabled?,
 *   tracesEnabled? } — any subset; omitted fields keep their current (or
 * default) value. `traceSampleRate` is deliberately not accepted (item 3a):
 * it stays whatever the column already holds (1.0 by default) and is never
 * user-settable in this phase.
 *
 * When `tracesEnabled` actually changes, immediately re-applies (or removes)
 * the agent-side tracing config for every agent in this workspace, rather
 * than waiting for the next 30s reconcile tick — the reconcile loop still
 * exists as the self-healing backstop for restarts, but a deliberate
 * operator toggle should take effect right away. Best-effort per agent: one
 * unreachable agent doesn't fail the settings update itself.
 */
router.put(
  "/workspaces/:id/log-settings",
  requireWorkspaceRole("admin", "id"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.id;
    const body = req.body || {};
    const current = await readWorkspaceLogSettingsRow(workspaceId);

    function parseRetentionDays(value, fallback) {
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) return null;
      return parsed;
    }
    function parseBooleanField(value, fallback) {
      if (value === undefined) return fallback;
      return Boolean(value);
    }

    const runtimeRetentionDays = parseRetentionDays(
      body.runtimeRetentionDays,
      current.runtimeRetentionDays,
    );
    const traceRetentionDays = parseRetentionDays(
      body.traceRetentionDays,
      current.traceRetentionDays,
    );
    if (runtimeRetentionDays === null || traceRetentionDays === null) {
      return res
        .status(400)
        .json({ error: "runtimeRetentionDays and traceRetentionDays must be integers >= 1" });
    }
    const gatewayLogsEnabled = parseBooleanField(
      body.gatewayLogsEnabled,
      current.gatewayLogsEnabled,
    );
    const tracesEnabledChanging =
      body.tracesEnabled !== undefined && Boolean(body.tracesEnabled) !== current.tracesEnabled;
    const tracesEnabled = parseBooleanField(body.tracesEnabled, current.tracesEnabled);

    const result = await db.query(
      `INSERT INTO workspace_log_settings(
         workspace_id, runtime_retention_days, trace_retention_days,
         gateway_logs_enabled, traces_enabled, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET
         runtime_retention_days = EXCLUDED.runtime_retention_days,
         trace_retention_days = EXCLUDED.trace_retention_days,
         gateway_logs_enabled = EXCLUDED.gateway_logs_enabled,
         traces_enabled = EXCLUDED.traces_enabled,
         updated_at = NOW()
       RETURNING ${WORKSPACE_LOG_SETTINGS_COLUMNS}`,
      [workspaceId, runtimeRetentionDays, traceRetentionDays, gatewayLogsEnabled, tracesEnabled],
    );
    const row = result.rows[0];

    await monitoring.logEvent(
      "workspace_log_settings_updated",
      `Workspace ${workspaceId} log settings updated`,
      {
        actorId: req.user?.id,
        workspace: { id: workspaceId },
        settings: { kind: "workspace_log_settings", previous: current, next: row },
      },
    );

    if (tracesEnabledChanging) {
      try {
        const agentsResult = await db.query(
          `SELECT a.id, a.user_id, a.container_id, a.backend_type, a.deploy_target,
                  a.execution_target_id, a.runtime_family, a.sandbox_profile, a.status,
                  a.host, a.runtime_host, a.runtime_port, a.gateway_host, a.gateway_port
             FROM agents a
             JOIN workspace_agents wa ON wa.agent_id = a.id
            WHERE wa.workspace_id = $1
              AND a.container_id IS NOT NULL
              AND a.status IN ('running', 'warning')`,
          [workspaceId],
        );
        for (const agent of agentsResult.rows) {
          try {
            await agentTracing.applyTracingConfig(agent);
          } catch {
            // Best-effort — the 30s reconcile loop will retry.
          }
        }
      } catch {
        // Best-effort — the 30s reconcile loop will retry.
      }
    }

    res.json({
      runtimeRetentionDays: row.runtime_retention_days,
      traceRetentionDays: row.trace_retention_days,
      gatewayLogsEnabled: row.gateway_logs_enabled,
      tracesEnabled: row.traces_enabled,
      traceSampleRate: Number(row.trace_sample_rate),
    });
  }),
);

// ─── 7. Traces (Phase 13) ───────────────────────────────────────────────

/**
 * GET /traces
 * Query: agentId (required), workspaceId?, from?, to?, limit?.
 *
 * Lists one agent's traces, aggregated from `agent_spans` — see
 * `traceQuery.ts`'s module header for the full response shape (`agentId`,
 * `workspaceId`, `tracesEnabled`, `traceSampleRate`, `traces[]`).
 *
 * Scoping (item 8): `traceQuery.listTraces` gates on
 * `findAccessibleAgentForActor` first, then applies `workspaceId` as an
 * additional narrowing via `logSearch.enforceWorkspaceScope` — the exact
 * same two-step gate `logSearch.searchLogs` uses, reused rather than
 * reimplemented so the Traces and Runtime lenses can never disagree about
 * what "this agent's workspace" means.
 */
router.get(
  "/traces",
  asyncHandler(async (req, res) => {
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : "";
    if (!(await enforceApiKeyAgentScope(req, res, agentId))) return;

    const workspaceId = req.apiKey
      ? apiKeyWorkspaceId(req)
      : typeof req.query.workspaceId === "string"
        ? req.query.workspaceId.trim()
        : null;

    try {
      const result = await traceQuery.listTraces(
        {
          agentId,
          workspaceId,
          from: req.query.from,
          to: req.query.to,
          limit: req.query.limit,
        },
        req.user,
      );
      res.json(result);
    } catch (error) {
      sendLogError(res, error);
    }
  }),
);

/**
 * GET /traces/:traceId
 * Query: workspaceId? — same additional-narrowing semantics as GET /traces.
 *
 * Returns the span tree plus correlated logs for one trace — see
 * `traceQuery.ts`'s module header for the full response shape (`trace`,
 * `spans[]`, `correlatedLogs[]`).
 *
 * There is no `agentId` query param here — the trace's agent is resolved
 * from its own `agent_spans` rows inside `traceQuery.getTraceDetail`, which
 * is exactly why that function gates access AFTER reading those rows
 * (using their `agent_id`) rather than requiring the caller to already
 * know it.
 *
 * API-key callers cannot go through `enforceApiKeyAgentScope` here (unlike
 * `/logs/search` and `/logs/export`) because that check needs an `agentId`
 * up front, and this route only learns the agent after the trace lookup.
 * Equivalent isolation still holds: `apiKeyWorkspaceId(req)` is passed as
 * `workspaceId` below, so `getTraceDetail`'s `enforceWorkspaceScope` call
 * rejects the request with the same `wrong_workspace` 403 the moment the
 * resolved agent's actual workspace doesn't match the key's bound one.
 */
router.get(
  "/traces/:traceId",
  asyncHandler(async (req, res) => {
    const traceId = typeof req.params.traceId === "string" ? req.params.traceId.trim() : "";
    const workspaceId = req.apiKey
      ? apiKeyWorkspaceId(req)
      : typeof req.query.workspaceId === "string"
        ? req.query.workspaceId.trim()
        : null;

    try {
      const result = await traceQuery.getTraceDetail(traceId, req.user, { workspaceId });
      res.json(result);
    } catch (error) {
      sendLogError(res, error);
    }
  }),
);

module.exports = router;
