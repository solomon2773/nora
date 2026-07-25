import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

type WecomConfig = Record<string, any>;
const DEFAULT_WECOM_AGENT_CALLBACK_PATH = "/plugins/wecom/agent/default";

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function normalizePolicyGroups(value: unknown): Record<string, { allowFrom: string[] }> {
  if (!value) return {};
  const raw =
    typeof value === "string"
      ? (() => {
          const trimmed = value.trim();
          if (!trimmed) return null;
          try {
            return JSON.parse(trimmed);
          } catch {
            throw new Error("Per-group sender allowlists must be valid JSON.");
          }
        })()
      : value;

  if (!raw) return {};
  if (!isPlainObject(raw)) {
    throw new Error("Per-group sender allowlists must be a JSON object.");
  }

  const normalized: Record<string, { allowFrom: string[] }> = {};
  for (const [groupId, entry] of Object.entries(raw)) {
    const normalizedGroupId = stringValue(groupId);
    if (!normalizedGroupId || !isPlainObject(entry)) continue;
    const allowFrom = parseStringList(entry.allowFrom);
    if (allowFrom.length) normalized[normalizedGroupId] = { allowFrom };
  }
  return normalized;
}

function numberValue(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCallbackPath(value: unknown): string {
  const normalized = stringValue(value || DEFAULT_WECOM_AGENT_CALLBACK_PATH);
  if (!normalized || normalized === "/api/wecom/callback") {
    return DEFAULT_WECOM_AGENT_CALLBACK_PATH;
  }
  return normalized;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function setNested(target: Record<string, any>, path: string, value: unknown) {
  const parts = path.split(".");
  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift() as string;
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[0]] = value;
}

function expandDottedInput(rawConfig: Record<string, unknown> = {}) {
  const next: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawConfig || {})) {
    if (value === undefined) continue;
    if (key.includes(".")) {
      setNested(next, key, value);
    } else if (isPlainObject(value)) {
      next[key] = expandDottedInput(value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function normalizeAccountEntry(rawAccount: Record<string, any> = {}): Record<string, any> {
  const source = isPlainObject(rawAccount) ? rawAccount : {};
  return {
    id: stringValue(source.id),
    label: stringValue(source.label || source.name),
    bot: {
      connectionMode: "websocket",
      name: stringValue(source?.bot?.name),
      botId: stringValue(source?.bot?.botId),
      secret: stringValue(source?.bot?.secret),
      websocketUrl:
        stringValue(source?.bot?.websocketUrl || "wss://openws.work.weixin.qq.com") ||
        "wss://openws.work.weixin.qq.com",
      sendThinkingMessage: boolValue(source?.bot?.sendThinkingMessage, true),
    },
    agent: {
      corpId: stringValue(source?.agent?.corpId),
      corpSecret: stringValue(source?.agent?.corpSecret),
      agentId: numberValue(source?.agent?.agentId),
      token: stringValue(source?.agent?.token),
      encodingAESKey: stringValue(source?.agent?.encodingAESKey),
      callbackPath: normalizeCallbackPath(source?.agent?.callbackPath),
    },
  };
}

function parseAccountsJson(value: unknown): Record<string, any>[] {
  const shapeErrors = new Set([
    "Additional Accounts JSON must be a JSON array.",
    "Additional Accounts JSON must be an array of account objects.",
  ]);
  if (Array.isArray(value)) {
    if (!value.every((entry) => isPlainObject(entry))) {
      throw new Error("Additional Accounts JSON must be an array of account objects.");
    }
    return value as Record<string, any>[];
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("Additional Accounts JSON must be a JSON array.");
    }
    if (!parsed.every((entry) => isPlainObject(entry))) {
      throw new Error("Additional Accounts JSON must be an array of account objects.");
    }
    return parsed as Record<string, any>[];
  } catch (error) {
    if (error instanceof Error && shapeErrors.has(error.message)) throw error;
    throw new Error("Additional Accounts JSON must be valid JSON.");
  }
}

/**
 * Expand dotted input and canonicalize WeCom accounts, policies, advanced settings, and status.
 *
 * Malformed additional-account or per-group allowlist JSON is rejected rather than discarded.
 *
 * @param {Object} [rawConfig={}] - Nested or dotted WeCom configuration.
 * @returns {Object} Canonical saved configuration.
 */
export function normalizeWecomConfigInput(rawConfig: Record<string, unknown> = {}): WecomConfig {
  const next = expandDottedInput(rawConfig);
  const mode = stringValue(next.mode || "bot") || "bot";
  const defaultAccount = normalizeAccountEntry(next.defaultAccount || {});
  const accounts = parseAccountsJson(next.accountsJson || next.accounts).map((entry, index) => {
    const normalized = normalizeAccountEntry(entry);
    if (!normalized.id) normalized.id = `account-${index + 1}`;
    return normalized;
  });
  const activation = isPlainObject(next.activation) ? next.activation : {};

  return {
    mode: ["bot", "agent", "both"].includes(mode) ? mode : "bot",
    defaultAccount,
    accounts,
    policies: {
      dmPolicy: stringValue(next?.policies?.dmPolicy || "pairing") || "pairing",
      allowFrom: parseStringList(next?.policies?.allowFrom),
      groupPolicy: stringValue(next?.policies?.groupPolicy || "open") || "open",
      groupAllowFrom: parseStringList(next?.policies?.groupAllowFrom),
      groups: normalizePolicyGroups(next?.policies?.groupsJson || next?.policies?.groups),
    },
    advanced: {
      mediaLocalRoots: stringValue(next?.advanced?.mediaLocalRoots),
      egressProxyUrl: stringValue(next?.advanced?.egressProxyUrl),
      dynamicAgentEnabled: boolValue(next?.advanced?.dynamicAgentEnabled, false),
    },
    activation: {
      lifecycleStatus: stringValue(activation.lifecycleStatus || "saved") || "saved",
      readiness: stringValue(activation.readiness || "pending_activation") || "pending_activation",
      lastError: stringValue(activation.lastError),
      lastVerifiedAt: stringValue(activation.lastVerifiedAt),
    },
  };
}

/**
 * Convert canonical account and group maps back to editable JSON text fields for the UI.
 *
 * @param {Object} [rawConfig={}] - Saved WeCom configuration.
 * @returns {Object} Display-ready configuration.
 */
export function normalizeWecomDisplayConfig(rawConfig: Record<string, unknown> = {}): WecomConfig {
  const normalized = normalizeWecomConfigInput(rawConfig);
  return {
    ...normalized,
    policies: {
      ...normalized.policies,
      groupsJson:
        normalized?.policies?.groups && Object.keys(normalized.policies.groups).length
          ? JSON.stringify(normalized.policies.groups, null, 2)
          : "",
    },
    accountsJson: normalized.accounts.length ? JSON.stringify(normalized.accounts, null, 2) : "",
  };
}

function validateRequiredFields(config: WecomConfig): string[] {
  const errors: string[] = [];
  const mode = config.mode;
  const account = config.defaultAccount || {};

  if (mode === "bot" || mode === "both") {
    if (!stringValue(account?.bot?.botId)) errors.push("Default Bot ID is required.");
    if (!stringValue(account?.bot?.secret)) errors.push("Default Bot Secret is required.");
  }

  if (mode === "agent" || mode === "both") {
    if (!stringValue(account?.agent?.corpId)) errors.push("Default Corp ID is required.");
    if (!stringValue(account?.agent?.corpSecret)) errors.push("Default Corp Secret is required.");
    if (!numberValue(account?.agent?.agentId)) errors.push("Default Agent ID is required.");
    if (!stringValue(account?.agent?.token)) errors.push("Default Agent Token is required.");
    if (!stringValue(account?.agent?.encodingAESKey)) {
      errors.push("Default Encoding AES Key is required.");
    }
  }

  return errors;
}

export const wecomProvider: Provider = {
  id: "wecom",
  authType: "custom",

  async test(ctx: DecryptedIntegration, _deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const normalized = normalizeWecomConfigInput(ctx.config || {});
      const errors = validateRequiredFields(normalized);
      if (errors.length) {
        return {
          success: false,
          error: errors[0],
          message: errors[0],
        };
      }

      return {
        success: true,
        message: "WeCom configuration saved and ready for activation wiring.",
      };
    } catch (error: any) {
      const message = error?.message ?? String(error);
      return { success: false, error: message, message };
    }
  },

  mapToEnv(_ctx: DecryptedIntegration): EnvMapping {
    return {
      primary: null,
      config: {},
    };
  },

  /**
   * Remove account credentials while retaining topology, policies, and activation status for sync.
   *
   * @param {Object} [config={}] - Decrypted WeCom configuration.
   * @returns {Object} Runtime manifest metadata without bot or agent secrets.
   */
  sanitizeForSync(config: Record<string, unknown> = {}) {
    const normalized = normalizeWecomConfigInput(config);
    return {
      mode: normalized.mode,
      defaultAccount: {
        label: normalized?.defaultAccount?.label || "",
        bot: {
          name: normalized?.defaultAccount?.bot?.name || "",
          connectionMode: "websocket",
          sendThinkingMessage: Boolean(normalized?.defaultAccount?.bot?.sendThinkingMessage),
        },
        agent: {
          callbackPath:
            normalized?.defaultAccount?.agent?.callbackPath || DEFAULT_WECOM_AGENT_CALLBACK_PATH,
        },
      },
      accounts: Array.isArray(normalized.accounts)
        ? normalized.accounts.map((account) => ({
            id: account.id || "",
            label: account.label || "",
            hasBot: Boolean(account?.bot?.botId || account?.bot?.secret),
            hasAgent: Boolean(account?.agent?.agentId),
          }))
        : [],
      policies: normalized.policies,
      advanced: {
        dynamicAgentEnabled: Boolean(normalized?.advanced?.dynamicAgentEnabled),
      },
      activation: normalized.activation,
    };
  },
};
