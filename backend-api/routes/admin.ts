// @ts-nocheck
const express = require("express");
const db = require("../db");
const billing = require("../billing");
const monitoring = require("../monitoring");
const agentHubStore = require("../agentHubStore");
const { scanTemplatePayloadForSecrets } = require("../agentHubSafety");
const { buildAgentHubTemplateUpdate } = require("../agentHubTemplateEdits");
const snapshots = require("../snapshots");
const containerManager = require("../containerManager");
const releaseUpgrade = require("../releaseUpgrade");
const kubernetesClusters = require("../kubernetesClusters");
const remoteHosts = require("../remoteHosts");
const userGroups = require("../userGroups");
const doctor = require("../doctor");
const { repairHermesAgentConfig } = require("../hermesUi");
const {
  addBackupJob,
  addDeploymentJob,
  addKubernetesPolicyReconcileJob,
  cancelDeploymentJobsForAgent,
  getDLQJobs,
  retryDLQJob,
} = require("../redisQueue");
const backups = require("../backups");
const { requireAdmin, requireScope, requireSession } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { reconcileAgentStatus } = require("../agentStatus");
const {
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
  resolveContainerName,
  serializeAgent,
  summarizeTemplatePayload,
} = require("../agentPayloads");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");
const {
  KNOWN_RUNTIME_FAMILIES,
  getRuntimeSelectionStatus,
  isKnownRuntimeFamily,
  normalizeRuntimeFamilyName,
} = require("../../agent-runtime/lib/backendCatalog");
const { buildAgentHistoryResponse, buildAgentStatsResponse } = require("../agentTelemetry");
const {
  buildAgentContext,
  buildAuditMetadata,
  buildListingContext,
  buildReportContext,
  buildUserContext,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");
const {
  buildAgentRuntimeFields,
  isSameRuntimePath,
  resolveRequestedRuntimeFields,
} = require("../agentRuntimeFields");
const {
  getDeploymentDefaults,
  getAgentHubSettings,
  getBackupPlanLimits,
  getBackupSettings,
  getSmtpSettings,
  getSystemBanner,
  getLanguageSettings,
  parseRequiredDeploymentDefaults,
  updateAgentHubSettings,
  updateBackupPlanLimits,
  updateBackupSettings,
  updateDeploymentDefaults,
  updateLanguageSettings,
  updateSmtpSettings,
  updateSystemBanner,
} = require("../platformSettings");
const mailer = require("../mailer");
const { resolveAuditSource } = require("../auditSource");
const { isProviderAuthStatusHoldReason, resumeAgentWithProviderAuth } = require("../authSync");
const {
  acquireAgentProvisionLock,
  buildReplacementDeploymentJob,
  enqueueReplacementDeployment,
} = require("../agentProvisionLock");

const router = express.Router();

router.use(requireAdmin);

// Control-plane self-check (DB, queue, Kubernetes targets, secret posture,
// fleet health, gateway exposure). Backs `nora doctor` and the admin Health
// panel. API clients need the explicit admin:read scope; every other admin
// route below remains session-only. Cached briefly; pass ?fresh=1 to force a
// recompute.
router.get(
  "/doctor",
  requireScope("admin:read"),
  asyncHandler(async (req, res) => {
    const fresh = req.query.fresh === "1" || req.query.fresh === "true";
    res.json(await doctor.getDoctorReport({ fresh }));
  }),
);

router.use(requireSession);
router.use(createMutationFailureAuditMiddleware("admin"));

// Shared parsing and admin orchestration helpers

function parseInterval(pg) {
  const match = String(pg || "").match(/(\d+)\s*(day|minute|hour|second)/);
  if (!match) return 15 * 60 * 1000;

  const count = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "day") return count * 86400000;
  if (unit === "hour") return count * 3600000;
  if (unit === "minute") return count * 60000;
  return count * 1000;
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeRequestedRuntimeFamily(value) {
  if (!isKnownRuntimeFamily(value)) return null;
  return normalizeRuntimeFamilyName(value);
}

function assertRuntimeSelectionAvailable(runtimeFields) {
  const status = getRuntimeSelectionStatus(runtimeFields);
  if (!status.enabled) {
    if (status.issue && /does not support/i.test(status.issue)) {
      throw createHttpError(status.issue);
    }
    throw createHttpError(
      `Runtime selection is not enabled. Enable runtime_family=${status.runtimeFamily}, deploy_target=${status.deployTarget}, and sandbox_profile=${status.sandboxProfile} for this Nora control plane.`,
    );
  }
  if (!status.configured) {
    throw createHttpError(
      status.issue || "Runtime selection is not configured for this Nora control plane.",
    );
  }
  return status;
}

/**
 * Validate an admin-selected runtime path, including remote-host availability
 * scoped to the target agent's persisted owner rather than the acting admin.
 *
 * @param {Object} runtimeFields - Requested runtime and execution-target fields.
 * @param {Object} [options={}] - Optional owner scope for remote-host authorization.
 * @returns {Promise<Object>} Runtime selection status.
 */
async function assertRuntimeTargetAvailable(runtimeFields, { ownerUserId = null } = {}) {
  const status = assertRuntimeSelectionAvailable(runtimeFields);
  await kubernetesClusters.assertKubernetesExecutionTargetAvailable(runtimeFields);
  // The persisted agent owner remains the durable credential/host principal
  // even when a platform admin initiates the replacement.
  await remoteHosts.assertRemoteHostExecutionTargetAvailable(runtimeFields, { ownerUserId });
  return status;
}

async function enqueueAdminReplacementDeployment(agent, jobData) {
  return enqueueReplacementDeployment(agent, jobData, {
    queryable: db,
    cancelDeploymentJobsForAgent,
    addDeploymentJob,
    acquireLock: acquireAgentProvisionLock,
    applicationName: "nora-backend-admin-agent-replacement",
  });
}

function createAdminAgentNotFoundError() {
  const error = new Error("Agent not found");
  error.statusCode = 404;
  return error;
}

function assertAdminLifecycleNotProvisioning(agent) {
  if (!["queued", "deploying"].includes(agent?.status)) return;
  const error = new Error(
    "Agent deployment is queued or in progress. Wait for provisioning to finish before changing lifecycle state.",
  );
  error.statusCode = 409;
  error.code = "AGENT_PROVISIONING_IN_PROGRESS";
  throw error;
}

async function withAdminAgentLifecycleLock(agentId, applicationName, callback) {
  const visible = await findAdminAgent(agentId, { includeOwner: true });
  if (!visible) throw createAdminAgentNotFoundError();

  const provisionLock = await acquireAgentProvisionLock(agentId, { applicationName });
  try {
    const agent = await findAdminAgent(agentId, { includeOwner: true });
    if (!agent) throw createAdminAgentNotFoundError();
    assertAdminLifecycleNotProvisioning(agent);
    return await callback(agent);
  } finally {
    await provisionLock.release();
  }
}

function resolveRequestedImage({
  requestedImage,
  runtimeFields,
  fallbackImage = null,
  fallbackRuntimeFields = null,
} = {}) {
  const explicitRequestedImage = typeof requestedImage === "string" ? requestedImage.trim() : "";
  if (explicitRequestedImage) return explicitRequestedImage;

  if (
    fallbackImage &&
    fallbackRuntimeFields &&
    isSameRuntimePath(runtimeFields, fallbackRuntimeFields)
  ) {
    return fallbackImage;
  }

  return getDefaultAgentImage({
    runtime_family: runtimeFields?.runtime_family,
    backend: runtimeFields?.backend_type,
    deploy_target: runtimeFields?.deploy_target,
    sandbox_profile: runtimeFields?.sandbox_profile,
  });
}

function parsePositiveInteger(
  value,
  defaultValue,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return defaultValue;
  return Math.min(max, Math.max(min, numeric));
}

function parseAuditDate(value, { endOfDay = false } = {}) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    parsed = new Date(`${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  } else {
    parsed = new Date(trimmed);
  }

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function buildAuditFilters(query = {}) {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const type =
    typeof query.type === "string" && query.type.trim() !== "all" ? query.type.trim() : "";
  const hasFrom = typeof query.from === "string" && query.from.trim();
  const hasTo = typeof query.to === "string" && query.to.trim();
  const from = hasFrom ? parseAuditDate(query.from) : null;
  const to = hasTo ? parseAuditDate(query.to, { endOfDay: true }) : null;

  if (hasFrom && !from) {
    throw createHttpError("Invalid from date");
  }

  if (hasTo && !to) {
    throw createHttpError("Invalid to date");
  }

  if (from && to && from > to) {
    throw createHttpError("Invalid date range");
  }

  return { search, type, from, to };
}

function buildAuditPageOptions(query = {}) {
  return {
    page: parsePositiveInteger(query.page, 1),
    limit: parsePositiveInteger(query.limit, 30, { min: 10, max: 100 }),
  };
}

function normalizeEventMetadata(metadata) {
  if (!metadata) return {};

  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch {
      return { raw: metadata };
    }
  }

  return metadata;
}

function csvCell(value) {
  if (value == null) return "";

  const normalized =
    typeof value === "string" ? value.replace(/\r?\n/g, " ").trim() : String(value);
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  return normalized;
}

function buildAuditExportRows(events = []) {
  return events.map((event) => {
    const metadata = normalizeEventMetadata(event.metadata);
    const source = resolveAuditSource(metadata);

    return {
      created_at: event.created_at || "",
      id: event.id || "",
      type: event.type || "",
      message: event.message || "",
      actor_email: metadata.actor?.email || "",
      actor_user_id: metadata.actor?.userId || "",
      actor_role: metadata.actor?.role || "",
      owner_email: metadata.agent?.ownerEmail || metadata.listing?.ownerEmail || "",
      owner_user_id: metadata.agent?.ownerUserId || metadata.listing?.ownerUserId || "",
      agent_id: metadata.agent?.id || "",
      agent_name: metadata.agent?.name || "",
      user_id: metadata.user?.id || "",
      user_email: metadata.user?.email || "",
      listing_id: metadata.listing?.id || "",
      listing_name: metadata.listing?.name || "",
      request_method: metadata.request?.method || "",
      request_path: metadata.request?.path || "",
      correlation_id: metadata.request?.correlationId || "",
      source_kind: source?.kind || "",
      source_label: source?.label || "",
      source_service: source?.service || "",
      source_channel: source?.channel || "",
      source_account_email: source?.account?.email || metadata.actor?.email || "",
      source_account_user_id: source?.account?.userId || metadata.actor?.userId || "",
      source_account_role: source?.account?.role || metadata.actor?.role || "",
      source_ip: source?.ip || metadata.request?.ip || "",
      source_origin: source?.origin || metadata.request?.origin || "",
      source_user_agent: source?.userAgent || metadata.request?.userAgent || "",
      error_name: metadata.error?.name || "",
      error_code: metadata.error?.code || "",
      error_status: metadata.error?.status || "",
      error_message: metadata.error?.message || "",
      metadata_json: JSON.stringify(metadata),
    };
  });
}

function buildAuditExportCsv(events = []) {
  const rows = buildAuditExportRows(events);
  const headers = [
    "created_at",
    "id",
    "type",
    "message",
    "actor_email",
    "actor_user_id",
    "actor_role",
    "owner_email",
    "owner_user_id",
    "agent_id",
    "agent_name",
    "user_id",
    "user_email",
    "listing_id",
    "listing_name",
    "request_method",
    "request_path",
    "correlation_id",
    "source_kind",
    "source_label",
    "source_service",
    "source_channel",
    "source_account_email",
    "source_account_user_id",
    "source_account_role",
    "source_ip",
    "source_origin",
    "source_user_agent",
    "error_name",
    "error_code",
    "error_status",
    "error_message",
    "metadata_json",
  ];

  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

function buildAuditExportFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `nora-audit-${timestamp}.csv`;
}

function resolveHistoryWindow(query = {}) {
  const rangeMap = {
    "5m": "5 minutes",
    "15m": "15 minutes",
    "30m": "30 minutes",
    "1h": "1 hour",
    "6h": "6 hours",
    "24h": "24 hours",
    "3d": "3 days",
    "7d": "7 days",
  };

  if (query.from && query.to) {
    return {
      fromTime: new Date(query.from),
      toTime: new Date(query.to),
    };
  }

  const range = rangeMap[query.range || "15m"] || "15 minutes";
  const toTime = new Date();
  const fromTime = new Date(Date.now() - parseInterval(range));
  return { fromTime, toTime };
}

async function listAdminAgents() {
  const result = await db.query(
    `SELECT a.*, u.email AS "ownerEmail"
       FROM agents a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC`,
  );
  return result.rows.map((row) => serializeAgent(row));
}

async function findAdminAgent(agentId, { includeOwner = false } = {}) {
  const result = includeOwner
    ? await db.query(
        `SELECT a.*, u.email AS "ownerEmail"
           FROM agents a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id = $1`,
        [agentId],
      )
    : await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);

  return result.rows[0] || null;
}

function adminAuditMetadata(req, context = {}) {
  return buildAuditMetadata(req, context);
}

function adminAgentAuditMetadata(req, agent, extra = {}) {
  return buildAuditMetadata(req, buildAgentContext(agent, extra));
}

function adminUserAuditMetadata(req, user, extra = {}) {
  return buildAuditMetadata(req, buildUserContext(user, extra));
}

function adminListingAuditMetadata(req, listing, extra = {}) {
  return buildAuditMetadata(req, buildListingContext(listing, extra));
}

function adminReportAuditMetadata(req, report, extra = {}) {
  return buildAuditMetadata(req, buildReportContext(report, extra));
}

/**
 * Best-effort reconcile an admin-visible agent's stored status with its live runtime.
 *
 * @param {Object} agent - Mutable agent row being returned to the admin.
 * @returns {Promise<Object>} Agent with reconciled status when the runtime was reachable.
 */
async function reconcileAdminAgent(agent) {
  if (
    !agent?.container_id ||
    isProviderAuthStatusHoldReason(agent.paused_reason) ||
    !["running", "warning", "error", "stopped"].includes(agent.status)
  ) {
    return agent;
  }

  try {
    const live = await containerManager.status(agent);
    const reconciledStatus = reconcileAgentStatus(agent.status, Boolean(live.running));

    if (reconciledStatus !== agent.status) {
      // Guarded on the observed status so this read-path reconcile cannot
      // clobber a deploy that started while the liveness probe was in flight.
      const reconciled = await db.query(
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3 RETURNING id",
        [reconciledStatus, agent.id, agent.status],
      );
      // Mirror in memory only when the row actually changed, so a lost
      // compare-and-swap cannot make the response disagree with the DB.
      if (reconciled?.rows?.length) {
        agent.status = reconciledStatus;
      }
    }
  } catch {
    // Leave the stored status alone when the runtime is unreachable.
  }

  return agent;
}

async function countAdminUsers() {
  const result = await db.query("SELECT count(*)::int AS total FROM users WHERE role = 'admin'");
  return result.rows[0]?.total || 0;
}

async function buildAdminListingDetail(listing, reports = [], options = {}) {
  const snapshot = listing?.snapshot_id ? await snapshots.getSnapshot(listing.snapshot_id) : null;
  const templatePayload = snapshot
    ? extractTemplatePayloadFromSnapshot(snapshot, { includeBootstrap: true })
    : null;
  const template = templatePayload
    ? summarizeTemplatePayload(templatePayload, {
        includeContent: options.includeContent === true,
        runtimeFamily: listing?.runtime_family || null,
      })
    : null;

  return {
    ...listing,
    snapshot: snapshot
      ? {
          id: snapshot.id,
          kind: snapshot.kind,
          templateKey: snapshot.template_key || null,
        }
      : null,
    defaults: snapshot ? extractTemplateDefaultsFromSnapshot(snapshot) : null,
    template:
      template && options.includeContent
        ? template
        : template
          ? {
              fileCount: template.fileCount,
              memoryFileCount: template.memoryFileCount,
              integrationCount: template.integrationCount,
              channelCount: template.channelCount,
              requiredCoreCount: template.requiredCoreCount,
              presentRequiredCoreCount: template.presentRequiredCoreCount,
              missingRequiredCoreFiles: template.missingRequiredCoreFiles,
              hasBootstrap: template.hasBootstrap,
              extraFilesCount: template.extraFilesCount,
              coreFiles: template.coreFiles.map((file) => ({
                path: file.path,
                label: file.label,
                required: file.required,
                present: file.present,
                bytes: file.bytes,
                lineCount: file.lineCount,
                preview: file.preview,
              })),
            }
          : null,
    reports,
  };
}

/**
 * Reject demotion or deletion when the user is currently observed as the
 * installation's final platform administrator.
 *
 * @param {Object} user - User whose admin role may be removed.
 * @returns {Promise<void>}
 */
async function ensureNotLastAdmin(user) {
  if (user?.role !== "admin") return;
  const adminCount = await countAdminUsers();
  if (adminCount <= 1) {
    const error = new Error("Cannot remove the last admin");
    error.statusCode = 400;
    throw error;
  }
}

/**
 * Destroy an agent runtime before deleting its row; cleanup failures abort the
 * deletion so the caller can retry without orphaning a runtime.
 *
 * @param {Object} agent - Agent and runtime being deleted.
 * @returns {Promise<void>}
 */
async function destroyAgent(agent) {
  if (containerManager.canDestroy(agent)) {
    await containerManager.destroy(agent);
  }

  await db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
}

async function destroyUserAgents(userId) {
  const result = await db.query("SELECT * FROM agents WHERE user_id = $1", [userId]);

  for (const agent of result.rows) {
    await destroyAgent(agent);
  }

  return result.rows;
}

/**
 * Guard against deleting a user whose personal Remote Docker host still has
 * agents deployed on it — those agents would be orphaned from their host's
 * credentials. Throws a 409 naming the first blocking host; no-ops otherwise.
 *
 * @param {string} userId - User targeted for deletion.
 * @returns {Promise<void>}
 */
async function ensureOwnedRemoteHostsAreUnused(userId) {
  const result = await db.query(
    `SELECT rh.id,
            rh.label,
            COUNT(a.id)::int AS "agentCount"
       FROM remote_hosts rh
       JOIN agents a
         ON a.execution_target_id = 'remote:' || rh.id
      WHERE rh.owner_user_id = $1
        AND a.status IS DISTINCT FROM 'deleted'
      GROUP BY rh.id, rh.label
      ORDER BY rh.label, rh.id
      LIMIT 1`,
    [userId],
  );
  const referencedHost = result.rows[0];
  if (!referencedHost) return;

  const agentCount = Number(referencedHost.agentCount) || 1;
  const error = new Error(
    `Cannot delete user while Remote Docker host "${referencedHost.label || referencedHost.id}" ` +
      `is still referenced by ${agentCount} agent${agentCount === 1 ? "" : "s"}. ` +
      "Drain or delete every agent on hosts owned by this user first.",
  );
  error.statusCode = 409;
  error.code = "REMOTE_HOSTS_IN_USE";
  throw error;
}

function buildSubscriptionLookup(row = {}) {
  if (!row?.subscriptionPlan) return null;
  return {
    plan: row.subscriptionPlan,
    status: row.subscriptionStatus,
  };
}

/**
 * Enrich an admin user row with effective agent and backup entitlements.
 *
 * @param {Object} row - User, usage, override, and subscription fields.
 * @param {Object} [options={}] - Optional preloaded platform and subscription data.
 * @returns {Promise<Object>} Admin-facing user and effective entitlement payload.
 */
async function buildAdminUserResponse(
  row,
  { deploymentDefaults = null, backupPlanLimits = null, subscriptionRow } = {},
) {
  const subscription = await billing.getSubscription(row.id, {
    userRow: row,
    subscriptionRow,
    ...(backupPlanLimits ? { backupPlanLimits } : {}),
    ...(deploymentDefaults ? { deploymentDefaults } : {}),
  });

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    created_at: row.created_at,
    agentCount: Number.parseInt(row.agentCount, 10) || 0,
    plan: subscription.plan,
    subscriptionStatus: subscription.status,
    agent_limit: subscription.agent_limit,
    agent_limit_override: subscription.agent_limit_override,
    base_agent_limit: subscription.base_agent_limit,
    agent_limit_source: subscription.agent_limit_source,
    is_unlimited: subscription.is_unlimited,
    managed_backups_enabled: subscription.managed_backups_enabled,
    managed_backups_enabled_override: subscription.managed_backups_enabled_override,
    managed_backups_source: subscription.managed_backups_source,
    backup_limit_per_agent: subscription.backup_limit_per_agent,
    backup_limit_per_agent_override: subscription.backup_limit_per_agent_override,
    backup_limit_source: subscription.backup_limit_source,
    backup_storage_mb: subscription.backup_storage_mb,
    backup_storage_mb_override: subscription.backup_storage_mb_override,
    backup_storage_source: subscription.backup_storage_source,
    backup_retention_days: subscription.backup_retention_days,
    backup_retention_days_override: subscription.backup_retention_days_override,
    backup_retention_source: subscription.backup_retention_source,
    backup_is_unlimited: subscription.backup_is_unlimited,
  };
}

async function getAdminUserRow(userId) {
  const result = await db.query(
    `SELECT u.id,
            u.email,
            u.name,
            u.role,
            u.created_at,
            u.agent_limit_override,
            u.managed_backups_enabled_override,
            u.backup_limit_per_agent_override,
            u.backup_storage_mb_override,
            u.backup_retention_days_override,
            COUNT(a.id)::int AS "agentCount",
            sub.plan AS "subscriptionPlan",
            sub.status AS "subscriptionStatus"
       FROM users u
       LEFT JOIN agents a ON a.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT plan, status
           FROM subscriptions
          WHERE user_id = u.id
          ORDER BY created_at DESC
          LIMIT 1
       ) sub ON TRUE
      WHERE u.id = $1
      GROUP BY
        u.id,
        u.email,
        u.name,
        u.role,
        u.created_at,
        u.agent_limit_override,
        u.managed_backups_enabled_override,
        u.backup_limit_per_agent_override,
        u.backup_storage_mb_override,
        u.backup_retention_days_override,
        sub.plan,
        sub.status`,
    [userId],
  );

  return result.rows[0] || null;
}

// Platform operations and settings

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    res.json(await monitoring.getMetrics());
  }),
);

router.get(
  "/kubernetes-clusters",
  asyncHandler(async (_req, res) => {
    res.json(await kubernetesClusters.listKubernetesClusters());
  }),
);

router.post(
  "/kubernetes-clusters",
  asyncHandler(async (req, res) => {
    const cluster = await kubernetesClusters.createKubernetesCluster(req.body || {});
    res.locals.auditContext = { settings: { kind: "kubernetes_clusters", id: cluster.id } };
    await monitoring.logEvent(
      "admin_kubernetes_cluster_created",
      `Admin registered Kubernetes cluster "${cluster.label}"`,
      adminAuditMetadata(req, {
        settings: {
          kind: "kubernetes_clusters",
          cluster: {
            id: cluster.id,
            label: cluster.label,
            provider: cluster.provider,
            clusterName: cluster.clusterName,
          },
        },
      }),
    );
    res.status(201).json(cluster);
  }),
);

router.put(
  "/kubernetes-clusters/:id",
  asyncHandler(async (req, res) => {
    const cluster = await kubernetesClusters.updateKubernetesCluster(req.params.id, req.body || {});
    res.locals.auditContext = { settings: { kind: "kubernetes_clusters", id: cluster.id } };
    await monitoring.logEvent(
      "admin_kubernetes_cluster_updated",
      `Admin updated Kubernetes cluster "${cluster.label}"`,
      adminAuditMetadata(req, {
        settings: {
          kind: "kubernetes_clusters",
          cluster: {
            id: cluster.id,
            label: cluster.label,
            provider: cluster.provider,
            clusterName: cluster.clusterName,
            enabled: cluster.enabled,
          },
        },
      }),
    );
    res.json(cluster);
  }),
);

router.post(
  "/kubernetes-clusters/:id/test",
  asyncHandler(async (req, res) => {
    const cluster = await kubernetesClusters.testKubernetesCluster(req.params.id);
    res.locals.auditContext = { settings: { kind: "kubernetes_clusters", id: cluster.id } };
    await monitoring.logEvent(
      "admin_kubernetes_cluster_tested",
      `Admin tested Kubernetes cluster "${cluster.label}" (${cluster.lastTestStatus})`,
      adminAuditMetadata(req, {
        settings: {
          kind: "kubernetes_clusters",
          cluster: {
            id: cluster.id,
            label: cluster.label,
            status: cluster.lastTestStatus,
          },
        },
      }),
    );
    res.json(cluster);
  }),
);

router.get(
  "/kubernetes-clusters/:id/policy-settings",
  asyncHandler(async (req, res) => {
    res.json(await kubernetesClusters.getKubernetesClusterPolicySettings(req.params.id));
  }),
);

router.put(
  "/kubernetes-clusters/:id/policy-settings",
  asyncHandler(async (req, res) => {
    const cluster = await kubernetesClusters.updateKubernetesClusterPolicySettings(
      req.params.id,
      req.body || {},
    );
    await addKubernetesPolicyReconcileJob({
      clusterId: cluster.id,
      desiredHash: cluster.policySettingsStatus?.desiredHash || cluster.customPolicyDesiredHash,
    });
    res.locals.auditContext = { settings: { kind: "kubernetes_clusters", id: cluster.id } };
    await monitoring.logEvent(
      "admin_kubernetes_cluster_policy_settings_updated",
      `Admin updated Kubernetes policy settings for "${cluster.label}"`,
      adminAuditMetadata(req, {
        settings: {
          kind: "kubernetes_clusters",
          cluster: {
            id: cluster.id,
            label: cluster.label,
            policyState: cluster.customPolicyState,
            customIngressConfigured: cluster.customIngressConfigured,
          },
        },
      }),
    );
    res.json(cluster);
  }),
);

router.delete(
  "/kubernetes-clusters/:id",
  asyncHandler(async (req, res) => {
    const cluster = await kubernetesClusters.deleteKubernetesCluster(req.params.id);
    res.locals.auditContext = { settings: { kind: "kubernetes_clusters", id: cluster.id } };
    await monitoring.logEvent(
      "admin_kubernetes_cluster_deleted",
      `Admin deleted Kubernetes cluster "${cluster.label}"`,
      adminAuditMetadata(req, {
        settings: {
          kind: "kubernetes_clusters",
          cluster: { id: cluster.id, label: cluster.label },
        },
      }),
    );
    res.json({ success: true, cluster });
  }),
);

// Fleet-wide masked inventory. Personal hosts remain read-only here; only
// management_scope=platform rows can be mutated through admin routes.
router.get(
  "/remote-hosts",
  asyncHandler(async (_req, res) => {
    res.json(await remoteHosts.listAdminRemoteHosts());
  }),
);

router.post(
  "/remote-hosts",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: { kind: "platform_remote_host", id: req.body?.id || null },
    };
    const host = await remoteHosts.createPlatformRemoteHost(req.body || {}, req.user.id);
    await monitoring.logEvent(
      "admin_remote_host_registered",
      `Admin registered platform remote host "${host.label}"`,
      adminAuditMetadata(req, {
        settings: { kind: "platform_remote_host", remoteHost: { id: host.id, label: host.label } },
      }),
    );
    res.status(201).json(host);
  }),
);

router.get(
  "/remote-hosts/:id",
  asyncHandler(async (req, res) => {
    const host = await remoteHosts.getAdminRemoteHost(req.params.id);
    if (!host) return res.status(404).json({ error: "Remote host not found" });
    res.json(host);
  }),
);

router.put(
  "/remote-hosts/:id",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: { kind: "platform_remote_host", id: req.params.id },
    };
    const host = await remoteHosts.updatePlatformRemoteHost(req.params.id, req.body || {});
    await monitoring.logEvent(
      "admin_remote_host_updated",
      `Admin updated platform remote host "${host.label}"`,
      adminAuditMetadata(req, {
        settings: { kind: "platform_remote_host", remoteHost: { id: host.id, label: host.label } },
      }),
    );
    res.json(host);
  }),
);

router.post(
  "/remote-hosts/:id/test",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: { kind: "platform_remote_host", id: req.params.id },
    };
    const host = await remoteHosts.testPlatformRemoteHost(req.params.id);
    await monitoring.logEvent(
      "admin_remote_host_tested",
      `Admin tested platform remote host "${host.label}" (${host.lastTestStatus})`,
      adminAuditMetadata(req, {
        settings: {
          kind: "platform_remote_host",
          remoteHost: { id: host.id, label: host.label, status: host.lastTestStatus },
        },
      }),
    );
    res.json(host);
  }),
);

router.post(
  "/remote-hosts/:id/reset-host-key",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: { kind: "platform_remote_host", id: req.params.id },
    };
    const host = await remoteHosts.resetPlatformRemoteHostHostKeyPin(
      req.params.id,
      req.body?.confirmation,
    );
    await monitoring.logEvent(
      "admin_remote_host_ssh_pin_reset",
      `Admin reset the pinned SSH host key for platform remote host "${host.label}"`,
      adminAuditMetadata(req, {
        settings: { kind: "platform_remote_host", remoteHost: { id: host.id, label: host.label } },
      }),
    );
    res.json(host);
  }),
);

router.get(
  "/remote-hosts/:id/access",
  asyncHandler(async (req, res) => {
    res.json(await remoteHosts.listPlatformRemoteHostAccess(req.params.id));
  }),
);

router.put(
  "/remote-hosts/:id/access",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: { kind: "platform_remote_host_access", id: req.params.id },
    };
    const access = await remoteHosts.replacePlatformRemoteHostAccess(
      req.params.id,
      req.body || {},
      req.user.id,
    );
    await monitoring.logEvent(
      "admin_remote_host_access_updated",
      `Admin replaced access grants for platform remote host "${req.params.id}"`,
      adminAuditMetadata(req, {
        settings: {
          kind: "platform_remote_host_access",
          remoteHost: { id: req.params.id },
          result: {
            version: access.version,
            availableToAll: access.availableToAll,
            userCount: access.users.length,
            groupCount: access.groups.length,
            workspaceCount: access.workspaces.length,
          },
        },
      }),
    );
    res.json(access);
  }),
);

router.delete(
  "/remote-hosts/:id",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: { kind: "platform_remote_host", id: req.params.id },
    };
    const host = await remoteHosts.deletePlatformRemoteHost(req.params.id, {
      deletedByUserId: req.user.id,
    });
    await monitoring.logEvent(
      "admin_remote_host_deleted",
      `Admin deleted platform remote host "${host.label}"`,
      adminAuditMetadata(req, {
        settings: { kind: "platform_remote_host", remoteHost: { id: host.id, label: host.label } },
      }),
    );
    res.json({ success: true, host });
  }),
);

router.get(
  "/user-groups",
  asyncHandler(async (_req, res) => {
    res.json(await userGroups.listUserGroups());
  }),
);

router.post(
  "/user-groups",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = { settings: { kind: "user_group" } };
    const group = await userGroups.createUserGroup(req.body || {}, req.user.id);
    await monitoring.logEvent(
      "admin_user_group_created",
      `Admin created user group "${group.name}"`,
      adminAuditMetadata(req, { settings: { kind: "user_group", group } }),
    );
    res.status(201).json(group);
  }),
);

router.put(
  "/user-groups/:id",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = { settings: { kind: "user_group", id: req.params.id } };
    const group = await userGroups.updateUserGroup(req.params.id, req.body || {});
    await monitoring.logEvent(
      "admin_user_group_updated",
      `Admin updated user group "${group.name}"`,
      adminAuditMetadata(req, { settings: { kind: "user_group", group } }),
    );
    res.json(group);
  }),
);

router.delete(
  "/user-groups/:id",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = { settings: { kind: "user_group", id: req.params.id } };
    const group = await userGroups.deleteUserGroup(req.params.id);
    await monitoring.logEvent(
      "admin_user_group_deleted",
      `Admin deleted user group "${group.name}"`,
      adminAuditMetadata(req, { settings: { kind: "user_group", group } }),
    );
    res.json({ success: true, group });
  }),
);

router.get(
  "/user-groups/:id/members",
  asyncHandler(async (req, res) => {
    res.json(await userGroups.listUserGroupMembers(req.params.id));
  }),
);

router.put(
  "/user-groups/:id/members",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = { settings: { kind: "user_group_members", id: req.params.id } };
    const members = await userGroups.replaceUserGroupMembers(
      req.params.id,
      req.body?.users,
      req.body?.expectedVersion,
      req.user.id,
    );
    await monitoring.logEvent(
      "admin_user_group_members_updated",
      `Admin replaced members for user group "${req.params.id}"`,
      adminAuditMetadata(req, {
        settings: {
          kind: "user_group_members",
          group: { id: req.params.id },
          result: { memberCount: members.members.length, version: members.version },
        },
      }),
    );
    res.json(members);
  }),
);

router.get(
  "/settings/deployment-defaults",
  asyncHandler(async (_req, res) => {
    res.json(await getDeploymentDefaults());
  }),
);

router.put(
  "/settings/deployment-defaults",
  asyncHandler(async (req, res) => {
    const currentDefaults = await getDeploymentDefaults();
    const requestedDefaults = parseRequiredDeploymentDefaults(req.body || {});
    res.locals.auditContext = {
      settings: {
        kind: "deployment_defaults",
      },
    };

    const nextDefaults = await updateDeploymentDefaults(
      requestedDefaults,
      billing.SELFHOSTED_LIMITS,
    );

    await monitoring.logEvent(
      "admin_deployment_defaults_updated",
      `Admin updated deployment defaults to ${nextDefaults.vcpu} vCPU / ${nextDefaults.ram_mb} MB RAM / ${nextDefaults.disk_gb} GB disk`,
      adminAuditMetadata(req, {
        settings: {
          kind: "deployment_defaults",
          previous: currentDefaults,
          next: nextDefaults,
        },
      }),
    );

    res.json(nextDefaults);
  }),
);

router.get(
  "/settings/language",
  asyncHandler(async (_req, res) => {
    res.json(await getLanguageSettings());
  }),
);

router.put(
  "/settings/language",
  asyncHandler(async (req, res) => {
    const currentSettings = await getLanguageSettings();
    res.locals.auditContext = {
      settings: {
        kind: "language",
      },
    };

    const nextSettings = await updateLanguageSettings(req.body || {});

    await monitoring.logEvent(
      "admin_language_settings_updated",
      `Admin updated the default language to ${nextSettings.defaultLocale}`,
      adminAuditMetadata(req, {
        settings: {
          kind: "language",
          previous: currentSettings,
          next: nextSettings,
        },
      }),
    );

    res.json(nextSettings);
  }),
);

router.get(
  "/settings/system-banner",
  asyncHandler(async (_req, res) => {
    res.json(await getSystemBanner());
  }),
);

router.put(
  "/settings/system-banner",
  asyncHandler(async (req, res) => {
    const currentBanner = await getSystemBanner();
    res.locals.auditContext = {
      settings: {
        kind: "system_banner",
      },
    };

    const nextBanner = await updateSystemBanner(req.body || {});

    await monitoring.logEvent(
      "admin_system_banner_updated",
      nextBanner.enabled
        ? `Admin updated the system banner (${nextBanner.severity})`
        : "Admin disabled the system banner",
      adminAuditMetadata(req, {
        settings: {
          kind: "system_banner",
          previous: currentBanner,
          next: nextBanner,
        },
      }),
    );

    res.json(nextBanner);
  }),
);

router.get(
  "/settings/agent-hub",
  asyncHandler(async (_req, res) => {
    res.json(await getAgentHubSettings());
  }),
);

router.put(
  "/settings/agent-hub",
  asyncHandler(async (req, res) => {
    const currentSettings = await getAgentHubSettings();
    res.locals.auditContext = {
      settings: {
        kind: "agent_hub",
      },
    };

    const nextSettings = await updateAgentHubSettings(req.body || {});

    await monitoring.logEvent(
      "admin_agent_hub_settings_updated",
      `Admin updated Agent Hub sharing defaults`,
      adminAuditMetadata(req, {
        settings: {
          kind: "agent_hub",
          previous: currentSettings,
          next: nextSettings,
        },
      }),
    );

    res.json(nextSettings);
  }),
);

router.get(
  "/settings/backups",
  asyncHandler(async (_req, res) => {
    const settings = await getBackupSettings();
    const schedule = await backups.syncInstallationScheduleFromSettings();
    res.json({ ...settings, installationSchedule: schedule });
  }),
);

router.put(
  "/settings/backups",
  asyncHandler(async (req, res) => {
    const currentSettings = await getBackupSettings();
    res.locals.auditContext = {
      settings: {
        kind: "backups",
      },
    };

    const nextSettings = await updateBackupSettings(req.body || {});
    const schedule = await backups.syncInstallationScheduleFromSettings(req.user.id);

    await monitoring.logEvent(
      "admin_backup_settings_updated",
      `Admin updated backup storage and schedule settings`,
      adminAuditMetadata(req, {
        settings: {
          kind: "backups",
          previous: currentSettings,
          next: nextSettings,
          schedule,
        },
      }),
    );

    res.json({ ...nextSettings, installationSchedule: schedule });
  }),
);

router.get(
  "/settings/notifications",
  asyncHandler(async (_req, res) => {
    res.json(await getSmtpSettings());
  }),
);

router.put(
  "/settings/notifications",
  asyncHandler(async (req, res) => {
    const previous = await getSmtpSettings();
    res.locals.auditContext = { settings: { kind: "notifications" } };
    const next = await updateSmtpSettings(req.body || {});
    mailer.bustCache();
    await monitoring.logEvent(
      "admin_smtp_settings_updated",
      "Admin updated platform SMTP settings",
      adminAuditMetadata(req, {
        settings: {
          kind: "notifications",
          previous,
          next,
        },
      }),
    );
    res.json(next);
  }),
);

// Send a test email to the calling admin's own login email. We deliberately
// do NOT accept a `to` parameter — that would make this an open relay any
// platform admin could abuse to spam from the install's SMTP credentials.
router.post(
  "/settings/notifications/test",
  asyncHandler(async (req, res) => {
    const recipient = req.user?.email;
    if (!recipient) {
      return res.status(400).json({ error: "Caller has no email on file" });
    }
    const configured = await mailer.isConfigured();
    if (!configured) {
      return res.status(409).json({ error: "SMTP is not configured" });
    }
    const result = await mailer.sendMail({
      to: recipient,
      subject: "Nora SMTP test",
      text:
        "This is a test message from your Nora installation. " +
        "If you received it, platform email is wired up correctly.",
    });
    await monitoring.logEvent(
      "admin_smtp_test_sent",
      `Admin sent SMTP test email to ${recipient}`,
      adminAuditMetadata(req, {
        settings: {
          kind: "notifications",
          test: { to: recipient, delivered: result.delivered, error: result.error || null },
        },
      }),
    );
    res.status(result.delivered ? 200 : 502).json(result);
  }),
);

router.get(
  "/settings/backup-plan-limits",
  asyncHandler(async (_req, res) => {
    res.json({
      platformMode: billing.PLATFORM_MODE,
      billingEnabled: billing.BILLING_ENABLED,
      plans: await getBackupPlanLimits(),
    });
  }),
);

router.put(
  "/settings/backup-plan-limits",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: {
        kind: "backup_plan_limits",
      },
    };

    // Single round-trip captures both `previous` and `next` atomically so
    // two simultaneous admin PUTs each get a truthful audit trail — the
    // second write's `previous` reflects the first write's `next`, not a
    // stale pre-read.
    const { previous, next: nextLimits } = await updateBackupPlanLimits(req.body || {});

    await monitoring.logEvent(
      "admin_backup_plan_limits_updated",
      "Admin updated backup plan limits",
      adminAuditMetadata(req, {
        settings: {
          kind: "backup_plan_limits",
          previous,
          next: nextLimits,
        },
      }),
    );

    res.json({
      platformMode: billing.PLATFORM_MODE,
      billingEnabled: billing.BILLING_ENABLED,
      plans: nextLimits,
    });
  }),
);

router.get(
  "/release-upgrade",
  asyncHandler(async (_req, res) => {
    res.json(await releaseUpgrade.getReleaseUpgradeStatus());
  }),
);

router.get(
  "/release-upgrade/preflight",
  asyncHandler(async (_req, res) => {
    const status = await releaseUpgrade.getReleaseUpgradeStatus();
    res.json(status.preflight);
  }),
);

router.post(
  "/release-upgrade",
  asyncHandler(async (req, res) => {
    res.locals.auditContext = {
      settings: {
        kind: "release_upgrade",
      },
    };

    const result = await releaseUpgrade.startReleaseUpgrade({ actor: req.user });
    const targetVersion = result.release?.latestVersion || "the latest release";

    await monitoring.logEvent(
      "admin_release_upgrade_started",
      `Admin started Nora upgrade to ${targetVersion}`,
      adminAuditMetadata(req, {
        settings: {
          kind: "release_upgrade",
          targetVersion,
          currentVersion: result.release?.currentVersion || null,
          jobId: result.job?.id || null,
        },
      }),
    );

    res.status(202).json(result);
  }),
);

// User and entitlement administration

router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const [deploymentDefaults, backupPlanLimits] = await Promise.all([
      billing.IS_PAAS ? getDeploymentDefaults() : null,
      billing.IS_PAAS && billing.BILLING_ENABLED ? getBackupPlanLimits() : null,
    ]);
    const result = await db.query(
      `SELECT u.id,
              u.email,
              u.name,
              u.role,
              u.created_at,
              u.agent_limit_override,
              u.managed_backups_enabled_override,
              u.backup_limit_per_agent_override,
              u.backup_storage_mb_override,
              u.backup_retention_days_override,
              COUNT(a.id)::int AS "agentCount",
              sub.plan AS "subscriptionPlan",
              sub.status AS "subscriptionStatus"
         FROM users u
         LEFT JOIN agents a ON a.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT plan, status
             FROM subscriptions
            WHERE user_id = u.id
            ORDER BY created_at DESC
            LIMIT 1
         ) sub ON TRUE
        GROUP BY
          u.id,
          u.email,
          u.name,
          u.role,
          u.created_at,
          u.agent_limit_override,
          u.managed_backups_enabled_override,
          u.backup_limit_per_agent_override,
          u.backup_storage_mb_override,
          u.backup_retention_days_override,
          sub.plan,
          sub.status
        ORDER BY u.created_at DESC`,
    );

    res.json(
      await Promise.all(
        result.rows.map((row) =>
          buildAdminUserResponse(row, {
            deploymentDefaults,
            backupPlanLimits,
            subscriptionRow: buildSubscriptionLookup(row),
          }),
        ),
      ),
    );
  }),
);

router.put(
  "/users/:id/role",
  asyncHandler(async (req, res) => {
    const { role } = req.body || {};
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const existing = await db.query("SELECT id, email, role FROM users WHERE id = $1", [
      req.params.id,
    ]);
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    res.locals.auditContext = buildUserContext(user);

    if (user.role === "admin" && role !== "admin") {
      await ensureNotLastAdmin(user);
    }

    const result = await db.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role",
      [role, req.params.id],
    );
    await monitoring.logEvent(
      "admin_user_role_changed",
      `Admin changed ${user.email} role from ${user.role} to ${role}`,
      adminUserAuditMetadata(req, result.rows[0], {
        result: {
          previousRole: user.role,
          nextRole: role,
        },
      }),
    );
    res.json(result.rows[0]);
  }),
);

router.put(
  "/users/:id/agent-limit",
  asyncHandler(async (req, res) => {
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "agent_limit_override")) {
      return res.status(400).json({ error: "agent_limit_override is required" });
    }

    const existing = await db.query(
      "SELECT id, email, name, role, agent_limit_override FROM users WHERE id = $1",
      [req.params.id],
    );
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    res.locals.auditContext = buildUserContext(user);

    const requestedOverride = req.body?.agent_limit_override;
    let nextOverride = null;
    if (requestedOverride !== null) {
      if (!Number.isSafeInteger(requestedOverride)) {
        return res.status(400).json({ error: "agent_limit_override must be an integer or null" });
      }
      if (requestedOverride < 0) {
        return res.status(400).json({ error: "agent_limit_override must be 0 or greater" });
      }
      if (!billing.IS_PAAS && requestedOverride > billing.SELFHOSTED_LIMITS.max_agents) {
        return res.status(400).json({
          error: `agent_limit_override cannot exceed the self-hosted platform ceiling (${billing.SELFHOSTED_LIMITS.max_agents})`,
        });
      }
      nextOverride = requestedOverride;
    }

    const [deploymentDefaults, backupPlanLimits] = await Promise.all([
      billing.IS_PAAS ? getDeploymentDefaults() : null,
      billing.IS_PAAS && billing.BILLING_ENABLED ? getBackupPlanLimits() : null,
    ]);
    const previousSubscription = await billing.getSubscription(user.id, {
      userRow: user,
      ...(backupPlanLimits ? { backupPlanLimits } : {}),
      ...(deploymentDefaults ? { deploymentDefaults } : {}),
    });

    await db.query("UPDATE users SET agent_limit_override = $1 WHERE id = $2", [
      nextOverride,
      req.params.id,
    ]);

    const updatedRow = await getAdminUserRow(req.params.id);
    const responseUser = await buildAdminUserResponse(updatedRow, {
      deploymentDefaults,
      backupPlanLimits,
      subscriptionRow: buildSubscriptionLookup(updatedRow),
    });

    await monitoring.logEvent(
      "admin_user_agent_limit_updated",
      nextOverride == null
        ? `Admin cleared agent cap override for ${user.email}`
        : `Admin set agent cap override for ${user.email} to ${nextOverride}`,
      adminUserAuditMetadata(req, responseUser, {
        result: {
          previousAgentLimitOverride: billing.normalizeAgentLimitOverride(
            user.agent_limit_override,
          ),
          nextAgentLimitOverride: responseUser.agent_limit_override,
          previousAgentLimit: previousSubscription.agent_limit,
          nextAgentLimit: responseUser.agent_limit,
          nextAgentLimitSource: responseUser.agent_limit_source,
          nextIsUnlimited: responseUser.is_unlimited,
        },
      }),
    );

    res.json(responseUser);
  }),
);

function parseNullableNonNegativeInteger(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    const error = new Error(`${fieldName} must be an integer that is 0 or greater, or null`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function parseNullableBooleanOverride(value, fieldName) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    const error = new Error(`${fieldName} must be a boolean or null`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

router.put(
  "/users/:id/backup-limits",
  asyncHandler(async (req, res) => {
    const existing = await db.query(
      `SELECT id,
              email,
              name,
              role,
              agent_limit_override,
              managed_backups_enabled_override,
              backup_limit_per_agent_override,
              backup_storage_mb_override,
              backup_retention_days_override
         FROM users
        WHERE id = $1`,
      [req.params.id],
    );
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    res.locals.auditContext = buildUserContext(user);

    const nextEnabled = parseNullableBooleanOverride(
      req.body?.managed_backups_enabled_override,
      "managed_backups_enabled_override",
    );
    const nextCount = parseNullableNonNegativeInteger(
      req.body?.backup_limit_per_agent_override,
      "backup_limit_per_agent_override",
    );
    const nextStorage = parseNullableNonNegativeInteger(
      req.body?.backup_storage_mb_override,
      "backup_storage_mb_override",
    );
    const nextRetention = parseNullableNonNegativeInteger(
      req.body?.backup_retention_days_override,
      "backup_retention_days_override",
    );

    const [deploymentDefaults, backupPlanLimits] = await Promise.all([
      billing.IS_PAAS ? getDeploymentDefaults() : null,
      billing.IS_PAAS && billing.BILLING_ENABLED ? getBackupPlanLimits() : null,
    ]);
    const previousSubscription = await billing.getSubscription(user.id, {
      userRow: user,
      ...(backupPlanLimits ? { backupPlanLimits } : {}),
      ...(deploymentDefaults ? { deploymentDefaults } : {}),
    });

    await db.query(
      `UPDATE users
          SET managed_backups_enabled_override = $2,
              backup_limit_per_agent_override = $3,
              backup_storage_mb_override = $4,
              backup_retention_days_override = $5
        WHERE id = $1`,
      [user.id, nextEnabled, nextCount, nextStorage, nextRetention],
    );

    const updatedRow = await getAdminUserRow(req.params.id);
    const responseUser = await buildAdminUserResponse(updatedRow, {
      deploymentDefaults,
      backupPlanLimits,
      subscriptionRow: buildSubscriptionLookup(updatedRow),
    });

    await monitoring.logEvent(
      "admin_user_backup_limits_updated",
      `Admin updated backup limits for ${user.email}`,
      adminUserAuditMetadata(req, responseUser, {
        result: {
          previous: {
            managed_backups_enabled: previousSubscription.managed_backups_enabled,
            backup_limit_per_agent: previousSubscription.backup_limit_per_agent,
            backup_storage_mb: previousSubscription.backup_storage_mb,
            backup_retention_days: previousSubscription.backup_retention_days,
          },
          next: {
            managed_backups_enabled: responseUser.managed_backups_enabled,
            backup_limit_per_agent: responseUser.backup_limit_per_agent,
            backup_storage_mb: responseUser.backup_storage_mb,
            backup_retention_days: responseUser.backup_retention_days,
          },
        },
      }),
    );

    res.json(responseUser);
  }),
);

router.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const existing = await db.query("SELECT id, email, role FROM users WHERE id = $1", [
      req.params.id,
    ]);
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    res.locals.auditContext = buildUserContext(user);

    await ensureNotLastAdmin(user);
    await ensureOwnedRemoteHostsAreUnused(user.id);
    const deletedAgents = await destroyUserAgents(user.id);
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    await monitoring.logEvent(
      "admin_user_deleted",
      `Admin deleted user ${user.email}`,
      adminUserAuditMetadata(req, user, {
        result: {
          deleted: true,
          deletedAgentCount: deletedAgents.length,
        },
      }),
    );
    res.json({ success: true });
  }),
);

// Backup administration

router.get(
  "/backups",
  asyncHandler(async (_req, res) => {
    res.json(await backups.listAdminBackups());
  }),
);

router.post(
  "/backups/installation",
  asyncHandler(async (req, res) => {
    const backup = await backups.createInstallationBackup({
      actorId: req.user.id,
      name: req.body?.name || "",
    });
    await addBackupJob({ backupId: backup.id });

    await monitoring.logEvent(
      "admin_installation_backup_queued",
      `Admin queued installation backup "${backup.name}"`,
      adminAuditMetadata(req, {
        backup: {
          id: backup.id,
          kind: backup.kind,
          status: backup.status,
        },
      }),
    );

    res.status(202).json({ backup });
  }),
);

router.get(
  "/backups/:id/download",
  asyncHandler(async (req, res) => {
    const { buffer, filename } = await backups.getBackupDownload({
      backupId: req.params.id,
      isAdmin: true,
    });
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

router.delete(
  "/backups/:id",
  asyncHandler(async (req, res) => {
    const result = await backups.deleteBackup({ backupId: req.params.id, isAdmin: true });
    await monitoring.logEvent(
      "admin_backup_deleted",
      `Admin deleted backup ${req.params.id}`,
      adminAuditMetadata(req, { backup: { id: req.params.id } }),
    );
    res.json(result);
  }),
);

router.post(
  "/backups/:id/restore",
  asyncHandler(async (req, res) => {
    const restored = await backups.restoreBackupInPlace({
      backupId: req.params.id,
      targetAgentId: req.body?.target_agent_id || req.body?.targetAgentId,
      confirmAgentName: req.body?.confirm_agent_name || req.body?.confirmAgentName,
      actor: req.user,
    });
    await monitoring.logEvent(
      "admin_backup_restored_in_place",
      `Admin restored backup ${req.params.id} into agent "${restored.name}"`,
      adminAuditMetadata(req, {
        backup: { id: req.params.id },
        agent: { id: restored.id, name: restored.name, ownerUserId: restored.user_id },
        restore: { mode: "in_place" },
      }),
    );
    res.json(restored);
  }),
);

// Fleet agent administration

router.get(
  "/agents",
  asyncHandler(async (_req, res) => {
    res.json(await listAdminAgents());
  }),
);

router.get(
  "/agents/:id",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);

    await reconcileAdminAgent(agent);
    res.json(serializeAgent(agent));
  }),
);

router.get(
  "/agents/:id/stats",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    res.json(await buildAgentStatsResponse(agent));
  }),
);

router.get(
  "/agents/:id/stats/history",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { fromTime, toTime } = resolveHistoryWindow(req.query);
    res.json(await buildAgentHistoryResponse(agent, fromTime, toTime));
  }),
);

router.post(
  "/agents/:id/start",
  asyncHandler(async (req, res) => {
    const result = await withAdminAgentLifecycleLock(
      req.params.id,
      "nora-backend-admin-agent-start",
      async (agent) => {
        res.locals.auditContext = buildAgentContext(agent);
        if (!containerManager.canMutate(agent)) {
          const error = new Error("No container - redeploy the agent first");
          error.statusCode = 400;
          throw error;
        }

        const resumed = await resumeAgentWithProviderAuth(agent, "start");
        await monitoring.logEvent(
          "admin_agent_started",
          `Admin started agent "${agent.name}"`,
          adminAgentAuditMetadata(
            req,
            {
              ...resumed.agent,
              ownerEmail: agent.ownerEmail,
            },
            {
              result: { status: "running" },
            },
          ),
        );
        return serializeAgent(resumed.agent);
      },
    );
    res.json(result);
  }),
);

router.post(
  "/agents/:id/stop",
  asyncHandler(async (req, res) => {
    const result = await withAdminAgentLifecycleLock(
      req.params.id,
      "nora-backend-admin-agent-stop",
      async (agent) => {
        res.locals.auditContext = buildAgentContext(agent);

        if (containerManager.canMutate(agent)) {
          try {
            await containerManager.stop(agent);
          } catch (error) {
            if (!containerManager.isIgnorableStopError(error)) {
              console.error("Container stop error:", error.message);
              throw error;
            }
          }
        }

        const updated = await db.query(
          "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *",
          [agent.id],
        );
        await monitoring.logEvent(
          "admin_agent_stopped",
          `Admin stopped agent "${agent.name}"`,
          adminAgentAuditMetadata(
            req,
            {
              ...updated.rows[0],
              ownerEmail: agent.ownerEmail,
            },
            {
              result: { status: "stopped" },
            },
          ),
        );
        return serializeAgent(updated.rows[0]);
      },
    );
    res.json(result);
  }),
);

router.post(
  "/agents/:id/restart",
  asyncHandler(async (req, res) => {
    const result = await withAdminAgentLifecycleLock(
      req.params.id,
      "nora-backend-admin-agent-restart",
      async (agent) => {
        res.locals.auditContext = buildAgentContext(agent);
        if (!containerManager.canMutate(agent)) {
          const error = new Error("No container - redeploy the agent first");
          error.statusCode = 400;
          throw error;
        }

        const resumed = await resumeAgentWithProviderAuth(agent, "restart");
        await monitoring.logEvent(
          "admin_agent_restarted",
          `Admin restarted agent "${agent.name}"`,
          adminAgentAuditMetadata(
            req,
            {
              ...resumed.agent,
              ownerEmail: agent.ownerEmail,
            },
            {
              result: { status: "running" },
            },
          ),
        );
        return serializeAgent(resumed.agent);
      },
    );
    res.json(result);
  }),
);

router.post(
  "/agents/:id/hermes/repair-config",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);
    if (agent.runtime_family !== "hermes") {
      return res.status(400).json({ error: "Agent is not a Hermes runtime" });
    }
    if (!agent.container_id) {
      return res.status(400).json({ error: "No container - redeploy the agent first" });
    }

    const result = await repairHermesAgentConfig(agent);
    await monitoring.logEvent(
      "admin_hermes_config_repaired",
      `Admin ran Hermes config surrogate repair on "${agent.name}" (${result?.mutated ? "mutated" : "no change"})`,
      adminAgentAuditMetadata(req, agent, {
        result: { mutated: !!result?.mutated, configPath: result?.configPath || null },
      }),
    );
    res.json({
      ok: true,
      mutated: !!result?.mutated,
      configPath: result?.configPath || null,
    });
  }),
);

router.post(
  "/agents/:id/redeploy",
  asyncHandler(async (req, res) => {
    const requestBody = req.body || {};
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);
    if (!["warning", "error", "stopped"].includes(agent.status)) {
      return res.status(400).json({
        error: "Agent must be in warning, error, or stopped state to redeploy",
      });
    }

    const runtimeFamily = normalizeRequestedRuntimeFamily(requestBody.runtime_family);
    if (requestBody.runtime_family != null && runtimeFamily == null) {
      return res.status(400).json({
        error: `Unsupported runtime_family. Nora currently supports: ${KNOWN_RUNTIME_FAMILIES.map((value) => `"${value}"`).join(", ")}.`,
      });
    }

    const currentRuntimeFields = buildAgentRuntimeFields(agent);
    const runtimeFields = resolveRequestedRuntimeFields({
      request: {
        ...requestBody,
        runtime_family: runtimeFamily || currentRuntimeFields.runtime_family,
      },
      fallback: currentRuntimeFields,
    });
    await assertRuntimeTargetAvailable(runtimeFields, { ownerUserId: agent.user_id });
    const containerName = resolveContainerName({
      requestedName: requestBody.container_name,
      currentName: agent.container_name,
      agentName: agent.name,
      runtimeSelection: runtimeFields,
    });
    const image = resolveRequestedImage({
      requestedImage: requestBody.image,
      runtimeFields,
      fallbackImage: agent.image || null,
      fallbackRuntimeFields: currentRuntimeFields,
    });

    // Admin and operator redeploys intentionally share one replacement
    // contract. The previous identity remains durable until the provisioner
    // validates the complete queued tuple and destroys that exact runtime.
    await enqueueAdminReplacementDeployment(
      agent,
      buildReplacementDeploymentJob(agent, {
        runtimeFields,
        containerName,
        image,
      }),
    );

    await monitoring.logEvent(
      "admin_agent_redeployed",
      `Admin re-queued agent "${agent.name}" for deployment`,
      adminAgentAuditMetadata(req, agent, {
        result: {
          previousStatus: agent.status,
          nextStatus: "queued",
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          executionTargetId: runtimeFields.execution_target_id,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
    );

    res.json({ success: true, status: "queued" });
  }),
);

router.delete(
  "/agents/:id",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    await destroyAgent(agent);
    await monitoring.logEvent(
      "admin_agent_deleted",
      `Admin deleted agent "${agent.name}"`,
      adminAgentAuditMetadata(req, agent, {
        result: { deleted: true },
      }),
    );
    res.json({ success: true });
  }),
);

// Agent Hub moderation

router.delete(
  "/agent-hub/:id",
  asyncHandler(async (req, res) => {
    const listing = await agentHubStore.getListing(req.params.id);
    res.locals.auditContext = buildListingContext(listing || { id: req.params.id });
    await agentHubStore.deleteListing(req.params.id);
    await monitoring.logEvent(
      "admin_agent_hub_listing_deleted",
      `Admin removed Agent Hub listing "${listing?.name || req.params.id}"`,
      adminListingAuditMetadata(req, listing || { id: req.params.id }, {
        result: { deleted: true },
      }),
    );
    res.json({ success: true });
  }),
);

router.get(
  "/agent-hub",
  asyncHandler(async (_req, res) => {
    const listings = await agentHubStore.listAdminListings();
    res.json(await Promise.all(listings.map((listing) => buildAdminListingDetail(listing))));
  }),
);

router.get(
  "/agent-hub/reports",
  asyncHandler(async (_req, res) => {
    res.json(await agentHubStore.listReports());
  }),
);

router.patch(
  "/agent-hub/reports/:id",
  asyncHandler(async (req, res) => {
    const nextStatus = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const report = await agentHubStore.resolveReport(req.params.id, req.user.id, nextStatus);
    if (!report) return res.status(404).json({ error: "Report not found" });

    await monitoring.logEvent(
      "agent_hub_report_resolved",
      `Agent Hub report ${report.id} marked ${report.status}`,
      adminAuditMetadata(req, {
        ...buildListingContext({
          id: report.listing_id,
          owner_user_id: report.owner_user_id,
          owner_email: report.owner_email,
          name: report.listing_name,
        }),
        ...buildReportContext(report, {
          reviewerUserId: req.user.id,
          reviewerEmail: req.user.email || null,
        }),
      }),
    );

    res.json(report);
  }),
);

router.patch(
  "/agent-hub/:id/status",
  asyncHandler(async (req, res) => {
    const nextStatus = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    if (!nextStatus) {
      return res.status(400).json({ error: "status is required" });
    }

    const listing = await agentHubStore.setListingStatus(
      req.params.id,
      nextStatus,
      req.user.id,
      typeof req.body?.reviewNotes === "string" ? req.body.reviewNotes.trim() : null,
    );
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const refreshed = await agentHubStore.getListing(listing.id);
    await monitoring.logEvent(
      "agent_hub_reviewed",
      `Agent Hub listing "${refreshed?.name || listing.name}" marked ${listing.status}`,
      adminListingAuditMetadata(req, refreshed || listing, {
        review: {
          notes: typeof req.body?.reviewNotes === "string" ? req.body.reviewNotes.trim() : null,
        },
      }),
    );

    res.json(refreshed || listing);
  }),
);

router.post(
  "/agent-hub/publish",
  asyncHandler(async (req, res) => {
    const { snapshotId } = req.body || {};
    if (!snapshotId) {
      return res.status(400).json({ error: "snapshotId is required" });
    }

    const snapshot = await snapshots.getSnapshot(snapshotId);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    res.locals.auditContext = {
      snapshot: {
        id: snapshot.id,
        name: snapshot.name,
        templateKey: snapshot.template_key || null,
      },
    };

    const listing = await agentHubStore.upsertListing({
      snapshotId: snapshot.id,
      name: (typeof req.body.name === "string" && req.body.name.trim()) || snapshot.name,
      description:
        (typeof req.body.description === "string" && req.body.description.trim()) ||
        snapshot.description,
      price: "Free",
      category: (typeof req.body.category === "string" && req.body.category.trim()) || "General",
      builtIn: req.body.builtIn === true,
      sourceType: agentHubStore.LISTING_SOURCE_PLATFORM,
      status: agentHubStore.LISTING_STATUS_PUBLISHED,
      visibility: agentHubStore.LISTING_VISIBILITY_PUBLIC,
      slug:
        (typeof req.body.slug === "string" && req.body.slug.trim()) ||
        snapshot.template_key ||
        null,
    });

    await monitoring.logEvent(
      "agent_hub_published",
      `Snapshot "${snapshot.name}" published to Agent Hub`,
      adminListingAuditMetadata(req, listing, {
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
          templateKey: snapshot.template_key || null,
        },
      }),
    );

    res.json(listing);
  }),
);

router.patch(
  "/agent-hub/:id",
  asyncHandler(async (req, res) => {
    const listing = await agentHubStore.getListing(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const snapshot = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });

    const update = buildAgentHubTemplateUpdate(snapshot, listing, req.body, {
      sourceType: listing.source_type,
      builtIn: listing.built_in === true,
      allowTemplateKeyChange: true,
      allowSnapshotKindChange: true,
    });
    const issues = scanTemplatePayloadForSecrets(update.snapshot.config?.templatePayload);
    if (issues.length > 0) {
      return res.status(400).json({
        error: "Potential secrets were detected in this template. Remove them before saving.",
        issues,
      });
    }

    await snapshots.updateSnapshot(snapshot.id, update.snapshot);
    await agentHubStore.upsertListing({
      listingId: listing.id,
      snapshotId: snapshot.id,
      ownerUserId: listing.owner_user_id,
      name: update.listing.name,
      description: update.listing.description,
      price: "Free",
      category: update.listing.category,
      slug: update.listing.slug,
      currentVersion: update.listing.currentVersion,
      builtIn: listing.built_in === true,
      sourceType: listing.source_type,
      status: listing.status,
      visibility: listing.visibility,
      reviewNotes:
        req.body?.reviewNotes !== undefined
          ? typeof req.body.reviewNotes === "string"
            ? req.body.reviewNotes.trim()
            : null
          : (listing.review_notes ?? null),
    });

    await monitoring.logEvent(
      "agent_hub_reviewed",
      `Agent Hub listing "${update.listing.name}" metadata was updated by admin`,
      adminListingAuditMetadata(req, listing, {
        snapshot: {
          id: snapshot.id,
          templateKey: update.snapshot.templateKey,
          kind: update.snapshot.kind,
        },
        review: {
          notes:
            req.body?.reviewNotes !== undefined
              ? typeof req.body.reviewNotes === "string"
                ? req.body.reviewNotes.trim()
                : null
              : (listing.review_notes ?? null),
        },
        result: {
          action: "template_update",
          currentVersion: update.listing.currentVersion,
        },
      }),
    );

    const refreshed = await agentHubStore.getListing(listing.id);
    const reports = (await agentHubStore.listReports()).filter(
      (report) => report.listing_id === listing.id,
    );
    res.json(
      await buildAdminListingDetail(refreshed || listing, reports, {
        includeContent: true,
      }),
    );
  }),
);

router.get(
  "/agent-hub/:id",
  asyncHandler(async (req, res) => {
    const listing = await agentHubStore.getListing(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const reports = (await agentHubStore.listReports()).filter(
      (report) => report.listing_id === listing.id,
    );
    res.json(await buildAdminListingDetail(listing, reports, { includeContent: true }));
  }),
);

// Audit and queue recovery

router.get(
  "/audit/export",
  asyncHandler(async (req, res) => {
    const filters = buildAuditFilters(req.query);
    const events = await monitoring.exportEvents(filters);
    const csv = buildAuditExportCsv(events);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${buildAuditExportFilename()}"`);
    res.send(csv);
  }),
);

router.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const filters = buildAuditFilters(req.query);
    const pagination = buildAuditPageOptions(req.query);

    res.json(await monitoring.getAuditEventsPage({ ...filters, ...pagination }));
  }),
);

router.get(
  "/dlq",
  asyncHandler(async (_req, res) => {
    const jobs = await getDLQJobs(0, 50);
    res.json(
      jobs.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
        finishedOn: job.finishedOn,
      })),
    );
  }),
);

router.post(
  "/dlq/:jobId/retry",
  asyncHandler(async (req, res) => {
    res.json(await retryDLQJob(req.params.jobId));
  }),
);

module.exports = router;
