// @ts-nocheck
// Executes one scheduled agent run (enqueued by the agentSchedules sweep onto
// the agent-schedules BullMQ queue). Lives in backend-api so it has local access
// to the gateway RPC, containerManager, metrics, and monitoring; the provisioner
// worker's queue handler calls runScheduledAction (same cross-package pattern as
// alert-deliveries -> backend-api/alertRules).

const { randomUUID } = require("crypto");
const db = require("./db");
const monitoring = require("./monitoring");
const metrics = require("./metrics");
const agentSchedules = require("./agentSchedules");
const containerManager = require("./containerManager");
const { addDeploymentJob } = require("./redisQueue");
const {
  rpcCall,
  resolveGatewayHostForProxy,
  allowedGatewayHostsForAgent,
} = require("./gatewayProxy");
const { runtimeAuthHeaders } = require("./runtimeAuth");
const { resolveAgentRuntimeFamily } = require("./agentRuntimeFields");

// Lifecycle actions that bring an agent UP — must not resurrect a budget-paused
// agent (the budget sweep would just re-pause it; a schedule shouldn't fight it).
const REVIVE_ACTIONS = new Set(["start", "restart", "redeploy"]);

const CHAT_TIMEOUT_MS = 240000;

async function loadAgent(agentId) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
  return result.rows[0] || null;
}

async function deliverPrompt(agent, prompt, userId) {
  const text = String(prompt || "").trim();
  if (!text) throw new Error("Schedule has no prompt to deliver");
  const family = resolveAgentRuntimeFamily(agent);
  const startedAtMs = Date.now();

  if (family === "hermes") {
    const host = agent.runtime_host;
    const port = agent.runtime_port;
    if (!host || !port) throw new Error("Hermes runtime endpoint unavailable");
    // SSRF-safe: validate + DNS-pin the runtime host through the same floor +
    // per-agent allowlist the gateway proxy uses (the OpenClaw path gets this
    // for free via rpcCall; the raw Hermes fetch must do it explicitly).
    const allowed = await allowedGatewayHostsForAgent(agent);
    const safeHost = await resolveGatewayHostForProxy(host, "hermes runtime", allowed);
    const url = `http://${safeHost}:${port}/v1/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: text }] }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Hermes chat returned ${resp.status}`);
    // Token usage flows to budgets + OTel exactly like an interactive chat.
    await metrics
      .recordTokenUsage?.(agent, userId || agent.user_id, data, {
        runtimeFamily: "hermes",
        source: "schedule",
        startedAtMs,
      })
      .catch(() => {});
    return;
  }

  // OpenClaw: deliver over the gateway WS-RPC (same call the chat route uses).
  const result = await rpcCall(
    agent,
    "chat.send",
    { sessionKey: "schedule", idempotencyKey: randomUUID(), message: text },
    CHAT_TIMEOUT_MS,
  );
  await metrics
    .recordTokenUsage?.(agent, userId || agent.user_id, result, {
      source: "schedule.openclaw",
      sessionId: "schedule",
      startedAtMs,
    })
    .catch(() => {});
}

async function performAction(agent, actionType, prompt, userId) {
  switch (actionType) {
    case "prompt":
      return deliverPrompt(agent, prompt, userId);
    case "restart":
      return containerManager.restart(agent);
    case "stop":
      return containerManager.stop(agent);
    case "start":
      return containerManager.start(agent);
    case "redeploy":
      return addDeploymentJob(agent);
    default:
      throw new Error(`Unknown schedule action: ${actionType}`);
  }
}

/**
 * Run one scheduled action. Records the outcome on the schedule (markRun) and as
 * an agent.schedule.run event (audit + alert rules). Throws on failure so BullMQ
 * applies its bounded retry; a permanently-missing agent is recorded, not thrown
 * (retrying can't fix it).
 */
async function runScheduledAction(payload = {}) {
  const { scheduleId, agentId, actionType, prompt, createdBy, name } = payload;
  if (!scheduleId || !agentId || !actionType) {
    throw new Error("runScheduledAction requires scheduleId, agentId, actionType");
  }

  const agent = await loadAgent(agentId);
  if (!agent) {
    await agentSchedules.markRun(scheduleId, "agent_missing").catch(() => {});
    return { ok: false, status: "agent_missing" };
  }

  const eventMeta = (ok, detail) => ({
    result: {
      scheduleId,
      agentId,
      action: actionType,
      name: name || null,
      ok,
      detail: detail || null,
    },
    agent: { id: agent.id, name: agent.name, ownerUserId: agent.user_id },
  });

  // Don't let a schedule revive a budget-paused agent — the budget sweep would
  // immediately re-pause it, and a scheduled prompt shouldn't run up a capped bill.
  if (agent.paused_reason && (REVIVE_ACTIONS.has(actionType) || actionType === "prompt")) {
    await agentSchedules.markRun(scheduleId, `skipped: ${agent.paused_reason}`).catch(() => {});
    await monitoring
      .logEvent(
        "agent.schedule.run",
        `Scheduled ${actionType} on "${agent.name}" skipped (${agent.paused_reason})`,
        eventMeta(false, `skipped: ${agent.paused_reason}`),
      )
      .catch(() => {});
    return { ok: false, status: `skipped: ${agent.paused_reason}` };
  }

  try {
    await performAction(agent, actionType, prompt, createdBy);
  } catch (err) {
    const status = `failed: ${err?.message || err}`.slice(0, 180);
    await agentSchedules.markRun(scheduleId, status).catch(() => {});
    await monitoring
      .logEvent(
        "agent.schedule.run",
        `Scheduled ${actionType} on "${agent.name}" failed`,
        eventMeta(false, status),
      )
      .catch(() => {});
    throw err; // surface to BullMQ for bounded retry
  }

  await agentSchedules.markRun(scheduleId, "success").catch(() => {});
  await monitoring
    .logEvent(
      "agent.schedule.run",
      `Scheduled ${actionType} ran on "${agent.name}"`,
      eventMeta(true),
    )
    .catch(() => {});
  return { ok: true, status: "success" };
}

module.exports = { runScheduledAction, deliverPrompt };
