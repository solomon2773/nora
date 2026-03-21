const express = require("express");
const db = require("../db");
const integrations = require("../integrations");
const { rpcCall } = require("../gatewayProxy");
const { syncAuthToUserAgents } = require("../authSync");

const router = express.Router();

async function syncIntegrationsToAgent(agentId) {
  const agentResult = await db.query(
    "SELECT id, host, status, gateway_token FROM agents WHERE id = $1",
    [agentId]
  );
  const agent = agentResult.rows[0];
  if (!agent || !agent.host) return;

  // 1. Push integration metadata (non-sensitive) to agent sidecar on port 9090
  try {
    const syncData = await integrations.getIntegrationsForSync(agentId);
    await fetch(`http://${agent.host}:9090/integrations/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syncData),
    });
  } catch (e) {
    console.warn(`[sync-integrations] Port-9090 sync failed for agent ${agentId}:`, e.message);
  }

  // 2. Push decrypted tokens into the live gateway env via RPC
  if (agent.status === 'running') {
    try {
      const envVars = await integrations.getIntegrationEnvVars(agentId);
      const count = Object.keys(envVars).length;
      if (count > 0) {
        await rpcCall(agent, 'config.set', { env: envVars });
        console.log(`[sync-integrations] Pushed ${count} integration env var(s) to agent ${agentId} gateway`);
      }
    } catch (e) {
      console.warn(`[sync-integrations] Gateway env push failed for agent ${agentId}:`, e.message);
    }
  }
}

// ─── Agent integrations ──────────────────────────────────────────

router.get("/agents/:id/integrations", async (req, res) => {
  try {
    res.json(await integrations.listIntegrations(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations", async (req, res) => {
  try {
    const { provider, token, config } = req.body;
    if (!provider) return res.status(400).json({ error: "Provider required" });
    const result = await integrations.connectIntegration(req.params.id, provider, token, config);
    syncIntegrationsToAgent(req.params.id).catch(() => {});
    // Also refresh auth-profiles.json for integrations that provide LLM tokens (e.g. HF_TOKEN)
    syncAuthToUserAgents(req.user.id, req.params.id).catch(() => {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/agents/:id/integrations/:iid", async (req, res) => {
  try {
    await integrations.removeIntegration(req.params.iid, req.params.id);
    syncIntegrationsToAgent(req.params.id).catch(() => {});
    syncAuthToUserAgents(req.user.id, req.params.id).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/agents/:id/integrations/:iid/test", async (req, res) => {
  try {
    const result = await integrations.testIntegration(req.params.iid, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
