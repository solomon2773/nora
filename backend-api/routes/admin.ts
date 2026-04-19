// @ts-nocheck
const express = require("express");
const db = require("../db");
const billing = require("../billing");
const monitoring = require("../monitoring");
const marketplace = require("../marketplace");
const { scanTemplatePayloadForSecrets } = require("../marketplaceSafety");
const { buildMarketplaceTemplateUpdate } = require("../marketplaceTemplateEdits");
const snapshots = require("../snapshots");
const containerManager = require("../containerManager");
const {
  addDeploymentJob,
  getDLQJobs,
  retryDLQJob,
} = require("../redisQueue");
const { requireAdmin } = require("../middleware/auth");
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
  buildBackendEnablementMessage,
  getBackendStatus,
  isKnownRuntimeFamily,
  normalizeRuntimeFamilyName,
} = require("../../agent-runtime/lib/backendCatalog");
const {
  buildAgentHistoryResponse,
  buildAgentStatsResponse,
} = require("../agentTelemetry");
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
  getSystemBanner,
  parseRequiredDeploymentDefaults,
  updateDeploymentDefaults,
  updateSystemBanner,
} = require("../platformSettings");
const { resolveAuditSource } = require("../auditSource");

const router = express.Router();

router.use(requireAdmin);
router.use(createMutationFailureAuditMiddleware("admin"));

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

function assertSupportedRuntimeSelection(runtimeFields) {
  if (runtimeFields?.runtime_family === "hermes") {
    if (runtimeFields.deploy_target !== "docker") {
      throw createHttpError(
        "Hermes runtime is only supported on the Docker execution target."
      );
    }
    if (runtimeFields.sandbox_profile !== "standard") {
      throw createHttpError(
        "Hermes runtime currently supports only the Standard sandbox profile."
      );
    }
    return;
  }
  if (runtimeFields?.sandbox_profile !== "nemoclaw") return;
  if (runtimeFields.deploy_target === "docker") return;

  throw createHttpError(
    "NemoClaw sandbox is only supported on the Docker execution target."
  );
}

function assertBackendAvailable(backend) {
  const status = getBackendStatus(backend);
  if (!status.enabled) {
    throw createHttpError(buildBackendEnablementMessage(status));
  }
  if (!status.configured) {
    throw createHttpError(
      status.issue || `${status.label} is not configured for this Nora control plane.`
    );
  }
}

function resolveRequestedImage({
  requestedImage,
  runtimeFields,
  fallbackImage = null,
  fallbackRuntimeFields = null,
} = {}) {
  const explicitRequestedImage =
    typeof requestedImage === "string" ? requestedImage.trim() : "";
  if (explicitRequestedImage) return explicitRequestedImage;

  if (
    fallbackImage &&
    fallbackRuntimeFields &&
    isSameRuntimePath(runtimeFields, fallbackRuntimeFields)
  ) {
    return fallbackImage;
  }

  return (
    getDefaultAgentImage({
      backend: runtimeFields?.backend_type,
      deploy_target: runtimeFields?.deploy_target,
      sandbox_profile: runtimeFields?.sandbox_profile,
    })
  );
}

