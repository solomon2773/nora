// Salesforce provider — Bearer access token against the customer's
// instance URL. The instance URL goes through assertSafeUrl to block SSRF.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const salesforceProvider: Provider = {
  id: "salesforce",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawUrl = config.instance_url;
      if (!rawUrl) throw new Error("Salesforce instance URL not configured");
      const instanceUrl = await deps.assertSafeUrl(String(rawUrl), "Salesforce instance URL");
      const res = await deps.fetch(`${instanceUrl}/services/data/v59.0/`, {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Salesforce API returned ${res.status}`);
      return { success: true, message: "Connected to Salesforce" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.instance_url) configEnv.instance_url = "SALESFORCE_INSTANCE_URL";
    return { primary: "SALESFORCE_ACCESS_TOKEN", config: configEnv };
  },
};
