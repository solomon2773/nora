const containerManager = require("./containerManager");
const { runContainerCommand } = require("./authSync");
const { waitForAgentReadiness } = require("./healthChecks");

const HERMES_CHANNEL_REDACTED = "[REDACTED]";

const HERMES_CHANNEL_DEFINITIONS = Object.freeze({
  telegram: Object.freeze({
    type: "telegram",
    label: "Telegram",
    emoji: "📱",
    description: "Bot token, allowlist, and default delivery chat for Telegram.",
    requiredKeys: ["TELEGRAM_BOT_TOKEN"],
    fields: Object.freeze([
      {
        key: "TELEGRAM_BOT_TOKEN",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "123456789:ABCDEF...",
      },
      {
        key: "TELEGRAM_ALLOWED_USERS",
        label: "Allowed User IDs",
        type: "text",
        required: false,
        placeholder: "123456789,987654321",
      },
      {
        key: "TELEGRAM_HOME_CHANNEL",
        label: "Home Chat ID",
        type: "text",
        required: false,
        placeholder: "123456789 or -100...",
      },
      {
        key: "TELEGRAM_HOME_CHANNEL_NAME",
        label: "Home Channel Name",
        type: "text",
        required: false,
        placeholder: "Ops Telegram",
      },
    ]),
  }),
  discord: Object.freeze({
    type: "discord",
    label: "Discord",
    emoji: "💬",
    description: "Bot token, allowlist, reply mode, and default Discord delivery channel.",
    requiredKeys: ["DISCORD_BOT_TOKEN"],
    fields: Object.freeze([
      {
        key: "DISCORD_BOT_TOKEN",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "Discord bot token",
      },
      {
        key: "DISCORD_ALLOWED_USERS",
        label: "Allowed User IDs",
        type: "text",
        required: false,
        placeholder: "111222333,444555666",
      },
      {
        key: "DISCORD_HOME_CHANNEL",
        label: "Home Channel ID",
        type: "text",
        required: false,
        placeholder: "123456789012345678",
      },
      {
        key: "DISCORD_HOME_CHANNEL_NAME",
        label: "Home Channel Name",
        type: "text",
        required: false,
        placeholder: "Agent Updates",
      },
      {
        key: "DISCORD_REPLY_TO_MODE",
        label: "Reply Mode",
        type: "select",
        required: false,
        options: ["off", "first", "all"],
      },
    ]),
  }),
  slack: Object.freeze({
    type: "slack",
    label: "Slack",
    emoji: "💼",
    description: "Socket Mode Slack bot credentials and optional home channel.",
    requiredKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    fields: Object.freeze([
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "xoxb-...",
      },
      {
        key: "SLACK_APP_TOKEN",
        label: "App Token",
        type: "password",
        required: true,
        placeholder: "xapp-...",
      },
      {
        key: "SLACK_ALLOWED_USERS",
        label: "Allowed User IDs",
        type: "text",
        required: false,
        placeholder: "U01234567,U07654321",
      },
      {
        key: "SLACK_HOME_CHANNEL",
        label: "Home Channel ID",
        type: "text",
        required: false,
        placeholder: "C0123456789",
      },
      {
        key: "SLACK_HOME_CHANNEL_NAME",
        label: "Home Channel Name",
        type: "text",
        required: false,
        placeholder: "ops-alerts",
      },
    ]),
  }),
  signal: Object.freeze({
    type: "signal",
    label: "Signal",
    emoji: "📡",
    description: "Signal HTTP bridge endpoint and home chat mapping.",
    requiredKeys: ["SIGNAL_HTTP_URL", "SIGNAL_ACCOUNT"],
    fields: Object.freeze([
      {
        key: "SIGNAL_HTTP_URL",
        label: "Signal HTTP URL",
        type: "url",
        required: true,
        placeholder: "http://signal-http:8080",
      },
      {
        key: "SIGNAL_ACCOUNT",
        label: "Signal Account",
        type: "text",
        required: true,
        placeholder: "+15551234567",
      },
      {
        key: "SIGNAL_HOME_CHANNEL",
        label: "Home Chat ID",
        type: "text",
        required: false,
        placeholder: "+15557654321",
      },
      {
        key: "SIGNAL_HOME_CHANNEL_NAME",
        label: "Home Channel Name",
        type: "text",
        required: false,
        placeholder: "Primary Signal",
      },
    ]),
  }),
  email: Object.freeze({
    type: "email",
    label: "Email",
    emoji: "📧",
    description: "IMAP/SMTP mailbox configuration for Hermes email workflows.",
    requiredKeys: [
      "EMAIL_ADDRESS",
      "EMAIL_PASSWORD",
      "EMAIL_IMAP_HOST",
      "EMAIL_SMTP_HOST",
    ],
    fields: Object.freeze([
      {
        key: "EMAIL_ADDRESS",
        label: "Email Address",
        type: "email",
        required: true,
        placeholder: "hermes@example.com",
      },
      {
        key: "EMAIL_PASSWORD",
        label: "Email Password",
        type: "password",
        required: true,
        placeholder: "App password",
      },
      {
        key: "EMAIL_IMAP_HOST",
        label: "IMAP Host",
        type: "text",
        required: true,
        placeholder: "imap.gmail.com",
      },
      {
        key: "EMAIL_IMAP_PORT",
        label: "IMAP Port",
        type: "text",
        required: false,
        placeholder: "993",
      },
      {
        key: "EMAIL_SMTP_HOST",
        label: "SMTP Host",
        type: "text",
        required: true,
        placeholder: "smtp.gmail.com",
      },
      {
        key: "EMAIL_SMTP_PORT",
        label: "SMTP Port",
        type: "text",
        required: false,
        placeholder: "587",
      },
      {
        key: "EMAIL_ALLOWED_USERS",
        label: "Allowed Sender Emails",
        type: "text",
        required: false,
        placeholder: "ops@example.com,oncall@example.com",
      },
      {
        key: "EMAIL_HOME_ADDRESS",
        label: "Home Address",
        type: "email",
        required: false,
        placeholder: "ops@example.com",
      },
    ]),
  }),
  sms: Object.freeze({
    type: "sms",
    label: "SMS (Twilio)",
    emoji: "📲",
    description: "Twilio account credentials and phone numbers for Hermes SMS delivery.",
    requiredKeys: [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
    ],
    fields: Object.freeze([
      {
        key: "TWILIO_ACCOUNT_SID",
        label: "Twilio Account SID",
        type: "text",
        required: true,
        placeholder: "AC...",
      },
      {
        key: "TWILIO_AUTH_TOKEN",
        label: "Twilio Auth Token",
        type: "password",
        required: true,
        placeholder: "Twilio auth token",
      },
      {
        key: "TWILIO_PHONE_NUMBER",
        label: "Twilio Phone Number",
        type: "text",
        required: true,
        placeholder: "+15551234567",
      },
      {
        key: "SMS_ALLOWED_USERS",
        label: "Allowed Phone Numbers",
        type: "text",
        required: false,
        placeholder: "+15557654321,+15559876543",
      },
      {
        key: "SMS_HOME_CHANNEL",
        label: "Home Channel Phone Number",
        type: "text",
        required: false,
        placeholder: "+15557654321",
      },
      {
        key: "SMS_HOME_CHANNEL_NAME",
        label: "Home Channel Name",
        type: "text",
        required: false,
        placeholder: "Primary SMS",
      },
    ]),
  }),
  mattermost: Object.freeze({
    type: "mattermost",
    label: "Mattermost",
    emoji: "🗨️",
    description: "Mattermost server URL, bot token, and default channel routing.",
    requiredKeys: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
    fields: Object.freeze([
      {
        key: "MATTERMOST_URL",
        label: "Server URL",
        type: "url",
        required: true,
        placeholder: "https://mm.example.com",
      },
      {
        key: "MATTERMOST_TOKEN",
        label: "Bot Token",
        type: "password",
        required: true,
        placeholder: "Mattermost bot token",
      },
      {
        key: "MATTERMOST_ALLOWED_USERS",
        label: "Allowed User IDs",
        type: "text",
        required: false,
        placeholder: "abcd1234efgh5678ijkl9012mn",
      },
      {
        key: "MATTERMOST_HOME_CHANNEL",
        label: "Home Channel ID",
        type: "text",
        required: false,
        placeholder: "channel-id",
      },
      {
        key: "MATTERMOST_HOME_CHANNEL_NAME",
        label: "Home Channel Name",
        type: "text",
        required: false,
        placeholder: "mattermost-home",
      },
      {
        key: "MATTERMOST_REPLY_MODE",
        label: "Reply Mode",
        type: "select",
        required: false,
        options: ["off", "thread"],
      },
    ]),
  }),
  matrix: Object.freeze({
    type: "matrix",
    label: "Matrix",
    emoji: "🔐",
    description: "Matrix homeserver, access token, and optional home room.",
    requiredKeys: ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"],
    fields: Object.freeze([
      {
        key: "MATRIX_HOMESERVER",
        label: "Homeserver URL",
        type: "url",
        required: true,
        placeholder: "https://matrix.example.org",
      },
      {
        key: "MATRIX_ACCESS_TOKEN",
        label: "Access Token",
        type: "password",
        required: true,
        placeholder: "Matrix access token",
      },
      {
        key: "MATRIX_USER_ID",
        label: "User ID",
        type: "text",
        required: false,
        placeholder: "@hermes:example.org",
      },
      {
        key: "MATRIX_ALLOWED_USERS",
        label: "Allowed User IDs",
        type: "text",
        required: false,
        placeholder: "@alice:example.org,@bob:example.org",
      },
      {
        key: "MATRIX_HOME_ROOM",
        label: "Home Room ID",
        type: "text",
        required: false,
        placeholder: "!abcdef:example.org",
      },
      {
        key: "MATRIX_HOME_ROOM_NAME",
        label: "Home Room Name",
        type: "text",
        required: false,
        placeholder: "Matrix Home",
      },
    ]),
  }),
});

