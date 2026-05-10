// HubSpot provider — Private App access token (Bearer).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const hubspotProvider: Provider = {
  id: "hubspot",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`HubSpot API returned ${res.status}`);
      return { success: true, message: "Connected to HubSpot" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "HUBSPOT_ACCESS_TOKEN", config: {} };
  },
};
