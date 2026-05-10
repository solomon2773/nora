// Twilio provider — Account SID + Auth Token, HTTP Basic auth.
// The connectivity test reads the account record by SID, which Twilio
// considers a free admin call and returns 401 if the credentials are wrong.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const twilioProvider: Provider = {
  id: "twilio",
  authType: "credentials",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const sid = String(config.account_sid || "").trim();
      if (!sid) throw new Error("Twilio Account SID not configured");
      const credentials = Buffer.from(`${sid}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error(`Twilio API returned ${res.status}`);
      return { success: true, message: "Connected to Twilio" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.account_sid) configEnv.account_sid = "TWILIO_ACCOUNT_SID";
    if (config.phone_number) configEnv.phone_number = "TWILIO_PHONE_NUMBER";
    return { primary: "TWILIO_AUTH_TOKEN", config: configEnv };
  },
};
