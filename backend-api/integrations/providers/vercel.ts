// Vercel provider — Bearer token, optional team scoping via team_id.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const vercelProvider: Provider = {
  id: "vercel",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.vercel.com/v2/user", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Vercel API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.user?.username || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.team_id) configEnv.team_id = "VERCEL_TEAM_ID";
    return { primary: "VERCEL_TOKEN", config: configEnv };
  },
};
