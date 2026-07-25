// @ts-nocheck
const express = require("express");
const channels = require("../channels");
const { getAdapter, listAdapterTypes } = require("../channels/adapters");
const {
  connectOpenClawChannel,
  getOpenClawChannelType,
  listOpenClawChannels,
  logoutOpenClawChannel,
  saveOpenClawChannel,
  startOpenClawChannelLogin,
  waitOpenClawChannelLogin,
} = require("../channels/openclaw");
const { resolveAgentRuntimeFamily } = require("../agentRuntimeFields");
const { requireOwnedAgent } = require("../middleware/ownership");
const { scopeByMethod } = require("../middleware/auth");

const router = express.Router();

router.use("/:id/channels", scopeByMethod("integrations:read", "integrations:write"));
router.use("/:id/channels", requireOwnedAgent("id"));

function normalizeChannelType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isOpenClawAgent(agent = {}) {
  return resolveAgentRuntimeFamily(agent) === "openclaw";
}

function buildLegacyTypeMeta(entry = {}) {
  return {
    id: entry.type,
    type: entry.type,
    label: entry.label || entry.type,
    title: entry.label || entry.type,
    detailLabel: entry.label || entry.type,
    icon: entry.icon || null,
    configFields: Array.isArray(entry.configFields)
      ? entry.configFields.map((field) => ({
          ...field,
          options: Array.isArray(field?.options)
            ? field.options.map((option) =>
                typeof option === "object" ? option : { label: String(option), value: option },
              )
            : [],
        }))
      : [],
    hasComplexFields: false,
    actions: {
      canQrLogin: false,
      canLogout: false,
    },
  };
}

function buildLegacyChannel(channel = {}, typeMeta = {}) {
  return {
    ...channel,
    selectionLabel: typeMeta.label || channel.type,
    detailLabel: typeMeta.detailLabel || typeMeta.label || channel.type,
    icon: typeMeta.icon || null,
    configured: true,
    readOnly: false,
    status: {
      state: channel.enabled === false ? "disabled" : "configured",
      connected: false,
      running: false,
      healthState: null,
      lastError: null,
      lastConnectedAt: null,
      lastProbeAt: null,
    },
    actions: {
      canEdit: true,
      canToggle: true,
      canDelete: true,
      canTest: true,
      canViewMessages: true,
      canQrLogin: false,
      canLogout: false,
    },
  };
}

/**
 * Project database-backed adapters into the same channel payload shape used by OpenClaw.
 *
 * @param {string} agentId - Agent whose legacy channels should be listed.
 * @returns {Promise<Object>} Unified channels, capabilities, and type metadata.
 */
async function listLegacyChannelsPayload(agentId) {
  const [channelRows, availableTypes] = await Promise.all([
    channels.listChannels(agentId),
    Promise.resolve(listAdapterTypes()),
  ]);

  const typeMetaByType = new Map(
    availableTypes.map((entry) => [entry.type, buildLegacyTypeMeta(entry)]),
  );

  return {
    runtime: "legacy",
    title: "Channels",
    description: "Nora manages built-in channel adapters here.",
    capabilities: {
      supportsTesting: true,
      supportsMessageHistory: true,
      supportsArbitraryNames: true,
      supportsLazyTypeDefinitions: false,
    },
    channels: channelRows.map((channel) =>
      buildLegacyChannel(channel, typeMetaByType.get(channel.type) || {}),
    ),
    availableTypes: availableTypes.map(buildLegacyTypeMeta),
  };
}

function sendError(res, error, fallbackMessage) {
  res.status(error?.statusCode || 500).json({
    error: error?.message || fallbackMessage,
  });
}

router.get("/:id/channels", async (req, res) => {
  try {
    if (isOpenClawAgent(req.agent)) {
      res.json(await listOpenClawChannels(req.agent));
      return;
    }

    res.json(await listLegacyChannelsPayload(req.params.id));
  } catch (e) {
    sendError(res, e, "Failed to load channels");
  }
});

