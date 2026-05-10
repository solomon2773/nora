// Google Drive provider — service-account JSON. Same validation shape as
// Firebase — the agent runtime drops the JSON onto disk and points
// GOOGLE_APPLICATION_CREDENTIALS at it.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

const REQUIRED_SA_KEYS = ["client_email", "private_key", "project_id"] as const;

export const googleDriveProvider: Provider = {
  id: "google-drive",
  authType: "service_account",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const raw = String(config.service_account_json || "").trim();
      if (!raw) throw new Error("Google Drive service account JSON is required");
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Service account JSON is not valid JSON");
      }
      const missing = REQUIRED_SA_KEYS.filter((k) => !parsed[k]);
      if (missing.length > 0) {
        throw new Error(`Service account JSON is missing required keys: ${missing.join(", ")}`);
      }
      return {
        success: true,
        message: `Service account stored (${parsed.client_email})`,
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
    if (config.shared_drive_id) configEnv.shared_drive_id = "GOOGLE_DRIVE_SHARED_DRIVE_ID";
    return { primary: null, config: configEnv };
  },
};
