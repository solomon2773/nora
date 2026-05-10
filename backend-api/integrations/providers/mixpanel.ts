// Mixpanel provider — Service Account credentials (project-scoped).
// The Project Token field is for client-side ingestion; the Service
// Account secret is the server-side credential used here. The connectivity
// test hits /api/2.0/me which returns the SA's display name.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const mixpanelProvider: Provider = {
  id: "mixpanel",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const username = String(config.service_account_username || "").trim();
      if (!username) {
        // Fall back to project-token-only mode (track API). We can't validate
        // it without sending a real event — store and let the runtime use it.
        if (!ctx.token)
          throw new Error("Mixpanel project token or service account secret is required");
        return {
          success: true,
          message: "Project token stored — Mixpanel doesn't support server-side validation",
        };
      }
      const auth = Buffer.from(`${username}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch("https://mixpanel.com/api/app/me/", {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!res.ok) throw new Error(`Mixpanel API returned ${res.status}`);
      return { success: true, message: "Connected to Mixpanel" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.project_id) configEnv.project_id = "MIXPANEL_PROJECT_ID";
    if (config.service_account_username) {
      configEnv.service_account_username = "MIXPANEL_SERVICE_ACCOUNT_USERNAME";
    }
    return { primary: "MIXPANEL_API_SECRET", config: configEnv };
  },
};
