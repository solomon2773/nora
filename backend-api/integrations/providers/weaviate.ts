// Weaviate provider — cluster URL + optional API key (anonymous read is
// possible on some clusters). The connectivity test hits the cluster's
// /.well-known/openid-configuration which is exposed by Weaviate Cloud
// and self-hosted clusters alike.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const weaviateProvider: Provider = {
  id: "weaviate",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawUrl = config.host;
      if (!rawUrl) throw new Error("Weaviate cluster URL not configured");
      const baseUrl = await deps.assertSafeUrl(String(rawUrl), "Weaviate URL");
      const headers: Record<string, string> = {};
      if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
      const res = await deps.fetch(`${baseUrl}/v1/meta`, { headers });
      if (!res.ok) throw new Error(`Weaviate API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected to Weaviate ${data.version || ""}`.trim(),
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.host) configEnv.host = "WEAVIATE_URL";
    return { primary: "WEAVIATE_API_KEY", config: configEnv };
  },
};
