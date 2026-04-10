const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const billing = require("../billing");
const {
  clampDeploymentDefaults,
  getDeploymentDefaults,
  normalizeDeploymentDefaults,
} = require("../platformSettings");
const scheduler = require("../scheduler");
const containerManager = require("../containerManager");
const monitoring = require("../monitoring");
const {
  CLONE_MODES,
  buildContainerName,
  buildTemplatePayloadFromAgent,
  createEmptyTemplatePayload,
  materializeTemplateWiring,
  sanitizeAgentName,
  serializeAgent,
} = require("../agentPayloads");
const { isGatewayAvailableStatus, reconcileAgentStatus } = require("../agentStatus");
const { OPENCLAW_GATEWAY_PORT } = require("../../agent-runtime/lib/contracts");
const { resolveGatewayAddress } = require("../../agent-runtime/lib/agentEndpoints");
const { getDefaultAgentImage } = require("../../agent-runtime/lib/agentImages");
const {
  getBackendStatus,
  getDefaultBackend,
  isKnownBackend,
  normalizeBackendName,
  sandboxForBackend,
} = require("../../agent-runtime/lib/backendCatalog");
const { asyncHandler } = require("../middleware/errorHandler");
const {
  buildAgentHistoryResponse,
  buildAgentStatsResponse,
} = require("../agentTelemetry");
const {
  buildAgentContext,
  buildAuditMetadata,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("agent"));

function resolveRequestedImage({
  requestedImage,
  backend = "docker",
  fallbackImage = null,
} = {}) {
  const normalizedBackend = isKnownBackend(backend)
    ? normalizeBackendName(backend)
    : getDefaultBackend(process.env, { sandbox: "standard" });

  return (
    (typeof requestedImage === "string" && requestedImage.trim()) ||
    fallbackImage ||
    getDefaultAgentImage({
      sandbox: sandboxForBackend(normalizedBackend),
      backend: normalizedBackend,
    })
  );
}

function resolveRequestedBackend({
  requestedBackend,
  fallbackBackend = null,
  fallbackSandbox = "standard",
} = {}) {
  if (isKnownBackend(requestedBackend)) {
    return normalizeBackendName(requestedBackend);
  }
  if (isKnownBackend(fallbackBackend)) {
    return normalizeBackendName(fallbackBackend);
  }
  return getDefaultBackend(process.env, { sandbox: fallbackSandbox });
}

function normalizeGatewayHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`http://${raw}`);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function resolvePublishedGatewayHost(req) {
  const configuredHost = normalizeGatewayHost(process.env.GATEWAY_HOST);
  if (configuredHost) return configuredHost;

  const nextAuthHost = normalizeGatewayHost(process.env.NEXTAUTH_URL);
  if (nextAuthHost) return nextAuthHost;

  const forwardedHostHeader = req.headers["x-forwarded-host"];
  const forwardedHost = Array.isArray(forwardedHostHeader)
    ? forwardedHostHeader[0]
    : String(forwardedHostHeader || "").split(",")[0];
  const normalizedForwardedHost = normalizeGatewayHost(forwardedHost);
  if (normalizedForwardedHost) return normalizedForwardedHost;

  return normalizeGatewayHost(req.get("host")) || "localhost";
}

function resolvePublishedGatewayProtocol(req) {
  const nextAuthUrl = String(process.env.NEXTAUTH_URL || "").trim();
  if (nextAuthUrl) {
    try {
      const parsed = new URL(nextAuthUrl);
      return parsed.protocol === "https:" ? "https" : "http";
    } catch {
      // Fall through to request headers.
    }
  }

  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : String(forwardedProtoHeader || "").split(",")[0];
  if (forwardedProto && forwardedProto.trim()) {
    return forwardedProto.trim() === "https" ? "https" : "http";
  }

  return req.protocol === "https" ? "https" : "http";
}

function assertBackendAvailable(backend) {
  const status = getBackendStatus(backend);
  if (!status.enabled) {
    const error = new Error(
      `${status.label} is not enabled. Add "${status.id}" to ENABLED_BACKENDS to use this backend.`
    );
    error.statusCode = 400;
    throw error;
  }
  if (!status.configured) {
    const error = new Error(
      status.issue || `${status.label} is not configured for this Nora control plane.`
    );
    error.statusCode = 400;
    throw error;
  }
  return status;
}

router.get("/", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(result.rows.map(serializeAgent));
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

  res.json(serializeAgent(agent));
}));

