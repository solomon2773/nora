// Sentry provider — Bearer auth token. /api/0/ is Sentry's root and a
// safe smoke test for any auth token (returns the API surface index).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const sentryProvider: Provider = {
  id: "sentry",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://sentry.io/api/0/", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Sentry API returned ${res.status}`);
      return { success: true, message: "Authenticated successfully" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.organization) configEnv.organization = "SENTRY_ORG";
    if (config.project) configEnv.project = "SENTRY_PROJECT";
    return { primary: "SENTRY_AUTH_TOKEN", config: configEnv };
  },
};
