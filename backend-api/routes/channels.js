const express = require("express");
const channels = require("../channels");
const { requireOwnedAgent } = require("../middleware/ownership");

const router = express.Router();

router.use("/:id/channels", requireOwnedAgent("id"));

router.get("/:id/channels", async (req, res) => {
  try {
    res.json(await channels.listChannels(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/channels", async (req, res) => {
  try {
    const { type, name, config } = req.body;
    if (!type || !name) return res.status(400).json({ error: "type and name required" });
    const ch = await channels.createChannel(req.params.id, type, name, config);
    res.json(ch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id/channels/:cid", async (req, res) => {
  try {
    const ch = await channels.updateChannel(req.params.cid, req.params.id, req.body);
    res.json(ch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id/channels/:cid", async (req, res) => {
  try {
    await channels.deleteChannel(req.params.cid, req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/channels/:cid/test", async (req, res) => {
  try {
    const result = await channels.testChannel(req.params.cid, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/channels/:cid/messages", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json(await channels.getMessages(req.params.cid, req.params.id, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
