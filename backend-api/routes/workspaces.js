const express = require("express");
const db = require("../db");
const workspaces = require("../workspaces");

const router = express.Router();

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
    res.json(await workspaces.getWorkspaceAgents(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/agents", async (req, res) => {
  try {
    const ws = await db.query("SELECT id FROM workspaces WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    if (!ws.rows[0]) return res.status(404).json({ error: "Workspace not found" });
    const { agentId, role } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    res.json(await workspaces.addAgent(req.params.id, agentId, role));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const ws = await db.query("SELECT id FROM workspaces WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    if (!ws.rows[0]) return res.status(404).json({ error: "Workspace not found" });
    await db.query("DELETE FROM workspace_agents WHERE workspace_id = $1", [req.params.id]);
    await db.query("DELETE FROM workspaces WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
