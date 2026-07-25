// @ts-nocheck
// `nora doctor` — a control-plane self-check the operator can run from the CLI
// (GET /admin/doctor) or read in the admin Health panel. Each check is
// independent and best-effort: a thrown check degrades to a "fail" entry rather
// than taking the whole report down, and the overall status is the worst of the
// individual checks.
//
// Scope note: these checks read only state the control plane already owns (DB,
// queue, registered Kubernetes targets, process secrets, and the agents table).
// Per-agent OpenClaw runtime posture probes are intentionally NOT here yet —
// they need live gateway probing that must be designed against a real runtime
// first (tracked as a follow-up), and shipping speculative checks would
// over-promise.

const db = require("./db");
const { deployQueue, getDLQJobs } = require("./redisQueue");
const kubernetesClusters = require("./kubernetesClusters");
const fleetStatus = require("./fleetStatus");
// Secret posture rules are centralized in lib/secretValidation so the boot-time
// fail-closed checks in server.ts and this report agree on what "weak" means.
const { validateRequiredSecrets } = require("./lib/secretValidation");

const STATUS_RANK = { ok: 0, warn: 1, fail: 2 };
const CACHE_TTL_MS = 30 * 1000;

function worst(statuses) {
  return statuses.reduce((acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc), "ok");
}

async function checkDatabase(dbClient) {
  try {
    await dbClient.query("SELECT 1");
    return { id: "database", label: "Database", status: "ok", detail: "Reachable" };
  } catch (err) {
    return { id: "database", label: "Database", status: "fail", detail: err.message };
  }
}

async function checkQueue(queue, dlqJobs) {
  try {
    const counts = await queue.getJobCounts("waiting", "active", "completed", "failed");
    let failedCount = 0;
    try {
      failedCount = (await dlqJobs()).length;
    } catch {
      // DLQ read is best-effort; getJobCounts already proved the queue is up.
    }
    const status = failedCount > 0 ? "warn" : "ok";
    return {
      id: "queue",
      label: "Provisioning queue",
      status,
      detail:
        failedCount > 0
          ? `${failedCount} job(s) in the dead-letter queue`
          : `waiting ${counts.waiting || 0}, active ${counts.active || 0}`,
      counts,
      deadLettered: failedCount,
    };
  } catch (err) {
    return {
      id: "queue",
      label: "Provisioning queue",
      status: "fail",
      detail: `Redis/queue unreachable: ${err.message}`,
    };
  }
}

async function checkKubernetesTargets(listTargets) {
  try {
    const clusters = await listTargets();
    if (!clusters || clusters.length === 0) {
      return {
        id: "kubernetes",
        label: "Kubernetes targets",
        status: "ok",
        detail: "No Kubernetes execution targets registered",
      };
    }
    const untested = clusters.filter((c) => c.lastTestStatus !== "ok");
    if (untested.length > 0) {
      return {
        id: "kubernetes",
        label: "Kubernetes targets",
        status: "warn",
        detail: `${untested.length} of ${clusters.length} target(s) have not passed a connection test`,
        targets: untested.map((c) => ({
          id: c.id,
          label: c.label,
          lastTestStatus: c.lastTestStatus || null,
          lastTestMessage: c.lastTestMessage || null,
        })),
      };
    }
    return {
      id: "kubernetes",
      label: "Kubernetes targets",
      status: "ok",
      detail: `${clusters.length} target(s), all connection-tested`,
    };
  } catch (err) {
    return {
      id: "kubernetes",
      label: "Kubernetes targets",
      status: "fail",
      detail: err.message,
    };
  }
}

function checkSecrets(env) {
  const problems = validateRequiredSecrets(env).map((p) => ({
    env: p.env,
    severity: p.severity,
    issue: p.issues.join(", "),
  }));
  const status = worst(["ok", ...problems.map((p) => p.severity)]);
  return {
    id: "secrets",
    label: "Secret posture",
    status,
    detail:
      problems.length === 0
        ? "All required secrets present and non-placeholder"
        : problems.map((p) => `${p.env} ${p.issue}`).join("; "),
    problems,
  };
}

