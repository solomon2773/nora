// Twitter / X provider — most complex of the migrated providers.
// Implements the optional Provider methods refreshCredentials (OAuth 2.0
// token refresh with PKCE-issued refresh_token) and sanitizeForSync (strip
// app-side OAuth secrets from the runtime payload).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
  RefreshOutcome,
} from "../types/provider";
import type { IntegrationRow } from "../types/integration";

const TWITTER_OAUTH_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const OAUTH_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TWITTER_OAUTH_AUTH_HINT =
  "Use an OAuth 2.0 user access token with tweet.read, users.read, and tweet.write scopes. The app-only Bearer Token and read-only OAuth 1.0 Access Token from Keys and Tokens are not valid for Nora's user-context Twitter/X integration.";

const APP_SECRET_KEYS = new Set(["client_id", "client_secret", "refresh_token"]);

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readErrorBody(res: Response): Promise<{ rawText: string; data: any }> {
  const rawText = await res.text().catch(() => "");
  if (!rawText) return { rawText: "", data: null };
  try {
    return { rawText, data: JSON.parse(rawText) };
  } catch {
    return { rawText, data: null };
  }
}

function providerErrorMessage(data: any, rawText: string): string {
  const firstError = Array.isArray(data?.errors) ? data.errors[0] : null;
  return (
    firstError?.detail ||
    firstError?.message ||
    data?.detail ||
    data?.message ||
    data?.title ||
    rawText ||
    ""
  );
}

function buildTwitterApiError(status: number, data: any, rawText: string): string {
  const detail = providerErrorMessage(data, rawText);
  const hint = status === 401 || status === 403 ? TWITTER_OAUTH_AUTH_HINT : "";
  return ["Twitter/X API returned " + status, detail, hint].filter(Boolean).join(": ");
}

function tokenExpiresAt(tokenData: any = {}): string | null {
  const expiresIn = Number.parseInt(tokenData.expires_in, 10);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function shouldRefreshOAuthToken(config: Record<string, any> = {}): boolean {
  const expiresAt = Date.parse(stringValue(config.expires_at || config.expiresAt));
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + OAUTH_TOKEN_REFRESH_SKEW_MS;
}

export const twitterProvider: Provider = {
  id: "twitter",
  authType: "oauth2",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.x.com/2/users/me", {
        headers: { Authorization: `Bearer ${ctx.token}` },
      });
      const { rawText, data } = await readErrorBody(res as unknown as Response);
      if (!res.ok) throw new Error(buildTwitterApiError(res.status, data, rawText));
      return {
        success: true,
        message: `Connected as @${data?.data?.username || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.api_key) configEnv.api_key = "TWITTER_API_KEY";
    if (config.api_secret) configEnv.api_secret = "TWITTER_API_SECRET";
    if (config.default_username) configEnv.default_username = "TWITTER_DEFAULT_USERNAME";
    return { primary: "TWITTER_ACCESS_TOKEN", config: configEnv };
  },

  /**
   * Remove control-plane OAuth app and refresh secrets before runtime sync.
   *
   * @param {Object} config - Decrypted Twitter/X integration config.
   * @returns {Object} Runtime-safe provider config.
   */
  sanitizeForSync(config: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(config || {}).filter(([key]) => !APP_SECRET_KEYS.has(key)),
    );
  },

  /**
   * Refresh a near-expiry OAuth token, leaving transport exceptions retryable.
   *
   * Any non-2xx response or successful response without an access token returns `failed`.
   *
   * @param {Object} row - Integration row with stored OAuth config.
   * @param {Object} deps - Network, crypto, and persistence dependencies.
   * @returns {Promise<Object>} Refresh outcome; persistence remains the service's responsibility.
   */
  async refreshCredentials(row: IntegrationRow, deps: ProviderDeps): Promise<RefreshOutcome> {
    if (!row?.id) return { row, refreshed: false };

    // The caller will already have decrypted secrets via the
    // catalog-driven crypto module, but refresh runs in contexts where
    // the row's `config` is still encrypted, so we decrypt fresh here.
    const config: Record<string, any> = (() => {
      if (typeof row.config === "string") {
        try {
          return JSON.parse(row.config);
        } catch {
          return {};
        }
      }
      return (row.config as Record<string, any>) || {};
    })();

    // Decrypt fields the legacy crypto module would have decrypted.
    for (const key of Object.keys(config)) {
      if (typeof config[key] === "string" && /^enc\(|^[A-Za-z0-9+/=]{20,}$/.test(config[key])) {
        try {
          config[key] = deps.decrypt(config[key]);
        } catch {
          // Field wasn't encrypted; leave as-is.
        }
      }
    }

    if (!shouldRefreshOAuthToken(config)) return { row, refreshed: false };

    const refreshToken = stringValue(config.refresh_token);
    const clientId = stringValue(config.client_id);
    if (!refreshToken || !clientId) return { row, refreshed: false };

    const clientSecret = stringValue(config.client_secret);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    }

    let tokenData: any = null;
    let rejection: string | null = null;
    try {
      const response = await deps.fetch(TWITTER_OAUTH_TOKEN_URL, {
        method: "POST",
        headers,
        body,
      });
      tokenData = await (response as any).json().catch(() => ({}));
      if (!response.ok) {
        // The endpoint answered and said no — revoked/expired grant, not a blip.
        rejection =
          stringValue(tokenData?.error_description) ||
          stringValue(tokenData?.error) ||
          `HTTP ${response.status}`;
      }
    } catch (error: any) {
      // Transient (network/DNS) — retry on the next sync without alarming the operator.
      console.warn(
        `[integrations] Failed to refresh Twitter/X OAuth token for integration ${row.id}: ${error?.message ?? error}`,
      );
      return { row, refreshed: false };
    }

    if (rejection) {
      console.warn(
        `[integrations] Twitter/X rejected OAuth token refresh for integration ${row.id}: ${rejection}`,
      );
      return { row, refreshed: false, failed: true, error: rejection };
    }

    const accessToken = stringValue(tokenData.access_token);
    if (!accessToken) {
      return { row, refreshed: false, failed: true, error: "Token response had no access_token" };
    }

    deps.ensureEncryptionConfigured("Twitter/X OAuth token refresh");
    const nextConfig = {
      ...config,
      access_token: accessToken,
      refresh_token: stringValue(tokenData.refresh_token) || refreshToken,
      token_type: stringValue(tokenData.token_type) || config.token_type || "bearer",
      scope: stringValue(tokenData.scope) || config.scope || "",
      expires_at: tokenExpiresAt(tokenData) || config.expires_at || null,
    };

    return {
      row: {
        ...row,
        access_token: accessToken,
        config: nextConfig,
      },
      refreshed: true,
    };
  },
};
