// @ts-nocheck
// Per-agent LLM spend budgets with hard-cap enforcement. Mirrors
// workspaceBudgets.ts for CRUD/alert-dedup semantics, and adds the part only
// a provisioning control plane can do: when spend crosses 100% of a budget,
// the runtime is stopped (status 'stopped' + paused_reason 'budget_exceeded').
//
// Enforcement runs from two directions:
//   - inline, fire-and-forget after every recordTokenUsage in gatewayProxy;
//   - sweepAgentBudgets on a 60s interval (covers usage recorded outside the
//     gateway path, failed stops, and manual restarts while still over cap —
//     the status reconciler flips stopped->running whenever the container is
//     live, so re-enforcement is what makes the pause stick).
//
// Alert events (agent.budget_soft_exceeded / agent.budget_exceeded) use
// last_alerted_pct for best-effort per-bucket suppression, like workspace budgets.
// Enforcement itself is NOT deduped: while over the hard cap and running,
// every check re-pauses.

const db = require("./db");
const metrics = require("./metrics");
const containerManager = require("./containerManager");
const monitoring = require("./monitoring");

const VALID_PERIODS = new Set(["daily", "weekly", "monthly"]);
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const PAUSED_REASON_BUDGET = "budget_exceeded";

// Budget normalization and persistence

function normalizePeriod(value) {
  const period = String(value || "monthly").trim();
  if (!VALID_PERIODS.has(period)) {
    const error = new Error(`period must be one of: ${[...VALID_PERIODS].join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return period;
}

function normalizeLimit(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    const error = new Error("limit_usd must be a positive number");
    error.statusCode = 400;
    throw error;
  }
  return Math.round(num * 100) / 100;
}

function normalizeThreshold(value) {
  if (value == null) return 80;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    const error = new Error("soft_threshold_pct must be between 0 and 100");
    error.statusCode = 400;
    throw error;
  }
  return Math.round(num);
}

function serializeBudget(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    period: row.period,
    limitUsd: Number(row.limit_usd),
    softThresholdPct: row.soft_threshold_pct,
    lastAlertedAt: row.last_alerted_at,
    lastAlertedPct: row.last_alerted_pct,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listBudgets(agentId, { dbClient = db } = {}) {
  const result = await dbClient.query(
    `SELECT id, agent_id, period, limit_usd, soft_threshold_pct,
            last_alerted_at, last_alerted_pct, created_at, updated_at
       FROM agent_budgets
      WHERE agent_id = $1
      ORDER BY period`,
    [agentId],
  );
  return result.rows.map(serializeBudget);
}

/**
 * Validate and upsert one budget for an agent and rolling spend window while
 * preserving the existing row's identity and alert state on update.
 *
 * @param {string} agentId - Agent that owns the budget.
 * @param {Object} [payload={}] - Requested limit, period, and soft threshold.
 * @param {Object} [options={}] - Optional database dependency override.
 * @returns {Promise<Object>} Persisted budget.
 */
async function upsertBudget(agentId, payload = {}, { dbClient = db } = {}) {
  const period = normalizePeriod(payload.period);
  const limitUsd = normalizeLimit(payload.limitUsd ?? payload.limit_usd);
  const softThresholdPct = normalizeThreshold(
    payload.softThresholdPct ?? payload.soft_threshold_pct,
  );

  const result = await dbClient.query(
    `INSERT INTO agent_budgets (agent_id, period, limit_usd, soft_threshold_pct)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, period) DO UPDATE
       SET limit_usd = EXCLUDED.limit_usd,
           soft_threshold_pct = EXCLUDED.soft_threshold_pct,
           updated_at = NOW()
     RETURNING id, agent_id, period, limit_usd, soft_threshold_pct,
               last_alerted_at, last_alerted_pct, created_at, updated_at`,
    [agentId, period, limitUsd, softThresholdPct],
  );
  return serializeBudget(result.rows[0]);
}

/**
 * Delete a budget only when it belongs to the requested agent.
 *
 * @param {string} budgetId - Budget to delete.
 * @param {string} agentId - Agent expected to own the budget.
 * @param {Object} [options={}] - Optional database dependency override.
 * @returns {Promise<boolean>} Whether a matching budget was deleted.
 */
async function deleteBudget(budgetId, agentId, { dbClient = db } = {}) {
  const result = await dbClient.query(
    "DELETE FROM agent_budgets WHERE id = $1 AND agent_id = $2 RETURNING id",
    [budgetId, agentId],
  );
  return Boolean(result.rows[0]);
}

/**
 * Best-effort persistence of the threshold percentage most recently reported.
 *
 * @param {string} budgetId - Budget whose alert state should be updated.
 * @param {number} pct - Percentage recorded for alert deduplication.
 * @param {Object} [options={}] - Optional database dependency override.
 * @returns {Promise<void>} Resolves even when the alert-state write fails.
 */
async function recordBudgetAlert(budgetId, pct, { dbClient = db } = {}) {
  await dbClient
    .query(
      `UPDATE agent_budgets
          SET last_alerted_at = NOW(),
              last_alerted_pct = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [budgetId, pct],
    )
    .catch((err) => console.error("Failed to record agent budget alert:", err.message));
}

