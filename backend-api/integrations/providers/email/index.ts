import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../../types/provider";

import { EMAIL_PROVIDER_PRESETS, type EmailProviderPresetId } from "./presets";
import { testEmailConnection } from "./testConnection";

type EmailConfig = Record<string, any>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function mailEndpointUrl(host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `https://${normalizedHost}:${port}`;
}

function setNested(target: Record<string, any>, path: string, value: unknown) {
  const parts = path.split(".");
  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift() as string;
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[0]] = value;
}

/**
 * Expand dotted input, apply provider defaults, and canonicalize current Email config sections.
 *
 * Legacy polling, initial-sync, and mailbox-scope fields are intentionally removed.
 *
 * @param {Object} [rawConfig={}] - Partial nested or dotted Email configuration.
 * @returns {Object} Canonical IMAP, SMTP, cron, auth, and verification config.
 */
export function normalizeEmailConfigInput(rawConfig: Record<string, unknown> = {}): EmailConfig {
  const next: Record<string, any> = {};

  for (const [key, value] of Object.entries(rawConfig || {})) {
    if (value === undefined) continue;
    if (key.includes(".")) {
      setNested(next, key, value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = normalizeEmailConfigInput(value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }

  const providerPreset = (stringValue(next.providerPreset || "gmail") ||
    "gmail") as EmailProviderPresetId;
  const preset = EMAIL_PROVIDER_PRESETS[providerPreset] || EMAIL_PROVIDER_PRESETS.gmail;

  next.providerPreset = providerPreset;
  next.auth = {
    mode: "basic",
    username: stringValue(next?.auth?.username || next?.smtp?.user),
    password: stringValue(next?.auth?.password),
  };
  next.imap = {
    host: stringValue(next?.imap?.host) || preset.imap.host,
    port: numberValue(next?.imap?.port, preset.imap.port),
    secure: boolValue(next?.imap?.secure, preset.imap.secure),
  };
  next.smtp = {
    host: stringValue(next?.smtp?.host) || preset.smtp.host,
    port: numberValue(next?.smtp?.port, preset.smtp.port),
    secure: boolValue(next?.smtp?.secure, preset.smtp.secure),
    fromAddress: stringValue(next?.smtp?.fromAddress || next?.from_address),
    fromName: stringValue(next?.smtp?.fromName),
  };
  next.cron = {
    enabled: boolValue(next?.cron?.enabled, false),
    intervalMinutes: numberValue(next?.cron?.intervalMinutes, 60),
    prompt:
      stringValue(next?.cron?.prompt) ||
      "Look for any new emails or calendar invites I should be aware of and summarize anything important for me.",
  };
  next.verification = {
    lastTestAt: stringValue(next?.verification?.lastTestAt),
    lastSuccess:
      typeof next?.verification?.lastSuccess === "boolean" ? next.verification.lastSuccess : null,
    lastError: stringValue(next?.verification?.lastError),
  };
  delete next.polling;
  delete next.initialSync;
  delete next.mailboxScope;

  return next;
}

export function extractEmailPrimarySecret(config: EmailConfig): string {
  return stringValue(config?.auth?.password);
}

export const emailProvider: Provider = {
  id: "email",
  authType: "custom",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    const normalized = normalizeEmailConfigInput(ctx.config || {});
    if (ctx.token) normalized.auth.password = ctx.token;
    await deps.assertSafeUrl(
      mailEndpointUrl(normalized.imap.host, normalized.imap.port),
      "Email IMAP endpoint",
    );
    await deps.assertSafeUrl(
      mailEndpointUrl(normalized.smtp.host, normalized.smtp.port),
      "Email SMTP endpoint",
    );
    return testEmailConnection(normalized);
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = normalizeEmailConfigInput((ctx.config || {}) as Record<string, any>);
    const auth = config.auth || {};

    return {
      primary: "EMAIL_PASSWORD",
      config: {
        providerPreset: "EMAIL_PROVIDER_PRESET",
        auth_username: "EMAIL_USERNAME",
        imap_host: "EMAIL_IMAP_HOST",
        imap_port: "EMAIL_IMAP_PORT",
        imap_secure: "EMAIL_IMAP_SECURE",
        smtp_host: "EMAIL_SMTP_HOST",
        smtp_port: "EMAIL_SMTP_PORT",
        smtp_secure: "EMAIL_SMTP_SECURE",
        smtp_fromAddress: "EMAIL_FROM_ADDRESS",
        smtp_fromName: "EMAIL_FROM_NAME",
      },
    };
  },

  sanitizeForSync(config: Record<string, unknown> = {}) {
    return normalizeEmailConfigInput(config);
  },
};

export { EMAIL_PROVIDER_PRESETS, testEmailConnection };
