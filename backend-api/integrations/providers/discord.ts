// Discord provider — bot tokens via the standard `Authorization: Bot <token>`
// header. The connectivity test hits /users/@me which Discord supports for
// bot tokens (returns the bot user, not the server's owner).

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

export const discordProvider: Provider = {
  id: "discord",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const res = await deps.fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${ctx.token ?? ""}` },
      });
      if (!res.ok) throw new Error(`Discord API returned ${res.status}`);
      const data: any = await res.json();
      return { success: true, message: `Connected as ${data.username}` };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.guild_id) configEnv.guild_id = "DISCORD_GUILD_ID";
    return { primary: "DISCORD_TOKEN", config: configEnv };
  },
};
