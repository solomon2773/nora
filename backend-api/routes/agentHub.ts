// @ts-nocheck
const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const agentHubStore = require("../agentHubStore");
const agentHubApiKeys = require("../agentHubApiKeys");
const { scanTemplatePayloadForSecrets } = require("../agentHubSafety");
const { buildAgentHubTemplateUpdate } = require("../agentHubTemplateEdits");
const { fetchCatalog, fetchListing, submitListing } = require("../agentHubRemote");
const { getAgentHubSettings, getAgentHubSourceApiKey } = require("../platformSettings");
const snapshots = require("../snapshots");
const scheduler = require("../scheduler");
const monitoring = require("../monitoring");
const { assertKubernetesExecutionTargetAvailable } = require("../kubernetesClusters");
const { assertRemoteHostExecutionTargetAvailable } = require("../remoteHosts");
const {
  buildTemplatePayloadFromAgent,
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
  materializeTemplateWiring,
  resolveContainerName,
  sanitizeAgentName,
  serializeAgent,
  stripInternalTemplateMetadata,
  summarizeTemplatePayload,
} = require("../agentPayloads");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");
const {
  DEFAULT_RUNTIME_FAMILY,
  getDefaultBackend,
  getRuntimeSelectionStatus,
  isKnownBackend,
  normalizeBackendName,
} = require("../../agent-runtime/lib/backendCatalog");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireSession } = require("../middleware/auth");
const {
  buildAgentContext,
  buildAuditMetadata,
  buildListingContext,
  buildReportContext,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");
const {
  buildAgentRuntimeFields,
  isSameRuntimePath,
  resolveRequestedRuntimeFields,
} = require("../agentRuntimeFields");

const router = express.Router();
// Agent Hub publishing, installation, reporting, and installation-key
// lifecycle can cross workspace and upstream-hub boundaries. Keep the entire
// authenticated UI surface behind a browser session until dedicated scopes
// and workspace-bound contracts are introduced.
router.use(requireSession);
router.use(createMutationFailureAuditMiddleware("agent_hub"));

function stripAsciiControlCharacters(value) {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

function normalizeListingName(value, fallback = "Untitled Template") {
  const normalized = typeof value === "string" ? stripAsciiControlCharacters(value).trim() : "";
  return (normalized || fallback).slice(0, 100);
}

function normalizeListingDescription(value) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
}

function normalizeListingCategory(value) {
  const normalized = typeof value === "string" ? stripAsciiControlCharacters(value).trim() : "";
  return (normalized || "General").slice(0, 60);
}

function normalizeListingPrice(value) {
  return "Free";
}

function normalizeShareTarget(value, fallback = agentHubStore.LISTING_SHARE_TARGET_BOTH) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === agentHubStore.LISTING_SHARE_TARGET_INTERNAL) return normalized;
  if (normalized === agentHubStore.LISTING_SHARE_TARGET_COMMUNITY) return normalized;
  if (normalized === agentHubStore.LISTING_SHARE_TARGET_BOTH) return normalized;
  return fallback || agentHubStore.LISTING_SHARE_TARGET_BOTH;
}

function shareTargetIncludesInternal(shareTarget) {
  return (
    shareTarget === agentHubStore.LISTING_SHARE_TARGET_INTERNAL ||
    shareTarget === agentHubStore.LISTING_SHARE_TARGET_BOTH
  );
}

function shareTargetIncludesCommunity(shareTarget) {
  return (
    shareTarget === agentHubStore.LISTING_SHARE_TARGET_COMMUNITY ||
    shareTarget === agentHubStore.LISTING_SHARE_TARGET_BOTH
  );
}

