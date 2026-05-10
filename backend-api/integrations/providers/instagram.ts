// Instagram (Graph API) provider — uses the same Facebook Graph access
// token. Optionally hits a specific business_account_id when provided.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const instagramProvider: Provider = {
  id: "instagram",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const accountId = String(config.business_account_id || "").trim();
      const token = encodeURIComponent(ctx.token ?? "");
      const path = accountId
        ? `${encodeURIComponent(accountId)}?fields=id,username&access_token=${token}`
        : `me?fields=id,name&access_token=${token}`;
      const res = await deps.fetch(`https://graph.facebook.com/v18.0/${path}`);
      if (!res.ok) throw new Error(`Instagram Graph API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.username || data.name || data.id || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.business_account_id) {
      configEnv.business_account_id = "INSTAGRAM_BUSINESS_ACCOUNT_ID";
    }
    if (config.page_id) configEnv.page_id = "INSTAGRAM_PAGE_ID";
    return { primary: "INSTAGRAM_ACCESS_TOKEN", config: configEnv };
  },
};
