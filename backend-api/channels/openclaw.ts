// @ts-nocheck
const { rpcCall } = require("../gatewayProxy");
const { resolveAgentRuntimeFamily } = require("../agentRuntimeFields");
const { OPENCLAW_GATEWAY_PORT } = require("../../agent-runtime/lib/contracts");
const db = require("../db");
const { encrypt, ensureEncryptionConfigured } = require("../crypto");

const REDACTED_SECRET = "[REDACTED]";
const OPENCLAW_RUNTIME_READY_STATUSES = new Set(["running", "warning"]);
const OPENCLAW_WEB_LOGIN_CHANNELS = new Set(["whatsapp"]);
const OPENCLAW_CLI_LOGIN_CHANNELS = new Set(["feishu", "zalouser"]);
const OPENCLAW_QR_LOGIN_CHANNELS = new Set([
  ...OPENCLAW_WEB_LOGIN_CHANNELS,
  ...OPENCLAW_CLI_LOGIN_CHANNELS,
]);
const OPENCLAW_LOGOUT_CHANNELS = new Set(["telegram", "qqbot", "whatsapp"]);
const OPENCLAW_DEFAULT_CHANNEL_IDS = Object.freeze([
  "bluebubbles",
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "mattermost",
  "matrix",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "qqbot",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "yuanbao",
  "zalo",
  "zalouser",
]);
const OPENCLAW_QR_LOGIN_PROVIDERS = Object.freeze({
  whatsapp: Object.freeze({
    pluginId: "whatsapp",
    installSpec: "whatsapp",
    fallbackSpec: "@openclaw/whatsapp",
    packageSpec: "@openclaw/whatsapp",
  }),
});
const OPENCLAW_GATEWAY_RESTART_RETRY_DELAYS_MS = Object.freeze([
  0, 750, 1500, 3000, 5000, 8000, 12000,
]);
const OPENCLAW_SELECTION_LABELS = Object.freeze({
  feishu: "Feishu/Lark (飞书)",
  googlechat: "Google Chat (Chat API)",
  nostr: "Nostr",
  msteams: "Microsoft Teams (Bot Framework)",
  mattermost: "Mattermost (plugin)",
  "nextcloud-talk": "Nextcloud Talk (self-hosted)",
  matrix: "Matrix (plugin)",
  bluebubbles: "BlueBubbles (macOS app)",
  line: "LINE (Messaging API)",
  zalo: "Zalo (Bot API)",
  zalouser: "Zalo (Personal Account)",
  "synology-chat": "Synology Chat (Webhook)",
  tlon: "Tlon (Urbit)",
  discord: "Discord (Bot API)",
  imessage: "iMessage (imsg)",
  irc: "IRC (Server + Nick)",
  qqbot: "QQ Bot",
  signal: "Signal (signal-cli)",
  slack: "Slack",
  telegram: "Telegram (Bot API)",
  twitch: "Twitch (Chat)",
  whatsapp: "WhatsApp (QR link)",
  yuanbao: "Yuanbao",
});
const OPENCLAW_CHANNEL_SEEDS = Object.freeze({
  whatsapp: Object.freeze({
    enabled: true,
    accounts: Object.freeze({
      default: Object.freeze({ enabled: true }),
    }),
  }),
  zalouser: Object.freeze({ enabled: true }),
});
const OPENCLAW_CLI_LOGIN_STATE_ROOT = "/tmp/nora-openclaw-channel-login";
const OPENCLAW_CLI_LOGIN_OUTPUT_MARKER = "__NORA_OPENCLAW_LOGIN_OUTPUT__";
const OPENCLAW_CLI_LOGIN_STATUS_MARKER = "__NORA_OPENCLAW_LOGIN_STATUS__";
const OPENCLAW_CHANNEL_SETUP_DEFINITIONS = Object.freeze({
  bluebubbles: Object.freeze({
    description: "Connect to a BlueBubbles macOS server.",
    configFields: Object.freeze([
      {
        key: "serverUrl",
        label: "Server URL",
        type: "url",
        required: true,
        placeholder: "http://192.168.1.100:1234",
        help: "BlueBubbles Server Web API URL.",
      },
      {
        key: "password",
        label: "API Password",
        type: "password",
        required: true,
        help: "Password from BlueBubbles Server settings.",
      },
      {
        key: "webhookPath",
        label: "Webhook Path",
        type: "text",
        defaultValue: "/bluebubbles-webhook",
        placeholder: "/bluebubbles-webhook",
      },
    ]),
  }),
  discord: Object.freeze({
    description: "Create a Discord application and bot, then paste the bot token.",
    configFields: Object.freeze([
      {
        key: "token",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "Discord bot token",
      },
      {
        key: "applicationId",
        label: "Application ID",
        type: "text",
        required: false,
        help: "Optional Discord application/client ID.",
      },
    ]),
  }),
  googlechat: Object.freeze({
    description: "Configure the Google Chat service account and webhook audience.",
    configFields: Object.freeze([
      {
        key: "serviceAccount",
        label: "Service Account JSON",
        type: "json",
        required: true,
        placeholder: '{\n  "type": "service_account"\n}',
        help: "Paste the downloaded Google service-account JSON.",
      },
      {
        key: "audienceType",
        label: "Audience Type",
        type: "select",
        required: true,
        defaultValue: "app-url",
        options: [
          { label: "App URL", value: "app-url" },
          { label: "Project Number", value: "project-number" },
        ],
      },
      {
        key: "audience",
        label: "Audience",
        type: "text",
        required: true,
        placeholder: "https://gateway.example.com/googlechat",
      },
      {
        key: "webhookPath",
        label: "Webhook Path",
        type: "text",
        defaultValue: "/googlechat",
        placeholder: "/googlechat",
      },
    ]),
  }),
  imessage: Object.freeze({
    description:
      "Legacy iMessage setup through the imsg CLI. BlueBubbles is recommended for new deployments.",
    configFields: Object.freeze([
      {
        key: "cliPath",
        label: "CLI Path",
        type: "text",
        defaultValue: "imsg",
        placeholder: "imsg",
      },
      {
        key: "dbPath",
        label: "Messages DB Path",
        type: "text",
        defaultValue: "~/Library/Messages/chat.db",
        placeholder: "~/Library/Messages/chat.db",
      },
      {
        key: "remoteHost",
        label: "Remote Host",
        type: "text",
        required: false,
        placeholder: "user@gateway-host",
      },
    ]),
  }),
  irc: Object.freeze({
    description: "Connect an IRC bot user to one or more channels.",
    configFields: Object.freeze([
      { key: "host", label: "Server Host", type: "text", required: true },
      { key: "port", label: "Port", type: "integer", required: true, defaultValue: 6697 },
      { key: "tls", label: "Use TLS", type: "boolean", defaultValue: true },
      { key: "nick", label: "Nickname", type: "text", required: true },
      {
        key: "channels",
        label: "Channels",
        type: "list",
        required: true,
        itemType: "string",
        placeholder: "#openclaw",
      },
    ]),
  }),
  line: Object.freeze({
    description: "Configure LINE Messaging API credentials.",
    configFields: Object.freeze([
      {
        key: "channelAccessToken",
        label: "Channel Access Token",
        type: "password",
        required: true,
      },
      { key: "channelSecret", label: "Channel Secret", type: "password", required: true },
      {
        key: "webhookPath",
        label: "Webhook Path",
        type: "text",
        defaultValue: "/line/webhook",
        placeholder: "/line/webhook",
      },
    ]),
  }),
  mattermost: Object.freeze({
    description: "Configure a Mattermost bot token and server URL.",
    configFields: Object.freeze([
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        required: true,
        placeholder: "https://chat.example.com",
      },
      { key: "botToken", label: "Bot Token", type: "password", required: true },
    ]),
  }),
  matrix: Object.freeze({
    description: "Configure Matrix access-token authentication.",
    configFields: Object.freeze([
      {
        key: "homeserver",
        label: "Homeserver URL",
        type: "url",
        required: true,
        placeholder: "https://matrix.example.org",
      },
      { key: "accessToken", label: "Access Token", type: "password", required: true },
      {
        key: "userId",
        label: "User ID",
        type: "text",
        required: false,
        placeholder: "@bot:example.org",
      },
    ]),
  }),
  msteams: Object.freeze({
    description: "Configure Microsoft Teams bot credentials and webhook endpoint.",
    configFields: Object.freeze([
      { key: "appId", label: "App ID", type: "text", required: true },
      { key: "appPassword", label: "App Password", type: "password", required: true },
      { key: "tenantId", label: "Tenant ID", type: "text", required: true },
      {
        key: "webhook.path",
        label: "Webhook Path",
        type: "text",
        defaultValue: "/api/messages",
      },
      {
        key: "webhook.port",
        label: "Webhook Port",
        type: "integer",
        defaultValue: 3978,
      },
    ]),
  }),
  "nextcloud-talk": Object.freeze({
    description: "Configure a Nextcloud Talk bot shared secret.",
    configFields: Object.freeze([
      {
        key: "baseUrl",
        label: "Base URL",
        type: "url",
        required: true,
        placeholder: "https://cloud.example.com",
      },
      { key: "botSecret", label: "Bot Secret", type: "password", required: true },
      {
        key: "webhookPublicUrl",
        label: "Webhook Public URL",
        type: "url",
        required: false,
        placeholder: "https://gateway.example.com/nextcloud-talk",
      },
    ]),
  }),
  nostr: Object.freeze({
    description: "Configure a Nostr private key for encrypted direct messages.",
    configFields: Object.freeze([
      { key: "privateKey", label: "Private Key", type: "password", required: true },
      {
        key: "relays",
        label: "Relay URLs",
        type: "list",
        itemType: "string",
        required: false,
        defaultValue: ["wss://relay.damus.io", "wss://nos.lol"],
      },
    ]),
  }),
  qqbot: Object.freeze({
    description: "Configure QQ Bot AppID and AppSecret.",
    configFields: Object.freeze([
      { key: "appId", label: "App ID", type: "text", required: true },
      { key: "clientSecret", label: "App Secret", type: "password", required: true },
    ]),
  }),
  signal: Object.freeze({
    description: "Configure a signal-cli account already linked or registered on the gateway host.",
    configFields: Object.freeze([
      {
        key: "account",
        label: "Signal Account",
        type: "text",
        required: true,
        placeholder: "+15551234567",
      },
      { key: "cliPath", label: "signal-cli Path", type: "text", defaultValue: "signal-cli" },
    ]),
  }),
  slack: Object.freeze({
    description: "Configure Slack Socket Mode or HTTP Request URL credentials.",
    configFields: Object.freeze([
      {
        key: "mode",
        label: "Mode",
        type: "select",
        required: true,
        defaultValue: "socket",
        options: [
          { label: "Socket Mode", value: "socket" },
          { label: "HTTP Request URLs", value: "http" },
        ],
      },
      { key: "botToken", label: "Bot Token", type: "password", required: true },
      {
        key: "appToken",
        label: "App-Level Token",
        type: "password",
        requiredWhen: { key: "mode", value: "socket" },
        help: "Required for Socket Mode.",
      },
      {
        key: "signingSecret",
        label: "Signing Secret",
        type: "password",
        requiredWhen: { key: "mode", value: "http" },
        help: "Required for HTTP Request URL mode.",
      },
      {
        key: "webhookPath",
        label: "Webhook Path",
        type: "text",
        defaultValue: "/slack/events",
        requiredWhen: { key: "mode", value: "http" },
      },
    ]),
  }),
  "synology-chat": Object.freeze({
    description: "Configure Synology Chat incoming and outgoing webhook credentials.",
    configFields: Object.freeze([
      { key: "token", label: "Outgoing Webhook Token", type: "password", required: true },
      {
        key: "incomingUrl",
        label: "Incoming Webhook URL",
        type: "url",
        required: true,
      },
      {
        key: "webhookPath",
        label: "Webhook Path",
        type: "text",
        defaultValue: "/webhook/synology",
      },
    ]),
  }),
  telegram: Object.freeze({
    description: "Create a Telegram bot with BotFather, then paste the bot token.",
    configFields: Object.freeze([
      {
        key: "botToken",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "123456:ABC-DEF...",
      },
    ]),
  }),
  tlon: Object.freeze({
    description: "Configure a Tlon ship and login code.",
    configFields: Object.freeze([
      { key: "ship", label: "Ship", type: "text", required: true, placeholder: "~sampel-palnet" },
      {
        key: "url",
        label: "Ship URL",
        type: "url",
        required: true,
        placeholder: "https://your-ship-host",
      },
      { key: "code", label: "Login Code", type: "password", required: true },
      { key: "ownerShip", label: "Owner Ship", type: "text", required: false },
    ]),
  }),
  twitch: Object.freeze({
    description: "Configure a Twitch bot account and target chat channel.",
    configFields: Object.freeze([
      { key: "username", label: "Bot Username", type: "text", required: true },
      { key: "accessToken", label: "Access Token", type: "password", required: true },
      { key: "clientId", label: "Client ID", type: "text", required: true },
      { key: "channel", label: "Twitch Channel", type: "text", required: true },
    ]),
  }),
  yuanbao: Object.freeze({
    description: "Configure Tencent Yuanbao robot credentials.",
    configFields: Object.freeze([
      { key: "appKey", label: "App Key", type: "text", required: true },
      { key: "appSecret", label: "App Secret", type: "password", required: true },
    ]),
  }),
  zalo: Object.freeze({
    description: "Configure a Zalo Bot API token.",
    configFields: Object.freeze([
      {
        key: "accounts.default.botToken",
        label: "Bot Token",
        type: "password",
        required: true,
      },
    ]),
  }),
});
const SECRET_LIKE_PATH_RE = /(^|\.)(token|secret|password|credential|auth|key)(\.|$)/i;
const MAX_SCHEMA_FIELD_DEPTH = 3;

