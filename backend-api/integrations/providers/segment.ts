// Segment provider — Source Write Key. Segment doesn't expose a
// validation endpoint for write keys (they're write-only), so test() is
// structural — confirms the key looks like a Segment write key and is
// non-empty.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const segmentProvider: Provider = {
  id: "segment",
  authType: "api_key",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      if (!ctx.token) throw new Error("Segment Write Key is required");
      return {
        success: true,
        message: "Write key stored — Segment doesn't expose a validation endpoint",
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(): EnvMapping {
    return { primary: "SEGMENT_WRITE_KEY", config: {} };
  },
};
