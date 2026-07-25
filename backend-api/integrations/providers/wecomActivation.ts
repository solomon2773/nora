const WECOM_PLUGIN_ID = "wecom-openclaw-plugin";
const WECOM_PLUGIN_SPEC = "@wecom/wecom-openclaw-plugin";
const OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS = 240000;
const OPENCLAW_GATEWAY_RESTART_TIMEOUT_MS = 120000;
const OPENCLAW_ACTIVE_STATUSES = new Set(["running", "warning"]);

type WecomConfig = Record<string, any>;
type WecomActivationOutcome = {
  deferred: boolean;
  activation: {
    lifecycleStatus: string;
    readiness: string;
    lastError: string;
    lastVerifiedAt: string;
  };
};

type WecomVerificationResult = {
  success: boolean;
  message: string;
  activation: WecomActivationOutcome["activation"];
};
const DEFAULT_WECOM_AGENT_CALLBACK_PATH = "/plugins/wecom/agent/default";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => stringValue(entry)).filter(Boolean))];
  }
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeGroupSenderAllowlists(value: unknown): Record<string, { allowFrom: string[] }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, { allowFrom: string[] }> = {};
  for (const [groupId, entry] of Object.entries(value as Record<string, any>)) {
    const normalizedGroupId = stringValue(groupId);
    const allowFrom = parseStringList(entry?.allowFrom);
    if (normalizedGroupId && allowFrom.length) {
      normalized[normalizedGroupId] = { allowFrom };
    }
  }
  return normalized;
}

function normalizeAgentId(value: unknown): number | string | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const trimmed = stringValue(value);
  return trimmed || undefined;
}

function buildAccountConfig(account: Record<string, any> = {}) {
  const entry: Record<string, any> = {};
  const bot = account?.bot || {};
  const agent = account?.agent || {};

  const connectionMode = stringValue(bot.connectionMode || "websocket") || "websocket";
  const botId = stringValue(bot.botId);
  const botSecret = stringValue(bot.secret);
  const hasBotConfig = Boolean(botId || botSecret || stringValue(bot.websocketUrl));

  if (hasBotConfig) {
    if (connectionMode) entry.connectionMode = connectionMode;
    if (botId) entry.botId = botId;
    if (botSecret) entry.secret = botSecret;
    if (stringValue(bot.websocketUrl)) entry.websocketUrl = stringValue(bot.websocketUrl);
    entry.sendThinkingMessage = booleanValue(bot.sendThinkingMessage, true);
  }

  const agentConfig: Record<string, any> = {};
  if (stringValue(agent.corpId)) agentConfig.corpId = stringValue(agent.corpId);
  if (stringValue(agent.corpSecret)) agentConfig.corpSecret = stringValue(agent.corpSecret);
  if (normalizeAgentId(agent.agentId) !== undefined) {
    agentConfig.agentId = normalizeAgentId(agent.agentId);
  }
  if (stringValue(agent.token)) agentConfig.token = stringValue(agent.token);
  if (stringValue(agent.encodingAESKey)) {
    agentConfig.encodingAESKey = stringValue(agent.encodingAESKey);
  }
  if (Object.keys(agentConfig).length) entry.agent = agentConfig;

  return entry;
}

/**
 * Project Nora's selected WeCom mode and accounts into OpenClaw `channels.wecom` config.
 *
 * @param {Object} [config={}] - Canonical secret-bearing WeCom configuration.
 * @returns {Object} OpenClaw plugin channel configuration.
 */
