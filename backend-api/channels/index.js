/**
 * Channels module — CRUD + messaging for agent communication channels.
 */

const db = require("../db");
const { encrypt, decrypt, ensureEncryptionConfigured } = require("../crypto");
const { agentRuntimeUrl } = require("../../agent-runtime/lib/contracts");
const { getAdapter, listAdapterTypes } = require("./adapters");

const REDACTED_SECRET = "[REDACTED]";
const SECRET_CONFIG_KEY_RE = /(token|secret|password|webhook_url|smtp_pass|auth_token)/i;

function parseConfig(config) {
  return typeof config === "string" ? JSON.parse(config) : (config || {});
}

function getSensitiveChannelKeys(type) {
  const adapter = getAdapter(type);
  return new Set(
    (adapter.configFields || [])
      .filter((field) => field?.type === "password" || SECRET_CONFIG_KEY_RE.test(field?.key || ""))
      .map((field) => field.key)
  );
}

function protectChannelConfig(type, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveChannelKeys(type);
  const secured = { ...parsed };
  let hasSensitiveMaterial = false;

  for (const key of Object.keys(secured)) {
    const value = secured[key];
    if (!value) continue;
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      hasSensitiveMaterial = true;
      secured[key] = encrypt(String(value));
    }
  }

  return { secured, hasSensitiveMaterial };
}

function revealChannelConfig(type, config = {}) {
  const parsed = parseConfig(config);
  const sensitiveKeys = getSensitiveChannelKeys(type);
  const revealed = { ...parsed };

  for (const key of Object.keys(revealed)) {
    const value = revealed[key];
    if (!value) continue;
    if (sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) {
      revealed[key] = decrypt(String(value));
    }
  }

  return revealed;
}

function redactChannelConfig(type, config = {}) {
  const parsed = parseConfig(config);
  const redacted = { ...parsed };
  const sensitiveKeys = getSensitiveChannelKeys(type);

  for (const key of Object.keys(redacted)) {
    if ((sensitiveKeys.has(key) || SECRET_CONFIG_KEY_RE.test(key)) && redacted[key]) {
      redacted[key] = REDACTED_SECRET;
    }
  }

  return redacted;
}

function sanitizeChannel(channel) {
  if (!channel) return channel;
  return {
    ...channel,
    config: redactChannelConfig(channel.type, channel.config),
  };
}

function hydrateChannel(channel) {
  if (!channel) return channel;
  return {
    ...channel,
    config: revealChannelConfig(channel.type, channel.config),
  };
}

// ── Channel CRUD ─────────────────────────────────────────

async function listChannels(agentId) {
  const result = await db.query(
    "SELECT * FROM channels WHERE agent_id = $1 ORDER BY created_at DESC",
    [agentId]
  );
  return result.rows.map(sanitizeChannel);
}

async function createChannel(agentId, type, name, config = {}) {
  // Verify the adapter type exists
  getAdapter(type);
  const { secured, hasSensitiveMaterial } = protectChannelConfig(type, config);
  if (hasSensitiveMaterial) {
    ensureEncryptionConfigured("Channel credential storage");
  }
  const result = await db.query(
    "INSERT INTO channels(agent_id, type, name, config) VALUES($1, $2, $3, $4) RETURNING *",
    [agentId, type, name, JSON.stringify(secured)]
  );
  return sanitizeChannel(result.rows[0]);
}

async function updateChannel(channelId, agentId, updates) {
  const existingResult = await db.query(
    "SELECT * FROM channels WHERE id = $1 AND agent_id = $2",
    [channelId, agentId]
  );
  const existing = existingResult.rows[0];
  if (!existing) throw new Error("Channel not found");

  const sets = [];
  const params = [];
  let idx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(updates.name);
  }
  if (updates.config !== undefined) {
    const { secured, hasSensitiveMaterial } = protectChannelConfig(existing.type, updates.config);
    sets.push(`config = $${idx++}`);
    params.push(JSON.stringify(secured));
    if (hasSensitiveMaterial) {
      ensureEncryptionConfigured("Channel credential storage");
    }
  }
  if (updates.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    params.push(updates.enabled);
  }

  if (sets.length === 0) throw new Error("No fields to update");

  params.push(channelId, agentId);
  const result = await db.query(
    `UPDATE channels SET ${sets.join(", ")} WHERE id = $${idx++} AND agent_id = $${idx} RETURNING *`,
    params
  );
  if (!result.rows[0]) throw new Error("Channel not found");
  return sanitizeChannel(result.rows[0]);
}