// Spend evaluation and enforcement

function bucketFor(pct, softThresholdPct) {
  if (pct >= 100) return "hard";
  if (pct >= softThresholdPct) return "soft";
  return "none";
}

/**
 * Read each budget's matching rolling-window spend, floor its percentage, and
 * assign its current `none`, `soft`, or `hard` threshold bucket.
 *
 * @param {string} agentId - Agent whose budgets should be summarized.
 * @param {Object} [deps={}] - Optional database and cost-resolver dependencies.
 * @returns {Promise<Array>} Budgets enriched with their current spend state.
 */
async function listBudgetsWithSpend(agentId, deps = {}) {
  const { costResolver = metrics.getAgentCost } = deps;
  const budgets = await listBudgets(agentId, deps);
  const out = [];
  for (const budget of budgets) {
    const cost = await costResolver(agentId, { periodDays: PERIOD_DAYS[budget.period] });
    const currentUsd = Number(cost?.total_cost || 0);
    const pct = budget.limitUsd > 0 ? Math.floor((currentUsd / budget.limitUsd) * 100) : 0;
    out.push({ ...budget, currentUsd, pct, bucket: bucketFor(pct, budget.softThresholdPct) });
  }
  return out;
}

/**
 * Evaluate every budget for an agent, best-effort suppress repeated alerts
 * using persisted bucket state, and re-enforce hard caps while the runtime is live.
 *
 * @param {Object} agent - Agent whose spend and runtime state should be checked.
 * @param {Object} [deps={}] - Optional database, cost, logging, and runtime dependencies.
 * @returns {Promise<Object>} Enforcement result and all crossed budgets.
 */
async function checkAndEnforce(agent, deps = {}) {
  const {
    dbClient = db,
    costResolver = metrics.getAgentCost,
    logEvent = (type, message, metadata) => monitoring.logEvent(type, message, metadata),
  } = deps;

  if (!agent?.id) return { enforced: false, crossings: [] };

  const budgets = await listBudgets(agent.id, { dbClient });
  if (budgets.length === 0) return { enforced: false, crossings: [] };

  const crossings = [];
  let enforced = false;

  for (const budget of budgets) {
    const cost = await costResolver(agent.id, { periodDays: PERIOD_DAYS[budget.period] });
    const currentUsd = Number(cost?.total_cost || 0);
    const pct = budget.limitUsd > 0 ? Math.floor((currentUsd / budget.limitUsd) * 100) : 0;
    const bucket = bucketFor(pct, budget.softThresholdPct);
    if (bucket === "none") continue;
    crossings.push({ budget, bucket, currentUsd, pct });

    const lastBucket =
      budget.lastAlertedPct == null
        ? "none"
        : budget.lastAlertedPct >= 100
          ? "hard"
          : budget.lastAlertedPct >= budget.softThresholdPct
            ? "soft"
            : "none";
    const shouldAlert = bucket === "hard" ? lastBucket !== "hard" : lastBucket === "none";

    if (shouldAlert) {
      const type = bucket === "hard" ? "agent.budget_exceeded" : "agent.budget_soft_exceeded";
      const message =
        bucket === "hard"
          ? `Agent "${agent.name || agent.id}" exceeded its ${budget.period} budget ($${currentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)})`
          : `Agent "${agent.name || agent.id}" reached ${pct}% of its ${budget.period} budget ($${currentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)})`;
      await Promise.resolve(
        logEvent(type, message, {
          agentId: agent.id,
          budgetId: budget.id,
          period: budget.period,
          limitUsd: budget.limitUsd,
          currentUsd,
          pct,
        }),
      ).catch(() => {});
      await recordBudgetAlert(budget.id, pct, { dbClient });
    }

    if (bucket === "hard" && !enforced) {
      enforced = await enforcePause(agent, { budget, currentUsd, pct }, deps);
    }
  }

  return { enforced, crossings };
}

