// Trello provider — API key (in config) + token (the secret). Trello
// expects both as query-string parameters rather than headers.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const trelloProvider: Provider = {
  id: "trello",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const apiKey = String(config.api_key || "").trim();
      if (!apiKey) throw new Error("Trello API key not configured");
      const token = encodeURIComponent(ctx.token ?? "");
      const res = await deps.fetch(
        `https://api.trello.com/1/members/me?key=${encodeURIComponent(apiKey)}&token=${token}`,
      );
      if (!res.ok) throw new Error(`Trello API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.api_key) configEnv.api_key = "TRELLO_API_KEY";
    return { primary: "TRELLO_TOKEN", config: configEnv };
  },
};