async function deleteChannel(channelId, agentId) {
  const result = await db.query(
    "DELETE FROM channels WHERE id = $1 AND agent_id = $2 RETURNING id",
    [channelId, agentId]
  );
  if (!result.rows[0]) throw new Error("Channel not found");
}

// ── Messaging ────────────────────────────────────────────

async function sendMessage(channelId, content, metadata = {}) {
  const chResult = await db.query("SELECT * FROM channels WHERE id = $1", [channelId]);
  const channel = hydrateChannel(chResult.rows[0]);
  if (!channel) throw new Error("Channel not found");
  if (!channel.enabled) throw new Error("Channel is disabled");

  const adapter = getAdapter(channel.type);
  const result = await adapter.send(channel, content, metadata);

  // Log the outbound message
  await db.query(
    "INSERT INTO channel_messages(channel_id, direction, content, metadata) VALUES($1, 'outbound', $2, $3)",
    [channelId, content, JSON.stringify(metadata)]
  );

  return result;
}

async function getMessages(channelId, agentId, limit = 50) {
  const result = await db.query(
    `SELECT cm.*
     FROM channel_messages cm
     JOIN channels c ON c.id = cm.channel_id
     WHERE cm.channel_id = $1 AND c.agent_id = $2
     ORDER BY cm.created_at DESC
     LIMIT $3`,
    [channelId, agentId, limit]
  );
  return result.rows;
}

// ── Testing ──────────────────────────────────────────────

async function testChannel(channelId, agentId) {
  const chResult = await db.query(
    "SELECT * FROM channels WHERE id = $1 AND agent_id = $2",
    [channelId, agentId]
  );
  const channel = hydrateChannel(chResult.rows[0]);
  if (!channel) throw new Error("Channel not found");

  const adapter = getAdapter(channel.type);

  // First verify config
  const verification = await adapter.verify(channel.config);
  if (!verification.valid) return { success: false, error: verification.error };

  // Then try sending a test message
  try {
    await adapter.send(channel, `🦞 OpenClaw test message — ${new Date().toISOString()}`);
    return { success: true, message: "Test message sent successfully" };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Inbound Webhooks ─────────────────────────────────────

async function handleInboundWebhook(channelId, payload, headers) {
  const chResult = await db.query("SELECT * FROM channels WHERE id = $1", [channelId]);
  const channel = hydrateChannel(chResult.rows[0]);
  if (!channel) throw new Error("Channel not found");
  if (!channel.enabled) throw new Error("Channel is disabled");

  const adapter = getAdapter(channel.type);
  const formatted = adapter.formatInbound(payload);

  // Log the inbound message
  await db.query(
    "INSERT INTO channel_messages(channel_id, direction, content, metadata) VALUES($1, 'inbound', $2, $3)",
    [channelId, formatted.content, JSON.stringify({ sender: formatted.sender, ...formatted.metadata })]
  );

  // Forward to agent runtime if agent is running
  const agentResult = await db.query(
    "SELECT host FROM agents WHERE id = $1",
    [channel.agent_id]
  );
  const agent = agentResult.rows[0];
  if (agent?.host && agent.host !== "pending") {
    try {
      await fetch(agentRuntimeUrl(agent.host, "/channels/receive"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          channelType: channel.type,
          content: formatted.content,
          sender: formatted.sender,
          metadata: formatted.metadata,
        }),
      });
    } catch {
      // Agent may not be reachable — that's okay, message is already logged
    }
  }

  return { received: true };
}

// ── Channel Types ────────────────────────────────────────

function getChannelTypes() {
  return listAdapterTypes();
}

module.exports = {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  sendMessage,
  getMessages,
  testChannel,
  handleInboundWebhook,
  getChannelTypes,
  redactChannelConfig,
  sanitizeChannel,
  protectChannelConfig,
  revealChannelConfig,
  hydrateChannel,
};
