// MongoDB provider — connection string. The legacy schema uses
// `connection_string` as a single password field, so the URI itself is
// the credential. test() validates the URI parses and uses an mongodb://
// or mongodb+srv:// scheme.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const mongodbProvider: Provider = {
  id: "mongodb",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const uri = String(ctx.token || "").trim();
      if (!uri) throw new Error("MongoDB connection string is required");
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new Error("MongoDB connection string is not a valid URI");
      }
      if (!/^mongodb(\+srv)?:$/.test(parsed.protocol)) {
        throw new Error("MongoDB URI must use mongodb:// or mongodb+srv:// scheme");
      }
      return {
        success: true,
        message: `Connection string stored — connectivity not verified (${parsed.hostname})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "MONGODB_URI", config: {} };
  },
};
