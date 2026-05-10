// Confluence Cloud provider — Basic auth (email + API token) against the
// customer's site. Validates the site URL to block SSRF.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const confluenceProvider: Provider = {
  id: "confluence",
  authType: "basic",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const baseUrl = config.base_url;
      const email = config.email;
      if (!baseUrl) throw new Error("Confluence URL not configured");
      if (!email) throw new Error("Confluence email not configured");
      const rawUrl = String(baseUrl).includes("://") ? String(baseUrl) : `https://${baseUrl}`;
      const url = await deps.assertSafeUrl(rawUrl, "Confluence base URL");
      const credentials = Buffer.from(`${email}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch(`${url}/wiki/rest/api/user/current`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error(`Confluence API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.displayName || data.email}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.email) configEnv.email = "CONFLUENCE_EMAIL";
    if (config.base_url) configEnv.base_url = "CONFLUENCE_BASE_URL";
    return { primary: "CONFLUENCE_TOKEN", config: configEnv };
  },
};
