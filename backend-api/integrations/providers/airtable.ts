// Airtable provider — Personal Access Token (PAT), Bearer auth.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const airtableProvider: Provider = {
  id: "airtable",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.airtable.com/v0/meta/whoami", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Airtable API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.email || data.id}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.base_id) configEnv.base_id = "AIRTABLE_BASE_ID";
    return { primary: "AIRTABLE_API_KEY", config: configEnv };
  },
};