function parsePositiveInteger(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
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
    parsed = new Date(
      `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    );
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
    typeof query.type === "string" && query.type.trim() !== "all"
      ? query.type.trim()
      : "";
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
      owner_user_id:
        metadata.agent?.ownerUserId || metadata.listing?.ownerUserId || "",
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
      source_account_email:
        source?.account?.email || metadata.actor?.email || "",
      source_account_user_id:
        source?.account?.userId || metadata.actor?.userId || "",
      source_account_role:
        source?.account?.role || metadata.actor?.role || "",
      source_ip: source?.ip || metadata.request?.ip || "",
      source_origin: source?.origin || metadata.request?.origin || "",
      source_user_agent:
        source?.userAgent || metadata.request?.userAgent || "",
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
      ORDER BY a.created_at DESC`
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
        [agentId]
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

async function reconcileAdminAgent(agent) {
  if (
    !agent?.container_id ||
    !["running", "warning", "error", "stopped"].includes(agent.status)
  ) {
    return agent;
  }

  try {
    const live = await containerManager.status(agent);
    const reconciledStatus = reconcileAgentStatus(
      agent.status,
      Boolean(live.running)
    );

    if (reconciledStatus !== agent.status) {
      await db.query("UPDATE agents SET status = $1 WHERE id = $2", [
        reconciledStatus,
        agent.id,
      ]);
      agent.status = reconciledStatus;
    }
  } catch {
    // Leave the stored status alone when the runtime is unreachable.
  }

  return agent;
}

async function countAdminUsers() {
  const result = await db.query(
    "SELECT count(*)::int AS total FROM users WHERE role = 'admin'"
  );
  return result.rows[0]?.total || 0;
}

async function buildAdminListingDetail(listing, reports = [], options = {}) {
  const snapshot = listing?.snapshot_id
    ? await snapshots.getSnapshot(listing.snapshot_id)
    : null;
  const templatePayload = snapshot
    ? extractTemplatePayloadFromSnapshot(snapshot, { includeBootstrap: true })
    : null;
  const template = templatePayload
    ? summarizeTemplatePayload(templatePayload, {
        includeContent: options.includeContent === true,
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

async function ensureNotLastAdmin(user) {
  if (user?.role !== "admin") return;
  const adminCount = await countAdminUsers();
  if (adminCount <= 1) {
    const error = new Error("Cannot remove the last admin");
    error.statusCode = 400;
    throw error;
  }
}

async function destroyAgent(agent) {
  if (agent?.container_id) {
    try {
      await containerManager.destroy(agent);
    } catch (error) {
      console.error("Container cleanup error:", error.message);
    }
  }

  await db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
}

async function destroyUserAgents(userId) {
  const result = await db.query("SELECT * FROM agents WHERE user_id = $1", [
    userId,
  ]);

  for (const agent of result.rows) {
    await destroyAgent(agent);
  }

  return result.rows;
}

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    res.json(await monitoring.getMetrics());
  })
);

router.get(
  "/settings/deployment-defaults",
  asyncHandler(async (_req, res) => {
    res.json(await getDeploymentDefaults());
  })
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
      billing.SELFHOSTED_LIMITS
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
      })
    );

    res.json(nextDefaults);
  })
);

router.get(
  "/settings/system-banner",
  asyncHandler(async (_req, res) => {
    res.json(await getSystemBanner());
  })
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
      })
    );

    res.json(nextBanner);
  })
);

router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const result = await db.query(
      `SELECT u.id,
              u.email,
              u.name,
              u.role,
              u.created_at,
              COUNT(a.id)::int AS "agentCount"
         FROM users u
         LEFT JOIN agents a ON a.user_id = u.id
        GROUP BY u.id, u.email, u.name, u.role, u.created_at
        ORDER BY u.created_at DESC`
    );

    res.json(result.rows);
  })
);

router.put(
  "/users/:id/role",
  asyncHandler(async (req, res) => {
    const { role } = req.body || {};
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const existing = await db.query(
      "SELECT id, email, role FROM users WHERE id = $1",
      [req.params.id]
    );
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    res.locals.auditContext = buildUserContext(user);

    if (user.role === "admin" && role !== "admin") {
      await ensureNotLastAdmin(user);
    }

    const result = await db.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role",
      [role, req.params.id]
    );
    await monitoring.logEvent(
      "admin_user_role_changed",
      `Admin changed ${user.email} role from ${user.role} to ${role}`,
      adminUserAuditMetadata(req, result.rows[0], {
        result: {
          previousRole: user.role,
          nextRole: role,
        },
      })
    );
    res.json(result.rows[0]);
  })
);

router.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const existing = await db.query(
      "SELECT id, email, role FROM users WHERE id = $1",
      [req.params.id]
    );
    const user = existing.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    res.locals.auditContext = buildUserContext(user);

    await ensureNotLastAdmin(user);
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
      })
    );
    res.json({ success: true });
  })
);

router.get(
  "/agents",
  asyncHandler(async (_req, res) => {
    res.json(await listAdminAgents());
  })
);

router.get(
  "/agents/:id",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);

    await reconcileAdminAgent(agent);
    res.json(serializeAgent(agent));
  })
);

router.get(
  "/agents/:id/stats",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    res.json(await buildAgentStatsResponse(agent));
  })
);

router.get(
  "/agents/:id/stats/history",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { fromTime, toTime } = resolveHistoryWindow(req.query);
    res.json(await buildAgentHistoryResponse(agent, fromTime, toTime));
  })
);

router.post(
  "/agents/:id/start",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);
    if (!agent.container_id) {
      return res
        .status(400)
        .json({ error: "No container - redeploy the agent first" });
    }

    await containerManager.start(agent);
    const updated = await db.query(
      "UPDATE agents SET status = 'running' WHERE id = $1 RETURNING *",
      [agent.id]
    );
    await monitoring.logEvent(
      "admin_agent_started",
      `Admin started agent "${agent.name}"`,
      adminAgentAuditMetadata(req, {
        ...updated.rows[0],
        ownerEmail: agent.ownerEmail,
      }, {
        result: { status: "running" },
      })
    );
    res.json(serializeAgent(updated.rows[0]));
  })
);

