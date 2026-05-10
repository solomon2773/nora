// Anthropic provider — x-api-key header + anthropic-version pinning.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const anthropicProvider: Provider = {
  id: "anthropic",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": ctx.token ?? "", "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);
      return { success: true, message: "API key validated" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.model) configEnv.model = "ANTHROPIC_MODEL";
    return { primary: "ANTHROPIC_API_KEY", config: configEnv };
  },
};
