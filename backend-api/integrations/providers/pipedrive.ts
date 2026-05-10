// Pipedrive provider — API token passed as query-string param.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const pipedriveProvider: Provider = {
  id: "pipedrive",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const token = encodeURIComponent(ctx.token ?? "");
      const res = await deps.fetch(`https://api.pipedrive.com/v1/users/me?api_token=${token}`);
      if (!res.ok) throw new Error(`Pipedrive API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.data?.name || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.company_domain) configEnv.company_domain = "PIPEDRIVE_COMPANY_DOMAIN";
    return { primary: "PIPEDRIVE_API_KEY", config: configEnv };
  },
};
