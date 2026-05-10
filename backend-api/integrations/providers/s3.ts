// Amazon S3 provider — credentials shape (access key + secret + region +
// bucket). Connectivity not validated from the control plane; the agent
// uses the AWS SDK with the standard env vars at runtime.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

export const s3Provider: Provider = {
  id: "s3",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      if (!config.access_key_id) throw new Error("S3 access key ID is required");
      if (!ctx.token) throw new Error("S3 secret access key is required");
      return {
        success: true,
        message: `Credentials stored — connectivity not verified${config.bucket_name ? ` (${config.bucket_name})` : ""}`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.access_key_id) configEnv.access_key_id = "AWS_ACCESS_KEY_ID";
    if (config.region) configEnv.region = "AWS_REGION";
    if (config.bucket_name) configEnv.bucket_name = "S3_BUCKET";
    return { primary: "AWS_SECRET_ACCESS_KEY", config: configEnv };
  },
};
