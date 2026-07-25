// @ts-nocheck
// workspace manager backed by PostgreSQL

const db = require("./db");

const WORKSPACE_ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };

// Serialization and normalization

function normalizeAgentRole(role) {
  const trimmed = typeof role === "string" ? role.trim() : "";
  return trimmed.slice(0, 80) || "member";
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeWorkspaceAgent(row) {
  const agent = {
    id: row.agent_id,
    name: row.agent_name,
    status: row.agent_status,
    user_id: row.agent_user_id,
    node: row.node,
    host: row.host,
    container_id: row.container_id,
    container_name: row.container_name,
    backend_type: row.backend_type,
    runtime_family: row.runtime_family,
    deploy_target: row.deploy_target,
    execution_target_id: row.execution_target_id,
    sandbox_profile: row.sandbox_profile,
    vcpu: row.vcpu,
    ram_mb: row.ram_mb,
    disk_gb: row.disk_gb,
    runtime_host: row.runtime_host,
    runtime_port: row.runtime_port,
    gateway_host: row.gateway_host,
    gateway_port: row.gateway_port,
    gateway_host_port: row.gateway_host_port,
    created_at: row.agent_created_at,
    isDirectOwner: row.is_direct_owner === true,
  };

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    workspaceId: row.workspace_id,
    agent_id: row.agent_id,
    agentId: row.agent_id,
    role: row.role,
    created_at: row.created_at,
    assignedAt: row.created_at,
    agent_name: row.agent_name,
    agentName: row.agent_name,
    agent_status: row.agent_status,
    agentStatus: row.agent_status,
    isDirectOwner: row.is_direct_owner === true,
    agent,
    ...agent,
  };
}

function serializeAgentCandidate(row) {
  return {
    agentId: row.id,
    id: row.id,
    name: row.name,
    status: row.status,
    assigned: row.assigned === true,
    runtime_family: row.runtime_family,
    deploy_target: row.deploy_target,
    execution_target_id: row.execution_target_id,
    sandbox_profile: row.sandbox_profile,
    backend_type: row.backend_type,
    container_name: row.container_name,
    created_at: row.created_at,
  };
}

function serializeAccessibleAgent(row) {
  const workspaces = parseJsonArray(row.workspaces).filter((workspace) => workspace?.id);
  return {
    ...row,
    isDirectOwner: row.is_direct_owner === true,
    effectiveRole: row.effective_role || (row.is_direct_owner ? "owner" : null),
    workspaces,
  };
}

// Workspace lifecycle

/**
 * Create a workspace and its initial owner membership in one transaction.
 *
 * @param {string} userId - User creating and owning the workspace.
 * @param {string} name - Workspace name.
 * @returns {Promise<Object>} Persisted workspace row.
 */
async function createWorkspace(userId, name) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const insert = await client.query(
      "INSERT INTO workspaces(user_id, name) VALUES($1, $2) RETURNING *",
      [userId, name],
    );
    const workspace = insert.rows[0];
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspace.id, userId],
    );
    await client.query("COMMIT");
    return workspace;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List workspaces where a user is a member, retaining the legacy creator-as-owner fallback.
 *
 * @param {string} userId - User whose memberships should be listed.
 * @returns {Promise<Array>} Workspaces with effective role and member/agent counts.
 */
async function listWorkspaces(userId) {
  const result = await db.query(
    `SELECT w.*,
            COALESCE(m.role, CASE WHEN w.user_id = $1 THEN 'owner' ELSE NULL END) AS role,
            COUNT(DISTINCT wa.agent_id)::int AS agent_count,
            COUNT(DISTINCT wm_all.user_id)::int AS member_count
       FROM workspaces w
       LEFT JOIN workspace_members m
         ON m.workspace_id = w.id AND m.user_id = $1
       LEFT JOIN workspace_agents wa
         ON wa.workspace_id = w.id
       LEFT JOIN workspace_members wm_all
         ON wm_all.workspace_id = w.id
      WHERE m.user_id = $1 OR w.user_id = $1
      GROUP BY w.id, m.role
      ORDER BY w.created_at DESC`,
    [userId],
  );
  return result.rows;
}

