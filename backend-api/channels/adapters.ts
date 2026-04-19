// @ts-nocheck
/**
 * Channel Adapters — each adapter handles a specific channel type
 * (send messages, verify config, format inbound webhooks).
 */

// ── SSRF Protection ──────────────────────────────────────
// Block user-supplied webhook URLs from targeting internal/private network
// addresses so that a malicious channel config cannot pivot into cluster-
// internal services (postgres, redis, worker-provisioner, cloud metadata).
// Keep in sync with PRIVATE_IP_RE / assertSafeUrl in integrations.ts.
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i;

function assertSafeWebhookUrl(rawUrl, label = "Webhook URL") {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http or https`);
  }
  if (PRIVATE_IP_RE.test(parsed.hostname)) {
    throw new Error(`${label} must not target internal or private network addresses`);
  }
  return parsed.toString();
}

// Safe header allowlist for the generic outbound webhook adapter. Custom
// headers supplied in channel config are filtered against this set so an
// attacker cannot forge Host/Authorization/etc. against internal services.
const WEBHOOK_CUSTOM_HEADER_ALLOWLIST = new Set([
  "x-webhook-secret",
  "x-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-api-key",
  "x-request-id",
  "x-correlation-id",
  "user-agent",
]);

function filterWebhookHeaders(customHeaders) {
  const filtered = {};
  if (!customHeaders || typeof customHeaders !== "object") return filtered;
  for (const [key, value] of Object.entries(customHeaders)) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    if (WEBHOOK_CUSTOM_HEADER_ALLOWLIST.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// ── Slack Adapter ────────────────────────────────────────

const slack = {
  type: "slack",
  label: "Slack",
  icon: "slack",

  configFields: [
    { key: "webhook_url", label: "Webhook URL", type: "url", required: true },
    { key: "channel", label: "Channel", type: "text", required: false },
    { key: "bot_token", label: "Bot Token", type: "password", required: false },
  ],

  async send(channel, message) {
    const rawUrl = channel.config.webhook_url;
    if (!rawUrl) throw new Error("Slack webhook URL not configured");
    const url = assertSafeWebhookUrl(rawUrl, "Slack webhook URL");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
    return { delivered: true };
  },

  async verify(config) {
    if (!config.webhook_url) return { valid: false, error: "Webhook URL required" };
    try {
      assertSafeWebhookUrl(config.webhook_url, "Slack webhook URL");
    } catch (e) {
      return { valid: false, error: e.message };
    }
    return { valid: true };
  },

  formatInbound(rawPayload) {
    return {
      content: rawPayload.event?.text || rawPayload.text || JSON.stringify(rawPayload),
      sender: rawPayload.event?.user || "slack",
      metadata: { channel: rawPayload.event?.channel },
    };
  },
};

// ── Discord Adapter ──────────────────────────────────────

const discord = {
  type: "discord",
  label: "Discord",
  icon: "discord",

  configFields: [
    { key: "webhook_url", label: "Webhook URL", type: "url", required: true },
    { key: "bot_token", label: "Bot Token", type: "password", required: false },
  ],

  async send(channel, message) {
    const rawUrl = channel.config.webhook_url;
    if (!rawUrl) throw new Error("Discord webhook URL not configured");
    const url = assertSafeWebhookUrl(rawUrl, "Discord webhook URL");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
    return { delivered: true };
  },

  async verify(config) {
    if (!config.webhook_url) return { valid: false, error: "Webhook URL required" };
    try {
      assertSafeWebhookUrl(config.webhook_url, "Discord webhook URL");
    } catch (e) {
      return { valid: false, error: e.message };
    }
    return { valid: true };
  },

  formatInbound(rawPayload) {
    return {
      content: rawPayload.content || JSON.stringify(rawPayload),
      sender: rawPayload.author?.username || "discord",
      metadata: { guild: rawPayload.guild_id, channel: rawPayload.channel_id },
    };
  },
};

// ── Email Adapter (SMTP) ─────────────────────────────────

const email = {
  type: "email",
  label: "Email (SMTP)",
  icon: "mail",

  configFields: [
    { key: "smtp_host", label: "SMTP Host", type: "text", required: true },
    { key: "smtp_port", label: "SMTP Port", type: "number", required: true },
    { key: "smtp_user", label: "Username", type: "text", required: true },
    { key: "smtp_pass", label: "Password", type: "password", required: true },
    { key: "from_address", label: "From Address", type: "email", required: true },
    { key: "to_address", label: "Default To Address", type: "email", required: false },
  ],

  async send(channel, message, opts = {}) {
    // Lightweight SMTP using nodemailer (if available) — or log
    try {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        host: channel.config.smtp_host,
        port: channel.config.smtp_port,
        secure: channel.config.smtp_port === 465,
        auth: { user: channel.config.smtp_user, pass: channel.config.smtp_pass },
      });
      await transporter.sendMail({
        from: channel.config.from_address,
        to: opts.to || channel.config.to_address,
        subject: opts.subject || "OpenClaw Agent Message",
        text: message,
      });
      return { delivered: true };
    } catch (e) {
      return { delivered: false, error: e.message };
    }
  },

  async verify(config) {
    if (!config.smtp_host || !config.smtp_user) return { valid: false, error: "SMTP host and user required" };
    return { valid: true };
  },

  formatInbound(rawPayload) {
    return {
      content: rawPayload.text || rawPayload.body || JSON.stringify(rawPayload),
      sender: rawPayload.from || "email",
      metadata: { subject: rawPayload.subject },
    };
  },
};

// ── Webhook Adapter (generic outbound HTTP) ──────────────

const webhook = {
  type: "webhook",
  label: "Webhook",
  icon: "globe",

  configFields: [
    { key: "url", label: "Webhook URL", type: "url", required: true },
    { key: "method", label: "HTTP Method", type: "select", options: ["POST", "PUT"], required: false },
    { key: "headers", label: "Custom Headers (JSON)", type: "textarea", required: false },
    { key: "secret", label: "Signing Secret", type: "password", required: false },
  ],

  async send(channel, message) {
    const rawUrl = channel.config.url;
    if (!rawUrl) throw new Error("Webhook URL not configured");
    const url = assertSafeWebhookUrl(rawUrl, "Webhook URL");
    const method = channel.config.method || "POST";
    let headers = { "Content-Type": "application/json" };
    if (channel.config.headers) {
      try {
        headers = { ...headers, ...filterWebhookHeaders(JSON.parse(channel.config.headers)) };
      } catch { /* ignore parse errors */ }
    }
    const res = await fetch(url, {
      method,
      headers,
      body: JSON.stringify({ content: message, timestamp: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Webhook error: ${res.status}`);
    return { delivered: true };
  },

  async verify(config) {
    if (!config.url) return { valid: false, error: "URL required" };
    try {
      assertSafeWebhookUrl(config.url, "Webhook URL");
    } catch (e) {
      return { valid: false, error: e.message };
    }
    return { valid: true };
  },

  formatInbound(rawPayload) {
    return {
      content: rawPayload.content || rawPayload.message || JSON.stringify(rawPayload),
      sender: rawPayload.sender || "webhook",
      metadata: rawPayload,
    };
  },
};

