// Shopify provider — Admin API access token via X-Shopify-Access-Token
// against the shop's myshopify.com host.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const shopifyProvider: Provider = {
  id: "shopify",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const shop = String(config.shop_domain || "").trim();
      if (!shop) throw new Error("Shopify shop domain not configured");
      const domain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
      const res = await deps.fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
        headers: { "X-Shopify-Access-Token": ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`Shopify API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected to ${data.shop?.name || shop}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.shop_domain) configEnv.shop_domain = "SHOPIFY_SHOP_DOMAIN";
    return { primary: "SHOPIFY_ACCESS_TOKEN", config: configEnv };
  },
};