function resolveRequestedImage({
  requestedImage,
  runtimeFields = null,
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

function resolveRequestedDeployTarget({
  requestedDeployTarget,
  requestedBackend,
  fallbackDeployTarget = null,
  fallbackBackend = null,
} = {}) {
  if (isKnownBackend(requestedDeployTarget)) {
    return normalizeBackendName(requestedDeployTarget);
  }
  if (isKnownBackend(requestedBackend)) {
    return normalizeBackendName(requestedBackend);
  }
  if (isKnownBackend(fallbackDeployTarget)) {
    return normalizeBackendName(fallbackDeployTarget);
  }
  if (isKnownBackend(fallbackBackend)) {
    return normalizeBackendName(fallbackBackend);
  }
  return getDefaultBackend(process.env);
}

function normalizeRequestedRuntimeFamily(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return normalized === DEFAULT_RUNTIME_FAMILY ? DEFAULT_RUNTIME_FAMILY : null;
}

function assertRuntimeSelectionAvailable(runtimeFields) {
  const status = getRuntimeSelectionStatus(runtimeFields);
  if (!status.enabled) {
    if (status.issue && /does not support/i.test(status.issue)) {
      const error = new Error(status.issue);
      error.statusCode = 400;
      throw error;
    }
    const error = new Error(
      `Runtime selection is not enabled. Enable runtime_family=${status.runtimeFamily}, deploy_target=${status.deployTarget}, and sandbox_profile=${status.sandboxProfile} for this Nora control plane.`,
    );
    error.statusCode = 400;
    throw error;
  }
  if (!status.configured) {
    const error = new Error(
      status.issue || "Runtime selection is not configured for this Nora control plane.",
    );
    error.statusCode = 400;
    throw error;
  }
  return status;
}

/**
 * Validate a template's runtime selection and verify any Kubernetes or remote
 * execution target is available to the future owning user.
 *
 * @param {Object} runtimeFields - Requested runtime and target selection.
 * @param {string} ownerUserId - User who will own the instantiated agent.
 * @returns {Promise<Object>} Validated runtime-selection status.
 */
async function assertRuntimeTargetAvailable(runtimeFields, ownerUserId) {
  const status = assertRuntimeSelectionAvailable(runtimeFields);
  await assertKubernetesExecutionTargetAvailable(runtimeFields);
  await assertRemoteHostExecutionTargetAvailable(runtimeFields, { ownerUserId });
  return status;
}

function resolveTemplateSpecs(defaults = {}, subscription = {}) {
  if (!billing.IS_PAAS) {
    const lim = billing.SELFHOSTED_LIMITS;
    return {
      vcpu: Math.max(1, Math.min(parseInt(defaults.vcpu, 10) || 2, lim.max_vcpu)),
      ram_mb: Math.max(512, Math.min(parseInt(defaults.ram_mb, 10) || 2048, lim.max_ram_mb)),
      disk_gb: Math.max(1, Math.min(parseInt(defaults.disk_gb, 10) || 20, lim.max_disk_gb)),
    };
  }

  return {
    vcpu: subscription.vcpu || parseInt(defaults.vcpu, 10) || 2,
    ram_mb: subscription.ram_mb || parseInt(defaults.ram_mb, 10) || 2048,
    disk_gb: subscription.disk_gb || parseInt(defaults.disk_gb, 10) || 20,
  };
}

async function getOwnedAgent(agentId, userId) {
  if (!agentId) return null;
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    agentId,
    userId,
  ]);
  return result.rows[0] || null;
}

/**
 * Allow published platform/internal listings to all signed-in users while
 * retaining owner access to listings that are not generally visible.
 *
 * @param {Object} listing - Listing being requested.
 * @param {string} userId - Requesting user.
 * @returns {boolean} Whether the listing may be accessed.
 */
function canAccessPublishedListing(listing, userId) {
  if (!listing) return false;
  if (
    listing.status === agentHubStore.LISTING_STATUS_PUBLISHED &&
    (listing.source_type === agentHubStore.LISTING_SOURCE_PLATFORM ||
      listing.local_visibility === agentHubStore.LISTING_LOCAL_VISIBILITY_INTERNAL)
  ) {
    return true;
  }
  return listing.owner_user_id && listing.owner_user_id === userId;
}

function buildSnapshotConfigFromAgent(agent, templatePayload) {
  const runtimeFields = buildAgentRuntimeFields(agent);
  const backend = resolveRequestedDeployTarget({
    fallbackDeployTarget: runtimeFields.deploy_target,
    fallbackBackend: runtimeFields.backend_type,
  });
  return {
    kind: "community-template",
    defaults: {
      backend,
      sandbox: runtimeFields.sandbox_profile,
      vcpu: agent.vcpu || 2,
      ram_mb: agent.ram_mb || 2048,
      disk_gb: agent.disk_gb || 20,
      image: agent.image || null,
    },
    templatePayload,
  };
}

function agentHubAuditMetadata(req, context = {}) {
  return buildAuditMetadata(req, context);
}

async function getAgentHubRemoteSettings() {
  const settings = await getAgentHubSettings();
  return {
    ...settings,
    sourceApiKey: await getAgentHubSourceApiKey(),
  };
}