// ── Microsoft Teams Adapter ──────────────────────────────

const teams = {
  type: "teams",
  label: "Microsoft Teams",
  icon: "message-square",

  configFields: [
    { key: "webhook_url", label: "Incoming Webhook URL", type: "url", required: true },
  ],

  async send(channel, message) {
    const rawUrl = channel.config.webhook_url;
    if (!rawUrl) throw new Error("Teams webhook URL not configured");
    const url = assertSafeWebhookUrl(rawUrl, "Teams webhook URL");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) throw new Error(`Teams API error: ${res.status}`);
    return { delivered: true };
  },

  async verify(config) {
    if (!config.webhook_url) return { valid: false, error: "Webhook URL required" };
    try {
      assertSafeWebhookUrl(config.webhook_url, "Teams webhook URL");
    } catch (e) {
      return { valid: false, error: e.message };
    }
    return { valid: true };
  },

  formatInbound(rawPayload) {
    return {
      content: rawPayload.text || JSON.stringify(rawPayload),
      sender: rawPayload.from?.name || "teams",
      metadata: {},
    };
  },
};

// ── SMS Adapter (Twilio) ─────────────────────────────────

const sms = {
  type: "sms",
  label: "SMS (Twilio)",
  icon: "smartphone",

  configFields: [
    { key: "account_sid", label: "Account SID", type: "text", required: true },
    { key: "auth_token", label: "Auth Token", type: "password", required: true },
    { key: "from_number", label: "From Number", type: "text", required: true },
    { key: "to_number", label: "Default To Number", type: "text", required: false },
  ],

  async send(channel, message, opts = {}) {
    const { account_sid, auth_token, from_number, to_number } = channel.config;
    const to = opts.to || to_number;
    if (!to) throw new Error("No recipient phone number");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${account_sid}:${auth_token}`).toString("base64"),
      },
      body: new URLSearchParams({ From: from_number, To: to, Body: message }),
    });
    if (!res.ok) throw new Error(`Twilio error: ${res.status}`);
    return { delivered: true };
  },

  async verify(config) {
    if (!config.account_sid || !config.auth_token || !config.from_number) {
      return { valid: false, error: "Account SID, Auth Token, and From Number required" };
    }
    return { valid: true };
  },

  formatInbound(rawPayload) {
    return {
      content: rawPayload.Body || JSON.stringify(rawPayload),
      sender: rawPayload.From || "sms",
      metadata: { from: rawPayload.From, to: rawPayload.To },
    };
  },
};

// ── WhatsApp Adapter (Cloud API) ─────────────────────────

const whatsapp = {
  type: "whatsapp",
  label: "WhatsApp",
  icon: "message-circle",

  configFields: [
    { key: "phone_number_id", label: "Phone Number ID", type: "text", required: true },
    { key: "access_token", label: "Access Token", type: "password", required: true },
    { key: "verify_token", label: "Webhook Verify Token", type: "text", required: false },
  ],

  async send(channel, message, opts = {}) {
    const { phone_number_id, access_token } = channel.config;
    const to = opts.to;
    if (!to) throw new Error("Recipient phone number required (pass opts.to)");
    const url = `https://graph.facebook.com/v18.0/${phone_number_id}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`WhatsApp API error: ${res.status} — ${err.error?.message || ""}`);
    }
    return { delivered: true };
  },

  async verify(config) {
    if (!config.phone_number_id || !config.access_token) {
      return { valid: false, error: "Phone Number ID and Access Token required" };
    }
    return { valid: true };
  },

  formatInbound(rawPayload, headers) {
    // WhatsApp Cloud API webhook payload
    const entry = rawPayload.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    return {
      content: msg?.text?.body || JSON.stringify(rawPayload),
      sender: msg?.from || "whatsapp",
      metadata: { wa_id: msg?.from, timestamp: msg?.timestamp, message_id: msg?.id },
    };
  },
};

