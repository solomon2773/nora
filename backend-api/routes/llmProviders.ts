// @ts-nocheck
const express = require("express");
const llmProviders = require("../llmProviders");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireSession } = require("../middleware/auth");
const { syncAuthToUserAgents } = require("../authSync");

const router = express.Router();
// Provider credentials and defaults are user-global. A workspace API key must
// not inherit its issuer's access to mutate or reconcile credentials across
// other workspaces (including Remote Docker agents).
router.use(requireSession);

async function syncAfterProviderSave(userId, successMessage = "Provider saved") {
  try {
    // Provider mutations hold the same per-user advisory lock through this
    // after-commit callback. Mark it explicitly so auth sync does not try to
    // reacquire the non-reentrant lock on a second PostgreSQL session.
    const results = await syncAuthToUserAgents(userId, null, { providerLockHeld: true });
    const failed = results.filter((result) => result.status === "failed");
    const unsafeFailures = failed.filter(
      (result) => result.runtimeStopped !== true || result.quarantinePersisted !== true,
    );
    if (unsafeFailures.length > 0) {
      const error = new Error(
        `${successMessage}, but ${unsafeFailures.length} running agent${unsafeFailures.length === 1 ? " could" : "s could"} not be stopped and quarantined after credential reconciliation failed`,
      );
      error.statusCode = 502;
      error.code = "PROVIDER_RUNTIME_REVOCATION_UNCONFIRMED";
      error.committed = true;
      error.syncResults = results;
      throw error;
    }
    return {
      sync_results: results,
      ...(failed.length > 0
        ? {
            sync_warning: `${failed.length} running agent${failed.length === 1 ? "" : "s"} could not be updated automatically`,
          }
        : {}),
    };
  } catch (error) {
    if (error?.code === "PROVIDER_RUNTIME_REVOCATION_UNCONFIRMED") throw error;
    console.warn("[llmProviders] Post-save auth sync failed:", error.message);
    const containmentError = new Error(
      `${successMessage}, but runtime credential reconciliation could not be confirmed`,
    );
    containmentError.statusCode = 502;
    containmentError.code = "PROVIDER_RUNTIME_REVOCATION_UNCONFIRMED";
    containmentError.committed = true;
    containmentError.syncResults = [];
    containmentError.cause = error;
    throw containmentError;
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
    res.status(e.statusCode || 400).json({
      error: e.message,
      ...(e.committed ? { committed: true } : {}),
      ...(Array.isArray(e.syncResults) ? { sync_results: e.syncResults } : {}),
    });
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
    res.status(e.statusCode || 400).json({
      error: e.message,
      ...(e.committed ? { committed: true } : {}),
      ...(Array.isArray(e.syncResults) ? { sync_results: e.syncResults } : {}),
    });
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
    res.status(e.statusCode || 400).json({
      error: e.message,
      ...(e.committed ? { committed: true } : {}),
      ...(Array.isArray(e.syncResults) ? { sync_results: e.syncResults } : {}),
    });
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
