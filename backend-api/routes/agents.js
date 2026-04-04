const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const scheduler = require("../scheduler");
const containerManager = require("../containerManager");
const monitoring = require("../monitoring");
const { reconcileAgentStatus } = require("../agentStatus");
const { OPENCLAW_GATEWAY_PORT } = require("../../agent-runtime/lib/contracts");
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

  // Live status reconciliation — check actual container state while preserving
  // warning as a first-class degraded state until the container actually stops.
  if (agent.container_id && ["running", "warning", "error", "stopped"].includes(agent.status)) {
    try {
      const live = await containerManager.status(agent);
      const reconciledStatus = reconcileAgentStatus(agent.status, Boolean(live.running));
      if (reconciledStatus !== agent.status) {
        await db.query("UPDATE agents SET status = $1 WHERE id = $2", [reconciledStatus, agent.id]);
        agent.status = reconciledStatus;
      }
    } catch {
      // Can't reach container runtime — leave DB status as-is
    }
  }

  res.json(agent);
}));

// Historical container stats with time range
// Query params: ?range=5m|15m|1h|6h|24h (default 15m) or ?from=ISO&to=ISO
router.get("/:id/stats/history", asyncHandler(async (req, res) => {
  const agentCheck = await db.query(
    "SELECT id FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]
  );
  if (!agentCheck.rows[0]) return res.status(404).json({ error: "Agent not found" });

  const rangeMap = { "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "1 hour", "6h": "6 hours", "24h": "24 hours" };
  let fromTime, toTime;

  if (req.query.from && req.query.to) {
    fromTime = new Date(req.query.from);
    toTime = new Date(req.query.to);
  } else {
    const range = rangeMap[req.query.range || "15m"] || "15 minutes";
    toTime = new Date();
    fromTime = new Date(Date.now() - parseInterval(range));
  }

  const result = await db.query(
    `SELECT cpu_percent, memory_usage_mb, memory_limit_mb, memory_percent,
            network_rx_mb, network_tx_mb, disk_read_mb, disk_write_mb, pids, recorded_at
     FROM container_stats WHERE agent_id = $1 AND recorded_at BETWEEN $2 AND $3
     ORDER BY recorded_at ASC LIMIT 2000`,
    [req.params.id, fromTime, toTime]
  );
  res.json(result.rows);
}));

function parseInterval(pg) {
  const m = pg.match(/(\d+)\s*(minute|hour|second)/);
  if (!m) return 15 * 60 * 1000;
  const n = parseInt(m[1]);
  if (m[2] === "hour") return n * 3600000;
  if (m[2] === "minute") return n * 60000;
  return n * 1000;
}

// Get the gateway control UI URL (published host port for direct browser access)
router.get("/:id/gateway-url", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT id, container_id, gateway_token, gateway_host_port, user_id FROM agents WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (!agent.container_id) return res.status(409).json({ error: "No container" });

  // Use stored host port if available, otherwise fall back to Docker inspect
  let hostPort = agent.gateway_host_port;
  if (!hostPort) {
    try {
      const Docker = require("dockerode");
      const docker = new Docker({ socketPath: "/var/run/docker.sock" });
      const info = await docker.getContainer(agent.container_id).inspect();
      const portBindings = info.NetworkSettings?.Ports?.[`${OPENCLAW_GATEWAY_PORT}/tcp`];
      hostPort = portBindings?.[0]?.HostPort || null;
    } catch (e) {
      return res.status(502).json({ error: "Could not inspect container", details: e.message });
    }
  }

  if (!hostPort) return res.status(409).json({ error: "Gateway port not published" });

  res.json({
    url: `http://localhost:${hostPort}`,
    port: parseInt(hostPort),
    token: agent.gateway_token,
  });
}));

// Live container resource stats (CPU, memory, network, PIDs)
router.get("/:id/stats", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT id, container_id, backend_type, user_id, status FROM agents WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  if (!agent.container_id) return res.status(409).json({ error: "No container" });

  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const container = docker.getContainer(agent.container_id);
    const stats = await container.stats({ stream: false });
    const info = await container.inspect();

    // CPU %
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage || 0);
    const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
    const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    // Memory
    const memUsage = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 0;
    const memCache = stats.memory_stats.stats?.cache || 0;
    const memActual = memUsage - memCache;

    // Network I/O (sum all interfaces)
    let netRx = 0, netTx = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
      }
    }

    // Disk I/O
    let diskRead = 0, diskWrite = 0;
    if (stats.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        if (entry.op === "read" || entry.op === "Read") diskRead += entry.value || 0;
        if (entry.op === "write" || entry.op === "Write") diskWrite += entry.value || 0;
      }
    }

    // Uptime
    const startedAt = info.State?.StartedAt ? new Date(info.State.StartedAt).getTime() : 0;
    const uptimeSeconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

    res.json({
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_usage_mb: Math.round(memActual / 1024 / 1024),
      memory_limit_mb: Math.round(memLimit / 1024 / 1024),
      memory_percent: memLimit > 0 ? Math.round((memActual / memLimit) * 10000) / 100 : 0,
      network_rx_mb: Math.round(netRx / 1024 / 1024 * 100) / 100,
      network_tx_mb: Math.round(netTx / 1024 / 1024 * 100) / 100,
      disk_read_mb: Math.round(diskRead / 1024 / 1024 * 100) / 100,
      disk_write_mb: Math.round(diskWrite / 1024 / 1024 * 100) / 100,
      pids: stats.pids_stats?.current || 0,
      uptime_seconds: uptimeSeconds,
      running: info.State?.Running || false,
    });
  } catch (e) {
    res.status(502).json({ error: "Could not fetch container stats", details: e.message });
  }
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
    if (!["warning", "error", "stopped"].includes(agent.status)) {
      return res.status(400).json({ error: "Agent must be in warning, error, or stopped state to redeploy" });
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
