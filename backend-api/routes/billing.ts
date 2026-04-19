// @ts-nocheck
const express = require("express");
const db = require("../db");
const billing = require("../billing");

const router = express.Router();

router.get("/subscription", async (req, res) => {
  try {
    const sub = await billing.getSubscription(req.user.id);
    const agentCount = await db.query("SELECT COUNT(*) FROM agents WHERE user_id = $1", [req.user.id]);
    res.json({ ...sub, agents_used: parseInt(agentCount.rows[0].count, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/checkout", async (req, res) => {
  if (!billing.BILLING_ENABLED) return res.status(404).json({ error: "Billing is disabled" });
  try {
    const { plan } = req.body;
    if (!plan || !["pro", "enterprise"].includes(plan)) return res.status(400).json({ error: "Invalid plan" });
    const result = await billing.createCheckoutSession(req.user.id, plan);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/portal", async (req, res) => {
  if (!billing.BILLING_ENABLED) return res.status(404).json({ error: "Billing is disabled" });
  try {
    const result = await billing.createPortalSession(req.user.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
