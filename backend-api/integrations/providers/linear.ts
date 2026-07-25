// Linear provider — GraphQL viewer query against api.linear.app.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const linearProvider: Provider = {
  id: "linear",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: ctx.token ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
      });
      if (!res.ok) throw new Error(`Linear API returned ${res.status}`);
      const data: any = await res.json();
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        throw new Error("Linear API rejected the credentials");
      }
      if (!data?.data?.viewer) {
        throw new Error("Linear API did not return the authenticated viewer");
      }
      return {
        success: true,
        message: `Connected as ${data.data.viewer.name || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.team_id) configEnv.team_id = "LINEAR_TEAM_ID";
    return { primary: "LINEAR_API_KEY", config: configEnv };
  },
};
