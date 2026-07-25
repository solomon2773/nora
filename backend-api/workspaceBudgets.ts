// @ts-nocheck
// Workspace usage budgets. When a check sees that current spend has crossed
// the soft threshold (default 80%) or 100% of the limit, it returns a crossing
// for the caller to emit as a workspace budget event.
//
// Repeat alerts are suppressed from persisted last_alerted_pct: an alert at
// 80% won't re-fire at 81%, only when the bucket advances from soft to hard.

const db = require("./db");

const VALID_PERIODS = new Set(["daily", "weekly", "monthly"]);

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
    workspaceId: row.workspace_id,
    period: row.period,
    limitUsd: Number(row.limit_usd),
    softThresholdPct: row.soft_threshold_pct,
    lastAlertedAt: row.last_alerted_at,
    lastAlertedPct: row.last_alerted_pct,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listBudgets(workspaceId) {
  const result = await db.query(
    `SELECT id, workspace_id, period, limit_usd, soft_threshold_pct,
            last_alerted_at, last_alerted_pct, created_at, updated_at
       FROM workspace_budgets
      WHERE workspace_id = $1
      ORDER BY period`,
    [workspaceId],
  );
  return result.rows.map(serializeBudget);
}

/**
 * Validate and upsert one workspace budget for the requested rolling spend window.
 *
 * @param {string} workspaceId - Workspace that owns the budget.
 * @param {Object} [payload={}] - Period, limit, and soft-threshold values.
 * @returns {Promise<Object>} Persisted budget.
 */
async function upsertBudget(workspaceId, payload = {}) {
  const period = normalizePeriod(payload.period);
  const limitUsd = normalizeLimit(payload.limitUsd ?? payload.limit_usd);
  const softThresholdPct = normalizeThreshold(
    payload.softThresholdPct ?? payload.soft_threshold_pct,
  );

  const result = await db.query(
    `INSERT INTO workspace_budgets (workspace_id, period, limit_usd, soft_threshold_pct)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, period) DO UPDATE
       SET limit_usd = EXCLUDED.limit_usd,
           soft_threshold_pct = EXCLUDED.soft_threshold_pct,
           updated_at = NOW()
     RETURNING id, workspace_id, period, limit_usd, soft_threshold_pct,
               last_alerted_at, last_alerted_pct, created_at, updated_at`,
    [workspaceId, period, limitUsd, softThresholdPct],
  );
  return serializeBudget(result.rows[0]);
}

/**
 * Delete a budget only when it belongs to the requested workspace.
 *
 * @param {string} budgetId - Budget to delete.
 * @param {string} workspaceId - Workspace that must own the budget.
 * @returns {Promise<boolean>} Whether a budget was deleted.
 */
async function deleteBudget(budgetId, workspaceId) {
  const result = await db.query(
    "DELETE FROM workspace_budgets WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [budgetId, workspaceId],
  );
  return Boolean(result.rows[0]);
}

const BUDGET_PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };

// Spend evaluation and alert state

/**
 * Return newly alertable soft or hard crossings using each budget's own
 * rolling 1-, 7-, or 30-day spend rather than the viewer-selected cost window.
 *
 * @param {string} workspaceId - Workspace whose budgets should be evaluated.
 * @param {number} _ignoredViewerWindowUsd - Legacy viewer-window value, intentionally ignored.
 * @param {Object} [deps={}] - Optional cost resolver dependency.
 * @returns {Promise<Array>} Crossings not already covered by persisted alert state.
 */
async function evaluateBudgetCrossings(workspaceId, _ignoredViewerWindowUsd, deps = {}) {
  const { costResolver = require("./metrics").getWorkspaceCost } = deps;
  const budgets = await listBudgets(workspaceId);
  const crossings = [];
  const spendByPeriod = new Map();
  for (const budget of budgets) {
    const periodDays = BUDGET_PERIOD_DAYS[budget.period] || 30;
    if (!spendByPeriod.has(periodDays)) {
      const cost = await costResolver(workspaceId, { periodDays });
      spendByPeriod.set(periodDays, Number(cost?.totalUsd ?? cost?.total_cost ?? 0));
    }
    const currentUsd = spendByPeriod.get(periodDays);
    const pct = budget.limitUsd > 0 ? Math.floor((currentUsd / budget.limitUsd) * 100) : 0;
    let bucket = "none";
    if (pct >= 100) bucket = "hard";
    else if (pct >= budget.softThresholdPct) bucket = "soft";
    if (bucket === "none") continue;

    // Skip if we already alerted for this bucket (or higher).
    const lastBucket =
      budget.lastAlertedPct == null
        ? "none"
        : budget.lastAlertedPct >= 100
          ? "hard"
          : budget.lastAlertedPct >= budget.softThresholdPct
            ? "soft"
            : "none";
    if (lastBucket === "hard") continue;
    if (lastBucket === "soft" && bucket === "soft") continue;

    crossings.push({ budget, bucket, currentUsd, pct });
  }
  return crossings;
}

/**
 * Best-effort persistence of the percentage most recently reported for a budget.
 *
 * @param {string} budgetId - Budget whose alert state should be updated.
 * @param {number} pct - Percentage used for later bucket suppression.
 * @returns {Promise<void>} Resolves even when the write fails.
 */
async function recordBudgetAlert(budgetId, pct) {
  await db
    .query(
      `UPDATE workspace_budgets
          SET last_alerted_at = NOW(),
              last_alerted_pct = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [budgetId, pct],
    )
    .catch((err) => console.error("Failed to record budget alert:", err.message));
}

module.exports = {
  VALID_PERIODS,
  deleteBudget,
  evaluateBudgetCrossings,
  listBudgets,
  recordBudgetAlert,
  serializeBudget,
  upsertBudget,
};
