// Jenkins provider — credentials shape (URL + username + API token).
// Uses HTTP Basic against the customer's Jenkins host, validated through
// assertSafeUrl to block RFC1918 / loopback URLs (the host has to be
// reachable from the Nora deployment, but operators often try localhost).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const jenkinsProvider: Provider = {
  id: "jenkins",
  authType: "credentials",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const rawUrl = config.url;
      const username = config.username;
      if (!rawUrl) throw new Error("Jenkins URL not configured");
      if (!username) throw new Error("Jenkins username not configured");
      const url = await deps.assertSafeUrl(String(rawUrl), "Jenkins URL");
      const credentials = Buffer.from(`${username}:${ctx.token ?? ""}`).toString("base64");
      const res = await deps.fetch(`${url}/api/json`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error(`Jenkins API returned ${res.status}`);
      return { success: true, message: "Connected to Jenkins" };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.url) configEnv.url = "JENKINS_URL";
    if (config.username) configEnv.username = "JENKINS_USERNAME";
    return { primary: "JENKINS_TOKEN", config: configEnv };
  },
};
