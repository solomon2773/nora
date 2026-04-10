const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const marketplace = require("../marketplace");
const { scanTemplatePayloadForSecrets } = require("../marketplaceSafety");
const { buildMarketplaceTemplateUpdate } = require("../marketplaceTemplateEdits");
const snapshots = require("../snapshots");
const scheduler = require("../scheduler");
const monitoring = require("../monitoring");
const {
  buildContainerName,
  buildTemplatePayloadFromAgent,
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
  materializeTemplateWiring,
  sanitizeAgentName,
  serializeAgent,
  summarizeTemplatePayload,
} = require("../agentPayloads");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");
const {
  getBackendStatus,
  getDefaultBackend,
  isKnownBackend,
  normalizeBackendName,
  sandboxForBackend,
} = require("../../agent-runtime/lib/backendCatalog");
const { asyncHandler } = require("../middleware/errorHandler");
const {
  buildAgentContext,
  buildAuditMetadata,
  buildListingContext,
  buildReportContext,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("marketplace"));

function normalizeListingName(value, fallback = "Untitled Template") {
  const normalized =
    typeof value === "string"
      ? value.replace(/[\x00-\x1f\x7f]/g, "").trim()
      : "";
  return (normalized || fallback).slice(0, 100);
}

function normalizeListingDescription(value) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
}

function normalizeListingCategory(value) {
  const normalized =
    typeof value === "string"
      ? value.replace(/[\x00-\x1f\x7f]/g, "").trim()
      : "";
  return (normalized || "General").slice(0, 60);
}

function normalizeListingPrice(value) {
  return "Free";
}

function resolveRequestedImage({
  requestedImage,
  backend = "docker",
  fallbackImage = null,
} = {}) {
  const normalizedBackend = isKnownBackend(backend)
    ? normalizeBackendName(backend)
    : getDefaultBackend(process.env, { sandbox: "standard" });
  return (
    (typeof requestedImage === "string" && requestedImage.trim()) ||
    fallbackImage ||
    getDefaultAgentImage({
      sandbox: sandboxForBackend(normalizedBackend),
      backend: normalizedBackend,
    })
  );
}

function resolveRequestedBackend({
  requestedBackend,
  fallbackBackend = null,
  fallbackSandbox = "standard",
} = {}) {
  if (isKnownBackend(requestedBackend)) {
    return normalizeBackendName(requestedBackend);
  }
  if (isKnownBackend(fallbackBackend)) {
    return normalizeBackendName(fallbackBackend);
  }
  return getDefaultBackend(process.env, { sandbox: fallbackSandbox });
}

function assertBackendAvailable(backend) {
  const status = getBackendStatus(backend);
  if (!status.enabled) {
    const error = new Error(
      `${status.label} is not enabled. Add "${status.id}" to ENABLED_BACKENDS to use this backend.`
    );
    error.statusCode = 400;
    throw error;
  }
  if (!status.configured) {
    const error = new Error(
      status.issue || `${status.label} is not configured for this Nora control plane.`
    );
    error.statusCode = 400;
    throw error;
  }
  return status;
}

function resolveTemplateSpecs(defaults = {}, subscription = {}) {
  if (!billing.IS_PAAS) {
    const lim = billing.SELFHOSTED_LIMITS;
    return {
      vcpu: Math.max(1, Math.min(parseInt(defaults.vcpu, 10) || 2, lim.max_vcpu)),
      ram_mb: Math.max(
        512,
        Math.min(parseInt(defaults.ram_mb, 10) || 2048, lim.max_ram_mb)
      ),
      disk_gb: Math.max(
        1,
        Math.min(parseInt(defaults.disk_gb, 10) || 20, lim.max_disk_gb)
      ),
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
  const result = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [agentId, userId]
  );
  return result.rows[0] || null;
}

function canAccessPublishedListing(listing, userId) {
  if (!listing) return false;
  if (listing.status === marketplace.LISTING_STATUS_PUBLISHED) return true;
  return listing.owner_user_id && listing.owner_user_id === userId;
}

function buildSnapshotConfigFromAgent(agent, templatePayload) {
  const backend = resolveRequestedBackend({
    fallbackBackend: agent.backend_type || null,
    fallbackSandbox: agent.sandbox_type || "standard",
  });
  return {
    kind: "community-template",
    defaults: {
      backend,
      sandbox: sandboxForBackend(backend),
      vcpu: agent.vcpu || 2,
      ram_mb: agent.ram_mb || 2048,
      disk_gb: agent.disk_gb || 20,
      image: agent.image || null,
    },
    templatePayload,
  };
}

function marketplaceAuditMetadata(req, context = {}) {
  return buildAuditMetadata(req, context);
}

async function buildListingTemplateDetail(listing, options = {}) {
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
  };
}

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const listings = await marketplace.listMarketplace();
    res.json(
      await Promise.all(
        listings.map((listing) => buildListingTemplateDetail(listing))
      )
    );
  })
);

