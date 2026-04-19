// @ts-nocheck
const db = require("../db");

async function findOwnedAgent(agentId, userId) {
  if (!agentId) return null;
  const result = await db.query(
    "SELECT id, user_id, name, status, host FROM agents WHERE id = $1 AND user_id = $2",
    [agentId, userId]
  );
  return result.rows[0] || null;
}

async function findOwnedWorkspace(workspaceId, userId) {
  if (!workspaceId) return null;
  const result = await db.query(
    "SELECT id, user_id, name, created_at FROM workspaces WHERE id = $1 AND user_id = $2",
    [workspaceId, userId]
  );
  return result.rows[0] || null;
}

function requireOwnedAgent(paramName = "id", attachAs = "agent") {
  return async (req, res, next) => {
    try {
      const agentId = req.params[paramName];
      const agent = await findOwnedAgent(agentId, req.user.id);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      req[attachAs] = agent;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

function requireOwnedWorkspace(paramName = "id", attachAs = "workspace") {
  return async (req, res, next) => {
    try {
      const workspaceId = req.params[paramName];
      const workspace = await findOwnedWorkspace(workspaceId, req.user.id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      req[attachAs] = workspace;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

module.exports = {
  findOwnedAgent,
  findOwnedWorkspace,
  requireOwnedAgent,
  requireOwnedWorkspace,
};
