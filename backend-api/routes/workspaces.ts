// @ts-nocheck
const express = require("express");
const db = require("../db");
const workspaces = require("../workspaces");
const workspaceMembers = require("../workspaceMembers");
const monitoring = require("../monitoring");
const apiKeysRouter = require("./apiKeys");
const alertRulesRouter = require("./alertRules");
const workspaceCostRouter = require("./workspaceCost");
const mailer = require("../mailer");
const metrics = require("../metrics");
const {
  buildAuditMetadata,
  buildWorkspaceContext,
  createMutationFailureAuditMiddleware,
} = require("../auditLog");
const {
  apiKeyWorkspaceId,
  findOwnedAgent,
  requireWorkspaceRole,
} = require("../middleware/ownership");
const { requireSession, scopeByMethod } = require("../middleware/auth");

const router = express.Router();
router.use(createMutationFailureAuditMiddleware("workspace"));
// API keys can read workspace metadata + members + invitations; mutations
// (create, delete, invite, role change) require session auth — issuing keys
// or changing membership via an existing API key is a deliberate footgun.
router.use(scopeByMethod("workspaces:read", null));

// API key management itself is session-only. An API key cannot mint another
// API key — that's a privilege-escalation hole. requireSession runs after
// authenticateToken, so the scope check above is redundant for this path but
// the explicit guard is safer than relying on null-write inheritance.
router.use("/:id/api-keys", requireSession, apiKeysRouter);
router.use("/:id/alert-rules", alertRulesRouter);

router.get("/cost", async (req, res) => {
  try {
    const costOptions = metrics.parseCostQuery(req.query);
    const boundWorkspaceId = apiKeyWorkspaceId(req);
    if (req.apiKey) {
      if (!boundWorkspaceId) {
        return res
          .status(403)
          .json({ error: "API key has no workspace binding", code: "wrong_workspace" });
      }
      const cost = await metrics.getWorkspaceCost(boundWorkspaceId, costOptions);
      const workspace = {
        workspaceName: req.apiKeyWorkspace?.name || null,
        role: null,
        ...cost,
      };
      return res.json({
        periodDays: cost.periodDays,
        periodStart: cost.periodStart,
        periodEnd: cost.periodEnd,
        workspaceTotalUsd: cost.totalUsd,
        uniqueFleetTotalUsd: cost.totalUsd,
        workspaces: [workspace],
        unassigned: { totalUsd: 0, perAgent: [] },
      });
    }
    res.json(await metrics.getAccessibleWorkspaceCosts(req.user.id, costOptions));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.use("/:id", workspaceCostRouter);

function logWorkspaceEvent(req, eventType, message, context) {
  return Promise.resolve(
    monitoring.logEvent(
      eventType,
      message,
      buildAuditMetadata(req, buildWorkspaceContext({}, context)),
    ),
  ).catch((error) => {
    console.error(`Failed to write workspace audit event ${eventType}:`, error.message);
  });
}

// ── Workspace collection ────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const all = await workspaces.listWorkspaces(req.user.id);
    // API keys are bound to a single workspace — even when the issuing user
    // belongs to others, the key must not enumerate them.
    const bound = apiKeyWorkspaceId(req);
    res.json(bound ? all.filter((w) => w.id === bound) : all);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    if (typeof name !== "string" || name.length > 100)
      return res.status(400).json({ error: "Name must be 1-100 characters" });
    const workspace = await workspaces.createWorkspace(req.user.id, name);
    await logWorkspaceEvent(req, "workspace_created", `Workspace "${workspace.name}" created`, {
      id: workspace.id,
      name: workspace.name,
    });
    res.json(workspace);
  } catch (e) {
    next(e);
  }
});

// ── Invitation accept (no :id binding — token carries workspace context) ────

