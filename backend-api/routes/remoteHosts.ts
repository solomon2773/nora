// @ts-nocheck
// Operator-facing remote-host registry routes (BYOC Phase A, A5).
//
// Each operator manages their OWN remote hosts (owner_user_id = req.user.id).
// Registering a host stores SSH credentials, so — like API-key minting — these
// routes are session-only (requireSession): an API key cannot create or read
// SSH credentials. Admin gets a separate read-only fleet view under /admin.

const express = require("express");
const remoteHosts = require("../remoteHosts");
const monitoring = require("../monitoring");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireSession } = require("../middleware/auth");

const router = express.Router();
router.use(requireSession);

/**
 * Load a caller-owned host, returning not-found semantics for foreign hosts.
 *
 * @param {Object} req - Authenticated request containing the remote-host id.
 * @returns {Promise<Object>} Masked host owned by the caller.
 */
async function loadOwnedHost(req) {
  const host = await remoteHosts.getRemoteHost(req.params.id);
  if (!host || host.ownerUserId !== req.user.id) {
    const error = new Error("Remote host not found");
    error.statusCode = 404;
    throw error;
  }
  return host;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    // Owned hosts (full management) + hosts shared into the caller's workspaces
    // (read-only; annotated with access + canDeploy).
    res.json(await remoteHosts.listAccessibleRemoteHosts(req.user.id));
  }),
);

// List the workspaces a host is shared into (owner only).
router.get(
  "/:id/shares",
  asyncHandler(async (req, res) => {
    await loadOwnedHost(req);
    res.json(
      await remoteHosts.listRemoteHostShares(req.params.id, {
        expectedOwnerUserId: req.user.id,
      }),
    );
  }),
);

// Share a host into a workspace. Owner only, and only into a workspace the owner
// is a member of (you can't share your host into someone else's workspace).
router.post(
  "/:id/shares",
  asyncHandler(async (req, res) => {
    const owned = await loadOwnedHost(req);
    const workspaceId = String((req.body || {}).workspace_id || (req.body || {}).workspaceId || "");
    if (!workspaceId) {
      return res.status(400).json({ error: "workspace_id is required" });
    }
    const share = await remoteHosts.shareRemoteHost(owned.id, workspaceId, req.user.id);
    await monitoring.logEvent(
      "remote_host_shared",
      `Shared remote host "${owned.label}" with workspace ${share?.workspaceName || workspaceId}`,
      { userId: req.user.id, remoteHost: { id: owned.id }, workspaceId },
    );
    res.status(201).json(
      await remoteHosts.listRemoteHostShares(owned.id, {
        expectedOwnerUserId: req.user.id,
      }),
    );
  }),
);

// Stop sharing a host with a workspace (owner only).
router.delete(
  "/:id/shares/:workspaceId",
  asyncHandler(async (req, res) => {
    const owned = await loadOwnedHost(req);
    await remoteHosts.unshareRemoteHost(owned.id, req.params.workspaceId, req.user.id);
    await monitoring.logEvent(
      "remote_host_unshared",
      `Stopped sharing remote host "${owned.label}"`,
      { userId: req.user.id, remoteHost: { id: owned.id }, workspaceId: req.params.workspaceId },
    );
    res.json(
      await remoteHosts.listRemoteHostShares(owned.id, {
        expectedOwnerUserId: req.user.id,
      }),
    );
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const host = await remoteHosts.createRemoteHost({
      ...(req.body || {}),
      ownerUserId: req.user.id,
    });
    await monitoring.logEvent("remote_host_registered", `Registered remote host "${host.label}"`, {
      userId: req.user.id,
      remoteHost: { id: host.id, label: host.label },
    });
    res.status(201).json(host);
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    await loadOwnedHost(req);
    // ownerUserId is pinned to the caller — a host cannot be reassigned.
    const host = await remoteHosts.updateRemoteHost(
      req.params.id,
      {
        ...(req.body || {}),
        ownerUserId: req.user.id,
      },
      {
        expectedOwnerUserId: req.user.id,
      },
    );
    res.json(host);
  }),
);

router.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    const owned = await loadOwnedHost(req);
    const host = await remoteHosts.testRemoteHost(req.params.id, {
      expectedOwnerUserId: req.user.id,
    });
    await monitoring.logEvent(
      "remote_host_tested",
      `Tested remote host "${owned.label}" (${host.lastTestStatus})`,
      { userId: req.user.id, remoteHost: { id: host.id, status: host.lastTestStatus } },
    );
    res.json(host);
  }),
);

router.post(
  "/:id/reset-host-key",
  asyncHandler(async (req, res) => {
    const owned = await loadOwnedHost(req);
    const host = await remoteHosts.resetRemoteHostHostKeyPin(
      req.params.id,
      (req.body || {}).confirmation,
      { expectedOwnerUserId: req.user.id },
    );
    await monitoring.logEvent(
      "remote_host_ssh_pin_reset",
      `Reset the pinned SSH host key for remote host "${owned.label}"`,
      {
        userId: req.user.id,
        remoteHost: { id: owned.id, label: owned.label },
        previousTestStatus: owned.lastTestStatus || null,
      },
    );
    res.json(host);
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await loadOwnedHost(req);
    const host = await remoteHosts.deleteRemoteHost(req.params.id, {
      expectedOwnerUserId: req.user.id,
    });
    await monitoring.logEvent("remote_host_deleted", `Deleted remote host "${host.label}"`, {
      userId: req.user.id,
      remoteHost: { id: host.id, label: host.label },
    });
    res.json(host);
  }),
);

module.exports = router;