// Shared config and gateway helpers

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Recursively redact string values whose config path appears credential-bearing.
 *
 * @param {*} value - Configuration value to sanitize.
 * @param {string} [path=""] - Current dotted path during recursion.
 * @returns {*} Cloned value with sensitive strings replaced.
 */
function redactSensitiveConfig(value, path = "") {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactSensitiveConfig(entry, path ? `${path}.${index}` : String(index)),
    );
  }

  if (isPlainObject(value)) {
    const redacted = {};
    for (const [key, nextValue] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      redacted[key] = redactSensitiveConfig(nextValue, nextPath);
    }
    return redacted;
  }

  if (typeof value === "string" && value && SECRET_LIKE_PATH_RE.test(path)) {
    return REDACTED_SECRET;
  }

  return value;
}

function restoreRedactedConfigValue(nextValue, currentValue) {
  if (nextValue === REDACTED_SECRET) {
    return currentValue;
  }

  if (Array.isArray(nextValue)) {
    const currentItems = Array.isArray(currentValue) ? currentValue : [];
    return nextValue.map((entry, index) => restoreRedactedConfigValue(entry, currentItems[index]));
  }

  if (isPlainObject(nextValue)) {
    const currentObject = isPlainObject(currentValue) ? currentValue : {};
    return Object.fromEntries(
      Object.entries(nextValue).map(([key, value]) => [
        key,
        restoreRedactedConfigValue(value, currentObject[key]),
      ]),
    );
  }

  return nextValue;
}

// Ignore `__proto__`, `constructor`, and `prototype` so a JSON payload can't
// reach Object.prototype through this merge — JSON.parse exposes `__proto__`
// as an own property, and our config patches flow from DB rows that
// originated as user input.
const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Merge nested channel config while replacing arrays and ignoring prototype-pollution keys.
 *
 * @param {*} target - Existing configuration value.
 * @param {*} patch - User-supplied patch value.
 * @returns {*} Merged clone.
 */