/**
 * Combine a local listing with its snapshot, deployment defaults, and either a
 * compact template summary or full file content.
 *
 * @param {Object} listing - Local Agent Hub listing.
 * @param {Object} [options={}] - Whether decoded template content is included.
 * @returns {Promise<Object>} Listing detail for API responses.
 */
async function buildListingTemplateDetail(listing, options = {}) {
  const snapshot = listing?.snapshot_id ? await snapshots.getSnapshot(listing.snapshot_id) : null;
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
  };
}

function isRemoteListingId(value) {
  return String(value || "").startsWith("hub:");
}

function buildRemoteTemplateDetail(remoteDetail, options = {}) {
  const templatePayload = stripInternalTemplateMetadata(
    remoteDetail.templatePayload || remoteDetail.template_payload || {},
  );
  const template = summarizeTemplatePayload(templatePayload, {
    includeContent: options.includeContent === true,
  });
  return {
    ...remoteDetail,
    templatePayload,
    template_payload: undefined,
    id: remoteDetail.id || `hub:${remoteDetail.remote_id}`,
    remote: true,
    source_type: "community",
    status: "published",
    defaults: remoteDetail.defaults || {},
    snapshot: remoteDetail.snapshot || null,
    template:
      options.includeContent === true
        ? template
        : {
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
          },
  };
}

function buildCentralSubmissionPayload(listing, snapshot, templatePayload) {
  return {
    listing: {
      id: listing.id,
      slug: listing.slug,
      name: listing.name,
      description: listing.description,
      category: listing.category,
      price: listing.price,
      sourceType: listing.source_type,
      ownerName: listing.owner_name || listing.owner_email || "Nora user",
      version: listing.current_version || 1,
    },
    snapshot: {
      id: snapshot.id,
      kind: snapshot.kind,
      templateKey: snapshot.template_key || null,
    },
    defaults: extractTemplateDefaultsFromSnapshot(snapshot),
    templatePayload: stripInternalTemplateMetadata(templatePayload),
  };
}

/**
 * Submit a local listing to the central hub and convert remote failure into a
 * persistable share-status result instead of rejecting the local workflow.
 *
 * @param {Object} listing - Local listing metadata.
 * @param {Object} snapshot - Snapshot referenced by the listing.
 * @param {Object} templatePayload - Template content being shared.
 * @returns {Promise<Object>} Submitted or failed central-share state.
 */
async function submitToCentralHub(listing, snapshot, templatePayload) {
  const settings = await getAgentHubRemoteSettings();
  try {
    const response = await submitListing(
      settings,
      buildCentralSubmissionPayload(listing, snapshot, templatePayload),
    );
    return {
      status: agentHubStore.CENTRAL_SHARE_STATUS_SUBMITTED,
      centralListingId: response?.id || response?.listingId || response?.listing?.id || null,
      error: null,
    };
  } catch (error) {
    return {
      status: agentHubStore.CENTRAL_SHARE_STATUS_FAILED,
      centralListingId: null,
      error: error.message,
    };
  }
}

// Catalog, settings, and API-key management

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const listings = await agentHubStore.listAgentHubLocalListings();
    res.json(await Promise.all(listings.map((listing) => buildListingTemplateDetail(listing))));
  }),
);

router.get(
  "/community",
  asyncHandler(async (req, res) => {
    const settings = await getAgentHubRemoteSettings();
    const catalog = await fetchCatalog(settings, {
      refresh: req.query.refresh === "true",
    });
    res.json(catalog);
  }),
);

router.get(
  "/mine",
  asyncHandler(async (req, res) => {
    const listings = await agentHubStore.listUserListings(req.user.id);
    res.json(await Promise.all(listings.map((listing) => buildListingTemplateDetail(listing))));
  }),
);

router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await getAgentHubSettings());
  }),
);

router.get(
  "/api-keys",
  asyncHandler(async (req, res) => {
    res.json(await agentHubApiKeys.listApiKeys(req.user.id));
  }),
);

router.post(
  "/api-keys",
  asyncHandler(async (req, res) => {
    const key = await agentHubApiKeys.createApiKey(req.user.id, req.body?.label);
    await monitoring.logEvent(
      "agent_hub_api_key_created",
      `Agent Hub API key "${key.label}" was created`,
      agentHubAuditMetadata(req, {
        result: {
          keyId: key.id,
          keyPrefix: key.keyPrefix,
          label: key.label,
        },
      }),
    );
    res.status(201).json(key);
  }),
);

