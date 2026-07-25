// Slack provider — Bearer token connectivity check via auth.test.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const slackProvider: Provider = {
  id: "slack",
  authType: "oauth2",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Slack API returned ${res.status}`);
      const data: any = await res.json();
      if (!data.ok) throw new Error(`Slack: ${data.error || "authentication failed"}`);
      return { success: true, message: `Connected to ${data.team}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.default_channel) configEnv.default_channel = "SLACK_DEFAULT_CHANNEL";
    return { primary: "SLACK_TOKEN", config: configEnv };
  },
};
