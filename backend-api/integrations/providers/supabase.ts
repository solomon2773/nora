// Supabase provider — project URL + anon/service key.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const supabaseProvider: Provider = {
  id: "supabase",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawUrl = config.url;
      if (!rawUrl) throw new Error("Supabase project URL not configured");
      const url = await deps.assertSafeUrl(String(rawUrl), "Supabase URL");
      const res = await deps.fetch(`${url}/rest/v1/`, {
        headers: { apikey: ctx.token ?? "", Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Supabase API returned ${res.status}`);
      return { success: true, message: "Connected to Supabase" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.url) configEnv.url = "SUPABASE_URL";
    return { primary: "SUPABASE_SERVICE_ROLE_KEY", config: configEnv };
  },
};
