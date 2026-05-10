// GitLab provider — supports gitlab.com and self-hosted GitLab via an
// optional base URL. Uses a personal access token in the PRIVATE-TOKEN
// header (GitLab's standard for PAT auth on the v4 API).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const gitlabProvider: Provider = {
  id: "gitlab",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawBaseUrl = config.base_url || "https://gitlab.com";
      const baseUrl = await deps.assertSafeUrl(String(rawBaseUrl), "GitLab base URL");
      const res = await deps.fetch(`${baseUrl}/api/v4/user`, {
        headers: { "PRIVATE-TOKEN": ctx.token ?? "" },
      });
      if (!res.ok) throw new Error(`GitLab API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.base_url) configEnv.base_url = "GITLAB_BASE_URL";
    return { primary: "GITLAB_TOKEN", config: configEnv };
  },
};
