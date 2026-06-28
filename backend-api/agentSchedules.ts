// @ts-nocheck
// Control-plane scheduled agent runs (recurring cron triggers).
//
// This module owns the schedule MODEL (CRUD), cron validation, next-fire
// computation, and the replica-safe SWEEP that claims due schedules and hands
// each run to an enqueue callback (the agent-schedules BullMQ queue). The actual
// action (prompt / lifecycle) is executed by the worker — see the queue handler.
//
// NOT to be confused with scheduler.ts (the node bin-packer) or the Hermes
// runtime's own /api/jobs cron — this is Nora-control-plane scheduling.

const { CronExpressionParser } = require("cron-parser");
const db = require("./db");

const ACTION_TYPES = Object.freeze(["prompt", "restart", "stop", "start", "redeploy"]);
const PROMPT_MAX = 8000;
const NAME_MAX = 120;
// A too-frequent cron can thrash an agent (and its budget). Floor the fire
// interval; overridable for ops that genuinely need tighter cadences.
const MIN_INTERVAL_SECONDS = (() => {
  const n = Number.parseInt(process.env.NORA_SCHEDULE_MIN_INTERVAL_SECONDS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 60;
})();

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Next fire after `fromDate` for a cron in a timezone. Throws on a bad cron. */
function computeNextRun(cron, timezone = "UTC", fromDate = new Date()) {
  const it = CronExpressionParser.parse(String(cron), {
    tz: timezone || "UTC",
    currentDate: fromDate,
  });
  return it.next().toDate();
}

/** Validate the cron parses and doesn't fire more often than the min interval. */
function validateCron(cron, timezone = "UTC") {
  let it;
  try {
    it = CronExpressionParser.parse(String(cron), { tz: timezone || "UTC" });
  } catch (e) {
    throw httpError(`Invalid cron expression: ${e.message}`, 400);
  }
  const a = it.next().toDate();
  const b = it.next().toDate();
  if ((b.getTime() - a.getTime()) / 1000 < MIN_INTERVAL_SECONDS) {
    throw httpError(
      `Schedule fires too frequently — minimum interval is ${MIN_INTERVAL_SECONDS}s`,
      400,
    );
  }
}

function normalizeInput(input = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has("name") || !partial) {
    const name = String(input.name || "").trim();
    if (!name) throw httpError("Schedule name is required", 400);
    if (name.length > NAME_MAX) throw httpError(`Name must be <= ${NAME_MAX} chars`, 400);
    out.name = name;
  }
  if (has("timezone") || !partial) {
    out.timezone = String(input.timezone || "UTC").trim() || "UTC";
  }
  if (has("action_type") || has("actionType") || !partial) {
    const action = String(input.action_type || input.actionType || "prompt").trim();
    if (!ACTION_TYPES.includes(action)) {
      throw httpError(`action_type must be one of: ${ACTION_TYPES.join(", ")}`, 400);
    }
    out.action_type = action;
  }
  if (has("prompt")) {
    const prompt = input.prompt == null ? null : String(input.prompt);
    if (prompt && prompt.length > PROMPT_MAX) {
      throw httpError(`prompt must be <= ${PROMPT_MAX} chars`, 400);
    }
    out.prompt = prompt;
  }
  if (has("enabled")) out.enabled = Boolean(input.enabled);
  if (has("cron") || !partial) {
    const cron = String(input.cron || "").trim();
    if (!cron) throw httpError("cron expression is required", 400);
    out.cron = cron;
  }

  // A 'prompt' action requires prompt text; lifecycle actions ignore it.
  const effectiveAction = out.action_type;
  if (effectiveAction === "prompt") {
    if ((has("prompt") || !partial) && !String(out.prompt || "").trim()) {
      throw httpError("A prompt is required for the 'prompt' action", 400);
    }
  }
  return out;
}

function serializeSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agent_id,
    created_by: row.created_by,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    action_type: row.action_type,
    prompt: row.prompt,
    enabled: row.enabled,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listSchedules(agentId) {
  const result = await db.query(
    "SELECT * FROM agent_schedules WHERE agent_id = $1 ORDER BY created_at",
    [agentId],
  );
  return result.rows.map(serializeSchedule);
}

async function getSchedule(agentId, scheduleId) {
  const result = await db.query("SELECT * FROM agent_schedules WHERE id = $1 AND agent_id = $2", [
    scheduleId,
    agentId,
  ]);
  return serializeSchedule(result.rows[0]);
}

