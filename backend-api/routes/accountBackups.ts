// @ts-nocheck
const express = require("express");

const {
  createRestoreDraft,
  deleteBackup,
  getBackupDownload,
  listUserBackups,
} = require("../backups");
const monitoring = require("../monitoring");
const { createMutationFailureAuditMiddleware } = require("../auditLog");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireSession } = require("../middleware/auth");

// Account-scoped backup access, resolved by backup id rather than through an
// agent.
//
// The agent-scoped router at /agents/:id/backups resolves the agent first and
// 404s when it is gone, so a backup became unreachable the moment its source
// agent was deleted — precisely the disaster-recovery case managed backups
// exist for. The archive and its row both survived; nothing routed to them
// (#338).
//
// The service layer already supported this: createRestoreDraft,
// getBackupDownload and deleteBackup all take agentId = null and scope by
// user_id, so ownership is enforced the same way here. Only the routing was
// missing.
const router = express.Router();

// Same reasoning as the agent-scoped router: backup archives carry full agent
// state and restore creates new runtime drafts, so a workspace API key must not
// inherit its issuer's owner access.
router.use(requireSession);
router.use(createMutationFailureAuditMiddleware("backup"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listUserBackups(req.user.id));
  }),
);

router.get(
  "/:backupId/download",
  asyncHandler(async (req, res) => {
    const { buffer, filename } = await getBackupDownload({
      backupId: req.params.backupId,
      userId: req.user.id,
    });
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

router.delete(
  "/:backupId",
  asyncHandler(async (req, res) => {
    res.json(
      await deleteBackup({
        backupId: req.params.backupId,
        userId: req.user.id,
      }),
    );
  }),
);

router.post(
  "/:backupId/restore",
  asyncHandler(async (req, res) => {
    // In-place restore needs a live agent to restore into, so it stays on the
    // agent-scoped route. Copy restore provisions a fresh agent from the
    // archive, which is what makes it work after the source agent is gone.
    const mode = String(req.body?.mode || "copy")
      .trim()
      .toLowerCase();
    if (mode !== "copy") {
      return res.status(400).json({
        error:
          "Only copy restore is available here. In-place restore requires the original agent and is available on /agents/:id/backups/:backupId/restore.",
      });
    }

    const result = await createRestoreDraft({
      backupId: req.params.backupId,
      userId: req.user.id,
    });
    await monitoring.logEvent(
      "backup_restore_draft_created",
      "Backup restore draft created from account-scoped route",
      {
        actor: { userId: req.user.id, email: req.user.email || null, role: req.user.role || null },
        backup: { id: req.params.backupId },
        restore: { mode: "copy", draftId: result.draft?.id || null },
      },
    );
    res.json(result);
  }),
);

module.exports = router;