// Fleet-wide attention roll-up (admin view — every agent, not user-scoped),
// reusing the pure deriveAttention from fleetStatus so doctor and the dashboard
// strip agree on what "needs attention" means.
async function checkFleet(dbClient, now) {
  try {
    const result = await dbClient.query(
      `SELECT a.id, a.name, a.status, a.paused_reason,
              dep.created_at AS entered_deploy_at,
              st.recorded_at AS last_stat_at,
              COALESCE(bud.soft_crossed, false) AS budget_soft_crossed
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT created_at FROM deployments d
            WHERE d.agent_id = a.id ORDER BY d.created_at DESC LIMIT 1
         ) dep ON true
         LEFT JOIN LATERAL (
           SELECT recorded_at FROM container_stats s
            WHERE s.agent_id = a.id ORDER BY s.recorded_at DESC LIMIT 1
         ) st ON true
         LEFT JOIN LATERAL (
           SELECT bool_or(b.last_alerted_pct >= b.soft_threshold_pct AND b.last_alerted_pct < 100)
                    AS soft_crossed
             FROM agent_budgets b WHERE b.agent_id = a.id
         ) bud ON true`,
    );
    const toMs = (value) => (value == null ? null : new Date(value).getTime());
    const items = result.rows.map((row) =>
      fleetStatus.deriveAttention(row, {
        now,
        enteredDeployAt: toMs(row.entered_deploy_at),
        lastStatAt: toMs(row.last_stat_at),
        budgetSoftCrossed: row.budget_soft_crossed === true,
      }),
    );
    const attention = items.filter((i) => i.needsAttention);
    const byCode = {};
    for (const item of attention) {
      for (const reason of item.reasons) byCode[reason.code] = (byCode[reason.code] || 0) + 1;
    }
    const status = attention.some((i) => i.severity === "error")
      ? "fail"
      : attention.length > 0
        ? "warn"
        : "ok";
    return {
      id: "fleet",
      label: "Fleet health",
      status,
      detail:
        attention.length === 0
          ? `${items.length} agent(s), none need attention`
          : `${attention.length} of ${items.length} agent(s) need attention`,
      total: items.length,
      attentionCount: attention.length,
      reasons: byCode,
    };
  } catch (err) {
    return { id: "fleet", label: "Fleet health", status: "fail", detail: err.message };
  }
}

// Count agents whose runtime gateway is published to a host port — a posture
// signal (host-exposed gateways) worth surfacing, not necessarily a problem.
async function checkGatewayExposure(dbClient) {
  try {
    const result = await dbClient.query(
      "SELECT count(*)::int AS exposed FROM agents WHERE gateway_host_port IS NOT NULL",
    );
    const exposed = result.rows[0]?.exposed || 0;
    return {
      id: "gateway_exposure",
      label: "Gateway exposure",
      status: "ok",
      detail:
        exposed === 0
          ? "No agent gateways are published to a host port"
          : `${exposed} agent gateway(s) published to a host port — ensure they are firewalled`,
      exposed,
    };
  } catch (err) {
    return {
      id: "gateway_exposure",
      label: "Gateway exposure",
      status: "fail",
      detail: err.message,
    };
  }
}

/**
 * Run independent control-plane health checks in parallel and reduce them to
 * the worst overall status without allowing one check to abort the report.
 *
 * @param {Object} [deps={}] - Injectable database, queue, cluster, environment, and clock.
 * @returns {Promise<Object>} Timestamped doctor report and individual checks.
 */
async function runDoctor(deps = {}) {
  const {
    dbClient = db,
    queue = deployQueue,
    dlqJobs = getDLQJobs,
    listKubernetesTargets = kubernetesClusters.listKubernetesExecutionTargets,
    env = process.env,
    now = Date.now(),
  } = deps;

  const checks = await Promise.all([
    checkDatabase(dbClient),
    checkQueue(queue, dlqJobs),
    checkKubernetesTargets(listKubernetesTargets),
    Promise.resolve(checkSecrets(env)),
    checkFleet(dbClient, now),
    checkGatewayExposure(dbClient),
  ]);

  return {
    generatedAt: new Date(now).toISOString(),
    overall: worst(checks.map((c) => c.status)),
    checks,
  };
}

// Small TTL cache so a CLI loop / panel refresh doesn't hammer the queue + DB.
let cached = null;
/**
 * Return a briefly cached doctor report unless a fresh run is requested.
 *
 * @param {Object} [options={}] - Whether to bypass the report cache.
 * @param {Object} [deps={}] - Dependencies forwarded to the doctor checks.
 * @returns {Promise<Object>} Cached or newly generated doctor report.
 */
async function getDoctorReport({ fresh = false } = {}, deps = {}) {
  const at = deps.now || Date.now();
  if (!fresh && cached && at - cached.at < CACHE_TTL_MS) return cached.report;
  const report = await runDoctor(deps);
  cached = { at, report };
  return report;
}

function _resetCacheForTests() {
  cached = null;
}

module.exports = {
  runDoctor,
  getDoctorReport,
  checkSecrets,
  _resetCacheForTests,
};
