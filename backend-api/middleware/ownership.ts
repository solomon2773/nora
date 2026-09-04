// @ts-nocheck
const db = require("../db");

// Role hierarchy for workspace_members.role. Higher index = more privileged.
// Routes ask for a minimum role; any equal-or-higher role is accepted.
const WORKSPACE_ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };

// Role evaluation

function rankRole(role) {
  return Object.prototype.hasOwnProperty.call(WORKSPACE_ROLE_RANK, role)
    ? WORKSPACE_ROLE_RANK[role]
    : -1;
}

function roleSatisfies(actual, required) {
  const a = rankRole(actual);
  const r = rankRole(required);
  // Fail-safe: an unknown role on either side means "no, never satisfied".
  if (a < 0 || r < 0) return false;
  return a >= r;
}

// API-key workspace binding

function apiKeyWorkspaceId(req) {
  if (!req || !req.apiKey) return null;
  return req.apiKeyWorkspace?.id ?? req.apiKey?.workspaceId ?? null;
}

/**
 * Enforce an API key's permanent workspace binding before membership checks.
 * Session-authenticated requests pass through unchanged.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response used for binding failures.
 * @param {string} workspaceId - Workspace requested by the route.
 * @returns {boolean} Whether authorization may continue.
 */
function enforceApiKeyWorkspace(req, res, workspaceId) {
  if (!req.apiKey) return true;
  const bound = apiKeyWorkspaceId(req);
  if (!bound || bound !== workspaceId) {
    res.status(403).json({
      error: "API key is not scoped to this workspace",
      code: "wrong_workspace",
    });
    return false;
  }
  return true;
}

function isRemoteDockerAgent(agent = {}) {
  const deployTarget = String(agent.deploy_target || agent.deployTarget || "")
    .trim()
    .toLowerCase();
  const backendType = String(agent.backend_type || agent.backendType || "")
    .trim()
    .toLowerCase();
  const executionTargetId = String(agent.execution_target_id || agent.executionTargetId || "")
    .trim()
    .toLowerCase();
  return (
    deployTarget === "remote-docker" ||
    backendType === "remote-docker" ||
    executionTargetId.startsWith("remote:")
  );
}

function assertApiKeyCanAccessLoadedAgent(req, agent) {
  if (!req?.apiKey || !agent || !isRemoteDockerAgent(agent)) return agent;

  const error = new Error("Remote Docker agent operations require session authentication");
  error.statusCode = 403;
  error.code = "session_required";
  throw error;
}

/**
 * Ensure an API-key target agent is assigned to its bound workspace and is not
 * a session-only Remote Docker agent. Session callers pass through unchanged.
 *
 * @param {Object} req - Authenticated Express request.
 * @param {Object} res - Express response used for binding failures.
 * @param {string} agentId - Agent requested by the route.
 * @returns {Promise<boolean>} Whether authorization may continue.
 */
async function enforceApiKeyAgentScope(req, res, agentId) {
  if (!req.apiKey) return true;
  const bound = apiKeyWorkspaceId(req);
  if (!bound) {
    res.status(403).json({ error: "API key has no workspace binding", code: "wrong_workspace" });
    return false;
  }

  const cached = req.apiKeyAgentScope;
  if (cached?.workspaceId === bound && cached?.agentId === agentId) {
    return true;
  }

  const result = await db.query(
    `SELECT a.id, a.backend_type, a.deploy_target, a.execution_target_id
       FROM workspace_agents wa
       JOIN agents a ON a.id = wa.agent_id
      WHERE wa.workspace_id = $1 AND wa.agent_id = $2
      LIMIT 1`,
    [bound, agentId],
  );
  const scopedAgent = result.rows[0];
  if (!scopedAgent) {
    res.status(403).json({
      error: "API key is not scoped to this agent's workspace",
      code: "wrong_workspace",
    });
    return false;
  }

  // Remote Docker registration, placement, and runtime access remain
  // session-only. In particular, stop/delete use a deliberately privileged
  // cleanup transport that can outlive a workspace host grant, so a workspace
  // API key must never inherit that capability from its issuing user.
  if (isRemoteDockerAgent(scopedAgent)) {
    res.status(403).json({
      error: "Remote Docker agent operations require session authentication",
      code: "session_required",
    });
    return false;
  }

  req.apiKeyAgentScope = {
    workspaceId: bound,
    agentId,
  };
  return true;
}

