// Algolia provider — Application ID + Admin API key. The /1/keys endpoint
// returns the list of API keys in the application; calling it confirms
// both the app ID and the admin key are valid.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const algoliaProvider: Provider = {
  id: "algolia",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const appId = String(config.app_id || "").trim();
      if (!appId) throw new Error("Algolia Application ID not configured");
      const res = await deps.fetch(`https://${appId}-dsn.algolia.net/1/keys`, {
        headers: { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`Algolia API returned ${res.status}`);
      return { success: true, message: "Connected to Algolia" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.app_id) configEnv.app_id = "ALGOLIA_APP_ID";
    if (config.index_name) configEnv.index_name = "ALGOLIA_INDEX";
    return { primary: "ALGOLIA_API_KEY", config: configEnv };
  },
};
