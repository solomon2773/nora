// Elasticsearch provider — credentials shape, optional username (Basic
// auth) or no auth at all (dev clusters). The connectivity test hits the
// node URL and reads the cluster_name from Elasticsearch's root response.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const elasticsearchProvider: Provider = {
  id: "elasticsearch",
  authType: "credentials",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawUrl = config.node_url;
      if (!rawUrl) throw new Error("Elasticsearch node URL not configured");
      const nodeUrl = await deps.assertSafeUrl(String(rawUrl), "Elasticsearch node URL");
      const headers: Record<string, string> = {};
      if (config.username) {
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${ctx.token ?? ""}`).toString("base64")}`;
      }
      const res = await deps.fetch(nodeUrl, { headers });
      if (!res.ok) throw new Error(`Elasticsearch returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected to cluster "${data.cluster_name || "unknown"}"`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.node_url) configEnv.node_url = "ELASTICSEARCH_URL";
    if (config.username) configEnv.username = "ELASTICSEARCH_USERNAME";
    if (config.index) configEnv.index = "ELASTICSEARCH_INDEX";
    return { primary: "ELASTICSEARCH_PASSWORD", config: configEnv };
  },
};
