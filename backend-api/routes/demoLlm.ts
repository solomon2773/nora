// @ts-nocheck
// OpenAI-compatible endpoints for the zero-key demo provider. Mounted PRE-auth
// (agent runtimes call this directly over the container network with the
// derived demo bearer token, not a JWT). Deterministic output, zero cost.

const express = require("express");
const {
  DEMO_MODEL_ID,
  deriveDemoToken,
  buildDemoReply,
  buildCompletionPayload,
  chunkReply,
} = require("../demoLlm");

const router = express.Router();

/**
 * Authenticate demo requests with the token derived from JWT secret or its fixed fallback.
 *
 * @param {Object} req - Express request containing bearer authorization.
 * @param {Object} res - Express response used for authentication failures.
 * @returns {boolean} Whether request processing may continue.
 */
function checkDemoAuth(req, res) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== deriveDemoToken()) {
    res
      .status(401)
      .json({ error: { message: "Invalid demo token", type: "invalid_request_error" } });
    return false;
  }
  return true;
}

// pi-ai/OpenAI clients may probe the model list.
router.get("/v1/models", (req, res) => {
  if (!checkDemoAuth(req, res)) return;
  res.json({
    object: "list",
    data: [{ id: DEMO_MODEL_ID, object: "model", owned_by: "nora-demo" }],
  });
});

router.post("/v1/chat/completions", (req, res) => {
  if (!checkDemoAuth(req, res)) return;
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const reply = buildDemoReply(messages);
  const model = typeof body.model === "string" && body.model ? body.model : DEMO_MODEL_ID;

  if (!body.stream) {
    return res.json(buildCompletionPayload(reply, { model }));
  }

  // SSE streaming with OpenAI delta framing. Chunked transfer is what the
  // gateway chat path expects; flush per event so deltas render live.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const id = `chatcmpl-nora-demo-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model };

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  for (const chunk of chunkReply(reply)) {
    send({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
});

module.exports = router;