router.delete(
  "/api-keys/:id",
  asyncHandler(async (req, res) => {
    const key = await agentHubApiKeys.revokeApiKey(req.params.id, req.user.id);
    if (!key) return res.status(404).json({ error: "Agent Hub API key not found" });
    await monitoring.logEvent(
      "agent_hub_api_key_revoked",
      `Agent Hub API key "${key.label}" was revoked`,
      agentHubAuditMetadata(req, {
        result: {
          keyId: key.id,
          keyPrefix: key.keyPrefix,
          label: key.label,
        },
      }),
    );
    res.json(key);
  }),
);

// Publishing and installation

router.post(
  "/share",
  asyncHandler(async (req, res) => {
    const { agentId, listingId = null } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }

    const agent = await getOwnedAgent(agentId, req.user.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });

    let existingListing = null;
    if (listingId) {
      existingListing = await agentHubStore.getListing(listingId);
      if (!existingListing || existingListing.owner_user_id !== req.user.id) {
        return res.status(404).json({ error: "Listing not found" });
      }
    }

    let templatePayload;
    try {
      templatePayload = await buildTemplatePayloadFromAgent(agent, "files_only");
    } catch (error) {
      return res.status(409).json({ error: error.message });
    }

    const issues = scanTemplatePayloadForSecrets(templatePayload);
    if (issues.length > 0) {
      return res.status(400).json({
        error: "Potential secrets were detected in this template. Remove them before sharing.",
        issues,
      });
    }

    const settings = await getAgentHubSettings();
    const shareTarget = normalizeShareTarget(req.body.shareTarget, settings.defaultShareTarget);
    const localVisibility = shareTargetIncludesInternal(shareTarget)
      ? agentHubStore.LISTING_LOCAL_VISIBILITY_INTERNAL
      : agentHubStore.LISTING_LOCAL_VISIBILITY_OWNER;
    const centralShareStatus = shareTargetIncludesCommunity(shareTarget)
      ? agentHubStore.CENTRAL_SHARE_STATUS_QUEUED
      : agentHubStore.CENTRAL_SHARE_STATUS_NOT_SHARED;
    const listingName = normalizeListingName(
      req.body.name,
      existingListing?.name || agent.name || "Untitled Template",
    );
    const listingDescription = normalizeListingDescription(
      req.body.description || existingListing?.description || "",
    );
    const listingCategory = normalizeListingCategory(
      req.body.category || existingListing?.category || "General",
    );
    const listingPrice = normalizeListingPrice();

    const snapshot = await snapshots.createSnapshot(
      agent.id,
      listingName,
      listingDescription,
      buildSnapshotConfigFromAgent(agent, templatePayload),
      {
        kind: "community-template",
        builtIn: false,
      },
    );

    const listing = await agentHubStore.upsertListing({
      listingId,
      snapshotId: snapshot.id,
      ownerUserId: req.user.id,
      name: listingName,
      description: listingDescription,
      price: listingPrice,
      category: listingCategory,
      builtIn: false,
      sourceType: agentHubStore.LISTING_SOURCE_COMMUNITY,
      status: agentHubStore.LISTING_STATUS_PUBLISHED,
      visibility: agentHubStore.LISTING_VISIBILITY_PUBLIC,
      shareTarget,
      localVisibility,
      centralShareStatus,
      centralListingId: null,
      centralLastSyncedAt: null,
      centralError: null,
      cloneMode: "files_only",
    });

    let finalListing = listing;
    if (shareTargetIncludesCommunity(shareTarget)) {
      const centralResult = await submitToCentralHub(listing, snapshot, templatePayload);
      finalListing =
        (await agentHubStore.updateCentralShareStatus(listing.id, {
          status: centralResult.status,
          centralListingId: centralResult.centralListingId,
          error: centralResult.error,
        })) || listing;
    }

    await monitoring.logEvent(
      "agent_hub_shared",
      existingListing
        ? `Agent Hub listing "${finalListing.name}" was updated`
        : `Agent Hub listing "${finalListing.name}" was shared`,
      agentHubAuditMetadata(req, {
        ...buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        }),
        ...buildListingContext(finalListing, {
          snapshotId: snapshot.id,
          ownerUserId: req.user.id,
          ownerEmail: req.user.email || null,
        }),
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
        },
        result: {
          action: existingListing ? "updated" : "shared",
          shareTarget,
          centralShareStatus: finalListing.central_share_status || centralShareStatus,
        },
      }),
    );

    res.json(await agentHubStore.getListing(finalListing.id));
  }),
);