// Historical container stats with time range
// Query params: ?range=5m|15m|30m|1h|6h|24h|3d|7d (default 15m) or ?from=ISO&to=ISO
router.get("/:id/stats/history", asyncHandler(async (req, res) => {
  const agentCheck = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]
  );
  const agent = agentCheck.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const rangeMap = {
    "5m": "5 minutes",
    "15m": "15 minutes",
    "30m": "30 minutes",
    "1h": "1 hour",
    "6h": "6 hours",
    "24h": "24 hours",
    "3d": "3 days",
    "7d": "7 days",
  };
  let fromTime, toTime;

  if (req.query.from && req.query.to) {
    fromTime = new Date(req.query.from);
    toTime = new Date(req.query.to);
  } else {
    const range = rangeMap[req.query.range || "15m"] || "15 minutes";
    toTime = new Date();
    fromTime = new Date(Date.now() - parseInterval(range));
  }

  res.json(await buildAgentHistoryResponse(agent, fromTime, toTime));
}));

function parseInterval(pg) {
  const m = pg.match(/(\d+)\s*(day|minute|hour|second)/);
  if (!m) return 15 * 60 * 1000;
  const n = parseInt(m[1]);
  if (m[2] === "day") return n * 86400000;
  if (m[2] === "hour") return n * 3600000;
  if (m[2] === "minute") return n * 60000;
  return n * 1000;
}

function agentAuditMetadata(req, agent, extra = {}) {
  return buildAuditMetadata(
    req,
    buildAgentContext(agent, {
      ownerEmail: req?.user?.email || null,
      ...extra,
    })
  );
}

// Get the gateway control UI URL (published host port for direct browser access)
router.get("/:id/gateway-url", asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT id, host, container_id, backend_type, gateway_token, gateway_host_port,
            gateway_host, gateway_port, user_id, status
       FROM agents
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.locals.auditContext = buildAgentContext(agent, {
    ownerEmail: req.user.email || null,
  });
  if (!isGatewayAvailableStatus(agent.status)) {
    return res.status(409).json({ error: "Agent gateway is only available while running" });
  }
  if (!agent.container_id) return res.status(409).json({ error: "No container" });

  // Prefer the stored published port when present. This keeps browser access on
  // the control-plane host for Docker and local kind NodePort verification.
  let hostPort = agent.gateway_host_port;
  if (!hostPort && agent.container_id && ["docker", "nemoclaw"].includes(agent.backend_type || "docker")) {
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

  const publishedGatewayHost = resolvePublishedGatewayHost(req);
  const publishedGatewayProtocol = resolvePublishedGatewayProtocol(req);

  if (hostPort) {
    return res.json({
      url: `${publishedGatewayProtocol}://${publishedGatewayHost}:${hostPort}`,
      port: parseInt(hostPort, 10),
    });
  }

  const directAddress = resolveGatewayAddress(agent, {
    publishedHost: publishedGatewayHost,
  });
  if (!directAddress) return res.status(409).json({ error: "Gateway address not available" });

  res.json({
    url: `${publishedGatewayProtocol}://${directAddress.host}:${directAddress.port}`,
    port: parseInt(directAddress.port, 10),
  });
}));

// Live container resource stats (CPU, memory, network, PIDs)
router.get("/:id/stats", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(await buildAgentStatsResponse(agent));
}));

