// Email (SMTP) provider — credentials authType.
//
// SMTP connectivity is hard to verify from the control plane: sending a
// real message would deliver, and most providers gate STARTTLS behind a
// full handshake we don't want to recreate without nodemailer. test()
// instead validates that the required fields are present and that the
// host looks reachable (FQDN, not RFC1918). The agent runtime sends real
// messages via SMTP_* env vars.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
} from "../types/provider";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRIVATE_HOST_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|0\.0\.0\.0$)/;

export const emailProvider: Provider = {
  id: "email",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const host = String(config.smtp_host || "").trim();
      const port = Number(config.smtp_port);
      const user = String(config.smtp_user || "").trim();
      const fromAddress = String(config.from_address || "").trim();
      if (!host) throw new Error("SMTP host is required");
      if (!port || port < 1 || port > 65535)
        throw new Error("SMTP port must be between 1 and 65535");
      if (!user) throw new Error("SMTP username is required");
      if (!ctx.token) throw new Error("SMTP password is required");
      if (!fromAddress) throw new Error("From address is required");
      if (!EMAIL_RE.test(fromAddress)) throw new Error("From address is not a valid email");
      if (PRIVATE_HOST_RE.test(host)) {
        throw new Error(
          "SMTP host must be reachable from Nora — RFC1918 / loopback hosts are rejected",
        );
      }
      return {
        success: true,
        message: `SMTP credentials stored — connectivity not verified from control plane (${host}:${port})`,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.smtp_host) configEnv.smtp_host = "SMTP_HOST";
    if (config.smtp_port !== undefined) configEnv.smtp_port = "SMTP_PORT";
    if (config.smtp_user) configEnv.smtp_user = "SMTP_USER";
    if (config.from_address) configEnv.from_address = "SMTP_FROM_ADDRESS";
    return { primary: "SMTP_PASS", config: configEnv };
  },
};