const HERMES_CHANNEL_TYPES = Object.freeze(
  Object.keys(HERMES_CHANNEL_DEFINITIONS)
);

function humanizeHermesChannelType(value) {
  return String(value || "")
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildHermesPythonCommand(script) {
  const encoded = Buffer.from(String(script || ""), "utf8").toString("base64");
  return [
    "set -eu",
    'HERMES_ROOT="/opt/hermes"',
    'HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python3"; fi',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$(command -v python3 2>/dev/null || true)"; fi',
    '[ -n "$HERMES_PYTHON" ] || exit 127',
    'if [ -d "$HERMES_ROOT" ]; then cd "$HERMES_ROOT"; fi',
    'PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}" exec "$HERMES_PYTHON" - <<\'PY\'',
    "import base64",
    "__nora_globals = {'__name__': '__main__'}",
    `exec(base64.b64decode(${JSON.stringify(encoded)}).decode('utf-8'), __nora_globals)`,
    "PY",
  ].join("\n");
}

async function runHermesPython(agent, script, { timeout = 30000 } = {}) {
  return runContainerCommand(agent, buildHermesPythonCommand(script), { timeout });
}

async function runHermesPythonJson(agent, script, { timeout = 30000 } = {}) {
  const result = await runHermesPython(agent, script, { timeout });
  const raw = String(result?.output || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const nextError = new Error(
      `Unexpected Hermes helper output: ${raw.slice(0, 400) || error.message}`
    );
    nextError.cause = error;
    throw nextError;
  }
}

async function persistHermesModelConfig(agent, modelConfig = {}) {
  const script = `
import json
from pathlib import Path

import yaml

from hermes_cli.config import get_config_path, load_config

payload = ${JSON.stringify(modelConfig || {})}
config = load_config() or {}
model = dict(config.get("model") or {})

default_model = str(payload.get("defaultModel") or "").strip()
provider = str(payload.get("provider") or "").strip()
base_url = str(payload.get("baseUrl") or "").strip()

if default_model:
    model["default"] = default_model
else:
    model.pop("default", None)

if provider:
    model["provider"] = provider
else:
    model.pop("provider", None)

if base_url:
    model["base_url"] = base_url
else:
    model.pop("base_url", None)

if model:
    config["model"] = model
else:
    config.pop("model", None)

config_path = Path(get_config_path())
config_path.parent.mkdir(parents=True, exist_ok=True)

with config_path.open("w", encoding="utf-8") as handle:
    yaml.safe_dump(config, handle, sort_keys=False)

print(json.dumps({
    "ok": True,
    "configPath": str(config_path),
    "modelConfig": {
        "defaultModel": model.get("default"),
        "provider": model.get("provider"),
        "baseUrl": model.get("base_url"),
    },
}))
`;

  return runHermesPythonJson(agent, script, { timeout: 30000 });
}

function serializeHermesChannelCatalog() {
  return HERMES_CHANNEL_TYPES.map((type) => {
    const definition = HERMES_CHANNEL_DEFINITIONS[type];
    return {
      id: definition.type,
      type: definition.type,
      label: definition.label,
      emoji: definition.emoji,
      description: definition.description,
      configFields: definition.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        placeholder: field.placeholder || "",
        help: field.help || "",
        options: field.options || null,
      })),
    };
  });
}

