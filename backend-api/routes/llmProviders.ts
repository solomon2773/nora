// @ts-nocheck
const express = require("express");
const llmProviders = require("../llmProviders");
const { asyncHandler } = require("../middleware/errorHandler");
const { syncAuthToUserAgents } = require("../authSync");

const router = express.Router();

router.get("/available", (req, res) => {
  res.json(llmProviders.getAvailableProviders());
});

router.get("/", async (req, res) => {
  try {
    res.json(await llmProviders.listProviders(req.user.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { provider, apiKey, model, config } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ error: "provider and apiKey required" });
    const result = await llmProviders.addProvider(req.user.id, provider, apiKey, model, config);
    syncAuthToUserAgents(req.user.id).catch(() => {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const result = await llmProviders.updateProvider(req.params.id, req.user.id, req.body);
    syncAuthToUserAgents(req.user.id).catch(() => {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await llmProviders.deleteProvider(req.params.id, req.user.id);
    syncAuthToUserAgents(req.user.id).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sync LLM keys to running agents (writes auth-profiles.json + sets model)
// Optional body: { agentId: "uuid" } to sync a specific agent only
router.post("/sync", asyncHandler(async (req, res) => {
  const { agentId } = req.body || {};
  const results = await syncAuthToUserAgents(req.user.id, agentId || null);
  res.json({
    synced: results.filter(r => r.status === 'synced').length,
    total: results.length,
    results,
  });
}));

module.exports = router;
