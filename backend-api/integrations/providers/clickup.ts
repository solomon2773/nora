// ClickUp provider — Personal API token in raw Authorization header.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const clickupProvider: Provider = {
  id: "clickup",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.clickup.com/api/v2/user", {
        headers: { Authorization: ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`ClickUp API returned ${res.status}`);
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
    if (config.team_id) configEnv.team_id = "CLICKUP_TEAM_ID";
    return { primary: "CLICKUP_API_KEY", config: configEnv };
  },
};
