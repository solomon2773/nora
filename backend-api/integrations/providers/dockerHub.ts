// Docker Hub provider — username + access token. Tested by hitting the
// /v2/users/login endpoint, which Docker Hub provides specifically for
// validating credentials without registering them as a session.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const dockerHubProvider: Provider = {
  id: "docker-hub",
  authType: "credentials",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const username = config.username;
      if (!username) throw new Error("Docker Hub username not configured");
      const res = await deps.fetch("https://hub.docker.com/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: ctx.token ?? "" }),
      });
      if (!res.ok) throw new Error(`Docker Hub API returned ${res.status}`);
      return { success: true, message: `Connected as ${username}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.username) configEnv.username = "DOCKER_HUB_USERNAME";
    return { primary: "DOCKER_HUB_TOKEN", config: configEnv };
  },
};