router.get(
  "/mine",
  asyncHandler(async (req, res) => {
    const listings = await marketplace.listUserListings(req.user.id);
    res.json(
      await Promise.all(
        listings.map((listing) => buildListingTemplateDetail(listing))
      )
    );
  })
);

router.post(
  "/publish",
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
      existingListing = await marketplace.getListing(listingId);
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
        error:
          "Potential secrets were detected in this template. Remove them before publishing.",
        issues,
      });
    }

    const listingName = normalizeListingName(
      req.body.name,
      existingListing?.name || agent.name || "Untitled Template"
    );
    const listingDescription = normalizeListingDescription(
      req.body.description || existingListing?.description || ""
    );
    const listingCategory = normalizeListingCategory(
      req.body.category || existingListing?.category || "General"
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
      }
    );

    const listing = await marketplace.upsertListing({
      listingId,
      snapshotId: snapshot.id,
      ownerUserId: req.user.id,
      name: listingName,
      description: listingDescription,
      price: listingPrice,
      category: listingCategory,
      builtIn: false,
      sourceType: marketplace.LISTING_SOURCE_COMMUNITY,
      status: marketplace.LISTING_STATUS_PENDING_REVIEW,
      visibility: marketplace.LISTING_VISIBILITY_PUBLIC,
      cloneMode: "files_only",
    });

    await monitoring.logEvent(
      "marketplace_submitted",
      existingListing
        ? `Marketplace listing "${listing.name}" resubmitted for review`
        : `Marketplace listing "${listing.name}" submitted for review`,
      marketplaceAuditMetadata(req, {
        ...buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        }),
        ...buildListingContext(listing, {
          snapshotId: snapshot.id,
          ownerUserId: req.user.id,
          ownerEmail: req.user.email || null,
        }),
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
        },
        result: {
          action: existingListing ? "resubmitted" : "submitted",
        },
      })
    );

    res.json(await marketplace.getListing(listing.id));
  })
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
      return res
        .status(402)
        .json({ error: limits.error, subscription: limits.subscription });
    }

    const listing = await marketplace.getListing(listingId);
    if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
      return res.status(404).json({ error: "listing not found" });
    }
    res.locals.auditContext = buildListingContext(listing);

    const snap = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snap) return res.status(404).json({ error: "snapshot missing" });

    const name = sanitizeAgentName(
      requestedName,
      snap.name || listing.name || "OpenClaw-Agent"
    );
    if (name.length > 100) {
      return res
        .status(400)
        .json({ error: "Agent name must be 100 characters or less" });
    }

    const defaults = extractTemplateDefaultsFromSnapshot(snap);
    const backend = resolveRequestedBackend({
      requestedBackend: req.body.backend,
      fallbackBackend: defaults.backend || null,
      fallbackSandbox: defaults.sandbox,
    });
    assertBackendAvailable(backend);
    const sandbox = sandboxForBackend(backend);

    const specs = resolveTemplateSpecs(defaults, limits.subscription || {});
    const image = resolveRequestedImage({
      requestedImage: req.body.image,
      backend,
      fallbackImage: defaults.image,
    });
    const templatePayload = extractTemplatePayloadFromSnapshot(snap, {
      includeBootstrap: true,
    });
    const node = await scheduler.selectNode({ fallback: backend });
    const containerNameRaw = (req.body.container_name || "").trim();
    const containerName = containerNameRaw || buildContainerName(name);

    const result = await db.query(
      `INSERT INTO agents(
         user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
         container_name, image, template_payload
       ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.user.id,
        name,
        node?.name || backend,
        backend,
        sandbox,
        specs.vcpu,
        specs.ram_mb,
        specs.disk_gb,
        containerName,
        image,
        JSON.stringify(templatePayload),
      ]
    );
    const agent = result.rows[0];

    await materializeTemplateWiring(agent.id, templatePayload);
    await db.query(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      [agent.id]
    );
    await marketplace.recordInstall(listingId);
    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      plan: limits.subscription.plan,
      backend,
      sandbox,
      specs,
      container_name: containerName,
      image,
    });
    await monitoring.logEvent(
      "marketplace_install",
      `Installed "${listing.name}" as "${agent.name}"`,
      marketplaceAuditMetadata(req, {
        ...buildAgentContext(agent, {
          ownerEmail: req.user.email || null,
        }),
        ...buildListingContext(listing, {
          id: listingId,
        }),
        snapshot: {
          id: snap.id,
          name: snap.name,
          templateKey: listing.template_key || null,
        },
      })
    );

    res.json(serializeAgent(agent));
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    if (listing.source_type !== marketplace.LISTING_SOURCE_COMMUNITY) {
      return res.status(400).json({ error: "Only community listings can be edited here" });
    }
    if (!listing.owner_user_id || listing.owner_user_id !== req.user.id) {
      return res.status(403).json({ error: "You do not have access to edit this listing" });
    }

    const snapshot = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    const update = buildMarketplaceTemplateUpdate(snapshot, listing, req.body, {
      sourceType: marketplace.LISTING_SOURCE_COMMUNITY,
      builtIn: false,
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
      ownerUserId: req.user.id,
      name: update.listing.name,
      description: update.listing.description,
      price: "Free",
      category: update.listing.category,
      slug: update.listing.slug,
      currentVersion: update.listing.currentVersion,
      builtIn: false,
      sourceType: marketplace.LISTING_SOURCE_COMMUNITY,
      status: marketplace.LISTING_STATUS_PENDING_REVIEW,
      visibility: marketplace.LISTING_VISIBILITY_PUBLIC,
    });

    await monitoring.logEvent(
      "marketplace_submitted",
      `Marketplace listing "${update.listing.name}" updated and resubmitted for review`,
      marketplaceAuditMetadata(req, {
        ...buildListingContext(listing, {
          ownerUserId: req.user.id,
          ownerEmail: req.user.email || null,
        }),
        snapshot: {
          id: snapshot.id,
          name: update.snapshot.name,
        },
        result: {
          action: "updated_and_resubmitted",
          currentVersion: update.listing.currentVersion,
        },
      })
    );

    const refreshed = await marketplace.getListing(listing.id);
    res.json(
      await buildListingTemplateDetail(refreshed || listing, {
        includeContent: true,
      })
    );
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
      return res.status(404).json({ error: "Listing not found" });
    }

    res.json(await buildListingTemplateDetail(listing, { includeContent: true }));
  })
);

router.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    if (!listing || !canAccessPublishedListing(listing, req.user.id)) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const snapshot = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snapshot) {
      return res.status(404).json({ error: "Snapshot not found" });
    }

    await marketplace.recordDownload(listing.id);
    await monitoring.logEvent(
      "marketplace_download",
      `Downloaded template package for "${listing.name}"`,
      marketplaceAuditMetadata(req, {
        ...buildListingContext(listing),
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
        },
      })
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
  })
);

router.post(
  "/:id/report",
  asyncHandler(async (req, res) => {
    const listing = await marketplace.getListing(req.params.id);
    if (!listing || listing.status !== marketplace.LISTING_STATUS_PUBLISHED) {
      return res.status(404).json({ error: "Listing not found" });
    }
    res.locals.auditContext = buildListingContext(listing);
    if (listing.source_type !== marketplace.LISTING_SOURCE_COMMUNITY) {
      return res.status(400).json({ error: "Only community listings can be reported" });
    }
    if (listing.owner_user_id && listing.owner_user_id === req.user.id) {
      return res.status(400).json({ error: "You cannot report your own listing" });
    }

    const reason =
      typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      return res.status(400).json({ error: "reason is required" });
    }

    try {
      const report = await marketplace.createReport({
        listingId: listing.id,
        reporterUserId: req.user.id,
        reason,
        details:
          typeof req.body.details === "string" ? req.body.details.trim() : "",
      });

      await monitoring.logEvent(
        "marketplace_reported",
        `Marketplace listing "${listing.name}" was reported`,
        marketplaceAuditMetadata(req, {
          ...buildListingContext(listing),
          ...buildReportContext(report, {
            reporterUserId: req.user.id,
            reporterEmail: req.user.email || null,
          }),
          reportDetails: {
            details:
              typeof req.body.details === "string"
                ? req.body.details.trim()
                : undefined,
          },
        })
      );

      res.json({ success: true, reportId: report.id });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  })
);

module.exports = router;
