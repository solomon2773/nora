// Monday.com provider — GraphQL with raw token in Authorization header
// (no Bearer prefix, per Monday's docs).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const mondayProvider: Provider = {
  id: "monday",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { Authorization: ctx.token ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ me { name } }" }),
      });
      if (!res.ok) throw new Error(`Monday.com API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.data?.me?.name || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "MONDAY_API_KEY", config: {} };
  },
};
