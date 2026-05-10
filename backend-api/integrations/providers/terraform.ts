// Terraform Cloud / Enterprise provider — Bearer token against the
// account details endpoint. Uses the JSON:API content type Terraform
// requires for v2 API calls.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const terraformProvider: Provider = {
  id: "terraform",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://app.terraform.io/api/v2/account/details", {
        headers: {
          Authorization: `Bearer ${ctx.token ?? ""}`,
          "Content-Type": "application/vnd.api+json",
        },
      });
      if (!res.ok) throw new Error(`Terraform Cloud API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.data?.attributes?.username || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.organization) configEnv.organization = "TFE_ORGANIZATION";
    return { primary: "TFE_TOKEN", config: configEnv };
  },
};