router.post(
  "/install",
  asyncHandler(async (req, res) => {
    const { listingId } = req.body;
    const requestedName = typeof req.body.name === "string" ? req.body.name : "";
    if (!listingId) return res.status(400).json({ error: "listingId is required" });
    if (!requestedName.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed) {
      return res.status(402).json({ error: limits.error, subscription: limits.subscription });
    }

    let listing;
    let snap;
    let defaults;
    let templatePayload;
    let remoteInstall = false;

    if (isRemoteListingId(listingId)) {
      const settings = await getAgentHubRemoteSettings();
      const remoteDetail = await fetchListing(settings, listingId);
      const detail = buildRemoteTemplateDetail(remoteDetail, { includeContent: true });
      listing = detail;
      snap = {
        id: detail.snapshot?.id || detail.remote_id || listingId,
        name: detail.name,
        template_key: detail.snapshot?.templateKey || detail.snapshot?.template_key || null,
      };
      defaults = detail.defaults || {};
      templatePayload = detail.templatePayload;
      remoteInstall = true;
    } else {
      listing = await agentHubStore.getListing(listingId);
      if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
        return res.status(404).json({ error: "listing not found" });
      }

      snap = await snapshots.getSnapshot(listing.snapshot_id);
      if (!snap) return res.status(404).json({ error: "snapshot missing" });
      defaults = extractTemplateDefaultsFromSnapshot(snap);
      templatePayload = extractTemplatePayloadFromSnapshot(snap, {
        includeBootstrap: true,
      });
    }
    res.locals.auditContext = buildListingContext(listing);

    const name = sanitizeAgentName(requestedName, snap.name || listing.name || "OpenClaw-Agent");
    if (name.length > 100) {
      return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    }

    const requestBody = req.body || {};
    const runtimeFamily = normalizeRequestedRuntimeFamily(requestBody.runtime_family);
    if (requestBody.runtime_family != null && runtimeFamily == null) {
      return res.status(400).json({
        error: `Unsupported runtime_family. Nora currently supports only "${DEFAULT_RUNTIME_FAMILY}".`,
      });
    }
    const runtimeFields = resolveRequestedRuntimeFields({
      request: {
        ...requestBody,
        runtime_family: runtimeFamily || DEFAULT_RUNTIME_FAMILY,
      },
      fallback: {
        backend_type: defaults.backend || null,
        execution_target_id: defaults.executionTargetId || null,
        sandbox_type: defaults.sandbox || "standard",
      },
    });
    const fallbackRuntimeFields = buildAgentRuntimeFields({
      backend_type: defaults.backend || null,
      execution_target_id: defaults.executionTargetId || null,
      sandbox_type: defaults.sandbox || "standard",
    });
    await assertRuntimeTargetAvailable(runtimeFields, req.user.id);

    const specs = resolveTemplateSpecs(defaults, limits.subscription || {});
    const image = resolveRequestedImage({
      requestedImage: requestBody.image,
      runtimeFields,
      fallbackImage: defaults.image,
      fallbackRuntimeFields,
    });
    const node = await scheduler.selectNode({
      fallback: runtimeFields.deploy_target,
    });
    const containerName = resolveContainerName({
      requestedName: requestBody.container_name,
      agentName: name,
      runtimeSelection: runtimeFields,
    });

    const result = await db.query(
      `INSERT INTO agents(
         user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
         container_name, image, template_payload, runtime_family, deploy_target,
         execution_target_id, sandbox_profile
       ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        req.user.id,
        name,
        node?.name || runtimeFields.deploy_target,
        runtimeFields.backend_type,
        runtimeFields.sandbox_type,
        specs.vcpu,
        specs.ram_mb,
        specs.disk_gb,
        containerName,
        image,
        JSON.stringify(templatePayload),
        runtimeFields.runtime_family,
        runtimeFields.deploy_target,
        runtimeFields.execution_target_id,
        runtimeFields.sandbox_profile,
      ],
    );
    const agent = result.rows[0];

    await materializeTemplateWiring(agent.id, templatePayload);
    await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);
    if (!remoteInstall) {
      await agentHubStore.recordInstall(listingId);
    }
    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      plan: limits.subscription.plan,
      backend: runtimeFields.backend_type,
      execution_target_id: runtimeFields.execution_target_id,
      sandbox: runtimeFields.sandbox_profile,
      specs,
      container_name: containerName,
      image,
    });
    await monitoring.logEvent(
      "agent_hub_install",
      `Installed "${listing.name}" as "${agent.name}"`,
      agentHubAuditMetadata(req, {
        ...buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        }),
        ...buildListingContext(listing, {
          id: listingId,
        }),
        snapshot: {
          id: snap.id,
          name: snap.name,
          templateKey: listing.template_key || snap.template_key || null,
        },
        hub: {
          remote: remoteInstall,
        },
        deploy: {
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          executionTargetId: runtimeFields.execution_target_id,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
    );

    res.json(serializeAgent(agent));
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const listing = await agentHubStore.getListing(req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    if (listing.source_type !== agentHubStore.LISTING_SOURCE_COMMUNITY) {
      return res.status(400).json({ error: "Only community listings can be edited here" });
    }
    if (!listing.owner_user_id || listing.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: "You do not have access to edit this listing" });
    }

    const snapshot = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    const update = buildAgentHubTemplateUpdate(snapshot, listing, req.body, {
      sourceType: agentHubStore.LISTING_SOURCE_COMMUNITY,
      builtIn: false,
    });
    const issues = scanTemplatePayloadForSecrets(update.snapshot.config?.templatePayload);
    if (issues.length > 0) {
      return res.status(400).json({
        error: "Potential secrets were detected in this template. Remove them before saving.",
        issues,
      });
    }

    const nextShareTarget = normalizeShareTarget(req.body.shareTarget, listing.share_target);
    const nextLocalVisibility = shareTargetIncludesInternal(nextShareTarget)
      ? agentHubStore.LISTING_LOCAL_VISIBILITY_INTERNAL
      : agentHubStore.LISTING_LOCAL_VISIBILITY_OWNER;
    const nextCentralShareStatus = shareTargetIncludesCommunity(nextShareTarget)
      ? agentHubStore.CENTRAL_SHARE_STATUS_QUEUED
      : agentHubStore.CENTRAL_SHARE_STATUS_NOT_SHARED;
    const updatedSnapshot = (await snapshots.updateSnapshot(snapshot.id, update.snapshot)) || {
      ...snapshot,
      ...update.snapshot,
      config: update.snapshot.config,
      template_key: update.snapshot.templateKey ?? snapshot.template_key,
    };
    const savedListing = await agentHubStore.upsertListing({
      listingId: listing.id,
      snapshotId: snapshot.id,
      ownerUserId: req.user.id,
      name: update.listing.name,
      description: update.listing.description,
      price: "Free",
      category: update.listing.category,
      slug: update.listing.slug,
      currentVersion: update.listing.currentVersion,
      builtIn: false,
      sourceType: agentHubStore.LISTING_SOURCE_COMMUNITY,
      status: agentHubStore.LISTING_STATUS_PUBLISHED,
      visibility: agentHubStore.LISTING_VISIBILITY_PUBLIC,
      shareTarget: nextShareTarget,
      localVisibility: nextLocalVisibility,
      centralShareStatus: nextCentralShareStatus,
      centralListingId: null,
      centralLastSyncedAt: null,
      centralError: null,
    });

    let finalListing = savedListing;
    if (shareTargetIncludesCommunity(nextShareTarget)) {
      const templatePayload = update.snapshot.config?.templatePayload || {};
      const centralResult = await submitToCentralHub(
        savedListing,
        updatedSnapshot,
        templatePayload,
      );
      finalListing =
        (await agentHubStore.updateCentralShareStatus(savedListing.id, {
          status: centralResult.status,
          centralListingId: centralResult.centralListingId,
          error: centralResult.error,
        })) || savedListing;
    }

    await monitoring.logEvent(
      "agent_hub_shared",
      `Agent Hub listing "${update.listing.name}" was updated`,
      agentHubAuditMetadata(req, {
        ...buildListingContext(listing, {
          ownerUserId: req.user.id,
          ownerEmail: req.user.email || null,
        }),
        snapshot: {
          id: snapshot.id,
          name: update.snapshot.name,
        },
        result: {
          action: "updated",
          currentVersion: update.listing.currentVersion,
          shareTarget: nextShareTarget,
          centralShareStatus: finalListing.central_share_status || nextCentralShareStatus,
        },
      }),
    );

    const refreshed = await agentHubStore.getListing(listing.id);
    res.json(
      await buildListingTemplateDetail(refreshed || listing, {
        includeContent: true,
      }),
    );
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (isRemoteListingId(req.params.id)) {
      const settings = await getAgentHubRemoteSettings();
      const remoteDetail = await fetchListing(settings, req.params.id);
      return res.json(buildRemoteTemplateDetail(remoteDetail, { includeContent: true }));
    }

    const listing = await agentHubStore.getListing(req.params.id);
    if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
      return res.status(404).json({ error: "Listing not found" });
    }

    res.json(await buildListingTemplateDetail(listing, { includeContent: true }));
  }),
);

router.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    if (isRemoteListingId(req.params.id)) {
      const settings = await getAgentHubRemoteSettings();
      const remoteDetail = await fetchListing(settings, req.params.id);
      const detail = buildRemoteTemplateDetail(remoteDetail, { includeContent: true });
      const payload = {
        listing: {
          id: detail.remote_id || detail.id,
          slug: detail.slug,
          name: detail.name,
          description: detail.description,
          category: detail.category,
          price: detail.price,
          sourceType: detail.source_type,
          ownerName: detail.owner_name || "Nora Community",
          version: detail.current_version || 1,
        },
        snapshot: detail.snapshot || null,
        defaults: detail.defaults || {},
        templatePayload: detail.templatePayload,
      };
      const filenameSeed = detail.slug || detail.name || "nora-agent-hub-template";
      const filename = `${filenameSeed.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "nora-agent-hub-template"}.nora-template.json`;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.json(payload);
    }

    const listing = await agentHubStore.getListing(req.params.id);
    if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const snapshot = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    await agentHubStore.recordDownload(listing.id);
    await monitoring.logEvent(
      "agent_hub_download",
      `Downloaded template package for "${listing.name}"`,
      agentHubAuditMetadata(req, {
        ...buildListingContext(listing),
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
        },
      }),
    );

    const payload = {
      listing: {
        id: listing.id,
        slug: listing.slug,
        name: listing.name,
        description: listing.description,
        category: listing.category,
        price: listing.price,
        sourceType: listing.source_type,
        ownerName: listing.owner_name || listing.owner_email || "Nora",
        version: listing.current_version || 1,
      },
      snapshot: {
        id: snapshot.id,
        kind: snapshot.kind,
        templateKey: snapshot.template_key || null,
      },
      defaults: extractTemplateDefaultsFromSnapshot(snapshot),
      templatePayload: extractTemplatePayloadFromSnapshot(snapshot, {
        includeBootstrap: true,
      }),
    };

    const filenameSeed = listing.slug || listing.name || "nora-template";
    const filename = `${filenameSeed.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "nora-template"}.nora-template.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json(payload);
  }),
);

