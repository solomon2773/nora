const express = require("express");
const db = require("../db");
const { agentRuntimeUrl } = require("../../agent-runtime/lib/contracts");

const router = express.Router();

router.get("/:id/nemoclaw/status", async (req, res) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.sandbox_type !== "nemoclaw") return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    if (!agent.host || agent.status !== "running") return res.json({ status: agent.status, sandbox: null });

    const resp = await fetch(agentRuntimeUrl(agent.host, "/nemoclaw/status"));
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/nemoclaw/policy", async (req, res) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.sandbox_type !== "nemoclaw") return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    if (!agent.host || agent.status !== "running") return res.status(400).json({ error: "Agent is not running" });

    const resp = await fetch(agentRuntimeUrl(agent.host, "/nemoclaw/policy"));
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/nemoclaw/policy", async (req, res) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.sandbox_type !== "nemoclaw") return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    if (!agent.host || agent.status !== "running") return res.status(400).json({ error: "Agent is not running" });

    const resp = await fetch(agentRuntimeUrl(agent.host, "/nemoclaw/policy"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/nemoclaw/approvals", async (req, res) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.sandbox_type !== "nemoclaw") return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    if (!agent.host || agent.status !== "running") return res.json({ approvals: [] });

    const resp = await fetch(agentRuntimeUrl(agent.host, "/nemoclaw/approvals"));
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/nemoclaw/approvals/:rid", async (req, res) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (agent.sandbox_type !== "nemoclaw") return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    if (!agent.host || agent.status !== "running") return res.status(400).json({ error: "Agent is not running" });

    const resp = await fetch(agentRuntimeUrl(agent.host, `/nemoclaw/approvals/${req.params.rid}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
