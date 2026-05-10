// Azure provider — Service Principal credentials (tenant + client + secret).
// Agents using @azure/identity automatically pick up the environment
// variables. Connectivity not validated from the control plane (token
// acquisition is non-trivial without the SDK).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const azureProvider: Provider = {
  id: "azure",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const tenantId = String(config.tenant_id || "").trim();
      const clientId = String(config.client_id || "").trim();
      if (!tenantId) throw new Error("Azure tenant ID is required");
      if (!clientId) throw new Error("Azure client ID is required");
      if (!ctx.token) throw new Error("Azure client secret is required");
      if (!UUID_RE.test(tenantId)) throw new Error("Azure tenant ID is not a valid UUID");
      if (!UUID_RE.test(clientId)) throw new Error("Azure client ID is not a valid UUID");
      return {
        success: true,
        message: `Service principal stored for tenant ${tenantId}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.tenant_id) configEnv.tenant_id = "AZURE_TENANT_ID";
    if (config.client_id) configEnv.client_id = "AZURE_CLIENT_ID";
    return { primary: "AZURE_CLIENT_SECRET", config: configEnv };
  },
};
