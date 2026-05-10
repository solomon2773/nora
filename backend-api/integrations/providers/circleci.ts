// CircleCI provider — personal API token via the Circle-Token header.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const circleciProvider: Provider = {
  id: "circleci",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://circleci.com/api/v2/me", {
        headers: { "Circle-Token": ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`CircleCI API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.name || data.login || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "CIRCLE_TOKEN", config: {} };
  },
};