export function buildWecomOpenClawChannelConfig(config: WecomConfig = {}): Record<string, any> {
  const mode = stringValue(config?.mode || "bot") || "bot";
  const defaultAccount = config?.defaultAccount || {};
  const extraAccounts = Array.isArray(config?.accounts) ? config.accounts : [];
  const filteredDefaultAccount = {
    ...defaultAccount,
    bot: mode === "agent" ? {} : defaultAccount?.bot || {},
    agent: mode === "bot" ? {} : defaultAccount?.agent || {},
  };
  const filteredExtraAccounts = extraAccounts.map((account: Record<string, any>) => ({
    ...account,
    bot: mode === "agent" ? {} : account?.bot || {},
    agent: mode === "bot" ? {} : account?.agent || {},
  }));
  const topLevel = buildAccountConfig(filteredDefaultAccount);
  const channelConfig: Record<string, any> = {
    enabled: true,
    ...topLevel,
  };

  const dmPolicy = stringValue(config?.policies?.dmPolicy);
  const groupPolicy = stringValue(config?.policies?.groupPolicy);
  const allowFrom = parseStringList(config?.policies?.allowFrom);
  const groupAllowFrom = parseStringList(config?.policies?.groupAllowFrom);
  const groups = normalizeGroupSenderAllowlists(config?.policies?.groups);
  const mediaLocalRoots = parseStringList(config?.advanced?.mediaLocalRoots);
  const egressProxyUrl = stringValue(config?.advanced?.egressProxyUrl);

  if (dmPolicy) channelConfig.dmPolicy = dmPolicy;
  if (groupPolicy) channelConfig.groupPolicy = groupPolicy;
  if (allowFrom.length) channelConfig.allowFrom = allowFrom;
  if (groupAllowFrom.length) channelConfig.groupAllowFrom = groupAllowFrom;
  if (Object.keys(groups).length) channelConfig.groups = groups;
  if (mediaLocalRoots.length) channelConfig.mediaLocalRoots = mediaLocalRoots;
  if (egressProxyUrl) {
    channelConfig.network = {
      ...(channelConfig.network || {}),
      egressProxyUrl,
    };
  }

  if (booleanValue(config?.advanced?.dynamicAgentEnabled, false)) {
    channelConfig.dynamicAgents = {
      enabled: true,
    };
  }

  if (filteredExtraAccounts.length > 0) {
    const defaultAccountId = stringValue(filteredDefaultAccount.id || "default") || "default";
    const accounts: Record<string, any> = {};
    accounts[defaultAccountId] = buildAccountConfig(filteredDefaultAccount);
    filteredExtraAccounts.forEach((account: Record<string, any>, index: number) => {
      const accountId =
        stringValue(account?.id || `account-${index + 1}`) || `account-${index + 1}`;
      accounts[accountId] = buildAccountConfig(account || {});
    });
    channelConfig.defaultAccount = defaultAccountId;
    channelConfig.accounts = accounts;
  }

  return channelConfig;
}

export function buildWecomPluginInstallCommand(): string {
  return [
    "set -eu",
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
    "export npm_config_audit=false",
    "export npm_config_fund=false",
    "export npm_config_progress=false",
    "export npm_config_update_notifier=false",
    'if ! printf "%s" "${NODE_OPTIONS:-}" | grep -Eq "(^| )--max-old-space-size="; then',
    '  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${OPENCLAW_PLUGIN_INSTALL_MAX_OLD_SPACE_MB:-256}"',
    "fi",
    "export NODE_OPTIONS",
    `"$OPENCLAW_BIN" plugins inspect ${shellSingleQuote(WECOM_PLUGIN_ID)} >/dev/null 2>&1 || "$OPENCLAW_BIN" plugins install ${shellSingleQuote(WECOM_PLUGIN_SPEC)} --force`,
    `"$OPENCLAW_BIN" plugins inspect ${shellSingleQuote(WECOM_PLUGIN_ID)} >/dev/null 2>&1`,
  ].join("\n");
}

export function buildWecomPluginUninstallCommand(): string {
  return [
    "set -eu",
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
    `if "$OPENCLAW_BIN" plugins inspect ${shellSingleQuote(WECOM_PLUGIN_ID)} >/dev/null 2>&1; then`,
    `  printf 'y\\n' | "$OPENCLAW_BIN" plugins uninstall ${shellSingleQuote(WECOM_PLUGIN_ID)}`,
    "fi",
  ].join("\n");
}

export function buildWecomGatewayReloadCommand(): string {
  return [
    "set -eu",
    'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
    'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
    '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
    'self_pid="$$"',
    "for proc in /proc/[0-9]*; do",
    '  pid="${proc##*/}"',
    '  [ "$pid" = "$self_pid" ] && continue',
    '  comm="$(cat "$proc/comm" 2>/dev/null || true)"',
    '  if [ "$comm" = "openclaw" ]; then',
    '    kill -USR1 "$pid"',
    "    exit 0",
    "  fi",
    '  if [ "$comm" = "openclaw-gateway" ]; then',
    '    kill -USR1 "$pid"',
    "    exit 0",
    "  fi",
    '  cmdline="$(tr "\\000" " " < "$proc/cmdline" 2>/dev/null || true)"',
    '  case "$cmdline" in',
    '    *"/usr/local/bin/node /usr/local/bin/openclaw gateway"*|*" node /usr/local/bin/openclaw gateway"*|*" openclaw gateway --port "*|*" openclaw gateway "*)',
    '      case "$comm" in',
    '        node|openclaw|openclaw-gateway) kill -USR1 "$pid"; exit 0 ;;',
    "      esac",
    "      ;;",
    "  esac",
    "done",
    '"$OPENCLAW_BIN" gateway restart',
  ].join("\n");
}

