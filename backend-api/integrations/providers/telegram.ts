// Telegram bot provider — tokens follow the format <bot_id>:<secret>.
// The connectivity test calls getMe via the Bot API and reads the bot's
// username. The token format check guards against operators pasting their
// own user API key by mistake.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

export const telegramProvider: Provider = {
  id: "telegram",
  authType: "api_key",

  async test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult> {
    try {
      const botToken = String(ctx.token || "").trim();
      if (!TELEGRAM_TOKEN_RE.test(botToken)) {
        throw new Error("Invalid Telegram bot token format");
      }
      const res = await deps.fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
      const data: any = await res.json();
      if (!data.ok) throw new Error(`Telegram: ${data.description || "validation failed"}`);
      return {
        success: true,
        message: `Connected as @${data.result?.username || "bot"}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.operator_user_id) configEnv.operator_user_id = "OPERATOR_TELEGRAM_ID";
    return { primary: "TELEGRAM_BOT_TOKEN", config: configEnv };
  },
};