function deepMerge(target, patch) {
  if (!isPlainObject(patch)) {
    return Array.isArray(patch) ? cloneJson(patch) : patch;
  }

  const next = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      next[key] = cloneJson(value);
      continue;
    }
    if (isPlainObject(value)) {
      next[key] = deepMerge(next[key], value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function normalizeSchemaType(value) {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === "string" && entry !== "null") || null;
  }
  return typeof value === "string" ? value : null;
}

function humanizeChannelId(channelId) {
  return (
    String(channelId || "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase()) || "Channel"
  );
}

function buildSelectionLabel(channelId, meta = {}) {
  return (
    OPENCLAW_SELECTION_LABELS[channelId] ||
    meta.selectionLabel ||
    meta.detailLabel ||
    meta.label ||
    humanizeChannelId(channelId)
  );
}

function buildTypeTitle(channelId, meta = {}) {
  return meta.label || humanizeChannelId(channelId);
}

function serializeTypeMeta(channelId, meta = {}, extras = {}) {
  return {
    id: channelId,
    type: channelId,
    label: buildSelectionLabel(channelId, meta),
    title: buildTypeTitle(channelId, meta),
    detailLabel: meta.detailLabel || buildSelectionLabel(channelId, meta),
    systemImage: meta.systemImage || null,
    actions: {
      canQrLogin: OPENCLAW_QR_LOGIN_CHANNELS.has(channelId),
      loginKind: OPENCLAW_WEB_LOGIN_CHANNELS.has(channelId)
        ? "web"
        : OPENCLAW_CLI_LOGIN_CHANNELS.has(channelId)
          ? "cli"
          : null,
      canLogout: OPENCLAW_LOGOUT_CHANNELS.has(channelId),
    },
    ...extras,
  };
}

/**
 * Require an OpenClaw agent whose recorded status permits channel gateway operations.
 *
 * This checks stored agent state; it does not probe whether the gateway is currently reachable.
 *
 * @param {Object} agent - Agent runtime record.
 * @returns {void}
 */
function assertOpenClawAgentReady(agent) {
  if (resolveAgentRuntimeFamily(agent) !== "openclaw") {
    throw createHttpError(409, "This agent does not use the OpenClaw runtime.");
  }
  if (
    !OPENCLAW_RUNTIME_READY_STATUSES.has(
      String(agent?.status || "")
        .trim()
        .toLowerCase(),
    )
  ) {
    throw createHttpError(
      409,
      `OpenClaw channels are unavailable while the agent is ${agent?.status || "not ready"}.`,
    );
  }
}

function toGatewayError(error, fallbackMessage) {
  if (error?.statusCode) return error;

  const message = error?.message || fallbackMessage || "OpenClaw channel request failed";
  const normalized = String(error?.code || "")
    .trim()
    .toUpperCase();

  if (normalized === "INVALID_REQUEST") {
    return createHttpError(400, message);
  }

  if (normalized === "GATEWAY_ERROR") {
    return createHttpError(502, message);
  }

  return createHttpError(502, message);
}

/**
 * Call an OpenClaw gateway method after readiness checks and normalize gateway failures.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} method - Gateway RPC method.
 * @param {Object} [params={}] - RPC parameters.
 * @param {number} [timeout] - Optional RPC timeout in milliseconds.
 * @returns {Promise<Object>} Gateway result.
 */
async function callGateway(agent, method, params = {}, timeout) {
  assertOpenClawAgentReady(agent);
  try {
    return await rpcCall(agent, method, params, timeout);
  } catch (error) {
    throw toGatewayError(error, `OpenClaw ${method} failed`);
  }
}

function isWebLoginProviderUnavailableError(error) {
  return /web login provider is not available/i.test(String(error?.message || ""));
}

function isTransientGatewayRestartError(error) {
  const statusCode = Number(error?.statusCode || 0);
  if (statusCode >= 500) return true;

  return /gateway|websocket|socket|connection|not connected|econnrefused|closed|unavailable|timed out/i.test(
    String(error?.message || ""),
  );
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// QR and CLI login orchestration

/**
 * Build the container command that enables or installs a QR provider and attempts a gateway restart.
 *
 * @param {string} channelId - Supported QR channel identifier.
 * @returns {string} Shell command with package fallback and a default heap cap only when absent.
 */
function buildOpenClawPluginEnableCommand(channelId) {
  const provider = OPENCLAW_QR_LOGIN_PROVIDERS[channelId];
  if (!provider) return "";
  const pluginId = provider.pluginId || channelId;
  const installSpec = provider.installSpec || provider.packageSpec || "";
  const fallbackSpec =
    provider.fallbackSpec && provider.fallbackSpec !== installSpec ? provider.fallbackSpec : "";
  const { shellSingleQuote } = require("../../agent-runtime/lib/containerCommand");

  return [
    "set -eu",
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
    `OPENCLAW_GATEWAY_PORT="\${OPENCLAW_GATEWAY_PORT:-${OPENCLAW_GATEWAY_PORT}}"`,
    "export OPENCLAW_GATEWAY_PORT",
    'if ! printf "%s" "${NODE_OPTIONS:-}" | grep -Eq "(^| )--max-old-space-size="; then',
    '  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${OPENCLAW_PLUGIN_INSTALL_MAX_OLD_SPACE_MB:-256}"',
    "fi",
    "export NODE_OPTIONS",
    "export npm_config_audit=false",
    "export npm_config_fund=false",
    "export npm_config_progress=false",
    "export npm_config_update_notifier=false",
    "enable_openclaw_plugin() {",
    '  plugin_id="$1"',
    '  if "$OPENCLAW_BIN" plugins inspect "$plugin_id" >/dev/null 2>&1; then',
    '    "$OPENCLAW_BIN" plugins enable "$plugin_id"',
    "    return 0",
    "  fi",
    "  return 2",
    "}",
    "install_openclaw_plugin() {",
    '  spec="$1"',
    '  log_file="$(mktemp /tmp/openclaw-plugin-install.XXXXXX)"',
    '  if "$OPENCLAW_BIN" plugins install "$spec" --force >"$log_file" 2>&1; then',
    '    cat "$log_file"',
    '    rm -f "$log_file"',
    "    return 0",
    "  fi",
    '  exit_code="$?"',
    '  cat "$log_file" >&2 || true',
    '  if [ "$exit_code" -eq 137 ]; then',
    '    rm -f "$log_file"',
    '    return "$exit_code"',
    "  fi",
    '  if [ -n "${2:-}" ] && grep -Eiq "not found|not in this registry|package unavailable|plugin unavailable|no npm install source|unknown plugin|could not resolve|cannot find" "$log_file"; then',
    '    rm -f "$log_file"',
    "    return 2",
    "  fi",
    '  rm -f "$log_file"',
    '  return "$exit_code"',
    "}",
    "restart_openclaw_gateway() {",
    "  for proc in /proc/[0-9]*; do",
    '    pid="${proc##*/}"',
    '    comm="$(cat "$proc/comm" 2>/dev/null || true)"',
    '    if [ "$comm" = "openclaw-gateway" ]; then',
    '      kill -USR1 "$pid"',
    "      return 0",
    "    fi",
    "  done",
    '  "$OPENCLAW_BIN" gateway restart',
    "}",
    `PLUGIN_ID=${shellSingleQuote(pluginId)}`,
    `INSTALL_SPEC=${installSpec ? shellSingleQuote(installSpec) : "''"}`,
    `FALLBACK_SPEC=${fallbackSpec ? shellSingleQuote(fallbackSpec) : "''"}`,
    'enable_openclaw_plugin "$PLUGIN_ID" || {',
    '  enable_status="$?"',
    '  if [ "$enable_status" -ne 2 ]; then exit "$enable_status"; fi',
    '  if [ -z "$INSTALL_SPEC" ]; then exit "$enable_status"; fi',
    '  install_openclaw_plugin "$INSTALL_SPEC" "$FALLBACK_SPEC" || {',
    '    install_status="$?"',
    '    if [ "$install_status" -eq 2 ] && [ -n "$FALLBACK_SPEC" ]; then',
    '      install_openclaw_plugin "$FALLBACK_SPEC"',
    "    else",
    '      exit "$install_status"',
    "    fi",
    "  }",
    '  enable_openclaw_plugin "$PLUGIN_ID"',
    "}",
    "if ! restart_openclaw_gateway; then",
    '  printf "%s\\n" "OpenClaw plugin enable completed, but gateway restart did not complete through the CLI."',
    "fi",
  ].join("\n");
}

function formatOpenClawPluginEnableError(channelId, provider, error) {
  const label = buildSelectionLabel(channelId);
  const pluginId = provider.pluginId || channelId;
  const installSpec = provider.installSpec || provider.packageSpec;
  const fallbackSpec =
    provider.fallbackSpec && provider.fallbackSpec !== installSpec
      ? `; fallback ${provider.fallbackSpec}`
      : "";
  const detail = error?.message || "plugin enable failed";
  const exitCode = Number(error?.exitCode || 0);

  if (exitCode === 137 || /code 137|sigkill|oom|out of memory/i.test(detail)) {
    return (
      `OpenClaw could not enable the ${label} QR login provider (${pluginId}): ` +
      "the activation process was killed with exit code 137. This usually means the agent container restarted or the host killed the helper while enabling the provider. " +
      `Increase the agent RAM to at least 2048 MB and retry. Underlying error: ${detail}`
    );
  }

  return `OpenClaw could not enable the ${label} QR login provider (${pluginId}${fallbackSpec}): ${detail}`;
}

function evictGatewayConnection(agent) {
  try {
    const { evictConnection } = require("../gatewayProxy");
    if (typeof evictConnection === "function") {
      evictConnection(agent);
    }
  } catch {
    // Gateway proxy eviction is a best-effort recovery step after restart.
  }
}

async function enableOpenClawLoginProvider(agent, channelId) {
  const provider = OPENCLAW_QR_LOGIN_PROVIDERS[channelId];
  if (!provider) return false;

  const { runContainerCommand } = require("../authSync");
  const command = buildOpenClawPluginEnableCommand(channelId);
  try {
    await runContainerCommand(agent, command, { timeout: 240000 });
    evictGatewayConnection(agent);
    return true;
  } catch (error) {
    throw createHttpError(502, formatOpenClawPluginEnableError(channelId, provider, error));
  }
}

async function startLoginViaGateway(agent, options = {}) {
  return await callGateway(agent, "web.login.start", {
    ...(typeof options?.force === "boolean" ? { force: options.force } : {}),
    ...(typeof options?.accountId === "string" && options.accountId.trim()
      ? { accountId: options.accountId.trim() }
      : {}),
    ...(typeof options?.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/**
 * Retry QR login while a restarted gateway or newly enabled provider becomes available.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} channelId - Channel used for labels and provider errors.
 * @param {Object} [options={}] - Gateway login options.
 * @param {Object} [retryOptions={}] - Provider-unavailable retry policy.
 * @returns {Promise<Object>} Gateway login payload.
 */
async function startLoginWithGatewayRetry(
  agent,
  channelId,
  options = {},
  { retryProviderUnavailable = false, providerUnavailableMessage = "" } = {},
) {
  let lastError = null;
  for (const delayMs of OPENCLAW_GATEWAY_RESTART_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    try {
      return await startLoginViaGateway(agent, options);
    } catch (error) {
      lastError = error;
      if (
        !(retryProviderUnavailable && isWebLoginProviderUnavailableError(error)) &&
        !isTransientGatewayRestartError(error)
      ) {
        throw error;
      }
    }
  }

  if (isWebLoginProviderUnavailableError(lastError)) {
    if (!providerUnavailableMessage) {
      throw lastError;
    }
    throw createHttpError(409, providerUnavailableMessage);
  }

  throw lastError || createHttpError(502, "OpenClaw QR login did not become available.");
}

function assertSupportedCliLoginChannel(channelId) {
  if (!OPENCLAW_CLI_LOGIN_CHANNELS.has(channelId)) {
    throw createHttpError(409, `${buildSelectionLabel(channelId)} does not expose CLI login.`);
  }
}

function cliLoginStateDir(channelId) {
  return `${OPENCLAW_CLI_LOGIN_STATE_ROOT}/${channelId}`;
}

/**
 * Build a background CLI login command that persists output and status for polling.
 *
 * Persisted output is unbounded; start and status responses return only its bounded tail.
 *
 * @param {string} channelId - Allowlisted CLI-login channel.
 * @param {Object} [options={}] - Optional account selection.
 * @returns {string} Shell command that starts the login helper.
 */
function buildOpenClawCliLoginStartCommand(channelId, options = {}) {
  assertSupportedCliLoginChannel(channelId);
  const { shellSingleQuote } = require("../../agent-runtime/lib/containerCommand");
  const accountId =
    typeof options?.accountId === "string" && options.accountId.trim()
      ? options.accountId.trim()
      : "default";
  const stateDir = cliLoginStateDir(channelId);

  return [
    "set -eu",
    `CHANNEL_ID=${shellSingleQuote(channelId)}`,
    `ACCOUNT_ID=${shellSingleQuote(accountId)}`,
    `STATE_DIR=${shellSingleQuote(stateDir)}`,
    'mkdir -p "$STATE_DIR"',
    'chmod 700 "$STATE_DIR"',
    'printf \'%s\' "$CHANNEL_ID" > "$STATE_DIR/channel"',
    'printf \'%s\' "$ACCOUNT_ID" > "$STATE_DIR/account"',
    'rm -f "$STATE_DIR/output.log" "$STATE_DIR/status.json"',
    "cat > \"$STATE_DIR/login.sh\" <<'NORA_OPENCLAW_LOGIN_SCRIPT'",
    "#!/bin/sh",
    "set +e",
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
    'OUTPUT_FILE="$STATE_DIR/output.log"',
    'STATUS_FILE="$STATE_DIR/status.json"',
    'channel_id="$(cat "$STATE_DIR/channel" 2>/dev/null || true)"',
    'account_id="$(cat "$STATE_DIR/account" 2>/dev/null || true)"',
    'printf \'{"status":"running"}\\n\' > "$STATUS_FILE"',
    'if [ -z "$OPENCLAW_BIN" ] || [ ! -x "$OPENCLAW_BIN" ]; then',
    '  printf "%s\\n" "OpenClaw CLI not found" > "$OUTPUT_FILE"',
    '  printf \'{"status":"failed","exitCode":127}\\n\' > "$STATUS_FILE"',
    "  exit 0",
    "fi",
    'if [ -n "$account_id" ] && [ "$account_id" != "default" ]; then',
    '  "$OPENCLAW_BIN" channels login --channel "$channel_id" --account "$account_id" > "$OUTPUT_FILE" 2>&1',
    "else",
    '  "$OPENCLAW_BIN" channels login --channel "$channel_id" > "$OUTPUT_FILE" 2>&1',
    "fi",
    "exit_code=$?",
    'if [ "$exit_code" -eq 0 ]; then',
    '  printf \'{"status":"complete","exitCode":0}\\n\' > "$STATUS_FILE"',
    "else",
    '  printf \'{"status":"failed","exitCode":%s}\\n\' "$exit_code" > "$STATUS_FILE"',
    "fi",
    "exit 0",
    "NORA_OPENCLAW_LOGIN_SCRIPT",
    'chmod 700 "$STATE_DIR/login.sh"',
    'STATE_DIR="$STATE_DIR" nohup /bin/sh "$STATE_DIR/login.sh" >/dev/null 2>&1 &',
    "sleep 2",
    `printf '%s\\n' ${shellSingleQuote(OPENCLAW_CLI_LOGIN_OUTPUT_MARKER)}`,
    'tail -c 12000 "$STATE_DIR/output.log" 2>/dev/null || true',
    `printf '\\n%s\\n' ${shellSingleQuote(OPENCLAW_CLI_LOGIN_STATUS_MARKER)}`,
    'cat "$STATE_DIR/status.json" 2>/dev/null || printf \'%s\\n\' \'{"status":"running"}\'',
  ].join("\n");
}

function buildOpenClawCliLoginStatusCommand(channelId) {
  assertSupportedCliLoginChannel(channelId);
  const { shellSingleQuote } = require("../../agent-runtime/lib/containerCommand");
  const stateDir = cliLoginStateDir(channelId);

  return [
    "set -eu",
    `STATE_DIR=${shellSingleQuote(stateDir)}`,
    `printf '%s\\n' ${shellSingleQuote(OPENCLAW_CLI_LOGIN_OUTPUT_MARKER)}`,
    'tail -c 12000 "$STATE_DIR/output.log" 2>/dev/null || true',
    `printf '\\n%s\\n' ${shellSingleQuote(OPENCLAW_CLI_LOGIN_STATUS_MARKER)}`,
    'cat "$STATE_DIR/status.json" 2>/dev/null || printf \'%s\\n\' \'{"status":"running"}\'',
  ].join("\n");
}

function parseMarkedCliLoginOutput(output) {
  const raw = String(output || "");
  const afterOutputMarker = raw.includes(OPENCLAW_CLI_LOGIN_OUTPUT_MARKER)
    ? raw.split(OPENCLAW_CLI_LOGIN_OUTPUT_MARKER).slice(1).join(OPENCLAW_CLI_LOGIN_OUTPUT_MARKER)
    : raw;
  const [logBlock, statusBlock = ""] = afterOutputMarker.split(OPENCLAW_CLI_LOGIN_STATUS_MARKER);
  let status = { status: "running" };
  try {
    status = JSON.parse(String(statusBlock || "").trim() || "{}");
  } catch {
    status = { status: "running" };
  }

  return {
    log: String(logBlock || "").trim(),
    status,
  };
}

function serializeCliLoginResult(channelId, commandOutput) {
  const { log, status } = parseMarkedCliLoginOutput(commandOutput);
  const normalizedStatus = String(status?.status || "running")
    .trim()
    .toLowerCase();
  const dataUrlMatch = log.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/);
  const message =
    normalizedStatus === "complete"
      ? `${buildSelectionLabel(channelId)} linked successfully.`
      : normalizedStatus === "failed"
        ? `${buildSelectionLabel(channelId)} login failed.`
        : `Scan or complete the ${buildSelectionLabel(channelId)} login prompt.`;

  return {
    success: normalizedStatus === "complete",
    channel: channelId,
    status: normalizedStatus,
    state: normalizedStatus,
    message,
    linked: normalizedStatus === "complete",
    connected: normalizedStatus === "complete",
    ...(Number.isInteger(status?.exitCode) ? { exitCode: status.exitCode } : {}),
    ...(dataUrlMatch ? { qrDataUrl: dataUrlMatch[0] } : {}),
    ...(log ? { qrText: log } : {}),
  };
}

async function runOpenClawCliLoginCommand(agent, command, { timeout = 10000 } = {}) {
  assertOpenClawAgentReady(agent);
  const { runContainerCommand } = require("../authSync");
  const result = await runContainerCommand(agent, command, { timeout });
  return result?.output || "";
}

async function startOpenClawCliChannelLogin(agent, channelId, options = {}) {
  const output = await runOpenClawCliLoginCommand(
    agent,
    buildOpenClawCliLoginStartCommand(channelId, options),
    { timeout: 15000 },
  );
  return serializeCliLoginResult(channelId, output);
}

async function waitOpenClawCliChannelLogin(agent, channelId) {
  const output = await runOpenClawCliLoginCommand(
    agent,
    buildOpenClawCliLoginStatusCommand(channelId),
    { timeout: 10000 },
  );
  return serializeCliLoginResult(channelId, output);
}

// Channel discovery and schema projection

function getConfigChannels(snapshot = {}) {
  return isPlainObject(snapshot?.config?.channels) ? snapshot.config.channels : {};
}

function normalizeChannelId(value) {
  const channelId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (channelId === "__proto__" || channelId === "constructor" || channelId === "prototype") {
    return "";
  }
  return channelId;
}

function requireSafeChannelId(value) {
  const channelId = normalizeChannelId(value);
  if (!channelId) {
    throw createHttpError(400, "Invalid OpenClaw channel type.");
  }
  return channelId;
}

function normalizeLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mergeTypeMeta(target, channelId, patch = {}) {
  const normalizedId = normalizeChannelId(channelId);
  if (!normalizedId) return;

  const current = target.get(normalizedId) || { id: normalizedId };
  const next = { ...current, id: normalizedId };

  for (const [key, value] of Object.entries(patch)) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    next[key] = value;
  }

  target.set(normalizedId, next);
}

function buildTypeMetaById(status = {}) {
  const metaById = new Map();
  const entries = Array.isArray(status?.channelMeta) ? status.channelMeta : [];

  for (const entry of entries) {
    mergeTypeMeta(metaById, entry?.id || entry?.type, entry);
  }

  for (const [channelId, label] of Object.entries(status?.channelLabels || {})) {
    mergeTypeMeta(metaById, channelId, {
      label: normalizeLabel(label),
    });
  }

  for (const [channelId, detailLabel] of Object.entries(status?.channelDetailLabels || {})) {
    mergeTypeMeta(metaById, channelId, {
      detailLabel: normalizeLabel(detailLabel),
    });
  }

  for (const [channelId, systemImage] of Object.entries(status?.channelSystemImages || {})) {
    mergeTypeMeta(metaById, channelId, {
      systemImage: normalizeLabel(systemImage),
    });
  }

  return metaById;
}

function extractSchemaChannelEntries(lookup = {}) {
  const children = Array.isArray(lookup?.children) ? lookup.children : [];
  return children
    .map((child) => {
      const id = normalizeChannelId(child?.key);
      if (!id || id === "*") return null;
      return {
        id,
        label: normalizeLabel(child?.hint?.label),
        detailLabel: normalizeLabel(child?.hint?.label),
        description: normalizeLabel(child?.hint?.help),
      };
    })
    .filter(Boolean);
}

function buildAvailableChannelIds(status = {}, configSnapshot = {}) {
  const known = new Set();

  for (const id of OPENCLAW_DEFAULT_CHANNEL_IDS) {
    known.add(id);
  }

  for (const rawId of Array.isArray(status?.channelOrder) ? status.channelOrder : []) {
    const id = normalizeChannelId(rawId);
    if (id) known.add(id);
  }

  for (const id of Object.keys(status?.channels || {})) {
    const normalizedId = normalizeChannelId(id);
    if (normalizedId) known.add(normalizedId);
  }

  for (const id of Object.keys(status?.channelAccounts || {})) {
    const normalizedId = normalizeChannelId(id);
    if (normalizedId) known.add(normalizedId);
  }

  for (const id of Object.keys(status?.channelDefaultAccountId || {})) {
    const normalizedId = normalizeChannelId(id);
    if (normalizedId) known.add(normalizedId);
  }

  for (const id of buildTypeMetaById(status).keys()) {
    const normalizedId = normalizeChannelId(id);
    if (normalizedId) known.add(normalizedId);
  }

  for (const id of Object.keys(getConfigChannels(configSnapshot))) {
    const normalizedId = normalizeChannelId(id);
    if (normalizedId) known.add(normalizedId);
  }
  return Array.from(known);
}

function mergeSchemaEntriesIntoTypeMeta(metaById, schemaEntries = []) {
  for (const entry of schemaEntries) {
    mergeTypeMeta(metaById, entry.id, entry);
  }
}

function buildChannelState({ configured, connected, running, lastError }) {
  if (lastError) return "error";
  if (connected) return "connected";
  if (running) return "running";
  if (configured) return "configured";
  return "not_configured";
}

function serializeAccount(account = {}) {
  return {
    accountId: account.accountId || "default",
    name: account.name || null,
    enabled: account.enabled !== false,
    configured: account.configured === true,
    linked: account.linked === true,
    running: account.running === true,
    connected: account.connected === true,
    healthState: account.healthState || null,
    lastError: account.lastError || null,
    lastConnectedAt: account.lastConnectedAt || null,
    lastProbeAt: account.lastProbeAt || null,
  };
}

function serializeChannelEntry(channelId, meta, status = {}, configSnapshot = {}) {
  const configChannels = getConfigChannels(configSnapshot);
  const channelConfig = isPlainObject(configChannels[channelId]) ? configChannels[channelId] : {};
  const summary = isPlainObject(status?.channels?.[channelId]) ? status.channels[channelId] : {};
  const accounts = Array.isArray(status?.channelAccounts?.[channelId])
    ? status.channelAccounts[channelId].map(serializeAccount)
    : [];
  const defaultAccountId = status?.channelDefaultAccountId?.[channelId] || "default";
  const primaryAccount =
    accounts.find((account) => account.accountId === defaultAccountId) || accounts[0] || null;
  const configured =
    summary.configured === true ||
    primaryAccount?.configured === true ||
    Object.keys(channelConfig).length > 0;
  const connected = primaryAccount?.connected === true;
  const running = primaryAccount?.running === true;
  const enabled =
    typeof channelConfig.enabled === "boolean"
      ? channelConfig.enabled
      : typeof primaryAccount?.enabled === "boolean"
        ? primaryAccount.enabled
        : configured;
  const lastError = primaryAccount?.lastError || summary.lastError || null;

  return {
    id: channelId,
    type: channelId,
    name: buildTypeTitle(channelId, meta),
    selectionLabel: buildSelectionLabel(channelId, meta),
    detailLabel: meta?.detailLabel || buildSelectionLabel(channelId, meta),
    systemImage: meta?.systemImage || null,
    configured,
    enabled,
    readOnly: false,
    defaultAccountId,
    accounts,
    accountCount: accounts.length,
    config: redactSensitiveConfig(channelConfig),
    status: {
      state: buildChannelState({ configured, connected, running, lastError }),
      connected,
      running,
      healthState: primaryAccount?.healthState || null,
      lastError,
      lastConnectedAt: primaryAccount?.lastConnectedAt || null,
      lastProbeAt: primaryAccount?.lastProbeAt || null,
    },
    actions: {
      canEdit: true,
      canToggle: configured,
      canDelete: false,
      canTest: false,
      canViewMessages: false,
      canQrLogin: OPENCLAW_QR_LOGIN_CHANNELS.has(channelId),
      loginKind: OPENCLAW_WEB_LOGIN_CHANNELS.has(channelId)
        ? "web"
        : OPENCLAW_CLI_LOGIN_CHANNELS.has(channelId)
          ? "cli"
          : null,
      canLogout:
        OPENCLAW_LOGOUT_CHANNELS.has(channelId) &&
        (connected || running || primaryAccount?.linked === true),
    },
  };
}

async function readChannelSnapshot(agent) {
  const [status, configSnapshot] = await Promise.all([
    callGateway(agent, "channels.status"),
    callGateway(agent, "config.get"),
  ]);

  return { status, configSnapshot };
}

function requireSnapshotHash(snapshot = {}) {
  const hash = typeof snapshot?.hash === "string" ? snapshot.hash.trim() : "";
  if (!hash) {
    throw createHttpError(
      409,
      "OpenClaw config hash is unavailable. Reload the channel tab and retry.",
    );
  }
  return hash;
}

async function writeConfigPatch(agent, snapshot, patch) {
  const baseHash = requireSnapshotHash(snapshot);
  return await callGateway(agent, "config.patch", {
    raw: JSON.stringify(patch),
    baseHash,
  });
}

async function safeLookup(agent, path) {
  try {
    return await callGateway(agent, "config.schema.lookup", { path });
  } catch (error) {
    if (error?.statusCode === 400 && /path not found/i.test(String(error.message || ""))) {
      return null;
    }
    throw error;
  }
}

async function loadSchemaChannelEntries(agent, { tolerateErrors = false } = {}) {
  try {
    const lookup = await safeLookup(agent, "channels");
    return extractSchemaChannelEntries(lookup);
  } catch (error) {
    if (tolerateErrors) {
      return [];
    }
    throw error;
  }
}

function relativeFieldKey(basePath, fullPath) {
  if (!fullPath.startsWith(`${basePath}.`)) return fullPath;
  return fullPath.slice(basePath.length + 1);
}

function resolveFieldOptions(schema = {}) {
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => ({ label: String(value), value }));
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    return [{ label: String(schema.const), value: schema.const }];
  }
  return [];
}

function buildFieldDefinition(basePath, child, lookup) {
  const schema = isPlainObject(lookup?.schema) ? lookup.schema : {};
  const options = resolveFieldOptions(schema);
  const key = relativeFieldKey(basePath, child.path);
  const resolvedType = normalizeSchemaType(schema.type || child.type);
  const sensitive = child?.hint?.sensitive === true || SECRET_LIKE_PATH_RE.test(key);
  const label = child?.hint?.label || key.split(".").slice(-1)[0];
  const help = child?.hint?.help || "";
  const placeholder = child?.hint?.placeholder || "";

  if (options.length > 0) {
    return {
      key,
      label,
      help,
      placeholder,
      required: child.required === true,
      type: "select",
      options,
      order: Number.isInteger(child?.hint?.order) ? child.hint.order : 9999,
    };
  }

  if (resolvedType === "array") {
    const item = Array.isArray(lookup?.children)
      ? lookup.children.find((entry) => entry.key === "*")
      : null;
    const itemType = normalizeSchemaType(item?.type);
    if (
      item &&
      !item.hasChildren &&
      (!itemType || itemType === "string" || itemType === "integer" || itemType === "number")
    ) {
      return {
        key,
        label,
        help,
        placeholder,
        required: child.required === true,
        type: "list",
        itemType: itemType || "string",
        order: Number.isInteger(child?.hint?.order) ? child.hint.order : 9999,
      };
    }
    return null;
  }

  if (resolvedType === "boolean") {
    return {
      key,
      label,
      help,
      placeholder,
      required: child.required === true,
      type: "boolean",
      order: Number.isInteger(child?.hint?.order) ? child.hint.order : 9999,
    };
  }

  if (resolvedType === "integer") {
    return {
      key,
      label,
      help,
      placeholder,
      required: child.required === true,
      type: "integer",
      order: Number.isInteger(child?.hint?.order) ? child.hint.order : 9999,
    };
  }

  if (resolvedType === "number") {
    return {
      key,
      label,
      help,
      placeholder,
      required: child.required === true,
      type: "number",
      order: Number.isInteger(child?.hint?.order) ? child.hint.order : 9999,
    };
  }

  if (resolvedType === "object") {
    return null;
  }

  const format = typeof schema.format === "string" ? schema.format : "";
  const inputType =
    format === "url" ? "url" : format === "email" ? "email" : sensitive ? "password" : "text";

  if (resolvedType == null && child.hasChildren) {
    return null;
  }

  return {
    key,
    label,
    help,
    placeholder,
    required: child.required === true,
    type: inputType,
    order: Number.isInteger(child?.hint?.order) ? child.hint.order : 9999,
  };
}

/**
 * Walk the gateway schema into editable fields while flagging unsupported complex shapes.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} basePath - Channel config root used for relative field keys.
 * @param {Object} lookup - Current schema lookup node.
 * @param {number} [depth=0] - Current recursion depth.
 * @param {Object|null} [state=null] - Shared field collection state.
 * @returns {Promise<Object>} Collected fields and complex-shape indicator.
 */
async function collectConfigFields(agent, basePath, lookup, depth = 0, state = null) {
  const nextState = state || { fields: [], hasComplexFields: false };
  const children = Array.isArray(lookup?.children) ? lookup.children : [];

  for (const child of children) {
    if (!child?.path) continue;
    if (child.key === "*") {
      nextState.hasComplexFields = true;
      continue;
    }

    const childLookup = await safeLookup(agent, child.path);
    if (!childLookup) {
      nextState.hasComplexFields = true;
      continue;
    }

    const field = buildFieldDefinition(basePath, child, childLookup);
    if (field) {
      nextState.fields.push(field);
      continue;
    }

    if (child.hasChildren && depth < MAX_SCHEMA_FIELD_DEPTH) {
      const before = nextState.fields.length;
      await collectConfigFields(agent, basePath, childLookup, depth + 1, nextState);
      if (nextState.fields.length === before) {
        nextState.hasComplexFields = true;
      }
      continue;
    }

    nextState.hasComplexFields = true;
  }

  return nextState;
}

function sortConfigFields(fields = []) {
  return [...fields].sort((left, right) => {
    const leftOrder = Number.isInteger(left?.order) ? left.order : 9999;
    const rightOrder = Number.isInteger(right?.order) ? right.order : 9999;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left?.label || left?.key || "").localeCompare(
      String(right?.label || right?.key || ""),
    );
  });
}

function docsSetupDefinitionFor(channelId) {
  return OPENCLAW_CHANNEL_SETUP_DEFINITIONS[channelId] || null;
}

function cloneSetupFields(fields = []) {
  return cloneJson(fields).map((field, index) => ({
    order: Number.isInteger(field?.order) ? field.order : index,
    ...field,
  }));
}

function mergeDocsBackedConfigFields(channelId, schemaFields = []) {
  const docsDefinition = docsSetupDefinitionFor(channelId);
  if (!docsDefinition) {
    return sortConfigFields(schemaFields);
  }

  const docsFields = cloneSetupFields(docsDefinition.configFields || []);
  const seen = new Set(docsFields.map((field) => String(field?.key || "")));
  const requiredSchemaExtras = schemaFields
    .filter((field) => {
      const key = String(field?.key || "");
      return key && key !== "enabled" && field?.required === true && !seen.has(key);
    })
    .map((field, index) => ({
      ...field,
      order: Number.isInteger(field?.order) ? field.order : docsFields.length + index,
    }));

  return sortConfigFields([...docsFields, ...requiredSchemaExtras]);
}

function docsBackedDescription(channelId, fallback = "") {
  return docsSetupDefinitionFor(channelId)?.description || fallback || "";
}

function buildDocsBackedTypeMeta(channelId, meta = {}) {
  const docsDefinition = docsSetupDefinitionFor(channelId);
  if (!docsDefinition) return null;

  return serializeTypeMeta(channelId, meta, {
    description: docsDefinition.description || "",
    configFields: mergeDocsBackedConfigFields(channelId, []),
    hasComplexFields: false,
  });
}

function requireSupportedQrChannel(channelId) {
  if (!OPENCLAW_QR_LOGIN_CHANNELS.has(channelId)) {
    throw createHttpError(
      409,
      `${buildSelectionLabel(channelId)} does not expose QR login through this OpenClaw gateway build.`,
    );
  }
}

function requireSupportedLogoutChannel(channelId) {
  if (!OPENCLAW_LOGOUT_CHANNELS.has(channelId)) {
    throw createHttpError(
      409,
      `${buildSelectionLabel(channelId)} does not expose a Nora logout action yet.`,
    );
  }
}

function buildSeededChannelConfig(channelId, currentConfig = {}) {
  const seed = Object.prototype.hasOwnProperty.call(OPENCLAW_CHANNEL_SEEDS, channelId)
    ? OPENCLAW_CHANNEL_SEEDS[channelId]
    : null;
  const seeded = deepMerge(
    seed ? cloneJson(seed) : {},
    isPlainObject(currentConfig) ? currentConfig : {},
  );

  if (typeof seeded.enabled !== "boolean") {
    seeded.enabled = true;
  }

  return seeded;
}

function buildOpenClawChannelConfigPatch(channelId, nextConfig) {
  const patch = {};
  const provider = Object.prototype.hasOwnProperty.call(OPENCLAW_QR_LOGIN_PROVIDERS, channelId)
    ? OPENCLAW_QR_LOGIN_PROVIDERS[channelId]
    : null;
  if (provider?.pluginId && typeof nextConfig?.enabled === "boolean") {
    patch.plugins = {
      entries: Object.fromEntries([
        [
          provider.pluginId,
          {
            enabled: nextConfig.enabled,
          },
        ],
      ]),
    };
  }
  patch.channels = Object.fromEntries([[channelId, nextConfig]]);
  return patch;
}

async function ensureKnownChannel(agent, channelId) {
  channelId = requireSafeChannelId(channelId);
  const snapshot = await readChannelSnapshot(agent);
  let ids = buildAvailableChannelIds(snapshot.status, snapshot.configSnapshot);

  if (!ids.includes(channelId)) {
    const schemaEntries = await loadSchemaChannelEntries(agent);
    ids = Array.from(new Set([...ids, ...schemaEntries.map((entry) => entry.id)]));
    if (ids.includes(channelId)) {
      snapshot.schemaEntries = schemaEntries;
    }
  }

  if (!ids.includes(channelId)) {
    throw createHttpError(404, `Unknown OpenClaw channel type: ${channelId}`);
  }
  return snapshot;
}

/**
 * Merge runtime status, persisted config, built-in defaults, and optional schema channel types.
 *
 * Schema discovery is best-effort so an older or restarting gateway can still return known types.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @returns {Promise<Object>} Unified channel list and available type metadata.
 */
async function listOpenClawChannels(agent) {
  const { status, configSnapshot } = await readChannelSnapshot(agent);
  const typeMetaById = buildTypeMetaById(status);
  let channelIds = buildAvailableChannelIds(status, configSnapshot);
  const schemaEntries = await loadSchemaChannelEntries(agent, { tolerateErrors: true });

  mergeSchemaEntriesIntoTypeMeta(typeMetaById, schemaEntries);
  channelIds = Array.from(new Set([...channelIds, ...schemaEntries.map((entry) => entry.id)]));

  const availableTypes = channelIds.map((channelId) =>
    serializeTypeMeta(channelId, typeMetaById.get(channelId)),
  );
  const channels = channelIds.map((channelId) =>
    serializeChannelEntry(channelId, typeMetaById.get(channelId), status, configSnapshot),
  );

  return {
    runtime: "openclaw",
    title: "OpenClaw Channels",
    description:
      "Nora lists available OpenClaw channels here. Link or set up a channel to enable it.",
    capabilities: {
      supportsTesting: false,
      supportsMessageHistory: false,
      supportsArbitraryNames: false,
      supportsLazyTypeDefinitions: true,
    },
    channels,
    availableTypes,
  };
}

/**
 * Resolve one channel's setup fields from maintained docs or the live gateway schema.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} channelId - Normalized channel identifier.
 * @returns {Promise<Object>} Channel type metadata and editable field definitions.
 */
async function getOpenClawChannelType(agent, channelId) {
  channelId = requireSafeChannelId(channelId);
  const { status, schemaEntries } = await ensureKnownChannel(agent, channelId);
  const typeMetaById = buildTypeMetaById(status);
  if (Array.isArray(schemaEntries) && schemaEntries.length > 0) {
    mergeSchemaEntriesIntoTypeMeta(typeMetaById, schemaEntries);
  }
  const meta = typeMetaById.get(channelId) || {};

  const docsBackedMeta = buildDocsBackedTypeMeta(channelId, meta);
  if (docsBackedMeta) {
    return docsBackedMeta;
  }

  if (OPENCLAW_QR_LOGIN_CHANNELS.has(channelId)) {
    return serializeTypeMeta(channelId, meta, {
      description: "Link this channel through the OpenClaw pairing flow.",
      configFields: [],
      hasComplexFields: false,
    });
  }

  const basePath = `channels.${channelId}`;
  const lookup = await safeLookup(agent, basePath);
  const fieldState = lookup
    ? await collectConfigFields(agent, basePath, lookup)
    : { fields: [], hasComplexFields: true };
  const configFields = mergeDocsBackedConfigFields(channelId, fieldState.fields);
  const hasDocsBackedFields = Boolean(docsSetupDefinitionFor(channelId));

  return serializeTypeMeta(channelId, meta, {
    description: docsBackedDescription(channelId, lookup?.hint?.help),
    configFields,
    hasComplexFields: fieldState.hasComplexFields && !hasDocsBackedFields,
  });
}

// Channel config persistence and actions

/**
 * Best-effort persist an encrypted runtime patch so provisioning can reseed it after redeploy.
 *
 * Database failures are logged but do not fail the already successful runtime save.
 *
 * @param {string} agentId - Agent receiving the channel patch.
 * @param {string} channelId - Channel identifier.
 * @param {Object} patch - Applied OpenClaw config patch.
 * @returns {Promise<void>}
 */
async function persistOpenClawChannelState(agentId, channelId, patch) {
  if (!agentId || !channelId || !isPlainObject(patch)) return;
  try {
    ensureEncryptionConfigured("OpenClaw channel config persistence");
    await db.query(
      `INSERT INTO openclaw_channel_state(agent_id, channel_id, config_encrypted, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (agent_id, channel_id)
       DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted, updated_at = NOW()`,
      [agentId, channelId, encrypt(JSON.stringify(patch))],
    );
  } catch (error) {
    console.warn(
      `[channels] Could not persist OpenClaw channel state for agent ${agentId}/${channelId}: ${error.message}`,
    );
  }
}

/**
 * Merge and write channel config with optimistic hashes and transient gateway retries.
 *
 * A successful runtime write is returned even when durable reseed persistence later fails.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} channelId - Known channel identifier.
 * @param {Object} [input={}] - Config and enabled-state changes.
 * @param {Object} [options={}] - Create-mode marker.
 * @returns {Promise<Object>} Save result and any requested restart metadata.
 */
async function saveOpenClawChannel(agent, channelId, input = {}, { create = false } = {}) {
  channelId = requireSafeChannelId(channelId);
  let lastError = null;

  for (const delayMs of OPENCLAW_GATEWAY_RESTART_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    try {
      const { configSnapshot } = await ensureKnownChannel(agent, channelId);
      const snapshot = configSnapshot;
      const configChannels = getConfigChannels(snapshot);
      const currentConfig = Object.prototype.hasOwnProperty.call(configChannels, channelId)
        ? configChannels[channelId]
        : undefined;
      let nextConfig = create
        ? buildSeededChannelConfig(channelId, currentConfig)
        : buildSeededChannelConfig(channelId, currentConfig);

      if (isPlainObject(input?.config)) {
        nextConfig = deepMerge(nextConfig, restoreRedactedConfigValue(input.config, currentConfig));
      }

      if (typeof input?.enabled === "boolean") {
        nextConfig.enabled = input.enabled;
      }

      const patch = buildOpenClawChannelConfigPatch(channelId, nextConfig);
      const result = await writeConfigPatch(agent, snapshot, patch);

      // The runtime's openclaw.json is the live source of channel config, but
      // it dies with the container on redeploy — keep a durable encrypted
      // copy so provisioning can reseed it. QR session state (device links)
      // cannot be captured here; those channels re-pair after a rebuild.
      await persistOpenClawChannelState(agent.id, channelId, patch);

      return {
        success: true,
        channel: channelId,
        restart: result?.restart || null,
      };
    } catch (error) {
      if (!isTransientGatewayRestartError(error)) {
        throw error;
      }
      lastError = error;
      evictGatewayConnection(agent);
    }
  }

  throw lastError || createHttpError(502, "OpenClaw channel save did not become available.");
}

/**
 * Connect a channel through CLI login, config-only setup, or config followed by QR login.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} channelId - Channel to connect.
 * @param {Object} [options={}] - Setup and login options.
 * @returns {Promise<Object>} Connection, restart, and optional login status.
 */
async function connectOpenClawChannel(agent, channelId, options = {}) {
  channelId = requireSafeChannelId(channelId);
  if (OPENCLAW_CLI_LOGIN_CHANNELS.has(channelId)) {
    const loginResult = await startOpenClawChannelLogin(agent, channelId, options);
    return {
      ...loginResult,
      success: true,
      channel: channelId,
      login: loginResult,
    };
  }

  const saveResult = await saveOpenClawChannel(
    agent,
    channelId,
    {
      enabled: true,
      ...(isPlainObject(options?.config) ? { config: options.config } : {}),
    },
    { create: true },
  );
  if (saveResult?.restart) {
    evictGatewayConnection(agent);
  }
  if (!OPENCLAW_QR_LOGIN_CHANNELS.has(channelId)) {
    return {
      success: true,
      channel: channelId,
      restart: saveResult?.restart || null,
      linked: true,
    };
  }

  const loginResult = await startOpenClawChannelLogin(agent, channelId, options, {
    retryProviderUnavailable: Boolean(saveResult?.restart),
  });

  return {
    success: true,
    channel: channelId,
    restart: saveResult?.restart || null,
    login: loginResult,
    ...loginResult,
  };
}

/**
 * Start an allowlisted login flow, enabling a missing web provider when necessary.
 *
 * @param {Object} agent - Ready OpenClaw agent.
 * @param {string} channelId - QR or CLI-login channel.
 * @param {Object} [options={}] - Login options.
 * @param {Object} [retryOptions={}] - Retry behavior after a config restart.
 * @returns {Promise<Object>} Initial login status or pairing payload.
 */
async function startOpenClawChannelLogin(agent, channelId, options = {}, retryOptions = {}) {
  requireSupportedQrChannel(channelId);
  if (OPENCLAW_CLI_LOGIN_CHANNELS.has(channelId)) {
    return await startOpenClawCliChannelLogin(agent, channelId, options);
  }

  try {
    return await startLoginWithGatewayRetry(agent, channelId, options, {
      retryProviderUnavailable: retryOptions.retryProviderUnavailable === true,
    });
  } catch (error) {
    if (!isWebLoginProviderUnavailableError(error)) {
      throw error;
    }
    const enabled = await enableOpenClawLoginProvider(agent, channelId);
    if (!enabled) {
      throw error;
    }
    return await startLoginWithGatewayRetry(agent, channelId, options, {
      retryProviderUnavailable: true,
      providerUnavailableMessage: `${buildSelectionLabel(
        channelId,
      )} was enabled, but the OpenClaw gateway has not loaded the QR login provider yet. Restart the agent and try connecting again.`,
    });
  }
}

async function waitOpenClawChannelLogin(agent, channelId, options = {}) {
  requireSupportedQrChannel(channelId);
  if (OPENCLAW_CLI_LOGIN_CHANNELS.has(channelId)) {
    return await waitOpenClawCliChannelLogin(agent, channelId);
  }

  return await callGateway(agent, "web.login.wait", {
    ...(typeof options?.accountId === "string" && options.accountId.trim()
      ? { accountId: options.accountId.trim() }
      : {}),
    ...(typeof options?.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
  });
}

async function logoutOpenClawChannel(agent, channelId, options = {}) {
  requireSupportedLogoutChannel(channelId);
  return await callGateway(agent, "channels.logout", {
    channel: channelId,
    ...(typeof options?.accountId === "string" && options.accountId.trim()
      ? { accountId: options.accountId.trim() }
      : {}),
  });
}

module.exports = {
  connectOpenClawChannel,
  getOpenClawChannelType,
  listOpenClawChannels,
  saveOpenClawChannel,
  startOpenClawChannelLogin,
  waitOpenClawChannelLogin,
  logoutOpenClawChannel,
};