router.get("/:id/channels/types/:type", async (req, res) => {
  try {
    const type = normalizeChannelType(req.params.type);
    if (!type) {
      return res.status(400).json({ error: "Channel type required" });
    }

    if (isOpenClawAgent(req.agent)) {
      res.json(await getOpenClawChannelType(req.agent, type));
      return;
    }

    const adapter = getAdapter(type);
    res.json(buildLegacyTypeMeta(adapter));
  } catch (e) {
    if (/unknown channel type/i.test(String(e?.message || ""))) {
      return res.status(404).json({ error: e.message });
    }
    sendError(res, e, "Failed to load channel type");
  }
});

router.post("/:id/channels", async (req, res) => {
  try {
    const type = normalizeChannelType(req.body?.type);
    if (!type) {
      return res.status(400).json({ error: "Channel type required" });
    }

    if (isOpenClawAgent(req.agent)) {
      const result = await saveOpenClawChannel(req.agent, type, req.body, {
        create: true,
      });
      res.json(result);
      return;
    }

    const { name, config } = req.body;
    if (!name) {
      return res.status(400).json({ error: "type and name required" });
    }
    const ch = await channels.createChannel(req.params.id, type, name, config);
    res.json(ch);
  } catch (e) {
    sendError(res, e, "Failed to create channel");
  }
});

router.patch("/:id/channels/:cid", async (req, res) => {
  try {
    if (isOpenClawAgent(req.agent)) {
      res.json(
        await saveOpenClawChannel(req.agent, normalizeChannelType(req.params.cid), req.body),
      );
      return;
    }

    const ch = await channels.updateChannel(req.params.cid, req.params.id, req.body);
    res.json(ch);
  } catch (e) {
    sendError(res, e, "Failed to update channel");
  }
});

router.delete("/:id/channels/:cid", async (req, res) => {
  try {
    if (isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "OpenClaw channels cannot be deleted from Nora. Disable the channel instead.",
      });
    }

    await channels.deleteChannel(req.params.cid, req.params.id);
    res.json({ success: true });
  } catch (e) {
    sendError(res, e, "Failed to delete channel");
  }
});

router.post("/:id/channels/:cid/connect", async (req, res) => {
  try {
    if (!isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "Channel connect is only available for OpenClaw managed channels.",
      });
    }

    res.json(
      await connectOpenClawChannel(req.agent, normalizeChannelType(req.params.cid), req.body || {}),
    );
  } catch (e) {
    sendError(res, e, "Failed to connect channel");
  }
});

router.post("/:id/channels/:cid/login", async (req, res) => {
  try {
    if (!isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "QR login is only available for OpenClaw managed channels.",
      });
    }

    res.json(
      await startOpenClawChannelLogin(
        req.agent,
        normalizeChannelType(req.params.cid),
        req.body || {},
      ),
    );
  } catch (e) {
    sendError(res, e, "Failed to start channel login");
  }
});

router.post("/:id/channels/:cid/login/wait", async (req, res) => {
  try {
    if (!isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "QR login is only available for OpenClaw managed channels.",
      });
    }

    res.json(
      await waitOpenClawChannelLogin(
        req.agent,
        normalizeChannelType(req.params.cid),
        req.body || {},
      ),
    );
  } catch (e) {
    sendError(res, e, "Failed to check channel login");
  }
});

router.post("/:id/channels/:cid/logout", async (req, res) => {
  try {
    if (!isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "Logout is only available for OpenClaw managed channels.",
      });
    }

    res.json(
      await logoutOpenClawChannel(req.agent, normalizeChannelType(req.params.cid), req.body || {}),
    );
  } catch (e) {
    sendError(res, e, "Failed to logout channel");
  }
});

router.post("/:id/channels/:cid/test", async (req, res) => {
  try {
    if (isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "Channel testing is not available for OpenClaw managed channels.",
      });
    }

    const result = await channels.testChannel(req.params.cid, req.params.id);
    res.json(result);
  } catch (e) {
    sendError(res, e, "Failed to test channel");
  }
});

router.get("/:id/channels/:cid/messages", async (req, res) => {
  try {
    if (isOpenClawAgent(req.agent)) {
      return res.status(409).json({
        error: "Message history is not available for OpenClaw managed channels.",
      });
    }

    const limit = parseInt(req.query.limit) || 50;
    res.json(await channels.getMessages(req.params.cid, req.params.id, limit));
  } catch (e) {
    sendError(res, e, "Failed to load channel messages");
  }
});

module.exports = router;
