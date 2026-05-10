// PostgreSQL provider — credentials shape (host/port/database/user/password).
// Connectivity isn't validated from the control plane (databases are
// usually behind a private network). The agent runtime opens the
// connection using the standard PG* env vars.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const postgresqlProvider: Provider = {
  id: "postgresql",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      if (!config.host) throw new Error("PostgreSQL host is required");
      const port = Number(config.port);
      if (!port || port < 1 || port > 65535) throw new Error("PostgreSQL port must be 1–65535");
      if (!config.database) throw new Error("PostgreSQL database is required");
      if (!config.user) throw new Error("PostgreSQL user is required");
      if (!ctx.token) throw new Error("PostgreSQL password is required");
      return {
        success: true,
        message: `Credentials stored — connectivity not verified (${config.host}:${port}/${config.database})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.host) configEnv.host = "PGHOST";
    if (config.port !== undefined) configEnv.port = "PGPORT";
    if (config.database) configEnv.database = "PGDATABASE";
    if (config.user) configEnv.user = "PGUSER";
    return { primary: "PGPASSWORD", config: configEnv };
  },
};
