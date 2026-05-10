// Facebook provider — Graph API access token (long-lived user or page
// token). Token passed as query string param.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const facebookProvider: Provider = {
  id: "facebook",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const token = encodeURIComponent(ctx.token ?? "");
      const res = await deps.fetch(`https://graph.facebook.com/v18.0/me?access_token=${token}`);
      if (!res.ok) throw new Error(`Facebook API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.name || "verified"}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.page_id) configEnv.page_id = "FACEBOOK_PAGE_ID";
    return { primary: "FACEBOOK_ACCESS_TOKEN", config: configEnv };
  },
};