router.post(
  "/:id/report",
  asyncHandler(async (req, res) => {
    const listing = await agentHubStore.getListing(req.params.id);
    if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
      return res.status(404).json({ error: "Listing not found" });
    }
    res.locals.auditContext = buildListingContext(listing);
    if (listing.source_type !== agentHubStore.LISTING_SOURCE_COMMUNITY) {
      return res.status(400).json({ error: "Only community listings can be reported" });
    }
    if (listing.owner_user_id && listing.owner_user_id === req.user.id) {
      return res.status(400).json({ error: "You cannot report your own listing" });
    }

    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ error: "reason is required" });
    }

    try {
      const report = await agentHubStore.createReport({
        listingId: listing.id,
        reporterUserId: req.user.id,
        reason,
        details: typeof req.body.details === "string" ? req.body.details.trim() : "",
      });

      await monitoring.logEvent(
        "agent_hub_reported",
        `Agent Hub listing "${listing.name}" was reported`,
        agentHubAuditMetadata(req, {
          ...buildListingContext(listing),
          ...buildReportContext(report, {
            reporterUserId: req.user.id,
            reporterEmail: req.user.email || null,
          }),
          reportDetails: {
            details: typeof req.body.details === "string" ? req.body.details.trim() : undefined,
          },
        }),
      );

      res.json({ success: true, reportId: report.id });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  }),
);

module.exports = router;