async function createSchedule(agentId, createdBy, input = {}) {
  const fields = normalizeInput(input, { partial: false });
  validateCron(fields.cron, fields.timezone);
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const nextRun = enabled ? computeNextRun(fields.cron, fields.timezone) : null;
  const result = await db.query(
    `INSERT INTO agent_schedules
       (agent_id, created_by, name, cron, timezone, action_type, prompt, enabled, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      agentId,
      createdBy || null,
      fields.name,
      fields.cron,
      fields.timezone,
      fields.action_type,
      fields.prompt ?? null,
      enabled,
      nextRun,
    ],
  );
  return serializeSchedule(result.rows[0]);
}

async function updateSchedule(agentId, scheduleId, input = {}) {
  const existing = await getSchedule(agentId, scheduleId);
  if (!existing) return null;
  const fields = normalizeInput({ action_type: existing.action_type, ...input }, { partial: true });

  const cron = fields.cron ?? existing.cron;
  const timezone = fields.timezone ?? existing.timezone;
  if (fields.cron || fields.timezone) validateCron(cron, timezone);

  const enabled = fields.enabled ?? existing.enabled;
  // Recompute the next fire when the schedule's timing or enabled state changes.
  const timingChanged =
    fields.cron !== undefined ||
    fields.timezone !== undefined ||
    (fields.enabled !== undefined && fields.enabled !== existing.enabled);
  const nextRun = !enabled ? null : timingChanged ? computeNextRun(cron, timezone) : undefined;

  const sets = [];
  const vals = [];
  let i = 1;
  const set = (col, val) => {
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  };
  if (fields.name !== undefined) set("name", fields.name);
  if (fields.cron !== undefined) set("cron", fields.cron);
  if (fields.timezone !== undefined) set("timezone", fields.timezone);
  if (fields.action_type !== undefined) set("action_type", fields.action_type);
  if (fields.prompt !== undefined) set("prompt", fields.prompt);
  if (fields.enabled !== undefined) set("enabled", fields.enabled);
  if (nextRun !== undefined) set("next_run_at", nextRun);
  set("updated_at", new Date());

  vals.push(scheduleId, agentId);
  const result = await db.query(
    `UPDATE agent_schedules SET ${sets.join(", ")} WHERE id = $${i++} AND agent_id = $${i} RETURNING *`,
    vals,
  );
  return serializeSchedule(result.rows[0]);
}

async function deleteSchedule(agentId, scheduleId) {
  const result = await db.query(
    "DELETE FROM agent_schedules WHERE id = $1 AND agent_id = $2 RETURNING id",
    [scheduleId, agentId],
  );
  return result.rows.length > 0;
}

/** Record the outcome of a run (called by the worker after executing). */
async function markRun(scheduleId, status) {
  await db.query(
    "UPDATE agent_schedules SET last_run_at = NOW(), last_status = $2, updated_at = NOW() WHERE id = $1",
    [scheduleId, String(status || "").slice(0, 200)],
  );
}

/**
 * Claim due schedules and enqueue each run. Replica-safe: rows are claimed with
 * FOR UPDATE SKIP LOCKED inside a transaction and their next_run_at is bumped
 * before commit, so concurrent sweepers never double-fire. Enqueue happens AFTER
 * commit so a rollback can't leave an orphaned job. Returns the number enqueued.
 */
async function sweepDueSchedules({
  dbClient = db,
  enqueue,
  batchSize = 50,
  now = new Date(),
} = {}) {
  if (typeof enqueue !== "function") throw new Error("sweepDueSchedules requires an enqueue fn");
  const client = await dbClient.connect();
  const claimed = [];
  try {
    await client.query("BEGIN");
    const due = await client.query(
      `SELECT * FROM agent_schedules
        WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= $1
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [now, batchSize],
    );
    for (const row of due.rows) {
      let next;
      try {
        next = computeNextRun(row.cron, row.timezone, now);
      } catch {
        // A row with a now-invalid cron: disable it rather than spin forever.
        await client.query(
          "UPDATE agent_schedules SET enabled = FALSE, last_status = 'invalid_cron', updated_at = NOW() WHERE id = $1",
          [row.id],
        );
        continue;
      }
      await client.query(
        "UPDATE agent_schedules SET next_run_at = $2, updated_at = NOW() WHERE id = $1",
        [row.id, next],
      );
      claimed.push(row);
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }

  let enqueued = 0;
  for (const row of claimed) {
    try {
      await enqueue({
        scheduleId: row.id,
        agentId: row.agent_id,
        actionType: row.action_type,
        prompt: row.prompt,
        createdBy: row.created_by,
        name: row.name,
      });
      enqueued += 1;
    } catch (err) {
      // The claim already bumped next_run_at to the NEXT cron fire. If the
      // enqueue fails (e.g. Redis blip), don't silently skip until then — pull
      // next_run_at back to ~now so the next sweep re-claims and retries it.
      await db
        .query(
          "UPDATE agent_schedules SET next_run_at = NOW(), last_status = $2, updated_at = NOW() WHERE id = $1",
          [row.id, `enqueue_failed: ${err?.message || err}`.slice(0, 200)],
        )
        .catch(() => {});
    }
  }
  return enqueued;
}

module.exports = {
  ACTION_TYPES,
  MIN_INTERVAL_SECONDS,
  computeNextRun,
  validateCron,
  serializeSchedule,
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  markRun,
  sweepDueSchedules,
};
