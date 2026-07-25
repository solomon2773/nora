// LinkedIn provider — OAuth 2.0 with refresh-token rotation. Mirrors
// the structure of providers/twitter.ts. Connectivity tests hit the
// OIDC userinfo endpoint; the refresh flow exchanges the stored
// refresh_token at the LinkedIn token endpoint when the access token
// is within the skew window of expiry.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
  RefreshOutcome,
} from "../types/provider";
import type { IntegrationRow } from "../types/integration";

const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const OAUTH_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

const APP_SECRET_KEYS = new Set(["client_id", "client_secret", "refresh_token"]);

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

export const linkedinProvider: Provider = {
  id: "linkedin",
  authType: "oauth2",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch(LINKEDIN_USERINFO_URL, {
        headers: { Authorization: `Bearer ${ctx.token}` },
      });
      if (!res.ok) throw new Error(`LinkedIn API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.name || data.given_name || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(_ctx: DecryptedIntegration): EnvMapping {
    return { primary: "LINKEDIN_ACCESS_TOKEN", config: {} };
  },

  /**
   * Remove control-plane OAuth app and refresh secrets before runtime sync.
   *
   * @param {Object} config - Decrypted LinkedIn integration config.
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

    // Best-effort decrypt for fields the catalog crypto module would have decrypted.
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
    const clientSecret = stringValue(config.client_secret);
    if (!refreshToken || !clientId || !clientSecret) return { row, refreshed: false };

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    let tokenData: any = null;
    let rejection: string | null = null;
    try {
      const response = await deps.fetch(LINKEDIN_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
        `[integrations] Failed to refresh LinkedIn OAuth token for integration ${row.id}: ${error?.message ?? error}`,
      );
      return { row, refreshed: false };
    }

    if (rejection) {
      console.warn(
        `[integrations] LinkedIn rejected OAuth token refresh for integration ${row.id}: ${rejection}`,
      );
      return { row, refreshed: false, failed: true, error: rejection };
    }

    const accessToken = stringValue(tokenData.access_token);
    if (!accessToken) {
      return { row, refreshed: false, failed: true, error: "Token response had no access_token" };
    }

    deps.ensureEncryptionConfigured("LinkedIn OAuth token refresh");
    const nextConfig = {
      ...config,
      access_token: accessToken,
      refresh_token: stringValue(tokenData.refresh_token) || refreshToken,
      token_type: stringValue(tokenData.token_type) || config.token_type || "Bearer",
      scope: stringValue(tokenData.scope) || config.scope || "",
      expires_at: tokenExpiresAt(tokenData) || config.expires_at || null,
    };

    return {
      row: { ...row, access_token: accessToken, config: nextConfig },
      refreshed: true,
    };
  },
};