function isAcceptableGatewayReloadError(error: unknown): boolean {
  const message = String((error as Error)?.message || "");
  return (
    /gateway service disabled/i.test(message) ||
    /systemd user services are unavailable/i.test(message) ||
    /run the gateway in the foreground/i.test(message)
  );
}

function activationState(
  lifecycleStatus: string,
  readiness: string,
  lastError = "",
  lastVerifiedAt = "",
): WecomActivationOutcome["activation"] {
  return {
    lifecycleStatus,
    readiness,
    lastError,
    lastVerifiedAt,
  };
}

function inferWecomMode(channelConfig: Record<string, any> = {}): string {
  const topLevelHasBot = Boolean(
    stringValue(channelConfig.botId) ||
    stringValue(channelConfig.secret) ||
    stringValue(channelConfig.websocketUrl),
  );
  const topLevelHasAgent = Boolean(
    stringValue(channelConfig?.agent?.corpId) ||
    stringValue(channelConfig?.agent?.corpSecret) ||
    normalizeAgentId(channelConfig?.agent?.agentId) !== undefined ||
    stringValue(channelConfig?.agent?.token) ||
    stringValue(channelConfig?.agent?.encodingAESKey),
  );
  const accounts =
    channelConfig?.accounts && typeof channelConfig.accounts === "object"
      ? Object.values(channelConfig.accounts)
      : [];
  const accountHasBot = accounts.some((account: any) =>
    Boolean(
      stringValue(account?.botId) ||
      stringValue(account?.secret) ||
      stringValue(account?.websocketUrl),
    ),
  );
  const accountHasAgent = accounts.some((account: any) =>
    Boolean(
      stringValue(account?.agent?.corpId) ||
      stringValue(account?.agent?.corpSecret) ||
      normalizeAgentId(account?.agent?.agentId) !== undefined ||
      stringValue(account?.agent?.token) ||
      stringValue(account?.agent?.encodingAESKey),
    ),
  );
  const hasBot = topLevelHasBot || accountHasBot;
  const hasAgent = topLevelHasAgent || accountHasAgent;

  if (hasBot && hasAgent) return "both";
  if (hasBot) return "bot";
  if (hasAgent) return "agent";
  return "none";
}

function parseWecomConfigOutput(rawOutput: unknown): Record<string, any> | null {
  const text = String(rawOutput || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function canonicalizeWecomConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    const canonicalized = value.map((entry) => canonicalizeWecomConfig(entry));
    if (canonicalized.every((entry) => typeof entry === "string")) {
      return [...new Set(canonicalized as string[])].sort();
    }
    return canonicalized;
  }
  if (!value || typeof value !== "object") return value;

  const objectValue = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue).sort()) {
    const child = canonicalizeWecomConfig(objectValue[key]);
    if (child === undefined) continue;
    next[key] = child;
  }
  return next;
}

/**
 * Install and enable the WeCom plugin, replace stale runtime config, reload, and verify presence.
 *
 * Stopped agents return a deferred activation without runtime side effects. Running-agent steps
 * are sequential and are not rolled back if a later command fails.
 *
 * @param {Object} agent - OpenClaw agent runtime record.
 * @param {Object} normalizedConfig - Canonical secret-bearing WeCom configuration.
 * @param {Object} deps - Container-command and gateway RPC boundaries.
 * @returns {Promise<Object>} Deferred or active lifecycle outcome.
 */
