// Dropbox provider — Bearer access token. POSTs the documented
// /users/get_current_account endpoint to verify the token.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const dropboxProvider: Provider = {
  id: "dropbox",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Dropbox API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.name?.display_name || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "DROPBOX_ACCESS_TOKEN", config: {} };
  },
};
