// @ts-nocheck
// Workspace-scoped alert rule management. Mounted under
// /workspaces/:id/alert-rules. Reading requires viewer; mutating requires admin.

const express = require("express");
const alertRules = require("../alertRules");
const monitoring = require("../monitoring");
const { buildAuditMetadata, buildWorkspaceContext } = require("../auditLog");
const { requireWorkspaceRole } = require("../middleware/ownership");

const router = express.Router({ mergeParams: true });

/**
 * Write a workspace-scoped alert-rule audit event without failing the primary
 * mutation when audit persistence or downstream alert evaluation fails.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {string} eventType - Audit event type.
 * @param {string} message - Human-readable event message.
 * @param {Object} context - Workspace and alert context.
 * @returns {Promise<void>}
 */
function logAlertEvent(req, eventType, message, context) {
  return Promise.resolve(
    monitoring.logEvent(
      eventType,
      message,
      buildAuditMetadata(req, buildWorkspaceContext({}, context)),
    ),
  ).catch((error) => {
    console.error(`Failed to write alert audit event ${eventType}:`, error.message);
  });
}

router.get("/", requireWorkspaceRole("viewer", "id"), async (req, res) => {
  try {
    res.json(await alertRules.listRules(req.params.id));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/", requireWorkspaceRole("admin", "id"), async (req, res) => {
  try {
    const created = await alertRules.createRule(req.params.id, req.user.id, req.body || {});
    await logAlertEvent(req, "alert_rule_created", `Alert rule "${created.name}" created`, {
      id: req.params.id,
      alert: { id: created.id, name: created.name, eventPattern: created.eventPattern },
    });
    res.json(created);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.patch("/:ruleId", requireWorkspaceRole("admin", "id"), async (req, res) => {
  try {
    const updated = await alertRules.updateRule(req.params.ruleId, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Alert rule not found" });
    await logAlertEvent(req, "alert_rule_updated", `Alert rule "${updated.name}" updated`, {
      id: req.params.id,
      alert: { id: updated.id, name: updated.name, eventPattern: updated.eventPattern },
    });
    res.json(updated);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.delete("/:ruleId", requireWorkspaceRole("admin", "id"), async (req, res) => {
  try {
    const deleted = await alertRules.deleteRule(req.params.ruleId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Alert rule not found" });
    await logAlertEvent(req, "alert_rule_deleted", `Alert rule deleted`, {
      id: req.params.id,
      alert: { id: req.params.ruleId },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Test-fire: deliver a synthetic event through the rule to validate the
// channels are reachable. Useful for "is my Slack webhook working?" smoke
// tests from the UI.
router.post("/:ruleId/test", requireWorkspaceRole("admin", "id"), async (req, res) => {
  try {
    const rule = await alertRules.getRule(req.params.ruleId, req.params.id);
    if (!rule) return res.status(404).json({ error: "Alert rule not found" });

    const fakeEvent = {
      type: rule.eventPattern.endsWith(".*")
        ? `${rule.eventPattern.slice(0, -2)}.test`
        : rule.eventPattern,
      message: `Nora test alert from rule "${rule.name}"`,
      metadata: { workspace: { id: req.params.id }, test: true },
    };
    await alertRules.evaluateAndDeliver(fakeEvent.type, fakeEvent.message, fakeEvent.metadata);
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
