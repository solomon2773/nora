// @ts-nocheck
// Fleet-level runtime migration endpoints. Admin-only; mounted under
// /admin/fleet/migrations so the existing requireAdmin guard already covers
// the path. Dry-run mode reports per-agent compatibility without queuing
// any work; real runs reuse the per-agent redeploy path.

const express = require("express");
const fleetMigrations = require("../fleetMigrations");
const monitoring = require("../monitoring");
const { buildAuditMetadata } = require("../auditLog");
const { requireAdmin } = require("../middleware/auth");
const { requireSession } = require("../middleware/auth");

const router = express.Router();

// Fleet operations are infrastructure-level and should never be triggerable by
// an API key. Belt-and-braces over the admin guard.
router.use(requireSession);
router.use(requireAdmin);

/**
 * Record fleet audit activity without letting monitoring failures fail the request.
 *
 * @param {Object} req - Express request used to build audit metadata.
 * @param {string} eventType - Monitoring event type.
 * @param {string} message - Human-readable event message.
 * @param {Object} [context={}] - Fleet-specific audit context.
 * @returns {Promise<void>} Settled best-effort logging promise.
 */
function logFleetEvent(req, eventType, message, context = {}) {
  return Promise.resolve(
    monitoring.logEvent(eventType, message, buildAuditMetadata(req, context)),
  ).catch((err) => console.error(`fleet audit ${eventType} failed:`, err.message));
}

router.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json(await fleetMigrations.listMigrations({ limit }));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/preview", async (req, res) => {
  try {
    const plan = await fleetMigrations.planMigration({
      source: req.body?.from || req.body?.source,
      target: req.body?.to || req.body?.target,
      agentIds: req.body?.agent_ids || req.body?.agentIds,
    });
    res.json(plan);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const dryRun = Boolean(req.body?.dry_run ?? req.body?.dryRun);
    const result = await fleetMigrations.createMigration({
      source: req.body?.from || req.body?.source,
      target: req.body?.to || req.body?.target,
      agentIds: req.body?.agent_ids || req.body?.agentIds,
      dryRun,
      initiatedBy: req.user?.id || null,
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await logFleetEvent(
      req,
      dryRun ? "fleet_migration_previewed" : "fleet_migration_started",
      dryRun
        ? `Fleet migration preview (${result.plan.agentCount} agents)`
        : `Fleet migration queued for ${result.plan.agentCount} agents`,
      {
        migration: {
          id: result.migration.id,
          dryRun,
          source: result.migration.sourceSelection,
          target: result.migration.targetSelection,
          agentCount: result.plan.agentCount,
          blockedCount: result.plan.blockedCount,
        },
      },
    );

    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const migration = await fleetMigrations.getMigration(req.params.id);
    if (!migration) return res.status(404).json({ error: "Migration not found" });
    res.json(migration);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/:id/rollback", async (req, res) => {
  try {
    const migration = await fleetMigrations.getMigration(req.params.id);
    if (!migration) return res.status(404).json({ error: "Migration not found" });
    if (migration.dryRun) {
      return res.status(409).json({ error: "Dry-run migrations cannot be rolled back" });
    }
    if (migration.status === "rolled_back") {
      return res.status(409).json({ error: "Migration already rolled back" });
    }

    const errors = [];
    const restoredAgents = [];
    const db = require("../db");
    for (const [agentId, before] of Object.entries(migration.beforeState)) {
      try {
        await db.query(
          `UPDATE agents
              SET runtime_family = $2,
                  deploy_target = $3,
                  execution_target_id = $4,
                  sandbox_profile = $5,
                  backend_type = $6,
                  sandbox_type = $7,
                  container_name = $8,
                  image = $9,
                  template_payload = $10::jsonb,
                  status = 'queued',
                  container_id = NULL
            WHERE id = $1`,
          [
            agentId,
            before.runtime_family,
            before.deploy_target,
            before.execution_target_id || before.deploy_target,
            before.sandbox_profile,
            before.backend_type,
            before.sandbox_type,
            before.container_name,
            before.image,
            JSON.stringify(before.template_payload || {}),
          ],
        );
        restoredAgents.push(agentId);
      } catch (err) {
        errors.push({ agentId, error: err.message });
      }
    }

    const updated = await fleetMigrations.markRolledBack(req.params.id, {
      restoredAgents,
      errors,
      rolledBackAt: new Date().toISOString(),
    });

    await logFleetEvent(
      req,
      "fleet_migration_rolled_back",
      `Rolled back fleet migration ${req.params.id}`,
      {
        migration: {
          id: req.params.id,
          restoredCount: restoredAgents.length,
          errorCount: errors.length,
        },
      },
    );

    res.json({ migration: updated, restoredAgents, errors });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