/**
 * Pause a live runtime for a hard crossing, recording pause intent before the
 * stop so a failed attempt can be retried by the next sweep.
 *
 * @param {Object} agent - Running or warning agent to pause.
 * @param {Object} crossing - Hard-cap budget and spend details.
 * @param {Object} [deps={}] - Optional database, logging, and runtime dependencies.
 * @returns {Promise<boolean>} Whether the runtime was stopped and marked stopped.
 */
async function enforcePause(agent, crossing, deps = {}) {
  const {
    dbClient = db,
    stopRuntime = (target) => containerManager.stop(target),
    logEvent = (type, message, metadata) => monitoring.logEvent(type, message, metadata),
  } = deps;

  if (!["running", "warning"].includes(agent.status)) return false;

  await dbClient.query("UPDATE agents SET paused_reason = $1 WHERE id = $2", [
    PAUSED_REASON_BUDGET,
    agent.id,
  ]);

  try {
    await stopRuntime(agent);
  } catch (err) {
    await Promise.resolve(
      logEvent(
        "agent.budget_pause_failed",
        `Failed to stop agent "${agent.name || agent.id}" after budget hard cap: ${err.message}`,
        { agentId: agent.id, budgetId: crossing.budget.id, error: err.message },
      ),
    ).catch(() => {});
    return false;
  }

  await dbClient.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [agent.id]);
  await Promise.resolve(
    logEvent(
      "agent.budget_paused",
      `Agent "${agent.name || agent.id}" was paused: ${crossing.budget.period} budget hard cap reached ($${crossing.currentUsd.toFixed(2)} of $${crossing.budget.limitUsd.toFixed(2)})`,
      {
        agentId: agent.id,
        budgetId: crossing.budget.id,
        period: crossing.budget.period,
        limitUsd: crossing.budget.limitUsd,
        currentUsd: crossing.currentUsd,
        pct: crossing.pct,
      },
    ),
  ).catch(() => {});
  return true;
}

/**
 * Best-effort removal of an agent's current pause marker.
 * A later budget sweep may pause the agent again if it remains over budget.
 *
 * @param {string} agentId - Agent whose pause marker should be cleared.
 * @param {Object} [options={}] - Optional database dependency override.
 * @returns {Promise<void>} Resolves even when the database write fails.
 */
async function clearPausedReason(agentId, { dbClient = db } = {}) {
  await dbClient
    .query("UPDATE agents SET paused_reason = NULL WHERE id = $1 AND paused_reason IS NOT NULL", [
      agentId,
    ])
    .catch(() => {});
}

/**
 * Best-effort sweep that rechecks every budgeted agent with a live-like status.
 * Per-agent and sweep-level failures are isolated so later agents remain eligible.
 *
 * @param {Object} [deps={}] - Optional dependencies forwarded to budget enforcement.
 * @returns {Promise<void>} Always resolves after the best-effort sweep ends.
 */
async function sweepAgentBudgets(deps = {}) {
  const { dbClient = db } = deps;
  try {
    const result = await dbClient.query(
      `SELECT DISTINCT a.id, a.name, a.status, a.user_id, a.container_id, a.backend_type,
              a.runtime_family, a.deploy_target, a.execution_target_id, a.sandbox_profile,
              a.host, a.runtime_host, a.runtime_port, a.gateway_host, a.gateway_port
         FROM agents a
         JOIN agent_budgets b ON b.agent_id = a.id
        WHERE a.status IN ('running', 'warning')`,
    );
    for (const agent of result.rows) {
      try {
        await checkAndEnforce(agent, deps);
      } catch {
        // Per-agent failures must not stop the sweep.
      }
    }
  } catch {
    // Budget sweeping is best-effort only.
  }
}

module.exports = {
  PAUSED_REASON_BUDGET,
  PERIOD_DAYS,
  VALID_PERIODS,
  checkAndEnforce,
  clearPausedReason,
  deleteBudget,
  listBudgets,
  listBudgetsWithSpend,
  recordBudgetAlert,
  serializeBudget,
  sweepAgentBudgets,
  upsertBudget,
};
