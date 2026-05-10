// Stripe provider — Bearer secret key. /v1/balance is in every key's
// default scope.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const stripeProvider: Provider = {
  id: "stripe",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Stripe API returned ${res.status}`);
      return { success: true, message: "Balance verified" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.webhook_secret) configEnv.webhook_secret = "STRIPE_WEBHOOK_SECRET";
    return { primary: "STRIPE_SECRET_KEY", config: configEnv };
  },
};
