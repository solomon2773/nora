// @ts-nocheck
// Platform-wide email sender. One config (in platform_settings.smtp_*),
// used for invitation emails, alert email channels, and any future Nora →
// human notification. The agent-runtime channels system at backend-api/channels/
// is a separate concern and does not flow through here.
//
// Contract: sendMail() never throws — failures are returned as
// { delivered: false, error }. isConfigured() is cheap (cached for 30s) so
// hot paths can short-circuit when SMTP isn't set up.

const platformSettings = require("./platformSettings");

const CACHE_TTL_MS = 30_000;
let configuredCache = null; // { value, expiresAt }

function bustCache() {
  configuredCache = null;
}

/**
 * Check whether SMTP delivery is configured, failing closed and caching the
 * boolean result briefly for notification hot paths.
 *
 * @returns {Promise<boolean>} Whether the minimum SMTP settings are available.
 */
async function isConfigured() {
  const now = Date.now();
  if (configuredCache && configuredCache.expiresAt > now) {
    return configuredCache.value;
  }
  let value = false;
  try {
    const config = await platformSettings.getSmtpDeliveryConfig();
    value = Boolean(config && config.host && config.port && config.fromAddress);
  } catch {
    value = false;
  }
  configuredCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

async function getSettings() {
  try {
    return await platformSettings.getSmtpDeliveryConfig();
  } catch (err) {
    console.error("mailer: failed to load SMTP settings:", err.message);
    return null;
  }
}

function buildFromHeader(config) {
  const name = (config.fromName || "").trim();
  if (!name) return config.fromAddress;
  // Quote names that contain commas or other tricky characters.
  const safeName = name.includes('"') ? name.replace(/"/g, "") : name;
  return `"${safeName}" <${config.fromAddress}>`;
}

/**
 * Send platform email without throwing; validation, configuration, transport,
 * and delivery failures are returned as `{ delivered: false, error }`.
 *
 * @param {Object} [message={}] - Recipients, subject, bodies, and optional reply-to.
 * @returns {Promise<Object>} Delivery result and optional message id or error.
 */
async function sendMail({ to, subject, text, html, replyTo } = {}) {
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { delivered: false, error: "to address required" };
  }
  if (!subject || !text) {
    return { delivered: false, error: "subject and text required" };
  }
  const config = await getSettings();
  if (!config) {
    return { delivered: false, error: "not_configured" };
  }
  let nodemailer;
  try {
    // Lazy-require so installs without nodemailer don't pay the import.
    nodemailer = require("nodemailer");
  } catch (err) {
    return { delivered: false, error: `nodemailer not installed: ${err.message}` };
  }
  let transporter;
  try {
    // Defensive: enforce port-465 → secure=true at the call site, even if
    // upstream config drift left config.secure inconsistent. SMTP-on-465
    // expects implicit TLS; misclassifying it never works.
    const secure = config.port === 465 ? true : Boolean(config.secure);
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure,
      auth: config.username ? { user: config.username, pass: config.password || "" } : undefined,
    });
  } catch (err) {
    return { delivered: false, error: `transport error: ${err.message}` };
  }
  try {
    const info = await transporter.sendMail({
      from: buildFromHeader(config),
      to,
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    return { delivered: true, messageId: info && info.messageId };
  } catch (err) {
    return { delivered: false, error: err.message || String(err) };
  }
}

/**
 * Verify the current SMTP transport without throwing configuration or network errors.
 *
 * @returns {Promise<Object>} `{ ok: true }` or a stable failure result.
 */
async function verifyConnection() {
  const config = await getSettings();
  if (!config) return { ok: false, error: "not_configured" };
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (err) {
    return { ok: false, error: `nodemailer not installed: ${err.message}` };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: Boolean(config.secure),
      auth: config.username ? { user: config.username, pass: config.password || "" } : undefined,
    });
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  bustCache,
  isConfigured,
  sendMail,
  verifyConnection,
};