// Agent assignment and access views

/**
 * Assign or update an agent in a workspace, optionally requiring the caller's
 * direct ownership of that agent before the upsert.
 *
 * @param {string} workspaceId - Workspace receiving the agent.
 * @param {string} agentId - Agent being assigned.
 * @param {string} [role="member"] - Assignment label stored with the link.
 * @param {string|null} [userId=null] - Optional direct owner required for the agent.
 * @returns {Promise<Object>} Persisted workspace-agent assignment.
 */
async function addAgent(workspaceId, agentId, role = "member", userId = null) {
  if (userId) {
    const ownership = await db.query("SELECT id FROM agents WHERE id = $1 AND user_id = $2", [
      agentId,
      userId,
    ]);
    if (!ownership.rows[0]) throw new Error("Workspace or agent not found");
  }

  const normalizedRole = normalizeAgentRole(role);
  const result = await db.query(
    `INSERT INTO workspace_agents(workspace_id, agent_id, role)
     VALUES($1, $2, $3)
     ON CONFLICT (workspace_id, agent_id)
     DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [workspaceId, agentId, normalizedRole],
  );
  return result.rows[0];
}

async function getWorkspaceAgents(workspaceId, userId = null) {
  const result = await db.query(
    `SELECT wa.id, wa.workspace_id, wa.agent_id, wa.role, wa.created_at,
            a.name AS agent_name,
            a.status AS agent_status,
            a.user_id AS agent_user_id,
            a.node,
            a.host,
            a.container_id,
            a.container_name,
            a.backend_type,
            a.runtime_family,
            a.deploy_target,
            a.execution_target_id,
            a.sandbox_profile,
            a.vcpu,
            a.ram_mb,
            a.disk_gb,
            a.runtime_host,
            a.runtime_port,
            a.gateway_host,
            a.gateway_port,
            a.gateway_host_port,
            a.created_at AS agent_created_at,
            (a.user_id = $2) AS is_direct_owner
       FROM workspace_agents wa
       JOIN agents a ON wa.agent_id = a.id
      WHERE wa.workspace_id = $1
      ORDER BY wa.created_at DESC`,
    [workspaceId, userId],
  );
  return result.rows.map(serializeWorkspaceAgent);
}

/**
 * List a user's directly owned agents and mark whether each is already assigned
 * to the requested workspace.
 *
 * @param {string} workspaceId - Workspace used to mark current assignments.
 * @param {string} userId - Direct owner whose agents are candidates.
 * @returns {Promise<Array>} Candidate agents with assignment state.
 */
async function listAgentCandidates(workspaceId, userId) {
  const result = await db.query(
    `SELECT a.id, a.name, a.status, a.backend_type, a.runtime_family, a.deploy_target,
            a.execution_target_id, a.sandbox_profile, a.container_name, a.created_at,
            EXISTS (
              SELECT 1
                FROM workspace_agents wa
               WHERE wa.workspace_id = $1 AND wa.agent_id = a.id
            ) AS assigned
       FROM agents a
      WHERE a.user_id = $2
      ORDER BY assigned DESC, a.created_at DESC`,
    [workspaceId, userId],
  );
  return result.rows.map(serializeAgentCandidate);
}

async function removeAgent(workspaceId, agentId) {
  const result = await db.query(
    `DELETE FROM workspace_agents
      WHERE workspace_id = $1 AND agent_id = $2
      RETURNING *`,
    [workspaceId, agentId],
  );
  return result.rows[0] || null;
}

/**
 * List agents available through direct ownership or workspace membership,
 * optionally restricting the result to directly owned agents or one workspace.
 *
 * @param {string} userId - User whose agent access should be resolved.
 * @param {Object} [options={}] - Optional ownership scope and workspace filter.
 * @returns {Promise<Array>} Agents with effective role and workspace context.
 */
async function listAccessibleAgents(userId, { scope = "accessible", workspaceId = null } = {}) {
  if (workspaceId) {
    const ownedOnly = scope === "owned" ? "AND a.user_id = $1" : "";
    const result = await db.query(
      `SELECT a.*,
              (a.user_id = $1) AS is_direct_owner,
              CASE
                WHEN a.user_id = $1 THEN 'owner'
                ELSE COALESCE(wm.role, CASE WHEN w.user_id = $1 THEN 'owner' ELSE NULL END)
              END AS effective_role,
              jsonb_build_array(
                jsonb_build_object(
                  'id', w.id,
                  'name', w.name,
                  'role', COALESCE(wm.role, CASE WHEN w.user_id = $1 THEN 'owner' ELSE NULL END)
                )
              ) AS workspaces
         FROM workspace_agents wa
         JOIN agents a ON a.id = wa.agent_id
         JOIN workspaces w ON w.id = wa.workspace_id
         LEFT JOIN workspace_members wm
           ON wm.workspace_id = w.id AND wm.user_id = $1
        WHERE wa.workspace_id = $2
          AND (a.user_id = $1 OR wm.user_id = $1 OR w.user_id = $1)
          ${ownedOnly}
        ORDER BY a.created_at DESC`,
      [userId, workspaceId],
    );
    return result.rows.map(serializeAccessibleAgent);
  }

  if (scope === "owned") {
    const result = await db.query(
      `SELECT a.*,
              true AS is_direct_owner,
              'owner' AS effective_role,
              COALESCE(workspace_access.workspaces, '[]'::jsonb) AS workspaces
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    DISTINCT jsonb_build_object(
                      'id', w.id,
                      'name', w.name,
                      'role', COALESCE(wm.role, CASE WHEN w.user_id = $1 THEN 'owner' ELSE NULL END)
                    )
                  ) FILTER (WHERE w.id IS NOT NULL) AS workspaces
             FROM workspace_agents wa
             JOIN workspaces w ON w.id = wa.workspace_id
             LEFT JOIN workspace_members wm
               ON wm.workspace_id = w.id AND wm.user_id = $1
            WHERE wa.agent_id = a.id
              AND (wm.user_id = $1 OR w.user_id = $1)
         ) workspace_access ON true
        WHERE a.user_id = $1
        ORDER BY a.created_at DESC`,
      [userId],
    );
    return result.rows.map(serializeAccessibleAgent);
  }

  const result = await db.query(
    `SELECT a.*,
            (a.user_id = $1) AS is_direct_owner,
            CASE WHEN a.user_id = $1 THEN 'owner' ELSE workspace_access.effective_role END AS effective_role,
            COALESCE(workspace_access.workspaces, '[]'::jsonb) AS workspaces
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT (
                  array_agg(
                    wm.role
                    ORDER BY CASE wm.role
                      WHEN 'owner' THEN 3
                      WHEN 'admin' THEN 2
                      WHEN 'editor' THEN 1
                      WHEN 'viewer' THEN 0
                      ELSE -1
                    END DESC
                  )
                )[1] AS effective_role,
                jsonb_agg(
                  DISTINCT jsonb_build_object(
                    'id', w.id,
                    'name', w.name,
                    'role', wm.role
                  )
                ) FILTER (WHERE w.id IS NOT NULL) AS workspaces
           FROM workspace_agents wa
           JOIN workspace_members wm
             ON wm.workspace_id = wa.workspace_id AND wm.user_id = $1
           JOIN workspaces w ON w.id = wa.workspace_id
          WHERE wa.agent_id = a.id
       ) workspace_access ON true
      WHERE a.user_id = $1 OR workspace_access.effective_role IS NOT NULL
      ORDER BY a.created_at DESC`,
    [userId],
  );
  return result.rows.map(serializeAccessibleAgent);
}

module.exports = {
  WORKSPACE_ROLE_RANK,
  createWorkspace,
  listWorkspaces,
  addAgent,
  getWorkspaceAgents,
  listAgentCandidates,
  removeAgent,
  listAccessibleAgents,
};
