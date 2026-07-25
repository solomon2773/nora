// Jira provider — Basic auth (email + API token) against the customer's
// site URL. Validates the site URL is not internal/RFC1918 first.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const jiraProvider: Provider = {
  id: "jira",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const domain = config.site_url || config.domain || config.base_url;
      if (!domain) throw new Error("Jira site URL not configured");
      const rawUrl = String(domain).includes("://") ? String(domain) : `https://${domain}`;
      const url = await deps.assertSafeUrl(rawUrl, "Jira site URL");
      const email = config.email;
      if (!email) throw new Error("Jira email not configured");

      const credentials = Buffer.from(`${email}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch(`${url}/rest/api/3/myself`, {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Jira API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.displayName}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.email) configEnv.email = "JIRA_EMAIL";
    if (config.site_url) configEnv.site_url = "JIRA_BASE_URL";
    if (config.project_key) configEnv.project_key = "JIRA_PROJECT_KEY";
    return { primary: "JIRA_API_TOKEN", config: configEnv };
  },
};
