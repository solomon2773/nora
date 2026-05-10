// PagerDuty provider — Token token=<api_key> Authorization header.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const pagerdutyProvider: Provider = {
  id: "pagerduty",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.pagerduty.com/users/me", {
        headers: {
          Authorization: `Token token=${ctx.token ?? ""}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`PagerDuty API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.user?.name || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.routing_key) configEnv.routing_key = "PAGERDUTY_ROUTING_KEY";
    return { primary: "PAGERDUTY_TOKEN", config: configEnv };
  },
};