router.post(
  "/agents/:id/stop",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);

    if (agent.container_id) {
      try {
        await containerManager.stop(agent);
      } catch (error) {
        if (
          !error.message.includes("already stopped") &&
          !error.message.includes("not running")
        ) {
          console.error("Container stop error:", error.message);
        }
      }
    }

    const updated = await db.query(
      "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *",
      [agent.id]
    );
    await monitoring.logEvent(
      "admin_agent_stopped",
      `Admin stopped agent "${agent.name}"`,
      adminAgentAuditMetadata(req, {
        ...updated.rows[0],
        ownerEmail: agent.ownerEmail,
      }, {
        result: { status: "stopped" },
      })
    );
    res.json(serializeAgent(updated.rows[0]));
  })
);

router.post(
  "/agents/:id/restart",
  asyncHandler(async (req, res) => {
    const agent = await findAdminAgent(req.params.id, { includeOwner: true });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent);
    if (!agent.container_id) {
      return res
        .status(400)
        .json({ error: "No container - redeploy the agent first" });
    }

    await containerManager.restart(agent);
    const updated = await db.query(
      "UPDATE agents SET status = 'running' WHERE id = $1 RETURNING *",
      [agent.id]
    );
    await monitoring.logEvent(
      "admin_agent_restarted",
      `Admin restarted agent "${agent.name}"`,
      adminAgentAuditMetadata(req, {
        ...updated.rows[0],
        ownerEmail: agent.ownerEmail,
      }, {
        result: { status: "running" },
      })
    );
    res.json(serializeAgent(updated.rows[0]));
  })
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
        error:
          "Agent must be in warning, error, or stopped state to redeploy",
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
    assertSupportedRuntimeSelection(runtimeFields);
    assertBackendAvailable(runtimeFields.backend_type);
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

    await db.query(
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
              backend_type = $2,
              sandbox_type = $3,
              runtime_family = $4,
              deploy_target = $5,
              sandbox_profile = $6,
              container_name = $7,
              image = $8
        WHERE id = $1`,
      [
        agent.id,
        runtimeFields.backend_type,
        runtimeFields.sandbox_type,
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.sandbox_profile,
        containerName,
        image,
      ]
    );

    await db.query(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      [agent.id]
    );

    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: agent.user_id,
      backend: runtimeFields.backend_type,
      sandbox: runtimeFields.sandbox_profile,
      specs: {
        vcpu: agent.vcpu || 2,
        ram_mb: agent.ram_mb || 2048,
        disk_gb: agent.disk_gb || 20,
      },
      container_name: containerName,
      image,
    });

    await monitoring.logEvent(
      "admin_agent_redeployed",
      `Admin re-queued agent "${agent.name}" for deployment`,
      adminAgentAuditMetadata(req, agent, {
        result: {
          previousStatus: agent.status,
          nextStatus: "queued",
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      })
    );

    res.json({ success: true, status: "queued" });
  })
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
      })
    );
    res.json({ success: true });
  })
);

router.delete(
  "/marketplace/:id",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    res.locals.auditContext = buildListingContext(
      listing || { id: req.params.id }
    );
    await marketplace.deleteListing(req.params.id);
    await monitoring.logEvent(
      "admin_marketplace_listing_deleted",
      `Admin removed marketplace listing "${listing?.name || req.params.id}"`,
      adminListingAuditMetadata(req, listing || { id: req.params.id }, {
        result: { deleted: true },
      })
    );
    res.json({ success: true });
  })
);

router.get(
  "/marketplace",
  asyncHandler(async (_req, res) => {
    const listings = await marketplace.listAdminListings();
    res.json(
      await Promise.all(
        listings.map((listing) => buildAdminListingDetail(listing))
      )
    );
  })
);

router.get(
  "/marketplace/reports",
  asyncHandler(async (_req, res) => {
    res.json(await marketplace.listReports());
  })
);

router.patch(
  "/marketplace/reports/:id",
  asyncHandler(async (req, res) => {
    const nextStatus =
      typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const report = await marketplace.resolveReport(
      req.params.id,
      req.user.id,
      nextStatus
    );
    if (!report) return res.status(404).json({ error: "Report not found" });

    await monitoring.logEvent(
      "marketplace_report_resolved",
      `Marketplace report ${report.id} marked ${report.status}`,
      adminAuditMetadata(req, {
        ...buildListingContext(
          {
            id: report.listing_id,
            owner_user_id: report.owner_user_id,
            owner_email: report.owner_email,
            name: report.listing_name,
          }
        ),
        ...buildReportContext(report, {
          reviewerUserId: req.user.id,
          reviewerEmail: req.user.email || null,
        }),
      })
    );

    res.json(report);
  })
);

router.patch(
  "/marketplace/:id/status",
  asyncHandler(async (req, res) => {
    const nextStatus =
      typeof req.body?.status === "string" ? req.body.status.trim() : "";
    if (!nextStatus) {
      return res.status(400).json({ error: "status is required" });
    }

    const listing = await marketplace.setListingStatus(
      req.params.id,
      nextStatus,
      req.user.id,
      typeof req.body?.reviewNotes === "string"
        ? req.body.reviewNotes.trim()
        : null
    );
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const refreshed = await marketplace.getListing(listing.id);
    await monitoring.logEvent(
      "marketplace_reviewed",
      `Marketplace listing "${refreshed?.name || listing.name}" marked ${listing.status}`,
      adminListingAuditMetadata(req, refreshed || listing, {
        review: {
          notes:
            typeof req.body?.reviewNotes === "string"
              ? req.body.reviewNotes.trim()
              : null,
        },
      })
    );

    res.json(refreshed || listing);
  })
);

router.post(
  "/marketplace/publish",
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

    const listing = await marketplace.upsertListing({
      snapshotId: snapshot.id,
      name:
        (typeof req.body.name === "string" && req.body.name.trim()) ||
        snapshot.name,
      description:
        (typeof req.body.description === "string" &&
          req.body.description.trim()) ||
        snapshot.description,
      price: "Free",
      category:
        (typeof req.body.category === "string" && req.body.category.trim()) ||
        "General",
      builtIn: req.body.builtIn === true,
      sourceType: marketplace.LISTING_SOURCE_PLATFORM,
      status: marketplace.LISTING_STATUS_PUBLISHED,
      visibility: marketplace.LISTING_VISIBILITY_PUBLIC,
      slug:
        (typeof req.body.slug === "string" && req.body.slug.trim()) ||
        snapshot.template_key ||
        null,
    });

    await monitoring.logEvent(
      "marketplace_published",
      `Snapshot "${snapshot.name}" published to marketplace`,
      adminListingAuditMetadata(req, listing, {
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
          templateKey: snapshot.template_key || null,
        },
      })
    );

    res.json(listing);
  })
);

router.patch(
  "/marketplace/:id",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const snapshot = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });

    const update = buildMarketplaceTemplateUpdate(snapshot, listing, req.body, {
      sourceType: listing.source_type,
      builtIn: listing.built_in === true,
      allowTemplateKeyChange: true,
      allowSnapshotKindChange: true,
    });
    const issues = scanTemplatePayloadForSecrets(
      update.snapshot.config?.templatePayload
    );
    if (issues.length > 0) {
      return res.status(400).json({
        error:
          "Potential secrets were detected in this template. Remove them before saving.",
        issues,
      });
    }

    await snapshots.updateSnapshot(snapshot.id, update.snapshot);
    await marketplace.upsertListing({
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
          : listing.review_notes ?? null,
    });

    await monitoring.logEvent(
      "marketplace_reviewed",
      `Marketplace listing "${update.listing.name}" metadata was updated by admin`,
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
              : listing.review_notes ?? null,
        },
        result: {
          action: "template_update",
          currentVersion: update.listing.currentVersion,
        },
      })
    );

    const refreshed = await marketplace.getListing(listing.id);
    const reports = (await marketplace.listReports()).filter(
      (report) => report.listing_id === listing.id
    );
    res.json(
      await buildAdminListingDetail(refreshed || listing, reports, {
        includeContent: true,
      })
    );
  })
);

router.get(
  "/marketplace/:id",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    const reports = (await marketplace.listReports()).filter(
      (report) => report.listing_id === listing.id
    );
    res.json(
      await buildAdminListingDetail(listing, reports, { includeContent: true })
    );
  })
);

router.get(
  "/audit/export",
  asyncHandler(async (req, res) => {
    const filters = buildAuditFilters(req.query);
    const events = await monitoring.exportEvents(filters);
    const csv = buildAuditExportCsv(events);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildAuditExportFilename()}"`
    );
    res.send(csv);
  })
);

router.get(
  "/audit",
  asyncHandler(async (req, res) => {
    const filters = buildAuditFilters(req.query);
    const pagination = buildAuditPageOptions(req.query);

    res.json(await monitoring.getAuditEventsPage({ ...filters, ...pagination }));
  })
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
      }))
    );
  })
);

router.post(
  "/dlq/:jobId/retry",
  asyncHandler(async (req, res) => {
    res.json(await retryDLQJob(req.params.jobId));
  })
);

module.exports = router;
