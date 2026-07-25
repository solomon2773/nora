// @ts-nocheck
// Platform-admin "god view" of multi-tenant RBAC. Mounted under /admin so the
// existing requireAdmin guard chain applies; we re-apply it here to be
// belt-and-braces and to ensure API keys never reach this surface.
//
// Endpoints:
//   GET /admin/workspaces         every workspace with creator + member counts
//   GET /admin/members            every (workspace, user, role) tuple, filterable
//   GET /admin/members/summary    user-centric: each user × their workspaces
//
// All endpoints are read-only — actual role mutations still happen through
// the workspace admin's UI under /app/workspaces/:id/members so each change
// is attributed to the workspace admin who made it.

const express = require("express");
const db = require("../db");
const { requireAdmin, requireSession } = require("../middleware/auth");

const router = express.Router();

// Scope the guards to this router's actual prefixes so an unmatched request
// such as /admin/doctor can continue to the main admin router. Mount-wide
// guards here previously intercepted every /admin request before route match.
router.use("/workspaces", requireSession, requireAdmin);
router.use("/members", requireSession, requireAdmin);

router.get("/workspaces", async (_req, res, next) => {
  try {
    const result = await db.query(
      `SELECT w.id, w.name, w.user_id, w.created_at,
              creator.email AS creator_email,
              creator.name AS creator_name,
              COUNT(m.id) FILTER (WHERE m.role = 'owner')::int  AS owner_count,
              COUNT(m.id) FILTER (WHERE m.role = 'admin')::int  AS admin_count,
              COUNT(m.id) FILTER (WHERE m.role = 'editor')::int AS editor_count,
              COUNT(m.id) FILTER (WHERE m.role = 'viewer')::int AS viewer_count,
              COUNT(m.id)::int AS total_members,
              COALESCE(agent_counts.n, 0) AS agent_count
         FROM workspaces w
         LEFT JOIN users creator ON creator.id = w.user_id
         LEFT JOIN workspace_members m ON m.workspace_id = w.id
         LEFT JOIN (
           SELECT workspace_id, COUNT(*)::int AS n
             FROM workspace_agents
            GROUP BY workspace_id
         ) AS agent_counts ON agent_counts.workspace_id = w.id
        GROUP BY w.id, creator.email, creator.name, agent_counts.n
        ORDER BY w.created_at DESC`,
    );
    res.json(
      result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        creatorUserId: row.user_id,
        creatorEmail: row.creator_email,
        creatorName: row.creator_name,
        createdAt: row.created_at,
        memberCounts: {
          owner: row.owner_count,
          admin: row.admin_count,
          editor: row.editor_count,
          viewer: row.viewer_count,
          total: row.total_members,
        },
        agentCount: row.agent_count,
      })),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/members", async (req, res, next) => {
  try {
    const { workspaceId, userId, role, q } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;
    if (typeof workspaceId === "string" && workspaceId) {
      conditions.push(`m.workspace_id = $${paramIdx++}`);
      params.push(workspaceId);
    }
    if (typeof userId === "string" && userId) {
      conditions.push(`m.user_id = $${paramIdx++}`);
      params.push(userId);
    }
    if (typeof role === "string" && ["owner", "admin", "editor", "viewer"].includes(role)) {
      conditions.push(`m.role = $${paramIdx++}`);
      params.push(role);
    }
    if (typeof q === "string" && q.trim()) {
      conditions.push(
        `(u.email ILIKE $${paramIdx} OR u.name ILIKE $${paramIdx} OR w.name ILIKE $${paramIdx})`,
      );
      params.push(`%${q.trim()}%`);
      paramIdx += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await db.query(
      `SELECT m.workspace_id, m.user_id, m.role, m.invited_by, m.created_at AS joined_at,
              w.name AS workspace_name,
              u.email AS user_email,
              u.name AS user_name,
              u.role AS platform_role,
              inviter.email AS invited_by_email
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN users u ON u.id = m.user_id
         LEFT JOIN users inviter ON inviter.id = m.invited_by
         ${where}
        ORDER BY w.name ASC, CASE m.role
                  WHEN 'owner' THEN 0
                  WHEN 'admin' THEN 1
                  WHEN 'editor' THEN 2
                  WHEN 'viewer' THEN 3
                END, u.email ASC
        LIMIT 500`,
      params,
    );
    res.json(
      result.rows.map((row) => ({
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        userId: row.user_id,
        userEmail: row.user_email,
        userName: row.user_name,
        platformRole: row.platform_role,
        role: row.role,
        invitedBy: row.invited_by,
        invitedByEmail: row.invited_by_email,
        joinedAt: row.joined_at,
      })),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/members/summary", async (_req, res, next) => {
  try {
    // User-centric rollup: one row per user, with the count of workspaces they
    // belong to and the highest role they hold across all workspaces.
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.role AS platform_role,
              COUNT(m.id)::int AS workspace_count,
              MIN(CASE m.role
                    WHEN 'owner' THEN 0
                    WHEN 'admin' THEN 1
                    WHEN 'editor' THEN 2
                    WHEN 'viewer' THEN 3
                  END) AS top_role_rank
         FROM users u
         LEFT JOIN workspace_members m ON m.user_id = u.id
        GROUP BY u.id
        ORDER BY workspace_count DESC, u.email ASC
        LIMIT 500`,
    );
    const RANK_TO_ROLE = { 0: "owner", 1: "admin", 2: "editor", 3: "viewer" };
    res.json(
      result.rows.map((row) => ({
        userId: row.id,
        email: row.email,
        name: row.name,
        platformRole: row.platform_role,
        workspaceCount: row.workspace_count,
        topRole: row.top_role_rank == null ? null : RANK_TO_ROLE[row.top_role_rank],
      })),
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;
