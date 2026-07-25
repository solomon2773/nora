import tls from "tls";
import nodemailer from "nodemailer";

type EmailConfig = Record<string, any>;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function classifyMailError(error: unknown, protocol: "imap" | "smtp"): string {
  const message = String((error as any)?.message || error || "").toLowerCase();
  if (
    message.includes("invalid credentials") ||
    message.includes("auth") ||
    message.includes("login failed")
  ) {
    return "invalid_mail_credentials";
  }
  if (
    message.includes("tls") ||
    message.includes("ssl") ||
    message.includes("certificate") ||
    message.includes("self-signed") ||
    message.includes("unable to verify")
  ) {
    return "tls_mismatch";
  }
  if (message.includes("disabled")) {
    return "imap_disabled";
  }
  return protocol === "smtp" ? "smtp_unreachable" : "imap_unreachable";
}

function escapeImapString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Authenticate directly to IMAP with a 10-second socket-inactivity timeout and explicit LOGIN.
 *
 * @param {Object} config - Canonical Email configuration.
 * @returns {Promise<Object>} Successful IMAP endpoint summary.
 */
async function connectImap(config: EmailConfig): Promise<{ ok: true; message: string }> {
  const imap = config.imap || {};
  const auth = config.auth || {};
  const host = stringValue(imap.host);
  const port = numberValue(imap.port, 993);
  const secure = boolValue(imap.secure, true);
  const username = stringValue(auth.username);
  const password = stringValue(auth.password);

  if (!host || !username) throw new Error("IMAP host and username are required");
  if (!password) throw new Error("IMAP password is required");
  if (!secure) {
    throw new Error("IMAP TLS is required; enable TLS and use a TLS-capable endpoint");
  }

  await new Promise<void>((resolve, reject) => {
    let completed = false;
    let buffer = "";
    let commandSent = false;
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
    });

    const finish = (err?: Error) => {
      if (completed) return;
      completed = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const sendAuth = () => {
      if (commandSent) return;
      commandSent = true;
      const command = `a1 LOGIN ${escapeImapString(username)} ${escapeImapString(password)}\r\n`;
      socket.write(command);
    };

    socket.setTimeout(10000, () => finish(new Error("IMAP connection timed out")));
    socket.on("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!commandSent && /\* OK/i.test(buffer)) {
        sendAuth();
        return;
      }
      if (!commandSent) return;
      if (/^a1 OK\b/im.test(buffer)) {
        socket.write("a2 LOGOUT\r\n");
        finish();
        return;
      }
      if (/^a1 (NO|BAD)\b/im.test(buffer)) {
        finish(new Error(buffer.trim()));
      }
    });
  });

  return { ok: true, message: `IMAP authenticated to ${host}:${port}` };
}

/**
 * Build SMTP transport options that require TLS and validate the server certificate.
 *
 * @param {Object} config - Canonical Email configuration.
 * @returns {Object} Nodemailer transport options with plaintext credentials.
 */
export function buildSmtpTransportOptions(config: EmailConfig) {
  const smtp = config.smtp || {};
  const auth = config.auth || {};
  const host = stringValue(smtp.host);
  const port = numberValue(smtp.port, 465);
  const secure = boolValue(smtp.secure, port === 465);
  const user = stringValue(auth.username);
  const password = stringValue(auth.password);

  if (!host || !user) throw new Error("SMTP host and username are required");
  if (!password) throw new Error("SMTP password is required");

  return {
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass: password },
    tls: {
      rejectUnauthorized: true,
      servername: host,
    },
  };
}

/**
 * Verify SMTP authentication through Nodemailer with certificate validation enabled.
 *
 * @param {Object} config - Canonical Email configuration.
 * @returns {Promise<Object>} Successful SMTP endpoint summary.
 */
async function verifySmtp(config: EmailConfig): Promise<{ ok: true; message: string }> {
  const options = buildSmtpTransportOptions(config);
  const transport = nodemailer.createTransport(options);
  await transport.verify();
  return { ok: true, message: `SMTP verified for ${options.host}:${options.port}` };
}

/**
 * Probe IMAP and SMTP independently and return both results even when either side fails.
 *
 * @param {Object} config - Canonical Email configuration with plaintext credentials.
 * @returns {Promise<Object>} Combined connectivity status and protocol-specific details.
 */
export async function testEmailConnection(config: EmailConfig) {
  let imap: any;
  let smtp: any;

  try {
    imap = await connectImap(config);
  } catch (error) {
    const code = classifyMailError(error, "imap");
    imap = {
      ok: false,
      error: code,
      message: (error as any)?.message || String(error),
    };
  }

  try {
    smtp = await verifySmtp(config);
  } catch (error) {
    const code = classifyMailError(error, "smtp");
    smtp = {
      ok: false,
      error: code,
      message: (error as any)?.message || String(error),
    };
  }

  const ok = Boolean(imap?.ok) && Boolean(smtp?.ok);
  return {
    success: ok,
    ok,
    message: ok ? "IMAP and SMTP authentication verified" : "Email integration test failed",
    error: ok ? undefined : imap?.error || smtp?.error,
    imap,
    smtp,
  };
}
