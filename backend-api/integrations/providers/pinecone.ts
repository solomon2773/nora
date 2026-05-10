// Pinecone provider — Api-Key header.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const pineconeProvider: Provider = {
  id: "pinecone",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.pinecone.io/indexes", {
        headers: { "Api-Key": ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`Pinecone API returned ${res.status}`);
      return { success: true, message: "Connected to Pinecone" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.environment) configEnv.environment = "PINECONE_ENVIRONMENT";
    if (config.index_name) configEnv.index_name = "PINECONE_INDEX";
    return { primary: "PINECONE_API_KEY", config: configEnv };
  },
};