router.post("/deploy", async (req, res) => {
  try {
    // Enforce billing limits
    const limits = await billing.enforceLimits(req.user.id);
    if (!limits.allowed) return res.status(402).json({ error: limits.error, subscription: limits.subscription });

    const sub = limits.subscription;
    const name = sanitizeAgentName(req.body.name, "OpenClaw-Agent");
    if (name.length > 100) return res.status(400).json({ error: "Agent name must be 100 characters or less" });
    const containerNameRaw = (req.body.container_name || "").trim();
    const containerName = containerNameRaw || buildContainerName(name);
    const requestedSandbox = req.body.sandbox === "nemoclaw" ? "nemoclaw" : "standard";
    const backend = resolveRequestedBackend({
      requestedBackend: req.body.backend,
      fallbackSandbox: requestedSandbox,
    });
    const backendStatus = assertBackendAvailable(backend);
    const sandbox = sandboxForBackend(backend);
    const node = await scheduler.selectNode({ fallback: backend });
    const nodeName = node ? node.name : backend;

    const deploymentDefaults = await getDeploymentDefaults();

    // Resolve resource specs based on platform mode
    let specs;
    if (!billing.IS_PAAS) {
      // Self-hosted: accept user-chosen values clamped to operator limits
      specs = clampDeploymentDefaults(
        normalizeDeploymentDefaults(req.body, deploymentDefaults),
        billing.SELFHOSTED_LIMITS
      );
    } else {
      // PaaS: resources are controlled by the operator-managed deployment defaults.
      specs = deploymentDefaults;
    }
    const image = resolveRequestedImage({
      requestedImage: req.body.image,
      backend,
    });
    const templatePayload = createEmptyTemplatePayload({
      source: "blank-deploy",
    });

    const result = await db.query(
      `INSERT INTO agents(
         user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
         container_name, image, template_payload
       ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        req.user.id,
        name,
        nodeName,
        backend,
        sandbox,
        specs.vcpu,
        specs.ram_mb,
        specs.disk_gb,
        containerName,
        image,
        JSON.stringify(templatePayload),
      ]
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
      backend,
      sandbox,
      specs,
      container_name: containerName,
      image,
      model: sandbox === "nemoclaw" ? req.body.model || null : null,
    });

    const deployType = backendStatus.label;
    await monitoring.logEvent(
      "agent_deployed",
      `Agent "${name}" (${deployType}) queued for deployment`,
      agentAuditMetadata(req, agent, {
        deploy: {
          backend,
          type: deployType,
          specs,
          image,
          containerName,
        },
      })
    );

    res.json(serializeAgent(agent));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.patch("/:id", asyncHandler(async (req, res) => {
  const result = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const name = sanitizeAgentName(req.body.name, agent.name || "OpenClaw-Agent");
  if (name.length > 100) {
    return res.status(400).json({ error: "Agent name must be 100 characters or less" });
  }

  const updated = await db.query(
    "UPDATE agents SET name = $1 WHERE id = $2 RETURNING *",
    [name, agent.id]
  );
  await monitoring.logEvent(
    "agent_renamed",
    `Agent renamed to "${name}"`,
    agentAuditMetadata(req, updated.rows[0], {
      result: {
        previousName: agent.name,
        nextName: name,
      },
    })
  );
  res.json(serializeAgent(updated.rows[0]));
}));

router.post("/:id/duplicate", asyncHandler(async (req, res) => {
  const limits = await billing.enforceLimits(req.user.id);
  if (!limits.allowed) {
    return res.status(402).json({ error: limits.error, subscription: limits.subscription });
  }

  const sourceResult = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id]
  );
  const sourceAgent = sourceResult.rows[0];
  if (!sourceAgent) return res.status(404).json({ error: "Agent not found" });
  res.locals.auditContext = buildAgentContext(sourceAgent, {
    ownerEmail: req.user.email || null,
  });

  const cloneMode = CLONE_MODES.has(req.body.clone_mode)
    ? req.body.clone_mode
    : "files_only";
  const name = sanitizeAgentName(
    req.body.name,
    `${sourceAgent.name || "OpenClaw-Agent"} Copy`
  );
  if (name.length > 100) {
    return res.status(400).json({ error: "Agent name must be 100 characters or less" });
  }

  const backend = resolveRequestedBackend({
    requestedBackend: req.body.backend,
    fallbackBackend: sourceAgent.backend_type || null,
    fallbackSandbox: sourceAgent.sandbox_type || "standard",
  });
  assertBackendAvailable(backend);
  const node = await scheduler.selectNode({ fallback: backend });
  const containerNameRaw = (req.body.container_name || "").trim();
  const containerName = containerNameRaw || buildContainerName(name);
  const specs = {
    vcpu: sourceAgent.vcpu || 2,
    ram_mb: sourceAgent.ram_mb || 2048,
    disk_gb: sourceAgent.disk_gb || 20,
  };
  const sandbox = sandboxForBackend(backend);
  const image = resolveRequestedImage({
    requestedImage: req.body.image,
    backend,
    fallbackImage: sourceAgent.image || null,
  });

  let templatePayload;
  try {
    templatePayload = await buildTemplatePayloadFromAgent(sourceAgent, cloneMode);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  const inserted = await db.query(
    `INSERT INTO agents(
       user_id, name, status, node, backend_type, sandbox_type, vcpu, ram_mb, disk_gb,
       container_name, image, template_payload
     ) VALUES($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      req.user.id,
      name,
      node?.name || backend,
      backend,
      sandbox,
      specs.vcpu,
      specs.ram_mb,
      specs.disk_gb,
      containerName,
      image,
      JSON.stringify(templatePayload),
    ]
  );
  const agent = inserted.rows[0];

  await materializeTemplateWiring(agent.id, templatePayload);
  await db.query(
    "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
    [agent.id]
  );
  await addDeploymentJob({
    id: agent.id,
    name: agent.name,
    userId: req.user.id,
    plan: limits.subscription.plan,
    backend,
    sandbox,
    specs,
    container_name: containerName,
    image,
  });
  await monitoring.logEvent(
    "agent_duplicated",
    `Agent "${sourceAgent.name}" duplicated as "${agent.name}"`,
    agentAuditMetadata(req, agent, {
      sourceAgent: {
        id: sourceAgent.id,
        name: sourceAgent.name,
      },
      clone: {
        mode: cloneMode,
      },
    })
  );

  res.json(serializeAgent(agent));
}));

