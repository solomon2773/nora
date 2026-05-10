// AWS provider — programmatic access keys (IAM user). The connectivity
// test is structural; verifying signed AWS calls without the SDK isn't
// worth recreating. The agent runtime uses the standard AWS_* env vars.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

const AWS_ACCESS_KEY_RE = /^AKIA[0-9A-Z]{16}$/;

export const awsProvider: Provider = {
  id: "aws",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const accessKey = String(config.access_key_id || "").trim();
      if (!accessKey) throw new Error("AWS access key ID is required");
      if (!ctx.token) throw new Error("AWS secret access key is required");
      if (!config.region) throw new Error("AWS region is required (e.g. us-east-1)");
      if (!AWS_ACCESS_KEY_RE.test(accessKey)) {
        throw new Error(
          "AWS access key ID should look like AKIA followed by 16 alphanumeric chars",
        );
      }
      return {
        success: true,
        message: `Credentials stored for ${accessKey.slice(0, 4)}…${accessKey.slice(-4)} (${config.region})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.access_key_id) configEnv.access_key_id = "AWS_ACCESS_KEY_ID";
    if (config.region) configEnv.region = "AWS_DEFAULT_REGION";
    return { primary: "AWS_SECRET_ACCESS_KEY", config: configEnv };
  },
};