function requireApiKeyAgentScope(paramName = "id") {
  return async (req, res, next) => {
    try {
      if (await enforceApiKeyAgentScope(req, res, req.params[paramName])) next();
    } catch (error) {
      next(error);
    }
  };
}

// Mount this at /agents before every agent router, including the gateway.
// Collection routes are the only paths whose first segment is not an agent id.
function requireApiKeyAgentPathScope(options = {}) {
  const collectionSegments = new Set(
    options.collectionSegments || ["activate-demo", "adopt", "deploy"],
  );
  const sessionOnlyNestedSegments = new Set(
    options.sessionOnlyNestedSegments || ["backups", "export", "files"],
  );
  return async (req, res, next) => {
    if (!req.apiKey) return next();
    const segments = String(req.path || "")
      .split("/")
      .filter(Boolean);
    const firstSegment = segments[0];
    if (
      !firstSegment ||
      collectionSegments.has(firstSegment) ||
      (segments.length > 1 && sessionOnlyNestedSegments.has(segments[1]))
    ) {
      return next();
    }

    try {
      if (await enforceApiKeyAgentScope(req, res, firstSegment)) next();
    } catch (error) {
      next(error);
    }
  };
}

// Resource access lookups

async function findOwnedAgent(agentId, userId) {
  if (!agentId) return null;
  const result = await db.query(
    `SELECT id, user_id, name, status, host, container_id, backend_type, runtime_family,
            deploy_target, execution_target_id, sandbox_profile, clawhub_skills, gateway_token,
            gateway_host_port, gateway_host, gateway_port, runtime_host, runtime_port
       FROM agents
      WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  );
  return result.rows[0] || null;
}

// Preserve legacy direct-owner semantics for browser sessions while treating
// a workspace API key as the workspace capability it represents. Callers must
// still apply the route's scope guard and, for agent-id routes, the exact
// workspace/Remote-Docker guard before performing side effects.
async function findAgentForRequest(req, agentId) {
  if (!agentId) return null;
  if (req?.apiKey) {
    const workspaceId = apiKeyWorkspaceId(req);
    if (!workspaceId) return null;
    const result = await db.query(
      `SELECT a.*
         FROM workspace_agents wa
         JOIN agents a ON a.id = wa.agent_id
        WHERE wa.workspace_id = $1 AND wa.agent_id = $2
        LIMIT 1`,
      [workspaceId, agentId],
    );
    const agent = result.rows[0] || null;
    // Re-check the loaded row instead of relying only on the earlier path
    // guard. Placement can change between middleware and the route loader;
    // returning no capability here keeps that race fail-closed.
    return assertApiKeyCanAccessLoadedAgent(req, agent);
  }

  const userId = req?.user?.id;
  if (!userId) return null;
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    agentId,
    userId,
  ]);
  return result.rows[0] || null;
}

async function findAccessibleAgentForRequest(req, agentId, requiredRole = "viewer") {
  if (req?.apiKey) {
    // API keys are workspace capabilities. Re-query the exact bound assignment
    // on every authoritative load instead of falling back to the issuer's
    // direct ownership or membership in another workspace after a grant is
    // removed between the path guard and the route handler.
    return findAgentForRequest(req, agentId);
  }
  const agent = await findAccessibleAgent(agentId, req?.user?.id, requiredRole);
  return assertApiKeyCanAccessLoadedAgent(req, agent);
}

/**
 * Build the `agents` SELECT used by lookups that cannot call findAccessibleAgent
 * because they need a narrow, pinned column projection instead of `SELECT *` —
 * the embed and gateway proxies, whose SSRF allowlist authorizes against an
 * exact field list (see embedAgentColumns.ts).
 *
 * The statement resolves the same access model findAccessibleAgent implements —
 * the agent's owner, or a member of any workspace the agent is shared into — and
 * exposes the caller's highest role as `effective_role` so the caller can apply
 * its own minimum-role rule. Rows reachable by neither route are filtered out,
 * so a caller that ignores `effective_role` still gets owner-or-member scoping.
 *
 * Bind exactly `[agentId, userId]`. `user_id` in the projection stays the
 * *owner*, never the caller — the remote-host grant check depends on that.
 *
 * @param {string[]} columns - Agent columns to select; identifiers only.
 * @returns {string} Parameterized SELECT statement.
 */
function buildAccessibleAgentQuery(columns) {
  for (const column of columns) {
    // These lists are module constants, never request input, but interpolating
    // them into SQL is only safe while that stays true.
    if (typeof column !== "string" || !/^[a-z_]+$/.test(column)) {
      throw new Error(`Unsafe agent column: ${String(column)}`);
    }
  }
  return `SELECT ${columns.map((column) => `a.${column}`).join(", ")},
            CASE WHEN a.user_id = $2 THEN 'owner' ELSE shared.role END AS effective_role
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT m.role
           FROM workspace_agents wa
           JOIN workspace_members m
             ON m.workspace_id = wa.workspace_id AND m.user_id = $2
          WHERE wa.agent_id = a.id
          ORDER BY
            CASE m.role
              WHEN 'owner' THEN 0
              WHEN 'admin' THEN 1
              WHEN 'editor' THEN 2
              WHEN 'viewer' THEN 3
            END
          LIMIT 1
       ) shared ON TRUE
      WHERE a.id = $1
        AND (a.user_id = $2 OR shared.role IS NOT NULL)`;
}

/**
 * Resolve an agent through direct ownership or any sharing workspace where the
 * user meets the requested role, attaching the effective role on success.
 *
 * @param {string} agentId - Agent to authorize.
 * @param {string} userId - User requesting access.
 * @param {string} [requiredRole="viewer"] - Minimum workspace role.
 * @returns {Promise<Object|null>} Full agent row with effective role, or `null`.
 */
async function findAccessibleAgent(agentId, userId, requiredRole = "viewer") {
  if (!agentId || !userId) return null;
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_ROLE_RANK, requiredRole)) {
    throw new Error(`Unknown workspace role: ${requiredRole}`);
  }
  const agentResult = await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
  const row = agentResult.rows[0];
  if (!row) return null;

  // Fast path — direct ownership grants the highest role.
  if (row.user_id === userId) {
    return { ...row, effective_role: "owner" };
  }

  // Slow path — check workspace membership through workspace_agents.
  const memberResult = await db.query(
    `SELECT m.role
       FROM workspace_agents wa
       JOIN workspace_members m
         ON m.workspace_id = wa.workspace_id AND m.user_id = $2
      WHERE wa.agent_id = $1
      ORDER BY
        CASE m.role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 3
        END
      LIMIT 1`,
    [agentId, userId],
  );
  const memberRole = memberResult.rows[0]?.role;
  if (!memberRole) return null;
  if (!roleSatisfies(memberRole, requiredRole)) return null;
  return { ...row, effective_role: memberRole };
}

/**
 * Resolve non-Express actor access, granting platform admins fleet-wide access
 * and applying workspace-aware role checks to normal users.
 *
 * @param {string} agentId - Agent to authorize.
 * @param {Object} actor - Authenticated platform actor.
 * @param {string} [requiredRole="viewer"] - Minimum role for non-admin actors.
 * @returns {Promise<Object|null>} Authorized agent row, or `null`.
 */
async function findAccessibleAgentForActor(agentId, actor, requiredRole = "viewer") {
  if (!agentId || !actor?.id) return null;
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_ROLE_RANK, requiredRole)) {
    throw new Error(`Unknown workspace role: ${requiredRole}`);
  }

  if (actor.role === "admin") {
    const result = await db.query("SELECT * FROM agents WHERE id = $1", [agentId]);
    const row = result.rows[0];
    return row ? { ...row, effective_role: "admin" } : null;
  }

  return findAccessibleAgent(agentId, actor.id, requiredRole);
}

async function findOwnedWorkspace(workspaceId, userId) {
  if (!workspaceId) return null;
  const result = await db.query(
    "SELECT id, user_id, name, created_at FROM workspaces WHERE id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return result.rows[0] || null;
}

/**
 * Resolve workspace membership, treating the legacy workspace creator as owner
 * when no backfilled membership row exists.
 *
 * @param {string} workspaceId - Workspace to authorize.
 * @param {string} userId - User requesting access.
 * @returns {Promise<Object|null>} Workspace and effective role, or `null`.
 */
async function findWorkspaceMembership(workspaceId, userId) {
  if (!workspaceId || !userId) return null;
  const result = await db.query(
    `SELECT w.id, w.user_id, w.name, w.created_at, m.role
       FROM workspaces w
       LEFT JOIN workspace_members m
         ON m.workspace_id = w.id AND m.user_id = $2
      WHERE w.id = $1`,
    [workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.role) return row;
  if (row.user_id === userId) return { ...row, role: "owner" };
  return null;
}

// Express authorization middleware

function requireOwnedAgent(paramName = "id", attachAs = "agent") {
  return async (req, res, next) => {
    try {
      const agentId = req.params[paramName];
      if (!(await enforceApiKeyAgentScope(req, res, agentId))) return;
      const agent = await findAgentForRequest(req, agentId);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      req[attachAs] = agent;
      next();
    } catch (e) {
      res.status(e.statusCode || 500).json({
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
      });
    }
  };
}

function requireOwnedWorkspace(paramName = "id", attachAs = "workspace") {
  return async (req, res, next) => {
    try {
      const workspaceId = req.params[paramName];
      if (!enforceApiKeyWorkspace(req, res, workspaceId)) return;
      const workspace = await findOwnedWorkspace(workspaceId, req.user.id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      req[attachAs] = workspace;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

/**
 * Build an agent guard that enforces API-key binding or a session caller's
 * minimum workspace role, returning 404 when access is unavailable.
 *
 * @param {string} [requiredRole="viewer"] - Minimum workspace role.
 * @param {string} [paramName="id"] - Route parameter containing the agent id.
 * @param {string} [attachAs="agent"] - Request property receiving the agent.
 * @returns {Function} Express authorization middleware.
 */
function requireAccessibleAgent(requiredRole = "viewer", paramName = "id", attachAs = "agent") {
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_ROLE_RANK, requiredRole)) {
    throw new Error(`Unknown workspace role: ${requiredRole}`);
  }
  return async (req, res, next) => {
    try {
      const agentId = req.params[paramName];
      if (!(await enforceApiKeyAgentScope(req, res, agentId))) return;
      const agent = await findAccessibleAgentForRequest(req, agentId, requiredRole);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      req[attachAs] = agent;
      next();
    } catch (e) {
      res.status(e.statusCode || 500).json({
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
      });
    }
  };
}

/**
 * Build a workspace guard that enforces API-key binding and role hierarchy,
 * attaching membership context for authorized requests.
 *
 * @param {string} requiredRole - Minimum workspace role.
 * @param {string} [paramName="id"] - Route parameter containing the workspace id.
 * @param {string} [attachAs="workspace"] - Request property receiving membership context.
 * @returns {Function} Express authorization middleware.
 */
function requireWorkspaceRole(requiredRole, paramName = "id", attachAs = "workspace") {
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_ROLE_RANK, requiredRole)) {
    throw new Error(`Unknown workspace role: ${requiredRole}`);
  }
  return async (req, res, next) => {
    try {
      const workspaceId = req.params[paramName];
      if (!enforceApiKeyWorkspace(req, res, workspaceId)) return;
      const membership = await findWorkspaceMembership(workspaceId, req.user.id);
      if (!membership) return res.status(404).json({ error: "Workspace not found" });
      if (!roleSatisfies(membership.role, requiredRole)) {
        return res.status(403).json({ error: "Insufficient workspace permissions" });
      }
      req[attachAs] = membership;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

module.exports = {
  WORKSPACE_ROLE_RANK,
  rankRole,
  roleSatisfies,
  apiKeyWorkspaceId,
  enforceApiKeyWorkspace,
  enforceApiKeyAgentScope,
  isRemoteDockerAgent,
  assertApiKeyCanAccessLoadedAgent,
  requireApiKeyAgentScope,
  requireApiKeyAgentPathScope,
  findOwnedAgent,
  findAgentForRequest,
  buildAccessibleAgentQuery,
  findAccessibleAgent,
  findAccessibleAgentForRequest,
  findAccessibleAgentForActor,
  findOwnedWorkspace,
  findWorkspaceMembership,
  requireOwnedAgent,
  requireOwnedWorkspace,
  requireAccessibleAgent,
  requireWorkspaceRole,
};
