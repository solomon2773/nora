// Redis provider — credentials shape. Password is optional (Redis allows
// no-auth setups for trusted internal networks). Connectivity not
// validated from the control plane.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const redisProvider: Provider = {
  id: "redis",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      if (!config.host) throw new Error("Redis host is required");
      const port = Number(config.port);
      if (!port || port < 1 || port > 65535) throw new Error("Redis port must be 1–65535");
      return {
        success: true,
        message: `Credentials stored — connectivity not verified (${config.host}:${port})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.host) configEnv.host = "REDIS_HOST";
    if (config.port !== undefined) configEnv.port = "REDIS_PORT";
    return { primary: "REDIS_PASSWORD", config: configEnv };
  },
};
