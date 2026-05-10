// Hugging Face provider — Bearer token, GET /api/whoami-v2 returns the
// authenticated user's profile (covers tokens generated via the
// Settings → Access Tokens UI).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const huggingfaceProvider: Provider = {
  id: "huggingface",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Hugging Face API returned ${res.status}`);
      const data: any = await res.json();
      return {
        success: true,
        message: `Connected as ${data.name || data.fullname || "verified"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "HF_TOKEN", config: {} };
  },
};
