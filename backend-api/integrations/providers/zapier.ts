// Zapier provider — webhook integration. Stored-only: Nora can't safely
// hit a one-way webhook URL from the control plane.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const zapierProvider: Provider = {
  id: "zapier",
  authType: "webhook",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const url = String(config.webhook_url || "").trim();
      if (!url) throw new Error("Zapier webhook URL not configured");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Zapier webhook URL is not a valid URL");
      }
      if (parsed.protocol !== "https:") {
        throw new Error("Zapier webhook URL must use https://");
      }
      return {
        success: true,
        message: "Webhook URL stored — Zapier webhooks have no validation endpoint",
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.webhook_url) configEnv.webhook_url = "ZAPIER_WEBHOOK_URL";
    return { primary: null, config: configEnv };
  },
};