function isHermesChannelConfigured(definition, envValues = {}, platformDetails = {}) {
  if (platformDetails.connected || platformDetails.enabled) return true;
  return definition.requiredKeys.some((key) => {
    const value = envValues[key];
    return typeof value === "string" && value.trim();
  });
}

function redactHermesChannelConfig(definition, envValues = {}) {
  return definition.fields.reduce((config, field) => {
    const rawValue = String(envValues[field.key] || "");
    if (field.type === "password") {
      config[field.key] = rawValue ? HERMES_CHANNEL_REDACTED : "";
      return config;
    }
    config[field.key] = rawValue;
    return config;
  }, {});
}

function serializeKnownHermesChannel(definition, snapshot) {
  const envValues = snapshot?.envValues?.[definition.type] || {};
  const platformDetails = snapshot?.platformDetails?.[definition.type] || {};
  const platformStatus = snapshot?.runtimeStatus?.platforms?.[definition.type] || {};
  const discoveredTargets =
    snapshot?.directory?.platforms?.[definition.type] || [];

  return {
    id: definition.type,
    type: definition.type,
    name: definition.label,
    emoji: definition.emoji,
    description: definition.description,
    configured: isHermesChannelConfigured(definition, envValues, platformDetails),
    readOnly: false,
    homeChannel: platformDetails.home_channel || null,
    discoveredTargets,
    config: redactHermesChannelConfig(definition, envValues),
    configFields: definition.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      placeholder: field.placeholder || "",
      help: field.help || "",
      options: field.options || null,
    })),
    status: {
      state: platformStatus.state || null,
      errorCode: platformStatus.error_code || null,
      errorMessage: platformStatus.error_message || null,
      updatedAt: platformStatus.updated_at || null,
    },
  };
}

