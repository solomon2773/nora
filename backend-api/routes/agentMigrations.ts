// @ts-nocheck
const express = require("express");

const {
  buildLiveMigrationManifest,
  createMigrationDraft,
  deleteOwnedMigrationDraft,
  getOwnedMigrationDraft,
  parseUploadedMigrationBuffer,
} = require("../agentMigrations");
const { asyncHandler } = require("../middleware/errorHandler");
const { createMutationFailureAuditMiddleware } = require("../auditLog");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("agent_migration"));

router.post(
  "/upload",
  express.raw({ type: "*/*", limit: "100mb" }),
  asyncHandler(async (req, res) => {
    const filename = String(req.get("x-upload-filename") || "").trim();
    const manifest = await parseUploadedMigrationBuffer(req.body, filename);
    const draft = await createMigrationDraft({
      userId: req.user.id,
      manifest,
      sourceKind: "upload",
      sourceTransport: filename.toLowerCase().endsWith(".json") ? "file" : "bundle",
    });

    res.json({ draft: draft.preview });
  })
);

router.post(
  "/live-inspect",
  asyncHandler(async (req, res) => {
    const manifest = await buildLiveMigrationManifest(req.body || {});
    const draft = await createMigrationDraft({
      userId: req.user.id,
      manifest,
      sourceKind: "live",
      sourceTransport: req.body?.transport || "",
    });

    res.json({ draft: draft.preview });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const draft = await getOwnedMigrationDraft(req.params.id, req.user.id);
    if (!draft) {
      return res.status(404).json({ error: "Migration draft not found" });
    }

    res.json({ draft: draft.preview });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const draft = await getOwnedMigrationDraft(req.params.id, req.user.id);
    if (!draft) {
      return res.status(404).json({ error: "Migration draft not found" });
    }
    if (draft.deployed_agent_id) {
      return res.status(409).json({
        error: "This migration draft is attached to a deployed agent and cannot be deleted.",
      });
    }

    const deleted = await deleteOwnedMigrationDraft(req.params.id, req.user.id);
    res.json({ success: deleted });
  })
);

module.exports = router;
