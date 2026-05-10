// WooCommerce provider — Consumer Key + Consumer Secret as HTTP Basic
// against the customer's WordPress site.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const woocommerceProvider: Provider = {
  id: "woocommerce",
  authType: "credentials",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const siteUrl = config.site_url;
      const consumerKey = config.consumer_key;
      if (!siteUrl) throw new Error("WooCommerce site URL not configured");
      if (!consumerKey) throw new Error("WooCommerce consumer key not configured");
      const url = await deps.assertSafeUrl(String(siteUrl), "WooCommerce site URL");
      const credentials = Buffer.from(`${consumerKey}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch(`${url}/wp-json/wc/v3/system_status`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error(`WooCommerce API returned ${res.status}`);
      return { success: true, message: "Connected to WooCommerce" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.site_url) configEnv.site_url = "WOOCOMMERCE_STORE_URL";
    if (config.consumer_key) configEnv.consumer_key = "WOOCOMMERCE_CONSUMER_KEY";
    return { primary: "WOOCOMMERCE_CONSUMER_SECRET", config: configEnv };
  },
};