function serializeUnknownHermesChannel(type, snapshot) {
  const platformDetails = snapshot?.platformDetails?.[type] || {};
  const platformStatus = snapshot?.runtimeStatus?.platforms?.[type] || {};
  const discoveredTargets = snapshot?.directory?.platforms?.[type] || [];

  return {
    id: type,
    type,
    name: humanizeHermesChannelType(type),
    emoji: "📡",
    description:
      "Configured directly in Hermes outside Nora. Viewable here, but not editable from this tab yet.",
    configured: Boolean(platformDetails.connected || platformDetails.enabled),
    readOnly: true,
    homeChannel: platformDetails.home_channel || null,
    discoveredTargets,
    config: {},
    configFields: [],
    status: {
      state: platformStatus.state || null,
      errorCode: platformStatus.error_code || null,
      errorMessage: platformStatus.error_message || null,
      updatedAt: platformStatus.updated_at || null,
    },
  };
}

function normalizeHermesChannelInput(definition, inputConfig = {}, existingEnv = {}) {
  const normalized = {};

  for (const field of definition.fields) {
    let value = inputConfig[field.key];

    if (field.type === "password" && value === HERMES_CHANNEL_REDACTED) {
      value = existingEnv[field.key] || "";
    }

    if (value == null) {
      value = "";
    }

    value = String(value).trim();
    normalized[field.key] = value;
  }

  for (const requiredKey of definition.requiredKeys) {
    if (!String(normalized[requiredKey] || "").trim()) {
      const field = definition.fields.find((entry) => entry.key === requiredKey);
      const error = new Error(`${field?.label || requiredKey} is required`);
      error.statusCode = 400;
      throw error;
    }
  }

  return normalized;
}

function definitionForChannelType(type) {
  return HERMES_CHANNEL_DEFINITIONS[String(type || "").trim().toLowerCase()] || null;
}

