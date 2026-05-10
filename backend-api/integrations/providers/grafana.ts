// Grafana provider — Bearer service-account token against a customer
// instance URL. URL goes through assertSafeUrl.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const grafanaProvider: Provider = {
  id: "grafana",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawUrl = config.url;
      if (!rawUrl) throw new Error("Grafana URL not configured");
      const url = await deps.assertSafeUrl(String(rawUrl), "Grafana URL");
      const res = await deps.fetch(`${url}/api/org`, {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Grafana API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected to ${data.name || "Grafana"}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.url) configEnv.url = "GRAFANA_URL";
    return { primary: "GRAFANA_TOKEN", config: configEnv };
  },
};
