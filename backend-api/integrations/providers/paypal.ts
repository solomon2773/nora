// PayPal provider — client credentials grant. The connectivity test
// hits /v1/oauth2/token (the documented credential-validation endpoint)
// to swap the client_id + client_secret for an access token.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

const PRODUCTION_HOST = "https://api-m.paypal.com";
const SANDBOX_HOST = "https://api-m.sandbox.paypal.com";

export const paypalProvider: Provider = {
  id: "paypal",
  authType: "credentials",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const clientId = String(config.client_id || "").trim();
      if (!clientId) throw new Error("PayPal Client ID not configured");
      if (!ctx.token) throw new Error("PayPal Client Secret is required");
      const sandbox = config.sandbox === true || config.sandbox === "true";
      const base = sandbox ? SANDBOX_HOST : PRODUCTION_HOST;
      const auth = Buffer.from(`${clientId}:${ctx.token}`).toString("base64");
      const res = await deps.fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
      if (!res.ok) throw new Error(`PayPal API returned ${res.status}`);
      return {
        success: true,
        message: `Connected to PayPal (${sandbox ? "sandbox" : "production"})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.client_id) configEnv.client_id = "PAYPAL_CLIENT_ID";
    if (config.sandbox !== undefined) configEnv.sandbox = "PAYPAL_SANDBOX";
    return { primary: "PAYPAL_CLIENT_SECRET", config: configEnv };
  },
};
