// Zendesk provider — subdomain + email + API token. Uses the special
// Zendesk Basic-auth shape `<email>/token:<api_token>`.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const zendeskProvider: Provider = {
  id: "zendesk",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const subdomain = String(config.subdomain || "").trim();
      const email = String(config.email || "").trim();
      if (!subdomain) throw new Error("Zendesk subdomain not configured");
      if (!email) throw new Error("Zendesk email not configured");
      const credentials = Buffer.from(`${email}/token:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error(`Zendesk API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.user?.name || data.user?.email || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.subdomain) configEnv.subdomain = "ZENDESK_SUBDOMAIN";
    if (config.email) configEnv.email = "ZENDESK_EMAIL";
    return { primary: "ZENDESK_API_TOKEN", config: configEnv };
  },
};
