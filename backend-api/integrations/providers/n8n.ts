// n8n provider — webhook URL or API key against the customer's instance.
// We treat it as webhook (since most agent → n8n flows are inbound webhooks).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const n8nProvider: Provider = {
  id: "n8n",
  authType: "webhook",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const url = String(config.webhook_url || "").trim();
      if (!url) throw new Error("n8n webhook URL not configured");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("n8n webhook URL is not a valid URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("n8n webhook URL must use http:// or https://");
      }
      return {
        success: true,
        message: "Webhook URL stored — n8n webhooks have no validation endpoint",
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.webhook_url) configEnv.webhook_url = "N8N_WEBHOOK_URL";
    return { primary: "N8N_API_KEY", config: configEnv };
  },
};
