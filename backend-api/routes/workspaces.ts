// @ts-nocheck
const express = require("express");
const db = require("../db");
const workspaces = require("../workspaces");
const { findOwnedAgent, requireOwnedWorkspace } = require("../middleware/ownership");

const router = express.Router();

router.use("/:id", requireOwnedWorkspace("id"));

router.get("/", async (req, res) => {
  try {
    res.json(await workspaces.listWorkspaces(req.user.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    if (typeof name !== "string" || name.length > 100) return res.status(400).json({ error: "Name must be 1-100 characters" });
    res.json(await workspaces.createWorkspace(req.user.id, name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/agents", async (req, res) => {
  try {
    res.json(await workspaces.getWorkspaceAgents(req.params.id, req.user.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/agents", async (req, res) => {
  try {
    const { agentId, role } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    const agent = await findOwnedAgent(agentId, req.user.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(await workspaces.addAgent(req.params.id, agentId, role, req.user.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM workspace_agents WHERE workspace_id = $1", [req.params.id]);
    await db.query("DELETE FROM workspaces WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
