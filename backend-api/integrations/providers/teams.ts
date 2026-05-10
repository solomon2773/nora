// Microsoft Teams (incoming webhooks) provider — webhook authType.
//
// Teams incoming webhooks are write-only and don't expose a verification
// endpoint. We can't safely send a real test message (it would deliver
// to the channel), so test() validates that the URL is well-formed and
// hits the documented webhook host pattern. The agent sends messages
// via POST to TEAMS_WEBHOOK_URL — connectivity is verified there.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const teamsProvider: Provider = {
  id: "teams",
  authType: "webhook",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const url = String(config.webhook_url || "").trim();
      if (!url) throw new Error("Teams webhook URL not configured");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Teams webhook URL is not a valid URL");
      }
      if (parsed.protocol !== "https:") {
        throw new Error("Teams webhook URL must use https://");
      }
      const validHost =
        /\.webhook\.office\.com$/.test(parsed.hostname) ||
        /\.outlook\.office\.com$/.test(parsed.hostname) ||
        /^outlook\.office\.com$/.test(parsed.hostname);
      if (!validHost) {
        throw new Error("Teams webhook URL host doesn't look like a Microsoft webhook endpoint");
      }
      return {
        success: true,
        message: "Webhook URL stored — message delivery not verified from control plane",
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.webhook_url) configEnv.webhook_url = "TEAMS_WEBHOOK_URL";
    return { primary: null, config: configEnv };
  },
};