// ── Telegram Adapter (Bot API) ───────────────────────────

const telegram = {
  type: "telegram",
  label: "Telegram",
  icon: "send",

  configFields: [
    { key: "bot_token", label: "Bot Token", type: "password", required: true },
    { key: "chat_id", label: "Default Chat ID", type: "text", required: false },
  ],

  async send(channel, message, opts = {}) {
    const { bot_token, chat_id } = channel.config;
    const target = opts.to || chat_id;
    if (!target) throw new Error("Chat ID required");
    const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target, text: message, parse_mode: "Markdown" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Telegram API error: ${res.status} — ${err.description || ""}`);
    }
    return { delivered: true };
  },

  async verify(config) {
    if (!config.bot_token) return { valid: false, error: "Bot Token required" };
    // Optionally call getMe to verify the token
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.bot_token}/getMe`);
      const data = await res.json();
      if (!data.ok) return { valid: false, error: data.description || "Invalid bot token" };
      return { valid: true, botUsername: data.result.username };
    } catch {
      return { valid: true }; // network error, assume valid
    }
  },

  formatInbound(rawPayload) {
    const msg = rawPayload.message || rawPayload.edited_message || {};
    return {
      content: msg.text || msg.caption || JSON.stringify(rawPayload),
      sender: msg.from?.username || msg.from?.first_name || "telegram",
      metadata: { chat_id: msg.chat?.id, message_id: msg.message_id, from: msg.from },
    };
  },
};

// ── LINE Adapter ─────────────────────────────────────────

const line = {
  type: "line",
  label: "LINE",
  icon: "message-square",

  configFields: [
    { key: "channel_access_token", label: "Channel Access Token", type: "password", required: true },
    { key: "channel_secret", label: "Channel Secret", type: "password", required: false },
    { key: "user_id", label: "Default User/Group ID", type: "text", required: false },
  ],

  async send(channel, message, opts = {}) {
    const { channel_access_token, user_id } = channel.config;
    const to = opts.to || user_id;
    if (!to) throw new Error("User or Group ID required");
    const url = "https://api.line.me/v2/bot/message/push";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channel_access_token}`,
      },
      body: JSON.stringify({
        to,
        messages: [{ type: "text", text: message }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`LINE API error: ${res.status} — ${err.message || ""}`);
    }
    return { delivered: true };
  },

  async verify(config) {
    if (!config.channel_access_token) return { valid: false, error: "Channel Access Token required" };
    return { valid: true };
  },

  formatInbound(rawPayload) {
    const event = rawPayload.events?.[0] || {};
    return {
      content: event.message?.text || JSON.stringify(rawPayload),
      sender: event.source?.userId || "line",
      metadata: { replyToken: event.replyToken, source: event.source },
    };
  },
};

// ── Registry ─────────────────────────────────────────────

const adapters = { slack, discord, email, webhook, teams, sms, whatsapp, telegram, line };

function getAdapter(type) {
  const adapter = adapters[type];
  if (!adapter) throw new Error(`Unknown channel type: ${type}`);
  return adapter;
}

function listAdapterTypes() {
  return Object.values(adapters).map((a) => ({
    type: a.type,
    label: a.label,
    icon: a.icon,
    configFields: a.configFields,
  }));
}

module.exports = { adapters, getAdapter, listAdapterTypes };