export async function activateWecomForOpenClawAgent(
  agent: Record<string, any>,
  normalizedConfig: WecomConfig,
  deps: {
    runContainerCommand: (
      agent: Record<string, any>,
      command: string,
      options?: { timeout?: number },
    ) => Promise<{ output?: string }>;
    rpcCall: (
      agent: Record<string, any>,
      method: string,
      params?: Record<string, any>,
      timeout?: number,
    ) => Promise<Record<string, any>>;
  },
): Promise<WecomActivationOutcome> {
  if (!agent || !OPENCLAW_ACTIVE_STATUSES.has(String(agent.status || ""))) {
    return {
      deferred: true,
      activation: activationState(
        "saved",
        "pending_activation",
        "Start the agent to install and activate the WeCom plugin.",
        "",
      ),
    };
  }

  const channelConfig = buildWecomOpenClawChannelConfig(normalizedConfig);
  await deps.runContainerCommand(agent, buildWecomPluginInstallCommand(), {
    timeout: OPENCLAW_PLUGIN_INSTALL_TIMEOUT_MS,
  });

  const snapshot = await deps.rpcCall(agent, "config.get");
  const baseHash =
    typeof snapshot?.hash === "string" && snapshot.hash.trim() ? snapshot.hash.trim() : null;
  if (!baseHash) {
    throw new Error("OpenClaw runtime did not return a config hash for WeCom activation.");
  }

  await deps.rpcCall(agent, "config.patch", {
    raw: JSON.stringify({
      channels: { wecom: null },
      plugins: {
        entries: {
          [WECOM_PLUGIN_ID]: {
            enabled: false,
          },
        },
      },
    }),
    baseHash,
  });

  const refreshedSnapshot = await deps.rpcCall(agent, "config.get");
  const refreshedBaseHash =
    typeof refreshedSnapshot?.hash === "string" && refreshedSnapshot.hash.trim()
      ? refreshedSnapshot.hash.trim()
      : null;
  if (!refreshedBaseHash) {
    throw new Error(
      "OpenClaw runtime did not return a refreshed config hash for WeCom activation.",
    );
  }

  await deps.rpcCall(agent, "config.patch", {
    raw: JSON.stringify({
      channels: { wecom: channelConfig },
      plugins: {
        entries: {
          [WECOM_PLUGIN_ID]: {
            enabled: true,
          },
        },
      },
    }),
    baseHash: refreshedBaseHash,
  });

  try {
    await deps.runContainerCommand(agent, buildWecomGatewayReloadCommand(), {
      timeout: OPENCLAW_GATEWAY_RESTART_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isAcceptableGatewayReloadError(error)) throw error;
  }

  await deps.runContainerCommand(
    agent,
    [
      "set -eu",
      'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
      'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
      '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
      `"$OPENCLAW_BIN" plugins inspect ${shellSingleQuote(WECOM_PLUGIN_ID)} >/dev/null 2>&1`,
      '"$OPENCLAW_BIN" config get channels.wecom --json >/dev/null',
    ].join("\n"),
    { timeout: 30000 },
  );

  return {
    deferred: false,
    activation: activationState("active", "ready", "", new Date().toISOString()),
  };
}

/**
 * Compare the installed plugin's complete runtime config with Nora's saved WeCom state.
 *
 * Verification failures are returned as activation status rather than thrown; stopped agents
 * report pending activation.
 *
 * @param {Object} agent - OpenClaw agent runtime record.
 * @param {Object} normalizedConfig - Canonical secret-bearing WeCom configuration.
 * @param {Object} deps - Container-command and gateway RPC boundaries.
 * @returns {Promise<Object>} Connectivity and activation-state result for the caller to persist.
 */
export async function verifyWecomForOpenClawAgent(
  agent: Record<string, any>,
  normalizedConfig: WecomConfig,
  deps: {
    runContainerCommand: (
      agent: Record<string, any>,
      command: string,
      options?: { timeout?: number },
    ) => Promise<{ output?: string }>;
    rpcCall: (
      agent: Record<string, any>,
      method: string,
      params?: Record<string, any>,
      timeout?: number,
    ) => Promise<Record<string, any>>;
  },
): Promise<WecomVerificationResult> {
  if (!agent || !OPENCLAW_ACTIVE_STATUSES.has(String(agent.status || ""))) {
    return {
      success: false,
      message: "Start the agent to finish WeCom activation and runtime verification.",
      activation: activationState(
        "saved",
        "pending_activation",
        "Start the agent to finish WeCom activation and runtime verification.",
        "",
      ),
    };
  }

  try {
    const snapshot = await deps.rpcCall(agent, "config.get");
    const baseHash =
      typeof snapshot?.hash === "string" && snapshot.hash.trim() ? snapshot.hash.trim() : null;
    if (!baseHash) {
      throw new Error("OpenClaw gateway responded without a config hash.");
    }

    await deps.runContainerCommand(
      agent,
      [
        "set -eu",
        'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
        'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
        '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
        `"$OPENCLAW_BIN" plugins inspect ${shellSingleQuote(WECOM_PLUGIN_ID)} >/dev/null 2>&1`,
      ].join("\n"),
      { timeout: 30000 },
    );

    const configResult = await deps.runContainerCommand(
      agent,
      [
        "set -eu",
        'OPENCLAW_BIN="${OPENCLAW_CLI_PATH:-/usr/local/bin/openclaw}"',
        'if [ ! -x "$OPENCLAW_BIN" ]; then OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"; fi',
        '[ -n "$OPENCLAW_BIN" ] && [ -x "$OPENCLAW_BIN" ]',
        '"$OPENCLAW_BIN" config get channels.wecom --json',
      ].join("\n"),
      { timeout: 30000 },
    );

    const runtimeConfig = parseWecomConfigOutput(configResult?.output);
    const expectedMode = stringValue(normalizedConfig?.mode || "bot") || "bot";
    const runtimeMode = inferWecomMode(runtimeConfig || {});
    const expectedRuntimeConfig = buildWecomOpenClawChannelConfig(normalizedConfig);

    if (runtimeMode === "none") {
      throw new Error("WeCom config was not found in the OpenClaw runtime.");
    }
    if (expectedMode !== runtimeMode) {
      throw new Error(
        `WeCom runtime config is active in ${runtimeMode} mode, but Nora saved ${expectedMode} mode.`,
      );
    }
    if (
      JSON.stringify(canonicalizeWecomConfig(runtimeConfig || {})) !==
      JSON.stringify(canonicalizeWecomConfig(expectedRuntimeConfig))
    ) {
      throw new Error(
        "WeCom runtime config does not fully match Nora's saved configuration. Save again to re-apply the latest settings.",
      );
    }

    return {
      success: true,
      message: "WeCom plugin is installed, the gateway responded, and the saved config is active.",
      activation: activationState("active", "ready", "", new Date().toISOString()),
    };
  } catch (error) {
    const message =
      String((error as Error)?.message || "WeCom runtime verification failed.")
        .trim()
        .replace(/\s+/g, " ") || "WeCom runtime verification failed.";
    return {
      success: false,
      message,
      activation: activationState("activation_failed", "error", message, ""),
    };
  }
}

/**
 * Remove WeCom runtime config and plugin state from an active OpenClaw agent.
 *
 * Stopped agents and active agents without a config hash are no-ops. Removal is sequential and not
 * transactional, so later failure leaves earlier changes applied.
 *
 * @param {Object} agent - OpenClaw agent runtime record.
 * @param {Object} deps - Gateway RPC and container-command boundaries.
 * @returns {Promise<void>}
 */
export async function deactivateWecomForOpenClawAgent(
  agent: Record<string, any>,
  deps: {
    rpcCall: (
      agent: Record<string, any>,
      method: string,
      params?: Record<string, any>,
      timeout?: number,
    ) => Promise<Record<string, any>>;
    runContainerCommand: (
      agent: Record<string, any>,
      command: string,
      options?: { timeout?: number },
    ) => Promise<{ output?: string }>;
  },
): Promise<void> {
  if (!agent || !OPENCLAW_ACTIVE_STATUSES.has(String(agent.status || ""))) return;
  const snapshot = await deps.rpcCall(agent, "config.get");
  const baseHash =
    typeof snapshot?.hash === "string" && snapshot.hash.trim() ? snapshot.hash.trim() : null;
  if (!baseHash) return;

  await deps.rpcCall(agent, "config.patch", {
    raw: JSON.stringify({
      channels: { wecom: null },
      plugins: {
        entries: {
          [WECOM_PLUGIN_ID]: {
            enabled: false,
          },
        },
      },
    }),
    baseHash,
  });

  await deps.runContainerCommand(agent, buildWecomPluginUninstallCommand(), {
    timeout: 60000,
  });

  try {
    await deps.runContainerCommand(agent, buildWecomGatewayReloadCommand(), {
      timeout: OPENCLAW_GATEWAY_RESTART_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isAcceptableGatewayReloadError(error)) throw error;
  }
}