router.post("/invitations/accept", async (req, res) => {
  try {
    const { token } = req.body || {};
    const accepted = await workspaceMembers.acceptInvitation(token, req.user.id);
    await logWorkspaceEvent(
      req,
      "workspace_invitation_accepted",
      `User accepted invitation to workspace ${accepted.workspaceId}`,
      { id: accepted.workspaceId, role: accepted.role, memberUserId: req.user.id },
    );
    res.json(accepted);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── Per-workspace agent routes ──────────────────────────────────────────────

router.get("/:id/agents", requireWorkspaceRole("viewer"), async (req, res, next) => {
  try {
    res.json(await workspaces.getWorkspaceAgents(req.params.id, req.user.id));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/agent-candidates", requireWorkspaceRole("editor"), async (req, res, next) => {
  try {
    res.json(await workspaces.listAgentCandidates(req.params.id, req.user.id));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/agents", requireWorkspaceRole("editor"), async (req, res, next) => {
  try {
    const { agentId, role } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    const agent = await findOwnedAgent(agentId, req.user.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const assignment = await workspaces.addAgent(req.params.id, agentId, role, req.user.id);
    await logWorkspaceEvent(
      req,
      "workspace_agent_assigned",
      `Agent ${agent.name || agent.id} assigned to workspace ${req.params.id}`,
      { id: req.params.id, agentId: agent.id, agentName: agent.name },
    );
    res.json(assignment);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id/agents/:agentId", requireWorkspaceRole("admin"), async (req, res, next) => {
  try {
    const removed = await workspaces.removeAgent(req.params.id, req.params.agentId);
    if (!removed) return res.status(404).json({ error: "Workspace agent assignment not found" });
    await logWorkspaceEvent(
      req,
      "workspace_agent_removed",
      `Agent ${req.params.agentId} removed from workspace ${req.params.id}`,
      { id: req.params.id, agentId: req.params.agentId },
    );
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireWorkspaceRole("owner"), async (req, res, next) => {
  try {
    await db.query("DELETE FROM workspace_agents WHERE workspace_id = $1", [req.params.id]);
    await db.query("DELETE FROM workspaces WHERE id = $1", [req.params.id]);
    await logWorkspaceEvent(req, "workspace_deleted", `Workspace ${req.params.id} deleted`, {
      id: req.params.id,
      name: req.workspace?.name,
    });
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ── Member management ──────────────────────────────────────────────────────

router.get("/:id/members", requireWorkspaceRole("viewer"), async (req, res, next) => {
  try {
    res.json(await workspaceMembers.listMembers(req.params.id));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/members/:userId", requireWorkspaceRole("admin"), async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ error: "role required" });
    const updated = await workspaceMembers.updateMemberRole(req.params.id, req.params.userId, role);
    if (!updated) return res.status(404).json({ error: "Member not found" });
    await logWorkspaceEvent(
      req,
      "workspace_member_role_changed",
      `Member ${updated.email || updated.userId} role set to ${role}`,
      { id: req.params.id, memberUserId: updated.userId, memberEmail: updated.email, role },
    );
    res.json(updated);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.delete("/:id/members/:userId", requireWorkspaceRole("admin"), async (req, res) => {
  try {
    const removed = await workspaceMembers.removeMember(req.params.id, req.params.userId);
    if (!removed) return res.status(404).json({ error: "Member not found" });
    await logWorkspaceEvent(
      req,
      "workspace_member_removed",
      `Member ${req.params.userId} removed from workspace ${req.params.id}`,
      { id: req.params.id, memberUserId: req.params.userId },
    );
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── Invitation management ──────────────────────────────────────────────────

router.get("/:id/invitations", requireWorkspaceRole("admin"), async (req, res, next) => {
  try {
    const includeRevoked = req.query.includeRevoked === "true";
    res.json(await workspaceMembers.listInvitations(req.params.id, { includeRevoked }));
  } catch (e) {
    next(e);
  }
});

function stripTrailingSlash(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return value.slice(0, end);
}

/**
 * Build an invitation acceptance URL from the configured public base or a
 * length-capped request Origin, falling back to a relative path when both are absent.
 *
 * @param {Object} req - Invitation request.
 * @param {string} rawToken - Raw invitation token.
 * @returns {string} Absolute or relative invitation acceptance URL.
 */
function buildAcceptUrl(req, rawToken) {
  // Prefer NEXTAUTH_URL (the canonical public URL). Fall back to the request
  // origin so local dev still produces a usable link without env config. Cap
  // the origin length before stripping — an attacker-controlled Origin header
  // would otherwise feed an unbounded string into URL construction.
  const rawOrigin = req.headers?.origin ? String(req.headers.origin).slice(0, 2048) : "";
  const base =
    stripTrailingSlash(process.env.NEXTAUTH_URL || "") || stripTrailingSlash(rawOrigin) || "";
  return `${base}/app/invitations/accept?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Attempt invitation delivery when SMTP is configured, returning delivery
 * status without invalidating the already-created invitation on mail failure.
 *
 * @param {Object} req - Authenticated invitation request.
 * @param {Object} invitation - Persisted invitation containing its one-time token.
 * @returns {Promise<Object>} Delivery status and optional message id or error.
 */
async function maybeSendInvitationEmail(req, invitation) {
  if (!invitation || !invitation.token) return { sent: false, error: "no_token" };
  let configured = false;
  try {
    configured = await mailer.isConfigured();
  } catch {
    configured = false;
  }
  if (!configured) return { sent: false, error: "not_configured" };

  // Workspace name is useful in the subject line; cheap secondary lookup.
  let workspaceName = req.workspace?.name || invitation.workspaceId;
  try {
    const ws = await db.query("SELECT name FROM workspaces WHERE id = $1", [
      invitation.workspaceId,
    ]);
    if (ws.rows[0]?.name) workspaceName = ws.rows[0].name;
  } catch {
    // Keep the fallback; the email is still useful without an exact name.
  }

  const acceptUrl = buildAcceptUrl(req, invitation.token);
  const inviterEmail = req.user?.email || "the workspace admin";
  const result = await mailer.sendMail({
    to: invitation.email,
    subject: `You're invited to ${workspaceName} on Nora`,
    text:
      `${inviterEmail} invited you to join "${workspaceName}" on Nora as ${invitation.role}.\n\n` +
      `Open this link to accept the invitation:\n${acceptUrl}\n\n` +
      `This invitation expires on ${new Date(invitation.expiresAt).toUTCString()}.`,
    replyTo: req.user?.email || undefined,
  });
  return result.delivered
    ? { sent: true, messageId: result.messageId || null }
    : { sent: false, error: result.error || "unknown" };
}

router.post("/:id/invitations", requireWorkspaceRole("admin"), async (req, res) => {
  try {
    const { email, role } = req.body || {};
    const invitation = await workspaceMembers.createInvitation(
      req.params.id,
      email,
      role,
      req.user.id,
    );
    // Fire the email and capture the result. The route waits for delivery so
    // the response can tell the dashboard whether to show "Email sent to …"
    // vs. fall through to the copy-link toast — this is a low-volume admin
    // action, the latency cost of one SMTP roundtrip is acceptable.
    const emailDelivery = await maybeSendInvitationEmail(req, invitation);
    await logWorkspaceEvent(
      req,
      "workspace_invitation_created",
      `Invited ${invitation.email} as ${invitation.role}`,
      {
        id: req.params.id,
        invitationId: invitation.id,
        invitationEmail: invitation.email,
        invitationRole: invitation.role,
        email: emailDelivery,
      },
    );
    res.json({ ...invitation, emailDelivery });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.delete("/:id/invitations/:invitationId", requireWorkspaceRole("admin"), async (req, res) => {
  try {
    const revoked = await workspaceMembers.revokeInvitation(req.params.invitationId, req.params.id);
    if (!revoked) return res.status(404).json({ error: "Invitation not found" });
    await logWorkspaceEvent(
      req,
      "workspace_invitation_revoked",
      `Revoked invitation ${revoked.id} for ${revoked.email}`,
      {
        id: req.params.id,
        invitationId: revoked.id,
        invitationEmail: revoked.email,
        invitationRole: revoked.role,
      },
    );
    res.json(revoked);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
