// Notion provider — internal-integration token (Bearer) + version header.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const notionProvider: Provider = {
  id: "notion",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${ctx.token ?? ""}`,
          "Notion-Version": "2022-06-28",
        },
      });
      if (!res.ok) throw new Error(`Notion API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.name || data.id}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "NOTION_TOKEN", config: {} };
  },
};
