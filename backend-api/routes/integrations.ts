// @ts-nocheck
const express = require("express");
const db = require("../db");
const integrations = require("../integrations");
const { rpcCall } = require("../gatewayProxy");
const { syncAuthToUserAgents } = require("../authSync");
const { requireOwnedAgent } = require("../middleware/ownership");
const { AGENT_RUNTIME_PORT } = require("../../agent-runtime/lib/contracts");
const { runtimeUrlForAgent } = require("../../agent-runtime/lib/agentEndpoints");
const { resolveAgentRuntimeFamily } = require("../agentRuntimeFields");

const router = express.Router();

router.use("/agents/:id/integrations", requireOwnedAgent("id"));

async function getAgentIntegrationRuntimeTarget(agentId) {
  const agentResult = await db.query(
    `SELECT id, host, runtime_host, runtime_port, status, gateway_token,
            gateway_host_port, gateway_host, gateway_port, backend_type,
            runtime_family, deploy_target, sandbox_profile, user_id
       FROM agents WHERE id = $1`,
    [agentId],
  );
  return agentResult.rows[0] || null;
}

async function syncIntegrationsToAgent(agentId, { strictHermes = false } = {}) {
  const agent = await getAgentIntegrationRuntimeTarget(agentId);
  if (!agent) return null;

  if (resolveAgentRuntimeFamily(agent) === "hermes") {
    const syncResults = await syncAuthToUserAgents(agent.user_id, agent.id);
    const failedResult = Array.isArray(syncResults)
      ? syncResults.find((entry) => entry?.agentId === agent.id && entry?.status === "failed")
      : null;

    if (strictHermes && failedResult) {
      const error = new Error(
        failedResult.error || "Failed to sync Hermes integrations to runtime",
      );
      error.statusCode = 502;
      throw error;
    }

    return {
      runtimeFamily: "hermes",
      syncResults,
    };
  }

  const runtimeUrl = runtimeUrlForAgent(agent, "/integrations/sync");
  if (!runtimeUrl) return;

  // 1. Push integration metadata (non-sensitive) to the agent runtime.
  try {
    const syncData = await integrations.getIntegrationsForSync(agentId);
    await fetch(runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ integrations: syncData }),
    });
  } catch (e) {
    console.warn(
      `[sync-integrations] Runtime sync failed for agent ${agentId} on port ${AGENT_RUNTIME_PORT}: ${String(e?.message || e)}`,
    );
  }

  // 2. Push decrypted tokens into the live gateway env via RPC
  if (agent.status === "running") {
    try {
      const envVars = await integrations.getIntegrationEnvVars(agentId);
      const count = Object.keys(envVars).length;
      if (count > 0) {
        await rpcCall(agent, "config.set", { env: envVars });
        console.log(
          `[sync-integrations] Pushed ${count} integration env var(s) to agent ${agentId} gateway`,
        );
      }
    } catch (e) {
      console.warn(
        `[sync-integrations] Gateway env push failed for agent ${agentId}: ${String(e?.message || e)}`,
      );
    }
  }

  return {
    runtimeFamily: resolveAgentRuntimeFamily(agent),
  };
}

async function invokeAgentIntegrationTool(agentId, payload = {}) {
  const agent = await getAgentIntegrationRuntimeTarget(agentId);
  if (!agent) {
    const error = new Error("Agent not found");
    error.statusCode = 404;
    throw error;
  }

  if (resolveAgentRuntimeFamily(agent) === "hermes") {
    const error = new Error("Integration tool invocation is not available for Hermes runtimes");
    error.statusCode = 409;
    throw error;
  }

  if (!["running", "warning"].includes(agent.status)) {
    const error = new Error(`Agent is ${agent.status}, not running`);
    error.statusCode = 409;
    throw error;
  }

  const runtimeUrl = runtimeUrlForAgent(agent, "/integrations/tools/invoke");
  if (!runtimeUrl) {
    const error = new Error("Agent runtime not yet provisioned");
    error.statusCode = 409;
    throw error;
  }

  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Runtime returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

// ─── Agent integrations ──────────────────────────────────────────

router.get("/agents/:id/integrations", async (req, res) => {
  try {
    res.json(await integrations.listIntegrations(req.params.id));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations", async (req, res) => {
  try {
    const { provider, token, config } = req.body;
    if (!provider) return res.status(400).json({ error: "Provider required" });
    const agent = await getAgentIntegrationRuntimeTarget(req.params.id);
    const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
    const result = await integrations.connectIntegration(req.params.id, provider, token, config);

    if (runtimeFamily === "hermes") {
      await syncIntegrationsToAgent(req.params.id, { strictHermes: true });
    } else {
      syncIntegrationsToAgent(req.params.id).catch(() => {});
      // Also refresh auth-profiles.json for integrations that provide LLM tokens (e.g. HF_TOKEN)
      syncAuthToUserAgents(req.user.id, req.params.id).catch(() => {});
    }

    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.delete("/agents/:id/integrations/:iid", async (req, res) => {
  try {
    const agent = await getAgentIntegrationRuntimeTarget(req.params.id);
    const runtimeFamily = resolveAgentRuntimeFamily(agent || {});
    await integrations.removeIntegration(req.params.iid, req.params.id);

    if (runtimeFamily === "hermes") {
      await syncIntegrationsToAgent(req.params.id, { strictHermes: true });
    } else {
      syncIntegrationsToAgent(req.params.id).catch(() => {});
      syncAuthToUserAgents(req.user.id, req.params.id).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations/:iid/test", async (req, res) => {
  try {
    const result = await integrations.testIntegration(req.params.iid, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations/tools/invoke", async (req, res) => {
  try {
    const toolName =
      typeof req.body.toolName === "string" && req.body.toolName
        ? req.body.toolName
        : typeof req.body.name === "string" && req.body.name
          ? req.body.name
          : "";
    if (!toolName) {
      return res.status(400).json({ error: "toolName required" });
    }

    const input =
      req.body.input && typeof req.body.input === "object" && !Array.isArray(req.body.input)
        ? req.body.input
        : req.body.arguments &&
            typeof req.body.arguments === "object" &&
            !Array.isArray(req.body.arguments)
          ? req.body.arguments
          : {};
    const result = await invokeAgentIntegrationTool(req.params.id, {
      toolName,
      input,
    });
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ─── Integration catalog ──────────────────────────────────────────

router.get("/integrations/catalog", async (req, res) => {
  try {
    const { category } = req.query;
    res.json(await integrations.getCatalog(category));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/integrations/catalog/:catalogId", async (req, res) => {
  try {
    const item = await integrations.getCatalogItem(req.params.catalogId);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
