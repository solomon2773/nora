// Make.com (formerly Integromat) provider — webhook URL.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const makeProvider: Provider = {
  id: "make",
  authType: "webhook",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const url = String(config.webhook_url || "").trim();
      if (!url) throw new Error("Make.com webhook URL not configured");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Make.com webhook URL is not a valid URL");
      }
      if (parsed.protocol !== "https:") {
        throw new Error("Make.com webhook URL must use https://");
      }
      return {
        success: true,
        message: "Webhook URL stored — Make.com webhooks have no validation endpoint",
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.webhook_url) configEnv.webhook_url = "MAKE_WEBHOOK_URL";
    return { primary: null, config: configEnv };
  },
};
