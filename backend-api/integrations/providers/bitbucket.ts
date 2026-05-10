// Bitbucket Cloud provider — username + app password authenticated via
// HTTP Basic. App passwords are scoped per-permission and can be created
// from the user's account settings (the catalog credentialsUrl points
// operators directly at the page).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const bitbucketProvider: Provider = {
  id: "bitbucket",
  authType: "basic",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const username = config.username;
      if (!username) throw new Error("Bitbucket username not configured");
      const credentials = Buffer.from(`${username}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch("https://api.bitbucket.org/2.0/user", {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error(`Bitbucket API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.username || data.display_name}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.username) configEnv.username = "BITBUCKET_USERNAME";
    if (config.workspace) configEnv.workspace = "BITBUCKET_WORKSPACE";
    return { primary: "BITBUCKET_APP_PASSWORD", config: configEnv };
  },
};
