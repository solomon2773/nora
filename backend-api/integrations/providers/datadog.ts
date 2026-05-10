// Datadog provider — DD-API-KEY header.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const datadogProvider: Provider = {
  id: "datadog",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.datadoghq.com/api/v1/validate", {
        headers: { "DD-API-KEY": ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`Datadog API returned ${res.status}`);
      return { success: true, message: "API key validated" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.app_key) configEnv.app_key = "DD_APP_KEY";
    if (config.site) configEnv.site = "DD_SITE";
    return { primary: "DD_API_KEY", config: configEnv };
  },
};
