// Firebase provider — service-account JSON. test() validates the JSON
// parses and contains the keys Google's auth libraries expect
// (client_email + private_key + project_id), without making any
// network call.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

const REQUIRED_SA_KEYS = ["client_email", "private_key", "project_id"] as const;

export const firebaseProvider: Provider = {
  id: "firebase",
  authType: "service_account",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const raw = String(config.service_account_json || "").trim();
      if (!raw) throw new Error("Firebase service account JSON is required");
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Firebase service account JSON is not valid JSON");
      }
      const missing = REQUIRED_SA_KEYS.filter((k) => !parsed[k]);
      if (missing.length > 0) {
        throw new Error(`Service account JSON is missing required keys: ${missing.join(", ")}`);
      }
      return {
        success: true,
        message: `Service account stored for project ${parsed.project_id}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.service_account_json) {
      configEnv.service_account_json = "GOOGLE_APPLICATION_CREDENTIALS_JSON";
    }
    if (config.project_id) configEnv.project_id = "FIREBASE_PROJECT_ID";
    return { primary: null, config: configEnv };
  },
};
