// @ts-nocheck
// Fleet-level runtime transitions. A single migration captures the request,
// every affected agent's pre-state (so rollback is possible), and a status
// timeline. Execution reuses the existing per-agent redeploy path — we don't
// reinvent the queue, just orchestrate batches of redeploys.

const db = require("./db");
const {
  getRuntimeSelectionStatus,
  isKnownRuntimeFamily,
  normalizeDeployTargetName,
  normalizeExecutionTargetId,
} = require("../agent-runtime/lib/backendCatalog");
const agentVersions = require("./agentVersions");

const ALLOWED_TARGETS = new Set(["docker", "k8s", "proxmox"]);
const ALLOWED_SANDBOXES = new Set(["standard", "nemoclaw"]);

// Selection and compatibility planning

/**
 * Normalize selection aliases and reject unsupported runtime, target, or sandbox values.
 *
 * @param {Object} value - Source or target selection supplied by the caller.
 * @param {string} label - Field prefix used in validation errors.
 * @returns {Object} Canonical selection with nullable criteria.
 */
function normalizeSelection(value, label) {
  const sel = value && typeof value === "object" ? value : {};
  const runtimeFamily = sel.runtime_family || sel.runtimeFamily;
  if (runtimeFamily && !isKnownRuntimeFamily(runtimeFamily)) {
    const error = new Error(`${label}.runtime_family ${runtimeFamily} is not a known runtime`);
    error.statusCode = 400;
    throw error;
  }
  const explicitExecutionTargetId = normalizeExecutionTargetId(
    sel.execution_target_id || sel.executionTargetId || sel.executionTarget,
  );
  const rawDeployTarget = sel.deploy_target || sel.deployTarget || explicitExecutionTargetId;
  const normalizedTargetFromDeployTarget = rawDeployTarget
    ? normalizeExecutionTargetId(rawDeployTarget)
    : null;
  if (rawDeployTarget && !normalizedTargetFromDeployTarget) {
    const error = new Error(
      `${label}.deploy_target must be one of: ${[...ALLOWED_TARGETS].join(", ")}`,
    );
    error.statusCode = 400;
    throw error;
  }
  const deployTarget = rawDeployTarget
    ? normalizeDeployTargetName(normalizedTargetFromDeployTarget)
    : null;
  const executionTargetId =
    explicitExecutionTargetId ||
    (normalizedTargetFromDeployTarget && normalizedTargetFromDeployTarget !== deployTarget
      ? normalizedTargetFromDeployTarget
      : null);
  const sandboxProfile = sel.sandbox_profile || sel.sandboxProfile;
  if (sandboxProfile && !ALLOWED_SANDBOXES.has(sandboxProfile)) {
    const error = new Error(
      `${label}.sandbox_profile must be one of: ${[...ALLOWED_SANDBOXES].join(", ")}`,
    );
    error.statusCode = 400;
    throw error;
  }
  const normalizedSelection = {
    runtime_family: runtimeFamily || null,
    deploy_target: deployTarget || null,
    sandbox_profile: sandboxProfile || null,
  };
  if (executionTargetId) {
    normalizedSelection.execution_target_id = executionTargetId;
  }
  return normalizedSelection;
}

