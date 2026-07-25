// @ts-nocheck
// Zero-key demo LLM: a deterministic OpenAI-compatible stub served by the
// backend itself, so a fresh install can deploy a working agent and see a chat
// round-trip before adding any real provider key.
//
// The demo "provider" rides the existing LLM provider machinery end to end:
// adding provider id "demo" stores a derived token as the api key and the stub
// URL as config.baseUrl, the worker decrypts/injects them like any provider
// (NORA_DEMO_LLM_TOKEN + NORA_DEMO_LLM_BASE_URL), and the runtime registers an
// openai-completions custom provider pointing back at this stub.

const crypto = require("crypto");

const DEMO_PROVIDER_ID = "demo";
const DEMO_MODEL_ID = "nora-demo-1";

/**
 * Derive a deterministic demo bearer token from the JWT secret, using a fixed
 * demo seed when unset so backend and worker still agree. This token only gates
 * canned stub traffic and is not a provider-security boundary.
 *
 * @param {Object} [env=process.env] - Environment containing the JWT secret.
 * @returns {string} Deterministic demo token.
 */
function deriveDemoToken(env = process.env) {
  return crypto
    .createHmac("sha256", String(env.JWT_SECRET || "nora-demo"))
    .update("nora-demo-llm-v1")
    .digest("hex");
}

/**
 * Resolve the demo endpoint as reachable from agent containers, not browsers.
 *
 * @param {Object} [env=process.env] - Runtime backend URL configuration.
 * @returns {string} Container-reachable OpenAI-compatible base URL.
 */
function demoLlmBaseUrl(env = process.env) {
  const backendUrl =
    env.AGENT_RUNTIME_BACKEND_API_URL || env.BACKEND_API_URL || "http://backend-api:4000";
  return `${String(backendUrl).replace(/\/+$/, "")}/demo-llm/v1`;
}

function lastUserMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.find((p) => p?.type === "text");
      if (text?.text) return text.text;
    }
  }
  return "";
}

/**
 * Build deterministic zero-cost demo text from the most recent user message.
 *
 * @param {Array} [messages=[]] - OpenAI-style conversation messages.
 * @returns {string} Stable demo-agent reply.
 */
function buildDemoReply(messages = []) {
  const userText = lastUserMessage(messages).trim();
  const intro =
    "Hi! I'm Nora's demo agent, running on a built-in stub model — no API key required.";
  if (!userText) {
    return `${intro} Say anything and I'll echo a deterministic response. When you're ready for real intelligence, add an LLM provider key under Providers and redeploy.`;
  }
  return [
    intro,
    "",
    `You said: "${userText}"`,
    "",
    "This response is generated locally by your Nora control plane (deterministic, zero cost). To chat with a real model, add a provider key under Providers and switch this agent off the demo provider.",
  ].join("\n");
}

/**
 * Wrap a reply in an OpenAI chat-completions envelope, allowing stable caller
 * identifiers and timestamps for deterministic tests.
 *
 * @param {string} reply - Assistant text to return.
 * @param {Object} [options={}] - Model, timestamp, and response id overrides.
 * @returns {Object} OpenAI-compatible completion payload.
 */
function buildCompletionPayload(reply, { model = DEMO_MODEL_ID, created, id } = {}) {
  return {
    id: id || `chatcmpl-nora-demo-${crypto.randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Split reply text into whitespace-preserving word groups for SSE delta framing.
 *
 * @param {string} reply - Reply text to stream.
 * @param {number} [chunkWords=6] - Approximate words per chunk.
 * @returns {Array} Ordered text chunks.
 */
function chunkReply(reply, chunkWords = 6) {
  const words = String(reply).split(/(\s+)/); // keep whitespace tokens
  const chunks = [];
  let current = "";
  let count = 0;
  for (const token of words) {
    current += token;
    if (/\S/.test(token)) count += 1;
    if (count >= chunkWords) {
      chunks.push(current);
      current = "";
      count = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  DEMO_PROVIDER_ID,
  DEMO_MODEL_ID,
  deriveDemoToken,
  demoLlmBaseUrl,
  buildDemoReply,
  buildCompletionPayload,
  chunkReply,
};
