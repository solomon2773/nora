// OpenAI provider — Bearer API key. /v1/models is in the default scope of
// every API key, so it's a safe validation endpoint.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const openaiProvider: Provider = {
  id: "openai",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`OpenAI API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected (${data.data?.length || 0} models available)`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.org_id) configEnv.org_id = "OPENAI_ORG_ID";
    if (config.model) configEnv.model = "OPENAI_MODEL";
    return { primary: "OPENAI_API_KEY", config: configEnv };
  },
};