function selectionWhereClause(selection) {
  const conditions = [];
  const params = [];
  let next = 1;
  if (selection.runtime_family) {
    conditions.push(`runtime_family = $${next++}`);
    params.push(selection.runtime_family);
  }
  if (selection.deploy_target) {
    conditions.push(`deploy_target = $${next++}`);
    params.push(selection.deploy_target);
  }
  if (selection.execution_target_id) {
    conditions.push(`execution_target_id = $${next++}`);
    params.push(selection.execution_target_id);
  }
  if (selection.sandbox_profile) {
    conditions.push(`sandbox_profile = $${next++}`);
    params.push(selection.sandbox_profile);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

async function findCandidateAgents(source, agentIds) {
  if (Array.isArray(agentIds) && agentIds.length > 0) {
    const result = await db.query(
      `SELECT id, name, user_id, status, runtime_family, deploy_target, execution_target_id,
              sandbox_profile,
              backend_type, sandbox_type, container_id, container_name, image,
              vcpu, ram_mb, disk_gb, template_payload
         FROM agents
        WHERE id = ANY($1::uuid[])`,
      [agentIds],
    );
    return result.rows;
  }
  const { where, params } = selectionWhereClause(source);
  const result = await db.query(
    `SELECT id, name, user_id, status, runtime_family, deploy_target, execution_target_id,
            sandbox_profile,
            backend_type, sandbox_type, container_id, container_name, image,
            vcpu, ram_mb, disk_gb, template_payload
       FROM agents
       ${where}`,
    params,
  );
  return result.rows;
}

/**
 * Compare an agent's current runtime selection with a proposed target.
 *
 * @param {Object} agent - Candidate agent row.
 * @param {Object} target - Normalized target selection.
 * @returns {Object} Current, desired, and availability details for the agent.
 */
function evaluateAgent(agent, target) {
  const desired = {
    runtime_family: target.runtime_family || agent.runtime_family,
    deploy_target: target.deploy_target || agent.deploy_target,
    execution_target_id:
      target.execution_target_id ||
      agent.execution_target_id ||
      target.deploy_target ||
      agent.deploy_target,
    sandbox_profile: target.sandbox_profile || agent.sandbox_profile,
  };
  const status = getRuntimeSelectionStatus(desired);
  return {
    agentId: agent.id,
    agentName: agent.name,
    current: {
      runtime_family: agent.runtime_family,
      deploy_target: agent.deploy_target,
      execution_target_id: agent.execution_target_id || agent.deploy_target,
      sandbox_profile: agent.sandbox_profile,
    },
    desired,
    available: status?.available !== false,
    statusReason: status?.reason || null,
  };
}

/**
 * Capture the runtime and template fields needed by the current rollback path.
 *
 * @param {Object} agent - Candidate agent row.
 * @returns {Object} Persistable pre-migration state.
 */
function captureBeforeState(agent) {
  return {
    runtime_family: agent.runtime_family,
    deploy_target: agent.deploy_target,
    execution_target_id: agent.execution_target_id || agent.deploy_target,
    sandbox_profile: agent.sandbox_profile,
    backend_type: agent.backend_type,
    sandbox_type: agent.sandbox_type,
    container_name: agent.container_name,
    image: agent.image,
    template_payload: agent.template_payload || {},
  };
}

/**
 * Plan a fleet transition without mutating agents or creating a migration record.
 *
 * Explicit agent IDs select candidates directly; otherwise the normalized source filters them.
 *
 * @param {Object} [input={}] - Source, target, and optional agent IDs.
 * @returns {Promise<Object>} Normalized selections and per-agent compatibility evaluations.
 */
async function planMigration({ source = {}, target = {}, agentIds = [] } = {}) {
  const normalizedSource = normalizeSelection(source, "from");
  const normalizedTarget = normalizeSelection(target, "to");
  const ids = Array.isArray(agentIds) ? agentIds.filter((id) => typeof id === "string") : [];
  const agents = await findCandidateAgents(normalizedSource, ids);
  const evaluations = agents.map((agent) => evaluateAgent(agent, normalizedTarget));
  return {
    source: normalizedSource,
    target: normalizedTarget,
    agentCount: evaluations.length,
    blockedCount: evaluations.filter((e) => !e.available).length,
    evaluations,
  };
}

// Migration persistence

/**
 * Persist a fleet migration plan and its pre-state snapshot without executing agent transitions.
 *
 * Dry runs are recorded as completed. Real runs are recorded as queued and request best-effort
 * per-agent version snapshots.
 *
 * @param {Object} [input={}] - Selections, candidate IDs, dry-run flag, actor, and notes.
 * @returns {Promise<Object>} Serialized migration record and compatibility plan.
 */
async function createMigration({
  source,
  target,
  agentIds,
  dryRun = false,
  initiatedBy = null,
  notes = null,
} = {}) {
  const plan = await planMigration({ source, target, agentIds });

  // Capture snapshot of every agent's pre-state so rollback is possible later.
  const agents = await findCandidateAgents(plan.source, agentIds);
  const beforeState = {};
  for (const agent of agents) {
    beforeState[agent.id] = captureBeforeState(agent);
  }

  const insert = await db.query(
    `INSERT INTO fleet_migrations
       (initiated_by, status, source_selection, target_selection, agent_ids,
        before_state, dry_run, notes, started_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
     RETURNING *`,
    [
      initiatedBy,
      dryRun ? "completed" : "queued",
      JSON.stringify(plan.source),
      JSON.stringify(plan.target),
      JSON.stringify(agents.map((a) => a.id)),
      JSON.stringify(beforeState),
      dryRun,
      notes,
      dryRun ? new Date() : null,
    ],
  );

  if (!dryRun) {
    // Snapshot a pre-migration version per agent so per-agent rollback works
    // through the existing /agents/:id/rollback path too.
    for (const agent of agents) {
      agentVersions.recordVersionBestEffort(agent.id, agent.template_payload || {}, {
        createdBy: initiatedBy,
        message: `Pre-fleet-migration snapshot (migration ${insert.rows[0].id})`,
        source: "redeploy",
      });
    }
  }

  return {
    migration: serializeMigration(insert.rows[0]),
    plan,
  };
}

function serializeMigration(row) {
  return {
    id: row.id,
    initiatedBy: row.initiated_by,
    status: row.status,
    sourceSelection: row.source_selection || {},
    targetSelection: row.target_selection || {},
    agentIds: Array.isArray(row.agent_ids) ? row.agent_ids : [],
    beforeState: row.before_state || {},
    afterState: row.after_state || {},
    errors: Array.isArray(row.errors) ? row.errors : [],
    dryRun: row.dry_run,
    notes: row.notes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    rolledBackAt: row.rolled_back_at,
    createdAt: row.created_at,
  };
}

async function listMigrations({ limit = 50 } = {}) {
  const result = await db.query(
    `SELECT * FROM fleet_migrations
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  );
  return result.rows.map(serializeMigration);
}

async function getMigration(migrationId) {
  const result = await db.query("SELECT * FROM fleet_migrations WHERE id = $1", [migrationId]);
  return result.rows[0] ? serializeMigration(result.rows[0]) : null;
}

/**
 * Mark a migration record rolled back after its caller performs any agent restoration.
 *
 * @param {string} migrationId - Fleet migration identifier.
 * @param {Object} [afterState={}] - Caller-supplied rollback outcome.
 * @returns {Promise<Object|null>} Updated migration record when found.
 */
async function markRolledBack(migrationId, afterState = {}) {
  const result = await db.query(
    `UPDATE fleet_migrations
        SET status = 'rolled_back',
            rolled_back_at = NOW(),
            after_state = $2::jsonb
      WHERE id = $1
      RETURNING *`,
    [migrationId, JSON.stringify(afterState)],
  );
  return result.rows[0] ? serializeMigration(result.rows[0]) : null;
}

module.exports = {
  ALLOWED_TARGETS,
  ALLOWED_SANDBOXES,
  captureBeforeState,
  createMigration,
  evaluateAgent,
  getMigration,
  listMigrations,
  markRolledBack,
  normalizeSelection,
  planMigration,
  serializeMigration,
};