async function readHermesRuntimeSnapshot(agent) {
  const definitions = serializeHermesChannelCatalog().map((entry) => ({
    type: entry.type,
    configFields: entry.configFields.map((field) => ({ key: field.key })),
  }));

  const script = `
import json

from gateway.channel_directory import load_directory
from gateway.config import load_gateway_config
from gateway.status import read_runtime_status
from hermes_cli.config import get_config_path, get_env_value, load_config

definitions = ${JSON.stringify(definitions)}
config = load_gateway_config()
connected = {platform.value for platform in config.get_connected_platforms()}
platform_details = {}
for platform, platform_config in config.platforms.items():
    platform_details[platform.value] = {
        "enabled": bool(getattr(platform_config, "enabled", False)),
        "connected": platform.value in connected,
        "reply_to_mode": getattr(platform_config, "reply_to_mode", None),
        "home_channel": platform_config.home_channel.to_dict() if getattr(platform_config, "home_channel", None) else None,
        "extra_keys": sorted(list((getattr(platform_config, "extra", {}) or {}).keys())),
    }

env_values = {}
for definition in definitions:
    values = {}
    for field in definition.get("configFields", []):
        key = field["key"]
        value = get_env_value(key)
        values[key] = value if value is not None else ""
    env_values[definition["type"]] = values

jobs_count = None
try:
    from cron.jobs import list_jobs
    jobs_count = len(list_jobs(include_disabled=True))
except Exception:
    jobs_count = None

runtime_config = load_config() or {}
model_config = runtime_config.get("model") or {}

print(json.dumps({
    "runtimeStatus": read_runtime_status() or {},
    "directory": load_directory() or {"updated_at": None, "platforms": {}},
    "platformDetails": platform_details,
    "envValues": env_values,
    "jobsCount": jobs_count,
    "modelConfig": {
        "defaultModel": model_config.get("default"),
        "provider": model_config.get("provider"),
        "baseUrl": model_config.get("base_url"),
        "configPath": str(get_config_path()),
    },
}))
`;

  return runHermesPythonJson(agent, script, { timeout: 30000 });
}

async function restartHermesRuntime(agent) {
  await containerManager.restart(agent);
  const readiness = await waitForAgentReadiness(
    {
      host: agent.host,
      runtimeHost: agent.runtime_host,
      runtimePort: agent.runtime_port,
      gatewayHostPort: agent.gateway_host_port,
      gatewayHost: agent.gateway_host,
      gatewayPort: agent.gateway_port,
      checkGateway: false,
    },
    {
      runtime: {
        attempts: 8,
        intervalMs: 5000,
        timeoutMs: 5000,
      },
    }
  );

  if (!readiness.ok) {
    const error = new Error(
      `Hermes runtime did not recover after configuration change (${readiness.runtime?.error || "unreachable"})`
    );
    error.statusCode = 502;
    throw error;
  }
}

async function persistHermesChannelConfig(agent, definition, config) {
  const script = `
import json

from hermes_cli.config import remove_env_value, save_env_value

payload = ${JSON.stringify(config)}
for key, value in payload.items():
    text = "" if value is None else str(value).strip()
    if text:
        save_env_value(key, text)
    else:
        remove_env_value(key)
print(json.dumps({"ok": True}))
`;

  await runHermesPythonJson(agent, script, { timeout: 30000 });
}

async function removeHermesChannelConfig(agent, definition) {
  const script = `
import json

from hermes_cli.config import remove_env_value

keys = ${JSON.stringify(definition.fields.map((field) => field.key))}
for key in keys:
    remove_env_value(key)
print(json.dumps({"ok": True}))
`;

  await runHermesPythonJson(agent, script, { timeout: 30000 });
}

