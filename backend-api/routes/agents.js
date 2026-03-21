const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const scheduler = require("../scheduler");
const containerManager = require("../containerManager");
const monitoring = require("../monitoring");
const { asyncHandler } = require("../middleware/errorHandler");

const router = express.Router();

router.get("/", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(result.rows);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Agent not found" });

  const agent = result.rows[0];

  // Live status reconciliation — check actual container state
  if (agent.container_id && (agent.status === "running" || agent.status === "error" || agent.status === "stopped")) {
    try {
      const live = await containerManager.status(agent);
      const liveStatus = live.running ? "running" : "stopped";
      if (liveStatus !== agent.status && agent.status !== "queued" && agent.status !== "deploying") {
        await db.query("UPDATE agents SET status = $1 WHERE id = $2", [liveStatus, agent.id]);
        agent.status = liveStatus;
      }
    } catch {
      // Can't reach container runtime — leave DB status as-is
    }
  }

  res.json(agent);
}));

router.post("/deploy", async (req, res) => {
  try {
    // Enforce billing limits
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed) return res.status(402).json({ error: limits.error, subscription: limits.subscription });

    const sub = limits.subscription;
    const node = await scheduler.selectNode();
    const rawName = typeof req.body.name === "string" ? req.body.name : "";
    // Strip control characters (newlines, tabs, etc.) to prevent log injection
    const name = (rawName.replace(/[\x00-\x1f\x7f]/g, "") || "OpenClaw-Agent-" + Math.floor(Math.random() * 1000)).trim();
    if (name.length > 100) return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    const containerNameRaw = (req.body.container_name || "").trim();
    const containerName = containerNameRaw || `oclaw-agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
    const nodeName = node ? node.name : "worker-01";

    // NemoClaw sandbox support
    const sandbox = req.body.sandbox === "nemoclaw" ? "nemoclaw" : "standard";
    if (sandbox === "nemoclaw" && process.env.NEMOCLAW_ENABLED !== "true") {
      return res.status(400).json({ error: "NemoClaw is not enabled. Set NEMOCLAW_ENABLED=true in .env" });
    }

    // Resolve resource specs based on platform mode
    let specs;
    if (!billing.IS_PAAS) {
      // Self-hosted: accept user-chosen values clamped to operator limits
      const lim = billing.SELFHOSTED_LIMITS;
      specs = {
        vcpu:    Math.max(1, Math.min(parseInt(req.body.vcpu)    || 2,    lim.max_vcpu)),
        ram_mb:  Math.max(512, Math.min(parseInt(req.body.ram_mb)  || 2048, lim.max_ram_mb)),
        disk_gb: Math.max(1, Math.min(parseInt(req.body.disk_gb) || 20,   lim.max_disk_gb)),
      };
    } else {
      // PaaS: resources locked to subscription plan
      specs = { vcpu: sub.vcpu || 2, ram_mb: sub.ram_mb || 2048, disk_gb: sub.disk_gb || 20 };
    }

    const result = await db.query(
      "INSERT INTO agents(user_id, name, status, node, sandbox_type, vcpu, ram_mb, disk_gb, container_name) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8) RETURNING *",
      [req.user.id, name, nodeName, sandbox, specs.vcpu, specs.ram_mb, specs.disk_gb, containerName]
    );
    const agent = result.rows[0];

    await db.query(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      [agent.id]
    );

    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      plan: sub.plan,
      sandbox,
      specs,
      container_name: containerName,
    });

    const deployType = sandbox === "nemoclaw" ? "NemoClaw + OpenClaw" : "OpenClaw + Docker";
    await monitoring.logEvent("agent_deployed", `Agent "${name}" (${deployType}) queued for deployment`, { agentId: agent.id });

    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/start", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!agent.container_id) return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.start(agent);

    const updated = await db.query(
      "UPDATE agents SET status = 'running' WHERE id = $1 RETURNING *", [agent.id]
    );
    res.json(updated.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/stop", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (agent.container_id) {
      try {
        await containerManager.stop(agent);
      } catch (e) {
        if (!e.message.includes("already stopped") && !e.message.includes("not running")) {
          console.error("Container stop error:", e.message);
        }
      }
    }

    const updated = await db.query(
      "UPDATE agents SET status = 'stopped' WHERE id = $1 RETURNING *", [agent.id]
    );
    res.json(updated.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function destroyAgent(agentId, userId, res) {
  const result = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [agentId, userId]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  if (agent.container_id) {
    try {
      await containerManager.destroy(agent);
    } catch (e) {
      console.error("Container cleanup error:", e.message);
    }
  }

  await db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
  res.json({ success: true });
}

router.post("/:id/delete", async (req, res) => {
  try {
    await destroyAgent(req.params.id, req.user.id, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await destroyAgent(req.params.id, req.user.id, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/restart", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!agent.container_id) return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.restart(agent);

    await db.query("UPDATE agents SET status = 'running' WHERE id = $1", [agent.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/redeploy", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.status !== "error" && agent.status !== "stopped") {
      return res.status(400).json({ error: "Agent must be in error or stopped state to redeploy" });
    }

    await db.query(
      "UPDATE agents SET status = 'queued', container_id = NULL, host = NULL WHERE id = $1",
      [agent.id]
    );

    await db.query(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      [agent.id]
    );

    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      sandbox: agent.sandbox_type || "standard",
      specs: { vcpu: agent.vcpu || 2, ram_mb: agent.ram_mb || 2048, disk_gb: agent.disk_gb || 20 },
      container_name: agent.container_name,
    });

    await monitoring.logEvent("agent_redeployed", `Agent "${agent.name}" re-queued for deployment`, { agentId: agent.id });

    res.json({ success: true, status: "queued" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
