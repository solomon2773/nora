// @ts-nocheck
// Workspace member + invitation management.
// Invitation tokens follow the same HMAC-SHA256-on-server pattern as
// agentHubApiKeys.ts: the raw token is shown once at creation, only the hash
// is stored, and accept-time lookup hashes the presented token and compares.

const crypto = require("crypto");
const db = require("./db");

const INVITE_TOKEN_PREFIX = "nora_inv_";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"]; // owner can only be created at workspace-create
const ALL_ROLES = ["owner", "admin", "editor", "viewer"];

// Invitation token security

/**
 * Resolve the HMAC secret for invitation tokens, rejecting non-test operation
 * when no configured secret has at least 32 characters.
 *
 * @returns {string} Invitation-token hashing secret.
 */
function inviteHashSecret() {
  const candidates = [
    process.env.NORA_WORKSPACE_INVITE_SECRET,
    process.env.NORA_AGENT_HUB_API_KEY_HASH_SECRET,
    process.env.JWT_SECRET,
    process.env.ENCRYPTION_KEY,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed.length >= 32) return trimmed;
  }
  if (process.env.NODE_ENV === "test") return "nora-workspace-invite-test-hash-secret";
  const error = new Error(
    "Workspace invitations require JWT_SECRET, ENCRYPTION_KEY, or NORA_WORKSPACE_INVITE_SECRET (>=32 chars)",
  );
  error.statusCode = 503;
  throw error;
}

function generateRawInviteToken() {
  return `${INVITE_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function hashInviteToken(rawToken) {
  return crypto
    .createHmac("sha256", inviteHashSecret())
    .update(String(rawToken || ""), "utf8")
    .digest("hex");
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function assertAssignableRole(role) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    const error = new Error(`Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
}

function serializeMember(row) {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  };
}

function serializeInvitation(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  };
}

// Membership lifecycle

async function listMembers(workspaceId) {
  const result = await db.query(
    `SELECT m.workspace_id, m.user_id, m.role, m.invited_by, m.created_at,
            u.email, u.name
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY
        CASE m.role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 3
          ELSE 4
        END,
        m.created_at ASC`,
    [workspaceId],
  );
  return result.rows.map(serializeMember);
}

async function countOwners(workspaceId) {
  const result = await db.query(
    "SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
    [workspaceId],
  );
  return result.rows[0]?.n || 0;
}

/**
 * Change a member role after a non-locking check rejects demotion of the
 * currently observed last owner.
 *
 * @param {string} workspaceId - Workspace containing the member.
 * @param {string} userId - Member whose role should change.
 * @param {string} newRole - Valid workspace role to assign.
 * @returns {Promise<Object|null>} Updated member, or `null` when absent.
 */