function buildHermesGatewaySummary(snapshot) {
  const directoryPlatforms = snapshot?.directory?.platforms || {};
  const configuredPlatforms = Object.values(snapshot?.platformDetails || {}).filter(
    (entry) => entry?.connected || entry?.enabled
  );
  const discoveredTargetsCount = Object.values(directoryPlatforms).reduce(
    (count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
    0
  );

  return {
    state: snapshot?.runtimeStatus?.gateway_state || null,
    exitReason: snapshot?.runtimeStatus?.exit_reason || null,
    restartRequested: Boolean(snapshot?.runtimeStatus?.restart_requested),
    activeAgents: snapshot?.runtimeStatus?.active_agents || 0,
    updatedAt: snapshot?.runtimeStatus?.updated_at || null,
    configuredPlatformsCount: configuredPlatforms.length,
    discoveredTargetsCount,
    jobsCount:
      typeof snapshot?.jobsCount === "number" ? snapshot.jobsCount : null,
    platformStates: snapshot?.runtimeStatus?.platforms || {},
  };
}

async function listHermesChannels(agent) {
  const snapshot = await readHermesRuntimeSnapshot(agent);
  const knownChannels = HERMES_CHANNEL_TYPES.map((type) =>
    serializeKnownHermesChannel(HERMES_CHANNEL_DEFINITIONS[type], snapshot)
  ).filter(
    (channel) =>
      channel.configured ||
      channel.discoveredTargets.length > 0 ||
      channel.status.state ||
      channel.homeChannel
  );

  const unknownTypes = new Set([
    ...Object.keys(snapshot?.platformDetails || {}),
    ...Object.keys(snapshot?.directory?.platforms || {}),
    ...Object.keys(snapshot?.runtimeStatus?.platforms || {}),
  ]);

  for (const type of HERMES_CHANNEL_TYPES) {
    unknownTypes.delete(type);
  }

  const readOnlyChannels = Array.from(unknownTypes)
    .sort()
    .map((type) => serializeUnknownHermesChannel(type, snapshot))
    .filter(
      (channel) =>
        channel.configured ||
        channel.discoveredTargets.length > 0 ||
        channel.status.state
    );

  return {
    channels: [...knownChannels, ...readOnlyChannels],
    availableTypes: serializeHermesChannelCatalog(),
    gateway: buildHermesGatewaySummary(snapshot),
    directoryUpdatedAt: snapshot?.directory?.updated_at || null,
  };
}

async function saveHermesChannel(agent, type, inputConfig = {}, { create = false } = {}) {
  const definition = definitionForChannelType(type);
  if (!definition) {
    const error = new Error("Unsupported Hermes channel type");
    error.statusCode = 400;
    throw error;
  }

  const snapshot = await readHermesRuntimeSnapshot(agent);
  const platformDetails = snapshot?.platformDetails?.[definition.type] || {};
  const existingEnv = snapshot?.envValues?.[definition.type] || {};
  const alreadyConfigured = isHermesChannelConfigured(
    definition,
    existingEnv,
    platformDetails
  );

  if (create && alreadyConfigured) {
    const error = new Error(`${definition.label} is already configured`);
    error.statusCode = 409;
    throw error;
  }

  const normalized = normalizeHermesChannelInput(
    definition,
    inputConfig,
    existingEnv
  );

  await persistHermesChannelConfig(agent, definition, normalized);
  await restartHermesRuntime(agent);

  const payload = await listHermesChannels(agent);
  return {
    payload,
    channel:
      payload.channels.find((entry) => entry.type === definition.type) || null,
  };
}

async function deleteHermesChannel(agent, type) {
  const definition = definitionForChannelType(type);
  if (!definition) {
    const error = new Error("Unsupported Hermes channel type");
    error.statusCode = 400;
    throw error;
  }

  await removeHermesChannelConfig(agent, definition);
  await restartHermesRuntime(agent);
  return listHermesChannels(agent);
}

async function testHermesChannel(agent, type) {
  const payload = await listHermesChannels(agent);
  const channel = payload.channels.find((entry) => entry.type === type);
  if (!channel) {
    const error = new Error("Channel not found");
    error.statusCode = 404;
    throw error;
  }

  if (!channel.configured) {
    return {
      success: false,
      error: `${channel.name} is not configured yet`,
    };
  }

  if (channel.status.errorMessage) {
    return {
      success: false,
      error: channel.status.errorMessage,
      state: channel.status.state,
    };
  }

  if (channel.status.state === "connected") {
    return {
      success: true,
      message: `${channel.name} is configured and Hermes reports it as connected.`,
      state: channel.status.state,
    };
  }

  if (channel.status.state === "fatal" || channel.status.state === "disconnected") {
    return {
      success: false,
      error: `${channel.name} is configured but Hermes reports ${channel.status.state}.`,
      state: channel.status.state,
    };
  }

  return {
    success: true,
    message:
      channel.discoveredTargets.length > 0
        ? `${channel.name} is configured and has discovered ${channel.discoveredTargets.length} target(s).`
        : `${channel.name} configuration is saved. Hermes has not reported active channel discovery yet.`,
    state: channel.status.state || null,
  };
}

module.exports = {
  HERMES_CHANNEL_REDACTED,
  HERMES_CHANNEL_DEFINITIONS,
  HERMES_CHANNEL_TYPES,
  definitionForChannelType,
  listHermesChannels,
  persistHermesModelConfig,
  readHermesRuntimeSnapshot,
  saveHermesChannel,
  deleteHermesChannel,
  testHermesChannel,
};
