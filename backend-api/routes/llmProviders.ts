// @ts-nocheck
const express = require("express");
const llmProviders = require("../llmProviders");
const { asyncHandler } = require("../middleware/errorHandler");
const { syncAuthToUserAgents } = require("../authSync");

const router = express.Router();

async function syncAfterProviderSave(userId, successMessage = "Provider saved") {
  try {
    const results = await syncAuthToUserAgents(userId);
    const failed = results.filter((result) => result.status === "failed");
    return {
      sync_results: results,
      ...(failed.length > 0
        ? {
            sync_warning: `${failed.length} running agent${failed.length === 1 ? "" : "s"} could not be updated automatically`,
          }
        : {}),
    };
  } catch (error) {
    console.warn("[llmProviders] Post-save auth sync failed:", error.message);
    return {
      sync_results: [],
      sync_warning: `${successMessage}, but running agents could not be updated automatically`,
    };
  }
}

async function mutateProviderAndSync(userId, successMessage, mutation) {
  let sync = { sync_results: [] };
  const result = await mutation({
    afterCommit: async () => {
      sync = await syncAfterProviderSave(userId, successMessage);
    },
  });
  return { ...result, ...sync };
}

router.get("/available", (req, res) => {
  res.json(llmProviders.getAvailableProviders());
});

router.get("/", async (req, res, next) => {
  try {
    res.json(await llmProviders.listProviders(req.user.id));
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res) => {
  try {
    const { provider, apiKey, model, config } = req.body;
    // The built-in demo provider is the one zero-key path (its token is
    // derived server-side); every real provider still requires a key.
    if (!provider || (!apiKey && provider !== "demo"))
      return res.status(400).json({ error: "provider and apiKey required" });
    res.json(
      await mutateProviderAndSync(req.user.id, "Provider saved", (mutationOptions) =>
        llmProviders.addProvider(req.user.id, provider, apiKey, model, config, mutationOptions),
      ),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    res.json(
      await mutateProviderAndSync(req.user.id, "Provider updated", (mutationOptions) =>
        llmProviders.updateProvider(req.params.id, req.user.id, req.body, mutationOptions),
      ),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    res.json(
      await mutateProviderAndSync(req.user.id, "Provider deleted", (mutationOptions) =>
        llmProviders.deleteProvider(req.params.id, req.user.id, mutationOptions),
      ),
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sync LLM keys to running agents (writes auth-profiles.json + sets model)
// Optional body: { agentId: "uuid" } to sync a specific agent only
router.post(
  "/sync",
  asyncHandler(async (req, res) => {
    const { agentId } = req.body || {};
    const results = await syncAuthToUserAgents(req.user.id, agentId || null);
    res.json({
      synced: results.filter((r) => r.status === "synced").length,
      total: results.length,
      results,
    });
  }),
);

module.exports = router;