async function updateMemberRole(workspaceId, userId, newRole) {
  if (!ALL_ROLES.includes(newRole)) {
    const error = new Error(`Role must be one of: ${ALL_ROLES.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  // Prevent demoting the last owner.
  if (newRole !== "owner") {
    const current = await db.query(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    if (!current.rows[0]) return null;
    if (current.rows[0].role === "owner" && (await countOwners(workspaceId)) <= 1) {
      const error = new Error("Cannot demote the last owner of a workspace");
      error.statusCode = 409;
      throw error;
    }
  }
  const result = await db.query(
    `UPDATE workspace_members
        SET role = $3
      WHERE workspace_id = $1 AND user_id = $2
      RETURNING workspace_id, user_id, role, invited_by, created_at`,
    [workspaceId, userId, newRole],
  );
  if (!result.rows[0]) return null;
  const userRow = await db.query("SELECT email, name FROM users WHERE id = $1", [userId]);
  return serializeMember({ ...result.rows[0], ...userRow.rows[0] });
}

/**
 * Remove a member after a non-locking check rejects removal of the currently
 * observed last owner.
 *
 * @param {string} workspaceId - Workspace containing the member.
 * @param {string} userId - Member to remove.
 * @returns {Promise<boolean>} Whether a member was removed.
 */
async function removeMember(workspaceId, userId) {
  const current = await db.query(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  if (!current.rows[0]) return false;
  if (current.rows[0].role === "owner" && (await countOwners(workspaceId)) <= 1) {
    const error = new Error("Cannot remove the last owner of a workspace");
    error.statusCode = 409;
    throw error;
  }
  await db.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
    workspaceId,
    userId,
  ]);
  return true;
}

// Invitation lifecycle

/**
 * Create a seven-day, email-bound invitation, storing only its HMAC and
 * returning the raw acceptance token once.
 *
 * @param {string} workspaceId - Workspace the recipient may join.
 * @param {string} email - Recipient email address.
 * @param {string} role - Assignable role granted on acceptance.
 * @param {string} invitedBy - User issuing the invitation.
 * @returns {Promise<Object>} Invitation metadata plus the one-time raw token.
 */
async function createInvitation(workspaceId, email, role, invitedBy) {
  assertAssignableRole(role);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    const error = new Error("Valid email required");
    error.statusCode = 400;
    throw error;
  }
  // If the invitee is already a member, no invitation needed.
  const existingMember = await db.query(
    `SELECT 1
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND lower(u.email) = $2`,
    [workspaceId, normalizedEmail],
  );
  if (existingMember.rows[0]) {
    const error = new Error("User is already a member of this workspace");
    error.statusCode = 409;
    throw error;
  }
  const rawToken = generateRawInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const result = await db.query(
    `INSERT INTO workspace_invitations
       (workspace_id, email, role, token_hash, invited_by, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING id, workspace_id, email, role, invited_by, status, expires_at, accepted_at, created_at`,
    [workspaceId, normalizedEmail, role, tokenHash, invitedBy, expiresAt],
  );
  return { ...serializeInvitation(result.rows[0]), token: rawToken };
}

async function listInvitations(workspaceId, { includeRevoked = false } = {}) {
  const result = await db.query(
    `SELECT id, workspace_id, email, role, invited_by, status, expires_at, accepted_at, created_at
       FROM workspace_invitations
      WHERE workspace_id = $1
        ${includeRevoked ? "" : "AND status IN ('pending', 'accepted')"}
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(serializeInvitation);
}

async function revokeInvitation(invitationId, workspaceId) {
  const result = await db.query(
    `UPDATE workspace_invitations
        SET status = 'revoked'
      WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
      RETURNING id, workspace_id, email, role, invited_by, status, expires_at, accepted_at, created_at`,
    [invitationId, workspaceId],
  );
  return result.rows[0] ? serializeInvitation(result.rows[0]) : null;
}

/**
 * Accept an invitation only for its addressed user email after validating its
 * token and state. Membership and invitation status are separate writes, so a
 * later failure can leave the membership applied before acceptance is recorded.
 *
 * @param {string} rawToken - Raw invitation token presented by the user.
 * @param {string} userId - Authenticated user accepting the invitation.
 * @returns {Promise<Object>} Joined workspace id and assigned role.
 */
async function acceptInvitation(rawToken, userId) {
  const token = String(rawToken || "").trim();
  if (!token) {
    const error = new Error("Invitation token required");
    error.statusCode = 400;
    throw error;
  }
  const tokenHash = hashInviteToken(token);
  const userResult = await db.query("SELECT email FROM users WHERE id = $1", [userId]);
  if (!userResult.rows[0]) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }
  const userEmail = normalizeEmail(userResult.rows[0].email);

  const inviteResult = await db.query(
    `SELECT id, workspace_id, email, role, status, expires_at
       FROM workspace_invitations
      WHERE token_hash = $1`,
    [tokenHash],
  );
  const invite = inviteResult.rows[0];
  if (!invite) {
    const error = new Error("Invitation not found");
    error.statusCode = 404;
    throw error;
  }
  if (invite.status !== "pending") {
    const error = new Error(`Invitation is ${invite.status}`);
    error.statusCode = 409;
    throw error;
  }
  if (new Date(invite.expires_at) < new Date()) {
    await db.query("UPDATE workspace_invitations SET status = 'expired' WHERE id = $1", [
      invite.id,
    ]);
    const error = new Error("Invitation has expired");
    error.statusCode = 410;
    throw error;
  }
  if (normalizeEmail(invite.email) !== userEmail) {
    const error = new Error("Invitation is addressed to a different email");
    error.statusCode = 403;
    throw error;
  }

  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
     SELECT $1, $2, $3, invited_by FROM workspace_invitations WHERE id = $4
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [invite.workspace_id, userId, invite.role, invite.id],
  );
  await db.query(
    `UPDATE workspace_invitations
        SET status = 'accepted',
            accepted_by = $2,
            accepted_at = NOW()
      WHERE id = $1`,
    [invite.id, userId],
  );

  return { workspaceId: invite.workspace_id, role: invite.role };
}

module.exports = {
  ASSIGNABLE_ROLES,
  ALL_ROLES,
  hashInviteToken,
  listMembers,
  updateMemberRole,
  removeMember,
  createInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
};