router.post("/:id/start", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    const agent = result.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!agent.container_id) return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.start(agent);

    const updated = await db.query(
      "UPDATE agents SET status = 'running' WHERE id = $1 RETURNING *", [agent.id]
    );
    await monitoring.logEvent(
      "agent_started",
      `Agent "${agent.name}" started`,
      agentAuditMetadata(req, updated.rows[0], {
        result: { status: "running" },
      })
    );
    res.json(serializeAgent(updated.rows[0]));
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
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });

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
    await monitoring.logEvent(
      "agent_stopped",
      `Agent "${agent.name}" stopped`,
      agentAuditMetadata(req, updated.rows[0], {
        result: { status: "stopped" },
      })
    );
    res.json(serializeAgent(updated.rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function destroyAgent(agentId, userId, req, res) {
  const result = await db.query(
    "SELECT * FROM agents WHERE id = $1 AND user_id = $2",
    [agentId, userId]
  );
  const agent = result.rows[0];
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.locals.auditContext = buildAgentContext(agent, {
    ownerEmail: req.user.email || null,
  });

  if (agent.container_id) {
    try {
      await containerManager.destroy(agent);
    } catch (e) {
      console.error("Container cleanup error:", e.message);
    }
  }

  await db.query("DELETE FROM agents WHERE id = $1", [agent.id]);
  await monitoring.logEvent(
    "agent_deleted",
    `Agent "${agent.name}" deleted`,
    agentAuditMetadata(req, agent, {
      result: { deleted: true },
    })
  );
  res.json({ success: true });
}

router.post("/:id/delete", async (req, res) => {
  try {
    await destroyAgent(req.params.id, req.user.id, req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await destroyAgent(req.params.id, req.user.id, req, res);
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
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!agent.container_id) return res.status(400).json({ error: "No container — redeploy the agent first" });

    await containerManager.restart(agent);

    await db.query("UPDATE agents SET status = 'running' WHERE id = $1", [agent.id]);
    await monitoring.logEvent(
      "agent_restarted",
      `Agent "${agent.name}" restarted`,
      agentAuditMetadata(req, agent, {
        result: { status: "running" },
      })
    );
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
    res.locals.auditContext = buildAgentContext(agent, {
      ownerEmail: req.user.email || null,
    });
    if (!["warning", "error", "stopped"].includes(agent.status)) {
      return res.status(400).json({ error: "Agent must be in warning, error, or stopped state to redeploy" });
    }

    await db.query(
      `UPDATE agents
          SET status = 'queued',
              container_id = NULL,
              host = NULL,
              runtime_host = NULL,
              runtime_port = NULL,
              gateway_host = NULL,
              gateway_port = NULL,
              gateway_host_port = NULL,
              gateway_token = NULL
        WHERE id = $1`,
      [agent.id]
    );

    await db.query(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      [agent.id]
    );

    const backend = resolveRequestedBackend({
      fallbackBackend: agent.backend_type || null,
      fallbackSandbox: agent.sandbox_type || "standard",
    });
    assertBackendAvailable(backend);

    await addDeploymentJob({
      id: agent.id,
      name: agent.name,
      userId: req.user.id,
      backend,
      sandbox: sandboxForBackend(backend),
      specs: { vcpu: agent.vcpu || 2, ram_mb: agent.ram_mb || 2048, disk_gb: agent.disk_gb || 20 },
      container_name: agent.container_name,
      image: agent.image || null,
    });

    await monitoring.logEvent(
      "agent_redeployed",
      `Agent "${agent.name}" re-queued for deployment`,
      agentAuditMetadata(req, agent, {
        result: {
          previousStatus: agent.status,
          nextStatus: "queued",
        },
      })
    );

    res.json({ success: true, status: "queued" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
