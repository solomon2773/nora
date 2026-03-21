const express = require("express");
const db = require("../db");
const { addDeploymentJob } = require("../redisQueue");
const marketplace = require("../marketplace");
const snapshots = require("../snapshots");
const scheduler = require("../scheduler");
const monitoring = require("../monitoring");

const router = express.Router();

router.post("/install", async (req, res) => {
  try {
    const { listingId } = req.body;
    const listing = await marketplace.getListing(listingId);
    if (!listing) return res.status(404).json({ error: "listing not found" });
    const snap = await snapshots.getSnapshot(listing.snapshot_id);
    if (!snap) return res.status(404).json({ error: "snapshot missing" });

    const node = await scheduler.selectNode();
    const result = await db.query(
      "INSERT INTO agents(user_id, name, status, node) VALUES($1, $2, 'queued', $3) RETURNING *",
      [req.user.id, snap.name, node?.name || "worker-01"]
    );
    const agent = result.rows[0];

    await db.query(
      "INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')",
      [agent.id]
    );
    await addDeploymentJob({ id: agent.id, name: agent.name, userId: req.user.id });
    await monitoring.logEvent("marketplace_install", `Installed "${snap.name}" from marketplace`, { agentId: agent.id, listingId });

    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
