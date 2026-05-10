// SendGrid provider — Bearer token, GET /v3/user/profile validates the
// API key. SendGrid keys can be scoped (Mail Send only, Full Access, etc.)
// — /user/profile is in the default scope of every key, so it's a safe
// validation endpoint.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const sendgridProvider: Provider = {
  id: "sendgrid",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.sendgrid.com/v3/user/profile", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`SendGrid API returned ${res.status}`);
      return { success: true, message: "API key validated" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.from_email) configEnv.from_email = "SENDGRID_FROM_EMAIL";
    return { primary: "SENDGRID_API_KEY", config: configEnv };
  },
};
