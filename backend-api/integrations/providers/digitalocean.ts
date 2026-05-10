// DigitalOcean provider — Bearer token, GET /v2/account returns the
// account's email + UUID.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const digitaloceanProvider: Provider = {
  id: "digitalocean",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.digitalocean.com/v2/account", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`DigitalOcean API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected (${data.account?.email || "verified"})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "DIGITALOCEAN_TOKEN", config: {} };
  },
};
